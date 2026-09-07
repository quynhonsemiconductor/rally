data "aws_caller_identity" "current" {}

# ── Read shared layer outputs (ECR URLs, KMS ARN, artifacts bucket) ───────────
# _shared owns ECR repos and re-exports platform-level outputs from qnsc-infra.
# Dependency: the product's _shared stack must be applied before this one.
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "qnsc-tofu-state"
    key    = var.shared_state_key
    region = "ap-southeast-1"
  }
}

locals {
  # Values that are DERIVED, not chosen. Anything an environment picks is a
  # variable; anything computed from those lives here, so the two callers cannot
  # drift in how a value is assembled — only in what they feed in.
  name         = "${var.product}-${var.env_slug}"
  app_base_url = "https://${var.app_domain}"

  # The port the api container listens on. ONE definition, because two consumers must
  # agree: the Cloudflare Tunnel's ingress rule (`module.tunnel`) names it, and the
  # cloudflared sidecar (`module.tunnel_api`) forwards to it. A disagreement between them
  # is a 502 with nothing in the app's own logs to explain it.
  api_container_port = 3000

  kms_key_arn        = data.terraform_remote_state.shared.outputs.kms_key_arn
  cloudflare_zone_id = try(data.terraform_remote_state.shared.outputs.cloudflare_zone_id, "")
  cloudflare_ipv4    = data.terraform_remote_state.shared.outputs.cloudflare_ipv4

  # `rediss://`, never `redis://`: the cache module enables transit encryption
  # unconditionally, so a plaintext scheme would simply fail to connect.
  # When the cache is disabled (an idled environment) this is a deliberately
  # UNRESOLVABLE address rather than an empty string or an omitted variable.
  #
  # `env.schema.ts` declares `REDIS_URL: z.string().default('redis://localhost:6379')`,
  # so omitting it makes a deployed task fall back to LOCALHOST — and the token denylist
  # and rate limiter both FAIL OPEN when Valkey is unreachable. A task booted without a
  # cache would therefore run with two security controls degraded instead of failing.
  # An empty string is no better: it is a valid string, so the schema accepts it.
  #
  # `.invalid` is reserved by RFC 2606 and can never resolve, so the failure is a loud
  # DNS error naming the cause. The real guard is still the `check` block at the bottom
  # of this file: with the cache off, no task may run at all.
  # THREE cases, and the middle one is the shared node in the runtime layer.
  #
  # The DATABASE INDEX is only appended when sharing. A dedicated node has nobody to
  # collide with, and appending `/0` there would rewrite REDIS_URL on every existing
  # environment for no behaviour change — a task-definition revision and a rolling deploy
  # to say the same thing.
  #
  # `try()` on the runtime output is load-bearing rather than defensive: runtime-prod has
  # no shared cache and therefore no `cache_endpoint` output at all, and a bare reference
  # to a missing output fails the plan for EVERY environment, not just the one sharing.
  # When sharing is on and the output is missing, the URL lands on `.invalid` and fails
  # loudly at boot rather than silently pointing somewhere wrong.
  shared_cache_endpoint = try(data.terraform_remote_state.runtime.outputs.cache_endpoint, null)
  shared_cache_port     = try(data.terraform_remote_state.runtime.outputs.cache_port, 6379)

  redis_url = (
    !var.cache.enabled ? "rediss://cache-disabled.invalid:6379" :
    var.cache.shared ? (
      local.shared_cache_endpoint == null
      ? "rediss://shared-cache-missing.invalid:6379"
      : "rediss://${local.shared_cache_endpoint}:${local.shared_cache_port}/${var.cache.db_index}"
    ) :
    "rediss://${module.cache[0].endpoint}:${module.cache[0].port}"
  )

  # Computed, not read from `module.api.log_group_name`, to break a dependency
  # cycle: the agent needs a log group, the api needs the agent's container
  # definition, and the api is what creates the log group. `ecs-service` names it
  # `/ecs/<cluster>-<service>` deterministically, and the `check` blocks at the
  # bottom of this file fail the plan if that convention ever changes.
  api_log_group    = "/ecs/${local.name}-api"
  worker_log_group = "/ecs/${local.name}-worker"

  # Telemetry env shared by api and worker. Both must agree, or the two halves of
  # one trace land under different environments or sampling ratios.
  otel_env = [
    # DEPLOYMENT_ENV, not NODE_ENV. NODE_ENV is pinned to "production" in DEVELOP
    # too (see the env-flag notes in CLAUDE.md), so deriving deployment identity
    # from it labelled every develop span, metric and log as production.
    { name = "DEPLOYMENT_ENV", value = var.env },
    # Terraform already knows the deployed tag, so `service.version` needs no CI
    # plumbing. Prod pins a release tag; develop is honestly "latest".
    { name = "SERVICE_VERSION", value = var.image_tag },
    { name = "OTEL_SAMPLING_PROBABILITY", value = tostring(var.observability.sampling_probability) },
  ]

  # Collector footprint, scaled to the task it rides in. A sidecar's container-level
  # `memory` is a HARD limit carved out of the TASK's total, not additional capacity, so
  # the module's 128 CPU / 256 MiB default is half of develop's 256/512 worker task —
  # enough to OOM a NestJS process the moment telemetry is switched on. Cap the collector
  # at an eighth of task memory with a 128 MiB floor, and keep the soft memory_limiter
  # threshold at the module's 62.5% ratio so it sheds telemetry before it is killed.
  otel_api_memory    = max(128, min(256, floor(var.api.memory / 8)))
  otel_worker_memory = max(128, min(256, floor(var.worker.memory / 8)))
  otel_api_cpu       = max(64, min(128, floor(var.api.cpu / 8)))
  otel_worker_cpu    = max(64, min(128, floor(var.worker.cpu / 8)))

  ecr_base         = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  ecr_api_url      = "${local.ecr_base}/${var.product}-api:${var.image_tag}"
  ecr_worker_url   = "${local.ecr_base}/${var.product}-worker:${var.image_tag}"
  ecr_migrator_url = "${local.ecr_base}/${var.product}-migrator:${var.image_tag}"

  tags = { Environment = var.env }
}

# ── Shared runtime layer (VPC + NAT + ALB) ────────────────────────────────────
# Option A: the VPC/NAT/ALB now live once per env in qnsc-infra/live/runtime-dev
# and are shared by every product. This stack consumes them via remote state
# instead of creating its own. RDS + Fargate stay per-product below.
data "terraform_remote_state" "runtime" {
  backend = "s3"
  config = {
    bucket = "qnsc-tofu-state"
    key    = var.runtime_state_key
    region = "ap-southeast-1"
  }
}

# ── Object storage layer (Cloudflare R2 attachment bucket) ────────────────
# The attachments bucket lives in the platform storage-dev stack (v5 Cloudflare
# provider, isolated from this v4 stack). We consume its name + S3-compatible
# endpoint via remote state — no Cloudflare provider or R2 resource here. The
# bucket-scoped runtime credentials come from Secrets Manager (r2-* below).
# Dependency: platform/storage-dev must be applied before this environment stack.
data "terraform_remote_state" "storage" {
  backend = "s3"
  config = {
    bucket = "qnsc-tofu-state"
    key    = var.storage_state_key
    region = "ap-southeast-1"
  }
}

# ── Secrets (scaffolding only — fill values in Secrets Manager console) ───────
# The secret set this stack owns. Hoisted into a local rather than written inline in
# `module.secrets` so that `local.secret_iam_arns` below can derive the IAM resource
# list from the SAME keys — one definition, so the grant cannot drift from the set.
locals {
  secret_names = merge(var.observability.otlp_endpoint == "" ? {} : {
    # The COMPLETE Authorization header the collector sidecar sends upstream, e.g.
    # `Basic base64(instanceID:token)` — not the bare token. Assembling it in Terraform
    # would put the instance id in state and the credential in the collector's plaintext
    # config.
    "observability-token" = "Authorization header for the OTLP backend (e.g. 'Basic <base64>')"
    }, {
    # There is deliberately NO jwt-public here. `env.schema.ts` derives the public key
    # from this one, because an ES256 public key is a pure function of its private half and
    # rally publishes no JWKS. Storing both allowed the one failure a key pair cannot
    # otherwise have — a mismatched pair, where signing succeeds and every verification
    # rejects — which nothing detected, since both halves were individually valid to
    # Terraform, to the deploy preflight and to the schema. Do not add it back.
    "jwt-private" = "EC P-256 (ES256) private key (PEM, base64-encoded)"
    "csrf-secret" = "CSRF token signing secret"
    # NOTE: give this a value BEFORE the next app deploy — COOKIE_SECRET is required at
    # startup, so a task wired to an empty secret cannot boot (a failed deploy plus
    # rollback, not a silent downgrade, which is the intent).
    "cookie-secret"       = "Cookie signing secret (distinct from csrf-secret)"
    "entra-client-secret" = "Microsoft Entra confidential-client secret (BFF OIDC)"
    # SCM (GitHub App) — minted in GitHub, pasted by hand (Terraform only scaffolds
    # empty containers). Both stay empty until the App is registered, which keeps the
    # SCM backfill and webhook paths dormant.
    "github-webhook-secret"  = "GitHub App webhook HMAC secret (X-Hub-Signature-256)"
    "github-app-private-key" = "GitHub App private key (PEM)"
    # Scoped to <product>-<env>-attachments ONLY. The public bucket gets its own pair
    # below, gated on `storage_public_credentials` — one token per bucket, so a leaked
    # avatar-writer cannot read permission-gated attachments.
    #
    # This comment previously demanded the OPPOSITE (one token scoped to both buckets),
    # because StorageService then used a single S3 client for both. It no longer does:
    # `clientFor(visibility)` picks the public pair when injected. The comment outlived
    # that change, and the tokens in Cloudflare were attachments-only the whole time —
    # so the file documented a requirement reality never met, and public writes 403'd.
    # R2 tokens are minted by hand in the Cloudflare dashboard; add a BUCKET, add a TOKEN.
    #
    # The access key ID is an identifier rather than a credential (useless without the
    # secret half, and Cloudflare shows it in the dashboard), so it is the one value
    # here that could live in Parameter Store as a plain String. It does not, because
    # that module input takes the VALUE in Terraform — which would put it in state to
    # save $0.40/mo. Kept alongside its secret half instead.
    "r2-access-key-id"     = "Cloudflare R2 access key ID (attachments + public-assets)"
    "r2-secret-access-key" = "Cloudflare R2 secret access key (attachments + public-assets)"
    # PUBLIC-bucket-only credential. Optional: while empty, StorageService reuses the
    # pair above and behaviour is unchanged, so this can be adopted without a flag day.
    #
    # The point is blast radius. One token covering both buckets means a leak exposes
    # every permission-gated attachment AND lets an attacker overwrite avatars and logos.
    # Scope this one to <product>-<env>-public-assets only, set it, deploy, THEN re-mint
    # the pair above scoped to attachments alone — in that order, or public writes 403
    # between the two steps.
    "r2-public-access-key-id"     = "Cloudflare R2 access key ID (public-assets ONLY)"
    "r2-public-secret-access-key" = "Cloudflare R2 secret access key (public-assets ONLY)"
    # The COMPLETE Authorization header the collector sidecar sends upstream, e.g.
    # `Basic base64(instanceID:token)` — not the bare token. Assembling it in Terraform
    # would put the instance id in state and the credential in the collector's plaintext
    # config. Empty keeps the whole OTel path dormant.

    # Passwords for the least-privilege database roles created by migration 0068
    # (rova_app / rova_worker). Empty containers only: the value is set by hand
    # at the same moment the role is granted LOGIN, so the password exists in
    # exactly two places — Secrets Manager and pg_authid — and never in state.
    #
    # Creating these changes nothing on its own. The api/worker tasks keep using
    # the RDS master credential until `db_least_privilege` flips to true, which is
    # a separate, per-environment apply. Order matters and is not enforceable in
    # Terraform: grant LOGIN and set the value FIRST, flip the flag second, or the
    # task boots and dies on 28P01. Full sequence in
    # docs/runbooks/db-role-least-privilege.md.
    # Cloudflare Tunnel connector token, consumed by the cloudflared sidecar as
    # TUNNEL_TOKEN. Created out of band with the tunnel itself (a tunnel and its token
    # are one object in Cloudflare — Terraform does not mint this), then pasted into the
    # bundle. Present in `secret_names` so `secret_arns["tunnel-token"]` resolves and so
    # the key shows up in the bundle's generated description; the IAM grant is the whole
    # bundle either way.
    "tunnel-token"       = "Cloudflare Tunnel connector token (cloudflared TUNNEL_TOKEN)"
    "db-app-password"    = "Password for the rova_app Postgres role (api) — set with the LOGIN grant"
    "db-worker-password" = "Password for the rova_worker Postgres role (worker) — set with the LOGIN grant"
  })
}

module "secrets" {
  source      = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/secrets?ref=secrets-v2.1.1"
  prefix      = "${var.product}/${var.env}"
  kms_key_arn = local.kms_key_arn

  # Dev: delete secrets immediately on teardown (no 7-day recovery window) so a
  # destroy+redeploy cycle doesn't hit "secret scheduled for deletion" on the
  # recreate. Prod keeps the default recovery window for safety.
  recovery_window_days = var.secrets_recovery_window_days

  # Cost: collapse the set into one JSON secret. Staged across four applies — see
  # `secrets_bundle_name` in variables.tf for the ordering and why it is staged.
  bundle_name       = var.secrets_bundle_name
  use_bundle        = var.secrets_use_bundle
  create_standalone = var.secrets_create_standalone

  # ONE store: AWS Secrets Manager. The only other Secrets Manager secrets on the
  # account are the `rds!db-*` credentials RDS creates and rotates itself.
  #
  # Parameter Store SecureString would be free where this is $0.40 per secret per
  # month, and that was tried — but at 22 secrets it is $8.80/mo, 1.2% of the bill, and
  # Secrets Manager buys something Parameter Store cannot: a secret can exist while
  # holding NO value. That empty state is what makes "unpopulated" unambiguous and
  # gives the failure mode this stack wants everywhere — a task that cannot boot, a
  # failed deploy and a rollback, rather than a silent downgrade. Parameter Store
  # rejects an empty value, so the same guarantee needed a placeholder, a version-number
  # check in CI, and a runtime guard: three mechanisms replacing one property, plus a
  # new failure mode (a value that looks set and is not).
  #
  # Revisit past roughly 30 secrets, where the per-secret fee starts to outweigh that.
  # The `secure_parameters` input on this module supports the switch when it does.
  #
  # Terraform creates these EMPTY; values are pasted in out of band and never enter
  # state. The deploy preflight in qnsc-ci refuses to deploy while any injected secret
  # is still an empty container.
  # Merged rather than a flat map so `observability-token` can be omitted entirely while
  # the OTel path is dormant. A secret that is deliberately never populated AND never
  # injected is a resource with no purpose — it still bills $0.40/mo per environment, and
  # more to the point it shows up in every audit of "which secrets are unpopulated?" as a
  # permanent false positive, which is how a real unpopulated secret gets overlooked.
  secret_names = local.secret_names

  tags = local.tags
}

# ── RDS PostgreSQL 17 ─────────────────────────────────────────────────────────
module "rds" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/rds?ref=rds-v2.1.2"

  identifier        = local.name
  subnet_ids        = data.terraform_remote_state.runtime.outputs.data_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_rds_id
  kms_key_arn       = local.kms_key_arn

  instance_class           = var.rds.instance_class
  allocated_storage_gb     = var.rds.allocated_storage_gb
  max_allocated_storage_gb = var.rds.max_allocated_storage_gb
  multi_az                 = var.rds.multi_az
  deletion_protection      = var.rds.deletion_protection
  backup_retention_days    = var.rds.backup_retention_days
  monitoring_interval      = var.rds.monitoring_interval

  tags = local.tags
}

# ── Cache (Valkey/Redis) ──────────────────────────────────────────────────────
# Sessions live ONLY here, so this sits outside the ECS tasks and survives task
# replacement — that is what stops every deploy logging users out.
#
# `node` mode is an aws_elasticache_replication_group with at-rest KMS encryption
# and transit encryption both on, which is why the URL scheme below is `rediss://`.
# ioredis turns TLS on from that scheme alone (verified: `rediss://` yields
# `options.tls === true`), so no client-side configuration is needed.
module "cache" {
  # NOT created when this product uses the shared node in the runtime layer. Switching a
  # live environment to `shared` therefore DESTROYS its dedicated node, which is the point
  # — that is where the saving is — and issues a different endpoint, so the change is a
  # task-definition revision and a rolling deploy, not an in-place edit.
  count  = var.cache.enabled && !var.cache.shared ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/cache?ref=cache-v1.1.0"

  name              = "${local.name}-cache"
  subnet_ids        = data.terraform_remote_state.runtime.outputs.data_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_cache_id
  kms_key_arn       = local.kms_key_arn

  mode      = var.cache.mode
  node_type = var.cache.node_type

  tags = local.tags
}

# ── Telemetry collector sidecars ──────────────────────────────────────────────
# One per service: each needs its own log group, and a sidecar can only ever see
# the task it lives in.
#
# Both are a NO-OP until `observability.otlp_endpoint` is set AND the
# `observability-token` secret holds a value — the module returns empty lists, and
# `OTEL_ENABLED` below is gated on the same flag, so the app is never told to
# export into a void. That is what makes turning telemetry on a one-line change
# per environment rather than a migration.
# ── Cloudflare Tunnel ─────────────────────────────────────────────────────────
# Created by Terraform via the shared cf-tunnel module. Both of rally's tunnels predate
# it and were made in the dashboard, so live/*/main.tf carries an `import` block that
# adopts each one — the module ignores `secret` precisely so that adoption is a no-op
# rather than a rotation. Rotating the secret would change the connector token, and every
# running cloudflared would be left holding one that no longer authenticates.
module "tunnel" {
  count  = var.tunnel_enabled && var.cloudflare_account_id != "" ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/cf-tunnel?ref=cf-tunnel-v0.2.1"

  account_id = var.cloudflare_account_id
  name       = local.name

