import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { PreconditionFailedException } from '@platform';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { PortfolioItemsService } from '@modules/portfolio';
import { ProjectsService } from '@modules/projects';
import { CollaborationService } from './collaboration.service';
import { COMMENT_REPOSITORY } from '../domain/ports/comment.repository';
import type { Comment } from '../domain/collaboration.types';

const now = new Date('2024-06-01');

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
  authMethod: 'sso' as const,
};

const mockComment = (o: Partial<Comment> = {}): Comment => ({
  id: 'c-1',
  workspaceId: 'ws-1',
  entityType: 'work_item',
  entityId: 'wi-1',
  authorId: 'user-1',
  body: 'hello',
  parentId: null,
  isEdited: false,
  editedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
  ...o,
});

const makeCommentRepo = () => ({
  findById: vi.fn(),
  listByEntity: vi.fn().mockResolvedValue([]),
  create: vi.fn().mockImplementation((input) => Promise.resolve(mockComment(input))),
  update: vi.fn().mockImplementation((id, body) => Promise.resolve(mockComment({ id, body }))),
  softDelete: vi.fn().mockResolvedValue(undefined),
});

// getWorkItem resolves the item so the service can read its projectId.
const makeWorkItemsService = () => ({
  getWorkItem: vi.fn().mockResolvedValue({ id: 'wi-1', projectId: 'proj-9', workspaceId: 'ws-1' }),
  notifyCommentAdded: vi.fn().mockResolvedValue(undefined),
});

// getItem is the portfolio counterpart of getWorkItem — same job, different table.
const makePortfolioItemsService = () => ({
  getItem: vi.fn().mockResolvedValue({ id: 'pi-1', projectId: 'proj-7', workspaceId: 'ws-1' }),
});

const makeAccessService = () => ({
  assertProjectPermission: vi.fn().mockResolvedValue(undefined),
  // The Editor Team scope (BA ruling 2026-08-17): a comment thread is as reachable as its item, and
  // the route's guard stops at the project. Passes by default; the case about it says otherwise.
  assertTeamInScope: vi.fn().mockResolvedValue(undefined),
});

// The ONE home of PRJ-FR-010. Resolves by default; the block about it rejects deliberately.
const makeProjectsService = () => ({
  assertProjectWritable: vi
    .fn()
    .mockResolvedValue({ id: 'proj-9', workspaceId: 'ws-1', status: 'active' }),
});

const WORK_ITEM_REF = { entityType: 'work_item' as const, entityId: 'wi-1' };
const PORTFOLIO_REF = { entityType: 'portfolio_item' as const, entityId: 'pi-1' };

