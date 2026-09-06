// rally · develop
//
// This file is deliberately thin. The entire stack lives in ../../modules/stack, so
// develop and production cannot drift structurally — only the values below differ.
// Develop leans on SHARED, cheap infrastructure (Fargate Spot, small RDS, short
// retention); production takes the dedicated, durable settings. Adding a resource
// means editing the module once, not both environments.
terraform {
  required_version = ">= 1.9"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.0" }
    grafana    = { source = "grafana/grafana", version = "~> 3.0" }
  }

  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "rally/develop/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "qnsc-tofu-locks"
  }
}

provider "aws" {
  region = "ap-southeast-1"
  default_tags {
    tags = {
      Project     = "rova"
      Environment = "develop"
      ManagedBy   = "opentofu"
    }
  }
}

// Reads CLOUDFLARE_API_TOKEN (or TF_VAR_cloudflare_api_token). DNS/Pages resources
// are skipped when the zone is unset, so the stack applies before Cloudflare exists.
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
      Project     = "rova"
      Environment = "develop"
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

  product  = "rova"
  env      = "develop"
  env_slug = "develop"
  region   = local.region

  app_domain = "rova-dev.qnsc.vn"
  api_domain = "rova-api-dev.qnsc.vn"
  web_record = "rova-dev"
  api_record = "rova-api-dev"

  shared_state_key  = "rally/shared/terraform.tfstate"
  runtime_state_key = "platform/runtime-dev/terraform.tfstate"
  storage_state_key = "platform/storage-dev/terraform.tfstate"

  // Develop tracks the newest image; production pins a release tag.
  image_tag = "latest"

  // NO demo data in ANY deployed environment — develop mirrors production.
  //
  // Develop used to seed the demo fixture on every deploy, which put a second project, a capacity plan
  // and a frozen report history into a database people were reading as real. A shared environment whose
  // contents nobody can vouch for is worse than an empty one: every bug report has to start by asking
  // which rows were fixtures. Fixtures now exist only where they can be trusted — a developer's own
  // database (`pnpm db:seed:test`) and CI's ephemeral Postgres.
  //
  // The module default is already `false`; this stays written out so the intent is visible in the env
  // that used to differ. `db/migrate.ts` also refuses the demo seed outright under NODE_ENV=production,
  // so flipping this back would not be enough to reach a deployed database.
  seed_on_deploy = false

  # Entra B2B guest provisioning, ON for develop only.
  #
  # Requires the `User.Invite.All` APPLICATION permission with admin consent on the app registration
  # in `entra_client_id` — granted 2026-08-16. Without it every queued row dead-letters with a 403
  # AND the invitee hears nothing, because once this is on the guest-invite relay owns the invitation
  # email. Prod stays at the variable's `false` default until this has been exercised here.
  entra_guest_invite_enabled = true

  # qnsc.vn is the company tenant: those users are directory members on SSO, not B2B
  # guests — see the variable's own description for what this skips and unlocks.
  internal_email_domains = "qnsc.vn"
  platform_admin_emails  = var.platform_admin_emails

  entra_tenant_id = var.entra_tenant_id
  entra_client_id = var.entra_client_id
  github_app_id   = var.github_app_id

  // Cost-leaning: short retention, immediate secret deletion so a
  // destroy+redeploy cycle does not trip "secret scheduled for deletion".
  log_retention_days           = 7
  secrets_recovery_window_days = 0

  // ── Secret bundling · COMPLETE ──────────────────────────────────────────────
  // Every app secret lives in ONE container, rally/develop/app, read per key by ECS via
  // the `<arn>:<key>::` form of valueFrom. Secrets Manager bills per SECRET regardless of
  // size, so this is 12 containers' worth of material for one container's fee.
  //
  // `secrets_create_standalone` is now unset (defaults to !use_bundle = false), which
  // DESTROYS the 12 standalone secrets and is what realises the saving. Safe to do here
  // only because all three consumers were proven against the bundle first — api, worker
  // and migrator each rolled onto it via the normal deploy pipeline (#313) and reached
  // steady state, with /v1/readyz reporting postgres and valkey up.
  //
  // NO LONGER A ONE-LINE ROLLBACK. recovery_window_days = 0 in this environment, so the
  // standalone secrets are gone for good once this applies. Reverting means recreating
  // them AND re-pasting all 12 values by hand. The bundle itself is the backup — do not
  // delete it casually.
  //
  // Repeating this in production: populate and verify the bundle key-by-key BEFORE
  // setting use_bundle. The qnsc-ci deploy preflight proves the container is non-empty,
  // not that every key is present, so a bundle missing one key passes CI and fails at
  // task boot. Full sequence and the verify script:
  // docs/runbooks/secrets-bundle-migration.md.
  secrets_bundle_name = "app"
  secrets_use_bundle  = true

  // ── Ingress via Cloudflare Tunnel, not the shared ALB ───────────────────────
  // cloudflared runs as a sidecar in the api task and dials OUT to Cloudflare, so
  // this environment needs no ALB listener rule, no target group and no public IPv4.
  // Setting this also sets `attach_alb = false` on the api service — a tunnel-served
  // task must not simultaneously be an ALB target.
  //
  // Requires `tunnel-token` in rally/develop/app, which holds the connector token for
  // the `rally-develop` tunnel (created out of band 2026-08-02; a tunnel and its token
  // are one Cloudflare object, so Terraform does not mint it).
  //
  // DEVELOP FIRST, deliberately: this is the environment where the tunnel path gets
  // proven — SSE held open past the heartbeat interval, Entra SSO end to end, and an
  // R2 upload — before production's hostname is cut over.
  tunnel_enabled = true

  // OFF here and in production alike — see ../prod/main.tf for the audit. Per-task
  // metrics are billed as custom CloudWatch metrics at $0.07 each and no alarm,
  // dashboard or autoscaling target in this stack reads that namespace.
  // ── Graviton ─────────────────────────────────────────────────────────────────
  // ARM64 Fargate bills ~20% less per vCPU-hour and GB-hour at identical sizing. Nothing
  // is given up: same platform, same networking, same limits.
  //
  // DEVELOP FIRST, and that is the point of having it. An x86 image on an ARM64 task does
  // not fail the apply — it fails at TASK START with "image Manifest does not contain
  // descriptor matching platform", after a deploy that reports a rollout. Proving it here
  // costs a broken develop; discovering it in production costs an outage on launch day.
  //
  // MOVES WITH THE BUILD. `.github/workflows/backend-deploy.yml` sets
  // `build_runner: ubuntu-24.04-arm` and `image_platforms: linux/arm64` in the same
  // change. Native ARM runner, not QEMU — the qnsc-ci reusable notes that emulating an
  // arm64 pnpm + Nest compile on x86 costs more build minutes than the Fargate saving is
  // worth.
  //
  // rally qualifies on every image in the task: the app is node:alpine (multi-arch), and
  // both sidecars publish arm64 — cloudflare/cloudflared and amazon/aws-otel-collector,
  // checked 2026-08-17. qnsc-kb does not, and cannot follow: clamav/clamav is amd64-only
  // on every published tag.
  //
  // ROLLBACK is this line plus the two workflow inputs, reverted together and redeployed.
  cpu_architecture = "ARM64"

  container_insights = "disabled"

  // ── Shared develop cache ─────────────────────────────────────────────────────
  // Uses the ONE Valkey node in the runtime layer rather than a node of rally's own.
  //
  // ElastiCache cannot be stopped, only deleted, so a per-product dev cache billed all
  // 730 hours of the month regardless of the idle schedule above — which now runs this
  // environment only 55 hours a week. rally and qnsc-kb were paying $15.45 each for two
  // nodes holding a few thousand keys between them. The runtime layer already owned the
  // security group and the data subnets; only the node was duplicated.
  //
  // Saves $15.45/mo across the account. Created in quynhonsemiconductor/infra#69.
  //
  // DATABASE 0. qnsc-kb takes database 1. The index is enforced by the server rather than
  // by a key-prefix convention every library has to honour — cluster mode is disabled on
  // the shared node, so all 16 databases exist and SELECT works. Indexes are allocated in
  // the `db_index` note in ../../modules/stack/variables.tf; a second product silently
  // reusing 0 is the collision that note exists to prevent, and nothing catches it at
  // plan time.
  //
  // MIND THE EVICTION POLICY IF YOU EVER TUNE IT. qnsc-kb runs Celery on this node, and
  // its broker keys carry no TTL. The default parameter group is `volatile-lru`, which
  // evicts only keys that HAVE a TTL — rally's rate-limit counters and denylist entries
  // go first, Celery's queue is never a candidate. Setting `allkeys-lru` to make rally's
  // cache behave better under pressure would silently start dropping qnsc-kb's tasks.
  //
  // APPLIED 2026-08-17. rally-develop-cache was destroyed and the endpoint changed, so the
  // cutover was a task-definition revision plus a rolling deploy. Verified afterwards:
  // /v1/readyz reported postgres up AND valkey up, and the worker's NotificationPubSub
  // logged no lookup failures on the new revision. The old revision briefly did — it still
  // named the deleted node — which is worth knowing for any future endpoint change: the
  // apply registers a task definition, the DEPLOY is what puts it in service.
  //
  // PRODUCTION KEEPS ITS OWN NODE and was untouched by this.
  cache = {
    shared   = true
    db_index = 0
  }

  // Three dashboards are free per ACCOUNT; four environments across two products
  // means one is billable. Develop is the one to drop — its alarms still fire.
  create_dashboard = false

  // The unhealthy-target alarm treats "no registered targets" as breaching, which is
  // right for an always-on environment and wrong here: these services run on Fargate
  // SPOT, and a Spot interruption leaves zero registered targets until a replacement
  // task passes its health check. Past the 3x60s evaluation window that fires the alarm
  // — in an environment nobody is paged for. Interruptions are not hypothetical here;
  // `SpotInterruption` shows up in this service's stopped-task reasons.
  //
  // ALSO justified by the idle schedule now, which is a REVERSAL of what this comment
  // used to say. It claimed no off-hours scheduler existed. One does: `idle_schedule`
  // below creates three EventBridge schedules (rds-stop, api-scale-down,
  // worker-scale-down) that take this environment to zero tasks nightly, verified
  // firing in CloudTrail. Zero tasks means zero registered targets, which this alarm
  // treats as breaching — so leaving it on would page nobody-in-particular every night
  // by design.
  //
  // The Spot reason above still stands independently, and is the reason this was
  // originally false.
  monitor_target_health = false

  // Nightly, not weekly like production. Develop wakes on every merge to main, so a
  // weekly stop would leave it running most of the week; midnight local puts it down
  // after the working day and the next deploy brings it back.
  //
  // THERE IS NOW A MATCHING START SCHEDULE — see `wake_schedule` below. This comment
  // used to say there was none "on purpose", on the grounds that the deploy pipeline is
  // the wake signal and a morning start would pay for the days nobody touches develop.
  // The first half is still true and is why the wake is WEEKDAYS ONLY. The second half
  // was wrong about which days matter: it counted the days develop is CHANGED and
  // ignored the days it is USED. A QA session on a morning nobody merged found the
  // environment stopped, which reads as an outage, and RDS takes ~4-5 minutes to start,
  // so it cannot be waited out.
  //
  // TWO PASSES, 00:00 AND 03:00 — because ONE was not holding. Measured 2026-08-02:
  // develop's RDS published CPU datapoints for every hour of every night across seven
  // days, i.e. it was never actually down. CloudTrail shows why:
  //
  //   21:00:36  StopDBInstance   (this schedule — fires correctly, every night)
  //   21:33:07  StartDBInstance  (GitHubActions — `ensure_rds` in the deploy reusable)
  //
  // A deploy landing after the stop wakes RDS and scales the services back up, and
  // nothing stopped them again until the FOLLOWING night. 6 of 40 sampled deploys ran at
  // 21:00-02:00 local, so develop was billing ~24h/day for maybe 10h of use. This is a
  // control-loop problem, not a sizing one: a once-daily stop cannot hold against a wake
  // signal that fires at any hour.
  //
  // FIRST PASS MOVED 21:00 -> 00:00 (2026-08-06), because 21:00 was cutting into use.
  // The 03:00 backstop is what makes this affordable: the measurement above shows the
  // damage comes from a deploy landing AFTER the stop and leaving the environment up all
  // night, not from the hour of the stop itself — and 03:00 still catches that. The cost
  // of the move is bounded at 3 extra hours on nights nobody deploys late, ~$0.15/night.
  //
  // Note this narrows the late-evening deploy window from 6h to 3h: a deploy at 01:00
  // now leaves develop up for only two hours instead of five. That is a saving, not a
  // problem, but it means the two passes are closer together than they look — if a third
  // pass is ever wanted it belongs BEFORE 00:00 (e.g. a 20:00 pass for a team that stops
  // earlier), not between these two.
  //
  // 03:00 is chosen to sit after the late-evening deploy window and before the working
  // day. A deploy at 02:00 still gets its environment; one at 01:00 no longer leaves it
  // running all night. If deploys routinely land between 03:00 and 08:00, add a pass
  // rather than moving this one — 08:00 is now the wake, so a stop after it would fight
  // `wake_schedule` below.
  // THREE passes now, and the first one is the change: 19:00 ends the working day,
  // 22:00 catches an evening deploy, 02:00 catches a late one. Was `0,3`.
  //
  // 19:00 is what moves the money. Develop was up 08:00-00:00, so five of those sixteen
  // hours were after everyone had stopped. Measured across both develop environments
  // (rally and qnsc-kb), the 19:00-00:00 tail is ~$8.13/mo of RDS and Fargate.
  //
  // THE LATE PASSES ARE NOT OPTIONAL, and dropping to a single 19:00 stop is the obvious
  // "simplification" that breaks this. A deploy at 20:00 wakes develop; with nothing after
  // 19:00 it would then stay up until the NEXT working day's stop — 23 hours, which is
  // worse than the schedule this replaces. Each pass is a no-op when develop is already
  // down (InvalidDBInstanceState, deliberately not retried).
  //
  // A pass between 02:00 and 08:00 would be pointless: nothing wakes develop in that
  // window except a deploy, and 02:00 already caught the previous evening's.
  # 00:00 and 03:00 Asia/Ho_Chi_Minh. Moved back from 19:00 on request 2026-08-19: a 19:00
  # stop cut the evening short, and develop being down while somebody is still working costs
  # more in interruption than the hours save.
  #
  # WHAT IT COSTS: +$3.90/mo for this stack. 55h/week becomes 80h (16h x 5 days), so RDS
  # instance-hours and Fargate both rise ~45%. The weekday-only wake below is what keeps
  # this from being the old 112h/week schedule — weekends are still the larger saving and
  # they stay off.
  #
  # TWO PASSES, and the second is not optional. 00:00 ends the day; 03:00 catches a deploy
  # that landed late and woke the environment, because nothing else would put it back down
  # until the next working day. Each pass is a no-op when develop is already down
  # (InvalidDBInstanceState, deliberately not retried).
  idle_schedule = "cron(0 0,3 * * ? *)"

  // 08:00 local, EVERY DAY. This was MON-FRI first, on the argument that a 7-day wake
  // "would pay for two days a week nobody works". Two weekends in, that argument had
  // been falsified twice: somebody wanted develop on a Saturday both times, found it
  // stopped, and it had to be started by hand — which takes SEVEN MINUTES of waiting
  // (measured 2026-08-08, not the ~4-5 estimated here before), during which the person
  // cannot do the thing they sat down to do.
  //
  // The weekday restriction was optimising the wrong quantity. Two extra wake-days cost
  // about $2.50/mo against a ~$50/mo environment — 5% — to remove a recurring
  // interruption and the standing question "is develop up today?". The nightly stop is
  // where the real saving always was, and that is untouched.
  //
  // 08:00 rather than 09:00 because RDS takes ~7 minutes to reach `available` and the
  // API tasks then need to pass a readiness check, so the environment is serving by
  // roughly 08:10 — before the working day rather than during its first minutes.
  //
  // This does NOT conflict with the 03:00 stop above. 03:00 fires while develop is
  // already down (a no-op, InvalidDBInstanceState, deliberately not retried) and 08:00
  // brings it up five hours later. The 00:00 stop then ends the day. A deploy landing at
  // any hour still wakes it independently — that path is unchanged, and it is what makes
  // the weekday-only wake safe.
  //
  // WEEKENDS REMOVED AGAIN (was `* * ?`, daily). This reverses #408, and the reversal is
  // about arithmetic rather than a change of mind.
  //
  // #408 bought weekend availability for "about $2.50/mo". That number was too low: it
  // priced RDS alone, at a rate taken from memory, for one product. Measured from Cost
  // Explorer across BOTH develop environments — unblended cost divided by usage quantity,
  // 2026-08-01..16 — the weekend share of develop's RDS and Fargate is ~$10.42/mo. The
  // decision was sound at $2.50 and does not survive at four times that, against a target
  // of $100/mo for the whole account.
  //
  // What it costs: develop is DOWN on Saturday and Sunday unless someone deploys. That
  // path is unchanged and automatic — the `wake` job in qnsc-ci's backend-deploy reusable
  // starts RDS and both services before the deploy proceeds, so weekend work costs a wait
  // of a few minutes, not a manual step or a support request. It is the same mechanism
  // that already covers a 07:00 start on a weekday.
  //
  // Expected effect: develop is up 08:00-00:00 on weekdays, 80h/week rather than 112.
  //
  // VERIFIED FIRING, so a future failure is a regression and not "it never worked":
  // CloudTrail 2026-08-07 (the first weekday after it was created) shows all three
  // targets from the waker role, no errors —
  //   01:00:09Z  ecs:UpdateService  api    desiredCount=1
  //   01:00:29Z  rds:StartDBInstance
  //   01:00:47Z  ecs:UpdateService  worker desiredCount=1
  wake_schedule = "cron(0 8 ? * MON-FRI *)"

  // Both halves of rally/develop/r2-public-* are populated, so the public-bucket
  // credential can be injected. This is a FIX, not hardening: the primary token
  // (`rally-develop-r2-app`) is scoped to `rally-develop-attachments` alone, so while
  // this was false every avatar and workspace-logo write went to the public bucket
  // with a credential that has no grant on it.
  storage_public_credentials = true

  // Step 2 of docs/runbooks/db-role-least-privilege.md: rally/develop/db-*-password
  // are populated, so the migrator can read them and the one-off cutover task can
  // set them on the roles. Inert on its own — the normal migrate entrypoint ignores
  // these, and api/worker stay on the master credential until `db_least_privilege`
  // flips in a LATER apply, after the cutover task has actually run.
  db_role_passwords_set = true

  // Step 3, the last one: api and worker stop connecting as the RDS master.
  //
  // The cutover task ran here on 2026-07-29 (task
  // 17d5bd4504bd43959c7dc531cbd36c95, exit 0) and verified BOTH roles against this
  // database: LOGIN works, none of rolsuper/rolbypassrls/rolcreatedb/rolcreaterole/
  // rolreplication is set, and CREATE TABLE as the role is denied.
  //
  // Enabling this the first time (#246) broke every file write, and the fix is a
  // migration rather than this flag. Moving off master also moves the app off being
  // the table OWNER, and Postgres exempts only the owner from row-level security, so
  // two leftover `tenant_isolation` policies on storage.files and
  // work.work_item_attachments executed for the first time. They require
  // `app.workspace_id`, which nothing sets, so they denied every insert. Migration
  // 0070 drops them, completing the teardown migration 0025 began — Rally is
  // single-tenant and DB-level isolation is an explicit non-goal, so those two
  // policies (2 of 41 workspace-scoped tables) were never a boundary.
  //
  // The MIGRATOR keeps the master credential — it needs DDL. Narrowing it means
  // transferring schema ownership, which is step 4 and deliberately separate.
  //
  // Rollback is this line and a rolling restart: the master credential is untouched
  // and the app holds no state tied to the role it connected as.
  db_least_privilege = true

  rds = {
    instance_class           = "db.t4g.micro"
    allocated_storage_gb     = 20
    max_allocated_storage_gb = 100
    multi_az                 = false
    deletion_protection      = false # easy teardown in develop
    // ZERO, which DISABLES automated backups and PITR in this environment.
    //
    // Develop holds nothing worth recovering. It carries no demo fixtures (see
    // seed_on_deploy above) and no user data anyone is asked to trust — the migrator
    // rebuilds it from migrations plus the two prod-safe seeds on any deploy, which is
    // exactly how it was rebuilt from an empty database on 2026-08-04. A backup of a
    // database that is cheaper to recreate than to restore is storage nobody reads.
    //
    // Cost is small and honest rather than large: automated snapshots are free up to the
    // allocated 20 GB, so this mainly stops paying for the overflow and stops carrying
    // five 20 GB snapshots of a database that was deliberately wiped.
    //
    // APPLYING THIS DELETES EVERY EXISTING AUTOMATED SNAPSHOT for this instance, and it
    // is not reversible — retention 0 → 3 starts a fresh series, it does not restore the
    // old one. Take a manual snapshot first if develop ever holds something real.
    //
    // PRODUCTION IS UNAFFECTED and must stay at 30: it is single-AZ, so PITR is what
    // makes an AZ failure a recoverable outage rather than data loss. See ../prod.
    backup_retention_days = 0
    monitoring_interval   = 0 # Enhanced Monitoring off — saves CloudWatch cost
  }

  // Fargate Spot: ~70% cheaper, and an interruption in develop is harmless.
  // ── IDLE BY DEFAULT, WOKEN BY DEPLOYS ───────────────────────────────────────
  // `min_count = 0` on both services. Develop is exercised by CI deploys and the odd
  // manual check, not by users — its ALB sees a handful of requests a day — so paying
  // for two tasks around the clock buys nothing.
  //
  // Waking needs no new machinery and no schedule: qnsc-ci's deploy reusable already
  // restores services scaled to 0 and calls `ensure_rds` to start a stopped instance,
  // and `_shared` already grants the develop deploy role `rds:StartDBInstance`. Every
  // merge to main therefore brings develop up on its own. `idle_schedule` below
  // puts it back down nightly.
  //
  // AUTOSCALING IS OFF HERE, and that is the load-bearing part.
  //
  // Deploys and `idle_schedule` between them own the desired count, so the floor has to
  // be 0 — with a floor of 1 Application Auto Scaling restores the service within minutes
  // and the midnight scale-to-zero undoes itself.
  //
  // But a scalable target with a floor of 0 cannot act at all, in either direction. Target
  // tracking scales proportionally, so from one task at ~1% CPU it computes
  // ceil(1 x 1/65) = 1 and never reaches zero; and once the schedule has taken the service
  // to zero there is no CPU or memory metric left for it to scale out from. Measured here,
  // not assumed: develop ran for hours at 0.07-1.0% average CPU against a floor of 0, and
  // Application Auto Scaling logged ZERO scaling activities across its six-week retention.
  //
  // So autoscaling was never fighting the schedule — it was inert, while billing four
  // CloudWatch alarms per service. `enable_autoscaling = false` says that out loud and
  // leaves exactly one writer: `desired_count` is under `ignore_changes` in the
  // ecs-service module, the deploy sets it to 1, the nightly schedule sets it to 0.
  //
  // Losing it costs develop nothing regardless: no users to absorb a spike for, and
  // `max_count` was never approached. Production restores it at go-live along with a floor
  // of 1 — see ../prod/main.tf, and the validation that ties those two together.
  //
  // NOT done with scheduled autoscaling ACTIONS, which is the other obvious shape:
  // `aws_appautoscaling_target` has no `ignore_changes` on min/max, so a scheduled
  // action mutating them would drift, and any infra-apply running at night would
  // silently wake develop. Same silent-reset shape as the `task_definition` and
  // `desired_count` cases documented in CLAUDE.md.
  //
  // `min_count`/`max_count` stay set: they no longer drive scaling, but `max_count`
  // sizes the DB connection pool and `min_count = 0` on both services is what marks
  // this environment idle (suppressing the load alarms) and what the cacheless-tasks
  // check reads.
  api = {
    cpu                = 512
    memory             = 1024
    max_count          = 3
    min_count          = 0
    enable_autoscaling = false
    use_spot           = true
  }

  // Idled with the api — see the note above.
  worker = {
    cpu                = 256
    memory             = 512
    max_count          = 2
    min_count          = 0
    enable_autoscaling = false
    use_spot           = true
  }

  // Telemetry stays DORMANT until otlp_endpoint is set: no sidecar, OTEL_ENABLED
  // false. Set the `observability-token` secret FIRST, then this.
  observability = {
    otlp_endpoint = var.otlp_endpoint
    // Full fidelity: develop volume is trivial, and validating the
    // instrumentation is the reason to enable it here at all.
    sampling_probability = 1.0
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