  // ── STEP ONE OF TWO: ADOPT THE TUNNEL, CHANGE NOTHING ─────────────────────
  // `hostname` is deliberately left unset, so this module creates NO configuration
  // resource and rally keeps the routing it has today.
  //
  // That restraint is the whole point. Cloudflare's tunnel-configuration API is a
  // whole-document PUT, so writing a partial rule set silently discards anything the
  // live configuration holds that this file does not reproduce — against a tunnel that
  // is currently carrying traffic, on a hostname nobody has compared rule-by-rule.
  //
  // config_src is left UNSET, because that is what rally's tunnels actually have. The
  // first plan of this change proved it, and proved why it matters:
  //
  //   + config_src = "cloudflare" # forces replacement
  //
  // Writing the attribute would have destroyed and recreated a tunnel currently serving
  // rally-api-dev.qnsc.vn — new UUID, new CNAME target, new connector token. The plan is
  // the only place that was visible before it happened.
  //
  // STEP TWO IS NOW AVAILABLE, PER ENVIRONMENT, via `tunnel_routing_managed`.
  //
  // What forced it: production went live on 2026-08-18 with a tunnel that had no ingress
  // rule, so `cloudflared` connected, reported healthy and returned 503 to every request
  // — `No ingress rules were defined in provided config (if any) nor from the cli`. The
  // post-deploy readiness check caught it, but nothing in the pipeline could have created
  // the rule, because rally adopted its tunnels and left routing outside Terraform. That
  // is a step someone has to remember, and on production nobody did.
  //
  // Still OPT-IN, and still off for develop, because the configuration API is a
  // whole-document PUT: develop's live rule set has never been compared rule-by-rule, and
  // production's holds nothing but the catch-all 503 this change exists to replace.
  //
  // `config_src` IS PINNED TO "" — unset — in BOTH environments, and it has to be passed
  // explicitly, because the module's own DEFAULT is "cloudflare". Omitting the argument is
  // therefore NOT the same as leaving the attribute alone: a plan on this branch, with the
  // argument deleted, proposed replacing BOTH tunnels for exactly the reason quoted above.
  //
  // It is not needed either. The attribute only tells the connector where to READ routing
  // from, and both tunnels already read it from Cloudflare; writing the ingress rule is
  // the whole job. So the two halves are deliberately independent: `tunnel_routing_managed`
  // decides whether Terraform writes the RULE, and nothing decides to rewrite the TUNNEL.
  //
  // `hostname` is the api domain and `service` is the app port, so the rule cannot drift
  // from the task it forwards to — the module writes a catch-all `http_status:404` after
  // it, which Cloudflare requires as the last rule.
  hostname = var.tunnel_routing_managed ? var.api_domain : ""
  service  = "http://localhost:${local.api_container_port}"

  config_src = "" // NOT omittable: the module defaults it to "cloudflare". See above.
}

# The connector token, in its own secret rather than as a key in the bundle.
#
# It cannot share the bundle: that is one JSON object an operator populates by hand, and
# Terraform writing a single key of it would clobber the rest. Separate secrets keep the
# two ownership models apart — this one is Terraform's, the bundle stays the operator's.
#
# MIGRATION NOTE: the bundle's existing `tunnel-token` key is left in place and simply
# stops being referenced. Nothing deletes it, so a rollback is a one-line revert, and the
# api task keeps serving from its current task definition until the next deploy moves it
# onto this ARN.
resource "aws_secretsmanager_secret" "tunnel_token" {
  count = var.tunnel_enabled && var.cloudflare_account_id != "" ? 1 : 0

  name                    = "${var.product}/${var.env}/tunnel-token-tf"
  description             = "Cloudflare Tunnel connector token (TUNNEL_TOKEN). Managed by Terraform — do not edit by hand."
  kms_key_id              = local.kms_key_arn
  recovery_window_in_days = var.secrets_recovery_window_days

  tags = local.tags
}

resource "aws_secretsmanager_secret_version" "tunnel_token" {
  count = var.tunnel_enabled && var.cloudflare_account_id != "" ? 1 : 0

  secret_id     = aws_secretsmanager_secret.tunnel_token[0].id
  secret_string = module.tunnel[0].token
}

# ── Cloudflare Tunnel sidecar (api only) ──────────────────────────────────────
# Ingress WITHOUT an ALB: cloudflared dials out to Cloudflare, so the task needs no
# inbound listener and no public IPv4. Gated on `tunnel_token_secret_arn` — empty
# means no sidecar, so this is inert until a tunnel exists for the environment.
#
# The worker gets none: it is a relay with no HTTP surface and `attach_alb = false`
# already.
#
# SSE was the compatibility question and it is answered: NotificationSseController
# writes a `: heartbeat` every 25s, inside Cloudflare's ~100s idle timeout.
module "tunnel_api" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/tunnel-agent?ref=tunnel-agent-v1.0.0"

  tunnel_token_secret_arn = length(aws_secretsmanager_secret.tunnel_token) > 0 ? aws_secretsmanager_secret.tunnel_token[0].arn : ""
  // Same local as the tunnel's own ingress rule above: the connector forwards to this
  // port and the rule names this port, so they cannot drift into a 502 nobody can explain.
  app_port  = local.api_container_port
  log_group = local.api_log_group
  region    = var.region
}

module "otel_agent_api" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/observability-agent?ref=observability-agent-v1.0.0"

  product       = var.product
  env           = var.env
  otlp_endpoint = var.observability.otlp_endpoint
  # try(): the secret is not created while the OTel path is dormant, and this module is a
  # no-op in that state anyway — so an absent ARN is the correct input, not an error.
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  log_group        = local.api_log_group
  region           = var.region

  cpu              = local.otel_api_cpu
  memory           = local.otel_api_memory
  memory_limit_mib = floor(local.otel_api_memory * 0.625)
}

module "otel_agent_worker" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/observability-agent?ref=observability-agent-v1.0.0"

  product       = var.product
  env           = var.env
  otlp_endpoint = var.observability.otlp_endpoint
  # try(): the secret is not created while the OTel path is dormant, and this module is a
  # no-op in that state anyway — so an absent ARN is the correct input, not an error.
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  log_group        = local.worker_log_group
  region           = var.region

  cpu              = local.otel_worker_cpu
  memory           = local.otel_worker_memory
  memory_limit_mib = floor(local.otel_worker_memory * 0.625)
}

# ── FireLens log router sidecars ──────────────────────────────────────────────
# Same gate as otel_agent above: a no-op until otlp_endpoint AND the
# observability-token secret both exist. GRAFANA ONLY — CloudWatch dual-write
# was tried, worked, and was deliberately dropped (#507); see the module
# README for why this needs its own sidecar rather than folding into
# otel_agent.
#
# service_name MUST match the app's own hardcoded OTel service name exactly
# (app.module.ts / worker.module.ts's `serviceName: 'rova-api'` /
# `'rova-worker'`) — there is no shared var on the app side to read from, so
# a mismatch here doesn't error, it silently creates a THIRD service_name in
# Grafana that nothing else uses. product/env mirror otel_agent_{api,worker}
# above exactly, for the same reason: logs, metrics and traces must agree on
# which namespace/environment they belong to.
module "firelens_agent_api" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/firelens-agent?ref=firelens-agent-v0.2.1"

  service_name     = "rova-api"
  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  router_log_group = local.api_log_group
  region           = var.region
  kms_key_arn      = local.kms_key_arn
}

module "firelens_agent_worker" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/firelens-agent?ref=firelens-agent-v0.2.1"

  service_name     = "rova-worker"
  product          = var.product
  env              = var.env
  otlp_endpoint    = var.observability.otlp_endpoint
  token_secret_arn = try(module.secrets.secret_arns["observability-token"], "")
  router_log_group = local.worker_log_group
  region           = var.region
  kms_key_arn      = local.kms_key_arn
}

# SINGLE SOURCE OF TRUTH for every threshold that appears BOTH as an alert
# condition (module.alerts, below) and as a visible line on the dashboard
# (grafana_dashboard.overview, further below). Defined once, here, so the
# two can never silently drift apart — a dashboard line at a different
# number than the alert that's supposed to explain it is worse than no
# line at all: it tells the reader the wrong thing is "the bad number".
#
# PER-ENVIRONMENT, deliberately — a pre-prod audit finding, fixed before
# prod ever got its own rules: production is STRICTER than develop.
# Develop traffic is synthetic/low-stakes; the same 5% error rate that's a
# shrug there is a real incident against paying customers in production.
# Zero infra cost — pure config, the free lever to pull before spending
# money on anything else (see qnsc-infra/live/observability's own
# retention-tier note for the one lever that DOES cost money).
#
# TWO OF THE KEYS BELOW ARE NOT THRESHOLDS ON A SYMPTOM. They are preconditions
# on whether the symptom can be measured at all, and they were added after a
# production page that turned out to be pure sampling noise:
#
#   min_samples_5m — the number of samples a five-minute window must hold before
#     a percentile or a ratio over that window is a statistic rather than a
#     restatement of one request. Composed into four of the rules in
#     module.alerts below; the full reasoning, with the measured request counts,
#     is in the comment above that module block.
#
#   slow_request_bucket_ms — the histogram bucket boundary that
#     http-slow-request-count treats as the line between "normal" and "slow".
#     Unlike every other number in this block it is NOT free to choose: it is
#     matched as a string against the `le` label of an exported series, so a
#     value that is not a real bucket boundary matches nothing and the rule
#     silently reports zero slow requests forever. The legal values are
#     local.http_duration_boundaries_ms below, and
#     terraform_data.slow_request_bucket_is_real at the bottom of this file
#     fails the plan on anything else rather than letting it pass review.
locals {
  alert_thresholds_by_env = {
    develop = {
      http_error_rate         = 0.05 # ratio, 0-1
      http_p99_latency_ms     = 2000
      db_pool_waiting         = 0
      worker_failure_rate     = 0.10 # ratio, 0-1
      auth_login_failure_rate = 0.30 # looser than http_error_rate — dev logins fail on typos/expired dev sessions, not just real outages
      # 20 requests per 5m, ~0.07 rps. Deliberately LOOSER than production's 50:
      # develop is exercised by CI deploys rather than by users, so a floor that
      # production-grade traffic clears easily would leave develop's rules
      # permanently gated off and hide a regression a CI run could have caught.
      # 20 is still an order of magnitude above the 0-2 samples a quiet window
      # holds, which is the failure this gate exists to stop.
      min_samples_5m = 20
      # 2500, not develop's http_p99_latency_ms of 2000: 2000 is NOT a boundary in
      # the exported histogram and 2500 is the next one above it. Rounding UP
      # rather than down to 1000 keeps the invariant this whole block is built on
      # — production stays stricter than develop — instead of inverting it.
      slow_request_bucket_ms = 2500
    }
    production = {
      http_error_rate         = 0.02
      http_p99_latency_ms     = 1000
      db_pool_waiting         = 0
      worker_failure_rate     = 0.05
      auth_login_failure_rate = 0.15
      # 50 requests per 5m, ~0.17 rps — the SAME floor the CloudWatch
      # alb_latency alarm already uses (thresholds.alb_latency_min_requests in
      # qnsc-tf-modules//modules/observability, default 50). Matched on purpose:
      # the two alarms watch the same latency on the same traffic from opposite
      # sides, and a reader who finds one gated at 50 and the other at some other
      # number has to work out which is right. Low enough that any environment
      # under real use is covered, high enough that noise cannot reach it.
      min_samples_5m = 50
      # 1000 is BOTH production's http_p99_latency_ms and a real boundary in the
      # exported histogram, so no rounding is needed here and the count-based rule
      # and the percentile rule agree on what "slow" means in production.
      slow_request_bucket_ms = 1000
    }
  }
  # Falls back to develop's (looser) numbers for any env string that isn't
  # one of the two above, rather than erroring — a third environment
  # someone adds later gets a safe default instead of a hard failure on
  # an unrelated change.
  alert_thresholds = lookup(local.alert_thresholds_by_env, var.env, local.alert_thresholds_by_env.develop)

  # The explicit bucket boundaries of http_server_duration_milliseconds, in
  # milliseconds — the only `le` values that exist on the series.
  #
  # MIRRORS apps/api/src/otel.ts. The list is NOT the OpenTelemetry JS defaults any
  # more: those stop at 10000, and the same change that added this gate widened the
  # view (`httpDurationBoundaries` on startOtel) precisely because the top finite
  # bucket is where a p99 goes to hide. The first fifteen entries are still the SDK
  # defaults, so the low end a healthy p99 near 48ms lives in is unchanged; the five
  # above 10000 exist to separate a 12-second request from a request that spent the
  # STORAGE preset's whole retry budget.
  #
  # Written out here rather than left implicit because two separate defects came out
  # of nobody being able to see this list. First, the top finite bucket is 10000, so
  # histogram_quantile CLAMPS at 10000 and the production page that opened this work
  # reported `A=10000` — which is not "the p99 was ten seconds", it is "at least one
  # request took longer than ten seconds and the histogram cannot say how much
  # longer". Second, an `le` filter is a STRING match on a label, so picking a
  # plausible-looking number that is not in this list (2000, say) produces a query
  # that matches no series and therefore never alerts, with nothing in a plan or a
  # dashboard to show it is dead.
  #
  # CHANGING THE SDK'S VIEW INVALIDATES THIS LIST, and this file cannot tell that it
  # happened — terraform_data.slow_request_bucket_is_real checks
  # slow_request_bucket_ms against THIS list, not against what the exporter is
  # actually sending, so a boundary edited in apps/api/src/otel.ts and not here makes
  # the precondition assert against a set nobody exports. Both lists move together or
  # neither moves. The check runs the safe way round (it can only reject a value the
  # exporter might in fact have), but a rejected legal boundary is still a plan that
  # fails for the wrong reason.
  http_duration_boundaries_ms = [
    0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
    15000, 30000, 60000, 120000, 180000,
  ]

  # The three ratio thresholds rendered as PERCENTAGES for the alert summaries.
  #
  # `format("%.4g", …)`, not a bare `* 100`. This looks like defensive noise and is
  # not: OpenTofu carries numbers as arbitrary-precision binary floats, and 0.02 is
  # not representable in binary, so `0.02 * 100` interpolates as
  # "1.9999999999999999999999…" — 151 digits of it. That is not a hypothetical.
  # auth-login-failure-rate has been shipping its threshold to production
  # notifications as "15.000000000000000000000000…001%" since it started
  # interpolating the value, which is how this was found: the summaries were
  # rendered for both environments and read, rather than assumed to be fine.
  #
  # `%.4g` and not `%.0f`/an integer cast, deliberately — four significant digits
  # render 2, 5, 10, 15 and 30 exactly as written while still rendering a genuinely
  # fractional threshold (2.5%, 0.5%) as itself. Rounding to an integer would make the
  # summary DISAGREE with the alert condition for any such value, which is precisely
  # the failure alert_thresholds_by_env exists to prevent.
  #
  # Defined once here rather than inline at each use so a fourth ratio rule cannot be
  # added with the raw multiplication, and so the summaries stay readable.
  alert_threshold_pct = {
    http_error_rate         = format("%.4g", local.alert_thresholds.http_error_rate * 100)
    worker_failure_rate     = format("%.4g", local.alert_thresholds.worker_failure_rate * 100)
    auth_login_failure_rate = format("%.4g", local.alert_thresholds.auth_login_failure_rate * 100)
  }

  # Threshold for http-slow-request-count, deliberately OUTSIDE
  # alert_thresholds_by_env and deliberately NOT per-environment.
  #
  # The per-environment strictness that block exists to express is already carried
  # by slow_request_bucket_ms — production calls a request slow at 1000ms and
  # develop at 2500ms. Making the COUNT differ as well would be two knobs for one
  # decision. And the count itself does not want to differ: more than three
  # requests over the slow line in half an hour is worth a human look in either
  # environment, because at 4-and-1-and-0-and-1 requests a day (production's
  # measured load, documented in ../../live/prod/main.tf) four slow requests in
  # thirty minutes is not a tail, it is most of the traffic.
  #
  # Kept as its own local rather than written inline as a literal so the number in
  # the rule's `threshold` and the number in its `summary` cannot drift apart —
  # the same single-source-of-truth rule alert_thresholds_by_env is built on.
  slow_request_count_max = 3

  # main, not a tag/sha: a runbook is meant to be edited without cutting a release,
  # and Grafana's alert panel just needs a URL that resolves, not a pinned revision.
  runbook_base_url = "https://github.com/quynhonsemiconductor/rova/blob/main/docs/runbooks/alerts"

  # A DIFFERENT number from http_error_rate above, deliberately not reused. The
  # alert threshold answers "is this bad enough to page right now" over 5
  # minutes; the SLO objective answers "did we meet our commitment" over 30
  # days. Prod's 99.5% success rate allows ~3.6 hours of full outage a month —
  # looser than it sounds because it is a MONTHLY budget, not a per-incident
  # one, so it tolerates one real incident without also demanding perfection
  # every single day.
  slo_success_objective_by_env = {
    develop    = 0.99
    production = 0.995
  }
  slo_success_objective = lookup(local.slo_success_objective_by_env, var.env, local.slo_success_objective_by_env.develop)
}

# ── Grafana Alerting ──────────────────────────────────────────────────────────
# ALONGSIDE CloudWatch Alarms (monitor_target_health below), not replacing it —
# CloudWatch stays on infra-level signals it can see directly; this covers
# only what CloudWatch cannot: application-level telemetry. Dormant until
# var.grafana_alerting_auth is set (count, not a no-op module — see that
# variable's own description for why count and not the usual empty-string
# no-op pattern).
#
# Every promql below scopes to THIS environment explicitly
# (deployment_environment_name), deliberately NOT to `service_namespace`/
# product — this module's own philosophy (see its README) is that a query
# is used verbatim, no hidden label injection, so a rule scoped wrong here
# is a bug in THIS file, not in the module.
#
# ── VOLUME GATE: why four of these queries end in `and on() (... >= N)` ───────
#
# A PERCENTILE OVER A HANDFUL OF SAMPLES IS NOT A PERCENTILE, and neither is a
# ratio. Production paged on `rally-production-http-p99-latency` with a value of
# A=10000 and resolved at A=48.5. Neither number described the service:
#
#   * 10000 is not a latency at all. It was the largest finite bucket boundary of
#     the OpenTelemetry JS DEFAULT histogram, which is what this service exported
#     at the time, so histogram_quantile clamped there. All it meant is "at least
#     one request exceeded 10s, upper bound unknown". The same change that added
#     this gate widened the view out to 180000 (local.http_duration_boundaries_ms
#     above, mirroring apps/api/src/otel.ts), so a repeat of that page now reports
#     a bucket that distinguishes 12s from a full retry budget — but the clamp is
#     a property of the top bucket, not of 10000, and it still applies there.
#   * With production's measured load — "4, 1, 0, 1 requests a day", documented in
#     ../../live/prod/main.tf's instance-class note — and health probes excluded
#     from the histogram by IGNORED_REQUEST_PATHS/SKIP_LOG_PREFIXES, a 5-minute
#     window holds roughly 0-2 real samples. A p99 over one sample IS that sample.
#     The alert fired on one slow request and cleared on the next one.
#
# THIS ORGANISATION ALREADY DIAGNOSED AND FIXED THIS EXACT DEFECT ON THE
# CLOUDWATCH SIDE. The alb_latency alarm in qnsc-tf-modules//modules/observability
# carries the same finding in its own words — "On a pre-launch or low-traffic
# environment (measured: 0-6 requests per 5-minute period) p95 IS effectively the
# second-slowest single request, so ONE slow request held the alarm over the
# threshold for three consecutive periods and paged. That is noise that trains
# people to ignore the alarm, which is worse than no alarm" — and it grew a
# request-volume gate (thresholds.alb_latency_min_requests, default 50). The
# Grafana rules in this file never got the same gate. One bug, two sides, one side
# fixed. This closes the other side, at the same floor.
#
# THE GATE IS COMPOSED HERE, IN THE QUERY, NOT ADDED TO THE SHARED MODULE. Adding
# a `min_samples` field to observability-alerts would mean the module rewriting
# arbitrary caller PromQL, which is precisely the hidden magic both its README and
# the paragraph above rule it out for: "String surgery on arbitrary PromQL to
# inject a label filter is exactly the kind of hidden magic that silently breaks
# on a query shape nobody tested." The gate needs a DIFFERENT denominator series
# per rule (http_server_requests_total, job_runs_total, auth_login_total) and a
# window that matches the rule's own, so it is exactly the kind of decision that
# has to be made by the query's author.
#
# MECHANISM. `X and on() (gate)` is the standard scalar-gate idiom: `on()` matches
# on the EMPTY label set, so every sample on the left is joined against the single
# sample on the right, and a comparison between an instant vector and a scalar
# FILTERS rather than returning a boolean — so when the gate fails the right side
# is empty, `and` yields nothing, and the module's own `no_data_state = "OK"`
# reports that as OK instead of as a breach. `and` is a set operator, so no
# cardinality error is possible regardless of what the left side carries.
#
# The label sets were checked per rule rather than assumed, because `on()` is only
# correct if both sides are genuinely unlabelled:
#
#   * http-p99-latency — `sum(...) by (le)` is consumed by histogram_quantile,
#     which returns a vector with NO labels. `on()` joins.
#   * the three ratio rules — `sum()` with no `by` collapses to no labels on both
#     numerator and denominator, and `vector(0)` is unlabelled too, so the
#     division is unlabelled. `on()` joins.
#
# No rule needed a different join form, so all four use the same one; had any of
# them kept labels through the aggregation, `on()` would have silently dropped to
# a no-match and the rule would never fire, which is why this was verified and not
# copied.
#
# `rate() * <window seconds>` converts a per-second rate back to an approximate
# COUNT over the window, which is the unit min_samples_5m is expressed in. It is
# approximate — rate() extrapolates at window edges — and that is fine: this is a
# floor separating "no data to speak of" from "enough to judge", not a quantity
# anyone acts on.
#
# WHAT THE GATE COSTS. Below the floor these four rules go silent, and silence
# then means "not enough samples to judge", not "healthy". That is a real loss and
# it is not left uncovered: http-slow-request-count below is a COUNT rather than a
# percentile, so it stays meaningful at one request per hour, and the runbooks say
# plainly what the silence means.
module "alerts" {
  count  = var.grafana_alerting_auth != "" ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/observability-alerts?ref=observability-alerts-v1.1.1"

