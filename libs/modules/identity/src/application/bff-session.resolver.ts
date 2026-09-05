import { Inject, Injectable } from '@nestjs/common';
import { BffService } from '@quynhonsemiconductor/identity';
import { type BffSessionResolver, type JwtPayload, toRovaPrincipal } from '@platform';

/**
 * Rally adapter binding the shared `@quynhonsemiconductor/identity` {@link BffService} to
 * rally's {@link BffSessionResolver} contract, which the platform
 * {@link JwtAuthGuard} consumes.
 *
 * The shared service resolves a session to the product-neutral core payload;
 * rally flattens it onto its own request principal via {@link toRovaPrincipal},
 * exactly as the Bearer path does. This is the only rally-side seam the hoist
 * requires — the OIDC flow and session lifecycle now live in the package.
 */
@Injectable()
export class RovaBffSessionResolver implements BffSessionResolver {
  constructor(@Inject(BffService) private readonly bff: BffService) {}

  get enabled(): boolean {
    return this.bff.enabled;
  }

  async resolve(sid: string, ip: string): Promise<JwtPayload | null> {
    const core = await this.bff.resolve(sid, ip);
    return core ? toRovaPrincipal(core) : null;
  }
}
