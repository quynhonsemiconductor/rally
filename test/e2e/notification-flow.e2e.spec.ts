/**
 * BA business-flow E2E — Phase 4.1 Notifications.
 *
 * Encodes the P4.1 acceptance rules from the Phase 4 development pack
 * (product-docs/projects/mini-rally/04_Developement_tracking/Phase 4/
 *  PHASE4_DEVELOPMENT_TRACKING.md — tasks P4-NOTIF-04/07/08/11) as the
 * cross-phase flow E2E-017:
 *   - Assigning a US/DE to another user enqueues exactly ONE assignment
 *     notification for the assignee — and none for a self-assignment.
 *   - The Notification Center read model (list, unread count, category filters,
 *     mark-read, mark-all-read) behaves as the mockup specifies.
 *   - A user only ever sees / can act on their OWN notifications.
 *
 * Architecture note — the notification pipeline is a transactional outbox:
 * producers (WorkItemsService) enqueue into `messaging.notification_outbox`
 * inside their business transaction; the Worker relay later renders and writes
 * `notifications.in_app_notifications`, which NotificationsService reads. This
 * suite boots only the API AppModule (no Worker), so it proves each half at its
 * real seam: the producer contract at the outbox, and the read model by driving
 * NotificationsService directly (its own `send()` is the same call the relay
 * makes). Nothing is stubbed.
 *
 * Drives the REAL application services against the seeded DB.
 */
import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotificationsService, NotificationPreferencesService } from '@modules/notifications';
import { ProjectsService } from '@modules/projects';
import { TeamService } from '@modules/workspace';
import { WorkItemsService } from '@modules/work-items';
import { DRIZZLE, type DrizzleDB } from '@platform';

import { notificationOutbox, emailOutbox } from '../../db/schema/messaging';
import { inAppNotifications } from '../../db/schema/notifications';
import type { NotificationRelayService } from '../../apps/worker/src/notifications/notification-relay.service';
import type { EmailRelayService } from '../../apps/worker/src/email/email-relay.service';
import {
  DEVELOPER_ID,
  SEEDED,
  WORKSPACE_ID,
  adminActor,
  bootRallyApp,
  bootRallyWorkerRelays,
  grantProjectAccess,
  uniqueKey,
} from './support/flow-harness';

/** A synthetic recipient id — the read model keys on recipientId (no FK), so a
 * fresh uuid isolates each assertion from seed data and prior runs. */
const freshRecipient = () => randomUUID();

