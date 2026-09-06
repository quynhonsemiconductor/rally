/**
 * End-to-end proof of the SSO login → RBAC/PBAC pipeline.
 *
 * Flow: none. Authentication/authorisation infrastructure, not a numbered BA
 * business flow. It underpins every flow (each one assumes a signed-in actor
 * with resolved permissions) but proves no single one. Recorded explicitly so
 * the matrix can tell "deliberately not a flow" from "untraced".
 *
 * This boots the REAL rally `AppModule` (real Nest DI, real Drizzle against the
 * seeded `rova-postgres`) and drives the REAL `@quynhonsemiconductor/identity` `AuthService`.
 * The ONLY thing stubbed is the Entra token signature check
 * (`EntraTokenVerifier.verify`) — we cannot mint a Microsoft-signed JWT locally,
 * so the stub returns the `EntraClaims` a genuine verified token would yield.
 * Everything downstream of verification — JIT provisioning, workspace
 * enrolment, default-role assignment, platform-admin elevation, claims
 * resolution and access-token minting — runs exactly as it does in production.
 *
 * What it proves:
 *  1. A brand-new corporate-domain SSO user is JIT-provisioned and lands as
 *     `project_member`, and the PBAC permissions resolved for the minted access
 *     token EXACTLY match what `AccessService` resolves for that user+workspace.
 *  2. A user whose email is in `PLATFORM_ADMIN_EMAILS` is elevated to
 *     `workspace_admin` on SSO login and their token carries `workspace:*`.
 *  3. The two are correctly differentiated (member has no `workspace:*`).
 *
 * Prereqs: docker deps up (`docker compose -f docker-compose.dev.yml up -d`) and
 * the DB seeded (`pnpm db:seed`). Config is read from `.env` by @nestjs/config,
 * so the test runs against the same connection/tenant the dev server uses.
 */
import 'reflect-metadata';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuthService, EntraTokenVerifier, type EntraClaims } from '@quynhonsemiconductor/identity';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessService } from '@modules/access';
import { AppModule } from '../../apps/api/src/app.module';

// Read from the SAME environment the seed used, so the test matches whatever
// this machine bootstrapped rather than one hard-coded environment.
//
// These were previously literals ('dev-tenant' / 'nghiavt@qnsc.vn'), which meant
// the spec only passed where those exact values happened to be configured — CI.
// Locally, .env seeds a different tenant and admin, so both cases failed with
// "No workspace is configured for your organization" and a project_member/
// workspace_admin mismatch: a config mismatch that reads exactly like a product
// bug. The header even claimed config came from .env while the code ignored it.
//
// seedTenantBootstrap creates the SSO connection from ENTRA_TENANT_ID, and the
// platform-admin elevation reads PLATFORM_ADMIN_EMAILS, so deriving both from
// the same source keeps the test aligned by construction.
const TENANT = process.env['ENTRA_TENANT_ID'] ?? 'dev-tenant';
//
// An EMPTY value is not the same as an unset one, and `??` cannot tell them apart: `.env` in this
// repo ships `PLATFORM_ADMIN_EMAILS=` with nothing after it, so the fallback never fired, the claims
// carried `email: ''`, and the login died in `assertConnectionAllows` — "Your email domain is not
// permitted to sign in to this organization", which reads like an SSO defect and is a config read.
const PLATFORM_ADMIN_EMAIL = (process.env['PLATFORM_ADMIN_EMAILS'] ?? '').split(',')[0].trim();
// JIT provisioning is gated on the connection's allow-list, which
// seedTenantBootstrap builds from SSO_ALLOWED_EMAIL_DOMAINS — not from the admin
// address. Deriving it from the admin email instead would happen to pass while
// asserting the wrong thing.
const DOMAIN = (process.env['SSO_ALLOWED_EMAIL_DOMAINS'] ?? 'qnsc.vn').split(',')[0].trim();
const WORKSPACE_ALL = 'workspace:*';

