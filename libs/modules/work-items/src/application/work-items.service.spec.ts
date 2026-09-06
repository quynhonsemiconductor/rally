import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { WorkItemsService } from './work-items.service';
import { WORK_ITEM_REPOSITORY } from '../domain/ports/work-item.repository';
import { ActivityLogger } from '@modules/activity';
import { TIME_LOG_REPOSITORY } from '../domain/ports/time-log.repository';
import { WATCHER_REPOSITORY } from '../domain/ports/watcher.repository';
import { ATTACHMENT_REPOSITORY, EntityAttachmentsService } from '@modules/attachments';
import { WORK_ITEM_RELATION_REPOSITORY } from '../domain/ports/work-item-relation.repository';
import { NotificationSchedulerService } from '@platform/notifications/notification-scheduler.service';
import { AttachmentsService } from '@modules/attachments';
import type { WorkItem } from '../domain/work-item.types';
import {
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  UnitOfWork,
} from '@platform';
import { ProjectsService } from '@modules/projects';
import { AccessService } from '@modules/access';
import { MilestonesService } from '@modules/milestones';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const now = new Date('2024-06-01');

const mockWorkItem = (o: Partial<WorkItem> = {}): WorkItem => ({
  id: 'wi-1',
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  itemKey: 'PROJ-1',
  type: 'story',
  title: 'Test story',
  description: null,
  statusId: 'status-todo',
  scheduleState: 'defined',
  flowState: 'defined',
  priority: 'none',
  assigneeId: null,
  reporterId: null,
  parentId: null,
  teamId: null,
  iterationId: null,
  releaseId: null,
  featureId: null,
  storyPoints: null,
  estimateHours: null,
  todoHours: null,
  actualHours: null,
  acceptanceCriteria: null,
  notes: null,
  releaseNotes: null,
  isBlocked: false,
  blockedReason: null,
  rank: 'a1',
  customFields: {},
  createdBy: 'user-1',
  updatedBy: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  // P3.4 — Defect-specific fields
  severity: null,
  foundInEnvironment: null,
  foundInReleaseId: null,
  rootCause: null,
  resolution: null,
  devOwnerId: null,
  defectState: null,
  fixedInBuild: null,
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

const mockStatus = (id: string, isDefault = false) => ({
  id,
  workspaceId: 'ws-1',
  projectId: 'proj-1',
  name: id,
  category: 'todo' as const,
  isDefault,
  position: 1,
  color: '#000',
  createdAt: now,
  updatedAt: now,
});

// ── Mock factories ────────────────────────────────────────────────────────────

const makeWorkItemRepo = () => ({
  findById: vi.fn(),
  findByIds: vi.fn().mockResolvedValue([]),
  findIterationScope: vi.fn().mockResolvedValue(null),
  findReleaseProject: vi.fn().mockResolvedValue(null),
  findPortfolioItemLinkTarget: vi.fn().mockResolvedValue({ type: 'feature', archived: false }),
  assignIteration: vi.fn().mockResolvedValue(undefined),
  assignRelease: vi.fn().mockResolvedValue(undefined),
  listByProject: vi.fn(),
  listBacklog: vi.fn(),
  listTasksByParent: vi.fn(),
  lockRankScope: vi.fn().mockResolvedValue(undefined),
  findMaxRank: vi.fn().mockResolvedValue(null),
  getTaskTotals: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn().mockResolvedValue(undefined),
  reorderItems: vi.fn().mockResolvedValue(undefined),
  addLabel: vi.fn().mockResolvedValue(undefined),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  listLabels: vi.fn(),
  listMilestones: vi.fn().mockResolvedValue([]),
  setMilestones: vi.fn().mockResolvedValue(undefined),
  // The parent Schedule State is DERIVED FROM THE TASK SET (`reconcileParentScheduleState`), so the
  // default census is "one task, still Defined" — a parent whose set says nothing has started. Cases
  // that care about the roll-up override it.
  taskStateCounts: vi.fn().mockResolvedValue({ total: 1, defined: 1, completed: 0 }),
  autoAcceptIterationIfComplete: vi.fn().mockResolvedValue(false),
  // The two Home aggregates. Both take the `listReadableProjectIds` sentinel as their last argument
  // — see the `Home aggregates` describe block at the bottom of this file for why that matters.
  listMyWork: vi.fn().mockResolvedValue([]),
  getWorkspaceSummary: vi.fn().mockResolvedValue({
    activeProjects: 0,
    activeSprints: 0,
    openWorkItems: 0,
    blockedItems: 0,
    openDefects: 0,
    assignedToMe: 0,
  }),
});

const makeRelationRepo = () => ({
  listForItem: vi.fn().mockResolvedValue([]),
  exists: vi.fn().mockResolvedValue(false),
  create: vi.fn().mockResolvedValue({ id: 'rel-1' }),
  findById: vi.fn(),
  delete: vi.fn().mockResolvedValue(undefined),
  deleteForItem: vi.fn().mockResolvedValue(undefined),
  wouldCreateCycle: vi.fn().mockResolvedValue(false),
});

const makeActivityRepo = () => ({
  build: vi.fn(
    (
      subject: {
        workspaceId: string;
        projectId: string;
        entityType: string;
        entityId: string;
        contextId?: string | null;
      },
      actorId: string | null,
      action: string,
      changes: unknown = null,
      metadata: Record<string, unknown> = {},
    ) => ({
      id: 'act',
      workspaceId: subject.workspaceId,
      projectId: subject.projectId,
      entityType: subject.entityType,
      entityId: subject.entityId,
      contextId: subject.contextId ?? null,
      actorId,
      action,
      changes,
      metadata,
    }),
  ),
  buildDiff: vi.fn(() => []),
  log: vi.fn().mockResolvedValue(undefined),
  logSafe: vi.fn().mockResolvedValue(undefined),
  listFor: vi.fn().mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 50 }),
});

const makeUnitOfWork = () => ({
  run: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
});

const makeProjectsService = () => {
  const listProjectTeams = vi.fn().mockResolvedValue([]);
  return {
    getProject: vi.fn().mockResolvedValue({ id: 'proj-1', workspaceId: 'ws-1' }),
    assertProjectWritable: vi.fn().mockResolvedValue(undefined),
    listStatuses: vi
      .fn()
      .mockResolvedValue([mockStatus('status-todo', true), mockStatus('status-done')]),
    assertTransitionAllowed: vi.fn().mockResolvedValue(undefined),
    generateItemKey: vi.fn().mockResolvedValue('PROJ-42'),
    // The Owner picker's own feed, which the Team-move Owner reset consults (`GAP-P1-WID-007` AC5).
    // Defaults to EMPTY, so a test that expects a moved Owner to survive has to name the roster.
    listProjectMemberOptions: vi.fn().mockResolvedValue([]),
    // The WRITE side of the same rule (BA `c42df59`): Owner and Dev Owner must be eligible in the
    // project/team, not merely members of the workspace. Permissive by default so the cases that are
    // about something else keep measuring that; the eligibility cases drive it explicitly.
    assertAssignable: vi.fn().mockResolvedValue(undefined),
    listProjectTeams,
    // Mirrors the real ProjectsService.assertTeamLinkedToProject so tests keep
    // driving the outcome via the listProjectTeams mock.
    assertTeamLinkedToProject: vi.fn(async (ws: string, projectId: string, teamId: string) => {
      const links = (await listProjectTeams(ws, projectId)) as Array<{
        teamId: string;
        status: string;
      }>;
      if (!links.some((l) => l.teamId === teamId && l.status === 'active')) {
        throw new PreconditionFailedException(
          'PROJECT_TEAM_LINK_NOT_FOUND',
          'Team is not linked to this project',
        );
      }
    }),
    // P1-15: scope validation helpers
    assertWorkspaceMember: vi.fn().mockResolvedValue(undefined),
    assertLabelBelongsToProject: vi.fn().mockResolvedValue(undefined),
  };
};

// Grants everything by default; individual tests override to assert denial.
//
// `getWorkspacePermissions` and `getProjectAccessLevel` are the two the attachment DELETE rule
// reads, and they default to the WEAKEST principal (no workspace grant, no project access level)
// so a test that wants admin authority has to say so.
const makeAccessService = () => ({
  assertProjectPermission: vi.fn().mockResolvedValue(undefined),
  // The Editor Team scope, reinstated by the BA on 2026-08-17 (`GAP-P4-RBAC-003`). Replaces the
  // `assertTeamScoped` mock that outlived the method it stood for by three months.
  assertTeamInScope: vi.fn().mockResolvedValue(undefined),
  // Unrestricted by default: a test about the Editor Team scope says so explicitly.
  resolveTeamScope: vi.fn().mockResolvedValue({ unrestricted: true }),
  getProjectPermissions: vi.fn().mockResolvedValue(['work_item:*']),
  getWorkspacePermissions: vi.fn().mockResolvedValue([]),
  getProjectAccessLevel: vi.fn().mockResolvedValue(null),
  // Cross-project scope for the Home aggregates. Defaults to the RESTRICTED-to-nothing answer, not
  // the `null` sentinel, for the same reason the two above default to the weakest principal: a test
  // that wants an unrestricted reader has to say so, and a caller that forgot to narrow fails here
  // rather than in production.
  listReadableProjectIds: vi.fn().mockResolvedValue([]),
});

/**
 * The milestone-artifact scope rule lives on MilestonesService — it reads the MILESTONE's project
 * and team scope, which this module cannot see. So the unit under test here is the DELEGATION; the
 * rule's own three conditions are pinned in milestones.service.spec.ts.
 */
const makeMilestonesService = () => ({
  assertArtifactsAssignable: vi.fn().mockResolvedValue(undefined),
});

const makeTimeLogRepo = () => ({
  findById: vi.fn(),
  listByWorkItem: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn().mockResolvedValue(undefined),
});

const makeWatcherRepo = () => ({
  listByWorkItem: vi.fn(),
  isWatching: vi.fn(),
  watch: vi.fn().mockResolvedValue(undefined),
  unwatch: vi.fn().mockResolvedValue(undefined),
  watchMany: vi.fn().mockResolvedValue(undefined),
  listUserIds: vi.fn(),
});

// Link table only — blob metadata now lives in storage.files behind AttachmentsService.
// Keyed by the entity pair since 0083.
const makeAttachmentRepo = () => ({
  listByEntity: vi.fn().mockResolvedValue([]),
  countByEntity: vi.fn().mockResolvedValue(0),
  findByEntityAndFile: vi.fn().mockResolvedValue(null),
  link: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
});

const makeNotificationScheduler = () => ({
  schedule: vi.fn().mockResolvedValue(undefined),
});

