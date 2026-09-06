/**
 * Rate limit tier definitions.
 *
 * Each tier defines a { limit, windowSeconds } pair used by RateLimitGuard to
 * call CacheService.consumeRateLimit(). The tiers are intentionally named by
 * intent, not by numbers, so callers read like documentation.
 *
 * Tier selection guide:
 *  DEFAULT       — apply via global APP_GUARD to all undecorated routes
 *  STRICT        — sensitive writes (project delete, member removal, etc.)
 *  AUTH_LOGIN    — brute-force prevention on CREDENTIAL SUBMISSION
 *  AUTH_SSO_START— starting an external IdP redirect (no credential passes through us)
 *  AUTH_IDP_LOOKUP— resolving an email to an IdP (no credential, but an enumeration oracle)
 *  AUTH_REFRESH  — token rotation endpoint
 *
 * THE DISTINCTION MATTERS, and getting it wrong is what these three tiers exist to prevent. In a BFF
 * that brokers to an external IdP, most of the "login" surface submits nothing secret: it mints a
 * `state` cookie and returns an authorize URL, and the credential is presented to the IdP. Rate
 * limiting those at brute-force strength does not stop an attack — there is nothing to guess — while it
 * does cap how often a real person may START a login, which is exactly what someone does repeatedly
 * when a passkey fails, a tab closes, or they pick the wrong account. Tier by WHAT CROSSES THE
 * BOUNDARY, not by whether the word "login" appears in the path.
 */

export const RATE_LIMIT_METADATA_KEY = 'rova:rate_limit:tier';
export const SKIP_RATE_LIMIT_KEY = 'rova:rate_limit:skip';

export const RATE_LIMIT_TIERS = {
  /** All routes without an explicit @RateLimit() decorator: 100 req/min */
  DEFAULT: { limit: 100, windowSeconds: 60 },

  /** Sensitive write operations: 20 req/min */
  STRICT: { limit: 20, windowSeconds: 60 },

  /**
   * CREDENTIAL SUBMISSION: 5 attempts per 15 minutes per IP.
   * Stops credential-stuffing and password-spray attacks.
   * 15-min window (vs 1-min) prevents burst-then-wait circumvention.
   *
   * Belongs only on a route that accepts something secret and mints a session from it. In rally that
   * is `POST /v1/bff/dev-login` — which had NO limit at all while both SSO-initiation routes carried
   * this one, i.e. the protection sat where it could not help and was missing where it could. It is
   * 404 in production (`nodeEnv !== 'production'`), but `NODE_ENV` DEFAULTS to `development` in
   * `env.schema.ts`, so a lost environment variable fails open to a passwordless login — which is
   * precisely the case a brute-force limit is the last line for.
   */
  AUTH_LOGIN: { limit: 5, windowSeconds: 15 * 60 },

  /**
   * STARTING an external IdP redirect: 30 per 15 minutes per IP.
   *
   * No email, no secret, no enumeration surface — the request carries at most a `returnTo` and gets
   * back an authorize URL. What the limit protects is the `state` machinery: each call writes a
   * short-lived Valkey key, so it must not be unbounded. 30 leaves room for a person who fumbles a
   * passkey, abandons the IdP page, or switches accounts a few times inside one window; 5 did not,
   * and locked people out of even ATTEMPTING to sign in.
   */
  AUTH_SSO_START: { limit: 30, windowSeconds: 15 * 60 },

  /**
   * RESOLVING an email to its IdP: 10 per 15 minutes per IP.
   *
   * Deliberately tighter than AUTH_SSO_START and looser than AUTH_LOGIN, because this one sits in
   * between: it submits no credential, but it takes an ADDRESS and its answer differs for an address
   * that routes versus one that does not — a soft account-enumeration oracle. 10 is enough for a real
   * person correcting a typo, and slow enough that sweeping a domain is impractical from one IP.
   *
   * Not a substitute for the routing rule itself: an uninvited address is refused because no
   * connection matches it, not because of this limit.
   */
  AUTH_IDP_LOOKUP: { limit: 10, windowSeconds: 15 * 60 },

  /**
   * Token refresh: 30 req/min per session.
   *
   * Keyed by SHA-256 of the HttpOnly refresh-token cookie rather than client
   * IP. Each browser session gets its own independent bucket, so teams behind
   * a shared corporate NAT/proxy don't exhaust each other's quota.
   * Falls back to IP when no cookie is present (unauthenticated probe).
   */
  AUTH_REFRESH: { limit: 30, windowSeconds: 60, keyBy: 'refreshToken' as const },
} as const;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;
