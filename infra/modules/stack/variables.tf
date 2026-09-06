// The product stack's input surface.
//
// Everything an environment CHOOSES is here; everything DERIVED from those choices
// lives in main.tf's locals. That split is the point of the module: develop and prod
// can no longer differ in structure, only in the values below, so a change made for
// one environment is automatically made for both.
//
// Defaults lean SAFE rather than cheap — a forgotten input should err toward
// production behaviour (no Spot, longer retention, deletion protection on), because
// the failure mode of a too-cheap production is worse than a too-careful develop.

// ── Identity ────────────────────────────────────────────────────────────────────

variable "product" {
  description = "Product slug. Drives resource names, ECR repos, secret prefixes and the metric namespace."
  type        = string
}

variable "env" {
  description = "Environment name as it appears in tags, secret prefixes and the metric namespace (e.g. develop, production)."
  type        = string
}

variable "env_slug" {
  description = <<-EOT
    Short environment token used in RESOURCE NAMES (`<product>-<env_slug>`).
    Deliberately separate from `env`: existing resources are named `rally-prod`
    while the environment is called `production`, and renaming them would force
    replacement of the cluster, RDS instance and log groups.
  EOT
  type        = string
}

variable "region" {
  type = string
}

// ── Networking / DNS ────────────────────────────────────────────────────────────

variable "app_domain" {
  description = "Public SPA hostname. Also drives CORS_ORIGINS, APP_BASE_URL and ENTRA_REDIRECT_URI."
  type        = string
}

variable "api_domain" {
  description = "Public API hostname, used for the ALB host-header rule and the SPA proxy's API_ORIGIN."
  type        = string
}

variable "web_record" {
  description = "Cloudflare CNAME label for the SPA (e.g. `rally-dev`, `rally`)."
  type        = string
}

variable "api_record" {
  description = "Cloudflare CNAME label for the API (e.g. `rally-api-dev`, `rally-api`)."
  type        = string
}

// ── Remote state ────────────────────────────────────────────────────────────────

variable "shared_state_key" {
  description = "State key of the product's _shared stack (ECR, KMS, Cloudflare zone)."
  type        = string
}

variable "runtime_state_key" {
  description = "State key of the platform runtime stack for this environment (VPC, ALB, SGs)."
  type        = string
}

variable "storage_state_key" {
  description = "State key of the platform storage stack for this environment (R2 buckets)."
  type        = string
}

// ── Application ─────────────────────────────────────────────────────────────────

variable "image_tag" {
  description = "Container image tag for api/worker/migrator. `latest` is acceptable in develop; production should pin a release tag."
  type        = string
  default     = "latest"
}

variable "cache" {
  description = <<-EOT
    Cache sizing. Encryption is NOT an option here: the module always enables
    KMS at rest and TLS in transit, so both environments get the same posture and
    the URL is always `rediss://`.

    `serverless` mode floors at roughly $90/month, so `node` is the default for
    both environments; a single cache.t4g.micro is about $12/month.
  EOT
  type = object({
    # Create the cache node at all. False is for an environment that is deliberately
    # idle: ElastiCache cannot be stopped, only deleted, so a node is the one component
    # of an idled environment that keeps billing. Requires min_count = 0 on both
    # services — the `check` block in main.tf enforces that, because a task without a
    # reachable cache does NOT fail loudly (see the note on local.redis_url).
    enabled   = optional(bool, true)
    mode      = optional(string, "node")
    node_type = optional(string, "cache.t4g.micro")

    # Use the SHARED node in the runtime layer instead of creating one for this product.
    #
    # ElastiCache has no stopped state, so a per-product dev cache bills 730 h/month no
    # matter how little the environment runs — two products meant two nodes at $15.45
    # each while the services they serve were idle two-thirds of the week. The runtime
    # layer already owned the security group and the subnets; only the node was
    # duplicated. See qnsc-infra live/runtime-dev, module.shared_cache.
    #
    # DEVELOP ONLY. Production keeps its own node: a shared cache is a shared blast
    # radius, and prod does not trade isolation for $15/mo.
    shared = optional(bool, false)

    # Which Valkey database this product uses on the shared node. IGNORED when
    # `shared = false` — a dedicated node has no one to collide with.
    #
    # NOT A KEY PREFIX, deliberately. A prefix convention has to be honoured by every
    # library that touches the connection; a database index is enforced by the server.
    # Cluster mode is disabled on the shared node (num_cache_clusters = 1), so all 16
    # databases exist and SELECT works.
    #
    # ALLOCATE CENTRALLY, because two products silently sharing an index is exactly the
    # collision this exists to prevent, and nothing detects it at plan time:
    #     0  rally
    #     1  qnsc-kb   (Celery broker AND result backend — see below)
    db_index = optional(number, 0)
  })
  default = {}

  # `validation`, not a `check` block. A violated check emits
  # `Warning: Check block assertion failed` and the plan exits 0 — measured on OpenTofu
  # 1.12.3 — so a guard written that way lets exactly the state it forbids apply cleanly.
  # A cross-variable validation exits 1.
  validation {
    # `cache.enabled = false` deletes the node, which is the only way to stop an idled
    # environment paying for ElastiCache. But a task that cannot reach its cache does NOT
    # fail loudly: REDIS_URL falls back to localhost and both the token denylist and the rate
    # limiter fail OPEN. So the dangerous state is not "no cache" — it is "no cache, tasks
    # running", which degrades two security controls while health checks still answer 200.
    condition     = var.cache.enabled || (var.api.min_count == 0 && var.worker.min_count == 0)
    error_message = "cache.enabled = false requires min_count = 0 on BOTH services. Without a cache, tasks do not fail loudly — REDIS_URL falls back to localhost and the token denylist and rate limiter fail open. Set both floors to 0, or re-enable the cache."
  }

  validation {
    # `shared` without `enabled` reads as "use the shared cache" and silently produces the
    # cache-disabled URL, which is the fail-open state the validation above exists to
    # prevent — reached by a different route.
    condition     = !var.cache.shared || var.cache.enabled
    error_message = "cache.shared = true requires cache.enabled = true. `shared` selects WHERE the cache is, not WHETHER there is one."
  }

  validation {
    condition     = var.cache.db_index >= 0 && var.cache.db_index <= 15
    error_message = "cache.db_index must be 0-15: Valkey exposes 16 databases when cluster mode is disabled, which is what the shared node runs."
  }
}