  product                    = var.product
  env                        = var.env
  prometheus_datasource_name = var.grafana_alerting.prometheus_datasource_name
  folder_uid                 = var.grafana_alerting.alerts_folder_uid

  rules = [
    {
      name        = "db-pool-contention"
      promql      = "db_pool_waiting{deployment_environment_name=\"${var.env}\"}"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.db_pool_waiting
      severity    = "warning"
      summary     = "Connections are queueing for the DB pool in ${var.env} — pool is undersized or a query is holding connections too long."
      runbook_url = "${local.runbook_base_url}/db-pool-contention.md"
    },
    {
      name = "http-5xx-rate"
      # `or vector(0)` on the numerator — same reasoning as the dashboard
      # panel's identical query and the auth-login-failure-rate rule: zero
      # 5xx means the series is absent, not present-at-zero.
      # `and on()` — the volume gate, see the block comment above this module. A 5xx
      # ratio over one request is 0% or 100% and nothing in between, so the same
      # single-sample defect that paged on p99 applies here verbatim. The gate reuses
      # the RATIO'S OWN DENOMINATOR (http_server_requests_total over the same 5m), so
      # "enough traffic to compute a rate" is asked of exactly the series the rate is
      # computed from.
      promql      = "(sum(rate(http_server_errors_total{deployment_environment_name=\"${var.env}\"}[5m])) or vector(0)) / sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) and on() (sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) * 300 >= ${local.alert_thresholds.min_samples_5m})"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.http_error_rate
      severity    = "critical"
      summary     = "HTTP 5xx rate above ${local.alert_threshold_pct.http_error_rate}% in ${var.env} for 5m, over a window holding at least ${local.alert_thresholds.min_samples_5m} requests."
      runbook_url = "${local.runbook_base_url}/http-5xx-rate.md"
    },
    {
      name = "http-p99-latency"
      # `and on()` — the volume gate, see the block comment above this module. THIS is
      # the rule the production page came from, and the one the gate was written for:
      # histogram_quantile over the 0-2 samples a quiet 5-minute window holds returns
      # the slowest of those samples, not a percentile of anything.
      #
      # `by (le)` is consumed by histogram_quantile, so the left side is unlabelled and
      # `on()` (empty label set) is the correct join — verified, not assumed.
      promql      = "histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le)) and on() (sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) * 300 >= ${local.alert_thresholds.min_samples_5m})"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.http_p99_latency_ms
      severity    = "warning"
      summary     = "HTTP p99 latency above ${local.alert_thresholds.http_p99_latency_ms}ms in ${var.env} for 5m, over a window holding at least ${local.alert_thresholds.min_samples_5m} requests — a reported value of exactly 10000 means the histogram's top bucket saturated, so the true p99 is somewhere above 10s and the number itself carries no upper bound."
      runbook_url = "${local.runbook_base_url}/http-p99-latency.md"
    },
    {
      name = "http-slow-request-count"
      # THE COVERAGE THAT SURVIVES THE VOLUME GATE. Every rule above is a percentile or
      # a ratio, and all four now go quiet below min_samples_5m — which is correct, but
      # it would leave production, at 4-and-1-and-0-and-1 requests a day, with no
      # latency signal at all. This rule is a COUNT, so it is exactly as valid at one
      # request an hour as at a thousand a second: "more than
      # ${local.slow_request_count_max} requests crossed the slow line in the last half
      # hour" is a true statement about the traffic regardless of how much of it there
      # was. No gate on this one, deliberately — gating a count on volume would defeat
      # the entire reason it exists.
      #
      # SHAPE: the +Inf bucket is the total request count, and the
      # slow_request_bucket_ms bucket is the count at or under the slow line
      # (Prometheus histogram buckets are CUMULATIVE), so subtracting gives the number
      # of requests ABOVE the line. increase() over 30m rather than rate() because the
      # answer wanted is a count of events, not a per-second frequency.
      #
      # THE `le` VALUE IS A STRING MATCH, WHICH IS THE FRAGILE PART. It must be a real
      # boundary of the exported series — see local.http_duration_boundaries_ms and
      # terraform_data.slow_request_bucket_is_real, which exists because a wrong value
      # here fails silently: the selector matches no series, the subtraction yields
      # nothing, and the rule sits at "no data / OK" forever while looking healthy.
      promql = "sum(increase(http_server_duration_milliseconds_bucket{le=\"+Inf\", deployment_environment_name=\"${var.env}\"}[30m])) - sum(increase(http_server_duration_milliseconds_bucket{le=\"${local.alert_thresholds.slow_request_bucket_ms}\", deployment_environment_name=\"${var.env}\"}[30m]))"
      # 5m against a 30m lookback. Not 0m: increase() extrapolates at the edges of its
      # window, so a single evaluation can read a fractional value just over an integer
      # threshold when a counter starts or a scrape is missed, and five consecutive
      # evaluations at the group's 60s interval cost nothing to require. Not longer,
      # either — a real breach stays in the 30m window for the full 30 minutes, so a
      # long `for` buys no extra confidence and only delays the page; and a `for`
      # approaching the window length would make the rule depend on WHERE in the window
      # the slow requests landed, which is not a property anyone intends to alert on.
      for         = "5m"
      op          = "gt"
      threshold   = local.slow_request_count_max
      severity    = "warning"
      summary     = "More than ${local.slow_request_count_max} HTTP requests took longer than ${local.alert_thresholds.slow_request_bucket_ms}ms in the last 30m in ${var.env} — a COUNT, not a percentile, so unlike http-p99-latency this stays valid at this environment's request volume."
      runbook_url = "${local.runbook_base_url}/http-slow-request-count.md"
    },
    {
      name = "worker-job-failure-rate"
      # `or vector(0)` on the numerator — same reasoning as http-5xx-rate and
      # auth-login-failure-rate above.
      # `and on()` — the volume gate, see the block comment above this module. Gated on
      # job_runs_total, this rule's own denominator, not on http_server_requests_total:
      # the worker's job volume is independent of the API's request volume, and a
      # worker whose jobs are all failing while the API is busy must still be able to
      # fire (and a worker with one job run in five minutes must still not page on it).
      promql      = "(sum(rate(job_failures_total{deployment_environment_name=\"${var.env}\"}[5m])) or vector(0)) / sum(rate(job_runs_total{deployment_environment_name=\"${var.env}\"}[5m])) and on() (sum(rate(job_runs_total{deployment_environment_name=\"${var.env}\"}[5m])) * 300 >= ${local.alert_thresholds.min_samples_5m})"
      for         = "5m"
      op          = "gt"
      threshold   = local.alert_thresholds.worker_failure_rate
      severity    = "warning"
      summary     = "Worker job failure rate above ${local.alert_threshold_pct.worker_failure_rate}% in ${var.env} for 5m, over a window holding at least ${local.alert_thresholds.min_samples_5m} job runs."
      runbook_url = "${local.runbook_base_url}/worker-job-failure-rate.md"
    },
    {
      name = "auth-login-failure-rate"
      # `or vector(0)` on the numerator — same reasoning as the dashboard
      # panel's identical query: zero failures means the series is absent,
      # not present-at-zero, and dividing by an absent vector produces an
      # empty result rather than 0. no_data_state = "OK" below already
      # prevented a false page from this, but the query itself should read
      # correctly on inspection, not rely on the no-data fallback to be safe.
      # `and on()` — the volume gate, see the block comment above this module. TWO
      # differences from the three 5m rules, both forced by this rule's 15m window:
      #
      #   * the gate's range selector is [15m], matching the ratio it gates. A 5m gate
      #     on a 15m ratio would ask about a different window than the one being
      #     judged, so a burst of logins in the last five minutes could unlock a ratio
      #     computed mostly from the ten quiet minutes before it.
      #   * the count is therefore `* 900` (15 minutes of seconds), and the floor is
      #     min_samples_5m * 3 — the same sample DENSITY as the 5m rules, scaled to
      #     three times the window. min_samples_5m stays the single knob; the 15m floor
      #     is derived from it rather than being a second number to keep in step, which
      #     is the same reason it is not stored per-window in
      #     alert_thresholds_by_env.
      promql      = "(sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\", outcome=\"failure\"}[15m])) or vector(0)) / sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\"}[15m])) and on() (sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\"}[15m])) * 900 >= ${local.alert_thresholds.min_samples_5m * 3})"
      for         = "15m"
      op          = "gt"
      threshold   = local.alert_thresholds.auth_login_failure_rate
      severity    = "warning"
      summary     = "Login failure rate above ${local.alert_threshold_pct.auth_login_failure_rate}% in ${var.env} for 15m, over a window holding at least ${local.alert_thresholds.min_samples_5m * 3} login attempts — the generic 401 on this path never surfaces WHY, check Recent errors / Logs Explorer for the actual IdP error."
      runbook_url = "${local.runbook_base_url}/auth-login-failure-rate.md"
    },
  ]
}

# SLO, not another alert rule — a DIFFERENT question from the four above.
# http-5xx-rate asks "is this bad enough to page right now" over 5 minutes;
# this asks "did we meet our commitment" over 30 days, and generates its own
# fast-burn/slow-burn alerts on top (Grafana computes those from the error
# budget, not from a threshold this file chooses). Same gating as
# module.alerts — dormant until var.grafana_alerting_auth is set.
#
# `status_class` is a real, confirmed Mimir label (queried directly against
# the datasource before this session's dashboards shipped), same one the
# "HTTP status code distribution" dashboard panel groups by — not guessed.
resource "grafana_slo" "http_availability" {
  count       = var.grafana_alerting_auth != "" ? 1 : 0
  provider    = grafana
  name        = "HTTP availability (${var.env})"
  description = "Fraction of HTTP requests that do not return a 5xx, over a rolling 30-day window."
  # Was unset, which left this in Grafana's own default SLO folder outside
  # the QNSC company tree everything else here lives under. See
  # var.grafana_alerting.slos_folder_uid's own description before ever
  # changing which folder this points to again.
  folder_uid = var.grafana_alerting.slos_folder_uid

  query {
    type = "ratio"
    ratio {
      success_metric = "http_server_requests_total{deployment_environment_name=\"${var.env}\", status_class!=\"5xx\"}"
      total_metric   = "http_server_requests_total{deployment_environment_name=\"${var.env}\"}"
    }
  }

  objectives {
    value  = local.slo_success_objective
    window = "30d"
  }

  destination_datasource {
    uid = data.grafana_data_source.prometheus[0].uid
  }

  label {
    key   = "product"
    value = var.product
  }
  label {
    key   = "env"
    value = var.env
  }

  # Minimal on purpose: an annotation-only burn-rate alert (no threshold to
  # tune here — Grafana derives fast/slow burn rate from the objective and
  # window itself) routed through the SAME Teams contact point every other
  # rule in this stack uses, via the shared root notification policy.
  alerting {
    fastburn {
      annotation {
        key   = "name"
        value = "SLO fast burn: HTTP availability (${var.env})"
      }
      annotation {
        key   = "description"
        value = "Error budget for HTTP availability in ${var.env} is burning fast enough to exhaust the 30-day budget in hours, not days."
      }
    }
    slowburn {
      annotation {
        key   = "name"
        value = "SLO slow burn: HTTP availability (${var.env})"
      }
      annotation {
        key   = "description"
        value = "Error budget for HTTP availability in ${var.env} is burning steadily — on pace to exhaust the 30-day budget before the window resets."
      }
    }
  }
}

# Resolved directly (not via a template variable) for the same reason the
# alert rules resolve their datasource through observability-alerts rather
# than a caller-supplied UID: this read is safe here because grafana_url/
# grafana_alerting_auth are always plain, already-known CI-secret values by
# apply time, never a same-run resource attribute racing its own creation.
data "grafana_data_source" "prometheus" {
  count    = var.grafana_alerting_auth != "" ? 1 : 0
  provider = grafana
  name     = var.grafana_alerting.prometheus_datasource_name
}

data "grafana_data_source" "loki" {
  count    = var.grafana_alerting_auth != "" ? 1 : 0
  provider = grafana
  name     = var.grafana_alerting.logs_datasource_name
}

# Read-only lookup, used only for the Overview dashboard's "Search traces"
# link (Explore, not an embedded panel — see that link's own comment for
# why). Never queried directly: no trace PromQL/TraceQL target reads this
# UID, so an empty/wrong value would break only that one link, not a panel.
data "grafana_data_source" "tempo" {
  count    = var.grafana_alerting_auth != "" ? 1 : 0
  provider = grafana
  name     = var.grafana_alerting.traces_datasource_name
}

# NOT created here — a real bug this used to be, confirmed via a live
# screenshot: develop and prod are separate Terraform ROOT MODULES with
# separate state, so each one's own `grafana_folder.product_dashboards`
# independently created its OWN "Rally" folder the moment prod applied for
# the first time — two real, separate top-level folders with the same
# title, each holding only that environment's own dashboards. Made worse
# by `dashboards_folder_uid` (the PARENT folder) never actually being
# backfilled from its "" default, so neither copy was even nested where
# intended.
#
# Fixed by creating it ONCE, centrally, in qnsc-infra/live/observability
# (`grafana_folder.rally_dashboards`) — same fix as `alerts_folder_uid`
# already being a plain resource reference there, not a var that can be
# left unset. `var.grafana_alerting.product_dashboards_folder_uid` below
# is that folder's real UID.