interface DecodedAccessToken {
  sub: string;
  contextId: string | null;
  authMethod: 'password' | 'sso';
  claims: Record<string, unknown>;
}

/** Decode a JWT payload without verifying — we only read the claims we minted. */
function decodeAccessToken(token: string): DecodedAccessToken {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DecodedAccessToken;
}

/** Build the fake "verified" Entra token: the stub verifier just JSON-parses it. */
function entraToken(claims: EntraClaims): string {
  return JSON.stringify(claims);
}

describe('SSO login → RBAC/PBAC (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let auth: AuthService;
  let access: AccessService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Replace ONLY the Microsoft signature check. Everything else is real.
      .overrideProvider(EntraTokenVerifier)
      .useValue({
        verify: async (idToken: string): Promise<EntraClaims> => JSON.parse(idToken) as EntraClaims,
      })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    // init() runs onModuleInit lifecycle (DB pool, cache) without binding a port.
    await app.init();

    auth = app.get(AuthService);
    access = app.get(AccessService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('JIT-provisions a corporate SSO user as project_member with token PBAC matching the store', async () => {
    const claims: EntraClaims = {
      oid: 'e2e-sso-regular',
      email: `sso-e2e-regular@${DOMAIN}`,
      displayName: 'E2E Regular SSO User',
      externalTenantId: TENANT,
      roles: [],
    };

    const result = await auth.ssoLogin(entraToken(claims), '127.0.0.1');
    const token = decodeAccessToken(result.accessToken);

    // Minted via the SSO path, scoped to a real workspace.
    expect(token.authMethod).toBe('sso');
    expect(token.contextId).toEqual(expect.any(String));

    // The token carries NO permissions: there is no login-time snapshot to drift
    // from the store, because every check resolves from the store.
    expect(token.claims['permissions']).toBeUndefined();

    // The store is the single source of authority, so assert against it directly.
    const resolved = await access.getUserRoleAndPermissions(token.sub, token.contextId!);
    // RBAC migration: ensureDefaultRole is a no-op — a JIT user gets zero project access until
    // WA grants one, and zero WORKSPACE-tier permission with it. The baseline used to floor at
    // `workspace:view`; that floor gated Workspace Settings and the SCM inventory, so it is gone
    // (see `AccessService.getUserRoleAndPermissions` and `project-authz.e2e.spec.ts`).
    expect(resolved.role).toBe('');
    expect(resolved.permissions).toEqual([]);

    // A plain member is NOT a workspace admin.
    expect(resolved.permissions).not.toContain(WORKSPACE_ALL);
  });

  /**
   * Elevation is CONFIGURATION-GATED, so this case only has a subject when the variable names one.
   *
   * Skipped rather than defaulted to a literal address: with `PLATFORM_ADMIN_EMAILS` empty the app
   * elevates NOBODY, so asserting that some invented address becomes `workspace_admin` would assert
   * behaviour the running configuration does not have — a green test for a claim that is false on the
   * machine it ran on. CI sets the variable, which is where the assertion means something.
   */
  it.skipIf(!PLATFORM_ADMIN_EMAIL)(
    'elevates a PLATFORM_ADMIN_EMAILS user to workspace_admin',
    async () => {
      const claims: EntraClaims = {
        oid: 'e2e-sso-admin',
        email: PLATFORM_ADMIN_EMAIL,
        displayName: 'E2E Platform Admin',
        externalTenantId: TENANT,
        roles: [],
      };

      const result = await auth.ssoLogin(entraToken(claims), '127.0.0.1');
      const token = decodeAccessToken(result.accessToken);

      const resolved = await access.getUserRoleAndPermissions(token.sub, token.contextId!);
      expect(resolved.role).toBe('workspace_admin');

      // workspace_admin carries the `workspace:*` wildcard in the store — which is
      // now the only place it lives.
      expect(resolved.permissions).toContain(WORKSPACE_ALL);
      expect(token.claims['permissions']).toBeUndefined();
    },
  );
});
