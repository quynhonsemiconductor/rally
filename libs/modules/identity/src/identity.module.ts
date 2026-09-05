import { Global, Module } from '@nestjs/common';
import {
  AuthService,
  EntraTokenVerifier,
  EntraOidcClient,
  BffService,
  BffSessionStore,
  BFF_OPTIONS,
  USER_REPOSITORY,
  AUTH_SESSION_REPOSITORY,
  SSO_CONNECTION_REPOSITORY,
  ACCESS_SERVICE,
  WORKSPACE_SERVICE,
  AUDIT_SERVICE,
  CLAIMS_PROVIDER,
  TRANSACTION_RUNNER,
  AUTH_SERVICE_OPTIONS,
  ENTRA_VERIFIER_OPTIONS,
  // Multi-IdP OIDC broker
  OidcDiscovery,
  OidcClient,
  OidcTokenVerifier,
  ConnectionRegistry,
  SECRET_RESOLVER,
} from '@quynhonsemiconductor/identity';
import type {
  AuthServiceOptions,
  EntraVerifierOptions,
  BffOptions,
  ISsoConnectionRepository,
  ISecretResolver,
} from '@quynhonsemiconductor/identity';
import { AppConfigService, BFF_SESSION_RESOLVER } from '@platform';
import { AccessModule, AccessService } from '@modules/access';
import { WorkspaceModule, WorkspaceService } from '@modules/workspace';
import { AuditService } from '@modules/audit';
import { AttachmentsModule } from '@modules/attachments';
import { IdentityController } from './interface/http/identity.controller';
import { AuthController } from './interface/http/auth.controller';
import { BffController } from './interface/http/bff/bff.controller';
import { RovaBffSessionResolver } from './application/bff-session.resolver';
import { UserDrizzleRepository } from './infrastructure/persistence/user.drizzle-repository';
import { AuthSessionDrizzleRepository } from './infrastructure/persistence/auth-session.drizzle-repository';
import { SsoConnectionDrizzleRepository } from './infrastructure/persistence/sso-connection.drizzle-repository';
import { SecretsManagerSecretResolver } from './infrastructure/secrets-manager-secret-resolver';
import { RovaClaimsProvider } from './application/claims.provider';
import { DrizzleTransactionRunner } from './application/transaction-runner';

/**
 * Rally's identity module. The refresh-rotation auth engine, Entra token
 * verification, and cookie contract all live in `@quynhonsemiconductor/identity`; rally
 * supplies the product-specific adapters via the shared DI tokens:
 *
 *  - persistence ports  → rally's drizzle repositories
 *  - service ports      → rally's access / workspace / audit services
 *  - claims provider    → rally's permission-based {@link RovaClaimsProvider}
 *  - transaction runner → drizzle `db.transaction`
 *  - token denylist     → `AuthTokenCache` (provided by the global PlatformModule)
 *  - options            → rally's env-driven config
 *
 * Rally keeps its own `JwtStrategy` / guards (extended `JwtPayload`), so the
 * package's `AuthModule.forRoot` is intentionally NOT used here.
 *
 * Marked `@Global` so the `BFF_SESSION_RESOLVER` bridge it exports is visible to
 * the shared (also global) `JwtAuthGuard` singleton, which must resolve the BFF
 * session cookie on EVERY authenticated route — not only the identity module's.
 */
@Global()
@Module({
  imports: [AccessModule, WorkspaceModule, AttachmentsModule],
  controllers: [IdentityController, AuthController, BffController],
  providers: [
    AuthService,
    EntraTokenVerifier,

    // BFF (Backend-for-Frontend) same-origin OIDC session — rally's only auth
    // path. The Entra client, session store, and orchestrator now live in
    // `@quynhonsemiconductor/identity`; rally binds `BFF_OPTIONS` from its env config and
    // adapts the core principal to `req.user` via `RovaBffSessionResolver`.
    EntraOidcClient,
    BffSessionStore,
    BffService,
    RovaBffSessionResolver,
    // Bridge that lets the shared JwtAuthGuard authenticate `/api/*` requests
    // from the BFF session cookie when no Bearer token is present.
    { provide: BFF_SESSION_RESOLVER, useExisting: RovaBffSessionResolver },

    // Multi-IdP OIDC broker collaborators. BffService picks these up via its
    // @Optional constructor params; the home/legacy path is unaffected when
    // (as today) no non-home connection is configured.
    { provide: OidcDiscovery, useFactory: () => new OidcDiscovery() },
    { provide: OidcClient, useFactory: () => new OidcClient() },
    { provide: OidcTokenVerifier, useFactory: () => new OidcTokenVerifier() },
    { provide: SECRET_RESOLVER, useClass: SecretsManagerSecretResolver },
    {
      provide: ConnectionRegistry,
      inject: [SSO_CONNECTION_REPOSITORY, SECRET_RESOLVER, OidcDiscovery, AppConfigService],
      useFactory: (
        repo: ISsoConnectionRepository,
        secrets: ISecretResolver,
        discovery: OidcDiscovery,
        config: AppConfigService,
      ) =>
        new ConnectionRegistry(
          repo,
          secrets,
          discovery,
          config.get('IDENTITY_REDIRECT_URI') ?? config.get('ENTRA_REDIRECT_URI'),
        ),
    },

    // Persistence ports → rally drizzle repositories.
    { provide: USER_REPOSITORY, useClass: UserDrizzleRepository },
    { provide: AUTH_SESSION_REPOSITORY, useClass: AuthSessionDrizzleRepository },
    { provide: SSO_CONNECTION_REPOSITORY, useClass: SsoConnectionDrizzleRepository },

    // Service ports → rally's existing domain services.
    { provide: ACCESS_SERVICE, useExisting: AccessService },
    { provide: WORKSPACE_SERVICE, useExisting: WorkspaceService },
    { provide: AUDIT_SERVICE, useExisting: AuditService },

    // Product adapters.
    { provide: CLAIMS_PROVIDER, useClass: RovaClaimsProvider },
    { provide: TRANSACTION_RUNNER, useClass: DrizzleTransactionRunner },

    {
      provide: AUTH_SERVICE_OPTIONS,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): AuthServiceOptions => ({
        jwtAccessExpiry: config.get('JWT_ACCESS_EXPIRY'),
        jwtRefreshExpiry: config.get('JWT_REFRESH_EXPIRY'),
        platformAdminEmails: (config.get('PLATFORM_ADMIN_EMAILS') ?? '')
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean),
        nodeEnv: config.get('NODE_ENV'),
      }),
    },
    {
      provide: ENTRA_VERIFIER_OPTIONS,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): EntraVerifierOptions => ({
        tenantId: config.get('ENTRA_TENANT_ID') ?? '',
        clientId: config.get('ENTRA_CLIENT_ID') ?? '',
      }),
    },
    {
      provide: BFF_OPTIONS,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): BffOptions => ({
        nodeEnv: config.get('NODE_ENV'),
        postLoginRedirect: config.get('BFF_POST_LOGIN_REDIRECT'),
        sessionTtlSeconds: config.get('BFF_SESSION_TTL_SECONDS'),
        entra: {
          tenantId: config.get('ENTRA_TENANT_ID'),
          clientId: config.get('ENTRA_CLIENT_ID'),
          clientSecret: config.get('ENTRA_CLIENT_SECRET'),
          redirectUri: config.get('ENTRA_REDIRECT_URI'),
        },
      }),
    },
  ],
  exports: [AuthService, BFF_SESSION_RESOLVER, SECRET_RESOLVER],
})
export class IdentityModule {}
