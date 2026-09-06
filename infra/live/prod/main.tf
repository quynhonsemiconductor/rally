// rally · production
//
// Structurally identical to ../develop by construction: the entire stack lives in
// ../../modules/stack and only the values below differ. Production takes the
// DEDICATED, durable settings — on-demand Fargate, RDS with deletion protection and
// 30-day backups, 90-day retention, a pinned image tag — while develop takes the
// shared, cheap ones.
//
// LIVE as of this change: service floors of 1, autoscaling on, cache node up, no idle
// schedule, ingress health check on. RDS stays single-AZ on t4g.micro with Enhanced
// Monitoring off — each of those is a costed decision with a named signal that revokes
// it, written above the `rds` block, not deferred maintenance.
//
// Security posture is NOT a per-environment value: the cache module always
// enables KMS at rest and TLS in transit, so develop cannot be the weaker one.
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    grafana    = { source = "grafana/grafana", version = "~> 3.0" }
  }

  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "rally/prod/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "qnsc-tofu-locks"
  }
}

provider "aws" {
  region = "ap-southeast-1"
  default_tags {
    tags = {
      Project     = "rally"
      Environment = "production"
      ManagedBy   = "opentofu"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token != "" ? var.cloudflare_api_token : null
}

// Configured UNCONDITIONALLY, like the cloudflare provider above — providers
// can't be conditional — but touches nothing at all while
// grafana_alerting_auth is empty: module.alerts (inside module.stack) is
// count-gated to zero in that state, so this config is simply never used
// for an actual API call. See modules/stack/variables.tf's
// grafana_alerting_auth for the full reasoning.
provider "grafana" {
  url  = var.grafana_alerting_url
  auth = var.grafana_alerting_auth
}

// Route 53 publishes health-check metrics ONLY to us-east-1, so the ingress alarm in
// module.stack has to be created there. Everything else stays in ap-southeast-1.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = {
      Project     = "rally"
      Environment = "production"
      ManagedBy   = "opentofu"
    }
  }
}

locals {
  region = "ap-southeast-1"
}

// ── The stack ─────────────────────────────────────────────────────────────────
module "stack" {
  source = "../../modules/stack"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  product = "rally"
  env     = "production"
  // Resources are named `rally-prod`, not `rally-production`: renaming them would
  // force replacement of the cluster, the RDS instance and every log group.
  env_slug = "prod"
  region   = local.region

  app_domain = "rally.qnsc.vn"
  api_domain = "rally-api.qnsc.vn"
  web_record = "rally"
  api_record = "rally-api"

  shared_state_key  = "rally/shared/terraform.tfstate"
  runtime_state_key = "platform/runtime-prod/terraform.tfstate"
  storage_state_key = "platform/storage-prod/terraform.tfstate"

  // Production runs the tag the release built, never a floating `latest`.
  image_tag = var.image_tag

  // Never seed demo data into production.
  seed_on_deploy        = false
  platform_admin_emails = var.platform_admin_emails

  entra_tenant_id = var.entra_tenant_id

  # qnsc.vn is the company tenant: those users are directory members on SSO, not B2B
  # guests — see the variable's own description for what this skips and unlocks.
  internal_email_domains = "qnsc.vn"
  entra_client_id        = var.entra_client_id
  github_app_id          = var.github_app_id

  // 90 days is the SOC 2 minimum; the recovery window keeps a mistaken destroy
  // recoverable.
  log_retention_days           = 90
  secrets_recovery_window_days = 30

