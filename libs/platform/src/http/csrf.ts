import { BFF_SESSION_COOKIE } from '../auth/bff-session-resolver';

/** Header the SPA echoes the CSRF token in. Mirrored in the CORS allow-list. */
export const CSRF_HEADER = 'x-csrf-token';

/**
 * Cookie holding the CSRF *secret* (not the token). `__Host-` pins it to Secure +
 * Path=/ + no Domain, and it is signed, so a subdomain or a non-TLS origin cannot
 * plant one.
 */
export const CSRF_SECRET_COOKIE = '__Host-rova_csrf';

/** Methods that cannot change state, so cannot be the target of a CSRF attack. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * Routes that must stay reachable without a CSRF token.
 *
 * Each entry is a deliberate exemption, not an oversight:
 *  - the login starters run BEFORE any session exists, so there is no token to
 *    issue yet (they are also protected by the OIDC `state` double-submit);
 *  - the dev-login shortcut is the same, and is already hard-blocked in production;
 *  - the SCM webhook is called by GitHub, not a browser: it carries no cookie and
 *    is authenticated by an HMAC signature instead.
 */
const EXEMPT_PATHS: readonly string[] = [
  '/v1/bff/login/sso',
  '/v1/bff/login/start',
  '/v1/bff/dev-login',
  '/v1/scm/webhook',
];

/** True when `url`'s path (query stripped) is an exempt route. */
function isExemptPath(url: string): boolean {
  const path = url.split('?')[0];
  return EXEMPT_PATHS.some((exempt) => path === exempt || path.startsWith(`${exempt}/`));
}

/** Whether the Authorization header carries a Bearer token. */
function hasBearerToken(authorization: string | string[] | undefined): boolean {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return typeof value === 'string' && value.trim().toLowerCase().startsWith('bearer ');
}

/**
 * Whether this request must present a valid CSRF token.
 *
 * CSRF is only possible when the browser attaches a credential **ambiently** — for
 * rally, the `__Host-rova_session` cookie. So the check applies exactly when all
 * of the following hold:
 *
 *  1. the method can change state;
 *  2. the request is NOT Bearer-authenticated — a caller that must attach a token
 *     by hand cannot be made to do so by an attacker's page, so requiring a second
 *     token would only break machine clients;
 *  3. a session cookie is actually present — with no ambient credential there is
 *     nothing to forge;
 *  4. the route is not one of the deliberate {@link EXEMPT_PATHS}.
 *
 * Kept a pure function of the request so the policy is unit-testable and lives in
 * one place, rather than being spread across route decorators where an omission
 * is invisible.
 */
export function requiresCsrfProtection(req: {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
}): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  if (hasBearerToken(req.headers['authorization'])) return false;
  if (!req.cookies?.[BFF_SESSION_COOKIE]) return false;
  return !isExemptPath(req.url);
}
