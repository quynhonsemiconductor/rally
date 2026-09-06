import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { AccessService } from '@modules/access';
import { ProjectsService } from './projects.service';
import { PROJECT_REPOSITORY } from '../domain/ports/project.repository';
import { WORKFLOW_STATUS_REPOSITORY } from '../domain/ports/workflow-status.repository';
import { LABEL_REPOSITORY } from '../domain/ports/label.repository';
import { PROJECT_TEAM_REPOSITORY } from '../domain/ports/project-team.repository';
import { PROJECT_MEMBER_REPOSITORY } from '../domain/ports/project-member.repository';
import { WORKSPACE_MEMBER_REPOSITORY, TeamService } from '@modules/workspace';
import { ActivityLogger } from '@modules/activity';
import type { Project, WorkflowStatus } from '../domain/project.types';

const activityMock = () => ({
  build: vi.fn(() => ({})),
  buildDiff: vi.fn(() => []),
  log: vi.fn(async () => undefined),
  logSafe: vi.fn(async () => undefined),
  listFor: vi.fn(async () => ({ data: [], total: 0, page: 1, pageSize: 50 })),
});
import {
  NotFoundException,
  ConflictException,
  PreconditionFailedException,
  UnitOfWork,
  AuditProducer,
  DRIZZLE,
} from '@platform';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = new Date('2024-06-01');

const mockProject = (o: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  workspaceId: 'ws-1',
  key: 'PROJ',
  name: 'Test Project',
  description: null,
  leadId: null,
  startDate: null,
  endDate: null,
  status: 'active',
  settings: {},
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  ...o,
});

const mockStatus = (o: Partial<WorkflowStatus> = {}): WorkflowStatus => ({
  id: 'status-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  name: 'To Do',
  category: 'to_do',
  color: '#6B7280',
  position: 0,
  isDefault: true,
  createdAt: now,
  ...o,
});

