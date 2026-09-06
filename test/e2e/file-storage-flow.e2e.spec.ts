/**
 * File-storage E2E — the write path that had no test, plus a guard against the
 * regression that exposed it.
 *
 * WHY THIS EXISTS
 *
 * `backend-ci.yml` runs this whole suite as `rova_app` rather than the superuser,
 * specifically so that anything the restricted role cannot do fails CI instead of a
 * deployed environment. That gate silently proved nothing about storage, because no
 * spec in this directory touched a file, an attachment, an avatar or a workspace
 * logo. So when `db_least_privilege` moved api/worker off the owning role, two
 * surviving `tenant_isolation` RLS policies started denying every insert into
 * `storage.files` and `work.attachments`, and CI was green throughout.
 * Develop returned 500 on `POST /v1/auth/me/avatar/presign`:
 *
 *   new row violates row-level security policy for table "files"
 *
 * Migration 0070 dropped those policies. This spec is what would have caught it.
 *
 * It drives the REPOSITORY rather than `AttachmentsService.presign`, deliberately:
 * `insert into "storage"."files"` is the exact statement RLS refused, and going
 * through presign would require live R2 credentials, making the test about object
 * storage instead of about the database boundary that actually broke.
 *
 * Prereqs: docker deps up + `pnpm db:migrate` (see flow-harness).
 */
import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FILE_REPOSITORY, type IFileRepository } from '@modules/attachments';
import { DRIZZLE, type DrizzleDB } from '@platform';

import { ADMIN_USER_ID, WORKSPACE_ID, bootRallyApp, uniqueKey } from './support/flow-harness';

describe('file storage (e2e)', () => {
  let app: NestFastifyApplication;
  let files: IFileRepository;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await bootRallyApp();
    files = app.get<IFileRepository>(FILE_REPOSITORY);
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * The regression guard, and the reason this file is worth more than its length.
   *
   * RLS on these tables is not a config choice someone may re-make: Rally is
   * single-tenant, so DB-level isolation is an explicit non-goal of the
   * drop-multi-tenant design, and migration 0025 tore the apparatus down. Migration
   * 0053 then re-added it to two tables on the stated belief that it "mirrors the
   * policy every other workspace-scoped table carries" — untrue by then, and the
   * direct cause of the outage above.
   *
   * Asserting on `pg_tables` rather than on `pg_policies` is deliberate: a table
   * with RLS enabled and NO policy denies everything for a non-owner, which is
   * harder to diagnose than a failing policy, and 0053 enabled RLS and created the
   * policy in separate statements. Either half alone is a fault.
   */
  it('has no row-level security enabled on any application table', async () => {
    const { rows } = await db.execute(sql`
      SELECT schemaname || '.' || tablename AS tbl
      FROM pg_tables
      WHERE rowsecurity = TRUE
        AND schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY 1
    `);

    expect(
      rows.map((r) => (r as { tbl: string }).tbl),
      'RLS is enabled on a table. Rally enforces workspace isolation in the repository ' +
        'layer (see test/workspace-scope.ratchet.spec.ts); no application code sets ' +
        'app.workspace_id, so any policy referencing it denies every write as soon as the ' +
        'app connects as a non-owner. See migration 0070.',
    ).toEqual([]);
  });

  /** The insert RLS refused. Fails as `rova_app` if a policy ever comes back. */
  it('writes and reads back a file row as the connected role', async () => {
    const id = randomUUID();
    const created = await files.create({
      id,
      workspaceId: WORKSPACE_ID,
      storageKey: `user-avatar/${ADMIN_USER_ID}/${id}`,
      filename: uniqueKey('avatar'),
      mimeType: 'image/jpeg',
      sizeBytes: 43_361,
      checksumSha256: 'GDEG6sQa3t75wFW00PmfC3Frk/U1amwsJzmIcF+/TzI=',
      visibility: 'public',
      uploadedBy: ADMIN_USER_ID,
    });

    expect(created.id).toBe(id);
    expect(created.status).toBe('pending');

    // The SELECT half: an RLS qual filtered these to zero rows rather than erroring,
    // so a write-only test would still have passed while every read came back empty.
    const found = await files.findById(id, WORKSPACE_ID);
    expect(found?.id).toBe(id);
    expect(found?.visibility).toBe('public');

    await files.softDelete(id);
  });

  /**
   * The boundary that REPLACES RLS, asserted rather than assumed. Dropping the
   * policies is only defensible because this holds.
   */
  it('does not return a file to a different workspace', async () => {
    const id = randomUUID();
    await files.create({
      id,
      workspaceId: WORKSPACE_ID,
      storageKey: `user-avatar/${ADMIN_USER_ID}/${id}`,
      filename: uniqueKey('avatar'),
      mimeType: 'image/png',
      sizeBytes: 1_024,
      checksumSha256: 'GDEG6sQa3t75wFW00PmfC3Frk/U1amwsJzmIcF+/TzI=',
      visibility: 'private',
      uploadedBy: ADMIN_USER_ID,
    });

    const otherWorkspace = randomUUID();
    expect(await files.findById(id, otherWorkspace)).toBeNull();

    await files.softDelete(id);
  });
});