variable "platform_admin_emails" {
  description = "Emails auto-granted workspace_admin on every SSO login."
  type        = list(string)
  default     = []
}

variable "mail_from_email" {
  description = <<-EOT
    Verified sender for all outbound mail. REQUIRED while email_provider is not "dev":
    the API now fails at boot without it, deliberately, because the previous behaviour was
    to send every message as `"Mini Rally" <>`, have SES reject each one, open the email
    circuit breaker and report healthy — a silent outage of invitations, notifications and
    password resets in both environments.

    The address (or its domain) must be a verified identity in the target account's SES,
    or every send still fails — Terraform cannot check that for you.
  EOT
  type        = string
  default     = "noreply@qnsc.vn"

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.mail_from_email))
    error_message = "mail_from_email must be a single bare email address (no display name)."
  }
}

variable "seed_on_deploy" {
  description = "Whether the migrator runs the demo seed after migrating. Never true in production."
  type        = bool
  default     = false
}


variable "internal_email_domains" {
  description = <<-EOT
    Comma-separated email domains that are INTERNAL to this deployment's Entra tenant
    (exact domains; subdomains are deliberately not matched). An invited address on one
    of these is a directory member signing in over the workspace SSO connection, so
    `inviteMember` skips the B2B guest queue for them — the same-tenant Graph collision
    the relay would resolve as "nothing to do" — and their invitation is additionally
    deliverable by the copy-link route, which exists precisely because same-tenant mail
    is the cohort a receiving filter is most likely to quarantine as spoofed. Empty
    string = the distinction is off and every address is treated as external.
  EOT
  type        = string
  default     = ""
}

variable "entra_guest_invite_enabled" {
  description = <<-EOT
    Whether an invitation also provisions the invitee as an Entra B2B GUEST via Microsoft Graph.

    OFF is the safe default and the only correct value until the tenant has granted the
    `User.Invite.All` APPLICATION permission with admin consent to the app registration in
    `entra_client_id`. Without that grant every queued row dead-letters with a 403, and — because the
    guest-invite relay owns the invitation email once this is on — the invitee would hear nothing at
    all rather than receiving a link they cannot use.

    Turning it ON also moves the invitation email off the API and onto the worker, so the worker
    becomes a dependency of onboarding. Read the guest-invite section of CLAUDE.md before enabling it
    in an environment people rely on.
  EOT
  type        = bool
  default     = false
}

variable "entra_tenant_id" {
  type = string
}

variable "entra_client_id" {
  type = string
}

variable "github_app_id" {
  description = "GitHub App ID for SCM discovery/backfill. Empty keeps the SCM path dormant."
  type        = string
  default     = ""
}

// ── Per-environment tuning ──────────────────────────────────────────────────────

variable "log_retention_days" {
  description = "CloudWatch log retention for api, worker and migrator. Production keeps 90 for SOC 2."
  type        = number
  default     = 90
}

variable "secrets_recovery_window_days" {
  description = <<-EOT
    Secrets Manager recovery window. 0 in develop so a destroy+redeploy cycle does
    not hit "secret scheduled for deletion"; production keeps a real window so a
    mistaken destroy is recoverable.
  EOT
  type        = number
  default     = 30
}

# ── Secret bundling (cost) ────────────────────────────────────────────────────
# Secrets Manager bills $0.40 per SECRET per month regardless of size. This stack
# creates 13 per environment, so 26 containers hold ~2.4 KB for ~$10.40/mo against a
# 64 KB per-secret limit. Bundling collapses each environment's set into ONE JSON
# object read per key by ECS, for $0.80 total.
#
# STAGED IN FOUR APPLIES, per the secrets module's `use_bundle` docs. The dangerous
# ordering is cutting the references over and destroying the old secrets together: if
# the bundle is wrong the values it replaced are already gone, and develop sets
# recovery_window_days = 0, so gone means gone.
#
#   1. bundle_name = "app"                          create the empty bundle
#   2.                                              populate it OUT OF BAND from the
#                                                   standalone values (not Terraform —
#                                                   values never enter state)
#   3. use_bundle = true, create_standalone = true  references cut over, old secrets
#                                                   RETAINED; revert to roll back
#   4. drop create_standalone                       old secrets destroyed, saving lands
#
# Step 3 is the only one that can fail, and it fails safely: a missing or misspelled
# key means the task cannot boot, the rollout never reaches steady state, and the
# previous task definition still points at secrets that still exist.
variable "secrets_bundle_name" {
  description = <<-EOT
    Name of the bundled secret, created as "<product>/<env>/<name>". Empty (default)
    keeps one Secrets Manager secret per entry. Setting this creates the bundle but
    does NOT switch anything onto it — see `secrets_use_bundle`.
  EOT
  type        = string
  default     = ""
}

