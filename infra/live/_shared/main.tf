terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }

  backend "s3" {
    bucket         = "qnsc-tofu-state"
    key            = "rally/shared/terraform.tfstate"
    region         = "ap-southeast-1"
    encrypt        = true
    dynamodb_table = "qnsc-tofu-locks"
  }
}

provider "aws" {
  region = "ap-southeast-1"
  default_tags {
    tags = {
      Project   = "rally"
      ManagedBy = "opentofu"
      Layer     = "shared"
    }
  }
}

locals {
  github_org = var.github_org
}

data "aws_caller_identity" "current" {}

# ── Read shared platform outputs from qnsc-infra bootstrap ───────────────────
# Gives us: kms_key_arn, artifacts_bucket_name, oidc_provider_arn
# Dependency: qnsc-infra/live/bootstrap must be applied before this stack.
data "terraform_remote_state" "platform" {
  backend = "s3"
  config = {
    bucket = "qnsc-tofu-state"
    key    = "platform/bootstrap/terraform.tfstate"
    region = "ap-southeast-1"
  }
}


# ── ECR Repositories ──────────────────────────────────────────────────────────
module "ecr" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/ecr?ref=ecr-v2.0.0"

  # ecr-v2.0.0 splits the keep-count lifecycle rule by tag prefix. The single rule it
  # replaces was provably dead: `tagPrefixList` is AND, not OR, so one rule listing
  # ["sha-", "v"] only ever selected images carrying BOTH prefixes — the handful of
  # promoted releases — and never fired. Verified live: 105 `sha-` images sat under a
  # policy claiming to keep 30, so tagged history grew without bound.
  #
  # Defaults are keep 30 releases (v*) and keep 20 builds (sha-*). Previewed against the
  # live repositories before bumping: 180/178/173 images expire, of which ~90 each are
  # untagged and already expirable under the old policy, and ZERO carry a release tag or
  # `latest`. Re-run `aws ecr start-lifecycle-policy-preview` before changing these
  # counts — it is a dry run and it is the only way to see what a policy will delete.
  repository_names     = ["rova-api", "rova-worker", "rova-migrator"]
  image_tag_mutability = "MUTABLE" # allows re-tagging :latest
  kms_key_arn          = data.terraform_remote_state.platform.outputs.kms_key_arn
  tags                 = { Layer = "shared" }
}

# ── GitHub OIDC ───────────────────────────────────────────────────────────────
# Owns ALL rally AWS deploy roles: API (per-env), ECR push, infra plan/apply.
# The web SPA deploys to Cloudflare Pages (see live/*/main.tf module "web"), so
# it needs no AWS deploy role here.
module "iam_oidc" {
  source = "git::https://github.com/quynhonsemiconductor/tf-modules.git//modules/iam-oidc?ref=iam-oidc-v3.0.1"

  product           = "rova"
  github_org        = local.github_org
  oidc_provider_arn = data.terraform_remote_state.platform.outputs.oidc_provider_arn

  environments = {
    develop = {
      allowed_subjects = [
        "repo:${local.github_org}/rova:ref:refs/heads/main",
        "repo:${local.github_org}/rova:environment:develop"
      ]
    }
    production = {
      allowed_subjects = [
        "repo:${local.github_org}/rova:ref:refs/heads/main",
        "repo:${local.github_org}/rova:ref:refs/tags/v*",
        "repo:${local.github_org}/rova:environment:production"
      ]
    }
  }

  app_repo_names         = ["rova"] # monorepo: was rally-api
  infra_repo_name        = "rova"   # monorepo: infra lives in rally/infra/
  ecr_repository_pattern = "rova-*"
  ecs_passrole_pattern   = "rova-*" # shared ecs-service names roles <cluster>-<service>-task
  tags                   = { Layer = "shared" }

  # infra_plan_subjects / infra_apply_subjects: rally's infra-apply jobs run in
  # the shared/develop/production GitHub Environments (see infra-apply.yml), which
  # exactly match the module defaults — so no override is needed.

