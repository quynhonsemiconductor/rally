/**
 * Shared bootstrap + fixtures for the BA business-flow E2E suite.
 *
 * These specs boot the REAL rally `AppModule` (real Nest DI, real Drizzle
 * against the seeded `rova-postgres`) and drive the REAL application services,
 * exactly as the HTTP controllers do. Nothing is stubbed: the flows are proven
 * end-to-end against the same code and database the running server uses.
 *
 * The BA "project scope + flow" spec these tests encode lives in
 * product-docs/projects/mini-rally/testing/E2E_BUSINESS_FLOW_COVERAGE.md
 * (flows E2E-001 … E2E-009).
 *
 * Prereqs: docker deps up (`docker compose -f docker-compose.dev.yml up -d`)
 * and the DB seeded (`pnpm db:seed`). Config is read from `.env` by
 * @nestjs/config, so the suite runs against the same connection/tenant as dev.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  NXP_CAPACITY_PLAN_2_ID,
  NXP_CAPACITY_PLAN_ID,
  NXP_DEFECT_1_ID,
  NXP_EPIC_1_ID,
  NXP_FEATURE_1_ID,
  NXP_ITER_CURRENT_ID,
  NXP_ITER_FUTURE_ID,
  NXP_ITER_PAST_ID,
  NXP_RELEASE_1_ID,
  NXP_RELEASE_2_ID,
  NXP_STORY_1_ID,
  PAY_CAPACITY_PLAN_ID,
  PAY_DEFECT_ID,
  PAY_EPIC_ID,
  PAY_FEATURE_ID,
  PAY_ITER_ID,
  PAY_MILESTONE_ID,
  PAY_PROJECT_ID,
  PAY_RELEASE_ID,
  PAY_STORY_ID,
  SEED_PROJECTS,
  TEAM_ALPHA_ID,
  TEAM_BETA_ID,
  TEAM_GAMMA_ID,
} from '../../../db/seeds/constants';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { JwtPayload } from '@platform';
import type { ProjectAccessLevel } from '@shared-kernel';
import { AccessService } from '@modules/access';
import { PlatformModule } from '@platform';
import { NotificationsModule } from '@modules/notifications';
import { AuditModule } from '@modules/audit';
import { AuditProjectionRelay } from '../../../apps/worker/src/audit/audit-projection.relay';

import { AppModule } from '../../../apps/api/src/app.module';
import { NotificationRelayService } from '../../../apps/worker/src/notifications/notification-relay.service';
import { EmailRelayService } from '../../../apps/worker/src/email/email-relay.service';

// ── Seed fixtures (see db/seeds/seed.ts) ──────────────────────────────────────
export const WORKSPACE_ID = '00000000-0000-7000-8000-000000000003';
/** Seeded `workspace_admin` — carries `workspace:*`. */
export const ADMIN_USER_ID = '00000000-0000-7000-8000-000000000002';
/** Seeded `project_member` at workspace scope. */
export const DEVELOPER_ID = '00000000-0000-7000-8000-000000000020';
/** Seeded `project_viewer` at workspace scope — read-only. */
export const VIEWER_ID = '00000000-0000-7000-8000-000000000021';

/** Boot the real AppModule with a Fastify adapter (no port bound). */
export async function bootRallyApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  // init() runs onModuleInit (DB pool, cache) without binding a port.
  await app.init();
  return app;
}

/**
 * Boot just enough of the real Worker to exercise the notification + email
 * relay's actual fetchBatch/processRow/markSent/markFailed against the seeded
 * DB — the same code the deployed Worker runs. Deliberately does NOT import
 * ScheduleModule.forRoot() or the full WorkerModule (AuditProjectionRelay,
 * ReportingModule, etc.): the @Cron decorators on relay() then have no
 * scheduler to register against, so the 5s cron never fires on its own —
 * tests call `.relay()` directly instead of waiting on/racing it.
 *
 * The Valkey wake-signal subscription is NOT disabled, though, and previously
 * this comment claimed "nothing fires on its own timer" as if it were —
 * onModuleInit() (below) subscribes both relays for real, so any code in the
 * same test file that goes through NotificationSchedulerService/
 * EmailSchedulerService (not a raw db.insert()) still triggers an
 * independent, un-awaited relay() pass exactly as it would in production.
 * That used to make direct `await relay()` calls non-deterministic — a call
 * could race an in-flight wake-triggered pass and return having silently
 * processed nothing (see AbstractOutboxRelay.relay()'s old isRelaying-flag
 * design). Fixed at the source: relay() now guarantees its promise never
 * resolves before a pass that started at-or-after the call has completed, so
 * awaiting it is deterministic regardless of whether a cron, a wake signal,
 * or this harness triggered the pass that got there first.
 */
