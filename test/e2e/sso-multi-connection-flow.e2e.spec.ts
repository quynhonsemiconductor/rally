/**
 * Multi-IdP OIDC broker — connection resolution, connection-driven provisioning,
 * and the disabled-connection cutoff, against the REAL rally AppModule + seeded
 * `rova-postgres`.
 *
 * The broker's expensive I/O (OIDC discovery + Secrets Manager) is exercised by
 * the package's unit tests; here we prove the parts that touch the real DB and
 * the real provisioning pipeline — which need no network because
 * `AuthService.ssoLoginFromConnection` takes the resolved connection ROW
 * directly (routing/verification already done upstream in production):
 *   1. the schema satisfies the package's connection CONTRACT;
 *   2. a `directory` connection is routed by its owned email domain (and unknown
 *      domains are denied);
 *   3. a `shared` connection is reachable only for an INVITED email;
 *   4. a federated user is JIT-provisioned into the RESOLVED connection's
 *      workspace + default role (never re-derived from claims);
 *   5. flipping a connection to `status='disabled'` denies login immediately.
 *
 * Prereqs: docker deps up + `pnpm db:seed` (+ migration 0057 applied), same as
 * the other e2e specs. Idempotent — fixed test tenants, upserted to `active` on
 * every run so a prior cutoff flip doesn't leak.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthService,
  SSO_CONNECTION_REPOSITORY,
  assertConnectionContract,
  type ISsoConnectionRepository,
  type EntraClaims,
} from '@quynhonsemiconductor/identity';
import { AccessService } from '@modules/access';
import { DRIZZLE, type DrizzleDB } from '@platform/database/drizzle.provider';
import { AppModule } from '../../apps/api/src/app.module';
import { ssoConnections, ssoConnectionDomains, users } from '../../db/schema/identity';
import { workspaceInvitations, workspaceMembers } from '../../db/schema/workspace';
import { WORKSPACE_ID, ADMIN_USER_ID } from './support/flow-harness';

const VENDOR_TID = 'e2e-mconn-vendor';
const CUTOFF_TID = 'e2e-mconn-cutoff';
const GOOGLE_TID = 'e2e-mconn-google';
const VENDOR_DOMAIN = 'vendor-e2e.test';
const CUTOFF_DOMAIN = 'cutoff-e2e.test';
const INVITED_EMAIL = 'guest@shared-e2e.test';

const BROKER = {
  authorityUrl: 'https://idp.example.test/x',
  clientId: 'e2e-cid',
  clientSecretRef: 'rova/test/sso/e2e',
} as const;

interface DecodedToken {
  authMethod: string;
  contextId: string | null;
  sub: string;
  claims: { permissions: string[] };
}

function decode(token: string): DecodedToken {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as DecodedToken;
}

describe('Multi-IdP broker: resolution, provisioning, cutoff (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let auth: AuthService;
  let access: AccessService;
  let repo: ISsoConnectionRepository;
  let db: DrizzleDB;

  async function upsertConnection(row: typeof ssoConnections.$inferInsert): Promise<void> {
    await db
      .insert(ssoConnections)
      .values(row)
      .onConflictDoUpdate({
        target: [ssoConnections.provider, ssoConnections.externalTenantId],
        set: {
          status: 'active',
          kind: row.kind,
          workspaceId: row.workspaceId,
          defaultRoleSlug: row.defaultRoleSlug,
          allowedEmailDomains: row.allowedEmailDomains,
          jitEnabled: row.jitEnabled,
          authorityUrl: row.authorityUrl,
          clientId: row.clientId,
          clientSecretRef: row.clientSecretRef,
          // Reconciled on conflict, not left at whatever the first run wrote: `created_at` is the
          // tiebreak `findSharedByInvitedEmail` orders on, so a row surviving from an earlier run
          // must adopt the caller's value or the shared-routing assertion depends on run history.
          // Only ever set from an explicit value — `$inferInsert` leaves it undefined otherwise, and
          // drizzle omits an undefined column rather than nulling it.
          ...(row.createdAt !== undefined && { createdAt: row.createdAt }),
          updatedAt: new Date(),
        },
      });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    auth = app.get(AuthService);
    access = app.get(AccessService);
    repo = app.get<ISsoConnectionRepository>(SSO_CONNECTION_REPOSITORY);
    db = app.get<DrizzleDB>(DRIZZLE);

    await upsertConnection({
      workspaceId: WORKSPACE_ID,
      provider: 'entra',
      externalTenantId: VENDOR_TID,
      kind: 'directory',
      defaultRoleSlug: 'project_member',
      allowedEmailDomains: [VENDOR_DOMAIN],
      jitEnabled: true,
      status: 'active',
      ...BROKER,
    });
    await upsertConnection({
      workspaceId: WORKSPACE_ID,
      provider: 'entra',
      externalTenantId: CUTOFF_TID,
      kind: 'directory',
      defaultRoleSlug: 'project_member',
      allowedEmailDomains: [CUTOFF_DOMAIN],
      jitEnabled: true,
      status: 'active',
      ...BROKER,
    });
    /**
     * `createdAt` is PINNED, and that is load-bearing rather than tidiness.
     *
     * The bootstrap seed now provisions its own `shared` connection in this same workspace (the
     * Entra "QNSC (guest)" row that lets an invited external type their address in the login box),
     * so two shared rows can match one invitation. `findSharedByInvitedEmail` breaks that tie with
     * `ORDER BY created_at, id` — oldest wins — which means the winner otherwise depends on whether
     * the seed or this fixture was written first.
     *
     * That is exactly the shape that passes locally and fails in CI: `db/seeds/reset.ts` truncates
     * nothing in `identity.*`, so a long-lived database keeps this fixture from an earlier run and it
     * is older than the seed's row; on a fresh database the seed runs first in global setup and wins
     * instead. Fixing the timestamp makes the tiebreak deterministic in both, and keeps this spec
     * asserting the routing rule rather than the order two writers happened to run in.
     */
    await upsertConnection({
      workspaceId: WORKSPACE_ID,
      provider: 'google',
      externalTenantId: GOOGLE_TID,
      kind: 'shared',
      defaultRoleSlug: 'project_member',
      allowedEmailDomains: [],
      jitEnabled: true,
      status: 'active',
      createdAt: new Date('2020-01-01T00:00:00Z'),
      ...BROKER,
    });

    const vendor = await repo.findByExternalTenantId('entra', VENDOR_TID);
    const cutoff = await repo.findByExternalTenantId('entra', CUTOFF_TID);
    await db
      .insert(ssoConnectionDomains)
      .values([
        { connectionId: vendor!.id, domain: VENDOR_DOMAIN },
        { connectionId: cutoff!.id, domain: CUTOFF_DOMAIN },
      ])
      .onConflictDoNothing({ target: ssoConnectionDomains.domain });

    await db
      .insert(workspaceInvitations)
      .values({
        workspaceId: WORKSPACE_ID,
        email: INVITED_EMAIL,
        tokenHash: `e2e-mconn-${INVITED_EMAIL}`,
        invitedBy: ADMIN_USER_ID,
        status: 'pending',
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      /**
       * REFRESH the window, do not skip on conflict.
       *
       * `db/seeds/reset.ts` deliberately truncates nothing in `workspace.*`, so this row survives
       * every run — and with `onConflictDoNothing` it kept the FIRST run's `expires_at` for ever.
       * The local row was thirteen days past expiry and still `pending`, so once
       * `findSharedByInvitedEmail` started checking the expiry (as `hasPendingInvitation` always
       * had), this fixture asserted routing for an invitation that must not route. The test was
       * passing on a row that contradicted its own intent.
       *
       * Note what that also demonstrates: `status` is a LAGGING projection of `expires_at` — the
       * cleanup cron flips rows to `expired` and does not run here at all. Only the timestamp can
       * gate access, which is exactly why the predicate checks it.
       */
      .onConflictDoUpdate({
        target: workspaceInvitations.tokenHash,
        set: { status: 'pending', expiresAt: new Date(Date.now() + 86_400_000) },
      });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the schema satisfies the broker connection contract', async () => {
    await expect(
      assertConnectionContract(async (table) => {
        const res = await db.execute(
          sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = ${table}`,
        );
        const rows =
          (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? ([] as unknown[]);
        return (rows as { column_name: string }[]).map((c) => ({ column_name: c.column_name }));
      }),
    ).resolves.toBeUndefined();
  });

  it('routes a directory connection by its owned email domain; denies unknown', async () => {
    const hit = await repo.findDirectoryByEmailDomain(`someone@${VENDOR_DOMAIN}`);
    expect(hit?.externalTenantId).toBe(VENDOR_TID);
    expect(await repo.findDirectoryByEmailDomain('someone@nowhere-e2e.test')).toBeNull();
    expect(await repo.connectionOwnsEmailDomain(hit!.id, `x@${VENDOR_DOMAIN}`)).toBe(true);
    expect(await repo.connectionOwnsEmailDomain(hit!.id, 'x@other-e2e.test')).toBe(false);
  });

  /**
   * The rule is "an INVITED address reaches a shared connection, an uninvited one reaches nothing".
   * It is deliberately NOT asserted as "reaches THIS shared connection".
   *
   * The bootstrap seed provisions its own `shared` row in this workspace — the Entra guest
   * connection that lets an invited external type their address in the login box — so two shared
   * rows legitimately match one invitation, and `findSharedByInvitedEmail` picks between them with
   * `ORDER BY created_at, id`. Which one wins is a property of that tiebreak, not of routing, and it
   * varies with whether the seed or this fixture was written first: `db/seeds/reset.ts` truncates
   * nothing in `identity.*`, so a long-lived database keeps this fixture from an earlier run while a
   * fresh one seeds first. Pinning the fixture's `created_at` makes the tiebreak deterministic (and
   * it is pinned, above), but asserting the winner here would still be asserting the wrong thing —
   * a second legitimate shared connection must not be able to fail this spec.
   */
  it('routes a shared connection only for an invited email', async () => {
    const invited = await repo.findSharedByInvitedEmail(INVITED_EMAIL);
    expect(invited).not.toBeNull();
    expect(invited?.kind).toBe('shared');
    expect(invited?.status).toBe('active');
    // Never domain-routed: a shared connection owns no `sso_connection_domains` rows, which is what
    // stops it admitting every address on a domain rather than only invited ones.
    expect(await repo.findDirectoryByEmailDomain(INVITED_EMAIL)).toBeNull();
    // The gate, and the whole point: without an invitation, nothing routes at all.
    expect(await repo.findSharedByInvitedEmail('uninvited@shared-e2e.test')).toBeNull();
  });

  /**
   * An EXPIRED invitation must not route, even while its row still says `pending`.
   *
   * Against a real database, because the predicate is the point: `findSharedByInvitedEmail` used to
   * check the status alone, so an expired invitation still selected its connection and was then
   * refused a moment later at the invite-only gate — `SSO_JIT_DISABLED`, surfacing from the BFF
   * callback as an opaque `AUTH_TOKEN_INVALID`, where `NO_CONNECTION` is the honest answer.
   *
   * The row is written `pending` with a PAST `expires_at` on purpose. That is not a contrived state:
   * the cleanup cron is what flips rows to `expired`, so every invitation passes through exactly
   * this shape between its expiry and the next tick — and this suite's own fixture sat in it for
   * thirteen days.
   */
  /**
   * THE RETURNING COLLABORATOR — the journey the whole shared connection exists for.
   *
   * Acceptance flips the invitation out of `pending`, and `resolveForEmail` has no third tier, so a
   * pending-only predicate let an external sign in exactly ONCE and then answered `NO_CONNECTION`
   * for ever. Against a real database because the fix is a SQL predicate over two tables, and the
   * bug was invisible to every test that only ever looked at a freshly-invited address.
   *
   * The removal half is the security pairing, and it is why routing keys on an ACTIVE membership row
   * rather than on `status IN ('pending','accepted')`: an accepted invitation never reverses, so
   * routing on it would readmit someone whose access was revoked — and the connection gate would let
   * them through (it admits any surviving `users` row), then re-enrol them on an empty membership
   * list. Both of those live in the vendored package, so this predicate is the only place it can be
   * refused.
   */
  it('keeps routing a collaborator AFTER acceptance, and stops once membership is removed', async () => {
    const email = `returning-${Date.now()}@shared-e2e.test`;

    // Invited, not yet accepted — routes on the invitation branch.
    await db.insert(workspaceInvitations).values({
      workspaceId: WORKSPACE_ID,
      email,
      tokenHash: `e2e-mconn-returning-${Date.now()}`,
      invitedBy: ADMIN_USER_ID,
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(await repo.findSharedByInvitedEmail(email)).not.toBeNull();

    // Acceptance: the invitation leaves `pending` and a membership row appears. This is exactly what
    // `WorkspaceService.acceptInvitation` does, reproduced here so the spec needs no HTTP session.
    const [user] = await db
      .insert(users)
      .values({ email, displayName: 'Returning Collaborator', status: 'active' })
      .returning({ id: users.id });
    await db
      .update(workspaceInvitations)
      .set({ status: 'accepted', acceptedBy: user.id, acceptedAt: new Date() })
      .where(
        and(
          eq(workspaceInvitations.workspaceId, WORKSPACE_ID),
          sql`lower(${workspaceInvitations.email}) = ${email}`,
        ),
      );
    await db
      .insert(workspaceMembers)
      .values({ workspaceId: WORKSPACE_ID, userId: user.id, status: 'active' });

    // The regression: with a pending-only predicate this returned null and locked them out.
    const returning = await repo.findSharedByInvitedEmail(email);
    expect(returning).not.toBeNull();
    expect(returning?.kind).toBe('shared');
    // Case-insensitively, since an IdP may return a differently-cased local part.
    expect(await repo.findSharedByInvitedEmail(email.toUpperCase())).not.toBeNull();

    // SUSPENDED is neither active nor removed, and must not route either — `workspace_member_status`
    // is `active | suspended | removed`, so a predicate written as `status <> 'removed'` would have
    // admitted a suspended collaborator. `= 'active'` is the narrower and correct form.
    await db
      .update(workspaceMembers)
      .set({ status: 'suspended' })
      .where(
        and(eq(workspaceMembers.workspaceId, WORKSPACE_ID), eq(workspaceMembers.userId, user.id)),
      );
    expect(await repo.findSharedByInvitedEmail(email)).toBeNull();

    // Removed: the membership ends, the `users` row survives (a removal does not delete the person,
    // which is exactly why the gate's `findByEmail != null` branch would still admit them).
    await db
      .update(workspaceMembers)
      .set({ status: 'removed' })
      .where(
        and(eq(workspaceMembers.workspaceId, WORKSPACE_ID), eq(workspaceMembers.userId, user.id)),
      );

    // Nothing routes them now — so they never reach the gate that would have re-enrolled them.
    expect(await repo.findSharedByInvitedEmail(email)).toBeNull();
  });

  it('does NOT route an expired invitation, even while its status is still pending', async () => {
    const expiredEmail = `expired-${Date.now()}@shared-e2e.test`;
    await db.insert(workspaceInvitations).values({
      workspaceId: WORKSPACE_ID,
      email: expiredEmail,
      tokenHash: `e2e-mconn-expired-${Date.now()}`,
      invitedBy: ADMIN_USER_ID,
      status: 'pending',
      expiresAt: new Date(Date.now() - 1_000),
    });

    expect(await repo.findSharedByInvitedEmail(expiredEmail)).toBeNull();
    // And the gate agrees, so the two predicates cannot drift apart again.
    expect(await repo.hasPendingInvitation(WORKSPACE_ID, expiredEmail)).toBe(false);
  });

  it('provisions a federated user into the resolved connection workspace + role', async () => {
    const vendor = await repo.findByExternalTenantId('entra', VENDOR_TID);
    const claims: EntraClaims = {
      oid: 'e2e-mconn-vendor-user',
      email: `user@${VENDOR_DOMAIN}`,
      displayName: 'Vendor E2E User',
      externalTenantId: null,
      roles: [],
    };
    const result = await auth.ssoLoginFromConnection(vendor!, claims, '127.0.0.1');
    const token = decode(result.accessToken);

    expect(token.authMethod).toBe('sso');
    expect(token.contextId).toBe(WORKSPACE_ID);
    const resolved = await access.getUserRoleAndPermissions(token.sub, WORKSPACE_ID);
    // RBAC migration: ensureDefaultRole is a no-op — a JIT user gets zero project access until WA
    // grants one, and no workspace-tier permission either (the `workspace:view` floor is gone).
    expect(resolved.role).toBe('');
    expect(resolved.permissions).toEqual([]);
  });

  it('denies login through a disabled connection (instant cutoff)', async () => {
    await db
      .update(ssoConnections)
      .set({ status: 'disabled' })
      .where(
        and(eq(ssoConnections.provider, 'entra'), eq(ssoConnections.externalTenantId, CUTOFF_TID)),
      );

    const disabled = await repo.findByExternalTenantId('entra', CUTOFF_TID); // findBy* has no status filter
    const claims: EntraClaims = {
      oid: 'e2e-mconn-cutoff-user',
      email: `user@${CUTOFF_DOMAIN}`,
      displayName: 'Cutoff E2E User',
      externalTenantId: null,
      roles: [],
    };
    await expect(auth.ssoLoginFromConnection(disabled!, claims, '127.0.0.1')).rejects.toMatchObject(
      {
        code: 'SSO_CONNECTION_DISABLED',
      },
    );
  });
});
