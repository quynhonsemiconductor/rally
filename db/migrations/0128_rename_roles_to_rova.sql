-- 0128_rename_roles_to_rova.sql
--
-- Rebrand: rename the least-privilege Postgres roles created in 0068 from the
-- old product name to the new one. `ALTER ROLE ... RENAME` preserves every
-- grant, default privilege and ownership the role holds — the role's OID does
-- not change — so no re-granting is needed. Renaming is a superuser/owner
-- operation, so this runs as the migrator (master) role.
--
-- Idempotent: each rename is guarded so a re-run (or a fresh DB that already
-- created the roles under the new name via an updated 0068) is a no-op.
--
-- ORDERING: the application's DATABASE_USER flips from rally_app/rally_worker to
-- rova_app/rova_worker in the SAME deploy that ships this migration. The migrator
-- runs before the api/worker roll, so by the time a task connects as rova_app the
-- role already exists under that name. The old login password carries over with
-- the rename; enable-least-privilege-roles then re-asserts it under the new name.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_app')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rova_app') THEN
    ALTER ROLE rally_app RENAME TO rova_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_worker')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rova_worker') THEN
    ALTER ROLE rally_worker RENAME TO rova_worker;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_migrate')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rova_migrate') THEN
    ALTER ROLE rally_migrate RENAME TO rova_migrate;
  END IF;
END
$$;