export async function bootRallyWorkerRelays(): Promise<{
  module: TestingModule;
  notificationRelay: NotificationRelayService;
  emailRelay: EmailRelayService;
}> {
  const module = await Test.createTestingModule({
    imports: [PlatformModule, NotificationsModule],
    providers: [NotificationRelayService, EmailRelayService],
  }).compile();

  // onModuleInit (Valkey wake-signal subscription) still runs via init().
  await module.init();

  return {
    module,
    notificationRelay: module.get(NotificationRelayService),
    emailRelay: module.get(EmailRelayService),
  };
}

/**
 * Boot the audit projection relay against the real DB, with nothing else running.
 *
 * Deliberately a separate module from `bootRallyWorkerRelays`: two relays polling
 * `outbox_events` and `notification_outbox` in one process are competing consumers,
 * and a test that has to reason about which relay claimed its row is a test that will
 * eventually be flaky for a reason nobody can reproduce.
 */
export async function bootAuditProjectionRelay(): Promise<{
  module: TestingModule;
  relay: AuditProjectionRelay;
}> {
  const module = await Test.createTestingModule({
    imports: [PlatformModule, AuditModule],
    providers: [AuditProjectionRelay],
  }).compile();

  await module.init();

  return { module, relay: module.get(AuditProjectionRelay) };
}

/**
 * Build a `JwtPayload` actor exactly as the auth guard would after minting an
 * access token. The application services read only `sub` and `workspaceId`; the
 * remaining JWT fields — `permissions` included, see `viewerActor` below — are
 * inert values so the shape type-checks.
 */
export function makeActor(userId: string, permissions: string[] = []): JwtPayload {
  return {
    sub: userId,
    contextId: WORKSPACE_ID,
    workspaceId: WORKSPACE_ID,
    permissions,
    claims: { permissions },
    sessionId: 'e2e-session',
    jti: 'e2e-jti',
    iss: 'rova-e2e',
    aud: 'rova',
    iat: 0,
    exp: 0,
    authMethod: 'sso',
  };
}

/**
 * Workspace-admin actor. The `workspace:*` list is decorative — like every principal's
 * `permissions`, it is inert (see `viewerActor`). What makes this actor an admin is the seeded
 * `user_role_assignments` row for `ADMIN_USER_ID`, which is what `AccessService` reads.
 */
export const adminActor = (): JwtPayload => makeActor(ADMIN_USER_ID, ['workspace:*']);

/**
 * A seeded user holding NO project grant — the No Access principal.
 *
 * Named `viewer` for the seeded fixture user it wraps, not for a level: §2.2 lists two levels (`Admin`
 * and `Editor`) and makes No Access the ABSENCE of an active `project_members` row. The BA removed
 * `Viewer` (`product-docs` 55e7dbb).
 *
 * It used to be a read-only principal backed by a workspace-owned CUSTOM ROLE assigned at WORKSPACE
 * scope, arranged by an `ensureViewerGrant` helper. Both halves are gone — custom roles by ruling
 * (AC-11), and the workspace-scoped shape because one row granting project-tier codes across every
 * project IS the over-grant migration 0111 removed. So there is nothing to arrange: use this actor for
 * the denied case, and `grantProjectAccess` when a spec needs a principal that CAN do something.
 *
 * The permission list on a principal is INERT either way — authorization resolves from the database on
 * every check, so a fixture cannot grant itself anything by declaring a list here.
 */
export const viewerActor = (): JwtPayload => makeActor(VIEWER_ID);

/**
 * Grant a user per-Project access at `admin` or `editor` — the ONLY supported way to give someone
 * project-tier permissions.
 *
 * Replaces `access.assignRole(actor, userId, roleId, 'project', projectId)`, which now throws
 * `PROJECT_SCOPE_RETIRED`: migration 0105 deleted the `scope_type='project'` rows and the service
 * refuses to create more, because a per-Project tier role is carried on
 * `work.project_members.access_level`. Four e2e tests across three files were still calling it and
 * had been red ever since.
 *
 * Goes through `AccessService.grantProjectAccess`, deliberately, rather than writing the row:
 * that path also invalidates the permission cache for the affected user, so a spec asserting a
 * grant is visible on the NEXT REQUEST is exercising the real invalidation rather than a TTL
 * expiry. It upserts, so repeated runs against the same seeded database stay clean.
 *
 * The PRIMITIVE writer, not `ProjectsService.setProjectAccess`, and that is the point: the combined
 * writer enforces PRJ-08 ("an Editor must have at least one Team", §2.2), and a fixture that wants
 * `editor` on a SEEDED project — which has teams — is arranging DATA rather than walking the §5
 * journey that rule belongs to. Routing the harness through the journey would make every such spec
 * depend on a team roster it never asked about. Use `setProjectAccess` (or the HTTP route) when the
 * spec is about the rule itself.
 *
 * The level maps onto the same permission sets the retired roles carried —
 * `ACCESS_LEVEL_PERMISSIONS.admin` IS `ROLE_PERMISSIONS[PROJECT_ADMIN]` — so a test that wanted
 * "project_admin on this project" wants `'admin'` here and gets an identical permission set.
 */