  // ── Secret bundling · COMPLETE ──────────────────────────────────────────────
  // Every app secret lives in ONE container, rally/production/app, read per key by ECS
  // via the `<arn>:<key>::` form of valueFrom. Secrets Manager bills per SECRET
  // regardless of size, so this is 12 containers' worth of material for one fee.
  //
  // Develop completed the same migration on 2026-08-01 (#313, #314); the sequence and
  // the populate/verify script are in docs/runbooks/secrets-bundle-migration.md.
  //
  // HOW THIS WAS VERIFIED WITHOUT A RUNNING TASK. Production was idle when the bundle
  // was cut over (min_count = 0 on both services, RDS stopped, no cache node), so unlike
  // develop nothing booted to prove it. Two checks stood in for that, and both must be
  // repeated if this is ever redone:
  //   1. sha256 per key, bundle vs standalone — all 12 identical (bundle-secrets.sh
  //      --verify).
  //   2. every `<arn>:<key>::` reference in the api, worker AND migrator task
  //      definitions resolved against the bundle exactly as ECS does, confirming the key
  //      is present and non-empty.
  //
  // The migrator is the one to watch. It is NOT covered by a -target on module.api or
  // module.worker, and it was still pointing at the standalone secrets after those two
  // had been cut over — a step-4 destroy at that moment would have deleted secrets it
  // still referenced. Plan the WHOLE stack, not a subset, before dropping standalone.
  //
  // RECOVERABLE FOR 30 DAYS, unlike develop: recovery_window_days = 30 above, so the
  // destroyed containers are scheduled rather than gone. Restore with
  // `aws secretsmanager restore-secret --secret-id rally/production/<name>` inside that
  // window; after it, they must be recreated and re-pasted by hand.
  //
  // AT GO-LIVE, treat any boot failure mentioning secrets as this change first. Rollback
  // is `secrets_use_bundle = false`, `secrets_create_standalone = true`, apply, redeploy.
  secrets_bundle_name = "app"
  secrets_use_bundle  = true

  // ── Ingress via Cloudflare Tunnel, not the shared ALB ───────────────────────
  // cloudflared runs as a sidecar in the api task and dials OUT to Cloudflare, so
  // production needs no ALB listener rule, no target group and no public IPv4. Every
  // request already arrived through Cloudflare — the SPA proxies /v1/* to API_ORIGIN
  // and the ALB security group admitted only Cloudflare edge ranges — so the load
  // balancer was a second TLS termination inside an already-proxied path.
  //
  // Setting this also sets `attach_alb = false`: a tunnel-served task must not
  // simultaneously be an ALB target.
  //
  // MONITORING MOVED, it did not disappear. `monitor_target_health` cannot exist
  // without a target group, so the Route 53 health check created by this module
  // (aws_route53_health_check.api_ingress) is what catches an outage producing no
  // load. It probes rally-api.qnsc.vn/v1/healthz from outside AWS, so it exercises the
  // whole user path rather than any one component's opinion of itself.
  //
  // THAT CHECK IS ON as of go-live — see `monitor_ingress` below. It was off while
  // production served nothing, which was correct then and wrong the moment it served
  // anything.
  //
  // ROLLBACK is not instant: set tunnel_enabled = false, apply, redeploy. That
  // recreates the ALB attachment, but the runtime layer's ALB must exist first
  // (enable_alb there) and it comes back with a NEW DNS name.
  tunnel_enabled = true

  // ROUTING UNDER TERRAFORM, production only (2026-08-18).
  //
  // This is the gap the first production deploy found. The tunnel, its token and the DNS
  // record were all created by Terraform, and the connector came up healthy — but nothing
  // had ever written an INGRESS RULE, so `cloudflared` logged
  //   No ingress rules were defined in provided config (if any) nor from the cli
  // and answered 503 to every request, including the post-deploy readiness check that
  // failed the deploy. Develop only works because its rule was added by hand on
  // 2026-08-02; that is a step someone has to remember, and remembering is not a control.
  //
  // Safe to switch on HERE and not on develop because the configuration API is a
  // whole-document PUT: production's live configuration holds nothing but the catch-all
  // 503 this replaces, while develop's rule set has never been compared rule-by-rule.
  // Nothing about the tunnel itself is rewritten — `config_src` is left unset by the
  // stack module precisely because writing it would force a replacement, and the
  // connector already reads its routing from Cloudflare. The DNS record is untouched too:
  // it already exists and points at this tunnel, which is why the DASHBOARD cannot create
  // this rule (its route form insists on creating its own record and refuses with "A DNS
  // record with this name already exists").
  //
  // The rule the module writes is `api_domain` → `http://localhost:${app_port}`, plus the
  // catch-all `http_status:404` Cloudflare requires last. Both sides come from variables
  // this file already sets, so the route cannot drift from the port the task listens on.
  tunnel_routing_managed = true