describe('BA flows: Phase 4.1 notifications (real AppModule + seeded DB)', () => {
  let app: NestFastifyApplication;
  let projects: ProjectsService;
  let teams: TeamService;
  let workItems: WorkItemsService;
  let notifications: NotificationsService;
  let db: DrizzleDB;
  const admin = adminActor();

  beforeAll(async () => {
    app = await bootRallyApp();
    projects = app.get(ProjectsService);
    teams = app.get(TeamService);
    workItems = app.get(WorkItemsService);
    notifications = app.get(NotificationsService);
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
  });

  const outboxFor = (resourceId: string) =>
    db
      .select()
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.resourceId, resourceId),
          eq(notificationOutbox.type, 'WORK_ITEM_ASSIGNED'),
        ),
      );

  // ── E2E-017a: assignment producer contract ──────────────────────────────────
  describe('E2E-017a assignment enqueues one notification for the assignee', () => {
    it('enqueues a WORK_ITEM_ASSIGNED notification for a new assignee', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'Notify Project',
      });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Assign me');
      // The grant is part of the FIXTURE now, not decoration. `createProject` makes a project nobody
      // but its creator can read, and the producer drops a recipient without `work_item:view` on it
      // (FR-019). Without this the assertion below passed only while the notification path ignored
      // access entirely — it would be measuring the leak, not the contract.
      // `editor`, NOT `admin`, and the level matters for a reason that has nothing to do with this
      // spec: `admin` carries `portfolio:view`, so granting it to the SEEDED Editor makes
      // `listReadableProjectIds('portfolio:view')` non-empty for them for the rest of the run — and
      // `authz-cluster.e2e.spec.ts` asserts the opposite premise ("readable is empty, and that branch
      // is checked first"), so it failed only in FULL runs and passed alone. A shared fixture is not a
      // scratch pad; the narrower grant leaks nothing.
      //
      // With `editor` the assignment rule (`c42df59`, 2026-08-22) needs the item to carry a Team the
      // recipient belongs to, so the fixture builds one instead of widening the grant.
      await grantProjectAccess(app, DEVELOPER_ID, project.id, 'editor');
      const team = await teams.createTeam(
        admin.workspaceId,
        { name: `Notify Team ${uniqueKey('T')}`, key: uniqueKey('T'), projectIds: [project.id] },
        admin.sub,
      );
      await teams.addTeamMember(team.id, DEVELOPER_ID, admin.workspaceId, admin.sub);
      await workItems.updateWorkItem(admin, story.id, { teamId: team.id });

      await workItems.updateWorkItem(admin, story.id, { assigneeId: DEVELOPER_ID });

      const rows = await outboxFor(story.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recipientId).toBe(DEVELOPER_ID);
      expect(rows[0]?.actorId).toBe(admin.sub);
      expect(rows[0]?.workspaceId).toBe(WORKSPACE_ID);
      // Deep-link contract: the producer threads the owning project id + item key
      // into vars so the relay can stamp metadata the client uses to open the item
      // in its OWN project context (notifications are workspace-wide).
      expect(rows[0]?.vars).toMatchObject({ itemKey: story.itemKey, projectId: project.id });
    });

    it('assigns across an access boundary but sends NO notification', async () => {
      // FR-019 from the WRITE side. The assignee is validated as an active WORKSPACE member
      // (`assertAssignmentScope`), never as someone who can read this project — so an admin can
      // legitimately assign work to a colleague with No Access to it, and the notification would
      // otherwise name the item's key and title on the one surface §7 says must disclose nothing.
      //
      // THE WRITE IS NOW REFUSED OUTRIGHT, and this case used to assert the opposite — "filtered, not
      // refused: the assignment is a real thing an admin may do deliberately". The BA's assignment
      // rule (`c42df59`, 2026-08-22) removed that possibility: a user with no access to the project
      // satisfies neither branch of it, so `WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE` fires before any
      // notification decision is reached. The refusal subsumes what this case was protecting — an
      // unreachable recipient cannot be told about an item they cannot see if they cannot be given it.
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'No Access Assign Project',
      });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Assign outward');

      await expect(
        workItems.updateWorkItem(admin, story.id, { assigneeId: DEVELOPER_ID }),
      ).rejects.toThrow(/not eligible|Project Admin/);

      const unchanged = await workItems.getWorkItem(admin.workspaceId, story.id);
      expect(unchanged.assigneeId).toBeNull();
      expect(await outboxFor(story.id)).toHaveLength(0);
    });

    it('does NOT notify the actor when they assign the item to themselves', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'Self Assign Project',
      });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Mine');

      await workItems.updateWorkItem(admin, story.id, { assigneeId: admin.sub });

      const rows = await outboxFor(story.id);
      expect(rows).toHaveLength(0);
    });
  });

  // ── E2E-017b: Notification Center read model ────────────────────────────────
  describe('E2E-017b notification center list, count, filters and read state', () => {
    it('lists, counts, filters by category and clears unread state', async () => {
      const recipient = freshRecipient();
      const reader = { ...admin, sub: recipient };

      const assigned = await notifications.send({
        workspaceId: WORKSPACE_ID,
        recipientId: recipient,
        actorId: admin.sub,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'You were assigned NXP-1',
      });
      const mention = await notifications.send({
        workspaceId: WORKSPACE_ID,
        recipientId: recipient,
        actorId: admin.sub,
        type: 'WORK_ITEM_MENTIONED',
        title: 'You were mentioned on NXP-2',
      });
      expect(assigned).not.toBeNull();
      expect(mention).not.toBeNull();

      // All → both; unread count → 2.
      const all = await notifications.listNotifications(reader, { unreadOnly: false });
      expect(all.map((n) => n.id).sort()).toEqual([assigned!.id, mention!.id].sort());
      expect(await notifications.getUnreadCount(reader)).toBe(2);

      // Category tabs map to template types (single source of truth).
      const assignedTab = await notifications.listNotifications(reader, {
        unreadOnly: false,
        category: 'assigned',
      });
      expect(assignedTab.map((n) => n.id)).toEqual([assigned!.id]);

      const mentionsTab = await notifications.listNotifications(reader, {
        unreadOnly: false,
        category: 'mentions',
      });
      expect(mentionsTab.map((n) => n.id)).toEqual([mention!.id]);

      // Read one → count drops; Unread tab excludes it.
      await notifications.markRead(reader, assigned!.id);
      expect(await notifications.getUnreadCount(reader)).toBe(1);
      const unread = await notifications.listNotifications(reader, { unreadOnly: true });
      expect(unread.map((n) => n.id)).toEqual([mention!.id]);

      // Mark all as read → count zero.
      await notifications.markAllRead(reader);
      expect(await notifications.getUnreadCount(reader)).toBe(0);
    });

    /**
     * The reader is the seeded Workspace Admin, not a synthetic uuid, because the read model now
     * applies the reader's per-Project access to the feed (RFE-05 / SRS §7 :199-200) and this row
     * deliberately NAMES a project. A `randomUUID()` recipient holds no access to any project, so
     * a project-naming notification addressed to one is correctly invisible — which is the subject
     * of the E2E-017f block below, not of this metadata round-trip. `workspace:*` makes the admin
     * unrestricted (`listReadableProjectIds` → null), so the deep-link payload is what is measured
     * here rather than the filter.
     */
    it('round-trips deep-link metadata through the read model', async () => {
      const metadata = { itemKey: 'NXP-42', projectId: randomUUID() };

      const sent = await notifications.send({
        workspaceId: WORKSPACE_ID,
        recipientId: admin.sub,
        actorId: DEVELOPER_ID,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'You were assigned NXP-42',
        resourceType: 'work_item',
        metadata,
      });
      expect(sent).not.toBeNull();
      expect(sent!.metadata).toMatchObject(metadata);

      // The list read model exposes it too — this is what the client deep-links on.
      const listed = (await notifications.listNotifications(admin, { unreadOnly: false })).find(
        (n) => n.id === sent!.id,
      );
      expect(listed?.metadata).toMatchObject(metadata);
    });
  });

  // ── E2E-017c: recipient isolation ───────────────────────────────────────────
  describe('E2E-017c a user only sees and acts on their own notifications', () => {
    it('never leaks another user notification and blocks cross-user mark-read', async () => {
      const owner = freshRecipient();
      const other = freshRecipient();

      const ownerNote = await notifications.send({
        workspaceId: WORKSPACE_ID,
        recipientId: owner,
        actorId: admin.sub,
        type: 'WORK_ITEM_ASSIGNED',
        title: 'Owner-only notification',
      });
      expect(ownerNote).not.toBeNull();

      // The other user's list never contains it.
      const otherReader = { ...admin, sub: other };
      const otherList = await notifications.listNotifications(otherReader, { unreadOnly: false });
      expect(otherList.map((n) => n.id)).not.toContain(ownerNote!.id);

      // …and they cannot mark it read.
      await expect(notifications.markRead(otherReader, ownerNote!.id)).rejects.toMatchObject({
        code: 'NOTIFICATION_NOT_FOUND',
      });

      // The rightful owner still sees it unread.
      const ownerReader = { ...admin, sub: owner };
      expect(await notifications.getUnreadCount(ownerReader)).toBe(1);
    });
  });

  // ── E2E-017d: FR-019 recipient access gating ────────────────────────────────
  describe('E2E-017d notifications reach only users allowed to access the item', () => {
    it('drops mentioned users without project access (FR-019)', async () => {
      const project = await projects.createProject(admin, {
        key: uniqueKey(),
        name: 'FR-019 Project',
      });
      const story = await workItems.createWorkItem(admin, project.id, 'story', 'Mention gating');

      /**
       * The mentioned-with-access principal needs a grant ON THIS PROJECT.
       *
       * This used to rest on "DEVELOPER_ID holds a workspace-scoped role → access to every project",
       * which was the legacy over-grant migration 0111 deletes and the seed used to re-create. With
       * it gone, dev has access to NXP and nothing else, so on a project created by this very test
       * they are correctly filtered — and the assertion below turned into a false failure that read
       * as "FR-019 drops people it should keep".
       *
       * Granted here rather than reaching for a user who already has broad access, because that is
       * what the rule is about: FR-019 keeps a mentioned user who can reach the item and drops one
       * who cannot. The project is created by this test, so the grant cannot leak into another spec.
       */
      await grantProjectAccess(app, DEVELOPER_ID, project.id, 'editor');

      // A fresh uuid has no membership and no grant → no access, must be filtered out.
      const outsider = randomUUID();

      await workItems.notifyCommentAdded(admin, story.id, [DEVELOPER_ID, outsider]);

      const rows = await db
        .select()
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.resourceId, story.id),
            eq(notificationOutbox.type, 'WORK_ITEM_MENTIONED'),
          ),
        );
      const recipients = rows.map((r) => r.recipientId);
      expect(recipients).toContain(DEVELOPER_ID);
      expect(recipients).not.toContain(outsider);
    });
  });

  // ── E2E-017f: the READ half of the same rule (RFE-05) ───────────────────────
  //
  // `Phase 4/02_Roles_Permissions/SRS.md` §7 :200 — "Notifications must apply the CURRENT
  // Project/Team access before displaying or routing to a Work Item" — and :199 — "Denied states
  // must not show restricted title, owner, Project, Team or other business data". E2E-017d above
  // proves the WRITE half (FR-019 drops a recipient at fan-out time); this block proves the read
  // half, which is the durable one: access is revocable AFTER a notification is stored, and the
  // stored row keeps naming the item.
  //
  // All three branches of `listReadableProjectIds`'s return are exercised, because the sentinel is
  // the whole subtlety — `null` is UNRESTRICTED and `[]` is "no projects", and confusing them is a
  // leak in one direction and a blank screen in the other. No project is CREATED here: the seeded
  // projects plus a uuid that names no project cover every branch.
  describe('E2E-017f the feed applies the reader current project access (SRS §7 :199-200)', () => {
    /** A notification that NAMES a project, exactly as the work-item templates render it. */
    const sendAboutProject = (recipientId: string, projectId: string, itemKey: string) =>
      notifications.send({
        workspaceId: WORKSPACE_ID,
        recipientId,
        actorId: admin.sub,
        type: 'WORK_ITEM_ASSIGNED',
        title: `You were assigned ${itemKey}`,
        body: 'A title the reader must not see without access',
        resourceType: 'work_item',
        metadata: { itemKey, projectId },
      });

    /** A workspace-scoped notification — no project to authorize against. */
    const sendWorkspaceWide = (recipientId: string) =>
      notifications.send({
        workspaceId: WORKSPACE_ID,
        recipientId,
        actorId: admin.sub,
        type: 'WORKSPACE_INVITATION',
        title: 'You were invited to Acme',
        resourceType: 'workspace',
      });

    it('hides a work-item notification whose project the reader cannot read, and keeps the project-less one', async () => {
      // A fresh uuid holds no membership and no assignment → readable projects is `[]`, the
      // restricting sentinel that must NOT be read as "everything".
      const denied = randomUUID();
      const reader = { ...admin, sub: denied };

      const restricted = await sendAboutProject(denied, SEEDED.nxp.projectId, 'NXP-501');
      const workspaceWide = await sendWorkspaceWide(denied);
      expect(restricted).not.toBeNull();
      expect(workspaceWide).not.toBeNull();

      const visible = (await notifications.listNotifications(reader, { unreadOnly: false })).map(
        (n) => n.id,
      );
      expect(visible).not.toContain(restricted!.id);
      expect(visible).toContain(workspaceWide!.id);

      // The badge must agree with the page — a count of rows the list refuses to show is its own
      // defect. This recipient is fresh, so the count is exactly the project-less notification.
      expect(await notifications.getUnreadCount(reader)).toBe(1);

      // The SSE live push consults the same fact.
      expect(await notifications.isVisible(reader, restricted!.id)).toBe(false);
      expect(await notifications.isVisible(reader, workspaceWide!.id)).toBe(true);

      // …and the cursor-paginated Notification Center page, which is a separate query.
      const page = await notifications.listNotificationsPage(
        reader,
        { unreadOnly: false },
        { limit: 50, cursor: null },
      );
      expect(page.data.map((n) => n.id)).not.toContain(restricted!.id);
    });

    it('shows a project-scoped notification to a reader who holds access to that project', async () => {
      // DEVELOPER_ID is a member of the seeded NXP project (see E2E-017d's note: dev has NXP and
      // not the projects a test creates), so the readable list is a NON-EMPTY array — the third
      // branch, and the one an over-eager "deny unless unrestricted" fix would break.
      const reader = { ...admin, sub: DEVELOPER_ID };

      const readable = await sendAboutProject(DEVELOPER_ID, SEEDED.nxp.projectId, 'NXP-502');
      const foreign = await sendAboutProject(DEVELOPER_ID, randomUUID(), 'PAY-502');
      expect(readable).not.toBeNull();
      expect(foreign).not.toBeNull();

      const visible = (
        await notifications.listNotifications(reader, { unreadOnly: false, limit: 200 })
      ).map((n) => n.id);
      expect(visible).toContain(readable!.id);
      expect(visible).not.toContain(foreign!.id);
    });

    it('shows both to a Workspace Admin, whose readable-projects answer is the null sentinel', async () => {
      // `workspace:*` is a workspace-wide grant, so `listReadableProjectIds` returns `null`.
      // Flattening that to `[]` would empty the admin's bell — the failure in the other direction.
      const anyProject = await sendAboutProject(admin.sub, randomUUID(), 'NXP-503');
      expect(anyProject).not.toBeNull();

      const visible = (
        await notifications.listNotifications(admin, { unreadOnly: false, limit: 200 })
      ).map((n) => n.id);
      expect(visible).toContain(anyProject!.id);
      expect(await notifications.isVisible(admin, anyProject!.id)).toBe(true);
    });

    it('clears only what the badge counted when the reader marks all read', async () => {
      const denied = randomUUID();
      const reader = { ...admin, sub: denied };

      const restricted = await sendAboutProject(denied, SEEDED.nxp.projectId, 'NXP-504');
      const workspaceWide = await sendWorkspaceWide(denied);
      expect(await notifications.getUnreadCount(reader)).toBe(1);

      await notifications.markAllRead(reader);
      expect(await notifications.getUnreadCount(reader)).toBe(0);

      // The hidden row keeps its unread state: it was never displayed, so consuming it would lose
      // the badge the reader would be owed if their access were restored.
      const [stillUnread] = await db
        .select({ isRead: inAppNotifications.isRead })
        .from(inAppNotifications)
        .where(eq(inAppNotifications.id, restricted!.id));
      expect(stillUnread?.isRead).toBe(false);

      const [cleared] = await db
        .select({ isRead: inAppNotifications.isRead })
        .from(inAppNotifications)
        .where(eq(inAppNotifications.id, workspaceWide!.id));
      expect(cleared?.isRead).toBe(true);
    });
  });
});

