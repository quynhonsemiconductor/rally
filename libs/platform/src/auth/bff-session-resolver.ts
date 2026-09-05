import type { JwtPayload } from './jwt.strategy';

/**
 * Optional bridge that lets the shared {@link JwtAuthGuard} authenticate a
 * request from an opaque, server-side BFF session cookie when no `Bearer` token
 * is present.
 *
 * The concrete implementation (Entra OIDC + Valkey session) lives in the
 * product's identity module and is bound to the {@link BFF_SESSION_RESOLVER}
 * token. When it is left unbound — any product without BFF —
 * the guard behaves exactly as a pure JWT guard, so the Bearer path is never
 * altered. This inversion keeps the platform layer free of a hard dependency on
 * the identity module.
 */
export interface BffSessionResolver {
  /** Whether BFF session auth is active. When false the guard skips the cookie path. */
  readonly enabled: boolean;
  /**
   * Resolve — and transparently refresh near expiry — the request principal for
   * a session id, or `null` when the session is missing or invalid.
   */
  resolve(sid: string, ip: string): Promise<JwtPayload | null>;
}

/**
 * Name of the cookie carrying the opaque BFF session id. Shared here so the
 * guard that *reads* it and the controller that *issues* it agree on one value.
 * The `__Host-` prefix pins it to Secure + path=/ + no Domain.
 */
export const BFF_SESSION_COOKIE = '__Host-rova_session';

/** DI token for the optional {@link BffSessionResolver}. */
export const BFF_SESSION_RESOLVER = Symbol('BFF_SESSION_RESOLVER');