  # Blast-radius guardrail: explicit-Deny on the rally infra-apply role so a buggy
  # rally apply cannot destroy the platform's own foundations (state bucket, lock
  # table, OIDC provider, CMK) or mint IAM users — all of which are owned by
  # qnsc-infra bootstrap, never by rally.
  infra_apply_guardrail = {
    state_bucket_arn     = "arn:aws:s3:::qnsc-tofu-state"
    lock_table_arn       = "arn:aws:dynamodb:ap-southeast-1:${data.aws_caller_identity.current.account_id}:table/qnsc-tofu-locks"
    oidc_provider_arn    = data.terraform_remote_state.platform.outputs.oidc_provider_arn
    kms_key_arn          = data.terraform_remote_state.platform.outputs.kms_key_arn
    artifacts_bucket_arn = data.terraform_remote_state.platform.outputs.artifacts_bucket_arn
  }
}

# ── RDS wake guard — develop deploy role only ────────────────────────────────
# Allows the CI deploy job to detect + start a stopped RDS instance before running
# migrations. Scoped to develop only, and deliberately absent from the production
# deploy role.
#
# The STOPPING half exists too, which this comment used to deny. `idle_schedule` in
# infra/live/develop/main.tf creates three EventBridge schedules — rds-stop,
# api-scale-down, worker-scale-down — and CloudTrail confirms them firing nightly.
#
# So the two halves are a LOOP, and this grant is what closes it: the schedule stops
# develop at 21:00 and 03:00, and the next deploy's `ensure_rds` starts it again. That
# pairing is the whole cost posture, not a safety net for manual teardown.
#
# It also has to be understood as a loop to be reasoned about. The schedule ran nightly
# for weeks while develop stayed up 24/7, because a single 21:00 stop could not hold
# against a wake signal that fires whenever a deploy lands — measured 2026-08-02, fixed
# by adding a second 03:00 pass. Removing this grant does not save money; it breaks
# waking and leaves deploys failing against a stopped database.
#
# The ARN is constructed directly (account_id + region + fixed identifier)
# instead of via a `data "aws_db_instance"` lookup. A data-source lookup
# fails hard whenever the instance doesn't exist yet or has been torn down
# (e.g. a fresh deploy, or a full teardown+redeploy cycle) — this stack
# would then be unable to apply/destroy independently of develop's RDS
# lifecycle. An ARN string doesn't require the resource to exist.
locals {
  rally_develop_rds_arn = "arn:aws:rds:ap-southeast-1:${data.aws_caller_identity.current.account_id}:db:rova-develop"
  rally_prod_rds_arn    = "arn:aws:rds:ap-southeast-1:${data.aws_caller_identity.current.account_id}:db:rally-prod"
}

resource "aws_iam_role_policy" "deploy_rds_dev_guard" {
  name = "rova-deploy-develop-rds-guard"
  role = split("/", module.iam_oidc.deploy_role_arns["develop"])[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RDSDevGuard"
        Effect = "Allow"
        Action = [
          "rds:DescribeDBInstances",
          "rds:StartDBInstance",
        ]
        Resource = local.rally_develop_rds_arn
      }
    ]
  })
}

# ── RDS wake guard — PRODUCTION deploy role ──────────────────────────────────
# This grant was deliberately ABSENT until production was idled, and the reason it is
# here now is a posture change rather than a loosening: production's instance is
# STOPPED on purpose until go-live (see `min_count = 0` and `idle_schedule` in
# ../prod/main.tf), so waking it is a normal step of deploying rather than an
# exception to be denied.
#
# Without it, idling production silently broke the release pipeline: the deploy would
# reach `Run database migrations` and fail against a stopped instance, with the cause
# two repos away from the symptom. Two releases were cut the same day the idle landed,
# so this is not hypothetical.
#
# Still Start and Describe only — never Stop. Stopping is the scheduler's job and it
# has its own narrowly-scoped role; a deploy role that can stop production is a
# deploy that can cause an outage.
#
# REMOVE AT GO-LIVE together with the idle settings. Once production is meant to be
# running continuously, a deploy role able to start a stopped database is again the
# exception it used to be, and its absence is what makes an accidental stop loud.
resource "aws_iam_role_policy" "deploy_rds_prod_guard" {
  name = "rova-deploy-prod-rds-guard"
  role = split("/", module.iam_oidc.deploy_role_arns["production"])[1]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RDSProdWakeWhileIdled"
        Effect = "Allow"
        Action = [
          "rds:DescribeDBInstances",
          "rds:StartDBInstance",
        ]
        Resource = local.rally_prod_rds_arn
      }
    ]
  })
}