export async function grantProjectAccess(
  app: INestApplication,
  userId: string,
  projectId: string,
  accessLevel: ProjectAccessLevel,
): Promise<void> {
  const access = app.get(AccessService);
  await access.grantProjectAccess({
    workspaceId: WORKSPACE_ID,
    projectId,
    userId,
    accessLevel,
    actorId: ADMIN_USER_ID,
    onWorkspaceAdmin: 'refuse',
  });
}

/**
 * Unique, uppercase project/team key (≤10 chars — the DB column is
 * `varchar(10)`) so repeated runs against the same seeded DB never collide with
 * a `*_KEY_TAKEN` conflict.
 *
 * The previous implementation was `Date.now().toString(36).slice(-5)` plus a
 * two-digit random, and did NOT hold that promise:
 *   - only 100 random values, so two keys minted in the same millisecond
 *     collided 1 in 100
 *   - the last 5 base36 chars of a ms timestamp wrap every 36^5 ms (~16.8 h),
 *     so the time component REPEATS
 * E2E rows are never cleaned up, so collision pressure grew with every run.
 * It surfaced as an unrelated-looking failure — a project insert dying on
 * uq_projects_workspace_key deep inside a notification test.
 *
 * Now 9 random hex chars after the prefix letter: 16^9 ≈ 6.9e10 values, no time
 * component to wrap. Key format is `^[A-Za-z][A-Za-z0-9]*$`, so hex is valid,
 * and 1 + 9 = 10 exactly fills varchar(10).
 */
export function uniqueKey(prefix = 'E'): string {
  const rand = randomUUID().replace(/-/g, '').slice(0, 9).toUpperCase();
  return `${prefix}${rand}`;
}

/**
 * The TWO seeded projects and their contents, for tests that need fixtures rather than to build them.
 *
 * Re-exported from `db/seeds/constants.ts` so there is one source: a test that hard-codes a UUID
 * drifts the moment the seed moves, and a test that CREATES its own project leaks it — the suite used
 * to call `createProject` 84 times per run with no teardown anywhere, which twice pushed
 * `portfolio_items.rank` into its `varchar(255)` ceiling and stopped the suite dead.
 *
 * Use `SEEDED.nxp` when the test needs depth (three iterations, two releases, an Epic with seven
 * Features, a draft AND a published capacity plan, frozen report history, SCM links, attachments).
 * Use `SEEDED.pay` when it needs a SECOND project — isolation, permission scoping, cross-project
 * refusals, "that release belongs to another project". Create your own only when the test is about
 * creation itself, and then clean it up.
 */
export const SEEDED = {
  nxp: {
    projectId: SEED_PROJECTS[0].id,
    key: SEED_PROJECTS[0].key,
    teamAlphaId: TEAM_ALPHA_ID,
    teamBetaId: TEAM_BETA_ID,
    iterationCurrentId: NXP_ITER_CURRENT_ID,
    iterationPastId: NXP_ITER_PAST_ID,
    iterationFutureId: NXP_ITER_FUTURE_ID,
    releaseId: NXP_RELEASE_1_ID,
    secondReleaseId: NXP_RELEASE_2_ID,
    epicId: NXP_EPIC_1_ID,
    featureId: NXP_FEATURE_1_ID,
    storyId: NXP_STORY_1_ID,
    defectId: NXP_DEFECT_1_ID,
    /** DRAFT — safe to mutate. */
    capacityPlanId: NXP_CAPACITY_PLAN_ID,
    /** PUBLISHED — read-only until reverted, which is the point of having both. */
    publishedCapacityPlanId: NXP_CAPACITY_PLAN_2_ID,
  },
  pay: {
    projectId: PAY_PROJECT_ID,
    key: 'PAY',
    teamId: TEAM_GAMMA_ID,
    iterationId: PAY_ITER_ID,
    releaseId: PAY_RELEASE_ID,
    milestoneId: PAY_MILESTONE_ID,
    epicId: PAY_EPIC_ID,
    featureId: PAY_FEATURE_ID,
    storyId: PAY_STORY_ID,
    defectId: PAY_DEFECT_ID,
    capacityPlanId: PAY_CAPACITY_PLAN_ID,
  },
} as const;

/** Paging args that fetch everything a small test project produces. */
export const ALL = { limit: 200, cursor: null } as const;