  // OFF, including in production. Audited every consumer: all 7 alarms and all 6
  // dashboard widgets read AWS/ECS, AWS/ApplicationELB and AWS/RDS — native namespaces
  // that are free and published whether Container Insights is on or off. Nothing reads
  // the ECS/ContainerInsights namespace at all, so "enabled" was billing custom metrics
  // no alarm, no autoscaling target and no dashboard panel queries. Application metrics
  // go to the OTLP backend, not CloudWatch, so they are unaffected too.
  //
  // Turn it to "enhanced" temporarily when you need per-task or per-container drilldown
  // during an incident, then turn it back. For right-sizing, AWS/ECS CPUUtilization as a
  // percentage of a known task size is the same arithmetic.
  // ── Graviton ─────────────────────────────────────────────────────────────────
  // ARM64 Fargate bills ~20% less per vCPU-hour and GB-hour at identical sizing — same
  // platform, same networking, same limits. On the sizes below that is $2.68/mo: the api
  // goes $13.26 -> $10.61 and the worker $3.48 -> $2.78.
  //
  // PROVEN IN DEVELOP FIRST (#447), which is the only reason this is safe to set before
  // production has ever run. An x86 image on an ARM64 task does not fail the apply — it
  // fails at TASK START with "image Manifest does not contain descriptor matching
  // platform", after a deploy that reports a rollout.
  //
  // SET BEFORE LAUNCH, NOT AFTER, and that timing is the point. Production has never
  // served a request, so it starts on ARM instead of being migrated to it later — no
  // cutover, no mixed-architecture window, no rollback plan needed for a live service.
  // This is the last moment that is true.
  //
  // The build side already moved with #447: .github/workflows/backend-deploy.yml sets
  // `build_runner: ubuntu-24.04-arm` and `image_platforms: linux/arm64` for BOTH
  // environments, so the release image production pins is already arm64.
  cpu_architecture = "ARM64"

  container_insights = "disabled"

  // Kept here and dropped in develop. This is the one someone opens during an
  // incident, and it is inside the 3-per-account free tier.
  create_dashboard = true

  // STAYS OFF, and this is not the pre-launch idle setting left behind — it is the only
  // correct value while `tunnel_enabled = true`. This alarm watches a target group's
  // UnHealthyHostCount, and a tunnelled task has no target group: the stack module passes
  // `target_group_arns = {}` when the tunnel is on, so setting this true creates no alarm
  // at all. It would be a flag that reads as coverage and produces none.
  //
  // What replaces it is `monitor_ingress` below. The two are not a pair to flip together
  // — they are alternatives selected by `tunnel_enabled`, and earlier revisions of this
  // file said otherwise. If the tunnel is ever rolled back to the ALB, this is the flag
  // that has to come on in the same change.
  monitor_target_health = false

  // ON at go-live. The Route 53 health check probes rally-api.qnsc.vn/v1/healthz from
  // outside AWS every 30s, so it exercises the whole path a user takes — Cloudflare edge,
  // tunnel, connector, app — rather than any single component's opinion of itself.
  //
  // It was off pre-launch for a reason worth keeping in view: production ran zero tasks,
  // so the check reported DOWN continuously from creation, $2.70/mo to be paged every
  // minute about the state the environment was deliberately in. That premise ends here —
  // the floors below are 1, so DOWN now means DOWN.
  //
  // This is production's ONLY ingress alarm while tunnelled. ECS reports a task RUNNING
  // whether or not cloudflared holds edge connections, and the sidecar's image is
  // distroless so no ECS healthCheck can probe it. Without this an ingress outage is
  // visible only when a user reports it.
  monitor_ingress = true

