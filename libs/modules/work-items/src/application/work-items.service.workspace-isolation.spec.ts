import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { WorkItemsService } from './work-items.service';
import { WORK_ITEM_REPOSITORY } from '../domain/ports/work-item.repository';
import { ActivityLogger } from '@modules/activity';
import { TIME_LOG_REPOSITORY } from '../domain/ports/time-log.repository';
import { WATCHER_REPOSITORY } from '../domain/ports/watcher.repository';
import {
  ATTACHMENT_REPOSITORY,
  EntityAttachmentsService,
  type AttachmentRef,
} from '@modules/attachments';
import { WORK_ITEM_RELATION_REPOSITORY } from '../domain/ports/work-item-relation.repository';
import { NotificationSchedulerService } from '@platform/notifications/notification-scheduler.service';
import type { WorkItem } from '../domain/work-item.types';
import type { TimeLog } from '../domain/time-log.types';
import type { EntityAttachment } from '@modules/attachments';
import { AttachmentsService } from '@modules/attachments';
import { NotFoundException, PreconditionFailedException, UnitOfWork } from '@platform';
import { ProjectsService } from '@modules/projects';
import { AccessService } from '@modules/access';
import { MilestonesService } from '@modules/milestones';

// Workspace isolation is enforced at the application layer via `getWorkItem`'s
// `item.workspaceId !== workspaceId` guard. These tests exercise that boundary
// directly: a caller scoped to workspace B must never be able to read or mutate
// a work item (or its logs/watchers/attachments) that belongs to workspace A,
// and every repository call must carry the caller's own workspaceId — never a
// hardcoded or borrowed one.

const now = new Date('2024-06-01');

const WORKSPACE_A = 'workspace-a';
const WORKSPACE_B = 'workspace-b';

