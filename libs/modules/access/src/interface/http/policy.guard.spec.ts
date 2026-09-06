import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PermissionDeniedException, type JwtPayload } from '@platform';
import {
  PolicyGuard,
  type PolicyScope,
  AUTHZ_MODE_KEY,
  grantsUnderTokenScopes,
} from './policy.guard';
import type { AccessService } from '../../application/access.service';
import type { ProjectScopeResolver } from '../../application/project-scope.resolver';

// Real permission codes so isProjectTierPermission / permissionGrants run for real:
//   roles:view   → WORKSPACE tier
//   work_item:edit → PROJECT tier
const WS_CODE = 'roles:view';
const PROJ_CODE = 'work_item:edit';

const actor = (permissions: string[]): JwtPayload => ({
  sub: 'user-1',
  workspaceId: 'ws-1',
  contextId: 'ws-1',
  permissions,
  claims: { permissions },
  sessionId: 's1',
  jti: 'j1',
  iss: 'rova',
  aud: 'rova',
  iat: 0,
  exp: 0,
  authMethod: 'sso',
});

function makeCtx(
  meta: { permission: string; scope?: PolicyScope } | undefined,
  req: {
    user?: JwtPayload;
    params?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  },
): { ctx: ExecutionContext; reflector: Reflector } {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(meta),
  } as unknown as Reflector;
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ params: {}, query: {}, body: {}, ...req }),
    }),
  } as unknown as ExecutionContext;
  return { ctx, reflector };
}