  // ON at go-live, with the service floors below, because the pairing is enforced.
  //
  // The `check` block in the stack module refuses a plan with running tasks and no cache:
  // a task that cannot reach its cache does not fail, it falls back to localhost and runs
  // with the token denylist and the rate limiter FAILED OPEN. So "cache" and "tasks" move
  // together in one change, and Terraform rejects any plan where they do not.
  //
  // Recreating the node takes ~10 minutes and issues a NEW endpoint. Harmless here — no
  // sessions exist to lose — but mind the id-namespace collision documented in CLAUDE.md
  // if this name is reused while an old node is still deleting.
  //
  // ~$10/mo for cache.t4g.micro, the single largest line in the go-live delta after the
  // Fargate floors. It is not optional at any price: it is what makes two security
  // controls fail CLOSED.
  cache = {
    enabled = true
  }

  // NO `idle_schedule`, deliberately, and its absence is the go-live change.
  //
  // It stopped RDS and scaled both services to zero nightly at 01:00 — correct for an
  // environment with no users, an outage for one with them. A schedule that stops
  // production every night is precisely the leftover that becomes an incident nobody can
  // explain, so it is removed rather than commented out.
  //
  // The 7-day force-start it existed to bound is now irrelevant: the instance runs
  // continuously. Nothing else depended on the schedule — qnsc-ci's `ensure_rds` starts a
  // stopped instance before every deploy either way, so it stays a no-op on a running
  // database.

  // Both halves of rally/production/r2-public-* are populated, so the public-bucket
  // credential can be injected. Same fix as develop: `rally-production-r2-app` is scoped
  // to `rally-prod-attachments` alone, so public-asset writes had no grant. Production
  // has had no users, so nothing has hit it yet — this lands before it can.
  storage_public_credentials = true

  // Step 2 of docs/runbooks/db-role-least-privilege.md, same as develop and equally
  // inert: the migrator can read the role passwords so the one-off cutover task can
  // set them.
  db_role_passwords_set = true

  // Step 3, the last one: api and worker stop connecting as the RDS master.
  //
  // Until this, every production connection was `app_admin`, which OWNS every table —
  // so an ordinary HTTP request carried the right to DROP the schema it was reading.
  //
  // The develop-first rule this file used to cite has been satisfied, and it earned its
  // keep: enabling it in develop first is what exposed two `tenant_isolation` RLS
  // policies that denied every file write once the app stopped being the table owner.
  // Had both environments flipped together that would have been a production outage.
  // Migration 0070 dropped those policies, `test/e2e/file-storage-flow.e2e.spec.ts`
  // now fails if RLS ever returns, and this database reports zero RLS-enabled tables.
  //
  // The cutover task ran here on 2026-07-29 (task
  // 747f5e5183c046d6afb399b3810f007e on rally-prod-migrator:15, exit 0). Verified
  // independently afterwards against this database: rova_app and rova_worker both
  // have rolcanlogin=true with rolsuper/rolbypassrls/rolcreatedb/rolcreaterole all
  // false, and a real connection as rova_app succeeded.
  //
  // The MIGRATOR keeps the master credential — it needs DDL. Narrowing it means
  // transferring schema ownership, which is step 4 and deliberately separate.
  //
  // Rollback is this line and a rolling restart: the master credential is untouched
  // and the app holds no state tied to the role it connected as.
  db_least_privilege = true