const mockWorkItem = (o: Partial<WorkItem> = {}): WorkItem => ({
  id: 'wi-a',
  workspaceId: WORKSPACE_A,
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

const mockTimeLog = (o: Partial<TimeLog> = {}): TimeLog => ({
  id: 'log-a',
  workspaceId: WORKSPACE_A,
  workItemId: 'wi-a',
  userId: 'user-1',
  loggedDate: '2026-06-25',
  hours: '2',
  description: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  ...o,
});

const mockAttachment = (o: Partial<EntityAttachment> = {}): EntityAttachment => ({
  id: 'att-a',
  workspaceId: WORKSPACE_A,
  entityType: 'work_item',
  entityId: 'wi-a',
  uploadedBy: 'user-1',
  filename: 'file.txt',
  mimeType: 'text/plain',
  sizeBytes: 100,
  createdAt: now,
  ...o,
});

const actorForWorkspace = (workspaceId: string) => ({
  sub: 'user-1',
  workspaceId,
  contextId: workspaceId,
  sessionId: 's1',
  jti: 'j1',
  iat: 0,
  exp: 0,
  iss: 'rova',
  aud: 'rova-app',
  permissions: [] as string[],
  claims: { permissions: [] as string[] },
  authMethod: 'password' as const,
});

// findById/findByIds faithfully simulate the SQL `WHERE id = ? AND workspace_id = ?`
// scoping — an item is only visible to its owning workspace, regardless of what
// the caller passes.
const makeScopedWorkItemRepo = (items: WorkItem[]) => ({
  findById: vi.fn((id: string, workspaceId: string) =>
    Promise.resolve(items.find((i) => i.id === id && i.workspaceId === workspaceId) ?? null),
  ),
  findByIds: vi.fn((ids: string[], workspaceId: string) =>
    Promise.resolve(items.filter((i) => ids.includes(i.id) && i.workspaceId === workspaceId)),
  ),
  findIterationScope: vi.fn().mockResolvedValue(null),
  findReleaseProject: vi.fn().mockResolvedValue(null),
  assignIteration: vi.fn().mockResolvedValue(undefined),
  assignRelease: vi.fn().mockResolvedValue(undefined),
  listByProject: vi.fn(),
  listBacklog: vi.fn(),
  listTasksByParent: vi.fn().mockResolvedValue([]),
  lockRankScope: vi.fn().mockResolvedValue(undefined),
  findMaxRank: vi.fn().mockResolvedValue(null),
  getTaskTotals: vi.fn(),
  create: vi.fn(),
  update: vi.fn((id: string, patch: Partial<WorkItem>) =>
    Promise.resolve(mockWorkItem({ id, ...patch })),
  ),
  softDelete: vi.fn().mockResolvedValue(undefined),
  reorderItems: vi.fn().mockResolvedValue(undefined),
  addLabel: vi.fn().mockResolvedValue(undefined),
  removeLabel: vi.fn().mockResolvedValue(undefined),
  listLabels: vi.fn().mockResolvedValue([]),
  listMilestones: vi.fn().mockResolvedValue([]),
  setMilestones: vi.fn().mockResolvedValue(undefined),
});

const makeScopedTimeLogRepo = (logs: TimeLog[]) => ({
  findById: vi.fn((id: string, workspaceId: string) =>
    Promise.resolve(logs.find((l) => l.id === id && l.workspaceId === workspaceId) ?? null),
  ),
  listByWorkItem: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  create: vi.fn((input: Partial<TimeLog>) => Promise.resolve(mockTimeLog(input))),
  update: vi.fn((id: string, patch: Partial<TimeLog>) =>
    Promise.resolve(mockTimeLog({ id, ...patch })),
  ),
  softDelete: vi.fn().mockResolvedValue(undefined),
});

/** Valid base64 SHA-256 shape — the DTO/service reject anything else. */
const CHECKSUM = 'A'.repeat(43) + '=';

const makeScopedAttachmentRepo = (attachments: EntityAttachment[]) => ({
  // Scoped by BOTH the owning entity and the workspace — a viewer of one item must not
  // be able to reach an attachment hanging off another.
  findByEntityAndFile: vi.fn((ref: AttachmentRef, fileId: string, workspaceId: string) =>
    Promise.resolve(
      attachments.find(
        (a) =>
          a.id === fileId &&
          a.entityType === ref.entityType &&
          a.entityId === ref.entityId &&
          a.workspaceId === workspaceId,
      ) ?? null,
    ),
  ),
  listByEntity: vi.fn().mockResolvedValue([]),
  countByEntity: vi.fn().mockResolvedValue(0),
  link: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
});

const makeAttachmentsService = () => ({
  presign: vi.fn().mockResolvedValue({
    fileId: 'att-new',
    uploadUrl: 'https://bucket.example.com/upload',
    requiredHeaders: {},
  }),
  confirm: vi.fn().mockResolvedValue({
    id: 'att-new',
    filename: 'file.txt',
    mimeType: 'text/plain',
    sizeBytes: 100,
    uploadedBy: 'user-1',
    createdAt: now,
  }),
  getDownloadUrl: vi
    .fn()
    .mockResolvedValue({ url: 'https://bucket.example.com/get', expiresInSeconds: 900 }),
  softDelete: vi.fn().mockResolvedValue(undefined),
  findById: vi.fn().mockResolvedValue(null),
});

const makeWatcherRepo = () => ({
  listByWorkItem: vi.fn().mockResolvedValue([]),
  isWatching: vi.fn(),
  watch: vi.fn().mockResolvedValue(undefined),
  unwatch: vi.fn().mockResolvedValue(undefined),
  watchMany: vi.fn().mockResolvedValue(undefined),
  listUserIds: vi.fn(),
});

const makeActivityRepo = () => ({
  build: vi.fn(() => ({})),
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
    getProject: vi.fn().mockResolvedValue({ id: 'proj-1', workspaceId: WORKSPACE_A }),
    assertProjectWritable: vi.fn().mockResolvedValue(undefined),
    listStatuses: vi.fn().mockResolvedValue([]),
    assertTransitionAllowed: vi.fn().mockResolvedValue(undefined),
    generateItemKey: vi.fn().mockResolvedValue('PROJ-42'),
    listProjectTeams,
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
    assertWorkspaceMember: vi.fn().mockResolvedValue(undefined),
    assertLabelBelongsToProject: vi.fn().mockResolvedValue(undefined),
  };
};

describe('WorkItemsService — workspace isolation', () => {
  let service: WorkItemsService;
  let workItemRepo: ReturnType<typeof makeScopedWorkItemRepo>;
  let timeLogRepo: ReturnType<typeof makeScopedTimeLogRepo>;
  let watcherRepo: ReturnType<typeof makeWatcherRepo>;
  let attachmentRepo: ReturnType<typeof makeScopedAttachmentRepo>;
  let attachmentsService: ReturnType<typeof makeAttachmentsService>;
  let activityRepo: ReturnType<typeof makeActivityRepo>;
  let projectsService: ReturnType<typeof makeProjectsService>;

  const itemA = mockWorkItem({ id: 'wi-a', workspaceId: WORKSPACE_A });
  const logA = mockTimeLog({ id: 'log-a', workspaceId: WORKSPACE_A, workItemId: 'wi-a' });
  const attachmentA = mockAttachment({
    id: 'att-a',
    workspaceId: WORKSPACE_A,
    entityType: 'work_item',
    entityId: 'wi-a',
  });

  const build = async (
    wiRepo: ReturnType<typeof makeScopedWorkItemRepo>,
    tlRepo: ReturnType<typeof makeScopedTimeLogRepo>,
    atRepo: ReturnType<typeof makeScopedAttachmentRepo>,
  ) => {
    activityRepo = makeActivityRepo();
    watcherRepo = makeWatcherRepo();
    projectsService = makeProjectsService();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WorkItemsService,
        { provide: WORK_ITEM_REPOSITORY, useValue: wiRepo },
        { provide: ActivityLogger, useValue: activityRepo },
        { provide: TIME_LOG_REPOSITORY, useValue: tlRepo },
        { provide: WATCHER_REPOSITORY, useValue: watcherRepo },
        // The real service over the scoped link-repo mock: WorkItemsService delegates its
        // attachment methods now (0083), so mocking the delegate would stop these tests
        // exercising the workspace/entity predicate they exist to pin.
        EntityAttachmentsService,
        { provide: ATTACHMENT_REPOSITORY, useValue: atRepo },
        {
          provide: WORK_ITEM_RELATION_REPOSITORY,
          useValue: {
            listForItem: vi.fn().mockResolvedValue([]),
            exists: vi.fn().mockResolvedValue(false),
            create: vi.fn().mockResolvedValue({ id: 'rel-1' }),
            findById: vi.fn(),
            delete: vi.fn().mockResolvedValue(undefined),
            deleteForItem: vi.fn().mockResolvedValue(undefined),
            wouldCreateCycle: vi.fn().mockResolvedValue(false),
          },
        },
        {
          provide: NotificationSchedulerService,
          useValue: { schedule: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: AttachmentsService, useValue: attachmentsService },
        { provide: ProjectsService, useValue: projectsService },
        {
          provide: AccessService,
          useValue: {
            assertProjectPermission: vi.fn().mockResolvedValue(undefined),
            assertTeamInScope: vi.fn().mockResolvedValue(undefined),
            // Unrestricted by default: a test about the Editor Team scope says so explicitly.
            resolveTeamScope: vi.fn().mockResolvedValue({ unrestricted: true }),
            getProjectPermissions: vi.fn().mockResolvedValue(['work_item:*']),
            getWorkspacePermissions: vi.fn().mockResolvedValue([]),
            getProjectAccessLevel: vi.fn().mockResolvedValue(null),
          },
        },
        {
          // Owns the milestone-artifact scope rule (see setWorkItemMilestones); the isolation
          // tests only need it to be present and permissive.
          provide: MilestonesService,
          useValue: { assertArtifactsAssignable: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: UnitOfWork, useValue: makeUnitOfWork() },
      ],
    }).compile();
    return module.get(WorkItemsService);
  };

  beforeEach(async () => {
    workItemRepo = makeScopedWorkItemRepo([itemA]);
    timeLogRepo = makeScopedTimeLogRepo([logA]);
    attachmentRepo = makeScopedAttachmentRepo([attachmentA]);
    attachmentsService = makeAttachmentsService();
    service = await build(workItemRepo, timeLogRepo, attachmentRepo);
  });

  // ── getWorkItem — the central gate ───────────────────────────────────────

  describe('getWorkItem', () => {
    it('reads a work item scoped to its owning workspace', async () => {
      const item = await service.getWorkItem(WORKSPACE_A, 'wi-a');
      expect(item.id).toBe('wi-a');
      expect(workItemRepo.findById).toHaveBeenCalledWith('wi-a', WORKSPACE_A);
    });

    it('cannot fetch a foreign workspace work item by id', async () => {
      await expect(service.getWorkItem(WORKSPACE_B, 'wi-a')).rejects.toThrow(NotFoundException);
      expect(workItemRepo.findById).toHaveBeenCalledWith('wi-a', WORKSPACE_B);
    });

    it('defends in depth: rejects even if the repository leaks a foreign row', async () => {
      const leakyRepo = makeScopedWorkItemRepo([itemA]);
      leakyRepo.findById.mockResolvedValue(itemA); // ignores the workspaceId argument
      const leakyService = await build(leakyRepo, timeLogRepo, attachmentRepo);
      await expect(leakyService.getWorkItem(WORKSPACE_B, 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── updateWorkItem / deleteWorkItem / moveWorkItem ───────────────────────

  describe('updateWorkItem', () => {
    it('cannot update a foreign workspace work item', async () => {
      await expect(
        service.updateWorkItem(actorForWorkspace(WORKSPACE_B), 'wi-a', { title: 'hijacked' }),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it('updates using the caller workspaceId, not a hardcoded one', async () => {
      await service.updateWorkItem(actorForWorkspace(WORKSPACE_A), 'wi-a', { title: 'ok' });
      expect(workItemRepo.update).toHaveBeenCalledWith(
        'wi-a',
        expect.objectContaining({ title: 'ok' }),
        WORKSPACE_A,
        expect.anything(),
      );
    });
  });

  describe('deleteWorkItem', () => {
    it('cannot delete a foreign workspace work item', async () => {
      await expect(service.deleteWorkItem(actorForWorkspace(WORKSPACE_B), 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(workItemRepo.softDelete).not.toHaveBeenCalled();
    });

    it('soft-deletes using the caller workspaceId', async () => {
      await service.deleteWorkItem(actorForWorkspace(WORKSPACE_A), 'wi-a');
      expect(workItemRepo.softDelete).toHaveBeenCalledWith('wi-a', WORKSPACE_A);
    });
  });

  describe('moveWorkItem', () => {
    it('cannot move a foreign workspace work item', async () => {
      await expect(
        service.moveWorkItem(actorForWorkspace(WORKSPACE_B), 'wi-a', 'status-done'),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });
  });

  // ── createTask (parent lookup is workspace-gated) ───────────────────────────

  describe('createTask', () => {
    it('cannot create a task under a foreign workspace parent', async () => {
      await expect(
        service.createTask(actorForWorkspace(WORKSPACE_B), 'wi-a', 'Subtask'),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.create).not.toHaveBeenCalled();
    });
  });

  // ── Tasks list / totals ──────────────────────────────────────────────────

  describe('listTasks', () => {
    it('cannot list tasks of a foreign workspace parent', async () => {
      await expect(service.listTasks(actorForWorkspace(WORKSPACE_B), 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(workItemRepo.listTasksByParent).not.toHaveBeenCalled();
    });
  });

  describe('getTaskTotals', () => {
    it('cannot read task totals of a foreign workspace parent', async () => {
      await expect(service.getTaskTotals(actorForWorkspace(WORKSPACE_B), 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(workItemRepo.getTaskTotals).not.toHaveBeenCalled();
    });
  });

  // ── Activity ──────────────────────────────────────────────────────────────

  describe('getActivity', () => {
    it('cannot read activity of a foreign workspace work item', async () => {
      await expect(
        service.getActivity(actorForWorkspace(WORKSPACE_B), 'wi-a', { limit: 10, offset: 0 }),
      ).rejects.toThrow(NotFoundException);
      expect(activityRepo.listFor).not.toHaveBeenCalled();
    });
  });

  // ── Labels ────────────────────────────────────────────────────────────────

  describe('label management', () => {
    it('cannot list labels of a foreign workspace work item', async () => {
      await expect(
        service.getWorkItemLabels(actorForWorkspace(WORKSPACE_B), 'wi-a'),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.listLabels).not.toHaveBeenCalled();
    });

    it('cannot add a label to a foreign workspace work item', async () => {
      await expect(
        service.addLabelToWorkItem(actorForWorkspace(WORKSPACE_B), 'wi-a', 'l1'),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.addLabel).not.toHaveBeenCalled();
    });

    it('adds a label using the caller workspaceId', async () => {
      await service.addLabelToWorkItem(actorForWorkspace(WORKSPACE_A), 'wi-a', 'l1');
      expect(workItemRepo.addLabel).toHaveBeenCalledWith('wi-a', 'l1', WORKSPACE_A);
    });

    it('cannot remove a label from a foreign workspace work item', async () => {
      await expect(
        service.removeLabelFromWorkItem(actorForWorkspace(WORKSPACE_B), 'wi-a', 'l1'),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.removeLabel).not.toHaveBeenCalled();
    });
  });

  // ── reorderWorkItems / rankWorkItem ──────────────────────────────────────

  describe('reorderWorkItems', () => {
    it('cannot reorder a foreign workspace work item', async () => {
      await expect(
        service.reorderWorkItems(actorForWorkspace(WORKSPACE_B), [{ id: 'wi-a', rank: 'b1' }]),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.reorderItems).not.toHaveBeenCalled();
    });
  });

  describe('rankWorkItem', () => {
    it('cannot rank a foreign workspace work item', async () => {
      await expect(
        service.rankWorkItem(actorForWorkspace(WORKSPACE_B), 'wi-a', {
          projectId: 'proj-1',
          beforeId: null,
          afterId: null,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.update).not.toHaveBeenCalled();
    });

    it('neighbour lookup uses the caller workspaceId', async () => {
      workItemRepo.findByIds.mockResolvedValueOnce([mockWorkItem({ id: 'before', rank: 'a' })]);
      await service.rankWorkItem(actorForWorkspace(WORKSPACE_A), 'wi-a', {
        projectId: 'proj-1',
        beforeId: 'before',
        afterId: null,
      });
      expect(workItemRepo.findByIds).toHaveBeenCalledWith(['before'], WORKSPACE_A);
    });
  });

  // ── Bulk assignment ───────────────────────────────────────────────────────

  describe('bulk assignment', () => {
    it('bulkAssignRelease loads items scoped to the caller workspaceId', async () => {
      await expect(
        service.bulkAssignRelease(actorForWorkspace(WORKSPACE_B), 'proj-1', ['wi-a'], null),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.findByIds).toHaveBeenCalledWith(['wi-a'], WORKSPACE_B);
      expect(workItemRepo.assignRelease).not.toHaveBeenCalled();
    });

    it('bulkAssignIteration loads items scoped to the caller workspaceId', async () => {
      await expect(
        service.bulkAssignIteration(actorForWorkspace(WORKSPACE_B), 'proj-1', ['wi-a'], null),
      ).rejects.toThrow(NotFoundException);
      expect(workItemRepo.findByIds).toHaveBeenCalledWith(['wi-a'], WORKSPACE_B);
      expect(workItemRepo.assignIteration).not.toHaveBeenCalled();
    });
  });

  // ── Time logging ──────────────────────────────────────────────────────────

  describe('time logs', () => {
    it('cannot list time logs of a foreign workspace work item', async () => {
      await expect(
        service.listTimeLogs(actorForWorkspace(WORKSPACE_B), 'wi-a', { page: 1, pageSize: 20 }),
      ).rejects.toThrow(NotFoundException);
      expect(timeLogRepo.listByWorkItem).not.toHaveBeenCalled();
    });

    it('cannot log time against a foreign workspace work item', async () => {
      await expect(
        service.logTime(actorForWorkspace(WORKSPACE_B), 'wi-a', {
          loggedDate: '2026-06-25',
          hours: '1',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(timeLogRepo.create).not.toHaveBeenCalled();
    });

    it('logs time using the caller workspaceId', async () => {
      await service.logTime(actorForWorkspace(WORKSPACE_A), 'wi-a', {
        loggedDate: '2026-06-25',
        hours: '1',
      });
      expect(timeLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE_A, workItemId: 'wi-a' }),
      );
    });

    it('cannot update a time log via a foreign workspace work item scope', async () => {
      await expect(
        service.updateTimeLog(actorForWorkspace(WORKSPACE_B), 'wi-a', 'log-a', { hours: '3' }),
      ).rejects.toThrow(NotFoundException);
      expect(timeLogRepo.update).not.toHaveBeenCalled();
    });

    it('cannot delete a time log via a foreign workspace work item scope', async () => {
      await expect(
        service.deleteTimeLog(actorForWorkspace(WORKSPACE_B), 'wi-a', 'log-a'),
      ).rejects.toThrow(NotFoundException);
      expect(timeLogRepo.softDelete).not.toHaveBeenCalled();
    });
  });

  // ── Watchers ──────────────────────────────────────────────────────────────

  describe('watchers', () => {
    it('cannot list watchers of a foreign workspace work item', async () => {
      await expect(service.listWatchers(actorForWorkspace(WORKSPACE_B), 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(watcherRepo.listByWorkItem).not.toHaveBeenCalled();
    });

    it('cannot watch a foreign workspace work item', async () => {
      await expect(service.watch(actorForWorkspace(WORKSPACE_B), 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(watcherRepo.watch).not.toHaveBeenCalled();
    });

    it('watches using the caller workspaceId', async () => {
      await service.watch(actorForWorkspace(WORKSPACE_A), 'wi-a');
      expect(watcherRepo.watch).toHaveBeenCalledWith('wi-a', 'user-1', WORKSPACE_A);
    });

    it('cannot unwatch a foreign workspace work item', async () => {
      await expect(service.unwatch(actorForWorkspace(WORKSPACE_B), 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(watcherRepo.unwatch).not.toHaveBeenCalled();
    });
  });

  // ── Attachments ───────────────────────────────────────────────────────────

  describe('attachments', () => {
    it('cannot presign an attachment against a foreign workspace work item', async () => {
      await expect(
        service.presignAttachment(actorForWorkspace(WORKSPACE_B), 'wi-a', {
          filename: 'a.txt',
          mimeType: 'text/plain',
          sizeBytes: 10,
          checksumSha256: CHECKSUM,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(attachmentsService.presign).not.toHaveBeenCalled();
    });

    it('presigns using the caller workspaceId', async () => {
      await service.presignAttachment(actorForWorkspace(WORKSPACE_A), 'wi-a', {
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        checksumSha256: CHECKSUM,
      });
      // The key is built from the ACTOR's workspace, never from a client value.
      expect(attachmentsService.presign).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: WORKSPACE_A }),
        expect.anything(),
        expect.objectContaining({ filename: 'a.txt' }),
        0,
      );
    });

    it('cannot confirm an attachment via a foreign workspace work item scope', async () => {
      await expect(
        service.confirmAttachment(actorForWorkspace(WORKSPACE_B), 'wi-a', 'att-a'),
      ).rejects.toThrow(NotFoundException);
      expect(attachmentsService.confirm).not.toHaveBeenCalled();
    });

    it('cannot list attachments of a foreign workspace work item', async () => {
      await expect(service.listAttachments(actorForWorkspace(WORKSPACE_B), 'wi-a')).rejects.toThrow(
        NotFoundException,
      );
      expect(attachmentRepo.listByEntity).not.toHaveBeenCalled();
    });

    it('cannot get a download url via a foreign workspace work item scope', async () => {
      await expect(
        service.getAttachmentDownloadUrl(actorForWorkspace(WORKSPACE_B), 'wi-a', 'att-a'),
      ).rejects.toThrow(NotFoundException);
      expect(attachmentsService.getDownloadUrl).not.toHaveBeenCalled();
    });

    it('cannot delete an attachment via a foreign workspace work item scope', async () => {
      await expect(
        service.deleteAttachment(actorForWorkspace(WORKSPACE_B), 'wi-a', 'att-a'),
      ).rejects.toThrow(NotFoundException);
      expect(attachmentsService.softDelete).not.toHaveBeenCalled();
    });
  });

  // ── List endpoints (project-scoped, not item-scoped) ─────────────────────

  describe('listWorkItems / listBacklog', () => {
    it('listWorkItems resolves project access using the caller workspaceId', async () => {
      workItemRepo.listByProject.mockResolvedValue({
        data: [],
        pageInfo: { nextCursor: null, hasNextPage: false, limit: 20 },
      });
      await service.listWorkItems(
        actorForWorkspace(WORKSPACE_B),
        'proj-1',
        {},
        { limit: 20, cursor: null },
      );
      expect(projectsService.getProject).toHaveBeenCalledWith(WORKSPACE_B, 'proj-1');
      expect(workItemRepo.listByProject).toHaveBeenCalledWith(
        'proj-1',
        WORKSPACE_B,
        {},
        expect.anything(),
        // The Editor Team scope rides along on every list — see the `Editor Team scope` block in
        // work-items.service.spec.ts for what each answer does to the query.
        { unrestricted: true },
      );
    });

    it('listBacklog resolves project access using the caller workspaceId', async () => {
      workItemRepo.listBacklog.mockResolvedValue({
        data: [],
        pageInfo: { nextCursor: null, hasNextPage: false, limit: 20 },
      });
      await service.listBacklog(
        actorForWorkspace(WORKSPACE_B),
        'proj-1',
        {},
        { limit: 20, cursor: null },
      );
      expect(projectsService.getProject).toHaveBeenCalledWith(WORKSPACE_B, 'proj-1');
      expect(workItemRepo.listBacklog).toHaveBeenCalledWith(
        'proj-1',
        WORKSPACE_B,
        {},
        expect.anything(),
        { unrestricted: true },
      );
    });
  });
});