const mockActor = {
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

// ── Mock factories ────────────────────────────────────────────────────────────

const makeProjectRepo = () => ({
  findById: vi.fn(),
  findByKey: vi.fn().mockResolvedValue(null),
  listByWorkspace: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn().mockResolvedValue(undefined),
  initCounter: vi.fn().mockResolvedValue(undefined),
  incrementCounter: vi.fn().mockResolvedValue(1),
  getMaxItemNumber: vi.fn().mockResolvedValue(0),
});

const makeStatusRepo = () => ({
  findById: vi.fn(),
  listByProject: vi.fn().mockResolvedValue([]),
  listTransitions: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
  updatePositions: vi.fn().mockResolvedValue(undefined),
  canTransition: vi.fn().mockResolvedValue(true),
  createTransition: vi.fn(),
  deleteTransition: vi.fn().mockResolvedValue(undefined),
});

const makeLabelRepo = () => ({
  findById: vi.fn(),
  listByProject: vi.fn().mockResolvedValue([]),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
});

const makeProjectTeamRepo = () => ({
  findLink: vi.fn().mockResolvedValue(null),
  listByProject: vi.fn().mockResolvedValue([]),
  linkTeam: vi.fn().mockResolvedValue(undefined),
  unlinkTeam: vi.fn().mockResolvedValue(undefined),
});

const makeProjectMemberRepo = () => ({
  listByProject: vi.fn().mockResolvedValue([]),
  // §2.1 — no Workspace Admin by default; the RBE-03 tests set this.
  listWorkspaceAdminUserIds: vi.fn().mockResolvedValue([]),
  // The synthesized Workspace Admin rows on the project roster (BA report 2026-08-21). Empty by
  // default so every other case still measures real members only.
  listWorkspaceAdminProfiles: vi.fn().mockResolvedValue([]),
  findMember: vi.fn().mockResolvedValue(null),
  findMemberById: vi.fn().mockResolvedValue(null),
  updateMember: vi.fn().mockResolvedValue(undefined),
  removeMember: vi.fn().mockResolvedValue(undefined),
});

/**
 * `listProjects` asks which projects the caller may read: `null` = UNRESTRICTED, which keeps these
 * specs' expectations about the unfiltered page intact; the restriction itself is covered
 * end-to-end in `test/e2e/read-scoping.e2e.spec.ts`.
 *
 * `grantProjectAccess` is the ONE per-Project grant writer, and `addProjectMember` is a thin
 * delegate to it — so what this spec can prove is the DELEGATION and its arguments. The rules the
 * body used to hold moved to `access.service.spec.ts` with the body.
 */
const makeAccessService = () => ({
  listReadableProjectIds: vi.fn().mockResolvedValue(null),
  invalidateUser: vi.fn().mockResolvedValue(undefined),
  // Archive/restore is WA-only; these specs run as one.
  hasPermission: vi.fn().mockResolvedValue(true),
  getProjectAccessLevel: vi.fn().mockResolvedValue(null),
  grantProjectAccess: vi
    .fn()
    .mockResolvedValue({ id: 'pm-1', userId: 'user-2', accessLevel: 'editor' }),
});

const makeWorkspaceMemberRepo = () => ({
  findMember: vi.fn().mockResolvedValue({ userId: 'user-1', status: 'active' }),
  listMembers: vi.fn().mockResolvedValue([]),
  addMember: vi.fn().mockResolvedValue(undefined),
  updateMember: vi.fn().mockResolvedValue(undefined),
  removeMember: vi.fn().mockResolvedValue(undefined),
});

// Execute the wrapped work immediately with a stub transaction so repository
// mocks receive a tx argument exactly as they would in production.
const makeUow = () => {
  // `updateEstimationSettings` writes via `tx.insert(projectSettings).values().onConflictDoUpdate()`;
  // the default `{}` tx made `tx.insert` undefined. Expose `tx` so a test can assert the upsert ran.
  // `createProject` also upserts work.project_settings, and the row it writes is the point of
  // the PRJ-06 fix — so the values are captured, not discarded.
  const inserted: Array<Record<string, unknown>> = [];
  const tx = {
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { onConflictDoUpdate: () => Promise.resolve(undefined) };
      },
    })),
  };
  return { run: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)), tx, inserted };
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ProjectsService', () => {
  let service: ProjectsService;
  let projectRepo: ReturnType<typeof makeProjectRepo>;
  let statusRepo: ReturnType<typeof makeStatusRepo>;
  let labelRepo: ReturnType<typeof makeLabelRepo>;
  let projectTeamRepo: ReturnType<typeof makeProjectTeamRepo>;
  let projectMemberRepo: ReturnType<typeof makeProjectMemberRepo>;
  let workspaceMemberRepo: ReturnType<typeof makeWorkspaceMemberRepo>;
  let teamService: {
    listTeams: ReturnType<typeof vi.fn>;
    listTeamMembers: ReturnType<typeof vi.fn>;
    listUserTeamIds: ReturnType<typeof vi.fn>;
    applyTeamMembershipDiff: ReturnType<typeof vi.fn>;
  };
  let uow: ReturnType<typeof makeUow>;
  /** Capacity plans that BLOCK an unlink. Empty unless a test is about that refusal. */
  let capacityPlanRows: Array<{ planKey: string; name: string }>;
  /** work.project_settings rows for the estimation-settings read. Empty by default → fallback. */
  let estimationRows: unknown[];
  let audit: { emit: ReturnType<typeof vi.fn> };
  let access: ReturnType<typeof makeAccessService>;

  beforeEach(async () => {
    capacityPlanRows = [];
    estimationRows = [];
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    projectRepo = makeProjectRepo();
    statusRepo = makeStatusRepo();
    labelRepo = makeLabelRepo();
    projectTeamRepo = makeProjectTeamRepo();
    projectMemberRepo = makeProjectMemberRepo();
    workspaceMemberRepo = makeWorkspaceMemberRepo();
    teamService = {
      listTeams: vi.fn().mockResolvedValue([]),
      // The selected Team's roster — the narrowed half of the assignee feed (GAP-P1-WID-007).
      listTeamMembers: vi.fn().mockResolvedValue([]),
      // The user holds NO team by default — the state PRJ-08 refuses for an Editor, so every test
      // that wants the level accepted has to say which teams it is standing on.
      listUserTeamIds: vi.fn().mockResolvedValue([]),
      applyTeamMembershipDiff: vi.fn().mockResolvedValue(undefined),
    };
    access = makeAccessService();
    uow = makeUow();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProjectsService,
        { provide: PROJECT_REPOSITORY, useValue: projectRepo },
        { provide: WORKFLOW_STATUS_REPOSITORY, useValue: statusRepo },
        { provide: LABEL_REPOSITORY, useValue: labelRepo },
        { provide: PROJECT_TEAM_REPOSITORY, useValue: projectTeamRepo },
        { provide: PROJECT_MEMBER_REPOSITORY, useValue: projectMemberRepo },
        { provide: WORKSPACE_MEMBER_REPOSITORY, useValue: workspaceMemberRepo },
        { provide: TeamService, useValue: teamService },
        { provide: UnitOfWork, useValue: uow },
        { provide: AuditProducer, useValue: audit },
        { provide: ActivityLogger, useValue: activityMock() },
        { provide: AccessService, useValue: access },
        {
          provide: DRIZZLE,
          /**
           * One chain: `unlinkTeam`'s capacity-plan guard
           * (`select→from→innerJoin→where→orderBy→limit`). Empty by default — a team on no plan is
           * the ordinary case — and a test that wants the unlink refused sets `capacityPlanRows`.
           */
          useValue: {
            select: () => ({
              from: () => ({
                innerJoin: () => ({
                  where: () => ({
                    orderBy: () => ({ limit: () => Promise.resolve(capacityPlanRows) }),
                  }),
                }),
                // estimation-settings read chain: select().from().where().limit()
                where: () => ({ limit: () => Promise.resolve(estimationRows) }),
              }),
            }),
          },
        },
      ],
    }).compile();

    service = module.get(ProjectsService);
  });

  // ── createProject ─────────────────────────────────────────────────────────

  describe('createProject', () => {
    it('creates project and seeds default workflow statuses', async () => {
      projectRepo.create.mockResolvedValue(mockProject());
      statusRepo.create.mockResolvedValue(mockStatus());

      const result = await service.createProject(mockActor, { key: 'proj', name: 'Test Project' });

      expect(result.key).toBe('PROJ');
      expect(projectRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'PROJ', name: 'Test Project' }),
        expect.anything(),
      );
      // 4 default statuses + 1 counter init
      expect(statusRepo.create).toHaveBeenCalledTimes(4);
    });

    /**
     * PRJ-06. §4.2 makes the estimate scale a Create Project field; it used to arrive through a
     * second, best-effort PATCH the SPA skipped whenever the values equalled the defaults, so the
     * common path created a project with NO `work.project_settings` row at all.
     */
    it('writes the caller-supplied estimation settings inside the create transaction', async () => {
      projectRepo.create.mockResolvedValue(mockProject());
      statusRepo.create.mockResolvedValue(mockStatus());

      await service.createProject(mockActor, {
        key: 'proj',
        name: 'Test Project',
        estimationSettings: {
          xsPoints: 2,
          sPoints: 4,
          mPoints: 6,
          lPoints: 10,
          xlPoints: 20,
          hoursPerPoint: 6.5,
        },
      });

      // The SAME tx the project, counter, statuses and team links were written in.
      expect(uow.inserted).toEqual([
        expect.objectContaining({
          workspaceId: 'ws-1',
          xsPoints: 2,
          sPoints: 4,
          mPoints: 6,
          lPoints: 10,
          xlPoints: 20,
          // numeric(8,2) is written as a string.
          hoursPerPoint: '6.5',
        }),
      ]);
    });

    it('writes the DEFAULT scale when the caller supplies none — the ROW is never optional', async () => {
      projectRepo.create.mockResolvedValue(mockProject());
      statusRepo.create.mockResolvedValue(mockStatus());

      await service.createProject(mockActor, { key: 'proj', name: 'Test Project' });

      // Every project has a settings row; only the OVERRIDE is optional. Defaults mirror
      // migration 0106's column DEFAULTs and DEFAULT_PRELIMINARY_ESTIMATE_MAP.
      expect(uow.inserted).toEqual([
        expect.objectContaining({
          xsPoints: 1,
          sPoints: 3,
          mPoints: 5,
          lPoints: 8,
          xlPoints: 13,
          hoursPerPoint: '8',
        }),
      ]);
    });

    it('normalises project key to uppercase', async () => {
      projectRepo.create.mockResolvedValue(mockProject({ key: 'MYKEY' }));
      statusRepo.create.mockResolvedValue(mockStatus());

      await service.createProject(mockActor, { key: 'mykey', name: 'My Project' });

      expect(projectRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'MYKEY' }),
        expect.anything(),
      );
    });

    it('throws ConflictException when key is already taken', async () => {
      projectRepo.findByKey.mockResolvedValue(mockProject());

      await expect(
        service.createProject(mockActor, { key: 'PROJ', name: 'Duplicate' }),
      ).rejects.toThrow(ConflictException);
    });

    it('persists startDate and links the requested teams inside the transaction', async () => {
      projectRepo.create.mockResolvedValue(mockProject());
      statusRepo.create.mockResolvedValue(mockStatus());
      teamService.listTeams.mockResolvedValue([{ id: 'team-1' }, { id: 'team-2' }]);

      await service.createProject(mockActor, {
        key: 'proj',
        name: 'Test Project',
        startDate: '2026-01-01',
        teamIds: ['team-1', 'team-2', 'team-1'], // duplicate must be deduped
      });

      expect(projectRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2026-01-01' }),
        expect.anything(),
      );
      // Deduped to two links, each carrying the tx argument
      expect(projectTeamRepo.linkTeam).toHaveBeenCalledTimes(2);
      expect(projectTeamRepo.linkTeam).toHaveBeenCalledWith(
        expect.any(String),
        mockActor.workspaceId,
        expect.any(String),
        'team-1',
        expect.anything(),
      );
    });

    it('rejects teams that do not belong to the workspace', async () => {
      projectRepo.create.mockResolvedValue(mockProject());
      teamService.listTeams.mockResolvedValue([{ id: 'team-1' }]);

      await expect(
        service.createProject(mockActor, {
          key: 'proj',
          name: 'Test Project',
          teamIds: ['team-1', 'team-unknown'],
        }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(projectTeamRepo.linkTeam).not.toHaveBeenCalled();
    });

    it('rejects an end date before the start date', async () => {
      await expect(
        service.createProject(mockActor, {
          key: 'proj',
          name: 'Test Project',
          startDate: '2026-09-30',
          endDate: '2026-07-01',
        }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(projectRepo.create).not.toHaveBeenCalled();
    });

    it('persists endDate when the range is valid', async () => {
      projectRepo.create.mockResolvedValue(mockProject({ endDate: '2026-09-30' }));
      statusRepo.create.mockResolvedValue(mockStatus());

      await service.createProject(mockActor, {
        key: 'proj',
        name: 'Test Project',
        startDate: '2026-07-01',
        endDate: '2026-09-30',
      });

      expect(projectRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2026-07-01', endDate: '2026-09-30' }),
        expect.anything(),
      );
    });
  });

  // ── linkTeam ──────────────────────────────────────────────────────────────

  describe('linkTeam', () => {
    it('rejects a team that does not belong to the workspace', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      teamService.listTeams.mockResolvedValue([{ id: 'team-1' }]);
      await expect(service.linkTeam('ws-1', 'proj-1', 'team-foreign')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(projectTeamRepo.linkTeam).not.toHaveBeenCalled();
    });

    it('links a team that belongs to the workspace', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      teamService.listTeams.mockResolvedValue([{ id: 'team-1' }]);
      projectTeamRepo.findLink.mockResolvedValue(null);
      projectTeamRepo.linkTeam.mockResolvedValue({ id: 'link-1', teamId: 'team-1' });
      await service.linkTeam('ws-1', 'proj-1', 'team-1');
      expect(projectTeamRepo.linkTeam).toHaveBeenCalled();
    });
  });

  describe('unlinkTeam', () => {
    it("REFUSES while the team is on one of this project's capacity plans", async () => {
      /**
       * `project_teams` is a soft status flip, so `fk_capacity_plan_teams_team ON DELETE RESTRICT`
       * never fires: nothing stopped an unlink from leaving the team's plan row and its allocations
       * behind, which is exactly the state migration 0085 had to clean up. Releases already refuse
       * deletion for a dependent plan; this is the same rule for the other reference.
       */
      projectRepo.findById.mockResolvedValue(mockProject());
      projectTeamRepo.findLink.mockResolvedValue({ id: 'link-1', teamId: 'team-1' });
      capacityPlanRows = [{ planKey: 'CP-2', name: 'Q3 capacity' }];

      await expect(service.unlinkTeam('ws-1', 'proj-1', 'team-1')).rejects.toMatchObject({
        code: 'PROJECT_TEAM_HAS_CAPACITY_PLAN',
      });
      expect(projectTeamRepo.unlinkTeam).not.toHaveBeenCalled();
    });

    it('names the plan, because "remove it from the plan" needs a plan', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      projectTeamRepo.findLink.mockResolvedValue({ id: 'link-1', teamId: 'team-1' });
      capacityPlanRows = [{ planKey: 'CP-2', name: 'Q3 capacity' }];

      await expect(service.unlinkTeam('ws-1', 'proj-1', 'team-1')).rejects.toThrow(
        /CP-2 \(Q3 capacity\)/,
      );
    });

    it('unlinks a team that is on no plan', async () => {
      // The ordinary case, asserted so the guard cannot quietly become a blanket refusal.
      projectRepo.findById.mockResolvedValue(mockProject());
      projectTeamRepo.findLink.mockResolvedValue({ id: 'link-1', teamId: 'team-1' });

      await service.unlinkTeam('ws-1', 'proj-1', 'team-1');
      expect(projectTeamRepo.unlinkTeam).toHaveBeenCalledWith('proj-1', 'team-1');
    });
  });

  // ── assertTeamLinkedToProject (shared rule) ────────────────────────────────

  describe('assertTeamLinkedToProject', () => {
    it('resolves when the team is actively linked to the project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      projectTeamRepo.listByProject.mockResolvedValue([{ teamId: 'team-1', status: 'active' }]);
      await expect(
        service.assertTeamLinkedToProject('ws-1', 'proj-1', 'team-1'),
      ).resolves.toBeUndefined();
    });

    it('throws when the team is not linked to the project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      projectTeamRepo.listByProject.mockResolvedValue([]);
      await expect(service.assertTeamLinkedToProject('ws-1', 'proj-1', 'team-1')).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('throws when the link exists but is not active', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      projectTeamRepo.listByProject.mockResolvedValue([{ teamId: 'team-1', status: 'unlinked' }]);
      await expect(service.assertTeamLinkedToProject('ws-1', 'proj-1', 'team-1')).rejects.toThrow(
        PreconditionFailedException,
      );
    });
  });

  // ── setProjectAccess (level + Teams, one write) ──────────────────────────────

  /**
   * The rules this block used to assert — the active-workspace-member check, the §2.1 Workspace
   * Admin refusal, upsert-not-409, both audit events, the cache invalidation — now live in
   * `AccessService.grantProjectAccess`, and so do their tests
   * (`libs/modules/access/src/application/access.service.spec.ts`). They had to move with the body:
   * `AccessService` is a mock here, so a spec on this side can only observe the delegation, and
   * asserting on `projectMemberRepo` after the writer moved would assert on a repository this
   * method no longer touches.
   *
   * What IS this method's own is PRJ-08 — "an Editor must be assigned to at least one active Team"
   * (§2.2, and `mini_rally_usecase_role_mapping.md:81`) — plus the ATOMICITY that makes it
   * enforceable, and the per-journey `onWorkspaceAdmin: 'refuse'` (an admin asked for the grant; the
   * two side-effect journeys skip). All four PRJ-08 cases are here, not just the refusal: a test that
   * only proves the refusal passes just as well when the level has been made unusable.
   */
  describe('setProjectAccess — PRJ-08: an Editor needs a Team', () => {
    // Existence, not writability: both level writes call `getProject` first, and access writes stay
    // open on an ARCHIVED project.
    beforeEach(() => {
      projectRepo.findById.mockResolvedValue(mockProject());
    });

    /** A project WITH a team to assign, which is what makes the rule apply at all. */
    function projectWithTeam() {
      projectTeamRepo.listByProject.mockResolvedValue([{ teamId: 'team-1', status: 'active' }]);
    }

    it('REFUSES an Editor with zero teams', async () => {
      projectWithTeam();

      await expect(
        service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {
          accessLevel: 'editor',
          teamIds: [],
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_EDITOR_REQUIRES_TEAM' });
      // Nothing written: the rule is decided before the transaction opens.
      expect(access.grantProjectAccess).not.toHaveBeenCalled();
      expect(teamService.applyTeamMembershipDiff).not.toHaveBeenCalled();
    });

    it('ACCEPTS an Editor with one team, and writes both halves in ONE transaction', async () => {
      projectWithTeam();

      const result = await service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {
        accessLevel: 'editor',
        teamIds: ['team-1'],
      });

      expect(teamService.applyTeamMembershipDiff).toHaveBeenCalledWith(uow.tx, {
        workspaceId: 'ws-1',
        userId: 'user-2',
        actorId: 'admin',
        add: ['team-1'],
        remove: [],
      });
      expect(access.grantProjectAccess).toHaveBeenCalledWith(
        {
          workspaceId: 'ws-1',
          projectId: 'proj-1',
          userId: 'user-2',
          accessLevel: 'editor',
          actorId: 'admin',
          onWorkspaceAdmin: 'refuse',
        },
        // The SAME transaction the team rows were written in — see the atomicity test below.
        uow.tx,
      );
      expect(access.invalidateUser).toHaveBeenCalledWith('ws-1', 'user-2');
      expect(result.accessLevel).toBe('editor');
    });

    it('ACCEPTS an Editor on a project with NO teams at all', async () => {
      // Decision, stated server-side: otherwise the level is unusable on a new project, and a
      // Workspace Admin would have to invent a Team before granting anyone delivery access.
      projectTeamRepo.listByProject.mockResolvedValue([]);

      await service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {
        accessLevel: 'editor',
      });

      expect(access.grantProjectAccess).toHaveBeenCalledWith(
        expect.objectContaining({ accessLevel: 'editor' }),
        uow.tx,
      );
    });

    it('ACCEPTS an Admin with zero teams — All Teams is the ABSENCE of a scope', async () => {
      projectWithTeam();

      await service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {
        accessLevel: 'admin',
      });

      expect(access.grantProjectAccess).toHaveBeenCalledWith(
        expect.objectContaining({ accessLevel: 'admin' }),
        uow.tx,
      );
    });

    it('leaves an Admin’s existing team rows alone rather than reconciling them', async () => {
      // §5.1 shows no Team control for an Admin, and the rows carry delivery meaning (assignment,
      // Team Status, capacity) — so a later demotion is lossless. Only `Remove` clears them.
      projectWithTeam();
      teamService.listUserTeamIds.mockResolvedValue(['team-1']);

      await service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {
        accessLevel: 'admin',
        teamIds: [],
      });

      expect(teamService.applyTeamMembershipDiff).toHaveBeenCalledWith(
        uow.tx,
        expect.objectContaining({ add: [], remove: [] }),
      );
    });

    it('is ATOMIC: a failed team write means the level did not land', async () => {
      projectWithTeam();
      teamService.applyTeamMembershipDiff.mockRejectedValue(new Error('team write exploded'));

      await expect(
        service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {
          accessLevel: 'editor',
          teamIds: ['team-1'],
        }),
      ).rejects.toThrow('team write exploded');

      expect(access.grantProjectAccess).not.toHaveBeenCalled();
    });

    it('refuses a team that is not linked to this project', async () => {
      projectWithTeam();

      await expect(
        service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {
          accessLevel: 'editor',
          teamIds: ['team-elsewhere'],
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_TEAM_NOT_FOUND' });
    });

    it('passes an omitted level through as undefined, never a defaulted one', async () => {
      await service.setProjectAccess('ws-1', 'proj-1', 'user-2', 'admin', {});

      const [input] = access.grantProjectAccess.mock.calls[0] as [Record<string, unknown>];
      expect('accessLevel' in input).toBe(false);
    });

    /**
     * The level-ONLY route (`PATCH :id/members/:memberId`) has no Teams to combine, so it is judged
     * against the ones the member already holds — and it must reach the SAME rule, not a second copy.
     */
    it('refuses a bare PATCH to Editor when the member holds no team', async () => {
      projectWithTeam();
      projectMemberRepo.findMemberById.mockResolvedValue({
        id: 'pm-1',
        projectId: 'proj-1',
        userId: 'user-2',
        accessLevel: null,
      });

      await expect(
        service.updateProjectMember('ws-1', 'proj-1', 'pm-1', { accessLevel: 'editor' }, 'admin'),
      ).rejects.toMatchObject({ code: 'PROJECT_EDITOR_REQUIRES_TEAM' });
    });

    it('allows a bare PATCH to Editor when the member already holds a team', async () => {
      projectWithTeam();
      teamService.listUserTeamIds.mockResolvedValue(['team-1']);
      projectMemberRepo.findMemberById.mockResolvedValue({
        id: 'pm-1',
        projectId: 'proj-1',
        userId: 'user-2',
        accessLevel: null,
      });
      projectMemberRepo.updateMember.mockResolvedValue({ id: 'pm-1', accessLevel: 'editor' });

      await expect(
        service.updateProjectMember('ws-1', 'proj-1', 'pm-1', { accessLevel: 'editor' }, 'admin'),
      ).resolves.toMatchObject({ accessLevel: 'editor' });
    });
  });

  /**
   * RBE-03. AC-8 / §2.1: "a Workspace Admin is not added as a Project user or Team member." The
   * seed writes the row and migration 0104 promoted it to `access_level = 'admin'`, and nothing
   * anti-joined it anywhere — so a WA was a member of every project in the workspace, and
   * offerable again as one.
   */
  describe('Workspace Admin is not a project member (§2.1)', () => {
    /**
     * The MEMBER half of §2.1 still holds: a `project_members` row for a Workspace Admin is dropped, so
     * they can never appear as an editable member with an access level. What changed on 2026-08-21 is
     * that they are then added back as a SYSTEM row — flagged, with no level — because the BA asked for
     * "a system-generated, read-only row … independent of Project Access and Team membership".
     */
    it('replaces a Workspace Admin member row with the synthesized system row', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      projectMemberRepo.listWorkspaceAdminUserIds.mockResolvedValue(['wa-1']);
      projectMemberRepo.listWorkspaceAdminProfiles.mockResolvedValue([
        { userId: 'wa-1', displayName: 'Wanda Admin', email: 'wanda@acme.test', avatarUrl: null },
      ]);
      projectMemberRepo.listByProject.mockResolvedValue([
        { id: 'pm-1', userId: 'wa-1', accessLevel: 'admin' },
        { id: 'pm-2', userId: 'user-2', accessLevel: 'editor' },
      ]);

      const roster = await service.listProjectMembers('ws-1', 'proj-1', 'user-1');

      // Once only, and as the system row: the real `pm-1` row is gone, so no editable level survives.
      expect(roster.map((m) => m.userId)).toEqual(['wa-1', 'user-2']);
      const wa = roster.find((m) => m.userId === 'wa-1');
      expect(wa?.isWorkspaceAdmin).toBe(true);
      expect(wa?.accessLevel).toBeNull();
      expect(roster.find((m) => m.userId === 'user-2')?.isWorkspaceAdmin).toBeUndefined();
    });

    it('shows the admin row on a project with no members of its own', async () => {
      // The reported symptom: "No members in this project yet." on a project whose only authority was
      // the admin reading the screen.
      projectRepo.findById.mockResolvedValue(mockProject());
      projectMemberRepo.listWorkspaceAdminUserIds.mockResolvedValue(['wa-1']);
      projectMemberRepo.listWorkspaceAdminProfiles.mockResolvedValue([
        { userId: 'wa-1', displayName: 'Wanda Admin', email: 'wanda@acme.test', avatarUrl: null },
      ]);
      projectMemberRepo.listByProject.mockResolvedValue([]);

      const roster = await service.listProjectMembers('ws-1', 'proj-1', 'user-1');

      expect(roster).toHaveLength(1);
      expect(roster[0].isWorkspaceAdmin).toBe(true);
    });

    // The write half of §2.1 — "REFUSES adding a Workspace Admin" — moved with the writer, to
    // `access.service.spec.ts`. The roster half stays here because `listProjectMembers` does.
  });

  /**
   * The assignee feed, and why it is a SEPARATE method from the roster.
   *
   * Gating the roster to Workspace/Project Admin (§3.1:71) was correct — and it broke every Editor's
   * Backlog and Iteration Status, because that roster was ALSO the only owner-picker feed. Both surfaces
   * derive the displayed owner NAME from it, so with the request refused every owned item read
   * `Unassigned` and §3.2:79's owner write was unreachable. Silent wrong data on the two screens an
   * Editor lives in, caused by a permission fix. No register row ever named it.
   *
   * So these tests pin the two properties that keep the fix honest: the feed carries NONE of the
   * administrative fields the roster is gated for, and it still excludes Workspace Admins (§2.1, and
   * `AC-16`'s "Workspace Admin is not an assignable owner" — one filter serving both).
   */
  describe('the assignee feed is separate from the roster (§3.1:71 / §3.2:79)', () => {
    beforeEach(() => {
      projectRepo.findById.mockResolvedValue(mockProject());
      projectMemberRepo.listWorkspaceAdminUserIds.mockResolvedValue(['wa-1']);
      projectMemberRepo.listByProject.mockResolvedValue([
        {
          id: 'pm-1',
          userId: 'wa-1',
          accessLevel: 'admin',
          status: 'active',
          displayName: 'Admin',
        },
        // A genuine PROJECT Admin — eligible in every branch, because §3.1 gives Admin All Teams.
        {
          id: 'pm-0',
          userId: 'user-1',
          accessLevel: 'admin',
          status: 'active',
          displayName: 'Ada Admin',
          email: 'ada@qnsc.dev',
          avatarUrl: null,
        },
        {
          id: 'pm-2',
          userId: 'user-2',
          accessLevel: 'editor',
          status: 'active',
          displayName: 'Dev Two',
          email: 'dev2@qnsc.dev',
          avatarUrl: null,
          teamCount: 3,
        },
        { id: 'pm-3', userId: 'user-3', accessLevel: 'editor', status: 'removed' },
      ]);
    });

    it('carries the picker fields and NONE of the administrative ones', async () => {
      const options = await service.listProjectMemberOptions('ws-1', 'proj-1');

      expect(options).toEqual([
        {
          userId: 'user-1',
          displayName: 'Ada Admin',
          email: 'ada@qnsc.dev',
          avatarUrl: null,
        },
      ]);
      // The fields §3.1 restricts the roster FOR must not ride along on the feed every participant
      // reads — asserted by key, so a field added to the roster shape later cannot join it silently.
      expect(Object.keys(options[0])).not.toContain('accessLevel');
      expect(Object.keys(options[0])).not.toContain('status');
      expect(Object.keys(options[0])).not.toContain('teamCount');
    });

    /**
     * WITH NO TEAM, ONLY A PROJECT ADMIN IS OFFERED (BA `c42df59`, 2026-08-22 — `WIC-FR-006A`).
     *
     * "With blank Team, Editor/WA Team members are not offered." This used to offer every active
     * project member, so an Editor could be made Owner of work their own team scope would then refuse
     * them. A Workspace Admin is excluded here too, and for a different reason: they qualify only
     * through a team roster, and there is no team.
     */
    it('offers project Admins and Workspace Admins when no team is given — not Editors', async () => {
      projectMemberRepo.listWorkspaceAdminProfiles.mockResolvedValue([
        { userId: 'wa-1', displayName: 'Admin', email: 'wa@qnsc.dev', avatarUrl: null },
      ]);

      const options = await service.listProjectMemberOptions('ws-1', 'proj-1');

      // The Editor (`user-2`) is withheld: that is the rule. The Workspace Admin is included as a
      // DECLARED READING — team-less work is the Project Backlog, whose audience is exactly Workspace
      // Admin plus Project Admin. See `assignmentCandidates`.
      expect(options.map((o) => o.userId).sort()).toEqual(['user-1', 'wa-1']);
    });

    it('takes NO actor and applies no roster gate — the route carries project:view', async () => {
      // The roster refuses an Editor by design. If this method grew the same check, the defect would
      // simply move here, so its signature deliberately has nowhere to put an actor.
      await expect(service.listProjectMemberOptions('ws-1', 'proj-1')).resolves.toHaveLength(1);
      expect(access.getProjectAccessLevel).not.toHaveBeenCalled();
    });

    /**
     * GAP-P1-WID-007 (P1). "Work Item and Task Owner default to Unassigned. Selected Team offers
     * Unassigned plus its ACTIVE MEMBERS; No Team offers only Unassigned. Do not add No Team or
     * unrelated Workspace users to Owner options."
     *
     * Three cases, because the rule has three branches and the middle one — "no team" — is the one a
     * client-side filter over the project feed would silently get wrong.
     */
    describe('a teamId narrows it to that Team (GAP-P1-WID-007)', () => {
      beforeEach(() => {
        projectTeamRepo.listByProject.mockResolvedValue([
          { id: 'link-1', projectId: 'proj-1', teamId: 'team-1', status: 'active' },
        ]);
        teamService.listTeamMembers.mockResolvedValue([
          {
            userId: 'user-9',
            status: 'active',
            displayName: 'Team Nine',
            email: 'nine@qnsc.dev',
            avatarUrl: null,
          },
          // On the roster but no longer an active member — offered by neither branch.
          { userId: 'user-8', status: 'inactive', displayName: 'Team Eight' },
          // A Workspace Admin who IS on the team roster. The BA reversed the old reading on
          // 2026-08-17 (`GAP-P1-WID-007` Confirmed Fail): the retest ACs name only "outside the Team"
          // and "inactive" as exclusions, and AC1 requires every active member of that Team. This
          // assertion is INVERTED from what it was — an active roster row is offered whatever else
          // its holder is.
          { userId: 'wa-1', status: 'active', displayName: 'Admin', email: 'wa@qnsc.dev' },
        ]);
      });

      /**
       * THE TEAM BRANCH IS THREE POPULATIONS, not the roster alone (BA `c42df59` — `WID-FR-017`).
       *
       * "active Project Admin, active Editor assigned to that Team, or active WA member of that Team."
       * It used to be `team_members` ALONE, which withheld a project Admin who is not on the team even
       * though §3.1 gives Admin All Teams — and offered a team member with no project access at all,
       * which RBE-06 used to justify and `PM-FR-021` has now retired.
       */
      it('offers project Admins, Editors on that team, and a WA on its roster', async () => {
        const options = await service.listProjectMemberOptions('ws-1', 'proj-1', 'team-1');

        // `user-1` (Admin, not on the team), `wa-1` (WA, on the roster). `user-9` is on the roster but
        // holds no project access, so `PM-FR-021`'s world has nothing to make them eligible.
        expect(options.map((o) => o.userId).sort()).toEqual(['user-1', 'wa-1']);
        expect(teamService.listTeamMembers).toHaveBeenCalledWith('team-1', 'ws-1');
      });

      it('offers an Editor once they are on the selected team', async () => {
        teamService.listTeamMembers.mockResolvedValue([
          { userId: 'user-2', status: 'active', displayName: 'Dev Two', email: 'dev2@qnsc.dev' },
        ]);

        const options = await service.listProjectMemberOptions('ws-1', 'proj-1', 'team-1');

        expect(options.map((o) => o.userId).sort()).toEqual(['user-1', 'user-2']);
      });

      /**
       * The 2026-08-17 retest failure itself: the selected team's only active member held the
       * workspace grant, so the Owner dropdown for a Story that HAS a team offered nothing but
       * `Unassigned` and the item could not be assigned to anyone at all.
       */
      it('offers an active Team member who is also a Workspace Admin (retest 2026-08-17)', async () => {
        teamService.listTeamMembers.mockResolvedValue([
          { userId: 'wa-1', status: 'active', displayName: 'Admin', email: 'wa@qnsc.dev' },
        ]);

        const options = await service.listProjectMemberOptions('ws-1', 'proj-1', 'team-1');

        // The WA is offered through the roster, beside the project Admin who is offered in every
        // branch. The retest failure was the WA being ABSENT; that is what this pins.
        expect(options.map((o) => o.userId)).toContain('wa-1');
      });

      it('does not consult any team when NO teamId is given', async () => {
        projectMemberRepo.listWorkspaceAdminProfiles.mockResolvedValue([]);
        const options = await service.listProjectMemberOptions('ws-1', 'proj-1');

        // Admin only, and no roster read at all — `WIC-FR-006A`: "With blank Team, Editor/WA Team
        // members are not offered."
        //
        // NOTE the consequence, because it moved a responsibility: this feed is no longer wide enough
        // to NAME an owner who has left the team, which it used to be relied on for. Names now come
        // joined on the row itself (`ownerNameJoins`), which is what made narrowing this safe.
        expect(options.map((o) => o.userId)).toEqual(['user-1']);
        expect(teamService.listTeamMembers).not.toHaveBeenCalled();
      });

      it('refuses a team that is not actively linked to the project', async () => {
        projectTeamRepo.listByProject.mockResolvedValue([]);

        await expect(
          service.listProjectMemberOptions('ws-1', 'proj-1', 'team-1'),
        ).rejects.toMatchObject({ code: 'PROJECT_TEAM_LINK_NOT_FOUND' });
        // Refused BEFORE the roster is read, so this route cannot be used to enumerate an unrelated
        // team's members through a project the caller happens to be able to view.
        expect(teamService.listTeamMembers).not.toHaveBeenCalled();
      });
    });
  });

  /**
   * PRJ-03. "Archived Projects are read-only regardless of access level" (PRJ-FR-010) held in four
   * other modules and in NONE of this one's own writes, though `assertProjectWritable` is a
   * sibling method in the same class. Reads stay open — archived means read-only, not invisible —
   * and the three member writes stay open so access can still be revoked.
   */
  describe('an archived project refuses its own configuration writes (PRJ-FR-010)', () => {
    beforeEach(() => {
      projectRepo.findById.mockResolvedValue(mockProject({ status: 'archived' }));
    });

    it('refuses a new workflow status', async () => {
      await expect(
        service.createStatus('ws-1', 'proj-1', { name: 'Blocked', category: 'to_do', position: 4 }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(statusRepo.create).not.toHaveBeenCalled();
    });

    it('refuses a new label', async () => {
      await expect(service.createLabel('ws-1', 'proj-1', 'urgent')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(labelRepo.create).not.toHaveBeenCalled();
    });

    it('refuses an estimation-settings edit', async () => {
      await expect(
        service.updateEstimationSettings(mockActor, 'proj-1', { mPoints: 50 }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(audit.emit).not.toHaveBeenCalled();
    });

    it('refuses a team link', async () => {
      teamService.listTeams.mockResolvedValue([{ id: 'team-1' }]);
      await expect(service.linkTeam('ws-1', 'proj-1', 'team-1')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(projectTeamRepo.linkTeam).not.toHaveBeenCalled();
    });

    it('still LISTS its statuses — archived is read-only, not invisible', async () => {
      statusRepo.listByProject.mockResolvedValue([mockStatus()]);
      await expect(service.listStatuses('ws-1', 'proj-1')).resolves.toHaveLength(1);
    });

    it('still allows REVOKING a member — access is not the project content', async () => {
      projectMemberRepo.findMember.mockResolvedValue({
        id: 'pm-1',
        userId: 'user-2',
        accessLevel: 'editor',
      });
      await expect(
        service.removeProjectMember('ws-1', 'proj-1', 'user-2', 'user-1'),
      ).resolves.toBeUndefined();
      expect(projectMemberRepo.removeMember).toHaveBeenCalled();
    });
  });

  describe('createTransition', () => {
    const transitionInput = { fromStatusId: 'status-1', toStatusId: 'status-2', name: 'Start' };

    it('creates a transition when both statuses belong to the project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      statusRepo.findById
        .mockResolvedValueOnce(mockStatus({ id: 'status-1' }))
        .mockResolvedValueOnce(mockStatus({ id: 'status-2' }));
      statusRepo.createTransition.mockResolvedValue({ id: 'tr-1' });
      await service.createTransition('ws-1', 'proj-1', transitionInput);
      expect(statusRepo.createTransition).toHaveBeenCalled();
    });

    it('rejects when the from-status belongs to another project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      statusRepo.findById
        .mockResolvedValueOnce(mockStatus({ id: 'status-1', projectId: 'other-proj' }))
        .mockResolvedValueOnce(mockStatus({ id: 'status-2' }));
      await expect(service.createTransition('ws-1', 'proj-1', transitionInput)).rejects.toThrow(
        NotFoundException,
      );
      expect(statusRepo.createTransition).not.toHaveBeenCalled();
    });

    it('rejects when the to-status belongs to another project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      statusRepo.findById
        .mockResolvedValueOnce(mockStatus({ id: 'status-1' }))
        .mockResolvedValueOnce(mockStatus({ id: 'status-2', projectId: 'other-proj' }));
      await expect(service.createTransition('ws-1', 'proj-1', transitionInput)).rejects.toThrow(
        NotFoundException,
      );
      expect(statusRepo.createTransition).not.toHaveBeenCalled();
    });

    it('rejects when a referenced status does not exist', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      statusRepo.findById
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockStatus({ id: 'status-2' }));
      await expect(service.createTransition('ws-1', 'proj-1', transitionInput)).rejects.toThrow(
        NotFoundException,
      );
      expect(statusRepo.createTransition).not.toHaveBeenCalled();
    });
  });

  // ── getProject ────────────────────────────────────────────────────────────

  describe('getProject', () => {
    it('returns project when found', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      const result = await service.getProject('ws-1', 'proj-1');
      expect(result.key).toBe('PROJ');
    });

    it('throws NotFoundException when not found', async () => {
      projectRepo.findById.mockResolvedValue(null);
      await expect(service.getProject('ws-1', 'missing')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when workspace mismatch', async () => {
      projectRepo.findById.mockResolvedValue(mockProject({ workspaceId: 'other-ws' }));
      await expect(service.getProject('ws-1', 'proj-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when project is soft-deleted', async () => {
      projectRepo.findById.mockResolvedValue(mockProject({ deletedAt: now }));
      await expect(service.getProject('ws-1', 'proj-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateProject ─────────────────────────────────────────────────────────

  describe('updateProject', () => {
    it('updates project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      projectRepo.update.mockResolvedValue(mockProject({ name: 'Renamed' }));

      const result = await service.updateProject(mockActor, 'proj-1', { name: 'Renamed' });
      expect(result.name).toBe('Renamed');
    });

    /**
     * PRJ-05 / RBE-12. Restoring an archived project was audited as `project.updated` —
     * indistinguishable in the Audit Log from a rename, on the one write that brings a read-only
     * project back into use. §8 audits it as its own administrative event.
     */
    it('audits a restore as project.restored, not project.updated', async () => {
      projectRepo.findById.mockResolvedValue(mockProject({ status: 'archived' }));
      projectRepo.update.mockResolvedValue(mockProject({ status: 'active' }));

      await service.updateProject(mockActor, 'proj-1', { status: 'active' });

      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'project.restored', resourceId: 'proj-1' }),
        expect.anything(),
      );
    });

    it('rejects an end date before the existing start date (merged validation)', async () => {
      projectRepo.findById.mockResolvedValue(mockProject({ startDate: '2026-07-01' }));

      await expect(
        service.updateProject(mockActor, 'proj-1', { endDate: '2026-01-01' }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(projectRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── deleteProject ─────────────────────────────────────────────────────────

  describe('deleteProject', () => {
    it('soft-deletes project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());

      await service.deleteProject(mockActor, 'proj-1');

      expect(projectRepo.softDelete).toHaveBeenCalledWith('proj-1', 'ws-1', expect.anything());
    });

    /**
     * PRJ-05 / RBE-12. §8 makes deleting a project an administrative audit event, and
     * `project.deleted` did not exist as an action — the most destructive write in the module was
     * the one mutation the Audit Log could not show. Emitted in the SAME transaction as the
     * delete, like every other emit here, so the outbox row cannot diverge from the state change.
     */
    it('emits project.deleted inside the same transaction as the soft delete', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());

      await service.deleteProject(mockActor, 'proj-1');

      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'project.deleted',
          resourceType: 'project',
          resourceId: 'proj-1',
          workspaceId: 'ws-1',
          actor: { id: mockActor.sub },
          // Names WHAT was deleted, not merely that something was.
          changes: { before: expect.objectContaining({ key: 'PROJ' }) },
        }),
        // The tx handed to the uow callback — the same one softDelete received above.
        uow.tx,
      );
      expect(uow.run).toHaveBeenCalled();
    });
  });

  // ── assertTransitionAllowed ───────────────────────────────────────────────

  describe('assertTransitionAllowed', () => {
    it('resolves when transition is permitted', async () => {
      statusRepo.canTransition.mockResolvedValue(true);
      await expect(
        service.assertTransitionAllowed('proj-1', 'status-a', 'status-b'),
      ).resolves.toBeUndefined();
    });

    it('throws PreconditionFailedException when transition is not allowed', async () => {
      statusRepo.canTransition.mockResolvedValue(false);
      await expect(
        service.assertTransitionAllowed('proj-1', 'status-a', 'status-b'),
      ).rejects.toThrow(PreconditionFailedException);
    });
  });

  // ── generateItemKey ───────────────────────────────────────────────────────

  describe('generateItemKey', () => {
    it('generates a type-prefixed hyphenated key like US-42 for story', async () => {
      projectRepo.findById.mockResolvedValue(mockProject({ key: 'PROJ' }));
      projectRepo.incrementCounter.mockResolvedValue(42);

      const key = await service.generateItemKey('ws-1', 'proj-1', 'story');
      expect(key).toBe('US-42');
      expect(projectRepo.incrementCounter).toHaveBeenCalledWith('ws-1', 'story');
    });

    it('generates DE-1 for defect', async () => {
      projectRepo.findById.mockResolvedValue(mockProject({ key: 'PROJ' }));
      projectRepo.incrementCounter.mockResolvedValue(1);

      const key = await service.generateItemKey('ws-1', 'proj-1', 'defect');
      expect(key).toBe('DE-1');
    });
  });

  // ── listStatuses ──────────────────────────────────────────────────────────

  describe('listStatuses', () => {
    it('returns statuses after validating project access', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      statusRepo.listByProject.mockResolvedValue([mockStatus()]);

      const result = await service.listStatuses('ws-1', 'proj-1');
      expect(result).toHaveLength(1);
    });
  });

  // ── deleteStatus ──────────────────────────────────────────────────────────

  describe('deleteStatus', () => {
    it('deletes status', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      statusRepo.findById.mockResolvedValue(mockStatus());

      await service.deleteStatus('ws-1', 'proj-1', 'status-1');
      expect(statusRepo.delete).toHaveBeenCalledWith('status-1');
    });

    it('throws NotFoundException when status does not belong to project', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      statusRepo.findById.mockResolvedValue(mockStatus({ projectId: 'other-proj' }));

      await expect(service.deleteStatus('ws-1', 'proj-1', 'status-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── estimation settings (SRS §6.2) ─────────────────────────────────────────

  describe('estimation settings', () => {
    const storedRow = {
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      xsPoints: 1,
      sPoints: 3,
      mPoints: 5,
      lPoints: 8,
      xlPoints: 13,
      // numeric(8,2) reads back as a string from drizzle.
      hoursPerPoint: '8.00',
    };

    it('getEstimationSettings falls back to the default scale when no row exists', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      estimationRows = [];

      const s = await service.getEstimationSettings('ws-1', 'proj-1');
      // The defaults mirror migration 0106 column DEFAULTs + DEFAULT_PRELIMINARY_ESTIMATE_MAP.
      expect(s).toEqual({
        xsPoints: 1,
        sPoints: 3,
        mPoints: 5,
        lPoints: 8,
        xlPoints: 13,
        hoursPerPoint: 8,
      });
    });

    it('getEstimationSettings returns the stored scale, coercing numeric hours to a number', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      estimationRows = [{ ...storedRow, mPoints: 50, hoursPerPoint: '6.50' }];

      const s = await service.getEstimationSettings('ws-1', 'proj-1');
      expect(s.mPoints).toBe(50);
      expect(s.hoursPerPoint).toBe(6.5);
    });

    it('updateEstimationSettings merges the patch onto current values, upserts, and audits', async () => {
      projectRepo.findById.mockResolvedValue(mockProject());
      estimationRows = [storedRow]; // current mPoints = 5

      const result = await service.updateEstimationSettings(mockActor, 'proj-1', { mPoints: 50 });

      // PATCH, not replace: only mPoints moved, the rest retained from the stored row.
      expect(result).toEqual({
        xsPoints: 1,
        sPoints: 3,
        mPoints: 50,
        lPoints: 8,
        xlPoints: 13,
        hoursPerPoint: 8,
      });
      expect(uow.tx.insert).toHaveBeenCalledTimes(1);
      // The audit event carries the merged `after`, proving the merge reached the writer.
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceType: 'project',
          resourceId: 'proj-1',
          changes: { before: expect.any(Object), after: result },
        }),
        expect.anything(),
      );
    });
  });
});