# TWO dashboards, not one growing page — the RED/USE split enterprise
# on-call practice uses: "is something wrong" (Overview, golden signals)
# is a different question from "why" (Runtime & Dependencies, saturation
# and downstream call health), and conflating them means every routine
# glance scrolls past diagnostic panels nobody needed yet. Deliberately
# NOT a reusable qnsc-tf-modules module (see the module family's own
# reasoning): a dashboard is a bespoke panel layout, no reuse payoff.
resource "grafana_dashboard" "overview" {
  count     = var.grafana_alerting_auth != "" ? 1 : 0
  provider  = grafana
  folder    = var.grafana_alerting.product_dashboards_folder_uid
  overwrite = true

  config_json = jsonencode({
    title         = "Overview (${var.env})"
    uid           = "rova-overview-${var.env}"
    timezone      = "browser"
    editable      = false
    schemaVersion = 39
    time          = { from = "now-6h", to = "now" }
    refresh       = "1m"
    tags          = ["rova", var.env, "provisioned"]

    # "level" gates the Logs Explorer panel below — a debug/investigation
    # tool, not a golden-signal panel, so it defaults to every level
    # instead of narrowing to errors like "Recent errors" does. Standard
    # Grafana custom-variable shape (verified against years of stable
    # Grafana docs, unlike the panel-JSON shapes flagged elsewhere in this
    # file as needing a real export to trust): "All" maps to the regex
    # ".*", matching detected_level's actual values (error/warn/info/debug).
    templating = {
      list = [
        {
          name    = "level"
          type    = "custom"
          label   = "Level"
          query   = "All : .*,error : error,warn : warn,info : info,debug : debug"
          current = { text = "All", value = ".*" }
          options = [
            { text = "All", value = ".*", selected = true },
            { text = "error", value = "error", selected = false },
            { text = "warn", value = "warn", selected = false },
            { text = "info", value = "info", selected = false },
            { text = "debug", value = "debug", selected = false },
          ]
        }
      ]
    }

    # No dashboard-embedded trace list/search panel: researched again this
    # session, real JSON shape for a sortable multi-trace TraceQL table
    # panel is still unverifiable (GitHub code search for "tableType":
    # "traces" / "queryType":"traceql" returned zero real fixtures, and
    # Grafana's own docs describe the feature without giving the JSON). A
    # dashboard LINK is the documented, stable mechanism instead — Explore
    # with the Tempo datasource preselected, no guessed panel model.
    links = [
      {
        title       = "Search traces (Tempo Explore)"
        url         = "/explore?left=%7B%22datasource%22:%22${data.grafana_data_source.tempo[0].uid}%22,%22queries%22:%5B%7B%22refId%22:%22A%22,%22queryType%22:%22traceqlSearch%22%7D%5D,%22range%22:%7B%22from%22:%22now-1h%22,%22to%22:%22now%22%7D%7D"
        type        = "link"
        icon        = "search"
        targetBlank = true
      }
    ]

    # Vertical marker on every panel showing when a deploy landed —
    # backend-deploy.yml's `annotate-deploy` job posts these via Grafana's
    # own annotation API after each successful deploy, tagged so ONLY this
    # product's THIS environment's deploys show here (a develop dashboard
    # showing prod's deploy markers, or rally's dashboard showing another
    # product's, would misattribute exactly the correlation this exists to
    # enable). Built-in "-- Grafana --" datasource — Grafana's own
    # annotation store, not a Loki/Prometheus query.
    annotations = {
      list = [
        {
          name       = "Deploys"
          datasource = { type = "grafana", uid = "-- Grafana --" }
          enable     = true
          iconColor  = "blue"
          tags       = ["deploy", "rova", var.env]
          type       = "tags"
        }
      ]
    }

    panels = [
      {
        id         = 1
        title      = "HTTP request rate, by route"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 0 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [{
          expr         = "sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) by (route)"
          legendFormat = "{{route}}"
          refId        = "A"
        }]
      },
      {
        id         = 2
        title      = "HTTP error rate"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 0 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        # Red step is local.alert_thresholds.http_error_rate itself — the
        # exact number http-5xx-rate alerts on, not a separately-chosen
        # "looks about right" value. thresholdsStyle draws it as a visible
        # LINE on the graph, not just a value-color change, so the reader
        # sees where the alert boundary sits without opening the rule.
        fieldConfig = {
          defaults = {
            unit   = "percentunit"
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "yellow", value = local.alert_thresholds.http_error_rate / 2 },
                { color = "red", value = local.alert_thresholds.http_error_rate },
              ]
            }
          }
        }
        targets = [{
          # `or vector(0)` on the numerator — confirmed live in prod: zero 5xx
          # ever recorded means http_server_errors_total is genuinely ABSENT,
          # not present-at-zero, and dividing by an absent vector renders as
          # "No data" instead of the honest 0%. Same fix as the login
          # failure-rate panel/alert.
          expr         = "(sum(rate(http_server_errors_total{deployment_environment_name=\"${var.env}\"}[5m])) or vector(0)) / sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m]))"
          legendFormat = "error rate"
          refId        = "A"
        }]
      },
      {
        id         = 3
        title      = "HTTP status code distribution"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        # Splits 2xx/3xx/4xx/5xx as separate series — the single error-rate
        # RATIO above says "how bad"; this says "client mistakes vs our
        # own faults", which is the next question anyone asks after that.
        targets = [{
          expr         = "sum(rate(http_server_requests_total{deployment_environment_name=\"${var.env}\"}[5m])) by (status_class)"
          legendFormat = "{{status_class}}"
          refId        = "A"
        }]
      },
      {
        id         = 4
        title      = "HTTP p50/p95/p99 latency"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        # Red step is local.alert_thresholds.http_p99_latency_ms — the
        # http-p99-latency alert's own boundary, drawn as a line, not
        # re-chosen here.
        fieldConfig = {
          defaults = {
            unit   = "ms"
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "red", value = local.alert_thresholds.http_p99_latency_ms },
              ]
            }
          }
        }
        targets = [
          {
            expr         = "histogram_quantile(0.50, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "p50"
            refId        = "A"
          },
          {
            expr         = "histogram_quantile(0.95, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "p95"
            refId        = "B"
          },
          {
            expr         = "histogram_quantile(0.99, sum(rate(http_server_duration_milliseconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "p99"
            refId        = "C"
          },
        ]
      },
      {
        id         = 5
        title      = "DB pool: in use vs waiting"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 24 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        # Threshold applies to the whole PANEL, not the "waiting" series
        # alone (Grafana field config has no per-series threshold) — reads
        # correctly regardless, since local.alert_thresholds.db_pool_waiting
        # is 0 and "waiting" sitting above 0 at all is exactly what
        # db-pool-contention alerts on; "in_use" naturally runs above 0
        # under normal load, so the line is visually crossed by that
        # series constantly — expected, not a bug.
        fieldConfig = {
          defaults = {
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "red", value = local.alert_thresholds.db_pool_waiting },
              ]
            }
          }
        }
        # sum by (service_name), not the raw metric: caught on a real
        # screenshot review, before prod — an ungrouped query returns one
        # series PER RUNNING TASK (service_instance_id differs across
        # replicas/rollouts even though service_name doesn't), which
        # rendered as duplicate-looking "rally-api in_use" legend entries
        # instead of one line per service.
        targets = [
          {
            expr         = "sum(db_pool_in_use{deployment_environment_name=\"${var.env}\"}) by (service_name)"
            legendFormat = "{{service_name}} in_use"
            refId        = "A"
          },
          {
            expr         = "sum(db_pool_waiting{deployment_environment_name=\"${var.env}\"}) by (service_name)"
            legendFormat = "{{service_name}} waiting"
            refId        = "B"
          },
        ]
      },
      {
        id         = 6
        title      = "Worker job success vs failure rate"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 24 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [
          {
            expr         = "sum(rate(job_runs_total{deployment_environment_name=\"${var.env}\"}[5m]))"
            legendFormat = "runs"
            refId        = "A"
          },
          {
            expr         = "sum(rate(job_failures_total{deployment_environment_name=\"${var.env}\"}[5m]))"
            legendFormat = "failures"
            refId        = "B"
          },
        ]
      },
      # The one panel on this dashboard that isn't a metric: every panel
      # above says something is wrong; this shows the ACTUAL error, so
      # reading it doesn't require switching to Explore. Full width,
      # bottom of the page — supporting detail, not a golden signal.
      # Shape verified against a real Grafana dashboard export (Loki
      # `type: "logs"` panels are undocumented in the schema itself), not
      # guessed — the same discipline as everything else added this
      # session that touches Grafana's opaque JSON models.
      {
        id         = 7
        title      = "Recent errors"
        type       = "logs"
        gridPos    = { h = 8, w = 24, x = 0, y = 32 }
        datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
        options = {
          dedupStrategy      = "none"
          enableLogDetails   = true
          prettifyLogMessage = false
          showCommonLabels   = false
          showLabels         = false
          showTime           = true
          sortOrder          = "Descending"
          wrapLogMessage     = false
        }
        targets = [{
          datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
          expr       = "{service_name=~\"rova-api|rova-worker\", deployment_environment_name=\"${var.env}\"} | detected_level=\"error\""
          refId      = "A"
        }]
      },
      # Full-text, all-levels debug tool — "Recent errors" above answers
      # "is something on fire"; this answers "what did this specific
      # request/instance actually log", which needs every level and a
      # freetext search box, not a fixed filter. `$level` (templating,
      # above) narrows by severity; the `|~` line-contains filter gives a
      # freetext box in the Loki query editor's UI for free (Grafana infers
      # it from the LogQL, same as the panel-type inference noted on
      # "Recent errors"). Same verified `type: "logs"` shape, just a second
      # instance with different options/query — not a new panel type.
      {
        id         = 8
        title      = "Logs Explorer"
        type       = "logs"
        gridPos    = { h = 10, w = 24, x = 0, y = 42 }
        datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
        options = {
          dedupStrategy      = "none"
          enableLogDetails   = true
          prettifyLogMessage = false
          showCommonLabels   = false
          showLabels         = true
          showTime           = true
          sortOrder          = "Descending"
          wrapLogMessage     = false
        }
        targets = [{
          datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
          expr       = "{service_name=~\"rova-api|rova-worker\", deployment_environment_name=\"${var.env}\"} | detected_level=~\"$level\""
          refId      = "A"
        }]
      },
      # "Is login itself working" — a question the HTTP error-rate panel above
      # cannot answer, because the BFF login callback deliberately collapses
      # every failure into one generic 401 (never surfaces OIDC/internal
      # detail to the browser). auth_login_total is the only place that
      # distinction is visible. Red step is auth-login-failure-rate's own
      # threshold, same single-source-of-truth pattern as every other
      # threshold line on this dashboard.
      {
        id         = 9
        title      = "Login success vs failure rate"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 16 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = {
          defaults = {
            unit   = "percentunit"
            custom = { thresholdsStyle = { mode = "line" } }
            thresholds = {
              steps = [
                { color = "green", value = null },
                { color = "red", value = local.alert_thresholds.auth_login_failure_rate },
              ]
            }
          }
        }
        targets = [{
          # `or vector(0)` on the numerator: confirmed live in prod (the first
          # real login ever recorded) that zero failures means the "failure"
          # series is genuinely ABSENT, not present-at-zero — dividing by an
          # absent vector produces an empty result in PromQL, which Grafana
          # renders as "No data" even though the honest answer is "0%,
          # working perfectly." The denominator needs no such guard: it is
          # only ever queried once at least one login (success or failure)
          # exists, at which point it is real and positive by construction.
          expr         = "(sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\", outcome=\"failure\"}[15m])) or vector(0)) / sum(rate(auth_login_total{deployment_environment_name=\"${var.env}\"}[15m]))"
          legendFormat = "failure rate"
          refId        = "A"
        }]
      },
    ]
  })
}

resource "grafana_dashboard" "runtime" {
  count     = var.grafana_alerting_auth != "" ? 1 : 0
  provider  = grafana
  folder    = var.grafana_alerting.product_dashboards_folder_uid
  overwrite = true

  config_json = jsonencode({
    title         = "Runtime & Dependencies (${var.env})"
    uid           = "rova-runtime-${var.env}"
    timezone      = "browser"
    editable      = false
    schemaVersion = 39
    time          = { from = "now-6h", to = "now" }
    refresh       = "1m"
    tags          = ["rova", var.env, "provisioned"]

    # Vertical marker on every panel showing when a deploy landed —
    # backend-deploy.yml's `annotate-deploy` job posts these via Grafana's
    # own annotation API after each successful deploy, tagged so ONLY this
    # product's THIS environment's deploys show here (a develop dashboard
    # showing prod's deploy markers, or rally's dashboard showing another
    # product's, would misattribute exactly the correlation this exists to
    # enable). Built-in "-- Grafana --" datasource — Grafana's own
    # annotation store, not a Loki/Prometheus query.
    annotations = {
      list = [
        {
          name       = "Deploys"
          datasource = { type = "grafana", uid = "-- Grafana --" }
          enable     = true
          iconColor  = "blue"
          tags       = ["deploy", "rova", var.env]
          type       = "tags"
        }
      ]
    }

    panels = [
      # ── Downstream dependencies: THIS is usually WHY latency/errors moved
      # on the Overview dashboard, not what moved — DB and outbound HTTP
      # calls are the two dependency classes this stack instruments.
      {
        id          = 1
        title       = "DB client operation latency (p99, by operation)"
        type        = "timeseries"
        gridPos     = { h = 8, w = 12, x = 0, y = 0 }
        datasource  = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = { defaults = { unit = "s" } }
        targets = [{
          expr         = "histogram_quantile(0.99, sum(rate(db_client_operation_duration_seconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le, db_operation_name))"
          legendFormat = "{{db_operation_name}}"
          refId        = "A"
        }]
      },
      {
        id         = 2
        title      = "DB client connections: by state, vs pending requests"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 0 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        # db_client_connection_count carries a `used`/`idle` state label —
        # summing without it would silently add opposite-meaning numbers
        # together into one uninterpretable line.
        targets = [
          {
            expr         = "sum(db_client_connection_count{deployment_environment_name=\"${var.env}\"}) by (service_name, db_client_connection_state)"
            legendFormat = "{{service_name}} {{db_client_connection_state}}"
            refId        = "A"
          },
          {
            expr         = "sum(db_client_connection_pending_requests{deployment_environment_name=\"${var.env}\"}) by (service_name)"
            legendFormat = "{{service_name}} pending"
            refId        = "B"
          },
        ]
      },
      {
        id         = 3
        title      = "Outbound HTTP client calls: rate + p99 latency"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 0, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        # A dependency going slow/down shows up HERE before it shows up as
        # our own error rate — this is what SCM/Entra/email-provider calls
        # look like from the inside.
        targets = [{
          expr         = "sum(rate(http_client_duration_milliseconds_count{deployment_environment_name=\"${var.env}\"}[5m])) by (net_peer_name)"
          legendFormat = "{{net_peer_name}}"
          refId        = "A"
        }]
      },
      {
        id         = 4
        title      = "Queue processed rate + lag (p99)"
        type       = "timeseries"
        gridPos    = { h = 8, w = 12, x = 12, y = 8 }
        datasource = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        targets = [
          {
            expr         = "sum(rate(queue_processed_total{deployment_environment_name=\"${var.env}\"}[5m]))"
            legendFormat = "processed/s"
            refId        = "A"
          },
          {
            expr         = "histogram_quantile(0.99, sum(rate(queue_lag_seconds_bucket{deployment_environment_name=\"${var.env}\"}[5m])) by (le))"
            legendFormat = "lag p99 (s)"
            refId        = "B"
          },
        ]
      },
      # ── Runtime saturation (USE method): the process's OWN resource
      # pressure — an event loop backing up or heap climbing explains a
      # latency/error spike the dependency panels above can't.
      {
        id          = 5
        title       = "Node.js event loop lag (p99, by service)"
        type        = "timeseries"
        gridPos     = { h = 8, w = 12, x = 0, y = 16 }
        datasource  = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = { defaults = { unit = "s" } }
        targets = [{
          expr         = "nodejs_eventloop_delay_p99_seconds{deployment_environment_name=\"${var.env}\"}"
          legendFormat = "{{service_name}}"
          refId        = "A"
        }]
      },
      {
        id          = 6
        title       = "V8 heap used, by service"
        type        = "timeseries"
        gridPos     = { h = 8, w = 12, x = 12, y = 16 }
        datasource  = { type = "prometheus", uid = data.grafana_data_source.prometheus[0].uid }
        fieldConfig = { defaults = { unit = "bytes" } }
        targets = [{
          expr         = "sum(v8js_memory_heap_used_bytes{deployment_environment_name=\"${var.env}\"}) by (service_name)"
          legendFormat = "{{service_name}}"
          refId        = "A"
        }]
      },
      # Sanity-checks the log pipeline ITSELF — a silent break upstream
      # (FireLens router down, Loki ingestion rejecting) shows here as
      # volume dropping to zero, which every panel above would miss:
      # they'd just look "quiet", not "broken". Verified the LogQL
      # aggregation syntax against real data before shipping (count_over_time
      # wrapped in sum() is a metric query through the same Loki datasource
      # the logs panel above uses, panel type "timeseries" not "logs").
      {
        id         = 7
        title      = "Log volume (lines/5m)"
        type       = "timeseries"
        gridPos    = { h = 8, w = 24, x = 0, y = 24 }
        datasource = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
        targets = [{
          datasource   = { type = "loki", uid = data.grafana_data_source.loki[0].uid }
          expr         = "sum(count_over_time({service_name=~\"rova-api|rova-worker\", deployment_environment_name=\"${var.env}\"}[5m])) by (service_name)"
          legendFormat = "{{service_name}}"
          refId        = "A"
        }]
      },
    ]
  })
}


# ── ALB ───────────────────────────────────────────────────────────────────────
# The ALB is shared and lives in runtime-dev. module.api attaches a host-header
# listener rule (var.api_domain, priority 100) to its HTTPS listener.

# ── ECS Cluster ───────────────────────────────────────────────────────────────
module "ecs_cluster" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/ecs-cluster?ref=ecs-cluster-v2.0.0"
  name   = local.name
  tags   = local.tags

  # Always stated, never inherited: the module default is "enhanced", whose per-task
  # metrics are billed as custom CloudWatch metrics. See the variable.
  container_insights = var.container_insights
}

# ── Database credentials — master vs least-privilege ──────────────────────────
# Today api, worker AND migrator all connect as the RDS master, which owns every
# table: an ordinary HTTP request runs with rights to DROP the schema it reads,
# and any row-level policy would be skipped, because Postgres exempts a table's
# owner from RLS unless FORCE ROW LEVEL SECURITY is also set. That exemption is
# what made the RLS layer in migration 0005 inert, and it is the audit's top
# finding in the drop-multi-tenant design doc.
#
# Migration 0068 creates rova_app / rova_worker with DML rights only. Flipping
# `db_least_privilege` per environment points the two runtime tasks at them. The
# MIGRATOR deliberately stays on master — it needs DDL, and narrowing it means
# transferring schema ownership, which is a separate and more disruptive step.
#
# Both branches keep the same shape the RDS-managed secret established: nothing
# is a hand-maintained copy, and the app composes the URL from parts. The only
# difference is that the username stops being a secret field — `rova_app` is not
# a credential — so it moves to plain env alongside host/port/name.
locals {
  # IAM resource list for the secret containers this stack owns.
  #
  # NOT `module.secrets.secret_iam_arns`, even though that is the semantically right
  # output. It is built from `aws_secretsmanager_secret.*.arn`, which is unknown until
  # apply — and `ecs-service` uses `length(var.secret_arns)` in a `count`, so an unknown
  # LENGTH fails the plan outright with "Invalid count argument". The contents may be
  # unknown at plan time; the length may not.
  #
  # Constructing the ARNs from names keeps the length static (a function of
  # `local.secret_names` and the two bundling flags, all known inputs). Secrets Manager
  # appends a random 6-character suffix to every ARN, so these carry a trailing `-*`
  # wildcard — which is how the AWS docs themselves recommend writing a secret ARN in an
  # IAM policy when the suffix is not known.
  #
  # Kept in lockstep with the module's own output: same containers, same modes. If the
  # module's naming changes, this breaks with it.
  secret_name_prefix = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${var.product}/${var.env}"

  secrets_standalone_exist = coalesce(var.secrets_create_standalone, !var.secrets_use_bundle)

  secret_iam_arns = concat(
    local.secrets_standalone_exist ? [
      for k in keys(local.secret_names) : "${local.secret_name_prefix}/${k}-*"
    ] : [],
    var.secrets_bundle_name != "" ? ["${local.secret_name_prefix}/${var.secrets_bundle_name}-*"] : [],
  )

  api_db_secrets = var.db_least_privilege ? [
    { name = "DATABASE_PASSWORD", secret_arn = module.secrets.secret_arns["db-app-password"] },
    ] : [
    { name = "DATABASE_USER", secret_arn = "${module.rds.master_secret_arn}:username::" },
    { name = "DATABASE_PASSWORD", secret_arn = "${module.rds.master_secret_arn}:password::" },
  ]

  worker_db_secrets = var.db_least_privilege ? [
    { name = "DATABASE_PASSWORD", secret_arn = module.secrets.secret_arns["db-worker-password"] },
    ] : [
    { name = "DATABASE_USER", secret_arn = "${module.rds.master_secret_arn}:username::" },
    { name = "DATABASE_PASSWORD", secret_arn = "${module.rds.master_secret_arn}:password::" },
  ]

  api_db_env    = var.db_least_privilege ? [{ name = "DATABASE_USER", value = "rova_app" }] : []
  worker_db_env = var.db_least_privilege ? [{ name = "DATABASE_USER", value = "rova_worker" }] : []

  # ── Connection-pool budget ──────────────────────────────────────────────────
  # `DATABASE_POOL_MAX` defaults to 20 per PROCESS in env.schema.ts, and nothing
  # here used to set it. That default is a per-task number multiplied by the
  # autoscaler's ceiling, so production could legitimately open
  # 10 api tasks x 20 + 6 worker tasks x 20 = 320 connections against an instance
  # that accepts ~112. The failure mode is not a clean rejection either: the pool
  # queues, `connectionTimeoutMillis` (5s, drizzle.provider.ts) elapses, and every
  # affected request pays five seconds before erroring — while CPU-target
  # autoscaling adds MORE tasks, each bringing its own pool, which starves the
  # database further. Derive the per-task ceiling from the ceiling that matters.
  #
  # Postgres computes max_connections as LEAST(DBInstanceClassMemory/9531392, 5000).
  # Listed per class rather than computed, so an unlisted class fails the plan
  # instead of silently inheriting a number that does not hold for it.
  db_max_connections_by_class = {
    "db.t4g.micro"  = 112
    "db.t4g.small"  = 225
    "db.t4g.medium" = 450
  }
  db_max_connections = local.db_max_connections_by_class[var.rds.instance_class]

  # Reserved off the top: 3 for Postgres' superuser slots, 10 for the migrator
  # one-off task (its own pool, and it runs DURING a deploy while api and worker
  # are still up), 5 for an operator holding a psql session while debugging.
  db_pool_budget = local.db_max_connections - 18

  # Split 60/40 api:worker. The worker's share is not proportional to its task
  # count: AbstractOutboxRelay holds one connection for the whole batch
  # transaction while `processRow` does its work on a SECOND connection, so a
  # relay tick needs at least two per task.
  api_pool_max    = max(4, floor(local.db_pool_budget * 0.6 / var.api.max_count))
  worker_pool_max = max(4, floor(local.db_pool_budget * 0.4 / var.worker.max_count))

  # Public HTTPS origin for the public-assets bucket, from the storage stack's
  # `<product>_public_assets_base_url` output. Null until that stack attaches a
  # `custom_domain`; try() also covers a storage stack applied before the output
  # existed, so this module stays appliable against either.
  #
  # Injected as CDN_PUBLIC_ASSETS_BASE_URL only when non-empty, and that matters:
  # env.schema.ts validates it with `z.string().url()`, so an empty string fails
  # validation and the task refuses to boot. Absent is the supported "no CDN" state;
  # empty is not.
  #
  # NEVER source this from an attachments bucket. Objects on this origin are readable
  # by anyone holding the key, with no auth and no expiry, so pointing it at
  # permission-gated files bypasses every authorization check silently —
  # `StorageService.cdnUrl()` has no private-bucket path for exactly this reason.
  public_assets_base_url = try(
    data.terraform_remote_state.storage.outputs["${var.product}_public_assets_base_url"],
    null,
  )

  # Explicit null check rather than coalesce(): coalesce rejects an empty string as
  # well as null, so `coalesce(x, "")` throws "no non-null, non-empty-string
  # arguments" in precisely the case this guard exists for — storage stack not yet
  # applied, output absent, try() returning null.
  public_assets_cdn_env = (
    local.public_assets_base_url != null && local.public_assets_base_url != ""
    ) ? [
    { name = "CDN_PUBLIC_ASSETS_BASE_URL", value = local.public_assets_base_url },
  ] : []
}