variable "secrets_use_bundle" {
  description = <<-EOT
    Read secrets from the bundle instead of the standalone containers. Requires
    `secrets_bundle_name`, and requires the bundle to already hold every key — a
    reference to an absent key fails the task at boot.
  EOT
  type        = bool
  default     = false
}

variable "secrets_create_standalone" {
  description = <<-EOT
    Whether the per-entry standalone secrets still exist. Defaults to
    `!secrets_use_bundle`, which is correct outside a migration.

    Set TRUE alongside `secrets_use_bundle` for the retained-rollback step: both exist,
    references point at the bundle, and reverting one line rolls back without needing
    the destroyed values. Drop it once the bundle is proven to realise the saving.
  EOT
  type        = bool
  default     = null
}

variable "rds" {
  description = "Database sizing and durability. No defaults for storage or protection — both callers state them explicitly, so neither is production-critical by accident."
  type = object({
    instance_class           = string
    allocated_storage_gb     = number
    max_allocated_storage_gb = number
    multi_az                 = bool
    deletion_protection      = bool
    backup_retention_days    = number
    monitoring_interval      = optional(number, 0)
  })
}

variable "api" {
  description = <<-EOT
    API service sizing and scaling.

    The autoscaling targets restate the ecs-service module's own defaults (65/75) rather
    than defaulting to null. `null` is NOT "use the module's default" for a nested
    optional attribute — it is passed straight through, and
    `target_tracking_scaling_policy_configuration.target_value` is a required argument,
    so the plan fails with "Missing required argument". Restating the numbers also keeps
    every environment's target explicit and reviewable.
  EOT
  type = object({
    cpu       = number
    memory    = number
    max_count = number
    # Autoscaling FLOOR. 1 by default because a service that can reach zero is a
    # service that can be silently down; set it to 0 only to idle an environment
    # deliberately (see the idle posture in ../../live/prod/main.tf).
    #
    # It has to be an input rather than a constant: the autoscaling floor is what
    # decides whether a scale-to-zero holds, so with it hardcoded the next apply
    # quietly restored a deliberately idled environment.
    min_count = optional(number, 1)

    # Create the scalable target and the CPU/memory target-tracking policies at all.
    #
    # False for an environment whose desired count is driven EXTERNALLY — a deploy that
    # restores it plus `idle_schedule` that puts it back down.
    #
    # Such an environment needs a floor of 0, or the scheduled scale-to-zero is restored
    # within minutes and the environment never sleeps. But a scalable target with a floor
    # of 0 is INERT: target tracking scales proportionally and so cannot compute zero from
    # a running task, and a service at zero tasks publishes no CPU or memory metric for it
    # to scale out from. It therefore neither fights the schedule nor protects anything,
    # while billing four CloudWatch alarms per service. Turning it off is the honest
    # description of what is already happening — see the validation below for the measured
    # evidence, and for why a LIVE environment must not be left in this state.
    #
    # `min_count`, `max_count` and the target percentages are then inert AS SCALING
    # INPUTS, but `max_count` still sizes the connection pool and `min_count` still
    # derives `environment_idle` below, so both stay meaningful — do not delete them.
    enable_autoscaling = optional(bool, true)

    use_spot = optional(bool, false)

    # Inert while enable_autoscaling is false. Kept set anyway in prod, so go-live
    # restores production's chosen targets rather than the module defaults.
    cpu_target_pct    = optional(number, 65)
    memory_target_pct = optional(number, 75)
  })

  # A LIVE environment must not combine autoscaling with a floor of 0, because that
  # combination cannot recover from reaching zero.
  #
  # This module's only policies are CPU and memory target tracking, and a service running
  # no tasks publishes NEITHER metric. There is therefore nothing for a scale-out to
  # evaluate: whatever takes the service to zero — the idle schedule, a failed deploy, a
  # mistaken `update-service` — is permanent as far as Application Auto Scaling is
  # concerned. A floor of at least 1 is the only thing that makes it restore capacity.
  #
  # So the floor is not a formality; with autoscaling on it is the entire self-healing
  # mechanism. Validating the pair here means a go-live that turns `enable_autoscaling`
  # back on and forgets `min_count` fails the plan, instead of producing a production that
  # looks scaled and silently stays down the first time anything scales it to zero.
  #
  # Measured, so the reasoning is not inverted: this is NOT a claim that target tracking
  # drives a service to zero on its own — it cannot. Scaling is proportional
  # (ceil(tasks x metric / target)), so from 1 task at ~1% CPU it computes ceil(0.015) = 1.
  # Develop ran for hours at 0.07-1.0% average CPU against a floor of 0 and Application
  # Auto Scaling logged ZERO scaling activities across its six-week retention. With a floor
  # of 0 the scalable target is simply inert in both directions, which is the other half of
  # why an idle environment should not carry one: it protects nothing while billing four
  # CloudWatch alarms per service.
  #
  # An environment that deliberately wants a floor of 0 drives its count externally — a
  # deploy raises it, `idle_schedule` lowers it — and must keep autoscaling off.
  validation {
    condition     = !var.api.enable_autoscaling || var.api.min_count >= 1
    error_message = "api.enable_autoscaling = true requires min_count >= 1 (got ${var.api.min_count}). Target tracking scales on CPU and memory, which a service at zero tasks does not publish, so nothing can scale it back out — a floor of at least 1 is what restores capacity. Raise the floor, or set enable_autoscaling = false and let the deploy and idle_schedule own the count."
  }
}