const makeAttachmentsService = () => ({
  presign: vi.fn().mockResolvedValue({
    fileId: 'file-1',
    uploadUrl: 'https://bucket.example.com/upload',
    requiredHeaders: {},
  }),
  confirm: vi.fn().mockResolvedValue({
    id: 'file-1',
    filename: 'f.txt',
    mimeType: 'text/plain',
    sizeBytes: 1024,
    uploadedBy: 'user-1',
    createdAt: new Date(),
  }),
  getDownloadUrl: vi
    .fn()
    .mockResolvedValue({ url: 'https://bucket.example.com/get', expiresInSeconds: 900 }),
  softDelete: vi.fn().mockResolvedValue(undefined),
  findById: vi.fn().mockResolvedValue(null),
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorkItemsService', () => {
  let service: WorkItemsService;
  let workItemRepo: ReturnType<typeof makeWorkItemRepo>;
  let activityRepo: ReturnType<typeof makeActivityRepo>;
  let projectsService: ReturnType<typeof makeProjectsService>;
  let accessService: ReturnType<typeof makeAccessService>;
  let uow: ReturnType<typeof makeUnitOfWork>;
  let timeLogRepo: ReturnType<typeof makeTimeLogRepo>;
  let watcherRepo: ReturnType<typeof makeWatcherRepo>;
  let attachmentRepo: ReturnType<typeof makeAttachmentRepo>;
  let attachmentsService: ReturnType<typeof makeAttachmentsService>;
  let relationRepo: ReturnType<typeof makeRelationRepo>;
  let notificationScheduler: ReturnType<typeof makeNotificationScheduler>;
  let milestonesService: ReturnType<typeof makeMilestonesService>;

  beforeEach(async () => {
    workItemRepo = makeWorkItemRepo();
    activityRepo = makeActivityRepo();
    projectsService = makeProjectsService();
    accessService = makeAccessService();
    uow = makeUnitOfWork();
    timeLogRepo = makeTimeLogRepo();
    watcherRepo = makeWatcherRepo();
    attachmentRepo = makeAttachmentRepo();
    attachmentsService = makeAttachmentsService();
    relationRepo = makeRelationRepo();
    notificationScheduler = makeNotificationScheduler();
    milestonesService = makeMilestonesService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkItemsService,
        { provide: WORK_ITEM_REPOSITORY, useValue: workItemRepo },
        { provide: ActivityLogger, useValue: activityRepo },
        { provide: TIME_LOG_REPOSITORY, useValue: timeLogRepo },
        { provide: WATCHER_REPOSITORY, useValue: watcherRepo },
        EntityAttachmentsService,
        { provide: ATTACHMENT_REPOSITORY, useValue: attachmentRepo },
        { provide: WORK_ITEM_RELATION_REPOSITORY, useValue: relationRepo },
        { provide: NotificationSchedulerService, useValue: notificationScheduler },
        { provide: AttachmentsService, useValue: attachmentsService },
        { provide: ProjectsService, useValue: projectsService },
        { provide: AccessService, useValue: accessService },
        { provide: MilestonesService, useValue: milestonesService },
        { provide: UnitOfWork, useValue: uow },
      ],
    }).compile();

    service = module.get(WorkItemsService);
  });

  // ── listWorkItems ──────────────────────────────────────────────────────────

  describe('listWorkItems', () => {
    it('validates project access and returns items', async () => {
      workItemRepo.listByProject.mockResolvedValue({
        data: [mockWorkItem()],
        pageInfo: { nextCursor: null, hasNextPage: false, limit: 20 },
      });

      const result = await service.listWorkItems(
        mockActor,
        'proj-1',
        {},
        { limit: 20, cursor: null },
      );

      expect(projectsService.getProject).toHaveBeenCalledWith('ws-1', 'proj-1');
      expect(result.data).toHaveLength(1);
    });
  });

  // ── createWorkItem ─────────────────────────────────────────────────────────

  describe('createWorkItem', () => {
    it('creates work item using default status when none provided', async () => {
      workItemRepo.create.mockResolvedValue(
        mockWorkItem({ statusId: 'status-todo', itemKey: 'PROJ-42' }),
      );

      const result = await service.createWorkItem(mockActor, 'proj-1', 'story', 'My story');

      expect(result.statusId).toBe('status-todo');
      expect(result.itemKey).toBe('PROJ-42');
      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ statusId: 'status-todo', workspaceId: 'ws-1' }),
        expect.anything(),
      );
    });

    it('uses provided valid statusId', async () => {
      workItemRepo.create.mockResolvedValue(mockWorkItem({ statusId: 'status-done' }));

      await service.createWorkItem(mockActor, 'proj-1', 'story', 'Story', {
        statusId: 'status-done',
      });

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ statusId: 'status-done' }),
        expect.anything(),
      );
    });

    it('throws NotFoundException for unknown statusId', async () => {
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'story', 'Story', {
          statusId: 'status-nonexistent',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws PreconditionFailedException when no statuses configured', async () => {
      projectsService.listStatuses.mockResolvedValue([]);

      await expect(service.createWorkItem(mockActor, 'proj-1', 'story', 'Story')).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('defaults priority to none', async () => {
      workItemRepo.create.mockResolvedValue(mockWorkItem({ priority: 'none' }));
      await service.createWorkItem(mockActor, 'proj-1', 'story', 'Story');

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 'none' }),
        expect.anything(),
      );
    });

    // ── Work-item hierarchy rules (DB design §Work item hierarchy / §19.3):
    //    Initiative → Feature → Story → { Task, Defect }; a defect's parent is a
    //    user story; a task's parent is a story or defect. ──
    it('rejects creating a defect under a non-story parent', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'feat-1', type: 'task' }));
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'defect', 'Bug', { parentId: 'feat-1' }),
      ).rejects.toThrow(/user story/i);
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it('allows creating a defect under a story parent', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'story-1', type: 'story' }));
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'defect', parentId: 'story-1' }));
      await service.createWorkItem(mockActor, 'proj-1', 'defect', 'Bug', { parentId: 'story-1' });
      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ parentId: 'story-1' }),
        expect.anything(),
      );
    });

    it.each(['story', 'defect'] as const)(
      'allows creating a task under a %s parent',
      async (parentType) => {
        workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'p-1', type: parentType }));
        workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task', parentId: 'p-1' }));
        await service.createWorkItem(mockActor, 'proj-1', 'task', 'T', { parentId: 'p-1' });
        expect(workItemRepo.create).toHaveBeenCalled();
      },
    );

    it.each(['task'] as const)('rejects creating a task under a %s parent', async (parentType) => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'p-1', type: parentType }));
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'task', 'T', { parentId: 'p-1' }),
      ).rejects.toThrow(/user story or defect/i);
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it('rejects creating a task with no parent', async () => {
      await expect(service.createWorkItem(mockActor, 'proj-1', 'task', 'T')).rejects.toThrow(
        /must be created under a user story or defect/i,
      );
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it.each(['story'] as const)(
      'rejects giving a %s a parent (only tasks and defects have parents)',
      async (childType) => {
        workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'p-1', type: 'story' }));
        await expect(
          service.createWorkItem(mockActor, 'proj-1', childType, 'X', { parentId: 'p-1' }),
        ).rejects.toThrow(/only defects and tasks/i);
        expect(workItemRepo.create).not.toHaveBeenCalled();
      },
    );

    it('rejects an iteration that belongs to a different project', async () => {
      workItemRepo.findIterationScope.mockResolvedValue({ projectId: 'other-proj', teamId: null });
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'story', 'Story', { iterationId: 'iter-x' }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a release that belongs to a different project', async () => {
      workItemRepo.findReleaseProject.mockResolvedValue('other-proj');
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'story', 'Story', { releaseId: 'rel-x' }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a defect foundInReleaseId from a different project', async () => {
      workItemRepo.findReleaseProject.mockResolvedValue('other-proj');
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'defect', 'Bug', {
          foundInReleaseId: 'rel-x',
        }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a reporterId who is not a workspace member', async () => {
      projectsService.assertWorkspaceMember.mockRejectedValueOnce(new Error('NOT_MEMBER'));
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'story', 'Story', {
          reporterId: 'foreign-user',
        }),
      ).rejects.toThrow('NOT_MEMBER');
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a devOwnerId who is not a workspace member', async () => {
      projectsService.assertWorkspaceMember.mockRejectedValueOnce(new Error('NOT_MEMBER'));
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'defect', 'Bug', {
          devOwnerId: 'foreign-user',
        }),
      ).rejects.toThrow('NOT_MEMBER');
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    // ── "assign on create" is the same event as "assign later" ───────────────
    //
    // The update path emitted WORK_ITEM_ASSIGNED and this one emitted nothing, so an item
    // created already assigned notified nobody. Both paths go through `notifyAssignee` now, and
    // these three cases are the rules that helper owns.

    it('notifies an assignee named at CREATE time (P45-02)', async () => {
      workItemRepo.create.mockResolvedValue(mockWorkItem({ assigneeId: 'user-2' }));

      await service.createWorkItem(mockActor, 'proj-1', 'story', 'My story', {
        assigneeId: 'user-2',
      });

      expect(notificationScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          template: 'WORK_ITEM_ASSIGNED',
          recipientId: 'user-2',
          actorId: 'user-1',
        }),
        // On the create transaction, so a rolled-back create leaves no ghost notification.
        expect.anything(),
      );
    });

    it('does not notify the actor who assigns an item to themselves', async () => {
      workItemRepo.create.mockResolvedValue(mockWorkItem({ assigneeId: mockActor.sub }));

      await service.createWorkItem(mockActor, 'proj-1', 'story', 'My story', {
        assigneeId: mockActor.sub,
      });

      expect(notificationScheduler.schedule).not.toHaveBeenCalled();
    });

    it('drops an assignee who cannot see the project (FR-019)', async () => {
      workItemRepo.create.mockResolvedValue(mockWorkItem({ assigneeId: 'user-2' }));
      // Assignment only proves active WORKSPACE membership; this user holds no project grant.
      accessService.getProjectPermissions.mockResolvedValue([]);

      await service.createWorkItem(mockActor, 'proj-1', 'story', 'My story', {
        assigneeId: 'user-2',
      });

      expect(notificationScheduler.schedule).not.toHaveBeenCalled();
    });
  });

  // ── createTask ─────────────────────────────────────────────────────────────

  /**
   * OWNER AND DEV OWNER MUST BE ELIGIBLE, not merely workspace members (BA `c42df59`, 2026-08-22).
   *
   * The write used to check only `assertWorkspaceMember`, which is orders of magnitude wider than the
   * picker: any user id in the body was accepted for work no picker would have offered them. The
   * candidate list and the validation are one rule now (`ProjectsService.assertAssignable`), and these
   * cases pin that the write CONSULTS it — with the reporter deliberately outside it.
   */
  /**
   * DEV OWNER NOTIFIES LIKE OWNER, on a Story, a Defect and a Task (`P4-NOTIF-DC-012`, BA `c42df59`).
   *
   * "An assignment notification is created when the signed-in user is newly assigned as `Owner` or
   * `Dev Owner` of a US/DE/Task." Only the Owner half existed, so naming somebody Dev Owner told them
   * nothing at all — and `work.tasks` had no `dev_owner_id` to name them in (migration 0127).
   */
  describe('assignment notifications cover both responsibilities', () => {
    beforeEach(() => {
      // The recipient can see the project. FR-019's filter has its own cases; here it must not be
      // what makes the assertion pass or fail.
      accessService.getProjectPermissions.mockResolvedValue(['work_item:view']);
    });

    it('notifies a NEW Dev Owner on update', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ devOwnerId: null }));
      workItemRepo.update.mockResolvedValue(mockWorkItem({ devOwnerId: 'u-dev' }));

      await service.updateWorkItem(mockActor, 'wi-1', { devOwnerId: 'u-dev' });

      // Asserted on the payload alone: the second argument is the open transaction, which is
      // `undefined` on some paths and `expect.anything()` refuses that.
      const payloads = notificationScheduler.schedule.mock.calls.map((c: unknown[]) => c[0]);
      expect(payloads).toEqual([
        expect.objectContaining({ template: 'WORK_ITEM_ASSIGNED', recipientId: 'u-dev' }),
      ]);
    });

    it('tells one person ONCE when they are named as both', async () => {
      // The recipient is the discriminator, not the field — otherwise a single patch would send the
      // same person two notifications for one action.
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ assigneeId: null, devOwnerId: null }));
      workItemRepo.update.mockResolvedValue(
        mockWorkItem({ assigneeId: 'u-dev', devOwnerId: 'u-dev' }),
      );

      await service.updateWorkItem(mockActor, 'wi-1', {
        assigneeId: 'u-dev',
        devOwnerId: 'u-dev',
      });

      const assignedCalls = notificationScheduler.schedule.mock.calls.filter(
        (c: unknown[]) => (c[0] as { template?: string }).template === 'WORK_ITEM_ASSIGNED',
      );
      expect(assignedCalls).toHaveLength(1);
    });

    it('does NOT notify when the Dev Owner is unchanged', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ devOwnerId: 'u-dev' }));
      workItemRepo.update.mockResolvedValue(mockWorkItem({ devOwnerId: 'u-dev' }));

      await service.updateWorkItem(mockActor, 'wi-1', { devOwnerId: 'u-dev' });

      const templates = notificationScheduler.schedule.mock.calls.map(
        (c: unknown[]) => (c[0] as { template?: string }).template,
      );
      expect(templates).not.toContain('WORK_ITEM_ASSIGNED');
    });
  });

  describe('the assignment rule reaches the write path', () => {
    it('asserts Owner and Dev Owner against the project/team, and not the reporter', async () => {
      // `team-1` has to be LINKED for the write to reach the assignment rule at all.
      projectsService.listProjectTeams.mockResolvedValue([{ teamId: 'team-1', status: 'active' }]);
      workItemRepo.create.mockResolvedValue(mockWorkItem({ assigneeId: 'u-owner' }));

      await service.createWorkItem(mockActor, 'proj-1', 'story', 'Titled', {
        teamId: 'team-1',
        assigneeId: 'u-owner',
        devOwnerId: 'u-dev',
        reporterId: 'u-reporter',
      });

      expect(projectsService.assertAssignable).toHaveBeenCalledWith(
        'ws-1',
        'proj-1',
        'team-1',
        'u-owner',
      );
      expect(projectsService.assertAssignable).toHaveBeenCalledWith(
        'ws-1',
        'proj-1',
        'team-1',
        'u-dev',
      );
      // A reporter records who RAISED the item, not who may be given it.
      expect(projectsService.assertAssignable).not.toHaveBeenCalledWith(
        'ws-1',
        'proj-1',
        'team-1',
        'u-reporter',
      );
    });

    it('refuses the create when the rule refuses the owner', async () => {
      workItemRepo.create.mockResolvedValue(mockWorkItem());
      projectsService.assertAssignable.mockRejectedValueOnce(
        new PreconditionFailedException('WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE', 'nope'),
      );

      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'story', 'Titled', { assigneeId: 'u-x' }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });

    it('asserts against the INCOMING team when a patch moves both', async () => {
      // The team the owner has to be eligible in is the one the item ends up on, not the one it left.
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ teamId: 'team-old' }));
      projectsService.listProjectTeams.mockResolvedValue([{ teamId: 'team-1', status: 'active' }]);
      workItemRepo.update.mockResolvedValue(mockWorkItem({ teamId: 'team-1' }));
      // The Team-move Owner reset consults the picker feed first (AC5) and would otherwise clear the
      // incoming owner before the rule is reached — the reset and the rule read the same population.
      projectsService.listProjectMemberOptions.mockResolvedValue([{ userId: 'u-owner' }]);

      await service.updateWorkItem(mockActor, 'wi-1', { teamId: 'team-1', assigneeId: 'u-owner' });

      expect(projectsService.assertAssignable).toHaveBeenCalledWith(
        'ws-1',
        'proj-1',
        'team-1',
        'u-owner',
      );
    });
  });

  describe('createTask', () => {
    it('inherits the team from the parent when none is provided', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'parent-1', projectId: 'proj-1', teamId: 'team-p' }),
      );
      projectsService.listProjectTeams.mockResolvedValue([{ teamId: 'team-p', status: 'active' }]);
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task', teamId: 'team-p' }));

      await service.createTask(mockActor, 'parent-1', 'My task');

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'team-p' }),
        expect.anything(),
      );
    });

    /**
     * GAP-P1-WID-007 / P6-TC-007. Owner is deliberately NOT inherited, unlike Team just above.
     *
     * This pair is the whole fix: the first assertion is the rule, the second is why the rule
     * matters. `assigneeId` used to be `opts.assigneeId ?? parent.assigneeId`, and because
     * `CreateTaskSchema.assigneeId` is `.optional()` and not `.nullable()`, an owned Story could
     * not produce an unowned Task through any API path — so the Unassigned bucket that Team
     * Capacity and Team Status both report was unreachable for the ordinary case, and the BA read
     * the resulting named attribution as a reporting defect. The projection was correct.
     */
    it('does NOT inherit the owner from the parent — Owner defaults to Unassigned', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'parent-1', projectId: 'proj-1', assigneeId: 'owner-of-the-story' }),
      );
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task' }));

      await service.createTask(mockActor, 'parent-1', 'My task');

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: undefined }),
        expect.anything(),
      );
    });

    it('still honours an explicitly provided owner', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'parent-1', projectId: 'proj-1', assigneeId: 'owner-of-the-story' }),
      );
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task' }));

      await service.createTask(mockActor, 'parent-1', 'My task', { assigneeId: 'someone-else' });

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: 'someone-else' }),
        expect.anything(),
      );
    });

    it('uses the explicitly provided team over the parent team', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'parent-1', projectId: 'proj-1', teamId: 'team-p' }),
      );
      projectsService.listProjectTeams.mockResolvedValue([{ teamId: 'team-x', status: 'active' }]);
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task', teamId: 'team-x' }));

      await service.createTask(mockActor, 'parent-1', 'My task', { teamId: 'team-x' });

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'team-x' }),
        expect.anything(),
      );
    });

    // ── Real Rally: Estimate is an independent planned value (client-set), not
    //    derived. To Do / Actuals are independent too. ──
    it('persists the client-supplied Estimate independently of To Do / Actual', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'parent-1', projectId: 'proj-1', teamId: 'team-p' }),
      );
      projectsService.listProjectTeams.mockResolvedValue([{ teamId: 'team-p', status: 'active' }]);
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task' }));

      await service.createTask(mockActor, 'parent-1', 'My task', {
        estimateHours: '8',
        todoHours: '3',
        actualHours: '2',
      });

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ estimateHours: '8', todoHours: '3', actualHours: '2' }),
        expect.anything(),
      );
    });

    // ── Real Rally: To Do defaults to the Estimate on create when not given ──
    it('defaults To Do to the Estimate when To Do is not provided', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'parent-1', projectId: 'proj-1', teamId: 'team-p' }),
      );
      projectsService.listProjectTeams.mockResolvedValue([{ teamId: 'team-p', status: 'active' }]);
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task' }));

      await service.createTask(mockActor, 'parent-1', 'My task', { estimateHours: '8' });

      expect(workItemRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ estimateHours: '8', todoHours: '8' }),
        expect.anything(),
      );
    });

    it.each(['task'] as const)(
      'rejects creating a task under a %s (parent must be a story or defect)',
      async (parentType) => {
        workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'p-1', type: parentType }));
        await expect(service.createTask(mockActor, 'p-1', 'T')).rejects.toThrow(
          /user story or defect/i,
        );
        expect(workItemRepo.create).not.toHaveBeenCalled();
      },
    );

    it('allows creating a task under a defect', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'de-1', type: 'defect', projectId: 'proj-1' }),
      );
      workItemRepo.create.mockResolvedValue(mockWorkItem({ type: 'task', parentId: 'de-1' }));
      await service.createTask(mockActor, 'de-1', 'T');
      expect(workItemRepo.create).toHaveBeenCalled();
    });
  });

  // ── getWorkItem ────────────────────────────────────────────────────────────

  describe('getWorkItem', () => {
    it('returns work item when found and belongs to workspace', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      const result = await service.getWorkItem('ws-1', 'wi-1');
      expect(result.title).toBe('Test story');
    });

    it('throws NotFoundException when not found', async () => {
      workItemRepo.findById.mockResolvedValue(null);
      await expect(service.getWorkItem('ws-1', 'missing')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when workspace mismatch', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ workspaceId: 'other-ws' }));
      await expect(service.getWorkItem('ws-1', 'wi-1')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for soft-deleted item', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ deletedAt: now }));
      await expect(service.getWorkItem('ws-1', 'wi-1')).rejects.toThrow(NotFoundException);
    });
  });

  // ── updateWorkItem ─────────────────────────────────────────────────────────

  describe('updateWorkItem', () => {
    it('updates work item', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      workItemRepo.update.mockResolvedValue(mockWorkItem({ title: 'Updated' }));

      const result = await service.updateWorkItem(mockActor, 'wi-1', { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    /**
     * `GAP-P1-WID-007` AC5/AC6 (BA DEV Handoff retest 2026-08-17). "If the Work Item moves to another
     * Team and the old Owner does not belong to the new Team, the system must return Owner to
     * `Unassigned`", and a Work Item with no Team may only be `Unassigned`.
     *
     * Asserted on the PATCH the repository receives, because that is the only place the reset is
     * observable — the whole point is that it rides the SAME write rather than a follow-up one.
     */
    describe('a Team move takes the Owner with it, or drops them (AC5/AC6)', () => {
      beforeEach(() => {
        workItemRepo.findById.mockResolvedValue(
          mockWorkItem({ teamId: 'team-a', assigneeId: 'u-9' }),
        );
        workItemRepo.update.mockResolvedValue(mockWorkItem());
        projectsService.listProjectTeams.mockResolvedValue([
          { teamId: 'team-a', status: 'active' },
          { teamId: 'team-b', status: 'active' },
        ]);
      });

      const patchSentFor = () =>
        (workItemRepo.update as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
          assigneeId?: string | null;
        };

      it('clears an Owner who is not on the new Team', async () => {
        projectsService.listProjectMemberOptions.mockResolvedValue([{ userId: 'someone-else' }]);

        await service.updateWorkItem(mockActor, 'wi-1', { teamId: 'team-b' });

        expect(patchSentFor().assigneeId).toBeNull();
      });

      it('KEEPS an Owner who is on the new Team too', async () => {
        // Clearing unconditionally would discard a true value: the same person can be on both teams.
        projectsService.listProjectMemberOptions.mockResolvedValue([
          { userId: 'u-9' },
          { userId: 'someone-else' },
        ]);

        await service.updateWorkItem(mockActor, 'wi-1', { teamId: 'team-b' });

        expect(patchSentFor().assigneeId).toBeUndefined();
      });

      it('clears the Owner when the Team is cleared, without reading any roster (AC6)', async () => {
        await service.updateWorkItem(mockActor, 'wi-1', { teamId: null });

        expect(patchSentFor().assigneeId).toBeNull();
        // There is no roster to consult for "no team" — offering only `Unassigned` is the whole rule.
        expect(projectsService.listProjectMemberOptions).not.toHaveBeenCalled();
      });

      it('judges the INCOMING Owner when one patch sets both', async () => {
        projectsService.listProjectMemberOptions.mockResolvedValue([{ userId: 'u-new' }]);

        await service.updateWorkItem(mockActor, 'wi-1', { teamId: 'team-b', assigneeId: 'u-new' });

        expect(patchSentFor().assigneeId).toBe('u-new');
      });

      it('leaves the Owner alone when the Team is not part of the patch', async () => {
        await service.updateWorkItem(mockActor, 'wi-1', { title: 'Renamed' });

        expect(patchSentFor().assigneeId).toBeUndefined();
        expect(projectsService.listProjectMemberOptions).not.toHaveBeenCalled();
      });
    });

    describe('linking a Story to a Feature', () => {
      // `feature_id` is what every portfolio rollup and capacity metric aggregates by, and until
      // now only the demo seed could set it — the field was readable and writable nowhere.
      beforeEach(() => {
        workItemRepo.findById.mockResolvedValue(mockWorkItem());
        workItemRepo.update.mockResolvedValue(mockWorkItem({ featureId: 'fe-1' }));
        workItemRepo.findPortfolioItemLinkTarget.mockResolvedValue({
          type: 'feature',
          archived: false,
        });
      });

      it('links a Story to an active Feature', async () => {
        const result = await service.updateWorkItem(mockActor, 'wi-1', { featureId: 'fe-1' });
        expect(result.featureId).toBe('fe-1');
        expect(workItemRepo.update).toHaveBeenCalledWith(
          'wi-1',
          expect.objectContaining({ featureId: 'fe-1' }),
          expect.anything(),
          expect.anything(),
        );
      });

      it('unlinks on null WITHOUT looking anything up', async () => {
        // There is nothing to validate about the absence of a link.
        await service.updateWorkItem(mockActor, 'wi-1', { featureId: null });
        expect(workItemRepo.findPortfolioItemLinkTarget).not.toHaveBeenCalled();
      });

      it('refuses an EPIC', async () => {
        // Rally attaches the story hierarchy to the LOWEST portfolio level. Our rollup counts an
        // Epic's children through its Features, so a story pointed straight at an Epic would be
        // counted by the Epic and by nothing else.
        workItemRepo.findPortfolioItemLinkTarget.mockResolvedValue({
          type: 'epic',
          archived: false,
        });
        await expect(
          service.updateWorkItem(mockActor, 'wi-1', { featureId: 'ep-1' }),
        ).rejects.toMatchObject({ code: 'WORK_ITEM_FEATURE_LINK_NOT_FEATURE' });
      });

      it('refuses an ARCHIVED Feature', async () => {
        // Archived Features are hidden from every portfolio surface, so work linked to one would
        // roll up into a row nobody can see.
        workItemRepo.findPortfolioItemLinkTarget.mockResolvedValue({
          type: 'feature',
          archived: true,
        });
        await expect(
          service.updateWorkItem(mockActor, 'wi-1', { featureId: 'fe-1' }),
        ).rejects.toMatchObject({ code: 'WORK_ITEM_FEATURE_LINK_ARCHIVED' });
      });

      it('refuses a TASK, which inherits the link from its work product', async () => {
        workItemRepo.findById.mockResolvedValue(mockWorkItem({ type: 'task' }));
        await expect(
          service.updateWorkItem(mockActor, 'wi-1', { featureId: 'fe-1' }),
        ).rejects.toMatchObject({ code: 'WORK_ITEM_FEATURE_LINK_NOT_ALLOWED' });
        // Refused before the lookup: the item type alone decides it.
        expect(workItemRepo.findPortfolioItemLinkTarget).not.toHaveBeenCalled();
      });

      it('404s a Feature that does not exist', async () => {
        workItemRepo.findPortfolioItemLinkTarget.mockResolvedValue(null);
        await expect(
          service.updateWorkItem(mockActor, 'wi-1', { featureId: 'nope' }),
        ).rejects.toMatchObject({ code: 'PORTFOLIO_ITEM_NOT_FOUND' });
      });

      it('does NOT require the Feature to be in the same project', async () => {
        // Rally lets a team project's Story roll up to a portfolio project's Feature, and the
        // portfolio rollup matches on `feature_id` alone — the project+release filter is Rally's
        // CAPACITY rule, not its portfolio rule.
        await expect(
          service.updateWorkItem(mockActor, 'wi-1', { featureId: 'fe-elsewhere' }),
        ).resolves.toBeDefined();
      });
    });

    describe('unblocking clears the Blocked Reason', () => {
      // Rally: "When a blocked status is removed, the Blocked Reason field is cleared."
      // A reason that outlives its block claims the item is blocked for that reason, right
      // next to a flag saying it is not — and the inline cell is only editable WHILE blocked,
      // so the stale text could be read and never removed.
      const blocked = () =>
        mockWorkItem({ isBlocked: true, blockedReason: 'Waiting on the vendor' });

      it('clears it when isBlocked goes false', async () => {
        workItemRepo.findById.mockResolvedValue(blocked());
        workItemRepo.update.mockResolvedValue(mockWorkItem({ isBlocked: false }));

        await service.updateWorkItem(mockActor, 'wi-1', { isBlocked: false });

        expect(workItemRepo.update).toHaveBeenCalledWith(
          'wi-1',
          expect.objectContaining({ isBlocked: false, blockedReason: null }),
          expect.anything(),
          expect.anything(),
        );
      });

      it('clears it even when the SAME patch sends a reason', async () => {
        // The two cannot both be true, so `isBlocked: false` wins rather than the write order
        // deciding it.
        workItemRepo.findById.mockResolvedValue(blocked());
        workItemRepo.update.mockResolvedValue(mockWorkItem({ isBlocked: false }));

        await service.updateWorkItem(mockActor, 'wi-1', {
          isBlocked: false,
          blockedReason: 'Still stuck',
        });

        expect(workItemRepo.update).toHaveBeenCalledWith(
          'wi-1',
          expect.objectContaining({ blockedReason: null }),
          expect.anything(),
          expect.anything(),
        );
      });

      it('leaves the reason alone when BLOCKING', async () => {
        workItemRepo.findById.mockResolvedValue(mockWorkItem());
        workItemRepo.update.mockResolvedValue(mockWorkItem({ isBlocked: true }));

        await service.updateWorkItem(mockActor, 'wi-1', {
          isBlocked: true,
          blockedReason: 'Waiting on the vendor',
        });

        expect(workItemRepo.update).toHaveBeenCalledWith(
          'wi-1',
          expect.objectContaining({ blockedReason: 'Waiting on the vendor' }),
          expect.anything(),
          expect.anything(),
        );
      });

      it('does not touch the reason on an unrelated edit', async () => {
        // A title change on a blocked item must not unblock anything by side effect.
        workItemRepo.findById.mockResolvedValue(blocked());
        workItemRepo.update.mockResolvedValue(blocked());

        await service.updateWorkItem(mockActor, 'wi-1', { title: 'Renamed' });

        const patch = workItemRepo.update.mock.calls[0][1] as Record<string, unknown>;
        expect('blockedReason' in patch).toBe(false);
      });
    });

    it('validates transition when statusId changes', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ statusId: 'status-todo' }));
      workItemRepo.update.mockResolvedValue(mockWorkItem({ statusId: 'status-done' }));

      await service.updateWorkItem(mockActor, 'wi-1', { statusId: 'status-done' });

      expect(projectsService.assertTransitionAllowed).toHaveBeenCalledWith(
        'proj-1',
        'status-todo',
        'status-done',
      );
    });

    it('skips transition check when statusId unchanged', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ statusId: 'status-todo' }));
      workItemRepo.update.mockResolvedValue(mockWorkItem());

      await service.updateWorkItem(mockActor, 'wi-1', { statusId: 'status-todo' });

      expect(projectsService.assertTransitionAllowed).not.toHaveBeenCalled();
    });

    // ── BR-WI-01: Schedule State <-> Flow State mirror ──
    it('mirrors a Schedule State change onto Flow State', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ scheduleState: 'defined' }));
      workItemRepo.update.mockResolvedValue(mockWorkItem({ scheduleState: 'in_progress' }));

      await service.updateWorkItem(mockActor, 'wi-1', { scheduleState: 'in_progress' });

      expect(workItemRepo.update).toHaveBeenCalledWith(
        'wi-1',
        expect.objectContaining({ scheduleState: 'in_progress', flowState: 'in_progress' }),
        'ws-1',
        expect.anything(),
      );
    });

    it('mirrors a Flow State change onto Schedule State', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ scheduleState: 'defined' }));
      workItemRepo.update.mockResolvedValue(mockWorkItem({ scheduleState: 'in_progress' }));

      await service.updateWorkItem(mockActor, 'wi-1', { flowState: 'in_progress' });

      expect(workItemRepo.update).toHaveBeenCalledWith(
        'wi-1',
        expect.objectContaining({ scheduleState: 'in_progress', flowState: 'in_progress' }),
        'ws-1',
        expect.anything(),
      );
    });

    it('rejects a request that sets Schedule and Flow to conflicting values', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());

      await expect(
        service.updateWorkItem(mockActor, 'wi-1', {
          scheduleState: 'in_progress',
          flowState: 'completed',
        }),
      ).rejects.toThrow(PreconditionFailedException);
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    // ── BR-TASK-02 / DEV-018: reverse roll-up ──
    it('reopens a completed parent when a child task leaves Completed', async () => {
      const task = mockWorkItem({
        id: 'task-1',
        type: 'task',
        scheduleState: 'completed',
        parentId: 'parent-1',
      });
      const parent = mockWorkItem({ id: 'parent-1', scheduleState: 'completed' });
      workItemRepo.findById.mockImplementation((id: string) =>
        Promise.resolve(id === 'parent-1' ? parent : task),
      );
      // One task, started: not all-Defined, not all-Completed, so the set derives In-Progress.
      workItemRepo.taskStateCounts.mockResolvedValue({ total: 1, defined: 0, completed: 0 });
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'task-1', type: 'task' }));

      await service.updateWorkItem(mockActor, 'task-1', { scheduleState: 'in_progress' });

      expect(workItemRepo.update).toHaveBeenCalledWith(
        'parent-1',
        expect.objectContaining({ scheduleState: 'in_progress' }),
        'ws-1',
        expect.anything(),
      );
    });

    it('reverts an Accepted parent to In-Progress when a child task reopens (P3-TS-FR-041; Accepted is not exempt)', async () => {
      const task = mockWorkItem({
        id: 'task-1',
        type: 'task',
        scheduleState: 'completed',
        parentId: 'parent-1',
      });
      const parent = mockWorkItem({ id: 'parent-1', scheduleState: 'accepted' });
      workItemRepo.findById.mockImplementation((id: string) =>
        Promise.resolve(id === 'parent-1' ? parent : task),
      );
      // The reopened task IS the set: one task, started — neither all-Defined nor all-Completed, so
      // the derived parent state is In-Progress.
      workItemRepo.taskStateCounts.mockResolvedValue({ total: 1, defined: 0, completed: 0 });
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'task-1', type: 'task' }));

      await service.updateWorkItem(mockActor, 'task-1', { scheduleState: 'in_progress' });

      expect(workItemRepo.update).toHaveBeenCalledWith(
        'parent-1',
        expect.objectContaining({ scheduleState: 'in_progress' }),
        'ws-1',
        expect.anything(),
      );
    });

    // ── Real Rally: Estimate is independent — never derived/overwritten on update ──
    it('does NOT derive or overwrite the Estimate on update', async () => {
      const task = mockWorkItem({
        id: 'task-1',
        type: 'task',
        todoHours: '1',
        actualHours: '1',
        estimateHours: '8',
      });
      workItemRepo.findById.mockResolvedValue(task);
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'task-1', type: 'task' }));

      await service.updateWorkItem(mockActor, 'task-1', { todoHours: '4' });

      const call = workItemRepo.update.mock.calls.find((c) => c[0] === 'task-1');
      // Only To Do changes; Estimate is left entirely to the client.
      expect(call?.[1]).not.toHaveProperty('estimateHours');
      expect(call?.[1]).toMatchObject({ todoHours: '4' });
    });

    /**
     * The BA's first clause, on the UPDATE path: "If the Owner enters `Estimate` first, the system
     * copies the same number of hours to `To Do` once" (Portfolio SRS:143).
     *
     * The create path did this and the update path did not, so estimating a task that already existed
     * left To Do empty and the planner typed the same number twice.
     */
    it('copies a FIRST Estimate into To Do, once', async () => {
      const task = mockWorkItem({ id: 'task-1', type: 'task', todoHours: null });
      workItemRepo.findById.mockResolvedValue(task);
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'task-1', type: 'task' }));

      await service.updateWorkItem(mockActor, 'task-1', { estimateHours: '6' });

      const call = workItemRepo.update.mock.calls.find((c) => c[0] === 'task-1');
      expect(call?.[1]).toMatchObject({ estimateHours: '6', todoHours: '6' });
    });

    it('does NOT re-copy once To Do has a value — including a deliberate 0', async () => {
      // "After that first copy, `Estimate`, `To Do` and `Actual` do not auto-recalculate each other"
      // (SRS:144). `0` is the case worth pinning: a completed task has exactly that, so treating it as
      // "unset" would undo the auto-zero, or overwrite a planner who typed 0 on purpose.
      for (const existingTodo of ['4', '0']) {
        workItemRepo.update.mockClear();
        workItemRepo.findById.mockResolvedValue(
          mockWorkItem({ id: 'task-1', type: 'task', todoHours: existingTodo }),
        );
        workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'task-1', type: 'task' }));

        await service.updateWorkItem(mockActor, 'task-1', { estimateHours: '9' });

        const call = workItemRepo.update.mock.calls.find((c) => c[0] === 'task-1');
        expect(call?.[1]).toMatchObject({ estimateHours: '9' });
        expect(call?.[1]).not.toHaveProperty('todoHours');
      }
    });

    it('lets the same patch set BOTH, without the copy interfering', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'task-1', type: 'task', todoHours: null }),
      );
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'task-1', type: 'task' }));

      await service.updateWorkItem(mockActor, 'task-1', { estimateHours: '8', todoHours: '3' });

      const call = workItemRepo.update.mock.calls.find((c) => c[0] === 'task-1');
      // An explicit To Do wins: the copy is a convenience for the field being LEFT OUT.
      expect(call?.[1]).toMatchObject({ estimateHours: '8', todoHours: '3' });
    });

    // ── Real Rally: completing a task auto-zeroes To Do; Estimate untouched ──
    it('auto-zeroes To Do when a task is completed, leaving Estimate untouched', async () => {
      const task = mockWorkItem({
        id: 'task-1',
        type: 'task',
        scheduleState: 'in_progress',
        todoHours: '3',
        actualHours: '2',
        estimateHours: '8',
        parentId: null,
      });
      workItemRepo.findById.mockResolvedValue(task);
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'task-1', type: 'task' }));

      await service.updateWorkItem(mockActor, 'task-1', { scheduleState: 'completed' });

      const call = workItemRepo.update.mock.calls.find((c) => c[0] === 'task-1');
      expect(call?.[1]).toMatchObject({ todoHours: '0' });
      expect(call?.[1]).not.toHaveProperty('estimateHours');
    });

    // ── Parent reassignment must obey the SAME hierarchy rules as create, so
    //    update can never back-door an invalid parent (the audit's GAP-2). ──
    // findById resolves BOTH the edited item and the candidate parent; route by id.
    const withItemAndParent = (
      item: ReturnType<typeof mockWorkItem>,
      parent: ReturnType<typeof mockWorkItem>,
    ) =>
      workItemRepo.findById.mockImplementation((id: string) =>
        Promise.resolve(id === item.id ? item : parent),
      );

    it('rejects moving a defect under a non-story parent', async () => {
      withItemAndParent(
        mockWorkItem({ id: 'de-1', type: 'defect', parentId: null }),
        mockWorkItem({ id: 'feat-1', type: 'task' }),
      );
      await expect(
        service.updateWorkItem(mockActor, 'de-1', { parentId: 'feat-1' }),
      ).rejects.toThrow(/user story/i);
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it('allows moving a defect under a story parent', async () => {
      withItemAndParent(
        mockWorkItem({ id: 'de-1', type: 'defect', parentId: null }),
        mockWorkItem({ id: 'story-1', type: 'story' }),
      );
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'de-1', type: 'defect' }));
      await service.updateWorkItem(mockActor, 'de-1', { parentId: 'story-1' });
      expect(workItemRepo.update).toHaveBeenCalled();
    });

    it('allows clearing a defect parent (null)', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'de-1', type: 'defect', parentId: 'story-1' }),
      );
      workItemRepo.update.mockResolvedValue(mockWorkItem({ id: 'de-1', type: 'defect' }));
      await service.updateWorkItem(mockActor, 'de-1', { parentId: null });
      expect(workItemRepo.update).toHaveBeenCalled();
    });

    it.each(['task'] as const)('rejects moving a task under a %s', async (parentType) => {
      withItemAndParent(
        mockWorkItem({ id: 'task-1', type: 'task', parentId: 'story-0' }),
        mockWorkItem({ id: 'p-1', type: parentType }),
      );
      await expect(
        service.updateWorkItem(mockActor, 'task-1', { parentId: 'p-1' }),
      ).rejects.toThrow(/user story or defect/i);
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it('rejects clearing a task parent (a task must belong to a work product)', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ id: 'task-1', type: 'task', parentId: 'story-0' }),
      );
      await expect(service.updateWorkItem(mockActor, 'task-1', { parentId: null })).rejects.toThrow(
        /must belong to a work product/i,
      );
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it.each(['story'] as const)(
      'rejects setting a parent on a %s via update (only tasks/defects have parents)',
      async (childType) => {
        withItemAndParent(
          mockWorkItem({ id: 'c-1', type: childType, parentId: null }),
          mockWorkItem({ id: 'p-1', type: 'story' }),
        );
        await expect(service.updateWorkItem(mockActor, 'c-1', { parentId: 'p-1' })).rejects.toThrow(
          /only defects and tasks/i,
        );
        expect(workItemRepo.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('deleteWorkItem', () => {
    it('soft-deletes the work item', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());

      await service.deleteWorkItem(mockActor, 'wi-1');

      expect(workItemRepo.softDelete).toHaveBeenCalledWith('wi-1', 'ws-1');
    });

    /**
     * INVERTED by `P3-QA-FR-020` (BA `c42df59`): "Soft delete retains child Tasks, attachments,
     * comments and relations … and performs no physical cascade delete."
     *
     * This used to assert the opposite — GAP-8 had the service delete the relations so none dangled
     * on the other item. That reason does not survive inspection: `listForItem` already filters
     * `isNull(other.deletedAt)` in both directions, so nothing dangled on screen either way, while
     * the cascade made the soft delete partly irreversible. The assertion is inverted rather than
     * deleted, because the behaviour is now the requirement.
     */
    it('RETAINS the item’s relations — a soft delete cascades nothing (P3-QA-FR-020)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1', type: 'story' }));

      await service.deleteWorkItem(mockActor, 'wi-1');

      expect(relationRepo.deleteForItem).not.toHaveBeenCalled();
    });

    it('records the actor and the action in the item’s own history (P3-QA-FR-020)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1', type: 'story' }));

      await service.deleteWorkItem(mockActor, 'wi-1');

      expect(activityRepo.log).toHaveBeenCalledWith(
        [expect.objectContaining({ action: 'work_item.deleted', actorId: mockActor.sub })],
        expect.anything(),
      );
    });

    it('throws when work item not found', async () => {
      workItemRepo.findById.mockResolvedValue(null);
      await expect(service.deleteWorkItem(mockActor, 'missing')).rejects.toThrow(NotFoundException);
    });

    /**
     * INVERTED by the BA's ruling of 2026-08-20 ("cannot delete defect in Backlog and Iteration
     * Status"). Phase 3.4 refused this for every principal; §3.2:81 gives `Quality / Defects` the verb
     * `Delete` in all three granted columns, and `server-role-matrix.e2e.spec.ts` had been recording
     * the pair as an unresolved mismatch inside the BA's own documents.
     *
     * The audit argument that carried the old rule does not decide it: this is a SOFT delete, so the
     * row and its activity history survive and the defect is invisible rather than erased.
     */
    it('DELETES a defect — §3.2:81 over Phase 3.4', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ type: 'defect', defectState: 'open' }),
      );

      await service.deleteWorkItem(mockActor, 'wi-1');

      expect(workItemRepo.softDelete).toHaveBeenCalledWith('wi-1', 'ws-1');
    });
  });

  // ── Relations (F6) ─────────────────────────────────────────────────────────

  describe('linkWorkItem', () => {
    it('rejects linking an item to itself', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1' }));
      await expect(service.linkWorkItem(mockActor, 'wi-1', 'wi-1', 'blocks')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(relationRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate relation', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      relationRepo.exists.mockResolvedValue(true);
      await expect(service.linkWorkItem(mockActor, 'wi-1', 'wi-2', 'relates_to')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(relationRepo.create).not.toHaveBeenCalled();
    });

    it('rejects the same relation in the reverse direction (GAP-7)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      // Forward (wi-1 → wi-2) does not exist, but the reverse (wi-2 → wi-1) does.
      relationRepo.exists.mockImplementation((src: string) => Promise.resolve(src === 'wi-2'));
      await expect(service.linkWorkItem(mockActor, 'wi-1', 'wi-2', 'blocks')).rejects.toThrow(
        /opposite direction/i,
      );
      expect(relationRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a relation that would create a dependency cycle (blocks)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      relationRepo.exists.mockResolvedValue(false);
      relationRepo.wouldCreateCycle.mockResolvedValue(true);
      await expect(service.linkWorkItem(mockActor, 'wi-1', 'wi-2', 'blocks')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(relationRepo.create).not.toHaveBeenCalled();
    });

    it('does NOT cycle-check associative relations (relates_to)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      relationRepo.exists.mockResolvedValue(false);
      await service.linkWorkItem(mockActor, 'wi-1', 'wi-2', 'relates_to');
      expect(relationRepo.wouldCreateCycle).not.toHaveBeenCalled();
      expect(relationRepo.create).toHaveBeenCalled();
    });

    it('creates the relation and returns the refreshed list', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      relationRepo.exists.mockResolvedValue(false);
      relationRepo.listForItem.mockResolvedValue([{ id: 'rel-1' }]);
      const result = await service.linkWorkItem(mockActor, 'wi-1', 'wi-2', 'depends_on');
      expect(relationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceItemId: 'wi-1',
          targetItemId: 'wi-2',
          relationType: 'depends_on',
        }),
        'ws-1',
        // The insert now runs on the caller's transaction, alongside its activity entry.
        expect.anything(),
      );
      expect(result).toEqual([{ id: 'rel-1' }]);
    });
  });

  describe('unlinkWorkItem', () => {
    it('throws when the relation does not exist', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      relationRepo.findById.mockResolvedValue(null);
      await expect(service.unlinkWorkItem(mockActor, 'wi-1', 'rel-x')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes a relation that touches the item', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1' }));
      relationRepo.findById.mockResolvedValue({
        id: 'rel-1',
        sourceItemId: 'wi-1',
        targetItemId: 'wi-2',
        relationType: 'blocks',
      });
      await service.unlinkWorkItem(mockActor, 'wi-1', 'rel-1');
      expect(relationRepo.delete).toHaveBeenCalledWith('rel-1', 'ws-1', expect.anything());
    });
  });

  // Note: per-route project authorization (create/edit/delete/view) now lives in
  // the PolicyGuard (@RequirePermission on the controller), covered by
  // policy.guard.spec.ts and the work-items e2e authz suite. The service no
  // longer calls assertProjectPermission for its primary route id — only for
  // SECONDARY targets a route-scoped guard cannot see (relation link target) and
  // the multi-project reorder batch, which are asserted in their own describes.

  // ── moveWorkItem ──────────────────────────────────────────────────────────

  describe('moveWorkItem', () => {
    it('validates transition and updates statusId', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ statusId: 'status-todo' }));
      workItemRepo.update.mockResolvedValue(mockWorkItem({ statusId: 'status-done' }));

      const result = await service.moveWorkItem(mockActor, 'wi-1', 'status-done');

      expect(projectsService.assertTransitionAllowed).toHaveBeenCalledWith(
        'proj-1',
        'status-todo',
        'status-done',
      );
      expect(workItemRepo.update).toHaveBeenCalledWith(
        'wi-1',
        expect.objectContaining({ statusId: 'status-done', updatedBy: 'user-1' }),
        'ws-1',
        expect.anything(),
      );
      expect(result.statusId).toBe('status-done');
    });
  });

  // ── reorderWorkItems ───────────────────────────────────────────────────────

  describe('reorderWorkItems', () => {
    it('skips when items array is empty', async () => {
      await service.reorderWorkItems(mockActor, []);
      expect(workItemRepo.reorderItems).not.toHaveBeenCalled();
    });

    it('validates each item belongs to workspace before reordering', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      await service.reorderWorkItems(mockActor, [{ id: 'wi-1', rank: 'b1' }]);
      expect(workItemRepo.reorderItems).toHaveBeenCalledWith(
        [{ id: 'wi-1', rank: 'b1' }],
        'ws-1',
        expect.anything(),
      );
    });
  });

  // ── labels ────────────────────────────────────────────────────────────────

  describe('label management', () => {
    beforeEach(() => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
    });

    it('getWorkItemLabels returns labels for work item', async () => {
      workItemRepo.listLabels.mockResolvedValue([{ id: 'l1', name: 'bug', color: '#f00' }]);
      const result = await service.getWorkItemLabels(mockActor, 'wi-1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('bug');
    });

    it('addLabelToWorkItem adds label', async () => {
      await service.addLabelToWorkItem(mockActor, 'wi-1', 'l1');
      expect(workItemRepo.addLabel).toHaveBeenCalledWith('wi-1', 'l1', 'ws-1');
    });

    it('addLabelToWorkItem validates label belongs to project (P1-15)', async () => {
      projectsService.assertLabelBelongsToProject.mockRejectedValueOnce(
        new Error('LABEL_NOT_IN_PROJECT'),
      );
      await expect(service.addLabelToWorkItem(mockActor, 'wi-1', 'bad-label')).rejects.toThrow(
        'LABEL_NOT_IN_PROJECT',
      );
    });

    it('removeLabelFromWorkItem removes label', async () => {
      await service.removeLabelFromWorkItem(mockActor, 'wi-1', 'l1');
      expect(workItemRepo.removeLabel).toHaveBeenCalledWith('wi-1', 'l1', 'ws-1');
    });
  });

  // ── Milestones (the artifact-link rule has ONE home) ──────────────────────
  //
  // `PUT /work-items/:id/milestones` and `PUT /milestones/:id/artifacts` write the same
  // `milestone_artifacts` rows. This side used to run its own project-only check, so a Task
  // could be made an artifact and a Team-scoped Milestone would take any item — refusals the
  // other endpoint had always enforced. It now delegates to the rule's owner.

  describe('setWorkItemMilestones', () => {
    it('hands the item to the milestone-artifact scope rule (P23-07)', async () => {
      const item = mockWorkItem({ id: 'wi-1', projectId: 'proj-1', teamId: 'team-a' });
      workItemRepo.findById.mockResolvedValue(item);

      await service.setWorkItemMilestones(mockActor, 'wi-1', ['ms-1', 'ms-1', 'ms-2']);

      expect(milestonesService.assertArtifactsAssignable).toHaveBeenCalledWith(
        'ws-1',
        ['ms-1', 'ms-2'],
        [item],
      );
      expect(workItemRepo.setMilestones).toHaveBeenCalledWith('wi-1', ['ms-1', 'ms-2']);
    });

    it('writes nothing when the rule refuses (task, team scope or project scope)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ type: 'task', parentId: 'wi-9' }));
      milestonesService.assertArtifactsAssignable.mockRejectedValueOnce(
        new PreconditionFailedException('MILESTONE_INVALID_ARTIFACT_TYPE', 'not an artifact type'),
      );

      await expect(service.setWorkItemMilestones(mockActor, 'wi-1', ['ms-1'])).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(workItemRepo.setMilestones).not.toHaveBeenCalled();
    });

    it('clears the set without consulting the rule (nothing to scope)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      await service.setWorkItemMilestones(mockActor, 'wi-1', []);
      expect(milestonesService.assertArtifactsAssignable).not.toHaveBeenCalled();
      expect(workItemRepo.setMilestones).toHaveBeenCalledWith('wi-1', []);
    });
  });

  // ── Attachments: the link, the file and the history are one write ──────────

  describe('attachment writes', () => {
    beforeEach(() => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ projectId: 'proj-1' }));
    });

    it('records attachment.uploaded INSIDE the confirm transaction (P01-04)', async () => {
      await service.confirmAttachment(mockActor, 'wi-1', 'file-1');

      expect(attachmentRepo.link).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file-1', entityType: 'work_item' }),
        expect.anything(),
      );
      expect(activityRepo.log).toHaveBeenCalledWith(
        [expect.objectContaining({ action: 'attachment.uploaded' })],
        { tx: expect.anything() },
      );
      // Fire-and-forget is the defect: a lost history entry must fail the write, not warn.
      expect(activityRepo.logSafe).not.toHaveBeenCalled();
    });

    it('records attachment.deleted INSIDE the delete transaction (P01-04)', async () => {
      attachmentRepo.findByEntityAndFile.mockResolvedValue({
        id: 'file-1',
        uploadedBy: mockActor.sub,
        filename: 'f.txt',
      });

      await service.deleteAttachment(mockActor, 'wi-1', 'file-1');

      expect(attachmentRepo.unlink).toHaveBeenCalledWith(
        { entityType: 'work_item', entityId: 'wi-1' },
        'file-1',
        'ws-1',
        expect.anything(),
      );
      expect(attachmentsService.softDelete).toHaveBeenCalledWith('file-1', expect.anything());
      expect(activityRepo.log).toHaveBeenCalledWith(
        [expect.objectContaining({ action: 'attachment.deleted' })],
        { tx: expect.anything() },
      );
      expect(activityRepo.logSafe).not.toHaveBeenCalled();
    });

    it("lets a per-Project Admin delete a teammate's attachment (P01-03)", async () => {
      attachmentRepo.findByEntityAndFile.mockResolvedValue({
        id: 'file-1',
        uploadedBy: 'someone-else',
        filename: 'f.txt',
      });
      // No workspace grant — the authority is the project access level alone.
      accessService.getProjectAccessLevel.mockResolvedValue('admin');

      await service.deleteAttachment(mockActor, 'wi-1', 'file-1');

      expect(accessService.getProjectAccessLevel).toHaveBeenCalledWith('ws-1', 'user-1', 'proj-1');
      expect(attachmentRepo.unlink).toHaveBeenCalled();
    });

    it("refuses an Editor deleting someone else's attachment", async () => {
      attachmentRepo.findByEntityAndFile.mockResolvedValue({
        id: 'file-1',
        uploadedBy: 'someone-else',
        filename: 'f.txt',
      });
      accessService.getProjectAccessLevel.mockResolvedValue('editor');

      await expect(service.deleteAttachment(mockActor, 'wi-1', 'file-1')).rejects.toThrow(
        PermissionDeniedException,
      );
      expect(attachmentRepo.unlink).not.toHaveBeenCalled();
    });
  });

  // ── P1-15 scope validation ────────────────────────────────────────────────

  describe('P1-15 scope validation', () => {
    it('createWorkItem validates assignee is workspace member', async () => {
      projectsService.assertWorkspaceMember.mockRejectedValueOnce(new Error('ASSIGNEE_NOT_MEMBER'));
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'story', 'Story', {
          assigneeId: 'not-a-member',
        }),
      ).rejects.toThrow('ASSIGNEE_NOT_MEMBER');
    });

    it('updateWorkItem validates new assignee is workspace member', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem());
      projectsService.assertWorkspaceMember.mockRejectedValueOnce(new Error('ASSIGNEE_NOT_MEMBER'));
      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { assigneeId: 'outsider' }),
      ).rejects.toThrow('ASSIGNEE_NOT_MEMBER');
    });

    it('createWorkItem validates parentId belongs to same project', async () => {
      workItemRepo.findById.mockResolvedValueOnce(null); // first call: parent not found
      await expect(
        service.createWorkItem(mockActor, 'proj-1', 'story', 'Story', {
          parentId: 'bad-parent',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── Phase 2: inline scope validation ─────────────────────────────────────

  describe('inline assignment scope validation', () => {
    it('rejects iteration from a different project', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ projectId: 'proj-1' }));
      workItemRepo.findIterationScope.mockResolvedValue({ projectId: 'proj-2', teamId: null });
      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { iterationId: 'it-x' }),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('rejects a team-scoped iteration whose team differs from the item team', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ teamId: 'team-a' }));
      workItemRepo.findIterationScope.mockResolvedValue({
        projectId: 'proj-1',
        teamId: 'team-b',
      });
      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { iterationId: 'it-x' }),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('allows a team-agnostic iteration onto any team item', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ teamId: 'team-a' }));
      workItemRepo.findIterationScope.mockResolvedValue({ projectId: 'proj-1', teamId: null });
      workItemRepo.update.mockResolvedValue(mockWorkItem({ iterationId: 'it-x' }));
      const res = await service.updateWorkItem(mockActor, 'wi-1', { iterationId: 'it-x' });
      expect(res.iterationId).toBe('it-x');
    });

    /**
     * P6-VEL-004: moving a Story INTO a CLOSED (accepted) iteration, and back out again.
     *
     * The scope lookup is `{ projectId, teamId }` — `findIterationScope` selects those two columns and
     * no `state` — so the write path is state-blind BY CONSTRUCTION and the picker was the only thing
     * refusing a closed sprint. This asserts it from the service's side: had the guard ever grown a
     * lifecycle condition, the eligibility feed would be offering a target the API rejects, which is
     * the same disagreement in the other direction.
     *
     * Velocity needs nothing else to change: it reads `work_items.iteration_id` live, so the next query
     * moves the bar with no snapshot rebuild (Phase 6 §5.2).
     */
    it('assigns a CLOSED iteration, and unassigns back to the Backlog', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ storyPoints: '5', scheduleState: 'in_progress' }),
      );
      // What the repository can tell the guard about a timebox. No `state` field exists here.
      workItemRepo.findIterationScope.mockResolvedValue({ projectId: 'proj-1', teamId: null });
      workItemRepo.update.mockResolvedValue(mockWorkItem({ iterationId: 'it-closed' }));

      const assigned = await service.updateWorkItem(mockActor, 'wi-1', {
        iterationId: 'it-closed',
      });
      expect(assigned.iterationId).toBe('it-closed');

      // And out again — the `--` / Backlog choice, which must not consult a timebox at all.
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ iterationId: 'it-closed', storyPoints: '5' }),
      );
      workItemRepo.findIterationScope.mockClear();
      workItemRepo.update.mockResolvedValue(mockWorkItem({ iterationId: null }));

      const cleared = await service.updateWorkItem(mockActor, 'wi-1', { iterationId: null });
      expect(cleared.iterationId).toBeNull();
      expect(workItemRepo.findIterationScope).not.toHaveBeenCalled();
    });

    /**
     * P6-VEL-004 AC5: changing the Iteration changes NOTHING else.
     *
     * Schedule State, Flow State and `accepted_date` must survive the move. The first two are only
     * written when the patch names one (the BR-WI-01 mirror), and `work_items.accepted_date` is
     * maintained by `trg_sync_accepted_date` off a schedule-state change — so the property to assert is
     * that the persisted patch carries the iteration and the actor and nothing more. A field appearing
     * in this payload is a field the trigger would then react to.
     */
    it('writes ONLY the iteration — no schedule state, flow state or acceptance stamp', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ scheduleState: 'accepted', flowState: 'accepted', storyPoints: '5' }),
      );
      workItemRepo.findIterationScope.mockResolvedValue({ projectId: 'proj-1', teamId: null });
      workItemRepo.update.mockResolvedValue(mockWorkItem({ iterationId: 'it-closed' }));

      await service.updateWorkItem(mockActor, 'wi-1', { iterationId: 'it-closed' });

      expect(workItemRepo.update).toHaveBeenCalledTimes(1);
      const patch = workItemRepo.update.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(patch).sort()).toEqual(['iterationId', 'updatedBy']);
      expect(patch.iterationId).toBe('it-closed');
    });

    it('rejects a release from another project', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ projectId: 'proj-1' }));
      workItemRepo.findReleaseProject.mockResolvedValue('proj-2');
      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { releaseId: 'rel-x' }),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('rejects a foundInReleaseId from another project', async () => {
      workItemRepo.findById.mockResolvedValue(
        mockWorkItem({ projectId: 'proj-1', type: 'defect' }),
      );
      workItemRepo.findReleaseProject.mockResolvedValue('proj-2');
      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { foundInReleaseId: 'rel-x' }),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('rejects a new reporterId who is not a workspace member', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ reporterId: 'user-1' }));
      projectsService.assertWorkspaceMember.mockRejectedValueOnce(new Error('NOT_MEMBER'));
      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { reporterId: 'outsider' }),
      ).rejects.toThrow('NOT_MEMBER');
    });

    it('rejects a new devOwnerId who is not a workspace member', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ type: 'defect', devOwnerId: null }));
      projectsService.assertWorkspaceMember.mockRejectedValueOnce(new Error('NOT_MEMBER'));
      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { devOwnerId: 'outsider' }),
      ).rejects.toThrow('NOT_MEMBER');
    });

    it('rejects priority edits on stories', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ type: 'story' }));
      await expect(service.updateWorkItem(mockActor, 'wi-1', { priority: 'high' })).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('rejects reassigning to a team not linked to the project', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ projectId: 'proj-1' }));
      projectsService.listProjectTeams.mockResolvedValue([]);
      await expect(service.updateWorkItem(mockActor, 'wi-1', { teamId: 'team-x' })).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('allows reassigning to a team linked to the project', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ projectId: 'proj-1' }));
      projectsService.listProjectTeams.mockResolvedValue([{ teamId: 'team-x', status: 'active' }]);
      workItemRepo.update.mockResolvedValue(mockWorkItem({ teamId: 'team-x' }));
      const res = await service.updateWorkItem(mockActor, 'wi-1', { teamId: 'team-x' });
      expect(res.teamId).toBe('team-x');
    });
  });

  // ── Phase 2: bulk assignment (all-or-nothing) ────────────────────────────

  describe('bulkAssignIteration', () => {
    it('fails the whole request if any item is missing', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'a' })]); // asked for 2
      await expect(
        service.bulkAssignIteration(mockActor, 'proj-1', ['a', 'b'], 'it-1'),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.assignIteration).not.toHaveBeenCalled();
    });

    it('rejects non-story/defect items', async () => {
      workItemRepo.findByIds.mockResolvedValue([
        mockWorkItem({ id: 'a', type: 'story' }),
        mockWorkItem({ id: 'b', type: 'task' }),
      ]);
      await expect(
        service.bulkAssignIteration(mockActor, 'proj-1', ['a', 'b'], 'it-1'),
      ).rejects.toThrow(PreconditionFailedException);
      expect(workItemRepo.assignIteration).not.toHaveBeenCalled();
    });

    it('rejects if an item is out of the given project', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'a', projectId: 'proj-2' })]);
      await expect(service.bulkAssignIteration(mockActor, 'proj-1', ['a'], null)).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it('unassigns (null) without touching iteration scope lookup', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'a', type: 'story' })]);
      const n = await service.bulkAssignIteration(mockActor, 'proj-1', ['a'], null);
      expect(n).toBe(1);
      expect(workItemRepo.findIterationScope).not.toHaveBeenCalled();
      expect(workItemRepo.assignIteration).toHaveBeenCalledWith(
        ['a'],
        null,
        'ws-1',
        'user-1',
        expect.anything(),
      );
    });

    it('assigns a valid iteration to all items', async () => {
      workItemRepo.findByIds.mockResolvedValue([
        mockWorkItem({ id: 'a', type: 'story' }),
        mockWorkItem({ id: 'b', type: 'defect' }),
      ]);
      workItemRepo.findIterationScope.mockResolvedValue({ projectId: 'proj-1', teamId: null });
      const n = await service.bulkAssignIteration(mockActor, 'proj-1', ['a', 'b'], 'it-1');
      expect(n).toBe(2);
      expect(workItemRepo.assignIteration).toHaveBeenCalledWith(
        ['a', 'b'],
        'it-1',
        'ws-1',
        'user-1',
        expect.anything(),
      );
    });
  });

  describe('bulkAssignRelease', () => {
    it('rejects a release from another project', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'a' })]);
      workItemRepo.findReleaseProject.mockResolvedValue('proj-2');
      await expect(service.bulkAssignRelease(mockActor, 'proj-1', ['a'], 'rel-1')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(workItemRepo.assignRelease).not.toHaveBeenCalled();
    });

    it('assigns a valid release', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'a' })]);
      workItemRepo.findReleaseProject.mockResolvedValue('proj-1');
      const n = await service.bulkAssignRelease(mockActor, 'proj-1', ['a'], 'rel-1');
      expect(n).toBe(1);
      expect(workItemRepo.assignRelease).toHaveBeenCalled();
    });
  });

  // ── Phase 2: neighbour rank ──────────────────────────────────────────────

  describe('rankWorkItem', () => {
    it('computes a rank between two neighbours', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1', rank: 'zzz' }));
      workItemRepo.findByIds.mockResolvedValue([
        mockWorkItem({ id: 'before', rank: 'a' }),
        mockWorkItem({ id: 'after', rank: 'c' }),
      ]);
      workItemRepo.update.mockImplementation((_id, input) =>
        Promise.resolve(mockWorkItem({ id: 'wi-1', rank: input.rank })),
      );
      const res = await service.rankWorkItem(mockActor, 'wi-1', {
        projectId: 'proj-1',
        beforeId: 'before',
        afterId: 'after',
      });
      expect(res.rank > 'a' && res.rank < 'c').toBe(true);
    });

    it('appends to the end when afterId is null', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1' }));
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'before', rank: 'm' })]);
      workItemRepo.update.mockImplementation((_id, input) =>
        Promise.resolve(mockWorkItem({ id: 'wi-1', rank: input.rank })),
      );
      const res = await service.rankWorkItem(mockActor, 'wi-1', {
        projectId: 'proj-1',
        beforeId: 'before',
        afterId: null,
      });
      expect(res.rank > 'm').toBe(true);
    });

    it('rejects a neighbour from a different project', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1' }));
      workItemRepo.findByIds.mockResolvedValue([
        mockWorkItem({ id: 'before', projectId: 'proj-2', rank: 'a' }),
      ]);
      await expect(
        service.rankWorkItem(mockActor, 'wi-1', {
          projectId: 'proj-1',
          beforeId: 'before',
          afterId: null,
        }),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it('rejects when neighbours are out of order (stale view)', async () => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1' }));
      workItemRepo.findByIds.mockResolvedValue([
        mockWorkItem({ id: 'before', rank: 'c' }),
        mockWorkItem({ id: 'after', rank: 'a' }),
      ]);
      await expect(
        service.rankWorkItem(mockActor, 'wi-1', {
          projectId: 'proj-1',
          beforeId: 'before',
          afterId: 'after',
        }),
      ).rejects.toThrow(PreconditionFailedException);
    });
  });

  /**
   * PRJ-03. Create, update and delete reached the archived-project rule through a PRIVATE COPY of
   * `ProjectsService.assertProjectWritable` in this class; the ~17 secondary writes below reached
   * neither the copy nor the original. So on an archived project a Story could not be edited but
   * could still be relinked, reranked, relabelled, bulk-assigned to another release or iteration,
   * given time logs, and have files attached and deleted.
   *
   * The copy is now a one-line delegation, which is the actual fix: a second home for one rule is
   * what let the two drift for as long as they did.
   *
   * `watch` / `unwatch` are deliberately EXCLUDED — see the note above them in the service. A
   * watcher row is the reader's own subscription, and the withdrawal has to keep working.
   */
  describe('an archived project refuses every secondary write (PRJ-FR-010)', () => {
    beforeEach(() => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ id: 'wi-1', projectId: 'proj-1' }));
      projectsService.assertProjectWritable.mockRejectedValue(
        new PreconditionFailedException('PROJECT_ARCHIVED', 'archived'),
      );
    });

    it('refuses a relation link', async () => {
      await expect(service.linkWorkItem(mockActor, 'wi-1', 'wi-2', 'blocks')).rejects.toMatchObject(
        { code: 'PROJECT_ARCHIVED' },
      );
      expect(relationRepo.create).not.toHaveBeenCalled();
    });

    it('refuses an unlink', async () => {
      relationRepo.findById.mockResolvedValue({
        id: 'rel-1',
        sourceItemId: 'wi-1',
        targetItemId: 'wi-2',
        relationType: 'blocks',
      });
      await expect(service.unlinkWorkItem(mockActor, 'wi-1', 'rel-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(relationRepo.delete).not.toHaveBeenCalled();
    });

    it('refuses a backlog reorder', async () => {
      await expect(
        service.reorderWorkItems(mockActor, [{ id: 'wi-1', rank: 'b' }]),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(workItemRepo.reorderItems).not.toHaveBeenCalled();
    });

    it('refuses a single-item rank change', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'before', rank: 'a' })]);
      await expect(
        service.rankWorkItem(mockActor, 'wi-1', { projectId: 'proj-1', beforeId: 'before' }),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it('refuses a bulk release assignment', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'wi-1' })]);
      await expect(
        service.bulkAssignRelease(mockActor, 'proj-1', ['wi-1'], 'rel-1'),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(workItemRepo.assignRelease).not.toHaveBeenCalled();
    });

    it('refuses a bulk iteration assignment', async () => {
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'wi-1', type: 'story' })]);
      await expect(
        service.bulkAssignIteration(mockActor, 'proj-1', ['wi-1'], 'it-1'),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(workItemRepo.assignIteration).not.toHaveBeenCalled();
    });

    it('refuses adding and removing a label', async () => {
      // The label CATALOGUE was already guarded in `ProjectsService`; the ASSIGNMENT was not, so
      // labels could not be created on an archived project but could still be applied.
      await expect(service.addLabelToWorkItem(mockActor, 'wi-1', 'lbl-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      await expect(
        service.removeLabelFromWorkItem(mockActor, 'wi-1', 'lbl-1'),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(workItemRepo.addLabel).not.toHaveBeenCalled();
      expect(workItemRepo.removeLabel).not.toHaveBeenCalled();
    });

    it('refuses a milestone-artifact set', async () => {
      await expect(
        service.setWorkItemMilestones(mockActor, 'wi-1', ['ms-1']),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(workItemRepo.setMilestones).not.toHaveBeenCalled();
    });

    it('refuses logging, editing and deleting time', async () => {
      timeLogRepo.findById.mockResolvedValue({
        id: 'tl-1',
        workItemId: 'wi-1',
        userId: 'user-1',
      });
      await expect(
        service.logTime(mockActor, 'wi-1', { loggedDate: '2026-08-14', hours: '2.00' }),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      await expect(
        service.updateTimeLog(mockActor, 'wi-1', 'tl-1', { hours: '3.00' }),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      await expect(service.deleteTimeLog(mockActor, 'wi-1', 'tl-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(timeLogRepo.create).not.toHaveBeenCalled();
      expect(timeLogRepo.update).not.toHaveBeenCalled();
      expect(timeLogRepo.softDelete).not.toHaveBeenCalled();
    });

    it('refuses an attachment at PRESIGN, not only at confirm', async () => {
      // Letting presign through would put bytes in the bucket for a project that accepts no
      // content and leave the reserved `storage.files` row to the reaper.
      await expect(
        service.presignAttachment(mockActor, 'wi-1', {
          filename: 'f.txt',
          mimeType: 'text/plain',
          sizeBytes: 10,
          checksumSha256: 'abc',
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED' });
      expect(attachmentsService.presign).not.toHaveBeenCalled();
    });

    it('refuses an attachment confirm and delete', async () => {
      attachmentRepo.findByEntityAndFile.mockResolvedValue({
        fileId: 'file-1',
        uploadedBy: 'user-1',
        filename: 'f.txt',
      });
      await expect(service.confirmAttachment(mockActor, 'wi-1', 'file-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      await expect(service.deleteAttachment(mockActor, 'wi-1', 'file-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(attachmentRepo.link).not.toHaveBeenCalled();
      expect(attachmentRepo.unlink).not.toHaveBeenCalled();
    });

    it('still lets a reader UNWATCH — the subscription is theirs, not the content', async () => {
      // Deliberate exception, same judgement as the three project MEMBER writes: revocation must
      // stay possible or a user receives an archived project's notifications with no way to stop.
      await expect(service.unwatch(mockActor, 'wi-1')).resolves.toBeUndefined();
      expect(watcherRepo.unwatch).toHaveBeenCalledWith('wi-1', 'user-1');
      await expect(service.watch(mockActor, 'wi-1')).resolves.toBeUndefined();
    });

    it('still READS the item and its attachments — read-only, not invisible', async () => {
      await expect(service.getWorkItem('ws-1', 'wi-1')).resolves.toMatchObject({ id: 'wi-1' });
      await expect(service.listAttachments(mockActor, 'wi-1')).resolves.toEqual([]);
    });
  });
  /**
   * BL §8:294 — "Editor may manage US/DE/Task only in explicitly assigned Teams and cannot assign
   * Release." Field-level, because the route is gated on `work_item:edit`, which an Editor legitimately
   * holds for every other field in the same body.
   *
   * This is asserted NOW because it only just became reachable. `GET /releases` required
   * `release:view`, which an Editor does not hold, so the release picker resolved to `[]` and the UI
   * could not produce a `releaseId` — the rule was failing closed BY ACCIDENT. Splitting off a
   * reference feed an Editor can read (so a released item stops rendering as unscheduled) removed the
   * accident, and a change that turns a latent over-permissive write into a live one has to close it.
   */
  describe('assigning a Release is admin-only (BL §8:294)', () => {
    it('refuses the field when the actor cannot see releases, and does not write', async () => {
      const denied = new PermissionDeniedException('PROJECT_PERMISSION_DENIED', 'no release:view');
      accessService.assertProjectPermission.mockImplementation(
        async (_actor: unknown, _projectId: string, code: string) => {
          if (code === 'release:view') throw denied;
        },
      );
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ releaseId: null }));

      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { releaseId: 'rel-1' }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it('refuses CLEARING a release too — an Editor does not decide release membership either', async () => {
      const denied = new PermissionDeniedException('PROJECT_PERMISSION_DENIED', 'no release:view');
      accessService.assertProjectPermission.mockImplementation(
        async (_actor: unknown, _projectId: string, code: string) => {
          if (code === 'release:view') throw denied;
        },
      );
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ releaseId: 'rel-1' }));

      await expect(
        service.updateWorkItem(mockActor, 'wi-1', { releaseId: null }),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it('refuses the BULK path too, and before the release is even resolved', async () => {
      // Two write paths reach the same field, so a gate on one is not a gate. Ordered ahead of
      // `assertReleaseAssignable` deliberately: a denied caller must not learn which release ids exist
      // from a RELEASE_NOT_FOUND.
      const denied = new PermissionDeniedException('PROJECT_PERMISSION_DENIED', 'no release:view');
      accessService.assertProjectPermission.mockImplementation(
        async (_actor: unknown, _projectId: string, code: string) => {
          if (code === 'release:view') throw denied;
        },
      );
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'wi-1' })]);

      await expect(
        service.bulkAssignRelease(mockActor, 'proj-1', ['wi-1'], 'rel-1'),
      ).rejects.toMatchObject({ code: 'PROJECT_PERMISSION_DENIED' });
      expect(workItemRepo.assignRelease).not.toHaveBeenCalled();
      expect(workItemRepo.findReleaseProject).not.toHaveBeenCalled();
    });

    it('does NOT consult the rule when the patch leaves the release alone', async () => {
      // The half a denial-only test cannot see: an ordinary edit on an item that already sits in a
      // release must not be refused, or every Editor loses the rest of the form.
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ releaseId: 'rel-1' }));
      workItemRepo.update.mockResolvedValue(mockWorkItem({ releaseId: 'rel-1', title: 'Renamed' }));

      await service.updateWorkItem(mockActor, 'wi-1', { title: 'Renamed' });

      expect(accessService.assertProjectPermission).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'release:view',
      );
    });
  });

  /**
   * Home's two aggregates are scoped by `listReadableProjectIds` — GAP-P4-RBAC-003, AC4.
   *
   * They were not, and `GET /work-items/summary`'s own `@AuthorizedInService` decorator said they
   * were, which is the exact false citation `listProjectHealth` carried until an e2e spec was written
   * for it. A decorator is a note; this is the check. Home was therefore the one surface that still
   * reported a project after a Workspace Admin removed the reader's access to it: the active-sprint,
   * open-work-item, blocked and open-defect totals, plus My Work's item titles and project names.
   * Phase 4 `02_Roles_Permissions/SRS.md` §2.2 and §6 put an unassigned project out of navigation,
   * selectors, search AND results.
   *
   * BOTH sentinel directions are asserted, because either alone passes for the wrong reason: a test
   * that only proves an array is forwarded also passes when `null` is forwarded as `[]` (which fails
   * closed — a Workspace Admin's Home would read all zeros), and one that only proves `null` reaches
   * the repository never observes any narrowing at all.
   */
  describe('Home aggregates are scoped to the readable projects (GAP-P4-RBAC-003 AC4)', () => {
    it('passes the readable project ids to the summary query', async () => {
      accessService.listReadableProjectIds.mockResolvedValue(['proj-1']);

      await service.getWorkspaceSummary(mockActor);

      expect(accessService.listReadableProjectIds).toHaveBeenCalledWith(
        'ws-1',
        'user-1',
        'project:view',
      );
      expect(workItemRepo.getWorkspaceSummary).toHaveBeenCalledWith(
        'ws-1',
        'user-1',
        ['proj-1'],
        // No project narrowed: `resolveTeamScope` answers unrestricted for this caller.
        [],
      );
    });

    it('passes the readable project ids to My Work', async () => {
      // `@SelfScoped` bounds WHOSE items these are, not which projects they may be read in — an item
      // stays assigned to a user after their access to its project is removed.
      accessService.listReadableProjectIds.mockResolvedValue(['proj-1']);

      await service.listMyWork(mockActor, 10);

      expect(workItemRepo.listMyWork).toHaveBeenCalledWith(
        'ws-1',
        'user-1',
        { limit: 10 },
        ['proj-1'],
        [],
      );
    });

    it('forwards an EMPTY scope as an empty array, not as unrestricted', async () => {
      // A No Access principal — no active `project_members` row (SRS §1). Flattening this to `null`
      // would hand them the whole workspace, which is the leak.
      accessService.listReadableProjectIds.mockResolvedValue([]);

      await service.getWorkspaceSummary(mockActor);

      expect(workItemRepo.getWorkspaceSummary).toHaveBeenCalledWith('ws-1', 'user-1', [], []);
    });

    it('forwards the UNRESTRICTED sentinel as `null`, not as an empty array', async () => {
      // A Workspace Admin. Flattening `null` to `[]` fails closed and would show them all zeros.
      accessService.listReadableProjectIds.mockResolvedValue(null);

      await service.getWorkspaceSummary(mockActor);
      await service.listMyWork(mockActor, 10);

      expect(workItemRepo.getWorkspaceSummary).toHaveBeenCalledWith('ws-1', 'user-1', null, []);
      expect(workItemRepo.listMyWork).toHaveBeenCalledWith(
        'ws-1',
        'user-1',
        { limit: 10 },
        null,
        [],
      );
    });
  });
  /**
   * THE READ HALF of the Editor Team scope (`GAP-P4-RBAC-003`, BA ruling 2026-08-17): "Null means
   * Project Backlog, accessible only to Workspace Admin and Project Admin. Editor … cannot access
   * team-less items. Enforce this consistently in API queries, lists, reports, search, pickers and
   * direct URLs."
   *
   * The three rules a caller must never break are pinned here — no predicate for an unrestricted
   * reader, the Editor's own ids for a restricted one, and `[]` forwarded AS `[]` so the read returns
   * nothing instead of everything. What `[]` then does to the SQL, and that `team_id IN (…)` excludes a
   * team-less row rather than admitting it, is pinned in `../domain/team-read-scope.spec.ts`.
   */
  describe('Editor Team scope on the reads (GAP-P4-RBAC-003)', () => {
    const ALPHA = { unrestricted: false, teamIds: ['team-alpha'] };
    const NO_TEAM = { unrestricted: false, teamIds: [] };
    const ARGS = { limit: 20, cursor: null };
    const EMPTY_PAGE = { data: [], pageInfo: { nextCursor: null, hasNextPage: false, limit: 20 } };

    const relationView = (id: string, itemKey: string) => ({
      id: `rel-${id}`,
      relationType: 'relates_to' as const,
      direction: 'outbound' as const,
      label: 'Relates to',
      relatedItem: {
        id,
        itemKey,
        title: `Title of ${itemKey}`,
        type: 'story',
        scheduleState: 'defined',
      },
      createdAt: now,
    });

    beforeEach(() => {
      workItemRepo.findById.mockResolvedValue(mockWorkItem({ teamId: 'team-alpha' }));
      workItemRepo.listBacklog.mockResolvedValue(EMPTY_PAGE);
      workItemRepo.listByProject.mockResolvedValue(EMPTY_PAGE);
      workItemRepo.listTasksByParent.mockResolvedValue([]);
      workItemRepo.getTaskTotals.mockResolvedValue({
        taskCount: 0,
        estimateHours: 0,
        todoHours: 0,
        actualHours: 0,
      });
      workItemRepo.listLabels.mockResolvedValue([]);
      watcherRepo.listByWorkItem.mockResolvedValue([]);
      timeLogRepo.listByWorkItem.mockResolvedValue({ items: [], total: 0 });
    });

    it('passes the UNRESTRICTED answer to the Backlog query, so no predicate is added', async () => {
      await service.listBacklog(mockActor, 'proj-1', {}, ARGS);

      expect(accessService.resolveTeamScope).toHaveBeenCalledWith('ws-1', 'user-1', 'proj-1');
      expect(workItemRepo.listBacklog).toHaveBeenCalledWith('proj-1', 'ws-1', {}, ARGS, {
        unrestricted: true,
      });
    });

    it("narrows the Backlog to the Editor's own Teams", async () => {
      accessService.resolveTeamScope.mockResolvedValue(ALPHA);

      await service.listBacklog(mockActor, 'proj-1', {}, ARGS);

      expect(workItemRepo.listBacklog).toHaveBeenCalledWith('proj-1', 'ws-1', {}, ARGS, ALPHA);
    });

    it('forwards an EMPTY team scope as empty — never flattened into unrestricted', async () => {
      // The `listReadableProjectIds` `null`-versus-`[]` mistake in a second place: an Editor with no
      // active Team must read NOTHING, and "no ids" is one keystroke from "no filter".
      accessService.resolveTeamScope.mockResolvedValue(NO_TEAM);

      await service.listBacklog(mockActor, 'proj-1', {}, ARGS);

      const scope = workItemRepo.listBacklog.mock.calls[0][4] as {
        unrestricted: boolean;
        teamIds: string[];
      };
      expect(scope.unrestricted).toBe(false);
      expect(scope.teamIds).toEqual([]);
    });

    it('scopes the project list, which is also the SEARCH query', async () => {
      // `q` is the work-item search: it is a filter on this same list, so the boundary is the same one.
      accessService.resolveTeamScope.mockResolvedValue(ALPHA);

      await service.listWorkItems(mockActor, 'proj-1', { q: 'US' }, ARGS);

      expect(workItemRepo.listByProject).toHaveBeenCalledWith(
        'proj-1',
        'ws-1',
        { q: 'US' },
        ARGS,
        ALPHA,
      );
    });

    it('narrows the Tasks tab and its totals in the SAME scope', async () => {
      accessService.resolveTeamScope.mockResolvedValue(ALPHA);

      await service.listTasks(mockActor, 'wi-1');
      await service.getTaskTotals(mockActor, 'wi-1');

      expect(workItemRepo.listTasksByParent).toHaveBeenCalledWith('wi-1', 'ws-1', ALPHA);
      expect(workItemRepo.getTaskTotals).toHaveBeenCalledWith('wi-1', 'ws-1', ALPHA);
    });

    /**
     * Every per-item SUB-RESOURCE read goes through the scope, not just `GET /work-items/:id`.
     * `PolicyGuard`'s `resource: 'work_item'` resolves the row's PROJECT only, so before this an Editor
     * refused a Team Beta Story could still read its history, links, hours, watchers and attachments.
     */
    const scopedReads: Array<[string, () => Promise<unknown>]> = [
      ['activity', () => service.getActivity(mockActor, 'wi-1', { limit: 50, offset: 0 })],
      ['labels', () => service.getWorkItemLabels(mockActor, 'wi-1')],
      ['relations', () => service.listRelations(mockActor, 'wi-1')],
      ['milestones', () => service.getWorkItemMilestones(mockActor, 'wi-1')],
      ['time logs', () => service.listTimeLogs(mockActor, 'wi-1', { page: 1, pageSize: 20 })],
      ['watchers', () => service.listWatchers(mockActor, 'wi-1')],
      ['attachments', () => service.listAttachments(mockActor, 'wi-1')],
      // A signed URL outlives the request that minted it, so this one keeps leaking after the refusal.
      ['attachment download', () => service.getAttachmentDownloadUrl(mockActor, 'wi-1', 'file-1')],
      ['tasks', () => service.listTasks(mockActor, 'wi-1')],
      ['task totals', () => service.getTaskTotals(mockActor, 'wi-1')],
    ];

    it.each(scopedReads)('refuses %s on a record outside the Editor Teams', async (_name, call) => {
      accessService.assertTeamInScope.mockRejectedValue(
        new PermissionDeniedException('TEAM_NOT_IN_SCOPE', 'another Team'),
      );

      await expect(call()).rejects.toThrow(PermissionDeniedException);
    });

    it.each(scopedReads)(
      'asks the boundary about the loaded record for %s',
      async (_name, call) => {
        workItemRepo.findById.mockResolvedValue(
          mockWorkItem({ projectId: 'proj-9', teamId: 'team-beta' }),
        );

        await call().catch(() => undefined);

        expect(accessService.assertTeamInScope).toHaveBeenCalledWith(
          'ws-1',
          'user-1',
          'proj-9',
          'team-beta',
        );
      },
    );

    it('drops a relation whose far end belongs to another Team, key and title with it', async () => {
      accessService.resolveTeamScope.mockResolvedValue(ALPHA);
      relationRepo.listForItem.mockResolvedValue([
        relationView('wi-alpha', 'US-2'),
        relationView('wi-beta', 'US-3'),
      ]);
      workItemRepo.findByIds.mockResolvedValue([
        mockWorkItem({ id: 'wi-alpha', teamId: 'team-alpha' }),
        mockWorkItem({ id: 'wi-beta', teamId: 'team-beta' }),
      ]);

      const views = await service.listRelations(mockActor, 'wi-1');

      expect(views.map((v) => v.relatedItem.id)).toEqual(['wi-alpha']);
      expect(JSON.stringify(views)).not.toContain('US-3');
    });

    it('drops a relation whose far end is a PROJECT BACKLOG item (no Team)', async () => {
      accessService.resolveTeamScope.mockResolvedValue(ALPHA);
      relationRepo.listForItem.mockResolvedValue([relationView('wi-backlog', 'US-4')]);
      workItemRepo.findByIds.mockResolvedValue([mockWorkItem({ id: 'wi-backlog', teamId: null })]);

      expect(await service.listRelations(mockActor, 'wi-1')).toEqual([]);
    });

    it('drops a relation whose far end sits in a project the reader cannot view', async () => {
      // Cross-project links are legal, and the check `linkWorkItem` made at creation does not survive
      // a later access change.
      accessService.getProjectPermissions.mockResolvedValue([]);
      relationRepo.listForItem.mockResolvedValue([relationView('wi-elsewhere', 'PAY-1')]);
      workItemRepo.findByIds.mockResolvedValue([
        mockWorkItem({ id: 'wi-elsewhere', projectId: 'proj-2', teamId: 'team-alpha' }),
      ]);

      expect(await service.listRelations(mockActor, 'wi-1')).toEqual([]);
    });

    it('resolves the Home aggregates PER PROJECT, keeping an empty scope as an empty one', async () => {
      // Cross-project reads: the caller may be an admin in one project and an editor in the next, so
      // one workspace-wide set of team ids would be wrong in both directions.
      accessService.listReadableProjectIds.mockResolvedValue(['proj-1', 'proj-2', 'proj-3']);
      accessService.resolveTeamScope.mockImplementation((_ws: string, _u: string, id: string) =>
        Promise.resolve(
          id === 'proj-1' ? ALPHA : id === 'proj-2' ? NO_TEAM : { unrestricted: true as const },
        ),
      );

      await service.getWorkspaceSummary(mockActor);
      await service.listMyWork(mockActor, 10);

      // proj-3 is absent because an unrestricted project needs no predicate; proj-2 is PRESENT with an
      // empty list, which is what tells the query that project contributes no rows.
      const expected = [
        { projectId: 'proj-1', teamIds: ['team-alpha'] },
        { projectId: 'proj-2', teamIds: [] },
      ];
      expect(workItemRepo.getWorkspaceSummary).toHaveBeenCalledWith(
        'ws-1',
        'user-1',
        ['proj-1', 'proj-2', 'proj-3'],
        expected,
      );
      expect(workItemRepo.listMyWork).toHaveBeenCalledWith(
        'ws-1',
        'user-1',
        { limit: 10 },
        ['proj-1', 'proj-2', 'proj-3'],
        expected,
      );
    });
  });
});