# ── ECS Service — API ─────────────────────────────────────────────────────────
module "api" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/ecs-service?ref=ecs-service-v2.3.2"

  cpu_architecture = var.cpu_architecture
  # Same gate as OTEL_ENABLED below: only switches log driver once a real
  # router exists in additional_containers, never a bare no-op flip.
  use_firelens   = module.firelens_agent_api.enabled
  s3_bucket_arns = module.firelens_agent_api.task_s3_bucket_arns

  service_name = "api"
  cluster_name = module.ecs_cluster.cluster_name
  cluster_arn  = module.ecs_cluster.cluster_arn
  region       = var.region
  image_uri    = local.ecr_api_url

  cpu    = var.api.cpu
  memory = var.api.memory

  vpc_id            = data.terraform_remote_state.runtime.outputs.vpc_id
  subnet_ids        = data.terraform_remote_state.runtime.outputs.private_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_app_id

  desired_count      = 1
  enable_autoscaling = var.api.enable_autoscaling
  min_count          = var.api.min_count
  max_count          = var.api.max_count
  use_spot           = var.api.use_spot
  log_retention_days = var.log_retention_days

  # Both callers set these; neither reached the module until now, so production ran on
  # the ecs-service defaults (65/75) while ../../live/prod/main.tf said 60/70.
  cpu_target_pct    = var.api.cpu_target_pct
  memory_target_pct = var.api.memory_target_pct

  attach_alb = !var.tunnel_enabled
  # try(): the runtime layer stops exporting ALB outputs entirely once its ALB is
  # deleted (enable_alb = false), so this attribute is ABSENT rather than null. A
  # tunnelled stack does not attach to a listener anyway — attach_alb is false above.
  alb_listener_arn  = try(data.terraform_remote_state.runtime.outputs.https_listener_arn, "")
  alb_priority      = 100
  alb_path_patterns = ["/*"]
  alb_host_headers  = [var.api_domain] # host-based routing on the shared ALB
  health_check_path = "/v1/healthz"

  # Cache is the shared ElastiCache replication group (module.cache), not an
  # in-task sidecar — so sessions in Valkey survive api deploys/recycles.

  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue
  # on it to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at
  # all ("unable to pull secrets") — it is not a runtime error, it is a boot
  # failure. The migrator reuses this role, so it is covered here too.
  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue on it
  # to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at all ("unable
  # to pull secrets") — a boot failure, not a runtime error. The migrator reuses this
  # role, so it is covered here too.
  #
  # `secret_iam_arns`, NOT `secret_arns`: this is an IAM resource list. The two outputs
  # are identical while secrets are standalone, but once `use_bundle` is on `secret_arns`
  # returns "<arn>:<key>::" — a valueFrom reference, not an ARN — and an IAM statement
  # built from those matches NOTHING while still applying cleanly. The failure surfaces
  # at the next task start as "unable to pull secrets", long after the apply reported
  # success. `secret_iam_arns` returns the container ARNs in both modes.
  # The tunnel token is appended EXPLICITLY because it is the one secret this stack
  # creates outside `module.secrets`, so `secret_iam_arns` — built from the bundle and
  # standalone NAMES — cannot cover it. Omitting it is the exact failure the paragraph
  # above describes, reached by a different route, and it broke every develop deploy
  # between 2026-08-10 and this change:
  #
  #   AccessDeniedException: assumed-role/rally-develop-api-exec is not authorized to
  #   perform: secretsmanager:GetSecretValue on .../rally/develop/tunnel-token-tf-*
  #
  # The apply that introduced the secret succeeded and wired the sidecar to it, so
  # nothing failed until the next task START — which then could not, the circuit breaker
  # rolled back, and develop sat on a stale image while reporting healthy. The worker
  # deployed normally throughout, which is what isolates the cause: it has no sidecar.
  #
  # qnsc-kb-backend already does this.
  #
  # THE SPLAT IS LOAD-BEARING — do not "clean this up" into
  # `module.tunnel_api.secret_arns`, which is the sidecar's own declaration of the same
  # thing and looks strictly better. It was tried here and broke `plan` for prod:
  #
  #   Error: Invalid count argument
  #     on modules/ecs-service/main.tf line 35, in data "aws_iam_policy_document"
  #     "execution_secrets": count = length(var.secret_arns) + ... > 0 ? 1 : 0
  #   The "count" value depends on resource attributes that cannot be determined until
  #   apply
  #
  # tunnel-agent gates that output on `enabled = var.tunnel_token_secret_arn != ""`, and
  # in an environment where the secret does not exist YET, the ARN is an unknown resource
  # attribute — so the comparison is unknown, the returned list's LENGTH is unknown, and a
  # count that calls `length()` on it cannot be computed. `[*].arn` has no such problem:
  # its length comes from `count`, which is known from configuration whatever the ARN
  # turns out to be.
  #
  # Develop hid this, because there the secret already exists and its ARN is known. Only
  # the prod workspace — never applied — surfaced it.
  secret_arns = concat(
    local.secret_iam_arns,
    [module.rds.master_secret_arn],
    aws_secretsmanager_secret.tunnel_token[*].arn,
    module.firelens_agent_api.secret_arns,
  )
  kms_key_arn = local.kms_key_arn
  secrets = concat(local.api_db_secrets, [
    # DB credentials come from local.api_db_secrets above: the RDS-managed secret
    # AWS owns and rotates, or the rova_app password once db_least_privilege is
    # on. Never a hand-maintained copy either way. `:key::` selects one JSON field.
    #
    # This replaced a static `db-url` secret. That copy went stale on every
    # rotation and the next deploy died with 28P01 (auth failed for app_admin),
    # with nothing drifting in Terraform to explain why. Host/port/name are
    # non-secret and passed as plain env below; the app composes the URL.
    { name = "JWT_PRIVATE_KEY", secret_arn = module.secrets.secret_arns["jwt-private"] },
    { name = "CSRF_SECRET", secret_arn = module.secrets.secret_arns["csrf-secret"] },
    { name = "COOKIE_SECRET", secret_arn = module.secrets.secret_arns["cookie-secret"] },
    { name = "ENTRA_CLIENT_SECRET", secret_arn = module.secrets.secret_arns["entra-client-secret"] },
    # GitHub App webhook HMAC secret — the API verifies X-Hub-Signature-256 on
    # inbound SCM webhooks (/v1/scm/webhook/*). Absent → the receiver returns 503,
    # no boot impact. Execution-role read is covered by secret_arns above.
    { name = "GITHUB_WEBHOOK_SECRET", secret_arn = module.secrets.secret_arns["github-webhook-secret"] },
    # Cloudflare R2 bucket-scoped credentials (S3-compatible SigV4).
    { name = "STORAGE_ACCESS_KEY_ID", secret_arn = module.secrets.secret_arns["r2-access-key-id"] },
    { name = "STORAGE_SECRET_ACCESS_KEY", secret_arn = module.secrets.secret_arns["r2-secret-access-key"] },
    ], var.storage_public_credentials ? [
    # Public-bucket-scoped pair, injected only once populated. NOT unconditional: the
    # deploy preflight blocks on an injected secret that holds no value, so wiring these
    # while empty broke every develop deploy. See the variable.
    { name = "STORAGE_PUBLIC_ACCESS_KEY_ID", secret_arn = module.secrets.secret_arns["r2-public-access-key-id"] },
    { name = "STORAGE_PUBLIC_SECRET_ACCESS_KEY", secret_arn = module.secrets.secret_arns["r2-public-secret-access-key"] },
  ] : [])

  environment_vars = concat(local.api_db_env, [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = "3000" },
    { name = "REDIS_URL", value = local.redis_url },
    { name = "AWS_REGION", value = var.region },
    # Non-secret connection parts; DATABASE_USER/PASSWORD arrive via secrets.
    { name = "DATABASE_HOST", value = module.rds.address },
    { name = "DATABASE_PORT", value = tostring(module.rds.port) },
    { name = "DATABASE_NAME", value = module.rds.db_name },
    # Per-task pool ceiling, derived from the RDS class — see local.api_pool_max.
    { name = "DATABASE_POOL_MAX", value = tostring(local.api_pool_max) },
    { name = "CORS_ORIGINS", value = local.app_base_url },
    { name = "APP_BASE_URL", value = local.app_base_url },
    # JWT config — defaults match app .env.example; override if needed
    { name = "JWT_ISSUER", value = "${var.product}-api" },
    { name = "JWT_AUDIENCE", value = "${var.product}-web" },
    { name = "JWT_ACCESS_EXPIRY", value = "15m" },
    { name = "JWT_REFRESH_EXPIRY", value = "30d" },
    # Microsoft Entra SSO (BFF) — all Entra vars are mandatory; the API fails to boot without them.
    { name = "ENTRA_TENANT_ID", value = var.entra_tenant_id },
    { name = "ENTRA_CLIENT_ID", value = var.entra_client_id },
    { name = "ENTRA_REDIRECT_URI", value = "${local.app_base_url}/v1/bff/callback" },
    # Enqueue-side of Entra B2B guest provisioning: `inviteMember` writes a guest_invite_outbox row
    # only while this is true. The worker carries the same value for the drain side.
    { name = "ENTRA_GUEST_INVITE_ENABLED", value = tostring(var.entra_guest_invite_enabled) },
    { name = "INTERNAL_EMAIL_DOMAINS", value = var.internal_email_domains },
    # GitHub App (SCM org-level auto-discovery + backfill). The API enumerates
    # the App's installations and mints installation tokens, so — like the worker —
    # it needs the App ID + private-key ref. Empty App ID keeps it dormant
    # (GithubAppAuthService.isConfigured() = false). Task role reads all secrets.
    { name = "GITHUB_APP_ID", value = var.github_app_id },
    { name = "GITHUB_APP_PRIVATE_KEY_SECRET_REF", value = module.secrets.secret_arns["github-app-private-key"] },
    # Multi-IdP broker: the home (company Entra) connection resolves its client
    # secret at RUNTIME from this ref. Reuses entra-client-secret (same Entra
    # app) — no duplicate copy to drift on rotation. Unset leaves the broker
    # home path dormant (legacy GET /bff/login unaffected). The task role is
    # granted GetSecretValue on it via task_secret_arns below.
    { name = "IDENTITY_HOME_SECRET_REF", value = module.secrets.secret_arns["entra-client-secret"] },
    # Comma-separated emails auto-granted workspace_admin on every SSO login
    { name = "PLATFORM_ADMIN_EMAILS", value = join(",", var.platform_admin_emails) },
    # Messaging — SQS queue URLs injected at deploy time from module outputs
    # Attachments object storage — Cloudflare R2 (S3-compatible) from the platform
    # storage-dev stack. Bucket name still travels as S3_ATTACHMENTS_BUCKET; the
    # presence of STORAGE_ENDPOINT flips StorageService to the R2 endpoint + keys.
    { name = "S3_ATTACHMENTS_BUCKET", value = data.terraform_remote_state.storage.outputs["${var.product}_attachments_name"] },
    # Separate PUBLIC bucket for avatars/logos. StorageService refuses to store a
    # public asset when this is unset rather than falling back to the private
    # bucket — a silent fallback would put world-readable objects next to
    # permission-gated ones.
    { name = "S3_PUBLIC_ASSETS_BUCKET", value = data.terraform_remote_state.storage.outputs["${var.product}_public_assets_name"] },
    # CDN_PUBLIC_ASSETS_BASE_URL travels via local.public_assets_cdn_env at the end of
    # this list, sourced from the storage stack rather than hand-entered.
    #
    # An earlier version of this comment said an unset value meant public assets "fall
    # back to a presigned GET, which is correct, just not edge-cached". That was wrong:
    # there is no fallback for the avatar surface. cdnUrl() returns null and the API
    # rejects the upload with 409 "Avatar storage is not configured (no public CDN base
    # URL)", which is what develop did until the buckets got a custom domain.
    { name = "STORAGE_ENDPOINT", value = data.terraform_remote_state.storage.outputs["${var.product}_attachments_endpoint"] },
    { name = "STORAGE_FORCE_PATH_STYLE", value = "true" },
    # Email — SES in production. The sender is REQUIRED alongside the provider: without it the API
    # now fails at boot by design, because the old behaviour was to send every message as
    # `"Mini Rally" <>`, collect an SES rejection for each, open the email circuit breaker for the
    # life of the process — and go on reporting healthy.
    { name = "EMAIL_PROVIDER", value = "ses" },
    { name = "MAIL_FROM_EMAIL", value = var.mail_from_email },
    # Observability
    { name = "LOG_LEVEL", value = "info" },
    { name = "LOG_PRETTY", value = "false" },
    { name = "OTEL_SERVICE_NAME", value = "${var.product}-api" },
    # Gated on the sidecar actually existing, so the app can never export into a
    # void. False until observability.otlp_endpoint is set.
    { name = "OTEL_ENABLED", value = tostring(module.otel_agent_api.enabled) },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = module.otel_agent_api.endpoint },
  ], local.public_assets_cdn_env, local.otel_env)

  # Merged into the task definition; reachable from the app at 127.0.0.1 via the
  # shared task network namespace. Empty list until a backend is configured.
  # Both sidecars. concat, not replace — the otel agent and the tunnel connector are
  # independent and either may be a no-op depending on its own gate.
  additional_containers = concat(
    module.otel_agent_api.container_definitions,
    module.tunnel_api.container_definitions,
    module.firelens_agent_api.container_definitions,
  )


  # Multi-IdP broker: the TASK role reads per-connection OIDC client secrets at
  # RUNTIME (resolved from the sso_connections row on demand). The home
  # connection reuses entra-client-secret; the sso/* prefix covers future
  # vendor connections added out-of-band (create the secret + the DB row, no TF
  # change). Distinct from secret_arns above (execution role, boot-time inject).
  # IAM RESOURCES, so these must be container ARNs — `secret_arns["<key>"]` is a
  # valueFrom reference and is invalid here once bundled (see the execution role above).
  #
  # SCOPE WIDENS WHEN BUNDLED, deliberately and unavoidably. Standalone, this granted the
  # task role exactly two secrets out of the set. IAM cannot scope below a secret, so a
  # bundle is granted whole or not at all: the task role can now read every key in it,
  # including the R2 credentials and the signing keys it has no use for. That is the cost
  # of bundling, and it is accepted here because the EXECUTION role is already granted the
  # entire set anyway (same task, same instance metadata), so the bundle does not expose
  # material that was previously unreachable from this task.
  #
  # If a value ever needs a genuinely narrower reader than the rest, keep it OUT of the
  # bundle — the module supports a mixed set, and `secret_iam_arns` returns whatever
  # containers exist.
  task_secret_arns = concat(local.secret_iam_arns, [
    # Future per-connection OIDC secrets, created out of band (a secret plus an
    # sso_connections row, no Terraform change), so the grant has to be a wildcard.
    "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${var.product}/${var.env}/sso/*",
  ])

  tags = merge(local.tags, { Service = "api" })
}

