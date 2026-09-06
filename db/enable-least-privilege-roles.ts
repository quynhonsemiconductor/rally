/**
 * Grant LOGIN to the least-privilege Postgres roles, then prove they are not
 * over-privileged. This is step 2 of docs/runbooks/db-role-least-privilege.md.
 *
 * Migration 0068 creates `rova_app` and `rova_worker` NOLOGIN, because giving a
 * role a password is a deliberate cutover step, not something a migration should
 * do. This script is that step, and it runs in two places:
 *
 *  - CI, before the e2e job, so the whole suite runs as `rova_app` instead of the
 *    superuser. Without it the split is untested: every other job connects as an
 *    owner, so a schema or sequence migration 0068 forgot to GRANT would pass CI
 *    and surface only after the real cutover, as `permission denied for …`.
 *
 *  - The deployed environments, as a one-off ECS task on the MIGRATOR task
 *    definition — the only workload that holds the RDS master credential and sits
 *    in the DB's subnets. RDS is not publicly accessible and ECS Exec is off, so
 *    there is no other path to the database.
 *      aws ecs run-task --task-definition rally-<env>-migrator \
 *        --overrides '{"containerOverrides":[{"name":"migrator",
 *          "command":["node","dist/db/enable-least-privilege-roles.js"]}]}'
 *
 * Idempotent: ALTER ROLE sets the password to the value it already has on a
 * re-run, so this is safe to repeat and safe to run before the flag flip.
 *
 * Lives in db/ rather than scripts/ so it compiles into dist/db via
 * tsconfig.migrator.json and ships in the migrator image, and so it can reuse the
 * repo's DSN composition instead of re-deriving it.
 */
// Load .env for local dev; in CI and ECS the env vars are injected directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI or container mode */
}

import { Client } from 'pg';
import { pgOptions } from './pg-ssl';
import { resolveMigrationUrl } from './database-url';

interface Target {
  role: string;
  /** Env var holding this role's password. Absent = skip the role entirely. */
  passwordEnv: string;
}

/**
 * The roles this script knows how to enable, and where each password comes from.
 *
 * A role whose password env var is unset is SKIPPED, not defaulted. That is what
 * lets one script serve both callers: CI supplies only `rova_app` (the e2e suite
 * is the only consumer), while the deployed one-off task supplies both from the
 * `db-app-password` / `db-worker-password` secrets. Defaulting instead would mean
 * a typo in the secret wiring silently set a guessable password on a real role.
 */
const TARGETS: Target[] = [
  { role: 'rova_app', passwordEnv: 'DATABASE_APP_PASSWORD' },
  { role: 'rova_worker', passwordEnv: 'DATABASE_WORKER_PASSWORD' },
];

/**
 * Attributes that must all be false on a least-privilege role. `rolsuper` and
 * `rolbypassrls` are the ones that would make the whole split decorative —
 * bypassrls in particular, since the point of moving off the owner is to stop
 * Postgres exempting it from row-level security.
 */
const FORBIDDEN_ATTRIBUTES = [
  'rolsuper',
  'rolbypassrls',
  'rolcreatedb',
  'rolcreaterole',
  'rolreplication',
] as const;

/**
 * `ALTER ROLE` is utility DDL: the grammar accepts neither an identifier nor a
 * password as a bind parameter, so both have to be interpolated. Validate them
 * instead. This now runs against REAL databases, not just an ephemeral CI one, so
 * an unchecked interpolation here would be an injection sink with production reach.
 */
function assertSafeRole(role: string): void {
  if (!/^[a-z_][a-z0-9_]*$/.test(role)) {
    throw new Error(`Refusing to interpolate an unsafe role name: ${role}`);
  }
}

function assertSafePassword(role: string, passwordEnv: string, password: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(password)) {
    throw new Error(
      `${passwordEnv} must be [A-Za-z0-9_-] only (it is the password for ${role}). ` +
        'database-url.ts composes a DSN from parts, so restricting the charset ' +
        'sidesteps URL-encoding entirely — see the runbook.',
    );
  }
}

