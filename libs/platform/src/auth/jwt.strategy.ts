import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Algorithm } from 'jsonwebtoken';
import type { JwtPayload as CoreJwtPayload } from '@quynhonsemiconductor/identity';
import { AppConfigService } from '../config/app-config.service';
import { toRovaPrincipal } from './rova-principal';

/**
 * Rally's request-scoped auth principal. Extends the shared `@quynhonsemiconductor/identity`
 * access-token payload — which carries the product-neutral `contextId` and the
 * product-defined `claims` bag — with rally's own flattened conveniences:
 * `workspaceId` (== `contextId`) and `permissions` (== `claims.permissions`).
 * Keeping these mirrors means rally's guards, decorators, and controllers keep
 * reading the same `req.user` fields they always have.
 */
export interface JwtPayload extends CoreJwtPayload {
  /** Active workspace id — rally's mirror of the core `contextId`. */
  workspaceId: string;
  /**
   * Effective permission codes for this user — rally's flattened mirror of
   * `claims.permissions`. Embedded at token-mint time and refreshed on every
   * rotation, so stale permissions are bounded by the access-token TTL.
   */
  permissions: string[];
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: AppConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_PUBLIC_KEY'),
      algorithms: ['ES256'] as Algorithm[],
      issuer: config.get('JWT_ISSUER'),
      audience: config.get('JWT_AUDIENCE'),
    });
  }

  /**
   * Map the verified `@quynhonsemiconductor/identity` token onto rally's `req.user`:
   * `contextId` → `workspaceId` and `claims.permissions` → `permissions`.
   * The denylist (Valkey) check happens in the JwtAuthGuard.
   */
  validate(payload: CoreJwtPayload): JwtPayload {
    return toRovaPrincipal(payload);
  }
}