# NOTE: the former inline patches `deploy_ecs_verify` (ecs:ListTasks) and
# `ecr_push_describe_images` (ecr:DescribeImages) were removed when this stack
# adopted iam-oidc-v2.0.1 — the module now grants both permissions on the deploy
# and ecr-push roles respectively, so the module is once again the single source
# of truth for these roles.


# ── Outbound email (SES) ──────────────────────────────────────────────────────
#
# The domain identity itself (aws_sesv2_email_identity + its DKIM/mail-from Cloudflare records) moved
# to qnsc-infra/live/edge (2026-08-31) — see that stack for why. This stack only owns the bounce/
# complaint feedback loop below, which IS product-scoped: each product tags its sends with its own
# configuration set and drains its own queue. `rally`'s IAM send grant (infra/modules/stack/main.tf)
# constructs the identity ARN directly (arn:aws:ses:<region>:<account>:identity/<domain>) rather than
# reading it from here, so this stack has no dependency on qnsc-infra/edge having applied first.

# ── SES asynchronous feedback: bounce and complaint events ──────────────────
#
# WHY THIS EXISTS. `EMAIL_PROVIDER=ses` answers 200 before the receiving mail server has said
# anything, so acceptance and delivery are different facts — and the app could only see the first.
# An invitation the inviter saw as "sent" could be hard-bounced or tenant-quarantined on the other
# end, with silence as the only symptom (that exact case cost a multi-day investigation: every local
# signal green, the invitee never saw mail). This loop makes the second fact visible: a
# configuration set tags every send, SES publishes BOUNCE/COMPLAIT events to SNS, SNS fans out to
# SQS, and the worker's BounceFeedbackService drains the queue onto the email_outbox row that sent.
#
# SNS IN THE MIDDLE IS NOT A CHOICE: SES event destinations speak SNS, Kinesis or EventBridge —
# never SQS directly. SQS at the end IS a choice: no public HTTPS endpoint to signature-check, no
# Cloudflare in the blast radius, and the consumer sits beside the relay that wrote the rows.
# Default (envelope) delivery, deliberately: the consumer parses SNS's `Message` field, which is
# the SES event JSON — raw_message_delivery would strip the envelope the code expects.
#
# Shared like the identity above: one configuration set per (account, region), both environments
# send through it, and each environment's worker drains from the one queue. A verdict's row is
# matched by SES message id, so cross-environment events cannot land on the wrong row even if both
# workers race — the guarded UPDATE answers whichever row owns that id.
# No `delivery_options`: the pinned AWS provider predates that argument on this
# resource, and Require is SES's own default for a domain-verified identity anyway.
resource "aws_sesv2_configuration_set" "email_feedback" {
  # `configuration_set_name`, not `name`: the pinned provider version predates the rename.
  configuration_set_name = "rova-email-feedback"
}

resource "aws_sns_topic" "ses_bounce_events" {
  name = "rova-ses-bounce-events"
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
  name = "rova-ses-bounce-feedback"
}

resource "aws_sns_topic_subscription" "ses_bounce_to_sqs" {
  topic_arn = aws_sns_topic.ses_bounce_events.arn
  protocol  = "sqs"
  endpoint  = aws_sqs_queue.ses_bounce_feedback.arn
}

# THE DELIVERY HALF of that subscription — without it the subscription shows Confirmed
# and every event still dies silently between the two services. SNS delivering to SQS is
# authorized by the QUEUE's policy, not by the subscription's existence: aws_sns_topic_subscription
# creates and confirms the subscription (same-account, owner credentials), but each published
# event is a separate cross-service call that SQS checks against this policy. Diagnosed live:
# SNS publish succeeded, NumberOfNotificationsFailed stayed zero, and the queue never received —
# a black hole with every green light on. Scoped to the one topic, so no other publisher can
# use this queue even if the subscription list grows.
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

output "ses_bounce_configset_name" {
  value       = aws_sesv2_configuration_set.email_feedback.configuration_set_name
  description = "Configuration set every SES send is tagged with, so bounce/complaint events reach the feedback queue."
}

output "ses_bounce_queue_url" {
  value       = aws_sqs_queue.ses_bounce_feedback.url
  description = "The SQS queue BounceFeedbackService drains for SES verdicts. Also the consumer's on/off switch."
}

output "ses_bounce_queue_arn" {
  value       = aws_sqs_queue.ses_bounce_feedback.arn
  description = "Same queue by ARN, for the worker task role's IAM resource scope."
}
