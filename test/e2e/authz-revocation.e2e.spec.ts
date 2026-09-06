/**
 * End-to-end proof that a permission change takes effect on the user's NEXT
 * request — with no token refresh, no re-login, and nothing for the client to do.
 *
 * Flow: none. Authorization infrastructure, like `sso-rbac.e2e.spec.ts` — it
 * underpins every business flow but proves no single one. Recorded explicitly so
 * the coverage matrix can tell "deliberately not a flow" from "untraced".
 *
 * History, because it explains the shape of these assertions. Rally used to embed
 * `claims.permissions` in every access token and authorize from that snapshot, so
 * revoking a role left the issued token working for up to `JWT_ACCESS_EXPIRY`.
 * That was patched with an authorization epoch: a counter bumped on every change,
 * compared on every request, rejecting a superseded token with `TOKEN_STALE` so the
 * client refreshed. It worked, but it made a token's authority one cache lookup away
 * from valid, and it needed a re-mint path on the BFF session to stay invisible.
 *
 * The token now carries identity only. `PolicyGuard` resolves permissions from the
 * database on every check, cached per (workspace, user) in Valkey and invalidated
 * by the write paths. So there is no snapshot to supersede: the same token simply
 * gets a different answer. These tests assert exactly that — a 403 becomes a 200
 * (and back) across an admin action, on the SAME bearer token.
 *
 * This boots the REAL `AppModule` (real Nest DI, real Drizzle against the seeded
 * `rova-postgres`, real Valkey) and drives REAL HTTP requests through
 * `app.inject()`, so the guard chain, the cached resolution and the route all run
 * exactly as in production. The ONLY stub is the Microsoft signature check
 * (`EntraTokenVerifier.verify`), which cannot be satisfied locally.
 *
 * Prereqs: docker deps up (`docker compose -f docker-compose.dev.yml up -d`) and
 * the DB seeded (`pnpm db:seed`).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessService } from '@modules/access';
import type { JwtPayload } from '@platform';
import { ACCESS_LEVEL_PERMISSIONS } from '@shared-kernel';
import { AppModule } from '../../apps/api/src/app.module';
import { SEED_PROJECTS } from '../../db/seeds/constants';
import { grantProjectAccess } from './support/flow-harness';

const TENANT = process.env['ENTRA_TENANT_ID'] ?? 'dev-tenant';
const DOMAIN = (process.env['SSO_ALLOWED_EMAIL_DOMAINS'] ?? 'qnsc.vn').split(',')[0].trim();

/**
 * The probe must be gated by a WORKSPACE-tier permission a JIT-provisioned user
 * does NOT hold, so the same request flips its answer as the grant changes.
 * `audit:view` fits: held only by workspace_admin, and the route takes no path
 * params, so a non-200 can only come from the authorization decision.
 */
const PROBE_ROUTE = '/audit-logs';

/**
 * Seeded `workspace_admin` (see db/seeds/seed.ts). Used as the acting admin for
 * the role mutations below — `granted_by` is a real uuid column, so a synthetic
 * string id fails the insert.
 */
const SEEDED_ADMIN_ID = '00000000-0000-7000-8000-000000000002';

interface DecodedAccessToken {
  sub: string;
  contextId: string | null;
  claims: Record<string, unknown>;
}

function decodeAccessToken(token: string): DecodedAccessToken {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DecodedAccessToken;
}