variable "worker" {
  description = "Worker service sizing and scaling."
  type = object({
    cpu       = number
    memory    = number
    max_count = number
    # See api.min_count and api.enable_autoscaling.
    min_count          = optional(number, 1)
    enable_autoscaling = optional(bool, true)
    use_spot           = optional(bool, false)
  })

  # See the same validation on `api` for why this pair is enforced.
  validation {
    condition     = !var.worker.enable_autoscaling || var.worker.min_count >= 1
    error_message = "worker.enable_autoscaling = true requires min_count >= 1 (got ${var.worker.min_count}). Target tracking scales on CPU and memory, which a service at zero tasks does not publish, so scaling in to zero is one-way. Raise the floor, or set enable_autoscaling = false and let the deploy and idle_schedule own the count."
  }
}

variable "observability" {
  description = <<-EOT
    Telemetry export. `otlp_endpoint` is the master switch: while it is empty no
    collector sidecar is created, `OTEL_ENABLED` stays false, and the whole OTel
    path is dormant — so this can be adopted before a backend exists.

    Turning it on is two steps, in this order:
      1. put the Authorization header in the `observability-token` secret
      2. set `otlp_endpoint` here
    Reversing them starts a collector that cannot authenticate.

    `sampling_probability` is HEAD sampling, the only lever the SDK has alone.
    1.0 in develop (volume is trivial and full fidelity is the point of enabling it
    there); lower in production for cost. Be aware that anything below 1.0 drops
    most ERROR traces too — keeping all errors needs tail sampling, which needs a
    gateway that sees whole traces, not a per-task sidecar.
  EOT
  type = object({
    otlp_endpoint        = optional(string, "")
    sampling_probability = optional(number, 1.0)
  })
  default = {}
}