  // SIZED FOR LAUNCH TRAFFIC, NOT FOR A CHECKLIST. This file's own rule for storage —
  // "raise on evidence, never speculatively" — is applied to the instance class and to
  // Enhanced Monitoring as well, so two items that earlier revisions listed as go-live
  // flips are deliberately NOT being flipped:
  //
  //   instance_class = "db.t4g.micro", not small.  $13.14/mo, and small is $26.28.
  //     1 GB of RAM against an application whose measured load to date is 4, 1, 0, 1
  //     requests a day. t4g is BURSTABLE, so the failure mode is not a wall: the
  //     instance earns 12 CPU credits/hour at a 10% baseline and spends them on spikes,
  //     and running out degrades gradually into throttling rather than falling over.
  //     RAISE IT ON THIS SIGNAL, and it is the first thing to raise: CPUCreditBalance
  //     trending to zero, or FreeableMemory under ~100 MB, in the AWS/RDS namespace on
  //     the dashboard. Both are on the free native metrics, so no extra spend is needed
  //     to watch for the moment this decision expires. The change is one line and a
  //     ~2-minute reboot — no snapshot, no endpoint change, reversible.
  //
  //   monitoring_interval = 0, not 60.  Enhanced Monitoring bills the OS-level metric
  //     stream to CloudWatch Logs; on a 1 GB instance the per-process and per-device
  //     detail it buys answers a question ("which process") that a single-application
  //     database rarely raises. Performance Insights' free 7-day tier and the native
  //     CPU/memory/IOPS metrics cover the questions that actually get asked. Turn it on
  //     WHEN INVESTIGATING a specific incident, then turn it back off — it takes effect
  //     without a reboot, so it is a debugging tool rather than a posture.
  //
  // Both are cost decisions taken with the size of this workload in evidence, not
  // deferred maintenance. Neither is one-way.
  //
  // Still SINGLE-AZ, and that is the separate, larger decision below.
  //
  //     allocated_storage_gb: raise on evidence, never speculatively (see below)
  //
  // MULTI-AZ IS DELIBERATELY NOT ON THAT LIST — decided 2026-08-02, and it is the one
  // item here that trades availability for cost rather than deferring spend.
  //
  // What it costs: $52.32/mo ($48.18 doubled instance rate + $4.14 mirrored volume at
  // 30 GB), a third of the entire go-live delta and more than every other candidate
  // combined. See docs/go-live-cost-delta.md.
  //
  // What single-AZ means when an AZ fails, stated plainly so nobody rediscovers it
  // during an incident:
  //   - Multi-AZ: AWS fails over to the standby, typically 60-120s, no data loss.
  //   - Single-AZ: the database is DOWN until AWS restores the AZ, or until someone
  //     restores from a snapshot into another AZ. Restore is a manual, multi-hour
  //     operation, and it loses everything written since the last backup — up to 24h
  //     with the current daily automated snapshot, though PITR narrows that to ~5min
  //     within the 30-day backup_retention_days window below.
  //
  // So the exposure is an outage of hours, not a permanent data loss, provided the
  // 30-day retention stays. Do not lower backup_retention_days while single-AZ: PITR is
  // what keeps this a recoverable outage rather than a real loss event.
  //
  // REVISIT WHEN: the product carries paying users, an availability commitment (SLA,
  // contract, SOC 2 CC7.x continuity), or a workload where hours of downtime costs more
  // than $52/mo. Turning it on later is a single flag plus an apply — RDS converts a
  // single-AZ instance to Multi-AZ in place, with a brief failover, no data migration
  // and no endpoint change. Nothing about this decision is one-way.
  //
  // Multi-AZ does NOT affect the deploy pipeline either way: the `ensure_rds` step in
  // qnsc-ci's backend-deploy reusable checks status and starts a stopped instance
  // regardless of AZ topology, so it is a no-op on an always-available database.
  //
  // 30 GB, not 100: `max_allocated_storage_gb` below already autoscales, and RDS gp3
  // gives the same 3,000 baseline IOPS and 125 MiB/s at every size under 400 GB, so
  // over-allocating buys nothing. Treat any increase as PERMANENT — RDS refuses to
  // shrink a volume and a snapshot restore cannot land smaller, so coming back down
  // needs the instance replaced (docs/runbooks/rds-storage-shrink.md).
  rds = {
    instance_class           = "db.t4g.micro"
    allocated_storage_gb     = 30
    max_allocated_storage_gb = 500
    multi_az                 = false
    deletion_protection      = true
    backup_retention_days    = 30
    monitoring_interval      = 0
  }