describe('PolicyGuard', () => {
  let access: {
    getProjectPermissions: ReturnType<typeof vi.fn>;
    getWorkspacePermissions: ReturnType<typeof vi.fn>;
  };
  let resolver: { resolve: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    access = {
      getProjectPermissions: vi.fn(),
      getWorkspacePermissions: vi.fn().mockResolvedValue([]),
    };
    resolver = { resolve: vi.fn() };
  });

  const guardFor = (reflector: Reflector) =>
    new PolicyGuard(
      reflector,
      access as unknown as AccessService,
      resolver as unknown as ProjectScopeResolver,
    );

  it('DENIES a route that declares no authorization', async () => {
    // This test used to assert `resolves.toBe(true)` — it encoded the fail-open. A handler
    // nobody decorated was allowed to every authenticated caller: JwtAuthGuard proved WHO the
    // caller was and nothing then checked WHETHER they may. 45 handlers were in that state.
    const { ctx, reflector } = makeCtx(undefined, { user: actor([]) });
    await expect(guardFor(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
  });

  it.each([
    ['self-scoped', { mode: 'self-scoped', reason: 'the caller' }],
    ['shared-read', { mode: 'shared-read', reason: 'reference data' }],
    ['in-service', { mode: 'in-service', reason: 'runtime', pinnedBy: 'x.spec.ts' }],
    ['gap', { mode: 'gap', reason: 'known hole' }],
  ])('allows an explicitly declared %s route', async (_name, mode) => {
    // A declared mode needs no permission code: the declaration IS the decision, and the
    // narrowing that makes it true lives in the service.
    const reflector = {
      getAllAndOverride: vi.fn((key: string) => (key === AUTHZ_MODE_KEY ? mode : undefined)),
    } as unknown as Reflector;
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ user: actor([]), params: {}, query: {}, body: {} }),
      }),
    } as unknown as ExecutionContext;

    await expect(guardFor(reflector).canActivate(ctx)).resolves.toBe(true);
  });

  it('fails closed when the user is missing (JwtAuthGuard did not run)', async () => {
    const { ctx, reflector } = makeCtx({ permission: WS_CODE }, { user: undefined });
    await expect(guardFor(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
      PermissionDeniedException,
    );
  });

  // ── Workspace tier ────────────────────────────────────────────────────────
  describe('workspace-tier', () => {
    it('allows when the DB-resolved baseline grants the code', async () => {
      // Resolved, not read off the token: the principal below deliberately carries
      // no permissions, because a token no longer has any.
      access.getWorkspacePermissions.mockResolvedValue([WS_CODE]);
      const { ctx, reflector } = makeCtx({ permission: WS_CODE }, { user: actor([]) });
      await expect(guardFor(reflector).canActivate(ctx)).resolves.toBe(true);
      expect(access.getWorkspacePermissions).toHaveBeenCalledWith('user-1', 'ws-1');
      expect(access.getProjectPermissions).not.toHaveBeenCalled();
    });

    it('denies when the baseline lacks the code — never touches project resolution', async () => {
      access.getWorkspacePermissions.mockResolvedValue(['audit:view']);
      const { ctx, reflector } = makeCtx({ permission: WS_CODE }, { user: actor([]) });
      await expect(guardFor(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
        PermissionDeniedException,
      );
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    it('honours a workspace wildcard', async () => {
      access.getWorkspacePermissions.mockResolvedValue(['workspace:*']);
      const { ctx, reflector } = makeCtx({ permission: WS_CODE }, { user: actor([]) });
      await expect(guardFor(reflector).canActivate(ctx)).resolves.toBe(true);
    });

    it('ignores a permissions array smuggled onto the principal', async () => {
      // Belt-and-braces on the whole point of the change: even if something puts a
      // permission list on req.user, the decision comes from the database.
      access.getWorkspacePermissions.mockResolvedValue([]);
      const { ctx, reflector } = makeCtx({ permission: WS_CODE }, { user: actor(['workspace:*']) });
      await expect(guardFor(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
        PermissionDeniedException,
      );
    });
  });

  // ── Project tier ──────────────────────────────────────────────────────────
  describe('project-tier', () => {
    const scope: PolicyScope = { resource: 'work_item', from: 'param', field: 'id' };

    it('resolves the project even for a workspace-wide holder', async () => {
      // The old fast path answered from the token when the caller held a
      // workspace-wide grant. `getProjectPermissions` already unions the baseline,
      // so the shortcut only bought a way to answer from a stale snapshot.
      resolver.resolve.mockResolvedValue('proj-9');
      access.getProjectPermissions.mockResolvedValue(['workspace:*']);
      const { ctx, reflector } = makeCtx(
        { permission: PROJ_CODE, scope },
        { user: actor([]), params: { id: 'wi-1' } },
      );
      await expect(guardFor(reflector).canActivate(ctx)).resolves.toBe(true);
      expect(access.getProjectPermissions).toHaveBeenCalledWith('user-1', 'ws-1', 'proj-9');
    });

    it('resolves the project from the resource and allows when the project role grants it', async () => {
      resolver.resolve.mockResolvedValue('proj-9');
      access.getProjectPermissions.mockResolvedValue([PROJ_CODE]);
      const { ctx, reflector } = makeCtx(
        { permission: PROJ_CODE, scope },
        { user: actor(['work_item:view']), params: { id: 'wi-1' } },
      );
      await expect(guardFor(reflector).canActivate(ctx)).resolves.toBe(true);
      expect(resolver.resolve).toHaveBeenCalledWith('work_item', 'wi-1', 'ws-1');
      expect(access.getProjectPermissions).toHaveBeenCalledWith('user-1', 'ws-1', 'proj-9');
    });

    it('denies when the resolved project role lacks the code', async () => {
      resolver.resolve.mockResolvedValue('proj-9');
      access.getProjectPermissions.mockResolvedValue(['work_item:view']);
      const { ctx, reflector } = makeCtx(
        { permission: PROJ_CODE, scope },
        { user: actor(['work_item:view']), params: { id: 'wi-1' } },
      );
      await expect(guardFor(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
        PermissionDeniedException,
      );
    });

    it('uses the id directly as the projectId for a non-resource scope', async () => {
      access.getProjectPermissions.mockResolvedValue([PROJ_CODE]);
      const { ctx, reflector } = makeCtx(
        { permission: PROJ_CODE, scope: { from: 'query', field: 'projectId' } },
        { user: actor([]), query: { projectId: 'proj-42' } },
      );
      await expect(guardFor(reflector).canActivate(ctx)).resolves.toBe(true);
      expect(resolver.resolve).not.toHaveBeenCalled();
      expect(access.getProjectPermissions).toHaveBeenCalledWith('user-1', 'ws-1', 'proj-42');
    });

    it('denies when the scope id is absent from the request', async () => {
      const { ctx, reflector } = makeCtx(
        { permission: PROJ_CODE, scope: { from: 'query', field: 'projectId' } },
        { user: actor([]), query: {} },
      );
      await expect(guardFor(reflector).canActivate(ctx)).rejects.toBeInstanceOf(
        PermissionDeniedException,
      );
      expect(access.getProjectPermissions).not.toHaveBeenCalled();
    });

    it('propagates a resolver 404 (unknown resource) instead of masking it as a deny', async () => {
      resolver.resolve.mockRejectedValue(new Error('WORK_ITEM_NOT_FOUND'));
      const { ctx, reflector } = makeCtx(
        { permission: PROJ_CODE, scope },
        { user: actor([]), params: { id: 'missing' } },
      );
      await expect(guardFor(reflector).canActivate(ctx)).rejects.toThrow('WORK_ITEM_NOT_FOUND');
    });
  });
});

describe('grantsUnderTokenScopes', () => {
  it('is a no-op for a principal with no scopes', () => {
    // Every cookie session and every JWT lands here: no scopes at all, so nothing may be narrowed.
    expect(grantsUnderTokenScopes(['work_item:view'], undefined, 'work_item:view')).toBe(true);
    expect(grantsUnderTokenScopes(['work_item:view'], [], 'work_item:view')).toBe(true);
  });

  it('requires BOTH the database and the token to grant the permission', () => {
    expect(grantsUnderTokenScopes(['work_item:view'], ['work_item:view'], 'work_item:view')).toBe(
      true,
    );
    // Held but not scoped: the token was minted without it.
    expect(grantsUnderTokenScopes(['work_item:view'], ['work_item:create'], 'work_item:view')).toBe(
      false,
    );
    // Scoped but not held: the scope cannot conjure a grant the user does not have.
    expect(grantsUnderTokenScopes([], ['work_item:view'], 'work_item:view')).toBe(false);
  });

  it('can only subtract, never add', () => {
    // The property that keeps this from being the `claims.permissions` snapshot again: a token is
    // always a subset of its owner, so a revoked grant lands on the token's next request.
    const held = ['work_item:view'];
    for (const scopes of [['workspace:*'], ['work_item:*'], ['project:delete']]) {
      expect(grantsUnderTokenScopes(held, scopes, 'project:delete')).toBe(false);
    }
  });

  it('honours a wildcard on either side', () => {
    // The case an array intersection gets wrong in both directions, which is why this is a two-sided
    // check rather than a set intersection.
    expect(grantsUnderTokenScopes(['work_item:view'], ['work_item:*'], 'work_item:view')).toBe(
      true,
    );
    expect(grantsUnderTokenScopes(['workspace:*'], ['work_item:view'], 'work_item:view')).toBe(
      true,
    );
    expect(grantsUnderTokenScopes(['workspace:*'], ['work_item:*'], 'work_item:create')).toBe(true);
    // A namespace scope still refuses another namespace.
    expect(grantsUnderTokenScopes(['workspace:*'], ['work_item:*'], 'project:delete')).toBe(false);
  });
});