// ── E2E-017e: the Worker relay half of the pipeline ─────────────────────────
//
// The suite above proves the producer contract (API → notification_outbox)
// and the read model (in_app_notifications → NotificationsService). This
// block proves the middle: the real NotificationRelayService/EmailRelayService
// fetchBatch → processRow → markSent/markFailed cycle, preference suppression
// at delivery time, the notification→email cascade, and retry/backoff on a
// forced failure — none of which the producer-only suite above can reach
// (the "P4.1 notifications" suite header explicitly scoped this out).
describe('BA flows: Worker relay — real fetchBatch/processRow/markSent/markFailed', () => {
  let workerModule: TestingModule;
  let notificationRelay: NotificationRelayService;
  let emailRelay: EmailRelayService;
  let prefs: NotificationPreferencesService;
  let db: DrizzleDB;
  const admin = adminActor();

  beforeAll(async () => {
    const worker = await bootRallyWorkerRelays();
    workerModule = worker.module;
    notificationRelay = worker.notificationRelay;
    emailRelay = worker.emailRelay;
    prefs = workerModule.get(NotificationPreferencesService);
    db = workerModule.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await workerModule?.close();
  });

  const freshRecipient = () => randomUUID();

  /**
   * PostCommitTask (SSE push + email scheduling) runs fire-and-forget AFTER
   * the relay's transaction commits (see AbstractOutboxRelay.relay() — "run
   * post-commit tasks (fire-and-forget, non-critical)"), so `await relay()`
   * resolving does not guarantee the cascade's email_outbox insert has
   * landed yet. Poll briefly instead of asserting immediately.
   */
  async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 2000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = await check();
      if (result !== undefined) return result;
      if (Date.now() > deadline) throw new Error(`waitFor() timed out after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('delivers a pending outbox row to in_app_notifications and marks it sent', async () => {
    const recipientId = freshRecipient();
    const [row] = await db
      .insert(notificationOutbox)
      .values({
        workspaceId: WORKSPACE_ID,
        recipientId,
        actorId: admin.sub,
        type: 'WORK_ITEM_ASSIGNED',
        vars: { itemKey: 'NXP-900', itemTitle: 'Relay smoke test', projectId: randomUUID() },
        resourceId: randomUUID(),
      })
      .returning();

    await notificationRelay.relay();

    const [after] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, row.id));
    expect(after?.status).toBe('sent');
    expect(after?.dispatchedAt).not.toBeNull();

    const delivered = await db
      .select()
      .from(inAppNotifications)
      .where(eq(inAppNotifications.recipientId, recipientId));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.type).toBe('WORK_ITEM_ASSIGNED');
    expect(delivered[0]?.title).toContain('NXP-900');
  });

  it('honours an in-app opt-out: the row is marked sent but no in_app_notifications row is written', async () => {
    const recipientId = freshRecipient();
    // Wildcard opt-out — the relay checks this at delivery time (not schedule
    // time), so it applies even though the row was already queued.
    await prefs.upsert({ workspaceId: WORKSPACE_ID, userId: recipientId, type: '*', inApp: false });

    await db.insert(notificationOutbox).values({
      workspaceId: WORKSPACE_ID,
      recipientId,
      actorId: admin.sub,
      type: 'WORK_ITEM_ASSIGNED',
      vars: { itemKey: 'NXP-901', itemTitle: 'Opted out', projectId: randomUUID() },
      resourceId: randomUUID(),
    });

    await notificationRelay.relay();

    const delivered = await db
      .select()
      .from(inAppNotifications)
      .where(eq(inAppNotifications.recipientId, recipientId));
    expect(delivered).toHaveLength(0);

    await prefs.reset(WORKSPACE_ID, recipientId, '*');
  });

  it('cascades to a scheduled email when the recipient has email enabled (default)', async () => {
    // The relay looks up an email address from identity.users — target the
    // seeded admin (a real user row) so the lookup inside
    // scheduleNotificationEmail() succeeds instead of skipping with "recipient
    // not found".
    const [row] = await db
      .insert(notificationOutbox)
      .values({
        workspaceId: WORKSPACE_ID,
        recipientId: admin.sub,
        actorId: admin.sub,
        type: 'WORK_ITEM_COMMENTED',
        vars: { itemKey: 'NXP-902', itemTitle: 'Cascade test', projectId: randomUUID() },
        resourceId: randomUUID(),
      })
      .returning();

    // Drain the outbox until THIS row is delivered, re-driving the relay on
    // each poll. A single relay() pass fetches only the oldest `batchSize` (50)
    // pending rows (fetchBatch: `ORDER BY scheduled_at ASC LIMIT 50`). The e2e
    // DB is shared and never cleaned between runs, so a freshly-inserted row can
    // sit behind ≥50 older pending rows and miss the first batch — the row is
    // never processed within a fixed poll window and the read times out (the
    // real, previously-misdiagnosed cause of this test's flake). Each pass marks
    // its batch sent — or failed, which pushes scheduled_at into the future so
    // the row drops out of the next batch — so re-driving deterministically
    // reaches our row instead of depending on a single pass landing it. `send()`
    // is idempotent on source_event_id, so extra passes never double-write.
    //
    // sourceEventId == row.id here: the relay passes `row.idempotencyKey ?? row.id`
    // and this row supplied no custom idempotency key.
    const delivered = await waitFor(async () => {
      await notificationRelay.relay();
      const [r] = await db
        .select()
        .from(inAppNotifications)
        .where(eq(inAppNotifications.sourceEventId, row.id));
      return r;
    }, 10_000);
    expect(delivered).toBeDefined();

    // Both relays are booted with their Valkey wake-signal subscriptions live
    // (see bootRallyWorkerRelays()), so EmailSchedulerService.schedule()'s
    // wake publish can trigger the email relay to drain this row before this
    // test's own explicit emailRelay.relay() call below runs — status may
    // already be 'sent' by the time we observe it. That race is itself a
    // reflection of the real system (the whole point of the wake signal is
    // near-instant delivery), so assert only what's deterministic: the
    // cascade produced the right row, in a non-terminal-failure state.
    const emailRow = await waitFor(async () => {
      const rows = await db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.idempotencyKey, `notification-email:${delivered.id}`));
      return rows[0];
    });
    expect(emailRow.template).toBe('notification');
    expect(['pending', 'sent']).toContain(emailRow.status);

    // Drain the email outbox until OUR row reaches 'sent', re-driving the email
    // relay on each poll. Same reasoning as the in-app drain above: emailRelay's
    // fetchBatch is also bounded (oldest N by scheduled_at) and the shared e2e
    // DB accumulates rows, so a single relay() pass need not include our row.
    // Re-driving reaches 'sent' deterministically without depending on which
    // pass gets there first. EMAIL_PROVIDER=dev (see vitest.e2e.config.ts) logs
    // instead of actually sending.
    const afterEmail = await waitFor(async () => {
      await emailRelay.relay();
      const [r] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, emailRow.id));
      return r?.status === 'sent' ? r : undefined;
    }, 10_000);
    expect(afterEmail.status).toBe('sent');
  });

  it('does NOT cascade to email when the recipient has email disabled for this type', async () => {
    const recipientId = freshRecipient();
    await prefs.upsert({
      workspaceId: WORKSPACE_ID,
      userId: recipientId,
      type: 'WORK_ITEM_COMMENTED',
      email: false,
    });

    const [row] = await db
      .insert(notificationOutbox)
      .values({
        workspaceId: WORKSPACE_ID,
        recipientId,
        actorId: admin.sub,
        type: 'WORK_ITEM_COMMENTED',
        vars: { itemKey: 'NXP-903', itemTitle: 'No email', projectId: randomUUID() },
        resourceId: randomUUID(),
      })
      .returning();

    await notificationRelay.relay();

    const emailRows = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.idempotencyKey, `notification-email:${row.id}`));
    expect(emailRows).toHaveLength(0);

    await prefs.reset(WORKSPACE_ID, recipientId, 'WORK_ITEM_COMMENTED');
  });

  it('never cascades WORK_ITEM_ASSIGNED to email, even with the email preference enabled', async () => {
    // No preference row is written: the DEFAULT is `email: true`, so a template that reached
    // the preference check would be mailed here. EMAIL_CHANNEL_BY_TEMPLATE marks this type
    // in-app only and is consulted first, which is what this asserts. Targets the seeded admin
    // (a real identity.users row) so a missing email address cannot be the reason nothing sends.
    const [row] = await db
      .insert(notificationOutbox)
      .values({
        workspaceId: WORKSPACE_ID,
        recipientId: admin.sub,
        actorId: admin.sub,
        type: 'WORK_ITEM_ASSIGNED',
        vars: { itemKey: 'NXP-904', itemTitle: 'In-app only', projectId: randomUUID() },
        resourceId: randomUUID(),
      })
      .returning();

    // Same bounded-batch reasoning as the cascade test above — re-drive until OUR row lands.
    const delivered = await waitFor(async () => {
      await notificationRelay.relay();
      const [r] = await db
        .select()
        .from(inAppNotifications)
        .where(eq(inAppNotifications.sourceEventId, row.id));
      return r;
    }, 10_000);
    // The in-app half is untouched: this is a channel removal, not a notification removal.
    expect(delivered).toBeDefined();
    expect(delivered.type).toBe('WORK_ITEM_ASSIGNED');

    const emailRows = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.idempotencyKey, `notification-email:${delivered.id}`));
    expect(emailRows).toHaveLength(0);
  });

  it('retries a failing row with backoff instead of exhausting all attempts immediately', async () => {
    // renderNotification()'s exhaustiveness guard throws for any type outside
    // NotificationTemplateName — the real, catchable failure mode processRow()
    // can hit (a missing var, by contrast, just renders as `undefined` in the
    // template string; it does not throw). Bypasses the DB enum type (raw SQL)
    // since notification_outbox.type is a plain varchar, not a Postgres enum.
    const badType = 'NOT_A_REAL_TEMPLATE';
    const [row] = await db
      .insert(notificationOutbox)
      .values({
        workspaceId: WORKSPACE_ID,
        recipientId: admin.sub,
        actorId: admin.sub,
        type: badType,
        vars: { itemKey: 'NXP-904' },
        resourceId: randomUUID(),
      })
      .returning();

    const before = Date.now();

    // Drive the relay on EACH poll, not once up-front. fetchBatch takes only the
    // oldest `batchSize` (50) eligible rows (ORDER BY scheduled_at ASC), so when
    // earlier tests in this file have left ≥50 pending rows, this freshly-inserted
    // row is behind the backlog and a single relay() pass never reaches it — the
    // passive poll then re-reads attempts=0 until timeout and flakes in CI. This
    // is the SAME drive-to-drain fix already applied to the in-app + email drains
    // above; it was missed here (the recurring notification flake, see #125/#136).
    // Looping relay() drains successive batches until this row is processed. Once
    // it fails, markFailed pushes scheduledAt into the future so later passes skip it.
    let after: typeof row | undefined = undefined;
    for (let i = 0; i < 40; i++) {
      await notificationRelay.relay();
      [after] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, row.id));
      if ((after?.attempts ?? 0) >= 1) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(after?.status).toBe('pending'); // attempt 1/5 — not yet terminal
    expect(after?.attempts).toBe(1);
    expect(after?.lastError).toBeTruthy();
    // Backoff pushed scheduledAt forward — NOT immediately re-eligible.
    expect(after?.scheduledAt.getTime()).toBeGreaterThan(before + 20_000);

    // A relay tick right now must NOT re-process it (scheduledAt is in the future).
    await notificationRelay.relay();
    const [stillOne] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, row.id));
    expect(stillOne?.attempts).toBe(1);
  });
});