  // On-demand, not Spot: an interruption here is user-visible. Tighter autoscale
  // targets and more headroom than develop.
  // ── LIVE ────────────────────────────────────────────────────────────────────
  // `min_count = 1` on both services, ending the pre-launch idle. Production ran zero
  // tasks from 2026-08-02 to go-live because it had never served a user — the ALB logged
  // 4, 1, 0, 1 requests on four consecutive days — while costing ~$52/mo in on-demand
  // Fargate, a third of the account.
  //
  // A FLOOR OF 1 IS NOT A HIGH-AVAILABILITY POSTURE, and nothing here claims it is. One
  // api task means an AZ event or a task replacement is a brief outage; autoscaling adds
  // the second task under load, not for redundancy. Raising the floor to 2 is $22.46/mo
  // for the api and the right change once there are users who notice a 30-second gap —
  // which is a traffic decision, not a launch-day one.
  //
  // AUTOSCALING IS ON, and it only works because of the floor. With a floor of 0 the
  // scalable target could do nothing: target tracking scales proportionally so it never
  // computes zero from a running task, and a service at zero tasks publishes no CPU or
  // memory metric to scale out from. Measured on this account during the idle: production
  // sat at 0/0 tasks for days with a registered target, and Application Auto Scaling
  // logged ZERO scaling activities across its full six-week retention. A `validation`
  // block on the stack module's `api` and `worker` variables enforces the pairing, so
  // this combination cannot drift apart in one direction without the plan failing.
  //
  // `desired_count` is under `ignore_changes`, so the deploy pipeline setting it is
  // expected and non-drifting. Note the consequence now that the floor is 1: scaling a
  // service to zero by hand no longer sticks — Application Auto Scaling restores it
  // within minutes. Stopping production means changing this file.
  //
  // RDS runs continuously too. Run-state is not a Terraform concept, so the instance was
  // stopped out of band during the idle and `idle_schedule` re-stopped it against the
  // 7-day force-start; that schedule is now removed above.
  //
  // SIZED FROM MEASUREMENT. 1024/2048 originally, then 512/1024, now 256/1024 — and
  // this last step is the only one of the three taken with data rather than judgement.
  //
  // THE DATA, AWS/ECS on rally-develop, 14 days to 2026-08-17, same image and same
  // workload as production will run:
  //
  //     api  512/1024   CPU avg 0.8%, peak 100%   Memory avg 14.2%, PEAK 25.9%
  //
  // Peak memory of 25.9% on a 1024 MB task is 265 MB. The CPU peaks are real but they
  // are BOOT AND MIGRATION bursts a minute long against a 0.8% average — not load.
  // Provisioning 0.5 vCPU to make those bursts finish faster is paying $9.23/mo for a
  // shorter cold start.
  //
  // MEMORY DELIBERATELY NOT HALVED. 256/512 is available and $2.02/mo cheaper, and it is
  // declined: 265 MB against 512 MB is 52% before production adds anything develop does
  // not have — real sessions, held-open SSE streams, a warmer connection pool. Two
  // dollars is not the right price for that margin. CPU is where the waste was.
  //
  // WHAT THIS COSTS: a slower cold start. That is a DEPLOY-duration cost, not an
  // availability one — the rolling deployment starts the replacement before draining the
  // old task — but it also lengthens the gap when a single task is replaced unexpectedly.
  // Watch it after go-live.
  //
  // HEADROOM IS max_count = 10, not task size. Production absorbs a spike by ADDING
  // tasks at a 60% CPU target, and it now adds them from a unit costing $13.26/mo. Four
  // 256-CPU tasks cost less than one 1024 and survive an AZ event.
  //
  // RAISE IT ON THIS SIGNAL: CPUUtilization sustained above 60% or MemoryUtilization
  // above 70% with a single task, over hours rather than minutes. Both are free native
  // metrics on the dashboard.
  //
  // Still ON-DEMAND. Spot would be $4.15 and is the wrong trade for the API: the note
  // below explains why the worker can take an interruption and this cannot.
  api = {
    cpu                = 256
    memory             = 1024
    max_count          = 10
    min_count          = 1
    enable_autoscaling = true
    use_spot           = false
    // Tighter than the module defaults (65/75) and tighter than develop: production
    // absorbs a spike by adding tasks earlier, because a spare task now costs $13.26/mo
    // and the cost of being late is a queue. Cheaper tasks are what make an early
    // scale-out affordable — the two settings are one decision.
    cpu_target_pct    = 60
    memory_target_pct = 70
  }

