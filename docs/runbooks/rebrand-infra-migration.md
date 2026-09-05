# Rebrand infra migration runbook (rally → Rova)

Execute **develop end-to-end first, verify, then repeat for prod.** All infra
applies run through the **CI infra-apply pipeline** (it holds the AWS OIDC + Cloudflare
credentials; local applies cannot reach Cloudflare). The RDS identifier rename is
handled **in-place by Terraform** (no data loss, no manual state mv).

## Pre-req (DONE)
- [x] Code/UI/cookie/brand rebrand (branch `rebrand/rova`) — typechecks pass.
- [x] RDS safety snapshots: `rally-develop-pre-rebrand-*`, `rally-prod-pre-rebrand-*` (available).
- [x] Storage `rova_*` output aliases PR (quynhonsemiconductor/infra #112) — merge + CI apply first.

## Coupling facts (do NOT change blindly)
- **TF state S3 key** `rally/shared/terraform.tfstate` — KEEP AS-IS (storage key, not brand). Changing it orphans state.
- **OIDC trust subject** `repo:<org>/rally:...` in `_shared` — change to `rova` only AFTER the GitHub repo is renamed rally→rova, or CI OIDC breaks.
- **ECR repos** `rally-api|worker|migrator` — renaming recreates them; deploy repushes on next run.
- **DB roles** `rally_app`/`rally_worker` — runtime-coupled (migration 0068). Rename via a dedicated DB migration (create new roles, re-grant, update DATABASE_APP/WORKER_PASSWORD secrets), NOT in TF.

## Order of operations (develop)
1. Merge storage aliases (infra #112) -> CI applies -> `rova_*` outputs exist.
2. Rename GitHub repo rally -> rova (redirects preserve refs). Update local remote.
3. rally `_shared`: product="rova"; OIDC trust repo:<org>/rova; ecr_repository_pattern/repository_names -> rova-*; rally_develop_rds_arn db name -> rova-develop. KEEP state key = rally/shared. PR -> CI infra-apply (recreates IAM/OIDC under rova-*, re-establishes OIDC trust).
4. rally `develop`: product="rova"; domains rova-dev.qnsc.vn / rova-api-dev.qnsc.vn; records rova-dev/rova-api-dev. PR -> CI infra-apply.
   - RDS rally-develop -> rova-develop renames IN-PLACE (verified). Set apply_immediately=true for the window, or accept next-maintenance-window reboot.
   - Staged apply for count-dependent resources: first apply with -exclude=module.stack.module.api.data.aws_iam_policy_document.execution_secrets (+ worker/firelens equivalents), then converging apply.
   - Repopulate recreated secrets (rova-develop tunnel token is new/empty).
5. DNS cutover: rova-dev / rova-api-dev created by the develop apply. Retire old rally-dev records after verification.
6. Redeploy backend. Cookies renamed -> users re-auth.
7. Verify: curl https://rova-dev.qnsc.vn/v1/readyz -> 200 with postgres: up, valkey: up, and confirm DB data intact.

## Then prod (separate window, after develop verified)
- Same for `_shared` prod deploy role + `prod` stack + rova.qnsc.vn / rova-api.qnsc.vn.
- Prod RDS rally-prod -> rova-prod in-place. apply_immediately=false -> rename waits for maintenance window unless forced.
- Prod deploy tag-gated (v*.*.*) with production environment reviewer.

## Rollback
- RDS: restore from *-pre-rebrand-* snapshots.
- Infra: revert TF PRs, re-apply (recreates rally-* names).
- Cookies: reverting code restores rally_ cookie names.