# ── ECS Service — Worker ──────────────────────────────────────────────────────
module "worker" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/ecs-service?ref=ecs-service-v2.3.2"

  cpu_architecture = var.cpu_architecture
  use_firelens     = module.firelens_agent_worker.enabled
  s3_bucket_arns   = module.firelens_agent_worker.task_s3_bucket_arns

  service_name = "worker"
  cluster_name = module.ecs_cluster.cluster_name
  cluster_arn  = module.ecs_cluster.cluster_arn
  region       = var.region
  image_uri    = local.ecr_worker_url

  cpu    = var.worker.cpu
  memory = var.worker.memory

  vpc_id            = data.terraform_remote_state.runtime.outputs.vpc_id
  subnet_ids        = data.terraform_remote_state.runtime.outputs.private_subnet_ids
  security_group_id = data.terraform_remote_state.runtime.outputs.sg_app_id

  desired_count      = 1
  enable_autoscaling = var.worker.enable_autoscaling
  min_count          = var.worker.min_count
  max_count          = var.worker.max_count
  use_spot           = var.worker.use_spot
  log_retention_days = var.log_retention_days

  attach_alb = false

  # Worker has no HTTP listener — check the node process is alive instead
  health_check_command = "pgrep -x node || exit 1"
  container_port       = 3001

  # Cache is the shared ElastiCache replication group (module.cache) — the
  # worker and api now share one cache, so their Redis pub/sub (notification
  # wake-ups) actually connects across tasks instead of each hitting its own
  # isolated sidecar.

  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue
  # on it to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at
  # all ("unable to pull secrets") — it is not a runtime error, it is a boot
  # failure. The migrator reuses this role, so it is covered here too.
  # Includes the AWS-managed RDS secret: the execution role needs GetSecretValue on it
  # to inject DATABASE_USER/PASSWORD. Omit it and the task cannot start at all ("unable
  # to pull secrets") — a boot failure, not a runtime error. The migrator reuses this
  # role, so it is covered here too.
  # `secret_iam_arns`, NOT `secret_arns` — same reason as the api execution role above:
  # a bundled `secret_arns` yields valueFrom references that are invalid as IAM resources
  # and fail silently at apply time, surfacing only as a boot failure.
  secret_arns = concat(local.secret_iam_arns, [module.rds.master_secret_arn], module.firelens_agent_worker.secret_arns)
  kms_key_arn = local.kms_key_arn
  secrets = concat(local.worker_db_secrets, [
    # DB credentials come from local.worker_db_secrets above: the RDS-managed
    # secret AWS owns and rotates, or the rova_worker password once
    # db_least_privilege is on. Never a hand-maintained copy either way.
    #
    # This replaced a static `db-url` secret. That copy went stale on every
    # rotation and the next deploy died with 28P01 (auth failed for app_admin),
    # with nothing drifting in Terraform to explain why. Host/port/name are
    # non-secret and passed as plain env below; the app composes the URL.
    { name = "JWT_PRIVATE_KEY", secret_arn = module.secrets.secret_arns["jwt-private"] },
    # Shared schema requires CSRF_SECRET even though the worker never uses it as middleware
    { name = "CSRF_SECRET", secret_arn = module.secrets.secret_arns["csrf-secret"] },
    { name = "COOKIE_SECRET", secret_arn = module.secrets.secret_arns["cookie-secret"] },
    # Shared schema also validates the Entra client secret at boot (worker runs the same env schema).
    { name = "ENTRA_CLIENT_SECRET", secret_arn = module.secrets.secret_arns["entra-client-secret"] },
    # Cloudflare R2 bucket-scoped credentials (worker also reads/writes attachments).
    { name = "STORAGE_ACCESS_KEY_ID", secret_arn = module.secrets.secret_arns["r2-access-key-id"] },
    { name = "STORAGE_SECRET_ACCESS_KEY", secret_arn = module.secrets.secret_arns["r2-secret-access-key"] },
    ], var.storage_public_credentials ? [
    # Public-bucket-scoped pair, injected only once populated. NOT unconditional: the
    # deploy preflight blocks on an injected secret that holds no value, so wiring these
    # while empty broke every develop deploy. See the variable.
    { name = "STORAGE_PUBLIC_ACCESS_KEY_ID", secret_arn = module.secrets.secret_arns["r2-public-access-key-id"] },
    { name = "STORAGE_PUBLIC_SECRET_ACCESS_KEY", secret_arn = module.secrets.secret_arns["r2-public-secret-access-key"] },
  ] : [])

  # SCM backfill runs in the worker (ScmBackfillRelayService): it resolves the
  # GitHub App private key at RUNTIME to mint the App JWT, so the TASK role — not
  # the execution role — needs GetSecretValue on it. Distinct from secret_arns
  # above (execution role, boot-time inject). Mirrors the api's task_secret_arns.
  # IAM RESOURCES — container ARNs, not valueFrom references. Same widening tradeoff as
  # the api's task_secret_arns above: bundled, this grants the whole object rather than
  # the one key, because IAM cannot scope below a secret.
  task_secret_arns = local.secret_iam_arns

  environment_vars = concat(local.worker_db_env, [
    { name = "NODE_ENV", value = "production" },
    { name = "REDIS_URL", value = local.redis_url },
    { name = "AWS_REGION", value = var.region },
    # Non-secret connection parts; DATABASE_USER/PASSWORD arrive via secrets.
    { name = "DATABASE_HOST", value = module.rds.address },
    { name = "DATABASE_PORT", value = tostring(module.rds.port) },
    { name = "DATABASE_NAME", value = module.rds.db_name },
    # Per-task pool ceiling, derived from the RDS class — see local.worker_pool_max.
    { name = "DATABASE_POOL_MAX", value = tostring(local.worker_pool_max) },
    # Entra SSO — the worker validates the shared env schema, so these are required to boot.
    { name = "ENTRA_TENANT_ID", value = var.entra_tenant_id },
    { name = "ENTRA_CLIENT_ID", value = var.entra_client_id },
    { name = "ENTRA_REDIRECT_URI", value = "${local.app_base_url}/v1/bff/callback" },
    # The worker WRITES user-facing links now, so it needs the same origin the api has (see :690).
    # Not cosmetic: with ENTRA_GUEST_INVITE_ENABLED on, the guest-invite relay becomes the writer of
    # the invitation email's `inviteUrl` and of Graph's `inviteRedirectUrl`, and `APP_BASE_URL`
    # DEFAULTS to http://localhost:5173 in env.schema.ts. Absent here every external invitee would be
    # mailed a localhost link and nothing would error — exactly the silent class of failure this file
    # keeps warning about. The other relays only send notifications, which is why it was never needed.
    { name = "APP_BASE_URL", value = local.app_base_url },
    # Drain-side of the same flag. Deliberately passed even when false: the flag gates ENQUEUEING,
    # and the relay must keep draining rows committed before it was turned off — a queued row also
    # owes the invitation email, so abandoning it leaves the invitee silent with no alarm.
    { name = "ENTRA_GUEST_INVITE_ENABLED", value = tostring(var.entra_guest_invite_enabled) },
    # GitHub App (SCM backfill). App ID stays empty until the App is registered,
    # keeping backfill dormant (GithubAppAuthService.isConfigured() = false). The
    # private-key ref is the SM ARN, resolved at runtime via the task role above.
    { name = "GITHUB_APP_ID", value = var.github_app_id },
    { name = "GITHUB_APP_PRIVATE_KEY_SECRET_REF", value = module.secrets.secret_arns["github-app-private-key"] },
    # Attachments object storage — Cloudflare R2 (see api service for rationale).
    { name = "S3_ATTACHMENTS_BUCKET", value = data.terraform_remote_state.storage.outputs["${var.product}_attachments_name"] },
    # Separate PUBLIC bucket for avatars/logos. StorageService refuses to store a
    # public asset when this is unset rather than falling back to the private
    # bucket — a silent fallback would put world-readable objects next to
    # permission-gated ones.
    { name = "S3_PUBLIC_ASSETS_BUCKET", value = data.terraform_remote_state.storage.outputs["${var.product}_public_assets_name"] },
    # CDN_PUBLIC_ASSETS_BASE_URL travels via local.public_assets_cdn_env at the end of
    # this list, sourced from the storage stack rather than hand-entered.
    #
    # An earlier version of this comment said an unset value meant public assets "fall
    # back to a presigned GET, which is correct, just not edge-cached". That was wrong:
    # there is no fallback for the avatar surface. cdnUrl() returns null and the API
    # rejects the upload with 409 "Avatar storage is not configured (no public CDN base
    # URL)", which is what develop did until the buckets got a custom domain.
    { name = "STORAGE_ENDPOINT", value = data.terraform_remote_state.storage.outputs["${var.product}_attachments_endpoint"] },
    { name = "STORAGE_FORCE_PATH_STYLE", value = "true" },
    # The WORKER sends too — the notification relay is its job — so it needs the sender for the
    # same reason the api task does.
    { name = "EMAIL_PROVIDER", value = "ses" },
    // `try`, not a plain index: the _shared stack owns these outputs, and a PR-time plan runs
    // against the remote state as it is TODAY — which does not have them yet. Empty until
    // _shared applies, which is exactly the loop's off state (the worker logs "feedback OFF").
    // The queue ARN below is CONSTRUCTED instead, same idiom as ses_identity_arn, so the IAM
    // grant is correct from the first apply and needs no ordering at all.
    { name = "SES_BOUNCE_CONFIGSET", value = aws_sesv2_configuration_set.email_feedback.configuration_set_name },
    { name = "SES_BOUNCE_QUEUE_URL", value = aws_sqs_queue.ses_bounce_feedback.url },
    { name = "MAIL_FROM_EMAIL", value = var.mail_from_email },
    { name = "LOG_LEVEL", value = "info" },
    { name = "LOG_PRETTY", value = "false" },
    { name = "OTEL_SERVICE_NAME", value = "${var.product}-worker" },
    # Gated on the sidecar actually existing, so the app can never export into a
    # void. False until observability.otlp_endpoint is set.
    { name = "OTEL_ENABLED", value = tostring(module.otel_agent_worker.enabled) },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = module.otel_agent_worker.endpoint },
  ], local.public_assets_cdn_env, local.otel_env)

  # Merged into the task definition; reachable from the app at 127.0.0.1 via the
  # shared task network namespace. Empty list until a backend is configured.
  additional_containers = concat(
    module.otel_agent_worker.container_definitions,
    module.firelens_agent_worker.container_definitions,
  )


  tags = merge(local.tags, { Service = "worker" })
}

# Attachments object storage now lives entirely in Cloudflare R2 (platform
# storage-dev stack; see the api/worker STORAGE_* wiring and the storage remote
# state above). The transitional rollback S3 bucket was retired here after the
# dev R2 round-trip was verified. The prod stack still keeps its S3 rollback
# bucket until the prod R2 cutover is verified.

# ── Migrator (one-shot, run manually or via CI) ───────────────────────────────
# Runs `pnpm migration:run` then exits. Never scheduled as a service; deploy
# pipelines trigger it with: aws ecs run-task ...
module "migrator" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/oneshot-task?ref=oneshot-task-v2.0.0"

  # Same architecture as the api and worker, and not independently settable: the migrator
  # runs the SAME image family, so a mismatch here is a task that cannot start during a
  # deploy — after the schema change has already been attempted or skipped.
  cpu_architecture = var.cpu_architecture

  name               = "${local.name}-migrator"
  container_name     = "migrator"
  image              = local.ecr_migrator_url
  cpu                = 512
  memory             = 1024
  execution_role_arn = module.api.execution_role_arn
  task_role_arn      = module.api.task_role_arn
  region             = var.region
  log_retention_days = var.log_retention_days

  environment = {
    NODE_ENV       = "production"
    AWS_REGION     = var.region
    SEED_ON_DEPLOY = tostring(var.seed_on_deploy)
    # Non-secret connection parts; USER/PASSWORD arrive via secrets below.
    DATABASE_HOST = module.rds.address
    DATABASE_PORT = tostring(module.rds.port)
    DATABASE_NAME = module.rds.db_name
    # Required by seed.ts to insert the SSO connection row that maps
    # this Entra directory to the system tenant (acme).
    # Without it, the ssoConnections insert is skipped and SSO login returns 401.
    ENTRA_TENANT_ID = var.entra_tenant_id
    # Broker home connection (identity >= 5.5.0): the seed writes clientId +
    # clientSecretRef onto the home sso_connections row. Without these it seeds
    # null refs and broker home login can't run the confidential-client token
    # exchange. clientSecretRef is a REF (ARN) only — not read at seed time, so
    # no task-role change here (the migrator already reuses module.api's role).
    ENTRA_CLIENT_ID          = var.entra_client_id
    IDENTITY_HOME_SECRET_REF = module.secrets.secret_arns["entra-client-secret"]
    # Invite-only access: the seed writes jitEnabled=false onto the home
    # connection, so SSO authenticates but only invited / already-provisioned
    # users (+ platform-admins) get in. No silent auto-join for any qnsc.vn user.
    SSO_JIT_ENABLED = "false"
    # SSO_ALLOWED_EMAIL_DOMAINS is deliberately NOT set here, and an earlier revision of this change
    # set it to "" — recorded because the reasoning is easy to repeat.
    #
    # The thought was that an invited external on a consumer mailbox needs the home connection's
    # allow-list emptied, or `isEmailDomainAllowed` refuses them before the invitation is consulted.
    # That is true only of the DIRECTORY connection. `assertConnectionAllows` skips the domain check
    # outright when `kind === 'shared'`, and an invited external resolves to the seeded `shared`
    # connection (by invitation, never by domain), so emptying this buys the intended flow nothing.
    #
    # What it would cost: the STAFF connection would accept every domain, i.e. any identity Entra can
    # authenticate in the tenant, leaving `SSO_JIT_ENABLED=false` as the only remaining control; the
    # bootstrap reconcile runs unconditionally on every deploy, so production's home connection would
    # be widened too; and because the seed inserts `sso_connection_domains` rows only when the list is
    # non-empty, a NEW environment would get no domain row at all and staff typing a company address
    # would fall through to `NO_CONNECTION`.
    #
    # So the split the schema already intends stands: directory = staff, by owned domain. Shared =
    # externals, by invitation.
  }

  secrets = merge({
    # The master credential, and it stays that way even when `db_least_privilege`
    # moves the api and worker off it: the migrator runs DDL, so it needs the
    # owner. Narrowing it to `rova_migrate` additionally requires transferring
    # schema ownership (`REASSIGN OWNED BY`), which is step 4 of the runbook and
    # deliberately not bundled with the runtime cutover.
    #
    # Read live from the AWS-managed secret so a rotation can never leave the
    # migrator holding a stale password.
    DATABASE_USER     = "${module.rds.master_secret_arn}:username::"
    DATABASE_PASSWORD = "${module.rds.master_secret_arn}:password::"
    },
    # The least-privilege role passwords, for the ONE-OFF cutover task only:
    #   aws ecs run-task --task-definition <name>-migrator --overrides \
    #     '{"containerOverrides":[{"name":"migrator","command":
    #       ["node","dist/db/enable-least-privilege-roles.js"]}]}'
    #
    # They live on the migrator because it is the ONLY workload that holds the RDS
    # master credential and sits in the database's subnets. RDS is not publicly
    # accessible and ECS Exec is disabled on every service, so there is no other
    # route to run `ALTER ROLE ... LOGIN PASSWORD`.
    #
    # `run-task --overrides` cannot add SECRETS — containerOverrides supports
    # `environment` only — so passing them at invocation time would mean plaintext
    # passwords in the API call. They have to be on the task definition.
    #
    # The normal entrypoint (`node dist/db/migrate.js`) ignores these, so the
    # migrator's behaviour is unchanged when the flag is on.
    var.db_role_passwords_set ? {
      DATABASE_APP_PASSWORD    = module.secrets.secret_arns["db-app-password"]
      DATABASE_WORKER_PASSWORD = module.secrets.secret_arns["db-worker-password"]
  } : {})

  tags = merge(local.tags, { Service = "migrator" })
}

# ── WAF: not used in dev. In prod the WebACL lives in runtime-prod and is
# associated with the shared ALB there. ───────────────────────────────────────

# ── Web SPA — Cloudflare Pages (zero-egress, native SPA routing) ─────────────
# Replaces the deprecated S3 + CloudFront (cdn) stack. Content is deployed from
# CI with `wrangler pages deploy apps/web/dist`. The SPA is built with an empty
# VITE_API_URL, so it reaches the API through relative /v1/* paths that the
# Pages Function reverse-proxy (apps/web/functions/v1/[[path]].ts) forwards to
# API_ORIGIN. That keeps the SPA and API same-origin under var.app_domain —
# required so the BFF __Host- session cookie is honoured (no cross-site cookie,
# no CORS). Pages provisions the project + custom domain + proxied CNAME. Gated
# on cloudflare_account_id so the stack still applies before the CF account is
# wired.
module "web" {
  count  = var.cloudflare_account_id != "" ? 1 : 0
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/pages-web?ref=pages-web-v1.0.1"

  account_id  = var.cloudflare_account_id
  name        = "${local.name}-web"
  zone_id     = local.cloudflare_zone_id
  domain      = local.cloudflare_zone_id != "" ? var.app_domain : ""
  record_name = local.cloudflare_zone_id != "" ? var.web_record : ""
  comment     = "${local.name} web SPA → Cloudflare Pages (managed by ${var.product}-infra ${var.env})"

  # Pages Function proxy upstream: /v1/* (incl. /v1/bff/*) is forwarded here so
  # the browser only ever sees the SPA origin (same-origin BFF requirement).
  production_env_vars = {
    API_ORIGIN = "https://${var.api_domain}"
  }
}

# ── DNS — var.api_domain → ALB (Cloudflare-proxied edge) ─────────────────────
# The API's public edge. Cloudflare-proxied (orange cloud) so the ALB is never
# directly reachable — WAF/DDoS/TLS terminate at Cloudflare, and the ALB SG is
# locked to cloudflare_ipv4 above. Cloudflare→origin runs in Full (strict) SSL
# mode; the ALB HTTPS listener serves the *.qnsc.vn cert, which matches the SNI
# var.api_domain. The api ECS service already attaches its /* forward
# rule to that HTTPS listener (see module.api.alb_listener_arn).
module "dns_api" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/dns-record?ref=dns-record-v1.1.0"

  enabled = local.cloudflare_zone_id != ""
  zone_id = local.cloudflare_zone_id
  name    = var.api_record
  type    = "CNAME"

  # Tunnel or ALB, and the CNAME target is the whole difference:
  #   tunnel — <tunnel-id>.cfargotunnel.com, a Cloudflare-internal name that only
  #            resolves through the edge. It CANNOT be unproxied: an orange-cloud
  #            record is the only way traffic reaches a connector.
  #   ALB    — the load balancer's public DNS name.
  content = var.tunnel_enabled ? one(module.tunnel[*].cname) : data.terraform_remote_state.runtime.outputs.alb_dns_name

  proxied = true # orange cloud: required for a tunnel, and shields the ALB otherwise
  comment = var.tunnel_enabled ? "${local.name} API → Cloudflare Tunnel (managed by ${var.product}-infra ${var.env})" : "${local.name} API → ALB via Cloudflare proxy (managed by ${var.product}-infra ${var.env})"
}

