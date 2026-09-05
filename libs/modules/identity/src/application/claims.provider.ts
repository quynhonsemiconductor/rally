import { Injectable } from '@nestjs/common';
import type { IClaimsProvider, ProductClaims } from '@quynhonsemiconductor/identity';

/**
 * Rally's {@link IClaimsProvider}.
 *
 * Deliberately empty. Rally used to embed the user's effective permission codes
 * (plus the authorization epoch they were resolved at) in every access token, and
 * `PolicyGuard` authorized from that snapshot. That is what made a revoked
 * permission stay effective until the token rotated, and it is why an epoch
 * counter had to exist at all to invalidate tokens early.
 *
 * Authorization now resolves from the database on every check, cached per
 * (workspace, user) in Valkey and invalidated by the write paths — so the token
 * carries identity only, and there is no snapshot to go stale. Anything a caller
 * needs about its own permissions comes from `/v1/bff/me`, which resolves through
 * the same path the guard uses.
 *
 * Kept as a bound port rather than deleted: the shared auth core requires a
 * CLAIMS_PROVIDER, and a product that later wants a claim has one obvious place
 * to add it.
 */
@Injectable()
export class RovaClaimsProvider implements IClaimsProvider {
  getClaims(): Promise<ProductClaims> {
    return Promise.resolve({});
  }
}