describe('CollaborationService — project-scoped comment writes', () => {
  let service: CollaborationService;
  let commentRepo: ReturnType<typeof makeCommentRepo>;
  let workItemsService: ReturnType<typeof makeWorkItemsService>;
  let portfolioItemsService: ReturnType<typeof makePortfolioItemsService>;
  let accessService: ReturnType<typeof makeAccessService>;
  let projectsService: ReturnType<typeof makeProjectsService>;

  beforeEach(async () => {
    commentRepo = makeCommentRepo();
    workItemsService = makeWorkItemsService();
    portfolioItemsService = makePortfolioItemsService();
    accessService = makeAccessService();
    projectsService = makeProjectsService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollaborationService,
        { provide: COMMENT_REPOSITORY, useValue: commentRepo },
        { provide: WorkItemsService, useValue: workItemsService },
        { provide: PortfolioItemsService, useValue: portfolioItemsService },
        { provide: AccessService, useValue: accessService },
        { provide: ProjectsService, useValue: projectsService },
      ],
    }).compile();

    service = module.get(CollaborationService);
  });

  describe('createComment', () => {
    // POST .../comments is now authorized by the PolicyGuard (work_item:edit on
    // the path workItemId's project); the service just writes the comment.
    it('creates the comment without a service-level project check', async () => {
      await service.createComment(mockActor, WORK_ITEM_REF, 'hi');
      expect(commentRepo.create).toHaveBeenCalledOnce();
      expect(accessService.assertProjectPermission).not.toHaveBeenCalled();
    });

    it('stores the entity pair it was given', async () => {
      await service.createComment(mockActor, PORTFOLIO_REF, 'hi');
      expect(commentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: 'portfolio_item', entityId: 'pi-1' }),
      );
    });

    // notifyCommentAdded fans out to watchers and the assignee. A portfolio item has
    // neither, so the notification is skipped rather than resolving nobody.
    it('notifies on a work item and stays silent on a portfolio item', async () => {
      await service.createComment(mockActor, WORK_ITEM_REF, 'hi');
      expect(workItemsService.notifyCommentAdded).toHaveBeenCalledOnce();

      workItemsService.notifyCommentAdded.mockClear();
      await service.createComment(mockActor, PORTFOLIO_REF, 'hi');
      expect(workItemsService.notifyCommentAdded).not.toHaveBeenCalled();
    });
  });

  describe('updateComment', () => {
    it('authorizes the project after the owner check', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await service.updateComment(mockActor, 'c-1', 'edited');
      expect(accessService.assertProjectPermission).toHaveBeenCalledWith(
        mockActor,
        'proj-9',
        'work_item:edit',
      );
      expect(commentRepo.update).toHaveBeenCalledWith('c-1', 'edited');
    });

    // The permission code follows the subject, not the route. A grant to edit work items
    // must not carry over to the portfolio, so this asserts the two branches differ.
    it('authorizes a portfolio comment with portfolio:edit, not work_item:edit', async () => {
      commentRepo.findById.mockResolvedValue(
        mockComment({ entityType: 'portfolio_item', entityId: 'pi-1' }),
      );
      await service.updateComment(mockActor, 'c-1', 'edited');
      expect(portfolioItemsService.getItem).toHaveBeenCalledWith(mockActor, 'pi-1');
      expect(workItemsService.getWorkItem).not.toHaveBeenCalled();
      expect(accessService.assertProjectPermission).toHaveBeenCalledWith(
        mockActor,
        'proj-7',
        'portfolio:edit',
      );
    });

    it('rejects editing another user’s comment before touching authorization', async () => {
      commentRepo.findById.mockResolvedValue(mockComment({ authorId: 'someone-else' }));
      await expect(service.updateComment(mockActor, 'c-1', 'edited')).rejects.toThrow(
        PreconditionFailedException,
      );
      expect(accessService.assertProjectPermission).not.toHaveBeenCalled();
    });
  });

  describe('deleteComment', () => {
    it('authorizes the project before soft-deleting', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await service.deleteComment(mockActor, 'c-1');
      expect(accessService.assertProjectPermission).toHaveBeenCalledWith(
        mockActor,
        'proj-9',
        'work_item:edit',
      );
      expect(commentRepo.softDelete).toHaveBeenCalledWith('c-1');
    });
  });

  /**
   * PRJ-03. None of the three comment writes carried the archived-project rule (PRJ-FR-010), so an
   * archived project's Discussion tab stayed fully writable — and a new comment still notified
   * watchers and @mentions, which means archiving did not even stop the mail.
   *
   * `createComment` reaches the rule through `subjectProjectId`, the same resolve
   * `assertCanCollaborate` uses, so create cannot end up scoped differently from the edit and
   * delete of the row it produces. Both entity types are covered because both write the same
   * `collaboration.comments` rows.
   */
  describe('an archived project refuses comment writes (PRJ-FR-010)', () => {
    beforeEach(() => {
      projectsService.assertProjectWritable.mockRejectedValue(
        new PreconditionFailedException('PROJECT_ARCHIVED', 'archived'),
      );
    });

    it('refuses a new comment on a work item', async () => {
      await expect(service.createComment(mockActor, WORK_ITEM_REF, 'hi')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(commentRepo.create).not.toHaveBeenCalled();
      expect(workItemsService.notifyCommentAdded).not.toHaveBeenCalled();
    });

    it('refuses a new comment on a portfolio item, resolved from the Feature', async () => {
      await expect(service.createComment(mockActor, PORTFOLIO_REF, 'hi')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(portfolioItemsService.getItem).toHaveBeenCalledWith(mockActor, 'pi-1');
      expect(commentRepo.create).not.toHaveBeenCalled();
    });

    it('refuses an edit', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await expect(service.updateComment(mockActor, 'c-1', 'edited')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(commentRepo.update).not.toHaveBeenCalled();
    });

    it('refuses a delete', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      await expect(service.deleteComment(mockActor, 'c-1')).rejects.toMatchObject({
        code: 'PROJECT_ARCHIVED',
      });
      expect(commentRepo.softDelete).not.toHaveBeenCalled();
    });

    it('still LISTS the thread — archived is read-only, not invisible', async () => {
      await expect(service.listComments(mockActor, WORK_ITEM_REF)).resolves.toEqual([]);
    });
  });

  /**
   * The Editor Team scope reaches the DISCUSSION too (BA ruling 2026-08-17: enforce it "consistently
   * in API queries, lists, reports, search, pickers and direct URLs").
   *
   * `@RequirePermission('work_item:view', { resource: 'work_item' })` resolves the PROJECT and nothing
   * finer, so without this an Editor on one Team could read another Team's thread — or the Project
   * Backlog's — through a door the record itself refuses. Asserted on the READ as well as the write,
   * because the read is the disclosure.
   */
  describe('a thread is only as reachable as its work item', () => {
    const denied = Object.assign(new Error('nope'), { code: 'TEAM_NOT_IN_SCOPE' });

    it('refuses to LIST when the item is out of the caller’s Team scope', async () => {
      accessService.assertTeamInScope.mockRejectedValueOnce(denied);

      await expect(service.listComments(mockActor, WORK_ITEM_REF)).rejects.toMatchObject({
        code: 'TEAM_NOT_IN_SCOPE',
      });
      expect(commentRepo.listByEntity).not.toHaveBeenCalled();
    });

    it('refuses to WRITE for the same reason', async () => {
      commentRepo.findById.mockResolvedValue(mockComment());
      accessService.assertTeamInScope.mockRejectedValueOnce(denied);

      await expect(service.updateComment(mockActor, 'c-1', 'edited')).rejects.toMatchObject({
        code: 'TEAM_NOT_IN_SCOPE',
      });
      expect(commentRepo.update).not.toHaveBeenCalled();
    });

    it('does NOT team-scope a portfolio comment — that surface is portfolio:view', async () => {
      // §3.2 withholds Portfolio from an Editor entirely, so the level check is the whole answer
      // there, and the ruling is about Work Items.
      await service.listComments(mockActor, PORTFOLIO_REF);

      expect(accessService.assertTeamInScope).not.toHaveBeenCalled();
    });
  });
});