/** Enable one role and verify it. Throws on anything unexpected. */
async function enableRole(adminUrl: string, admin: Client, target: Target, password: string): Promise<void> {
  const { role } = target;
  assertSafeRole(role);
  assertSafePassword(role, target.passwordEnv, password);

  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
  if (exists.rows.length === 0) {
    throw new Error(
      `Role ${role} does not exist. Migration 0068 should have created it — ` +
        'has db:migrate run against this database?',
    );
  }

  await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);

  // Assert the role gained LOGIN and nothing else. A role that is superuser or
  // bypasses RLS is worse than the master credential it replaces, because it
  // looks restricted.
  const attrs = await admin.query<Record<string, boolean>>(
    `SELECT rolcanlogin, ${FORBIDDEN_ATTRIBUTES.join(', ')} FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  const row = attrs.rows[0];
  if (!row?.['rolcanlogin']) {
    throw new Error(`${role} still cannot log in after ALTER ROLE. Nothing else was changed.`);
  }
  const granted = FORBIDDEN_ATTRIBUTES.filter((a) => row[a]);
  if (granted.length > 0) {
    throw new Error(
      `${role} holds privileged attributes it must not have: ${granted.join(', ')}. ` +
        'Fix the role before pointing any workload at it.',
    );
  }

  // Negative check: the role must NOT be able to run DDL. If the grants in
  // migration 0068 are ever widened to ownership this fails loudly instead of
  // quietly making the split decorative.
  //
  // Wrapped in a transaction that ALWAYS rolls back. The earlier CI-only version
  // created the probe table for real and dropped it afterwards, which would leave
  // a stray table in a production schema if the DROP ever failed. A rollback
  // cannot leave residue.
  const appUrl = new URL(adminUrl);
  appUrl.username = role;
  appUrl.password = password;

  const app = new Client(pgOptions(appUrl.toString()));
  await app.connect();
  let ddlAllowed = false;
  try {
    await app.query('BEGIN');
    await app.query('CREATE TABLE work.privilege_probe (id int)');
    ddlAllowed = true;
  } catch {
    // Expected: permission denied. DML-only is the whole point of the role.
  } finally {
    await app.query('ROLLBACK').catch(() => undefined);
    await app.end();
  }

  if (ddlAllowed) {
    throw new Error(
      `${role} was able to CREATE TABLE. It must hold DML rights only — ` +
        'check the GRANTs in db/migrations/0068_app_role_least_privilege.sql.',
    );
  }

  console.log(`✅  ${role} can log in, holds no privileged attributes, and cannot run DDL.`);
}

async function run(): Promise<void> {
  // Resolves DATABASE_MIGRATION_URL, else DATABASE_URL, else composes from the
  // DATABASE_* parts — the deployed path, where the migrator's master credential
  // arrives straight from the RDS-managed secret.
  let adminUrl: string;
  try {
    adminUrl = resolveMigrationUrl();
  } catch (err) {
    console.error(`❌  ${(err as Error).message}`);
    process.exit(1);
  }

  const requested = TARGETS.map((t) => ({ target: t, password: process.env[t.passwordEnv] })).filter(
    (r): r is { target: Target; password: string } => Boolean(r.password),
  );

  if (requested.length === 0) {
    console.error(
      '❌  No role passwords supplied. Set at least one of: ' +
        `${TARGETS.map((t) => t.passwordEnv).join(', ')}.`,
    );
    process.exit(1);
  }

  const admin = new Client(pgOptions(adminUrl));
  await admin.connect();
  try {
    for (const { target, password } of requested) {
      await enableRole(adminUrl, admin, target, password);
    }
  } catch (err) {
    console.error(`❌  ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await admin.end();
  }
}

void run();