describe('Permission changes take effect on the next request (real AppModule)', () => {
  let app: NestFastifyApplication;
  let auth: AuthService;
  let access: AccessService;

  /** Log in a brand-new JIT-provisioned SSO user, so each test owns its principal. */
  async function loginFreshUser() {
    const claims: EntraClaims = {
      oid: `e2e-authz-${randomUUID()}`,
      email: `authz-e2e-${randomUUID().slice(0, 8)}@${DOMAIN}`,
      displayName: 'E2E Authz User',
      externalTenantId: TENANT,
      roles: [],
    };
    const result = await auth.ssoLogin(JSON.stringify(claims), '127.0.0.1');
    return { result, token: decodeAccessToken(result.accessToken) };
  }

  function probe(accessToken: string) {
    return app.inject({
      method: 'GET',
      url: PROBE_ROUTE,
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  function actorFor(workspaceId: string): JwtPayload {
    return { sub: SEEDED_ADMIN_ID, workspaceId } as unknown as JwtPayload;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EntraTokenVerifier)
      .useValue({
        verify: async (idToken: string): Promise<EntraClaims> => JSON.parse(idToken) as EntraClaims,
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    // inject() drives the real Fastify router, which must be ready first.
    await app.getHttpAdapter().getInstance().ready();

    auth = app.get(AuthService);
    access = app.get(AccessService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('mints tokens that carry no permissions at all', async () => {
    // The absence IS the fix. While a token carried its own permission list, every
    // authorization answer was as old as the token, and an epoch counter had to
    // exist to expire it early.
    const { token } = await loginFreshUser();

    expect(token.claims['permissions']).toBeUndefined();
    expect(token.claims['authzEpoch']).toBeUndefined();
  });

  it('a GRANT takes effect on the same token, on the very next request', async () => {
    const { result, token } = await loginFreshUser();

    // 1. A JIT-provisioned user holds no `audit:view`.
    expect((await probe(result.accessToken)).statusCode).toBe(403);

    // 2. The admin action that used to require the victim to refresh.
    await access.elevateToWorkspaceAdmin(token.sub, token.contextId!);

    // 3. Same bearer token, no refresh, no re-login: allowed now.
    expect((await probe(result.accessToken)).statusCode).toBe(200);
  });

  it('a REVOCATION takes effect on the same token, on the very next request', async () => {
    const { result, token } = await loginFreshUser();
    await access.elevateToWorkspaceAdmin(token.sub, token.contextId!);
    expect((await probe(result.accessToken)).statusCode).toBe(200);

    // Revoke the workspace-scoped assignments that grant left behind. The actor is
    // the seeded workspace admin — this proves the effect on the VICTIM's
    // authorization, not the admin's own (covered by sso-rbac).
    const assignments = await access.getUserAssignments(token.contextId!, token.sub);
    const workspaceScoped = assignments.filter((a) => a.scopeType === 'workspace');
    expect(workspaceScoped.length).toBeGreaterThan(0);
    for (const assignment of workspaceScoped) {
      await access.revokeRole(actorFor(token.contextId!), assignment.id);
    }

    // The token is still perfectly valid — it just no longer authorizes this route.
    // 403, not 401: authentication never became the problem.
    expect((await probe(result.accessToken)).statusCode).toBe(403);
  });

  it('a PROJECT-scoped grant is visible immediately too', async () => {
    // Under the old epoch, project-scoped changes deliberately did NOT bump,
    // because project permissions were never in the token — they were resolved per
    // request, uncached, on every check. They now share the same cached read, so
    // this asserts the invalidation covers the project tier as well.
    //
    // Granted through `addProjectMember`, not `assignRole(..., 'project', ...)`: the latter now
    // throws `PROJECT_SCOPE_RETIRED` because per-Project tier access is carried on
    // `work.project_members.access_level`. A REAL project id is required for the same reason — the
    // write path validates the project exists, where a `scope_type='project'` row accepted any
    // uuid. That makes the assertion stronger, not weaker: the cache invalidation being tested is
    // the one on the production grant path.
    const { token } = await loginFreshUser();
    const projectId = SEED_PROJECTS[0].id;

    const before = await access.getProjectPermissions(token.sub, token.contextId!, projectId);

    await grantProjectAccess(app, token.sub, projectId, 'admin');

    // Asserted as a delta rather than a hardcoded code: naming one would only prove the
    // catalogue's contents. What matters is that the new grant is visible AT ONCE — no token
    // refresh, no TTL wait — and that whatever baseline existed survived the union.
    const after = await access.getProjectPermissions(token.sub, token.contextId!, projectId);
    const added = after.filter((code) => !before.includes(code));

    expect(added.length).toBeGreaterThan(0);
    expect(after).toEqual(expect.arrayContaining(before));
    expect(added).toEqual(
      expect.arrayContaining(
        [...ACCESS_LEVEL_PERMISSIONS.admin].filter((code) => !before.includes(code)),
      ),
    );
  });
});