# ── Observability: golden-signal alarms + dashboard ───────────────────────────
# Shared module (7 alarms across ECS/ALB/RDS, one dashboard, one SNS topic with
# email subscriptions). It was tagged months ago and never adopted by any stack,
# which is why this product had no alarms at all until the fail-open one below.
#
# It also OWNS the alert topic, so the topic this stack used to declare inline is
# gone — two topics per environment meant two subscriptions to confirm and two
# places to look. The fail-open alarm below publishes to this module's topic.
module "observability" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/observability?ref=observability-v4.3.0"

  create_dashboard = var.create_dashboard

  # OPT-IN BURSTABLE-INSTANCE ALARMS. The only two keys this stack overrides at all —
  # every other threshold in the module defaults to a value already correct here, which
  # is why `thresholds` was previously not passed. These two default to 0 (= alarm not
  # created) because a correct floor is a function of the INSTANCE CLASS, which the
  # module cannot see, so the caller running burstable has to state its own.
  #
  # BOTH ENVIRONMENTS get the same numbers, and that is deliberate rather than an
  # oversight of the per-env pattern used elsewhere in this file: develop and production
  # both run db.t4g.micro (../../live/develop/main.tf and ../../live/prod/main.tf), so
  # the sizing input is identical. Nor do these two need the `environment_idle`
  # treatment the load alarms get — an idled or stopped instance publishes no datapoint,
  # which lands in INSUFFICIENT_DATA rather than in ALARM, and an idle burstable
  # instance sits at its credit ceiling by definition.
  #
  # THE PAGE THAT MOTIVATED THIS. ../../live/prod/main.tf chose db.t4g.micro over small
  # on measured evidence and named its own expiry conditions in the same breath: "RAISE
  # IT ON THIS SIGNAL, and it is the first thing to raise: CPUCreditBalance trending to
  # zero, or FreeableMemory under ~100 MB". That instruction had no alarm behind it, so
  # the documented first-thing-to-check was a thing a human had to remember to go and
  # look at. The p99-latency page that opened this work is the downstream symptom those
  # two metrics would have explained hours earlier.
  #
  # rds_cpu_credit_min = 72. Same file: the instance "earns 12 CPU credits/hour at a 10%
  # baseline", so its accrual ceiling is 24 hours' worth, 288 credits. 72 is a quarter of
  # that ceiling and six hours of baseline accrual. Sized for USEFUL WARNING TIME rather
  # than for a round number: at a sustained 40% CPU across the two vCPUs the instance
  # spends ~48 credits/hour against 12 earned, a net drain of ~36/hour, so 72 credits is
  # roughly two hours of notice before the balance reaches zero and the instance is
  # pinned at baseline. That is comfortably more than the remedy needs — the same file
  # calls the instance-class change "one line and a ~2-minute reboot — no snapshot, no
  # endpoint change, reversible". Rejected a floor near zero (it fires when the
  # degradation has already started, which is what the p99 alert was already doing) and
  # a floor near the ceiling (normal burst-then-refill behaviour would page nightly).
  #
  # rds_freeable_memory_mb = 100. Taken VERBATIM from the "FreeableMemory under ~100 MB"
  # line above rather than rounded to a tidier figure, specifically so the alarm and the
  # runbook that sends people to it cannot disagree about the number — the same rule
  # local.alert_thresholds_by_env is built on. On a 1 GB instance it is ~10% remaining,
  # and the unit is MEGABYTES (the module multiplies up to bytes itself; the unit is in
  # the variable name for exactly this reason).
  thresholds = {
    rds_cpu_credit_min     = 72
    rds_freeable_memory_mb = 100
  }

  name              = local.name
  region            = var.region
  ecs_cluster_name  = module.ecs_cluster.cluster_name
  ecs_service_names = [module.api.service_name, module.worker.service_name]
  # Full ALB ARN — exposed by the runtime stack for exactly this. Without it the
  # module silently skips the two user-facing ALB alarms.
  alb_arn = try(data.terraform_remote_state.runtime.outputs.alb_arn, "")

  # Node mode only, and only rally's OWN dedicated node (never the shared node in
  # the runtime layer — see cache_cluster_id's own description for why: a shared
  # node's alarms belong where the node is created, not in one tenant's stack).
  # enable_cache_alarms is a SEPARATE, plan-time-known condition from
  # cache_cluster_id's value: on a from-scratch environment the cache node's
  # cluster_id output is unknown until apply, and a count gated on that directly
  # is a hard OpenTofu error, not a deferred plan (opshub hit this live; ported
  # back here before rally ever exercises the same first-apply path).
  enable_cache_alarms = var.cache.enabled && !var.cache.shared && var.cache.mode == "node"
  cache_cluster_id    = var.cache.enabled && !var.cache.shared && var.cache.mode == "node" ? module.cache[0].cluster_id : ""
  # `identifier` (rally-prod), NOT `instance_id` (db-F35NKOG…). CloudWatch publishes RDS
  # metrics under the DBInstanceIdentifier dimension, and `aws_db_instance.id` returns the
  # RESOURCE id on AWS provider 5.x — so this pointed at a dimension value that does not
  # exist. Six alarms sat in INSUFFICIENT_DATA permanently: RDS CPU, connections and free
  # storage were unmonitored in BOTH environments while appearing covered.
  #
  # observability-v3.0.0 now rejects a resource id outright, so this cannot regress
  # silently — it fails the plan instead.
  rds_instance_id = module.rds.identifier

  # Drives BOTH per-target-group alarms: response latency and UnHealthyHostCount.
  # Scoped by target group because the ALB is shared with other products — a
  # load-balancer-wide dimension aggregated rally and opshub into one p95 and paged
  # under a rally name for traffic that was not always rally's.
  #
  # Passed unconditionally now. It used to be gated on `monitor_target_health`, which
  # meant develop — where the cost-saver makes zero tasks a normal state — gave up
  # LATENCY monitoring to silence the health alarm. Only the health alarm needs that
  # opt-out; the latency alarm evaluates nothing in a period with no traffic.
  # EMPTY when the api is served by a tunnel: there is no ALB target group, so the
  # two target-group alarms (response latency, UnHealthyHostCount) have nothing to
  # read and the module would fail on a null ARN.
  #
  # This is a REAL LOSS OF COVERAGE, not just plumbing. ../../live/prod/main.tf calls
  # monitor_target_health "the only alarm that catches an outage producing no load to
  # move CPU, latency or 5xx" — and with no ALB nothing on the AWS side observes
  # ingress at all. Replace it OUTSIDE AWS before relying on a tunnel in production: a
  # Cloudflare health check or a synthetic probe against the public hostname. The
  # cloudflared sidecar cannot self-report either, because its image is distroless and
  # carries no shell for an ECS healthCheck (see the tunnel-agent module).
  target_group_arns     = var.tunnel_enabled ? {} : { api = module.api.target_group_arn }
  monitor_target_health = var.monitor_target_health

  // Suppresses the alarms whose premise is "this environment is serving traffic":
  // ECS CPU and memory, ALB 5xx, unhealthy hosts.
  //
  // Idling both environments turned their own alarms into a pager. With no registered
  // targets every request becomes a 503, so HTTPCode_ELB_5XX_Count cleared its
  // threshold from a single browser tab reconnecting to /v1/notifications/stream —
  // 139 requests in a day, against a threshold of 20 per five minutes. And a service
  // scaled to zero makes its CPU metric disappear rather than read zero, so the CPU
  // alarm walked OK -> INSUFFICIENT_DATA -> OK on every wake and mailed an OK notice
  // named "<service>-cpu-high" each time.
  //
  // Derived from the idle posture rather than being its own switch: an environment
  // whose services have a floor of 0 is exactly one that cannot support a load alarm.
  // Tying them together means restoring capacity re-arms the alarms in the same change.
  environment_idle = local.environment_idle
  alarm_emails     = var.alarm_emails
  tags             = local.tags
}

# ── Alerting: security controls that failed OPEN ──────────────────────────────
# The access-token denylist (JwtAuthGuard) and the rate limiter both fail open
# when Valkey is unreachable — individually correct, but together a cache outage
# accepts revoked tokens AND serves unlimited traffic with no signal. The app tags
# those log lines with `securityFailOpen`; this turns them into a metric + alarm.
#
# Log-based, not OTel-based, ON PURPOSE: OTEL_ENABLED is "false" in this
# environment, so a counter would report nothing while looking like monitoring.
# Container logs reach CloudWatch regardless.
#
# The field name is FAIL_OPEN_FIELD in libs/platform/src/observability/fail-open.ts.
# Renaming it there silently breaks this filter.
resource "aws_cloudwatch_log_metric_filter" "security_fail_open" {
  name           = "${local.name}-security-fail-open"
  log_group_name = module.api.log_group_name
  pattern        = "{ $.securityFailOpen = \"*\" }"

  metric_transformation {
    name          = "SecurityFailOpen"
    namespace     = "${var.product}/${var.env}"
    value         = "1"
    default_value = "0"
  }
}


resource "aws_cloudwatch_metric_alarm" "security_fail_open" {
  alarm_name        = "${local.name}-security-fail-open"
  alarm_description = "A security control failed open (token denylist or rate limiter) — check Valkey health."

  namespace           = "${var.product}/${var.env}"
  metric_name         = "SecurityFailOpen"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # A metric filter emits no data points when nothing matches, which is the
  # healthy state — treat that as OK rather than INSUFFICIENT_DATA noise.
  treat_missing_data = "notBreaching"

  alarm_actions = [module.observability.alarm_topic_arn]
  ok_actions    = [module.observability.alarm_topic_arn]
}

# ── Ingress health, from OUTSIDE AWS ─────────────────────────────────────────
# ONLY created when the api is tunnelled, and it exists to replace something real.
#
# With an ALB, `monitor_target_health` watched UnHealthyHostCount — described in
# ../../live/prod/main.tf as "the only alarm that catches an outage producing no load
# to move CPU, latency or 5xx". A tunnelled task has no target group, so that alarm
# cannot exist, and nothing else on the AWS side observes ingress at all:
#
#   - ECS reports the task RUNNING whether or not cloudflared holds edge connections.
#   - `essential = true` on the sidecar catches the connector CRASHING, not the
#     connector staying up with zero edge connections.
#   - An ECS healthCheck cannot probe it either: the cloudflared image is distroless,
#     so there is no shell for a CMD-SHELL probe (see the tunnel-agent module).
#
# A Route 53 health check probes the PUBLIC hostname from outside AWS, so it exercises
# the whole path a user takes — Cloudflare edge, tunnel, connector, app — rather than
# any single component's opinion of itself. $0.50/mo.
#
# Deliberately checks /v1/healthz, not /v1/readyz: readyz touches postgres and valkey,
# so a database blip would page as an ingress outage. Dependency health is already
# covered by the RDS and fail-open alarms.
#
# `monitor_ingress` is the second gate, and it is what lets a PRE-LAUNCH environment stay
# tunnelled without paying for a check that can only ever be red. Production runs zero
# tasks, so this probe sat in ALARM continuously from the day it was created — paying, every
# minute, to be told about the state the environment is deliberately in.
#
# Both gates are required: `tunnel_enabled` says the ALB alarm cannot do this job,
# `monitor_ingress` says there is something running worth watching.
locals {
  # An environment whose service floors are 0 spends most of its time at zero tasks, and a
  # health check against a hostname with nothing behind it sits in ALARM for every one of
  # those hours. That is the same argument this stack already makes for the LOAD alarms
  # (`environment_idle` on the observability module): a floor of 0 is exactly what makes an
  # alarm about serving traffic meaningless.
  #
  # So it is DERIVED rather than left to a third switch. `monitor_ingress`'s own text used to
  # instruct "TURN IT BACK ON IN THE SAME CHANGE THAT RAISES min_count" — this makes that
  # automatic instead of a thing to remember, which is the difference between a rule and a
  # hope. Raising the floors re-arms the probe in the same change that gives it something to
  # probe.
  environment_idle = var.api.min_count == 0 && var.worker.min_count == 0

  monitor_ingress = var.tunnel_enabled && var.monitor_ingress && !local.environment_idle
}

resource "aws_route53_health_check" "api_ingress" {
  count = local.monitor_ingress ? 1 : 0

  fqdn              = var.api_domain
  type              = "HTTPS"
  port              = 443
  resource_path     = "/v1/healthz"
  failure_threshold = 3
  request_interval  = 30

  # us-east-1 ONLY, and not a copy-paste error: Route 53 health-check metrics are
  # published exclusively to us-east-1 regardless of where the endpoint lives, so the
  # alarm below has to be created there too.
  measure_latency = false

  tags = merge(local.tags, { Name = "${local.name}-api-ingress" })
}

# CloudWatch alarm on the health check. In us-east-1 because that is the only region
# where AWS/Route53 HealthCheckStatus exists.
resource "aws_cloudwatch_metric_alarm" "api_ingress_down" {
  count    = local.monitor_ingress ? 1 : 0
  provider = aws.us_east_1

  alarm_name        = "${local.name}-api-ingress-down"
  alarm_description = "${var.api_domain} is not answering /v1/healthz from outside AWS. With no ALB this is the only ingress alarm — check the cloudflared sidecar's edge connections first."

  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  dimensions          = { HealthCheckId = aws_route53_health_check.api_ingress[0].id }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"

  # Missing data is NOT breaching here. The health checker itself is the thing
  # reporting, and a gap in its own metric is far more likely to be a Route 53
  # reporting hiccup than an outage — treating it as breaching would page on the
  # monitoring, not the service.
  treat_missing_data = "missing"

  alarm_actions = [aws_sns_topic.ingress_alarms_us_east_1[0].arn]
  ok_actions    = [aws_sns_topic.ingress_alarms_us_east_1[0].arn]

  tags = local.tags
}

# The alarm lives in us-east-1, and an SNS action must be in the alarm's own region —
# so the ap-southeast-1 alarm topic cannot be used and this one mirrors it.
resource "aws_sns_topic" "ingress_alarms_us_east_1" {
  count    = local.monitor_ingress ? 1 : 0
  provider = aws.us_east_1

  name = "${local.name}-ingress-alarms"
  tags = local.tags
}

resource "aws_sns_topic_subscription" "ingress_alarms_email" {
  for_each = local.monitor_ingress ? toset(var.alarm_emails) : toset([])
  provider = aws.us_east_1

  topic_arn = aws_sns_topic.ingress_alarms_us_east_1[0].arn
  protocol  = "email"
  endpoint  = each.value
}

