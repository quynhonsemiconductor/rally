import { createPrivateKey, createPublicKey } from 'node:crypto';
import { z } from 'zod';

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .default(String(defaultValue))
    .transform((v) => v === 'true');

/**
 * Validated environment schema.
 * Process refuses to start if any required variable is missing or malformed.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    /** Set to 'true' in local dev / CI to bypass all rate limiting. Never set in production. */
    DISABLE_RATE_LIMIT: booleanish(false),

    // ── Database ───────────────────────────────────────────────────────────────
    // Supply EITHER a complete DATABASE_URL (local dev, CI) OR the discrete parts
    // (deployed). See db/database-url.ts for why the deployed path composes from
    // parts rather than storing a URL: the password belongs to the RDS-managed
    // secret that AWS rotates, and any copy of it goes stale silently.
    DATABASE_URL: z.string().url().optional(),
    DATABASE_HOST: z.string().optional(),
    DATABASE_PORT: z.coerce.number().int().positive().optional(),
    DATABASE_NAME: z.string().optional(),
    DATABASE_USER: z.string().optional(),
    DATABASE_PASSWORD: z.string().optional(),
    DATABASE_SSLMODE: z.string().default('require'),

    DATABASE_POOL_MIN: z.coerce.number().int().positive().default(2),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
    DATABASE_MIGRATION_URL: z.string().url().optional(),

    // Redis / Valkey
    //
    // REQUIRED, with no default, and that is the whole point. It used to default to
    // `redis://localhost:6379`, which is harmless locally and dangerous everywhere
    // else: a deployed task whose REDIS_URL injection went missing did not fail to
    // boot — it silently connected to nothing on its own loopback.
    //
    // That is not a degraded cache. Sessions live ONLY in Valkey, so every browser
    // session breaks; and the token denylist and the rate limiter both FAIL OPEN when
    // it is unreachable, so a revoked token keeps working and rate limiting stops. The
    // task meanwhile answers `/v1/healthz` with 200, because that probe deliberately
    // touches no dependency, so the ALB keeps it registered and nothing reports it.
    //
    // `JWT_PRIVATE_KEY` has no default for the same reason: absent config should fail
    // the deploy and roll back, not silently downgrade the service. A localhost
    // fallback is a local-development convenience, so it belongs in `.env`, where
    // `.env.example` already sets it — not in the schema every deployed task shares.
    REDIS_URL: z
      .string()
      .url('REDIS_URL must be a URL — rediss:// against the deployed cache, redis:// locally')
      .min(1, 'REDIS_URL is required: there is deliberately no localhost fallback'),
    REDIS_KEY_PREFIX: z.string().default('rova:'),

    // JWT — keys may be raw PEM or base64-encoded PEM
    JWT_PRIVATE_KEY: z
      .string()
      .min(1)
      .transform((v) => (v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8')))
      .refine((v) => v.includes('-----BEGIN'), 'JWT_PRIVATE_KEY must be a PEM-encoded private key'),
    /**
     * OPTIONAL — derived from JWT_PRIVATE_KEY when absent (see the transform at the
     * bottom of this file). Supply it only to override, e.g. a local .env that already
     * has a pair. Nothing needs it configured: an ES256 public key is a pure function
     * of its private key, and rova publishes no JWKS, so no verifier exists that
     * lacks the private key.
     */
    JWT_PUBLIC_KEY: z
      .string()
      .min(1)
      .transform((v) => (v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8')))
      .refine((v) => v.includes('-----BEGIN'), 'JWT_PUBLIC_KEY must be a PEM-encoded public key')
      .optional(),
    JWT_ACCESS_EXPIRY: z.string().default('15m'),
    JWT_REFRESH_EXPIRY: z.string().default('30d'),
    JWT_ISSUER: z.string().default('rova-api'),
    JWT_AUDIENCE: z.string().default('rova-web'),

    // Cookie signing. Distinct from CSRF_SECRET on purpose: this one signs every
    // cookie rally sets, so rotating it invalidates all of them. Sharing one value
    // between the two made a cookie-hygiene rotation read as a CSRF change (and
    // vice versa) in the audit trail.
    COOKIE_SECRET: z.string().min(32),

    // CSRF — HMAC key binding a token to the session that requested it, so a
    // token lifted from one session cannot be replayed in another.
    CSRF_SECRET: z.string().min(32),

    /**
     * Serve the OpenAPI document + Swagger UI at /api/docs. Defaults to OFF and
     * must be turned on explicitly: this used to be derived from
     * `NODE_ENV !== 'production'`, so any future environment that isn't literally
     * "production" (staging, preview, a mis-set task definition) would have
     * published the endpoint inventory without anyone choosing to.
     */
    SWAGGER_ENABLED: booleanish(false),

    // SCM webhooks (GitHub/GHE) — HMAC shared secret for X-Hub-Signature-256.
    // Optional so the app boots without SCM configured; the webhook endpoint
    // returns 503 until it is set (prod should source it from Secrets Manager).
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    // SCM Phase 2 — GitHub App (backfill + authenticated REST). All optional so
    // the app boots without them; backfill no-ops until configured.
    GITHUB_APP_ID: z.string().optional(),
    // App private key (PEM). Local/dev only — prod resolves it from Secrets
    // Manager via GITHUB_APP_PRIVATE_KEY_SECRET_REF using the shared SECRET_RESOLVER.
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    GITHUB_APP_PRIVATE_KEY_SECRET_REF: z.string().optional(),
    // REST API base — github.com is https://api.github.com; a GHE host would be
    // https://<host>/api/v3. Defaults to github.com.
    GITHUB_API_BASE_URL: z.string().url().default('https://api.github.com'),

    // AWS
    AWS_REGION: z.string().default('ap-southeast-1'),
    AWS_ACCOUNT_ID: z.string().optional(),
    /**
     * Custom AWS service endpoint. Set ONLY in local dev / CI to target an
     * emulator such as LocalStack (e.g. http://localhost:4566). Leave UNSET in
     * real AWS environments so the SDK uses the default regional endpoints.
     */
    AWS_ENDPOINT_URL: z.string().url().optional(),
    /**
     * SES configuration set every send is tagged with, so bounce/complaint events fan out
     * to the feedback queue. OPTIONAL: unset = sends are untagged and behave exactly as
     * before the feedback loop existed (the dev provider ignores it entirely).
     */
    SES_BOUNCE_CONFIGSET: z.string().default(''),
    /**
     * The SQS queue BounceFeedbackService drains for SES bounce/complaint verdicts.
     * OPTIONAL and the consumer's OFF switch: unset = no consumer starts. Set alongside
     * SES_BOUNCE_CONFIGSET in a deployed environment for the loop to be live end to end.
     */
    SES_BOUNCE_QUEUE_URL: z.string().default(''),
    /**
     * Static AWS credentials. Set ONLY alongside AWS_ENDPOINT_URL for local dev /
     * CI (LocalStack accepts any value, conventionally "test"). In real AWS the
     * ECS task role / instance profile supplies credentials — leave these UNSET.
     */
    AWS_ACCESS_KEY_ID: z.string().optional(),
    AWS_SECRET_ACCESS_KEY: z.string().optional(),
    /** PRIVATE bucket — every permission-gated upload. Served only via presigned GET. */
    S3_ATTACHMENTS_BUCKET: z.string().default('rova-attachments'),

    /**
     * PUBLIC bucket — non-sensitive assets only (avatars, workspace logos). World-
     * readable by key. Optional: when unset, any attempt to store a public asset
     * throws rather than silently falling back to the private bucket.
     */
    S3_PUBLIC_ASSETS_BUCKET: z.string().optional(),

    /**
     * CDN origin for the PUBLIC bucket. MUST NOT point at the private bucket —
     * doing so makes every attachment readable by key, bypassing authorization
     * entirely. StorageService.cdnUrl() has no private-bucket path for this reason.
     */
    CDN_PUBLIC_ASSETS_BASE_URL: z.string().url().optional(),

    // Object-storage backend selection (provider-neutral). All optional:
    //  - unset          → AWS S3 via the default credential chain (ECS task role).
    //  - STORAGE_ENDPOINT set → S3-compatible backend (Cloudflare R2, MinIO).
    // R2 requires STORAGE_ENDPOINT + STORAGE_ACCESS_KEY_ID + STORAGE_SECRET_ACCESS_KEY
    // + STORAGE_FORCE_PATH_STYLE=true. Bucket names stay S3_ATTACHMENTS_BUCKET /
    // S3_PUBLIC_ASSETS_BUCKET; both buckets share the one endpoint.
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

    /**
     * OPTIONAL credentials scoped to the PUBLIC bucket only.
     *
     * When set, StorageService builds a second S3 client for public-asset operations,
     * so the credential that can write world-readable avatars and logos is NOT the
     * credential that can read every permission-gated attachment. One leaked token
     * then costs one bucket instead of both.
     *
     * When unset, public operations reuse STORAGE_ACCESS_KEY_ID/SECRET — identical to
     * the previous behaviour, so this can be adopted without a flag day: set these,
     * deploy, then re-mint the primary token scoped to attachments alone.
     *
     * Both must be set together; one alone is a configuration error and is rejected
     * below rather than silently ignored.
     */
    STORAGE_PUBLIC_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_PUBLIC_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_FORCE_PATH_STYLE: booleanish(false),

    // ── Email ──────────────────────────────────────────────────────────────────
    /**
     * Which email transport to use. Defaults to 'dev' (logs to stdout).
     * 'ses' requires MAIL_FROM_EMAIL + IAM role with ses:SendEmail.
     * 'resend' requires RESEND_API_KEY + a verified domain in the Resend dashboard.
     */
    EMAIL_PROVIDER: z.enum(['ses', 'resend', 'dev']).default('dev'),
    /** Display name that appears in the From header, e.g. "Mini Rova". */
    MAIL_FROM_NAME: z.string().default('Mini Rova'),
    /** Verified sender address — used by all providers. Required when EMAIL_PROVIDER != 'dev'. */
    MAIL_FROM_EMAIL: z.string().email().optional(),
    /** Required when EMAIL_PROVIDER=resend. */
    RESEND_API_KEY: z.string().optional(),
    /** Reply-To address shown in email clients. Defaults to a no-reply alias. */
    MAIL_REPLY_TO: z.string().email().optional(),
    /** Public base URL used to build password-reset and invitation links (e.g. https://app.rally.io). */
    APP_BASE_URL: z.string().url().default('http://localhost:5173'),

    // Observability
    OTEL_ENABLED: booleanish(false),
    OTEL_SERVICE_NAME: z.string().default('rova-api'),
    OTEL_WORKER_SERVICE_NAME: z.string().default('rova-worker'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
    /** 0.0–1.0 fraction of root spans to sample. Defaults: 1.0 dev, 0.1 prod. */
    OTEL_SAMPLING_PROBABILITY: z.coerce.number().min(0).max(1).optional(),
    /** Semver string injected into OTEL resource and Pino logs. */
    SERVICE_VERSION: z.string().default('dev'),
    /**
     * Deployment identity for telemetry (`deployment.environment.name`) — NOT the
     * same thing as `NODE_ENV`.
     *
     * `NODE_ENV` is a runtime mode, and DEVELOP deliberately runs it as
     * `production` so `/v1/bff/dev-login` stays disabled on a public host (see the
     * env-flag notes in CLAUDE.md). Deriving deployment identity from it labelled
     * every develop span, metric and log as `production` — indistinguishable from
     * real production — and silently applied the production sampling ratio there.
     *
     * Infra sets this to `develop` / `production`. Left unset, `@quynhonsemiconductor/observability`
     * falls back to `NODE_ENV`, which is why this is optional rather than required.
     */
    DEPLOYMENT_ENV: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_PRETTY: booleanish(false),
    LOG_SQL: booleanish(false),
    LOG_HTTP_BODIES: booleanish(false),
    LOG_DEV_EMAIL_CONTENT: booleanish(false),

    // Resilience
    RESILIENCE_ENABLED: booleanish(true),

    // TTL knobs — defaults match SRS but allow ops to tune without code change
    INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
    SESSION_CLEANUP_OLDER_THAN_DAYS: z.coerce.number().int().positive().default(7),

    // SSO — Microsoft Entra ID (Azure AD) OpenID Connect
    // Rally authenticates exclusively through the server-side BFF flow, so these
    // Entra credentials are mandatory in every environment; the API refuses to
    // boot without them.
    ENTRA_TENANT_ID: z.string().min(1),
    ENTRA_CLIENT_ID: z.string().min(1),

    // ── BFF (Backend-for-Frontend) — server-side OIDC session ──────────────────
    // The API is a *confidential* OIDC client: it runs the Authorization-Code +
    // PKCE flow server-side and issues an opaque, httpOnly `__Host-` session
    // cookie, so Entra/JWT tokens never reach the browser. This is rally's sole
    // authentication mode — every /bff/* route is always active.
    /** Entra confidential-client secret. */
    ENTRA_CLIENT_SECRET: z.string().min(1),
    /**
     * Absolute URL of the BFF OIDC callback, registered as a redirect URI on the
     * Entra app registration, e.g. https://rally-dev.qnsc.vn/v1/bff/callback.
     */
    ENTRA_REDIRECT_URI: z.string().url(),
    /**
     * Provision an invited external collaborator as a Microsoft Entra B2B GUEST.
     *
     * When true, `WorkspaceService.inviteMember` writes a `messaging.guest_invite_outbox` row in
     * the invite transaction and the worker relay calls
     * `POST https://graph.microsoft.com/v1.0/invitations` app-only, reusing the SAME app
     * registration and secret as the BFF (`ENTRA_TENANT_ID` / `_CLIENT_ID` / `_CLIENT_SECRET`) —
     * no new secret and no infra change.
     *
     * DEFAULT FALSE, and load-bearing. The registration needs the `User.Invite.All` APPLICATION
     * permission with admin consent before any of it can work; without it every Graph call is a
     * 403, and an invitation must not break because a directory grant has not landed yet. Off, no
     * outbox row is written and `inviteMember` behaves exactly as it did before.
     *
     * `booleanish`, not `z.coerce.boolean()` — the latter turns the string "false" into `true`.
     */
    ENTRA_GUEST_INVITE_ENABLED: booleanish(false),
    /**
     * Comma-separated list of email domains that are INTERNAL to this deployment's
     * identity tenant (e.g. `qnsc.vn`). An invited address on one of these domains is
     * a directory member already — they sign in with the workspace SSO connection —
     * so `inviteMember` skips the Entra B2B GUEST provisioning queue for them: the
     * guest relay would only answer the same-tenant collision as "nothing to do",
     * and making the invitation email wait on that no-op buys nothing. The invitation
     * itself is unchanged — it is still the authorization grant, and it still emails;
     * internal domains additionally get the copy-link path, which does not depend on
     * mail deliverability at all. Empty (default) disables the distinction and every
     * address is treated as it was before this existed.
     */
    INTERNAL_EMAIL_DOMAINS: z.string().default(''),
    /**
     * Multi-IdP broker: the single app-level OIDC callback shared by every
     * federated connection (the same `/bff/callback` endpoint). Defaults to
     * ENTRA_REDIRECT_URI when unset (the home connection reuses it).
     */
    IDENTITY_REDIRECT_URI: z.string().url().optional(),
    /**
     * Multi-IdP broker: Secrets Manager ref (name/ARN, e.g. `rova/${env}/sso/home`)
     * holding the HOME Entra client secret for the broker path. When unset the home
     * connection is seeded without a secret ref and only the legacy home flow works.
     */
    IDENTITY_HOME_SECRET_REF: z.string().optional(),
    /**
     * Same-origin path the browser lands on after a successful BFF login when no
     * safe `returnTo` was supplied. Must be a root-relative path.
     */
    BFF_POST_LOGIN_REDIRECT: z.string().default('/'),
    /** Server-side BFF session lifetime (seconds). Defaults to 30 days. */
    BFF_SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 24 * 60 * 60),

    /**
     * Comma-separated SSO (Entra) emails auto-granted workspace_admin on first login.
     * Example: "nghiavt@qnsc.vn,quangld@qnsc.vn"
     */
    PLATFORM_ADMIN_EMAILS: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    /**
     * Database credentials must arrive by exactly one of the two routes. Checked here so a
     * misconfigured task dies at boot with a precise message, rather than surviving startup and
     * failing on the first query — which is how the stale db-url secret presented: a healthy-looking
     * deploy, then 28P01.
     *
     * `DATABASE_URL` short-circuits THIS check only. It used to `return` out of the whole
     * `superRefine`, which silently disabled every rule written after it — the storage-credential
     * pairing below never ran for any deploy that used a database URL, which is every deploy we
     * have. A refinement block that grows more rules cannot early-return.
     */
    const missing = env.DATABASE_URL
      ? []
      : (
          [
            'DATABASE_HOST',
            'DATABASE_PORT',
            'DATABASE_NAME',
            'DATABASE_USER',
            'DATABASE_PASSWORD',
          ] as const
        ).filter((k) => !env[k]);

    // Half a credential pair is a misconfiguration, not a partial feature: an id
    // without a secret silently falls back to the private-bucket credential, which is
    // the separation this pair exists to create.
    const pubId = Boolean(env.STORAGE_PUBLIC_ACCESS_KEY_ID);
    const pubSecret = Boolean(env.STORAGE_PUBLIC_SECRET_ACCESS_KEY);
    if (pubId !== pubSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [pubId ? 'STORAGE_PUBLIC_SECRET_ACCESS_KEY' : 'STORAGE_PUBLIC_ACCESS_KEY_ID'],
        message:
          'STORAGE_PUBLIC_ACCESS_KEY_ID and STORAGE_PUBLIC_SECRET_ACCESS_KEY must be set ' +
          'together, or both left unset to reuse the primary storage credential.',
      });
    }

    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          `Database not configured. Set DATABASE_URL, or all of DATABASE_HOST, DATABASE_PORT, ` +
          `DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD. Missing: ${missing.join(', ')}.`,
      });
    }

    /**
     * A real email provider needs a SENDER, and the absence of one is silent otherwise.
     *
     * `MAIL_FROM_EMAIL` said "Required when EMAIL_PROVIDER != 'dev'" in its own comment and was
     * `.optional()` in the schema, so nothing enforced it. Unset, `resolveFromEmail()` returns `''`
     * and every message goes out as `"Mini Rova" <>`: SES rejects each one with
     * `Email address not verified`, three failures open the email circuit breaker, and it stays open
     * for the life of the process. The task boots healthy and reports healthy — invitations,
     * notifications and password resets simply never arrive.
     *
     * That was the live state of BOTH deployed environments: `infra/modules/stack/main.tf` sets
     * `EMAIL_PROVIDER=ses` for the api and worker tasks and nothing set a sender. Failing at boot is
     * the rule this repo already follows for the database credentials above, and for the same
     * reason — a precise message now beats an invisible outage later.
     */
    if (env.EMAIL_PROVIDER !== 'dev' && !env.MAIL_FROM_EMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_FROM_EMAIL'],
        message:
          `EMAIL_PROVIDER is "${env.EMAIL_PROVIDER}", which sends real mail, so a verified sender ` +
          `is required. Set MAIL_FROM_EMAIL, or set ` +
          `EMAIL_PROVIDER=dev to log messages instead of sending them.`,
      });
    }
  })
  .transform((env, ctx) => {
    // JWT_PUBLIC_KEY is DERIVED, not configured.
    //
    // Storing the public half alongside the private one invited the single failure a
    // key pair cannot otherwise have: a MISMATCHED pair, where signing succeeds and
    // every verification rejects — total auth outage. Nothing caught it, because both
    // values were individually valid to Terraform, to the deploy preflight, and to
    // this schema. Deriving removes the possibility rather than monitoring for it.
    //
    // An explicit value still wins, so a local .env with a real pair keeps working and
    // infra can keep injecting one through the transition.
    if (env.JWT_PUBLIC_KEY) return { ...env, JWT_PUBLIC_KEY: env.JWT_PUBLIC_KEY };

    const reject = (message: string) => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_PRIVATE_KEY'], message });
      return z.NEVER;
    };

    // createPrivateKey FIRST, deliberately. createPublicKey happily accepts a public
    // key as its input and hands it straight back, so deriving from it would silently
    // succeed for the likeliest paste error there is — the public half dropped into
    // the private slot — and fail much later at the first sign().
    let privateKey;
    try {
      privateKey = createPrivateKey(env.JWT_PRIVATE_KEY);
    } catch {
      return reject(
        'JWT_PRIVATE_KEY is PEM but not a PRIVATE key. A public key pasted here would ' +
          'pass the format check and then break signing at runtime.',
      );
    }

    // ES256 means P-256 specifically. Any other curve signs happily and produces
    // tokens every verifier rejects, which reads as a broken deploy with no cause.
    const curve = privateKey.asymmetricKeyDetails?.namedCurve;
    if (privateKey.asymmetricKeyType !== 'ec' || curve !== 'prime256v1') {
      return reject(
        `JWT_PRIVATE_KEY must be an EC P-256 key for ES256, got ` +
          `${privateKey.asymmetricKeyType}${curve ? `/${curve}` : ''}.`,
      );
    }

    return {
      ...env,
      // Derived from the validated PEM rather than the KeyObject: @types/node's
      // createPublicKey overloads do not accept a bare KeyObject, though the runtime
      // does. Re-exporting keeps this typed without a cast.
      JWT_PUBLIC_KEY: createPublicKey(
        privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      )
        .export({ type: 'spki', format: 'pem' })
        .toString(),
    };
  });

export type Env = z.infer<typeof EnvSchema>;