variable "grafana_alerting_auth" {
  description = <<-EOT
    Stack service account token — qnsc-infra/live/observability's
    `alerting_service_account_token` output. A SEPARATE variable from
    `grafana_alerting` below (not nested in that object), same reason
    `cloudflare_api_token` is its own top-level variable rather than folded
    into some larger config object: this carries a raw secret value directly
    through Terraform, and `sensitive = true` only masks plan/apply OUTPUT
    for a variable as a whole — nesting it would either blunt-hide the
    harmless fields alongside it or not mask this one at all.

    The master switch, same pattern as `observability.otlp_endpoint` above:
    while empty, `module.alerts` is not created at all — count, not a
    dormant no-op module, because `observability-alerts` has no provider
    block of its own (a module that configures its own provider cannot be
    used with count/for_each at all — see that module's README) and
    inherits the ROOT's `grafana` provider automatically. The root provider
    itself is configured unconditionally (providers can't be conditional),
    but touches nothing at all while count is 0.

    Reaches Terraform via TF_VAR_grafana_alerting_auth in CI
    (GRAFANA_ALERTS_TOKEN secret) — NEVER through AWS Secrets Manager,
    unlike the OTLP token: this credential is needed at PLAN/APPLY time
    only, nothing running in a task ever calls the Grafana instance API.
  EOT
  type        = string
  sensitive   = true
  default     = ""
}

variable "grafana_alerting" {
  description = <<-EOT
    Grafana Alerting + Dashboards config, ALONGSIDE CloudWatch Alarms
    (monitor_target_health below), not replacing it — CloudWatch stays on
    infra-level signals it can see directly; this covers only what
    CloudWatch cannot (DB pool contention, HTTP error rate, latency, worker
    job failure rate) plus this product's own dashboard. None of these
    fields are secret — see `grafana_alerting_auth` for the one that is.

    `alerts_folder_uid`, `dashboards_folder_uid` and
    `product_dashboards_folder_uid` are THREE DIFFERENT folders in the same
    shared Grafana stack — do not collapse them. A real bug caught before
    merge: the dashboard resource briefly reused `alerts_folder_uid`, which
    would have filed rally's dashboard under the Alerts folder. A second
    real bug, caught in production: `product_dashboards_folder_uid` used to
    be a `grafana_folder` resource created HERE, once per environment —
    since develop and prod are separate Terraform root modules with
    separate state, that created two real, separate "Rally" folders. It is
    now qnsc-infra/live/observability's `rally_dashboards_folder_uid`
    output — a plain UID, created once, centrally, same as the other two.
  EOT
  type = object({
    url                           = optional(string, "https://qnsc.grafana.net")
    prometheus_datasource_name    = optional(string, "grafanacloud-qnsc-prom")
    logs_datasource_name          = optional(string, "grafanacloud-qnsc-logs")
    traces_datasource_name        = optional(string, "grafanacloud-qnsc-traces")
    alerts_folder_uid             = optional(string, "")
    dashboards_folder_uid         = optional(string, "")
    product_dashboards_folder_uid = optional(string, "")
    slos_folder_uid               = optional(string, "")
  })
  default = {}
}

variable "monitor_target_health" {
  description = <<-EOT
    Create the per-service UnHealthyHostCount alarm.

    OFF in develop on purpose. The alarm treats missing data as breaching, because a
    target group with no registered targets publishes nothing at all and that is exactly
    the outage worth paging on. But develop has an off-hours cost-saver that scales
    services to 0 (qnsc-ci's deploy reusable restores them), so zero tasks is a NORMAL
    state there and the alarm would sit permanently in ALARM — noise that trains people
    to ignore the topic every other alarm publishes to.
  EOT
  type        = bool
  default     = true
}

variable "container_insights" {
  description = <<-EOT
    ECS Container Insights mode: "enhanced", "enabled" or "disabled".

    Stated here rather than inherited. "enhanced" adds per-task and per-container metrics
    that CloudWatch bills as CUSTOM metrics at $0.07 each: four clusters silently on that
    default produced 606 metric-months (~$42) on the July 2026 bill, and the count grows
    with task churn rather than with traffic.

    The module used to DEFAULT to "enhanced", which is how those four clusters got there.
    ecs-cluster v2.0.0 changed that default to "enabled" — cluster- and service-level
    metrics, in the free AWS/ECS namespace — so inheriting is no longer expensive. Still
    stated explicitly, because "no longer expensive" is not the same as "queried by
    anything", and the audit below says nothing queries it.

    Defaults to "disabled" because an audit of every consumer found none: all 7 alarms
    and all 6 dashboard widgets read AWS/ECS, AWS/ApplicationELB and AWS/RDS, which are
    free and published regardless, and application metrics go to the OTLP backend rather
    than CloudWatch. Both environments state "disabled" explicitly; this default exists
    so a NEW environment does not start paying for metrics nothing queries.

    Raise an environment to "enhanced" while debugging a per-container resource problem,
    then put it back.
  EOT
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["enhanced", "enabled", "disabled"], var.container_insights)
    error_message = "container_insights must be enhanced, enabled, or disabled."
  }
}

variable "create_dashboard" {
  description = <<-EOT
    Create the CloudWatch dashboard for this environment. Alarms are created either way.

    CloudWatch bills dashboards per ACCOUNT: three free, then $3/mo each. Two products
    at two environments is four, so the fourth starts charging. Develop is the one to
    drop — alarms are what page someone, a dashboard is what you open afterwards, and
    nobody opens develop's.
  EOT
  type        = bool
  default     = true
}


variable "alarm_emails" {
  description = "Addresses subscribed to the alarm topic. Terraform creates the subscription; each recipient must still confirm by email."
  type        = list(string)
  default     = []
}

variable "cloudflare_account_id" {
  description = "Cloudflare account that owns the Pages project."
  type        = string
  default     = ""
}


variable "storage_public_credentials" {
  description = <<-EOT
    Inject the PUBLIC-bucket R2 credential into api and worker, so the token that writes
    world-readable avatars is not the token that reads every permission-gated attachment.

    OFF by default, and the default matters: the deploy preflight refuses to deploy when
    an injected Secrets Manager secret holds no value, so injecting these before they are
    populated BLOCKS every deploy. That is exactly what happened when they were wired
    unconditionally.

    Two-step, same shape as `db_least_privilege`. Before flipping it, in this environment:
      1. mint an R2 API token scoped to `<product>-<env>-public-assets` ONLY;
      2. put both halves into the `r2-public-access-key-id` /
         `r2-public-secret-access-key` secrets.
    Then set this true.

    While false, StorageService reuses the PRIMARY credential for both buckets — and in
    this account that credential is scoped to `<product>-<env>-attachments` alone, so every
    public-asset write 403s. Turning this on is therefore a FIX, not hardening. An earlier
    version of this text called the false path "the behaviour that predates the split" as
    though it were merely less isolated, and told you to re-mint the primary token
    afterwards; both were wrong. The primary tokens were never wider than attachments.
  EOT
  type        = bool
  default     = false
}

variable "db_least_privilege" {
  description = <<-EOT
    Point the api and worker tasks at the least-privilege Postgres roles
    (`rova_app` / `rova_worker`) instead of the RDS master credential.

    OFF by default so merging this changes nothing that is running. Today all
    three tasks connect as the master user, which OWNS every table: an ordinary
    HTTP request carries rights to DROP the schema it is reading, and any
    row-level policy is skipped, because Postgres exempts a table's owner from
    RLS unless FORCE ROW LEVEL SECURITY is also set. That exemption is what made
    the RLS layer in migration 0005 inert.

    This is the LAST of three steps, and the order is not fully enforceable in
    Terraform. Before flipping it, in this environment:
      1. `pnpm db:migrate` has run, so migration 0068 has created the roles;
      2. the `db-app-password` / `db-worker-password` secrets hold a value, and
         `db_role_passwords_set` is true;
      3. the cutover task has run, applying those values with
         `ALTER ROLE ... LOGIN PASSWORD ...` (see `db_role_passwords_set`).
    Flip it first and the tasks boot, fail to authenticate (28P01) and roll back.
    Step 2 is enforced by the validation below; step 3 cannot be, because Terraform
    has no way to observe `pg_roles`.

    The MIGRATOR is deliberately unaffected — it needs DDL, and narrowing it
    means transferring schema ownership, a separate and more disruptive step.

    Full sequence, verification and rollback: docs/runbooks/db-role-least-privilege.md
  EOT
  type        = bool
  default     = false
}

variable "db_role_passwords_set" {
  description = <<-EOT
    Inject `db-app-password` / `db-worker-password` into the MIGRATOR, so the
    one-off cutover task can run `ALTER ROLE ... LOGIN PASSWORD ...` against them.

    A SEPARATE flag from `db_least_privilege`, and it has to be. The two steps are
    strictly ordered — the roles need a password before anything authenticates as
    them — and each flag drives a different workload:

      db_role_passwords_set = true   → migrator can read the passwords, so the
                                       cutover task can set them on the roles
      db_least_privilege    = true   → api and worker authenticate as those roles

    Folding them into one flag makes the cutover impossible: a single apply would
    both hand the migrator the passwords and point the runtime at roles that are
    still NOLOGIN, so api and worker fail with 28P01 before the cutover task could
    run. Hence two flags, flipped in two applies.

    OFF by default for the same reason `storage_public_credentials` is: the deploy
    preflight refuses to deploy while an INJECTED Secrets Manager secret is empty,
    so a new environment that turned this on before populating the secrets would
    block every deploy. Populate first, then flip.

    Runbook: docs/runbooks/db-role-least-privilege.md
  EOT
  type        = bool
  default     = false

  validation {
    # Catches the ordering mistake that is actually reachable in Terraform.
    # `db_least_privilege` without this flag means the cutover task was never able
    # to run, so the roles have no password and both runtime tasks would 28P01.
    condition     = var.db_role_passwords_set || !var.db_least_privilege
    error_message = "db_least_privilege requires db_role_passwords_set = true first: the roles need a password before api/worker can authenticate as them. Populate the secrets, set db_role_passwords_set, apply, run the cutover task, then set db_least_privilege."
  }
}

variable "idle_schedule" {
  type        = string
  default     = null
  description = <<-EOT
    Cron/rate expression for an EventBridge Scheduler that IDLES this environment:
    stops the RDS instance AND scales both services to zero. Null (the default) creates
    no schedules, no role and no policy.

    Both halves matter. Stopping only the database leaves Fargate tasks running against
    an instance they cannot reach — still billed, unable to serve, and invisible,
    because `healthz` answers 200 regardless so the ALB keeps them registered.

    Required for any environment that is deliberately idle, because AWS FORCE-STARTS a
    stopped RDS instance after seven days. Without a recurring re-stop the instance
    quietly comes back and the saving disappears with nothing reporting it.

    MUST FIRE AT LEAST DAILY. This used to read "every Sunday 01:00 local — comfortably
    inside the 7-day window: cron(0 1 ? * SUN *)", and that example was wrong in a way
    both products copied.

    The 7-day window bounds when AWS force-STARTS the instance, not how long it then runs.
    Stop it on Sunday, AWS starts it the following Sunday, and the next weekly pass is up
    to seven days after that. So a weekly re-stop bounds the exposure at seven days rather
    than one. Measured on rally-prod under exactly that expression: 59 of 168 hours in a
    week published CloudWatch datapoints — a pre-launch database with no users, no tasks
    and no cache node running 35% of the time, roughly $4/mo for nothing.

    Daily costs nothing extra. Stopping an already-stopped instance fails with
    InvalidDBInstanceState, which is the DESIRED state rather than an error, so the target
    is configured with no retries and no dead-letter queue — and the ECS half scales
    services that a zero floor already holds at zero.

    Expression is evaluated in Asia/Ho_Chi_Minh. A daily pass, and develop's two-pass
    form (see the note above about deploys waking the environment):

        cron(0 1 * * ? *)        production, pre-launch
        cron(0 0,3 * * ? *)      develop

    See `wake_schedule` for the reverse. The two are independent on purpose: an
    environment may idle with no wake (production before go-live) but must never wake
    with no idle, which `check "wake_requires_idle"` enforces.
  EOT

  // Enforced, because the description alone did not hold: it recommended the weekly form
  // and both products shipped it to production.
  //
  // Checked rather than replaced by a named-posture enum ("pre-launch", "working-hours"):
  // three call sites across two repos do not justify inventing a vocabulary, and the
  // constraint is a property of the VALUE, so it belongs on the value.
  //
  // Fields are minute hour day-of-month month day-of-week year. Restricting either day
  // field, or the month, means the schedule skips days; `*` and `?` are the only spellings
  // that do not. A `rate(...)` expression is rejected as well — it cannot be checked this
  // way, and nothing here uses one.
  validation {
    condition = var.idle_schedule == null || can(
      regex("^cron\\([^ ]+ [^ ]+ [*?] [*?] [*?] [^ )]+\\)$", var.idle_schedule)
    )
    error_message = <<-EOT
      idle_schedule must fire at least daily: day-of-month, month and day-of-week must all
      be "*" or "?". AWS force-starts a stopped RDS instance after 7 days, so a weekly
      schedule leaves it running for up to six of them — rally-prod measured 35% uptime
      under "cron(0 1 ? * SUN *)". Use "cron(0 1 * * ? *)" for a daily pass, or
      "cron(0 0,3 * * ? *)" for develop's two-pass form.
    EOT
  }
}

variable "wake_schedule" {
  type        = string
  default     = null
  description = <<-EOT
    Cron/rate expression for the REVERSE of `idle_schedule`: starts the RDS instance and
    scales both services back to their configured counts. Null (the default) creates no
    wake schedules, no role and no policy — which is the correct setting for production,
    where the only intended wake is a release.

    This exists because "the deploy pipeline is the wake signal" is not sufficient on its
    own. It is correct that develop should be up on the days it is being CHANGED, but it
    also has to be up on the days it is being USED — a QA session on a morning nobody
    merged found the environment stopped, which reads as an outage rather than as a
    saving. RDS takes ~4-5 minutes to become available, so this cannot be fixed by
    waiting.

    A DAILY wake is usually the right shape, not a weekday-restricted one:

        cron(0 8 * * ? *)

    This variable's first version recommended MON-FRI, on the reasoning that a 7-day wake
    "pays for two days a week nobody works". Develop was set that way and the reasoning
    did not survive contact: people did work weekends, found the environment stopped, and
    had to start it by hand — a ~7 minute wait each time. Two extra wake-days are ~$2.50/mo
    against a ~$50/mo environment, which is a poor trade against a recurring interruption.

    Restrict to weekdays only where nobody CAN use the environment at a weekend (a shared
    QA environment for one office, say), not merely where nobody is expected to.

    Note the saving lives in `idle_schedule`, not here — the nightly stop is what takes
    the environment to zero. Widening the wake trims that saving at the edges; it does not
    remove it.

    Expression is evaluated in Asia/Ho_Chi_Minh, like `idle_schedule`.

    A SEPARATE IAM role from the idler, deliberately. The idler's policy is documented
    stop-only on the grounds that "a role that can also start an instance turns a
    scheduling mistake into a cost increase" — that reasoning survives here by keeping
    the grants split, so a fault in one schedule cannot undo the other. The waker holds
    rds:StartDBInstance and ecs:UpdateService; the idler still holds no start permission
    of any kind.

    THE WAKE COUNT IS 1, NOT min_count. This is the subtle part. `min_count = 0` is
    exactly what lets an idled service STAY at zero — with a floor of 1, Application Auto
    Scaling restores the service within minutes and the idle never holds (see
    api.min_count). So the floors cannot be raised to describe the woken state, and this
    schedule cannot read them. It writes a literal DesiredCount = 1, which is the same
    count the deploy pipeline sets, so a wake and a deploy converge on one answer.

    Consequence worth stating: this env has THREE writers of desired_count now — the
    deploy, `idle_schedule`, and this. All three set it out of band, which is sanctioned
    because `desired_count` is under `ignore_changes` in the ecs-service module. A fourth
    writer (a scheduled autoscaling action) would NOT be, and is why this is built as
    ecs:UpdateService.
  EOT

  # `validation`, not a `check` block. A violated check emits
  # `Warning: Check block assertion failed` and the plan exits 0 — measured on OpenTofu
  # 1.12.3 — so a guard written that way lets exactly the state it forbids apply cleanly.
  # A cross-variable validation exits 1.
  validation {
    # Waking an environment that nothing stops is strictly worse than not scheduling it: it
    # is started on a cron, never idled, and it LOOKS deliberate. The reverse is legitimate —
    # production idles and is woken only by a release — so this is one-directional.
    condition     = var.wake_schedule == null || var.idle_schedule != null
    error_message = "wake_schedule is set but idle_schedule is null, so this environment would be started on a schedule and never stopped by one. Set idle_schedule as well, or remove wake_schedule. (idle without wake is fine — that is production today.)"
  }

  validation {
    # Mirror of the cache/floors rule. That one stops an idled environment from RUNNING tasks
    # with no cache; this stops a schedule being created that would START them — otherwise
    # the two settings are individually valid and jointly produce the fail-open state on a
    # timer, at 08:00, unattended.
    condition     = var.wake_schedule == null || var.cache.enabled
    error_message = "wake_schedule is set but cache.enabled is false. Waking would start tasks with no cache to reach: REDIS_URL falls back to localhost and both the token denylist and the rate limiter fail open. Enable the cache, or remove wake_schedule."
  }
}

# ── Ingress (cost) ────────────────────────────────────────────────────────────
variable "tunnel_enabled" {
  description = <<-EOT
    Serve this environment's api through a Cloudflare Tunnel sidecar instead of the
    shared ALB.

    An ALB costs $18.40/mo plus $3.65 per enabled AZ, and every request already
    arrives through Cloudflare — the SPA is a Pages project whose Function proxies
    /v1/* to API_ORIGIN, and the ALB security group admits only Cloudflare edge
    ranges. The load balancer is a second TLS termination inside an already-proxied
    path.

    Turning this ON also turns OFF the ALB target-group attachment (`attach_alb`),
    because a task served by a tunnel must not simultaneously be an ALB target: the
    target group would health-check a port the tunnel already owns, and traffic could
    arrive by two paths with different TLS termination.

    REQUIRES `tunnel-token` in the environment's secret bundle — the connector token
    from `cloudflared`. Absent, the sidecar is not produced and the api would have NO
    ingress at all, so this variable and that secret must move together.

    WHAT IS GIVEN UP: ALB access logs, the option of an origin-side AWS WAF, and the
    per-target-group CloudWatch alarms. `monitor_target_health` in particular has no
    equivalent — production/main.tf calls it "the only alarm that catches an outage
    producing no load to move CPU, latency or 5xx" — so external monitoring (a
    Cloudflare health check or synthetic probe) has to replace it before this is
    relied on in production.
  EOT
  type        = bool
  default     = false
}

variable "tunnel_routing_managed" {
  description = <<-EOT
    Let Terraform own the tunnel's INGRESS RULES (the public hostname → local service
    mapping), instead of leaving them to whatever was configured by hand.

    WHY THIS IS OPT-IN RATHER THAN THE DEFAULT. A tunnel with no ingress rule is inert:
    it connects, reports healthy, and 503s every request — which is exactly how rally
    production went live. But turning routing on for a tunnel that is ALREADY SERVING is
    the dangerous direction: Cloudflare's tunnel-configuration API is a whole-document
    PUT, so a partial rule set silently discards anything the live configuration holds
    that this file does not reproduce, and `config_src` FORCES REPLACEMENT — a new UUID,
    a new CNAME target and a new connector token, i.e. an outage plus a secret rotation
    the running task only picks up on its next deployment.

    So the safe order is: adopt with this false (what develop still does, its rules
    created out of band on 2026-08-02), and switch it on per environment when that
    environment can absorb a replacement. Production could, on 2026-08-18, precisely
    because it was serving nothing yet.

    Requires `api_domain` — the hostname the rule is written for. `app_port` is the local
    service the connector forwards to, so the two cannot drift from what the task runs.
  EOT
  type        = bool
  default     = false
}

variable "monitor_ingress" {
  description = <<-EOT
    Create the Route 53 health check + us-east-1 alarm that probe the public api
    hostname from outside AWS. Only meaningful when `tunnel_enabled` — with an ALB
    that job belongs to `monitor_target_health`.

    THE ZERO-TASK CASE IS NOW HANDLED FOR YOU, so this variable is only for an
    environment that IS serving and still does not want the probe. `local.monitor_ingress`
    also requires `!local.environment_idle`, so an environment whose service floors are 0
    creates no check at all — the same rule this stack already applies to the load alarms.
    Raising the floors re-arms it in the same change, rather than leaving a note asking
    someone to remember.

    That matters because a health check against a hostname with no tasks behind it sits in
    ALARM permanently: it pages for a condition that IS the intended state, which trains the
    reader to ignore the one alarm that replaces every ALB target-group alarm — and it bills
    every month for that non-signal. develop was in exactly that position: floors of 0, an
    idle schedule taking it to zero tasks nightly and all weekend, and this variable unset so
    it took the `true` default.

    ON COST, stated correctly. This creates ONE health check on a non-AWS endpoint, one
    CloudWatch alarm, and an SNS topic that bills nothing until it publishes. The check runs
    with `measure_latency = false` and no string match, so NO optional-feature charge applies
    — only the base rate. An earlier version of this text quoted "$2.70/mo per check ($0.75
    base + $2.00 for the string-match/latency option)", which charged for two options the
    resource disables and inflated the figure by roughly 3.5x. Deciding against monitoring on
    a wrong number is worse than the number.

    A tunnelled environment has NO other ingress alarm — ECS reports a task RUNNING whether
    or not cloudflared holds edge connections — so setting this false on an environment that
    IS serving means an ingress outage is visible only when a user reports it.
  EOT
  type        = bool
  default     = true
}

variable "cpu_architecture" {
  type    = string
  default = "X86_64"
  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
  description = <<-EOT
    Fargate CPU architecture for the api, worker and migrator: "X86_64" or "ARM64".

    ARM64 (Graviton) bills ~20% less per vCPU-hour and GB-hour for identical sizing, with
    no capability difference — same Fargate platform, same networking, same limits.

    IT IS NOT A FREE FLAG. The image must be built for linux/arm64, or the container fails
    at start with "image Manifest does not contain descriptor matching platform" — a
    failure that appears at TASK START, after a clean apply and a deploy that reports a
    rollout. So this moves together with `build_runner` and `image_platforms` in the
    caller's deploy workflow, in one change, and the three task definitions here move
    together with each other: the migrator runs the same image family as the api.

    Build NATIVELY on an ARM runner (`ubuntu-24.04-arm`), not under QEMU emulation. The
    qnsc-ci reusable's own note is explicit that emulating an arm64 pnpm + Nest compile on
    an x86 runner multiplies build minutes by enough to outweigh the Fargate saving.

    NOT EVERY PRODUCT CAN TAKE THIS. It depends on every image in the task having an
    arm64 build — including sidecars. rally qualifies: the app is `node:alpine`
    (multi-arch), and both sidecars publish arm64 (`cloudflare/cloudflared` and
    `amazon/aws-otel-collector`, checked 2026-08-17). qnsc-kb does NOT: `clamav/clamav`
    is amd64-only on every published tag.

    Defaults to X86_64 so a caller that has not moved its build keeps working.
  EOT
}
