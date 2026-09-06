# Cutting the app over to least-privilege database roles

**Status:**

| | develop | production |
|---|---|---|
| roles exist (migration 0068) | yes | yes |
| 1. passwords in Secrets Manager | yes (2026-07-28) | yes (2026-07-28) |
| 2. `db_role_passwords_set` | yes | yes |
| 2. cutover task run | yes (2026-07-29) | **yes (2026-07-29)** |
| 3. `db_least_privilege` | yes | **being enabled** |
| 4. ownership transfer | no | no |

Develop's cutover task was `17d5bd4504bd43959c7dc531cbd36c95` on
`rally-develop-migrator:105`, exit 0, both roles verified.

### What step 3 exposed in develop, and what fixed it

Enabling it (#246) broke every file write. Moving off the master credential also
moves the app off being the table OWNER, and Postgres exempts only the owner from
row-level security — so two surviving `tenant_isolation` policies on `storage.files`
and `work.work_item_attachments` executed for the first time. They require
`app.workspace_id`, which no application code sets, so they denied every insert:

```
POST /v1/auth/me/avatar/presign  →  500
new row violates row-level security policy for table "files"
```

Those policies should not have existed. Rally is single-tenant, DB-level isolation
is an explicit non-goal of the drop-multi-tenant design, and migration 0025 tore the
apparatus down; 0053 re-added it to two tables believing it "mirrors the policy every
other workspace-scoped table carries", which was already untrue. Coverage was 2 of 41
workspace-scoped tables.

**Migration 0070 drops them** and completes 0025's teardown, so step 3 stands. Isolation
remains where it has always actually run — the repository layer, guarded by
`test/workspace-scope.ratchet.spec.ts`.

CI ran this whole suite as `rally_app` and stayed green throughout, because no e2e
spec touched a file or attachment. `test/e2e/file-storage-flow.e2e.spec.ts` closes
that gap and fails if RLS is ever re-enabled.

Production's cutover task was `747f5e5183c046d6afb399b3810f007e` on
`rally-prod-migrator:15`, exit 0. Verified independently afterwards against that
database: both roles report `rolcanlogin=true` with no privileged attributes, and a
real connection as `rally_app` succeeded. Production also reports zero RLS-enabled
tables, so the blocker above does not apply there.

**Owner:** whoever runs the next infra change.

## Why

`infra/modules/stack/main.tf` wires `DATABASE_USER` / `DATABASE_PASSWORD` from
`module.rds.master_secret_arn` for **all three** workloads — api (line ~239),
worker (~388) and migrator (~510). So every HTTP request runs as the RDS master
role, which owns every table in the database. Two consequences:

1. **Blast radius.** An injection or a bad migration path has `DROP TABLE`
   rights on production data during ordinary request handling.
2. **Any future RLS is inert.** Postgres exempts a table's owner from row-level
   security unless `FORCE ROW LEVEL SECURITY` is also set. This is not
   hypothetical here: it is precisely why the RLS layer added in migration
   `0005` never enforced anything, recorded as the audit's top finding in
   `docs/superpowers/specs/2026-07-09-drop-multi-tenant-merge-into-workspace-design.md`.

Migration `0068_app_role_least_privilege.sql` has already created the roles and
their grants. It created them **NOLOGIN**, so nothing uses them yet and applying
it changed no running behaviour. This runbook is the part that does.

| Role | Rights | Used by |
|---|---|---|
| `rally_app` | `SELECT, INSERT, UPDATE, DELETE` on the nine app schemas. No DDL, no ownership. | api |
| `rally_worker` | Same as `rally_app`. Separate identity so worker traffic is attributable and can diverge later. | worker |
| `rally_migrate` | `ALL` on the app schemas plus `drizzle`. Owns the schema after step 4. | migrator only |

The application code needs no change: `db/migrate.ts` already prefers
`DATABASE_MIGRATION_URL` over `DATABASE_URL` (`db/database-url.ts:84`), and
`.env.example` already names `rally_app` and `rally_migrate` for local dev. Only
the credentials handed to each task change.

## What already proves the grants are complete

`backend-ci.yml` runs `pnpm db:roles:enable` before the e2e job, then runs **the
entire e2e suite as `rally_app`** rather than as the superuser every other job
uses. So a schema, table or sequence that migration 0068 forgot to `GRANT` fails
CI — not the production cutover. The script also asserts the role *cannot* run
DDL, so widening the grants to ownership fails too.

That is the **same script** the cutover in step 2 below runs, so CI exercises the
production code path rather than a parallel implementation of it.

Verified locally at the time of writing: 865 unit tests and 133 e2e tests pass
with `DATABASE_URL` pointing at `rally_app`, with no `permission denied`. `pnpm
db:seed` also works as `rally_app`; `db/truncate-all.ts` deliberately uses
`resolveMigrationUrl()` because `TRUNCATE` is an owner right.

To run locally the way CI and post-cutover production do:

```sql
ALTER ROLE rally_app LOGIN PASSWORD 'rally_app';
```
```bash
# .env — app as the restricted role, migrations as the owner
DATABASE_URL=postgresql://rally_app:rally_app@localhost:5432/rova_dev?sslmode=disable
DATABASE_MIGRATION_URL=postgresql://postgres:postgres@localhost:5432/rova_dev?sslmode=disable
```

## Cutover

Do this in **develop first**, leave it a full deploy cycle, then prod.

### 0. What Terraform already contains

`infra/modules/stack` is already wired for this, switched off:

- `secret_names` gains `db-app-password` and `db-worker-password`. Following the
  existing convention in that map, Terraform creates them **empty** — the value
  never enters state.
- `var.db_least_privilege` (**default `false`**) selects, via
  `local.api_db_secrets` / `local.worker_db_secrets`, whether api and worker take
  their credentials from the RDS master secret or from the new ones.
- `var.db_role_passwords_set` (**default `false`**) injects the two passwords into
  the MIGRATOR, so the step-2 cutover task can read them.
- The migrator's own connection is untouched by either flag; it keeps the master
  credential because it needs DDL.

So applying the current code creates two empty secrets and changes no running
task. Everything below is the deliberate part.

### 1. Put a password in each secret

**Done for rally/develop and rally/production on 2026-07-28.** Kept here for new
environments.

Set a value on `<product>/<env>/db-app-password` and
`<product>/<env>/db-worker-password`. Plain string, not JSON — the module injects
the whole secret as `DATABASE_PASSWORD`, and `DATABASE_USER` travels as plain env
(`rally_app` is an identifier, not a credential).

Use `[A-Za-z0-9_-]` only. `db/database-url.ts` composes a DSN from the parts, and
avoiding `@ : / ?` sidesteps URL-encoding entirely. The cutover script rejects
anything outside that class rather than producing a DSN that silently misparses.

```bash
for role in app worker; do
  PW=$(LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 32)
  aws secretsmanager put-secret-value \
    --secret-id "<product>/<env>/db-$role-password" --secret-string "$PW" >/dev/null
  unset PW
done
```

Generated and piped straight in, so the value never reaches a terminal or shell
history. Nobody needs to read these back — step 2 runs inside the VPC and reads
them from Secrets Manager directly.

> Do not hand-write these passwords into `.env`, CI, or a task definition. The
> deploy preflight in qnsc-ci already refuses to deploy while an injected secret
> is still empty, which is what makes step 3 fail loudly rather than silently.

### 2. Grant LOGIN — the cutover task

There is **no interactive route to the database**. Both instances are
`PubliclyAccessible: false` and `enableExecuteCommand` is false on all four
services, so there is no psql session to run `ALTER ROLE` from. The migrator task
definition is the only workload holding the RDS master credential inside the
database's subnets, so the cutover runs there.

First let the migrator read the two passwords, in `infra/live/<env>/main.tf`:

```hcl
db_role_passwords_set = true
```

Apply. This is inert: it adds two `secrets` entries to the migrator task
definition and nothing else. The normal entrypoint (`node dist/db/migrate.js`)
ignores them, and api/worker are untouched.

> Why this is a separate flag from `db_least_privilege`: one apply cannot do both.
> Handing the migrator the passwords and pointing the runtime at the roles in a
> single change means api and worker restart against roles that are still NOLOGIN
> and fail `28P01` before the cutover task could ever run. The module has a
> `validation` block that rejects `db_least_privilege` while this is false.
>
> It fires at **plan** time, not `tofu validate` — cross-variable validation is
> evaluated with real values, so `validate` will happily accept the bad ordering.

Then run the cutover, once per environment:

```bash
aws ecs run-task \
  --cluster rally-<env> \
  --task-definition rally-<env>-migrator \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[<private-subnet-ids>],securityGroups=[<migrator-sg>],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"migrator","command":["node","dist/db/enable-least-privilege-roles.js"]}]}'
```

Then read the task's log stream in `/ecs/rally-<env>-migrator`. Success is two
lines, one per role:

```
✅  rally_app can log in, holds no privileged attributes, and cannot run DDL.
✅  rally_worker can log in, holds no privileged attributes, and cannot run DDL.
```

The script does the verification the old manual SQL asked for, and fails the task
rather than printing a warning:

- the role exists (else migration 0068 never ran here);
- `rolcanlogin` is true afterwards;
- `rolsuper`, `rolbypassrls`, `rolcreatedb`, `rolcreaterole`, `rolreplication` are
  all false — `rolbypassrls` especially, since a role that bypasses RLS is worse
  than the master credential it replaces, because it looks restricted;
- connecting as the role and running `CREATE TABLE` is **denied**. That probe runs
  inside a transaction that always rolls back, so it cannot leave a stray table in
  a real schema even if the grants are wrong.

It is idempotent — `ALTER ROLE` re-sets the same password — so a re-run is safe.

### 3. Flip the flag

One line in `infra/live/<env>/main.tf`, inside `module "stack"`:

```hcl
db_least_privilege = true
```

Apply. The execution role already has `GetSecretValue` on the new secrets —
`secret_arns` passes `values(module.secrets.secret_arns)` wholesale, so they were
covered the moment they were added to `secret_names`.

**Order matters and Terraform cannot enforce it.** Steps 1 and 2 must be done in
this environment first. Flip the flag against a role that has no password and the
tasks boot, fail to authenticate (`28P01`), and roll back.

**Leave the migrator on master.** Changing the runtime and the migrator in one
deploy means a failure cannot be attributed to either.

Watch for `permission denied for …` in CloudWatch. CI runs the whole e2e suite as
`rally_app` (see below), so a gap here is unlikely — but if one appears it means
migration 0068's `app_schemas` array missed a schema. Grant it and move on; that
is not a reason to revert the whole change.

### 4. Transfer ownership to `rally_migrate` (optional, do later)

Only needed if RLS is ever adopted, or to stop the migrator running as master.
Ownership transfer is the disruptive part, so it is deliberately not bundled
with steps 1–3.

```sql
REASSIGN OWNED BY <master_username> TO rally_migrate;
```

Then repeat step 3 for the migrator task, pointing it at a `rally_migrate`
secret. After this, `rally_app` is a non-owner and `FORCE ROW LEVEL SECURITY`
would no longer be required for policies to bite — see the RLS discussion in
`RALLY_HARDENING_PLAN.md` before going further.

## Rollback

Set `db_least_privilege = false` and apply. The master credential is untouched
throughout and the app holds no state tied to the role it connected as, so this
is a task-definition revision and a rolling restart — nothing more. The secrets
and the roles can stay; they are inert while the flag is off.

To retire the roles entirely:

```sql
ALTER ROLE rally_app NOLOGIN;
ALTER ROLE rally_worker NOLOGIN;
-- and only if you also want them gone:
-- REVOKE ALL ON ALL TABLES IN SCHEMA work FROM rally_app;  -- …per schema
-- DROP ROLE rally_app;
```

Step 4 is the one that is awkward to undo — `REASSIGN OWNED BY` back to the
master role works, but do it in a maintenance window.

## Verifying afterwards

```sql
-- Who is the app actually connecting as?
SELECT usename, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1;
-- Expect rally_app / rally_worker, and the master only during a migration.
```
