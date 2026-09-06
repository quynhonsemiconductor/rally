import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, PreconditionFailedException } from '@platform';
import { ReleasesService } from './releases.service';
import { RELEASE_REPOSITORY } from '../domain/ports/release.repository';
import { ProjectsService } from '@modules/projects';
import { AccessService } from '@modules/access';
import { ActivityLogger } from '@modules/activity';
import { DRIZZLE } from '@platform';

const activityMock = () => ({
  build: vi.fn(() => ({})),
  buildDiff: vi.fn(() => []),
  log: vi.fn(async () => undefined),
  logSafe: vi.fn(async () => undefined),
  listFor: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 50 })),
});
import type { Release } from '../domain/release.types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = new Date('2024-06-01');

const actor = {
  sub: 'user-1',
  workspaceId: 'ws-1',
  contextId: 'ws-1',
  sessionId: 's1',
  jti: 'j1',
  iat: 0,
  exp: 0,
  iss: 'rova',
  aud: 'rova-app',
  permissions: [] as string[],
  claims: { permissions: [] as string[] },
  authMethod: 'password' as const,
};

const mockRelease = (o: Partial<Release> = {}): Release => ({
  id: 'rel-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  releaseKey: 'RE-1',
  name: 'v1.0',
  description: 'First release',
  theme: null,
  notes: null,
  status: 'planning',
  startDate: '2024-06-01',
  releaseDate: '2024-07-01',
  targetDate: null,
  plannedVelocity: null,
  planEstimate: null,
  version: null,
  releasedAt: null,
  releaseNotes: null,
  createdAt: now,
  updatedAt: now,
  ...o,
});

const emptyPage = {
  data: [],
  pageInfo: { nextCursor: null, hasNextPage: false, limit: 25 },
};

// ── Mock factories ────────────────────────────────────────────────────────────

const makeRepo = () => ({
  findById: vi.fn(),
  listByProject: vi.fn().mockResolvedValue(emptyPage),
  create: vi.fn().mockImplementation((input) => Promise.resolve(mockRelease(input))),
  update: vi.fn().mockImplementation((id, patch) => Promise.resolve(mockRelease({ id, ...patch }))),
  delete: vi.fn().mockResolvedValue(undefined),
  nextKeyNumber: vi.fn().mockResolvedValue(1),
});

const makeProjects = () => ({
  getProject: vi.fn().mockResolvedValue({ id: 'proj-1' }),
  assertProjectWritable: vi.fn().mockResolvedValue(undefined),
});

const makeAccess = () => ({
  assertProjectPermission: vi.fn().mockResolvedValue(undefined),
});

/**
 * A fully chainable, awaitable `select()` stub for the two-branch Artifacts query.
 *
 * The generic chain in `beforeEach` makes `.limit()` its own terminal (the capacity-plan lookup), and
 * it knows nothing of `leftJoin`/`orderBy`. The artifact branches end
 * `.leftJoin().where().orderBy().limit()`, so they need a chain where every link returns the chain and
 * the whole thing resolves to one supplied result.
 */