# ── Alerting: outbox rows that will never be retried ─────────────────────────
# Every relay (notifications, email, SCM webhook inbox, …) retries a failing row
# with exponential backoff and then gives up, setting status = 'failed'. That row
# is silent work loss: a notification nobody receives, or a pull request that
# never links to its work item. Nothing surfaced it — the state lived only in a
# column someone had to think to query, so the first symptom was a user asking why
# their PR was not showing up.
#
# On the WORKER log group, not the api's: the relays run in the worker. Pointing
# this at the api would match nothing and look like coverage.
#
# Log-based for the same reason as the fail-open alarm above: QueueMetrics already
# counts this, but OTEL_ENABLED is "false" in every deployed environment and no
# collector exists, so that counter reports nothing while appearing to be
# monitoring. Container logs reach CloudWatch either way.
#
# The field name is DEAD_LETTER_FIELD in
# libs/platform/src/outbox/abstract-outbox-relay.ts, and only the TERMINAL failure
# carries it — a row still inside its retry budget does not page. A spec asserts
# the field the application emits is the field filtered on here.
resource "aws_cloudwatch_log_metric_filter" "outbox_dead_letter" {
  name           = "${local.name}-outbox-dead-letter"
  log_group_name = module.worker.log_group_name
  pattern        = "{ $.outboxDeadLetter = \"*\" }"

  metric_transformation {
    name          = "OutboxDeadLetter"
    namespace     = "${var.product}/${var.env}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "outbox_dead_letter" {
  alarm_name        = "${local.name}-outbox-dead-letter"
  alarm_description = "A relay gave up on a row after exhausting its retries — work has been lost. Query the outbox table for status = 'failed'."

  namespace           = "${var.product}/${var.env}"
  metric_name         = "OutboxDeadLetter"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # A metric filter emits no data points when nothing matches, which is the
  # healthy state — treat that as OK rather than INSUFFICIENT_DATA noise.
  treat_missing_data = "notBreaching"

  alarm_actions = [module.observability.alarm_topic_arn]
  ok_actions    = [module.observability.alarm_topic_arn]
}

# ── Guard: the sidecar log groups must match the ones ecs-service creates ──────
# `local.{api,worker}_log_group` is COMPUTED rather than read from
# `module.<svc>.log_group_name`, because reading it would form a cycle: the agent
# needs a log group, the service needs the agent's container definition, and the
# service is what creates the log group.
#
# That means this stack now depends on `ecs-service` naming its log group
# `/ecs/<cluster>-<service>`. A `check` block is evaluated AFTER the resources it
# references, so it can assert the coupling without recreating the cycle. If a
# future ecs-service release renames the group, the collector would silently log
# into a group nobody reads. See the mechanism note below for why this is a resource
# precondition rather than the `check` block it used to be.
# ENFORCED as a resource precondition, not a `check` block. A violated check emits
# `Warning: Check block assertion failed` and the plan EXITS 0 — measured on OpenTofu 1.12.3
# — so the comment above, which promised "a loud failure instead", described something that
# did not happen. A silent collector logging into a group nobody reads was exactly the
# outcome it was meant to prevent.
#
# `terraform_data` rather than a validation because the condition reads `local.*` and module
# outputs, which a variable validation cannot. It does not recreate the cycle the comment
# above describes: nothing references this resource, so it sits downstream of the services
# rather than inside the agent/service/log-group chain.
#
# `input` is bound to the guarded values so the precondition is re-evaluated whenever they
# change, rather than only on first create.
resource "terraform_data" "otel_agent_log_groups_match_services" {
  input = {
    api    = local.api_log_group
    worker = local.worker_log_group
  }

  lifecycle {
    precondition {
      condition     = local.api_log_group == module.api.log_group_name
      error_message = "api sidecar log group '${local.api_log_group}' != '${module.api.log_group_name}'. ecs-service changed its log-group naming; update local.api_log_group."
    }

    precondition {
      condition     = local.worker_log_group == module.worker.log_group_name
      error_message = "worker sidecar log group '${local.worker_log_group}' != '${module.worker.log_group_name}'. ecs-service changed its log-group naming; update local.worker_log_group."
    }
  }
}

# ── Guard: the pool arithmetic must fit the instance ──────────────────────────
# `local.api_pool_max` / `worker_pool_max` divide a connection budget by the
# AUTOSCALER'S CEILING, so the arithmetic only holds while both ceilings and the
# instance class stay in step. Raise `api.max_count` without touching anything
# else and the per-task pool shrinks to compensate — correct. Shrink the RDS
# class, though, and the budget moves under both. This asserts the invariant
# that matters: everything this stack can open at full scale-out still fits.
#
# Worth an assertion rather than a comment because the failure is invisible in a
# plan and indirect at runtime — requests stall for `connectionTimeoutMillis`
# rather than anything reporting "out of connections".
# ENFORCED as a resource precondition for the same reason as the log-group guard above: a
# `check` block only warns. The condition reads `local.*`, so a variable validation cannot
# express it.
resource "terraform_data" "db_pool_fits_instance_class" {
  input = {
    api    = var.api.max_count * local.api_pool_max
    worker = var.worker.max_count * local.worker_pool_max
    budget = local.db_pool_budget
  }

  lifecycle {
    precondition {
      condition = (var.api.max_count * local.api_pool_max
      + var.worker.max_count * local.worker_pool_max) <= local.db_pool_budget
      error_message = join(" ", [
        "DB pool ceiling exceeds the budget for ${var.rds.instance_class}:",
        "api ${var.api.max_count}x${local.api_pool_max}",
        "+ worker ${var.worker.max_count}x${local.worker_pool_max}",
        "> ${local.db_pool_budget} usable of ${local.db_max_connections}.",
        "Lower a max_count or move to a larger instance class.",
      ])
    }
  }
}

# ── Guard: the slow-request bucket must be a REAL histogram boundary ──────────
# `local.alert_thresholds.slow_request_bucket_ms` is interpolated into an `le` label
# MATCHER in the http-slow-request-count rule above. `le` is an ordinary string label,
# so a value that is not one of the histogram's actual bucket boundaries does not
# error and does not warn — it selects no series, the subtraction returns an empty
# result, and Grafana's `no_data_state = "OK"` reports the rule as healthy for as long
# as nobody notices. An alert that cannot fire is worse than a missing alert, because
# it occupies the slot where somebody would otherwise notice the gap.
#
# The trap is specific and easy to fall into: develop's http_p99_latency_ms is 2000,
# 2000 is a completely reasonable-looking millisecond figure, and 2000 is NOT a bucket
# boundary (the OpenTelemetry JS defaults jump 1000 -> 2500). Anyone tuning this value
# to line up with a latency threshold, in either environment, hits it immediately.
#
# ENFORCED as a resource precondition for the same two reasons as the two guards
# above: a `check` block only WARNS and exits 0 on OpenTofu 1.12.3, and the condition
# reads `local.*`, which a variable validation cannot do. `input` is bound to the
# guarded value so the precondition re-evaluates whenever it changes rather than only
# on first create.
resource "terraform_data" "slow_request_bucket_is_real" {
  input = {
    bucket_ms  = local.alert_thresholds.slow_request_bucket_ms
    boundaries = local.http_duration_boundaries_ms
  }

  lifecycle {
    precondition {
      condition = contains(local.http_duration_boundaries_ms, local.alert_thresholds.slow_request_bucket_ms)
      error_message = join(" ", [
        "alert_thresholds_by_env[\"${var.env}\"].slow_request_bucket_ms is",
        "${local.alert_thresholds.slow_request_bucket_ms}, which is not a bucket boundary of",
        "http_server_duration_milliseconds. The http-slow-request-count rule matches this",
        "value as an `le` label, so a non-boundary matches no series and the alert can never",
        "fire. Legal values are ${join(", ", [for b in local.http_duration_boundaries_ms : tostring(b)])}",
        "(the OpenTelemetry JS default histogram boundaries). Pick the nearest boundary AT OR",
        "ABOVE the latency you mean, so the rule counts requests slower than that latency.",
      ])
    }
  }
}

# ── RDS stop scheduler (optional) ─────────────────────────────────────────────
# The half that was missing. `_shared` grants the develop deploy role
# `rds:StartDBInstance` and qnsc-ci's deploy reusable wakes a stopped instance and
# restores services scaled to 0 — but nothing ever STOPPED anything. Only the waking
# side existed, and a comment claiming otherwise was once used to justify disabling a
# real outage alarm, so this is deliberately built rather than assumed.
#
# Two uses, one mechanism:
#   * production idled before go-live — AWS force-starts a stopped instance after
#     SEVEN DAYS, so without a recurring re-stop the saving silently evaporates and
#     nothing reports it.
#   * develop off-hours, if that is ever wanted — same resource, tighter cron.
#
# EventBridge Scheduler's universal target calls the RDS API directly: no Lambda to
# own, patch or pay for.
resource "aws_iam_role" "idler" {
  count = var.idle_schedule == null ? 0 : 1
  name  = "${local.name}-idler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      # Confused-deputy guard: without it any other account's schedule could assume
      # this role. Scoped to this account's schedules only.
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "idler" {
  count = var.idle_schedule == null ? 0 : 1
  name  = "idle-environment"
  role  = aws_iam_role.idler[0].id

  # Stop only. Not Start, and not Reboot: the schedule's whole job is to remove
  # capacity, and a role that can also start an instance turns a scheduling mistake
  # into a cost increase. Waking is the deploy pipeline's job and has its own grant.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StopDatabase"
        Effect   = "Allow"
        Action   = "rds:StopDBInstance"
        Resource = module.rds.instance_arn
      },
      {
        # Scaling to zero as well as stopping the database, because stopping only the
        # database leaves Fargate tasks running against an instance they cannot reach:
        # still billed, unable to serve, and noisy. `healthz` answers 200 regardless, so
        # the ALB keeps them registered and nothing reports the state.
        Sid    = "ScaleServicesToZero"
        Effect = "Allow"
        Action = "ecs:UpdateService"
        Resource = [
          module.api.service_arn,
          module.worker.service_arn,
        ]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "rds_stop" {
  count       = var.idle_schedule == null ? 0 : 1
  name        = "${local.name}-rds-stop"
  description = "Stops ${module.rds.identifier}; see var.idle_schedule for why this exists"

  schedule_expression          = var.idle_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  # OFF, not a window: this is not load-sensitive work, and an exact time makes the
  # relationship between a run and its CloudTrail entry unambiguous.
  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:rds:stopDBInstance"
    role_arn = aws_iam_role.idler[0].arn
    input    = jsonencode({ DbInstanceIdentifier = module.rds.identifier })

    # No retries and no dead-letter queue ON PURPOSE. The common outcome is
    # InvalidDBInstanceState because the instance is ALREADY STOPPED — which is the
    # desired state, not an error. Retrying it would generate noise for a success, and
    # a DLQ would collect messages nobody should act on. A genuine permissions failure
    # still surfaces in CloudTrail and in the schedule's own metrics.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# ── Guard: an environment without a cache must run no tasks ───────────────────
# `cache.enabled = false` deletes the node, and ElastiCache has no stopped state, so
# this is the only way to stop an idled environment paying for one. But a task that
# cannot reach its cache does NOT fail loudly: `env.schema.ts` defaults REDIS_URL to
# localhost, and both the token denylist and the rate limiter FAIL OPEN when Valkey is
# unreachable. So the dangerous state is not "no cache" — it is "no cache, tasks
# running", which degrades two security controls silently.
#
# Enforced by a `validation` block on `var.cache` in variables.tf. It WAS a `check` here,
# and the comment claimed it made the combination "impossible to reach through Terraform:
# the plan fails". That was false — a violated check warns and the plan exits 0 — so the
# state that silently degrades two security controls would have applied cleanly. Waking an
# idled environment is one coherent change: cache back on, floors back to 1.


# Scale the services to zero on the same cadence as the database stop.
#
# `desired_count` is under `ignore_changes` in the ecs-service module, so setting it
# out of band is the sanctioned, non-drifting mechanism — which is why this uses
# ecs:UpdateService rather than an autoscaling scheduled action. A scheduled action
# would mutate the scalable target's min/max, and `aws_appautoscaling_target` has no
# `ignore_changes` on those, so every plan would show drift and any apply during the
# idle window would silently wake the environment.
#
# The floor being 0 (see api.min_count) is what makes this hold: with a floor of 1,
# Application Auto Scaling restores the service within minutes.
resource "aws_scheduler_schedule" "ecs_scale_down" {
  for_each = var.idle_schedule == null ? {} : {
    api    = module.api.service_name
    worker = module.worker.service_name
  }

  name        = "${local.name}-${each.key}-scale-down"
  description = "Scales ${each.value} to zero; see var.idle_schedule"

  schedule_expression          = var.idle_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ecs:updateService"
    role_arn = aws_iam_role.idler[0].arn
    input = jsonencode({
      Cluster      = module.ecs_cluster.cluster_name
      Service      = each.value
      DesiredCount = 0
    })

    # Idempotent — scaling an already-zero service to zero succeeds — so unlike the RDS
    # stop this one has no expected-failure case. Retries stay off for consistency; a
    # missed run is corrected by the next tick.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# ── Waking (the reverse of idling) ────────────────────────────────────────────
# Starts the database and restores both services, on a cron. See var.wake_schedule
# for why this exists at all — the short version is that "the deploy pipeline is the
# wake signal" covers the days the environment is CHANGED but not the days it is
# merely USED, and RDS takes ~4-5 minutes to come up, so a person who finds it
# stopped cannot simply wait it out.
#
# A SEPARATE ROLE from the idler, which is the whole point. The idler's policy says
# in its own comment that it is stop-only because "a role that can also start an
# instance turns a scheduling mistake into a cost increase". That is still true, so
# the start grants live here instead of being added there: a fault in the wake cron
# can cost money, and a fault in the idle cron can cost availability, but neither
# can now cause the other.
resource "aws_iam_role" "waker" {
  count = var.wake_schedule == null ? 0 : 1
  name  = "${local.name}-waker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      # Same confused-deputy guard as the idler.
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy" "waker" {
  count = var.wake_schedule == null ? 0 : 1
  name  = "wake-environment"
  role  = aws_iam_role.waker[0].id

  # Start only, mirroring the idler's stop-only. No rds:StopDBInstance here, and no
  # rds:DeleteDBInstance / RebootDBInstance — this role's entire job is to add
  # capacity back.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "StartDatabase"
        Effect   = "Allow"
        Action   = "rds:StartDBInstance"
        Resource = module.rds.instance_arn
      },
      {
        Sid    = "RestoreServices"
        Effect = "Allow"
        Action = "ecs:UpdateService"
        Resource = [
          module.api.service_arn,
          module.worker.service_arn,
        ]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "rds_start" {
  count       = var.wake_schedule == null ? 0 : 1
  name        = "${local.name}-rds-start"
  description = "Starts ${module.rds.identifier}; see var.wake_schedule for why this exists"

  schedule_expression          = var.wake_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:rds:startDBInstance"
    role_arn = aws_iam_role.waker[0].arn
    input    = jsonencode({ DbInstanceIdentifier = module.rds.identifier })

    # Mirror of the stop schedule: starting an already-started instance fails with
    # InvalidDBInstanceState, which is the DESIRED state and not an error. No retries
    # and no DLQ, for the same reason.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# Restore both services on the same cadence as the database start.
#
# DesiredCount is a literal 1, NOT var.api.min_count — see var.wake_schedule. The
# floors are 0 in an idled environment and have to stay 0, or Application Auto Scaling
# undoes the idle within minutes. 1 is the count the deploy pipeline sets, so a wake
# and a deploy agree.
#
# The tasks will come up before RDS finishes starting and will fail their readiness
# check for a few minutes. That is accepted: ECS keeps replacing them and they settle
# once postgres answers, which is the same behaviour a deploy-triggered wake already
# produces today. Sequencing the two would need a state machine, for a few minutes of
# 503 on a develop environment nobody is paged for.
resource "aws_scheduler_schedule" "ecs_scale_up" {
  for_each = var.wake_schedule == null ? {} : {
    api    = module.api.service_name
    worker = module.worker.service_name
  }

  name        = "${local.name}-${each.key}-scale-up"
  description = "Restores ${each.value} to 1 task; see var.wake_schedule"

  schedule_expression          = var.wake_schedule
  schedule_expression_timezone = "Asia/Ho_Chi_Minh"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = "arn:aws:scheduler:::aws-sdk:ecs:updateService"
    role_arn = aws_iam_role.waker[0].arn
    input = jsonencode({
      Cluster      = module.ecs_cluster.cluster_name
      Service      = each.value
      DesiredCount = 1
    })

    retry_policy {
      maximum_retry_attempts = 0
    }
  }
}

# ── Guard: waking an environment that never idles is a cost increase ──────────
# `wake_schedule` with no `idle_schedule` produces an environment that is started on a
# cron and never stopped by anything — strictly worse than not scheduling it at all,
# because it also looks deliberate. The reverse IS legitimate (production idles before
# go-live and is woken only by a release), so this is asserted in one direction only.


# ── Guard: a cache-less environment must not be woken ─────────────────────────
# The mirror of `idled_environment_runs_no_tasks` above. That check stops an idled
# environment from RUNNING tasks without a cache; this one stops a schedule being
# created that would START them. Without it the two settings are individually valid
# and jointly produce the exact state the other check exists to prevent — tasks up,
# no cache, REDIS_URL falling back to localhost, denylist and rate limiter failing
# open — except on a timer, at 08:00, with nobody watching.


# ── Outbound email: the permission half ───────────────────────────────────────
#
# The IDENTITY is created once in `infra/live/_shared` (per account+region, and both environments
# share both). What belongs here is the runtime grant: without `ses:SendEmail` on the task role, every
# send fails with AccessDenied before the sender is even looked at — which is what both environments
# did, while `EMAIL_PROVIDER=ses` and `MAIL_FROM_EMAIL` sat correctly configured beside it. Three
# failures then opened the app's in-process email circuit breaker and the API kept reporting healthy,
# so invitations and notifications were silently dead.
#
# The shared `ecs-service` module takes no policy input, so this attaches to the role it outputs.
# `split("/", arn)[1]` is the same idiom `infra/live/_shared` already uses for the deploy-role guards.
#
# SCOPED TWO WAYS, because a bare `ses:SendEmail` on `"*"` would let a compromised task send as any
# verified identity in the account — including prod's — from either environment:
#   • `Resource` is this account's identity for the sender's own domain, so develop cannot send
#     through an identity it does not share;
#   • `ses:FromAddress` pins the envelope sender to `MAIL_FROM_EMAIL` exactly, so the grant cannot be
#     used to impersonate another address on the same domain.
# The ARN is CONSTRUCTED rather than read from the shared state on purpose: IAM happily references a
# resource that does not exist yet, so the two applies can run in either order and the permission
# simply starts working once the identity is verified. A remote-state dependency would make this
# stack fail until `_shared` had been applied.
locals {
  mail_domain      = split("@", var.mail_from_email)[1]
  ses_identity_arn = "arn:aws:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/${local.mail_domain}"

  ses_send_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["ses:SendEmail", "ses:SendRawEmail"]
        # BOTH resources, or a send that names a configuration set is denied on the
        # config-set ARN even with the identity allowed: SES evaluates EVERY resource the
        # request touches. Found live — worker emails failed with AccessDenied on
        # 'configuration-set/rova-email-feedback' the moment #468 tagged sends with it,
        # opening the email circuit breaker in both environments.
        Resource = [local.ses_identity_arn, "arn:aws:ses:${var.region}:${data.aws_caller_identity.current.account_id}:configuration-set/rova-email-feedback"]
        Condition = {
          StringEquals = { "ses:FromAddress" = var.mail_from_email }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "api_ses_send" {
  name   = "${local.name}-api-ses-send"
  role   = split("/", module.api.task_role_arn)[1]
  policy = local.ses_send_policy
}

# The worker relays the outbox, so it sends MORE mail than the API does — the API only sends inline
# where a caller waits for the result. Both need it; a grant on one is a half outage that looks like a
# flake.
resource "aws_iam_role_policy" "worker_ses_send" {
  name   = "${local.name}-worker-ses-send"
  role   = split("/", module.worker.task_role_arn)[1]
  policy = local.ses_send_policy
}


# ── SES asynchronous feedback, PER ENVIRONMENT ───────────────────────────────
#
# The loop's whole point is that a verdict lands on the row that sent it, in the
# DATABASE that sent it — so the queue an environment drains must be its own. The
# first cut of this lived in _shared with one config set, topic and queue for both
# environments, and both workers long-polled that one queue: whichever polled first
# consumed the event, and when it was the other environment's worker the verdict
# logged "matched no sent row" in one database while the sending row stayed bare in
# the other. Observed live twice on 2026-08-21. The SES IDENTITY above this comment
# stays shared — it is one-per-account-and-region — but a configuration set is an
# ordinary named resource and each environment owns its own chain end to end.
#
# EXPAND FIRST: the shared chain is removed from _shared in the change AFTER this
# one deploys (the repo's own #394 rule — removing infrastructure running code still
# uses needs the deploy first). Until then both chains exist and the workers, on
# their new task definitions, use only their own.
#
# The queue policy is the delivery half: aws_sns_topic_subscription confirms the
# subscription, but each published event is a separate cross-service call that SQS
# authorizes against this policy — without it every verdict dies between the two
# services while every metric reads green. Also diagnosed live, same day.
resource "aws_sesv2_configuration_set" "email_feedback" {
  # `configuration_set_name`, not `name`: the pinned provider predates the rename.
  configuration_set_name = "${local.name}-email-feedback"
}

resource "aws_sns_topic" "ses_bounce_events" {
  name = "${local.name}-ses-bounce-events"
}

resource "aws_sesv2_configuration_set_event_destination" "bounces" {
  configuration_set_name = aws_sesv2_configuration_set.email_feedback.configuration_set_name
  event_destination_name = "bounce-complaints-to-sqs"

  event_destination {
    enabled              = true
    matching_event_types = ["BOUNCE", "COMPLAINT"]
    sns_destination {
      topic_arn = aws_sns_topic.ses_bounce_events.arn
    }
  }
}

resource "aws_sqs_queue" "ses_bounce_feedback" {
  name = "${local.name}-ses-bounce-feedback"
}

resource "aws_sqs_queue_policy" "ses_bounce_feedback" {
  queue_url = aws_sqs_queue.ses_bounce_feedback.url

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "sns.amazonaws.com" }
        Action    = "sqs:SendMessage"
        Resource  = aws_sqs_queue.ses_bounce_feedback.arn
        Condition = {
          ArnEquals = { "aws:SourceArn" = aws_sns_topic.ses_bounce_events.arn }
        }
      },
    ]
  })
}

resource "aws_sns_topic_subscription" "ses_bounce_to_sqs" {
  topic_arn = aws_sns_topic.ses_bounce_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.ses_bounce_feedback.arn
}

# This queue had NO alarm of any kind — checked, zero aws_cloudwatch_metric_alarm
# resources reference it anywhere in this repo, unlike every other AWS resource the
# stack owns. If BounceFeedbackService's long-poll loop stalls (a bug, a permission
# change, a worker deploy that drops the consumer), bounce/complaint events pile up
# silently: no failed health check, no 5xx, nothing — the app keeps sending mail to
# addresses SES already told us are bad, which is the compliance-relevant failure
# mode, not just a queue-depth one.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_queue_depth" {
  alarm_name          = "${local.name}-ses-bounce-queue-depth-high"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.ses_bounce_feedback.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 100
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.observability.alarm_topic_arn]
  tags                = local.tags
}

# The direct "is anyone draining this" signal — depth alone can spike from a real
# burst of bounces/complaints and clear on its own; age only grows when nothing is
# consuming. 1 hour is generous: BounceFeedbackService long-polls continuously, so a
# healthy consumer never lets a message sit anywhere near that long.
resource "aws_cloudwatch_metric_alarm" "ses_bounce_queue_stalled" {
  alarm_name          = "${local.name}-ses-bounce-queue-stalled"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.ses_bounce_feedback.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 3600
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [module.observability.alarm_topic_arn]
  tags                = local.tags
}

# The feedback half of the SES loop: the worker's BounceFeedbackService long-polls the shared
# bounce queue. Scoped to the ONE queue and the three calls a drain makes — Receive to claim a
# batch, Delete to acknowledge (which the consumer does whether or not the event matched a row,
# so an unmatched event can never poison the queue into a retry that cannot succeed), and
# GetQueueAttributes for the SDK's standard startup probe. No wildcard: a compromised worker
# must not be able to drain or tamper with any other queue in the account.
resource "aws_iam_role_policy" "worker_sqs_bounce_feedback" {
  name = "${local.name}-worker-sqs-bounce-feedback"
  role = split("/", module.worker.task_role_arn)[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        # Deterministic queue name, so the ARN needs no remote-state round trip — the same
        # reason ses_identity_arn is constructed. The queue is created in _shared with this name.
        Resource = aws_sqs_queue.ses_bounce_feedback.arn
      },
    ]
  })
}