  // Floored and autoscaled with the api — see the note above.
  //
  // SPOT, unlike the api. The worker is a relay: AbstractOutboxRelay claims rows with
  // FOR UPDATE SKIP LOCKED, retries with exponential backoff, and every write is an
  // idempotent upsert — so a task disappearing mid-batch loses no work, it just leaves
  // the rows claimed-then-released for the next tick. Spot's two-minute interruption
  // notice is longer than a 5-second relay cycle needs.
  //
  // That is not true of the api, which is why it stays on-demand: an interruption there
  // is a request nobody retries and an SSE stream that drops. Interruptions are real, not
  // hypothetical — `SpotInterruption` already appears in develop's stopped-task reasons.
  //
  // SIZED FROM MEASUREMENT, at 256/512 — the size develop has run all along, so this is
  // production adopting a proven number rather than guessing a smaller one.
  //
  //     worker  256/512   CPU avg 1.5%, peak 100%   Memory avg 20.7%, PEAK 35.8%
  //
  // AWS/ECS on rally-develop, 14 days to 2026-08-17. Peak memory of 35.8% on 512 MB is
  // 183 MB. As with the api, the CPU peaks are relay-tick and boot bursts against a 1.5%
  // average, not sustained load.
  //
  // Production's outbox carries the SAME work develop's does per unit of traffic, and
  // production currently has less of it. `max_count = 6` is the headroom, and the relay
  // is horizontally scalable by construction — FOR UPDATE SKIP LOCKED means a second
  // task claims different rows rather than contending for the same ones.
  //
  // Saves $3.48/mo against 512/1024, on top of Spot below.
  //
  // SPOT saves a further $7.77/mo at this size ($11.25 on-demand versus $3.48 on Spot).
  worker = {
    cpu                = 256
    memory             = 512
    max_count          = 6
    min_count          = 1
    enable_autoscaling = true
    use_spot           = true
  }

  // Telemetry stays DORMANT until otlp_endpoint is set: no sidecar, OTEL_ENABLED
  // false. Set the `observability-token` secret FIRST, then this.
  observability = {
    otlp_endpoint = var.otlp_endpoint
    // Cost control. Note this drops most ERROR traces too — keeping every
    // error needs tail sampling, which needs a gateway, not a sidecar.
    sampling_probability = 0.1
  }

  grafana_alerting_auth = var.grafana_alerting_auth
  grafana_alerting = {
    url                           = var.grafana_alerting_url
    prometheus_datasource_name    = var.grafana_alerting_prometheus_datasource_name
    logs_datasource_name          = var.grafana_logs_datasource_name
    alerts_folder_uid             = var.grafana_alerting_folder_uid
    dashboards_folder_uid         = var.grafana_dashboards_folder_uid
    product_dashboards_folder_uid = var.grafana_rally_dashboards_folder_uid
    slos_folder_uid               = var.grafana_slos_folder_uid
  }

  alarm_emails          = var.alarm_emails
  cloudflare_account_id = var.cloudflare_account_id
}