const makeArtifactChain = (result: unknown) => {
  const chain: Record<string, unknown> = {};
  for (const key of ['from', 'innerJoin', 'leftJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
    chain[key] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (resolve: (v: unknown) => void) => resolve(result);
  return chain;
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ReleasesService', () => {
  /** Rows the stubbed capacity-plan lookup returns — see the delete guard. */
  let capacityPlanRows: { planKey: string; name: string }[];
  /** Rows every stubbed grouped roll-up query returns — see the roll-up shape specs. */
  let statRows: Record<string, unknown>[];
  let service: ReleasesService;
  let repo: ReturnType<typeof makeRepo>;
  let projects: ReturnType<typeof makeProjects>;
  let access: ReturnType<typeof makeAccess>;
  /** The stubbed drizzle handle, so a spec can pin one query's result per call. */
  let db: { select: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    repo = makeRepo();
    projects = makeProjects();
    access = makeAccess();

    statRows = [
      {
        // The roll-up queries read releaseId plus the hour sums / accepted count; a null
        // releaseId means the row is skipped, so the roll-up resolves to EMPTY_TASK_ROLLUP
        // and taskEstimate to 0 in these unit tests.
        releaseId: null,
        estimateHours: '0',
        toDoHours: '0',
        actualHours: '0',
        acceptedItems: 0,
      },
    ];
    // Capacity plans built on the release under test. Empty by default: most specs are not about the
    // delete guard, and a release with no plan is the ordinary case.
    capacityPlanRows = [];
    // Root is deliberately NOT thenable (Nest DI awaits thenable useValue
    // providers). Only the chain returned by select() is awaitable, and it
    // supports both the stats query (.where terminal) and the estimate roll-up
    // (.where().groupBy() terminal).
    const makeChain = () => {
      const chain: Record<string, unknown> = {};
      for (const key of ['from', 'innerJoin', 'where', 'groupBy']) {
        chain[key] = vi.fn().mockReturnValue(chain);
      }
      // `.limit()` is its OWN terminal, resolving to `capacityPlanRows`: the delete path asks whether a
      // capacity plan is built on the release, and that question needs a different answer from the
      // stats queries above — which is why it cannot share the generic `statRows` result.
      chain.limit = vi.fn(() => ({
        then: (resolve: (v: unknown) => void) => resolve(capacityPlanRows),
      }));
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(statRows);
      return chain;
    };
    db = { select: vi.fn(() => makeChain()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReleasesService,
        { provide: RELEASE_REPOSITORY, useValue: repo },
        { provide: DRIZZLE, useValue: db },
        { provide: ProjectsService, useValue: projects },
        { provide: AccessService, useValue: access },
        { provide: ActivityLogger, useValue: activityMock() },
      ],
    }).compile();

    service = module.get(ReleasesService);
  });

  // ── listReleases ──────────────────────────────────────────────────────────

  describe('listReleases', () => {
    it('validates project access before listing', async () => {
      await service.listReleases(actor, 'proj-1', { limit: 25, cursor: null });
      expect(projects.getProject).toHaveBeenCalledWith('ws-1', 'proj-1');
    });

    it('propagates project-not-found', async () => {
      projects.getProject.mockRejectedValue(new Error('PROJECT_NOT_FOUND'));
      await expect(service.listReleases(actor, 'bad', { limit: 25, cursor: null })).rejects.toThrow(
        'PROJECT_NOT_FOUND',
      );
    });
  });

  // ── listReleaseArtifacts ──────────────────────────────────────────────────
  //
  // `GAP-P3-REL-002`: a release's artifacts come from TWO tables. `work_items.release_id` is the
  // Story/Defect half and `portfolio_items.release_id` is the Feature half — the column the Portfolio
  // Feature detail writes, present in the schema since the Feature gained a Release field, and never
  // read here. So a Feature assigned to a release showed the release on the Feature, survived a
  // reload, and the release's Artifacts tab reported `0 items`. The seed has had `FE-1 → RE-1` all
  // along, so every environment displayed the fault.

  describe('listReleaseArtifacts', () => {
    const story = {
      id: 'wi-1',
      itemKey: 'US-11',
      type: 'story',
      title: 'Guest checkout',
      scheduleState: 'in_progress',
      priority: 'high',
      assigneeId: 'user-1',
      assigneeName: 'Dev One',
      iterationId: 'it-1',
      releaseId: 'rel-1',
      storyPoints: 5,
      createdAt: now,
      updatedAt: now,
    };
    /** A Feature carries no Schedule State, no priority column and no leaf Plan Estimate. */
    const feature = {
      id: 'pi-1',
      itemKey: 'FE-6',
      type: 'feature',
      title: 'Checkout revamp',
      scheduleState: '',
      priority: '',
      assigneeId: 'user-2',
      assigneeName: 'Owner Two',
      iterationId: null,
      releaseId: 'rel-1',
      storyPoints: null,
      createdAt: now,
      updatedAt: now,
    };

    beforeEach(() => {
      repo.findById.mockResolvedValue(mockRelease());
    });

    it('serves the Story/Defect and the Feature in one page, with the summed total', async () => {
      // FOUR selects, in the order the `Promise.all` array evaluates: the work-item page, the
      // portfolio page, then a COUNT for each branch.
      db.select
        .mockReturnValueOnce(makeArtifactChain([{ ...story, sortKey: '20260101000000000001' }]))
        .mockReturnValueOnce(makeArtifactChain([{ ...feature, sortKey: '20260101000000000002' }]))
        .mockReturnValueOnce(makeArtifactChain([{ total: 1 }]))
        .mockReturnValueOnce(makeArtifactChain([{ total: 1 }]));

      const page = await service.listReleaseArtifacts(actor, 'rel-1', { limit: 25, cursor: null });

      // Merged newest-first on the exact MICROSECOND key — both fixtures share one `now`, so a
      // millisecond comparison would tie and fall through to the id instead. The key itself never
      // reaches the response.
      expect(page.data).toEqual([feature, story]);
      // Summed, because the two branches are disjoint by construction: two tables, two id spaces.
      expect(page.pageInfo.total).toBe(2);
      expect(page.pageInfo.hasNextPage).toBe(false);
    });

    it('pages the UNION, not each branch — `limit + 1` per branch, `limit` of the merge', async () => {
      // Three work items and one Feature against a limit of 2. A per-branch limit would have served
      // both branches' first rows; the merge must serve the two newest of the union and report a next
      // page. `limit + 1` per branch is what makes that exact.
      db.select
        .mockReturnValueOnce(
          makeArtifactChain([
            { ...story, id: 'wi-3', sortKey: '20260101000000000003' },
            { ...story, id: 'wi-2', sortKey: '20260101000000000002' },
            { ...story, id: 'wi-1', sortKey: '20260101000000000001' },
          ]),
        )
        .mockReturnValueOnce(makeArtifactChain([{ ...feature, sortKey: '20260101000000000004' }]))
        .mockReturnValueOnce(makeArtifactChain([{ total: 3 }]))
        .mockReturnValueOnce(makeArtifactChain([{ total: 1 }]));

      const page = await service.listReleaseArtifacts(actor, 'rel-1', { limit: 2, cursor: null });

      expect(page.data.map((r) => r.id)).toEqual(['pi-1', 'wi-3']);
      expect(page.pageInfo.hasNextPage).toBe(true);
      expect(page.pageInfo.total).toBe(4);
    });

    it('loads the release first, so an unknown id is a 404 and not an empty page', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.listReleaseArtifacts(actor, 'bad', { limit: 25, cursor: null }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── createRelease ─────────────────────────────────────────────────────────

  describe('createRelease', () => {
    it('creates with default planning status when none provided', async () => {
      const result = await service.createRelease(actor, 'proj-1', 'v2.0');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'planning' }));
      expect(result.status).toBe('planning');
    });

    it('uses provided status when given', async () => {
      await service.createRelease(actor, 'proj-1', 'v2.0', { state: 'active' });
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
    });

    it('rejects releaseDate before startDate', async () => {
      await expect(
        service.createRelease(actor, 'proj-1', 'v2.0', {
          startDate: '2024-07-01',
          releaseDate: '2024-06-01',
        }),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('allows releaseDate equal to startDate', async () => {
      await service.createRelease(actor, 'proj-1', 'v2.0', {
        startDate: '2024-06-01',
        releaseDate: '2024-06-01',
      });
      expect(repo.create).toHaveBeenCalled();
    });

    it('allows creation with only startDate (no releaseDate)', async () => {
      await service.createRelease(actor, 'proj-1', 'v2.0', {
        startDate: '2024-06-01',
      });
      expect(repo.create).toHaveBeenCalled();
    });

    it('validates project exists before creating', async () => {
      projects.assertProjectWritable.mockRejectedValue(new Error('PROJECT_NOT_FOUND'));
      await expect(service.createRelease(actor, 'bad', 'v2.0')).rejects.toThrow(
        'PROJECT_NOT_FOUND',
      );
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  // ── getRelease ───────────────────────────────────────────────────────────

  describe('getRelease', () => {
    it('returns release when found in same workspace', async () => {
      repo.findById.mockResolvedValue(mockRelease());
      const result = await service.getRelease('ws-1', 'rel-1');
      expect(result.id).toBe('rel-1');
    });

    it('throws when release not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.getRelease('ws-1', 'bad')).rejects.toThrow(NotFoundException);
    });

    it('throws when release belongs to different workspace', async () => {
      repo.findById.mockResolvedValue(mockRelease({ workspaceId: 'other-ws' }));
      await expect(service.getRelease('ws-1', 'rel-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateRelease ────────────────────────────────────────────────────────

  describe('updateRelease', () => {
    // Authorization (release:edit) moved to the PolicyGuard at the route (P2);
    // the guard denies before the service runs, so it is covered by the e2e
    // suite, not a service-level assert here.

    it('rejects releaseDate before startDate on update', async () => {
      repo.findById.mockResolvedValue(mockRelease());
      await expect(
        service.updateRelease(actor, 'rel-1', {
          startDate: '2024-07-01',
          releaseDate: '2024-06-01',
        }),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('throws NotFoundException when release not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.updateRelease(actor, 'bad', { name: 'X' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── deleteRelease ────────────────────────────────────────────────────────

  describe('deleteRelease', () => {
    it('refuses to delete a release that a capacity plan is built on, and NAMES the plan', async () => {
      // Migration 0085 makes this a foreign key; the check is what turns the constraint into an
      // answer. Before either existed the delete succeeded and left the plan pointing at a missing
      // row — Release badge blank, and publish permanently unable to write the Release field because
      // the plan's release is immutable by design.
      repo.findById.mockResolvedValue(mockRelease({ status: 'planning' }));
      capacityPlanRows = [{ planKey: 'CP-3', name: 'Q3 capacity' }];
      await expect(service.deleteRelease(actor, 'rel-1')).rejects.toMatchObject({
        code: 'RELEASE_HAS_CAPACITY_PLAN',
      });
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('deletes a planning release', async () => {
      repo.findById.mockResolvedValue(mockRelease({ status: 'planning' }));
      await service.deleteRelease(actor, 'rel-1');
      expect(repo.delete).toHaveBeenCalledWith('rel-1');
    });

    it('deletes an active release', async () => {
      repo.findById.mockResolvedValue(mockRelease({ status: 'active' }));
      await service.deleteRelease(actor, 'rel-1');
      expect(repo.delete).toHaveBeenCalledWith('rel-1');
    });

    it('rejects deleting an accepted release (P3-REL-DC-012)', async () => {
      repo.findById.mockResolvedValue(mockRelease({ status: 'accepted' }));
      await expect(service.deleteRelease(actor, 'rel-1')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(repo.delete).not.toHaveBeenCalled();
    });
    // Authorization (release:delete) is enforced by the PolicyGuard at the route
    // (P2), covered by the e2e suite — no service-level assert.
  });

  // ── getReleaseDetail ─────────────────────────────────────────────────────

  describe('getReleaseDetail', () => {
    it('returns the release when found', async () => {
      repo.findById.mockResolvedValue(mockRelease());
      const result = await service.getReleaseDetail(actor, 'rel-1');
      expect(result.id).toBe('rel-1');
    });

    it('throws when release not found', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.getReleaseDetail(actor, 'bad')).rejects.toThrow(NotFoundException);
    });
    // release:view is enforced by the PolicyGuard at the route (P2), resource-
    // resolved from :id — covered by context-isolation-rbac e2e, not here.

    /**
     * The roll-up is Estimate / To Do / Actual HOURS from the assigned tasks, plus the accepted
     * count — the BA's own §7.4 Release Detail DTO, which is why the API still serves it. It used
     * to be an item/point roll-up carrying a `progressPercent`, which P3-REL-FR-037 forbids on a
     * Phase 3 release surface and §7.5 defers to `Portfolio > Release Tracking`; those fields must
     * stay uncomputed, because a number nobody measures cannot be re-added by a UI edit.
     *
     * The DISPLAY rule is a different contract and lives in the SPA: FR-023/FR-024/AC #10 make the
     * Release Detail right panel metadata only, so `releases-detail-page.test.tsx` asserts that a
     * payload carrying these very values renders none of them (`GAP-P3-REL-001`, BA retest
     * 2026-08-17).
     */
    it('rolls up task HOURS and the accepted total, and computes no progress percentage', async () => {
      repo.findById.mockResolvedValue(mockRelease());
      // Drizzle hands numeric columns back as strings — the sums must survive that.
      statRows = [
        {
          releaseId: 'rel-1',
          estimateHours: '18.5',
          toDoHours: '6',
          actualHours: '12.5',
          acceptedItems: 3,
        },
      ];

      const { taskRollup, taskEstimate } = await service.getReleaseDetail(actor, 'rel-1');

      expect(taskRollup).toEqual({
        estimateHours: 18.5,
        toDoHours: 6,
        actualHours: 12.5,
        acceptedItems: 3,
      });
      // The list's Task Est. column is the roll-up's Estimate, computed once.
      expect(taskEstimate).toBe(18.5);
      for (const forbidden of [
        'progressPercent',
        'totalPoints',
        'completedPoints',
        'toDoPoints',
        'totalItems',
        'completedItems',
        'toDoItems',
      ]) {
        expect(taskRollup).not.toHaveProperty(forbidden);
      }
    });
  });
});
