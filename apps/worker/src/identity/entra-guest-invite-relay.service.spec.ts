/**
 * EntraGuestInviteRelayService — the worker half of Entra B2B guest provisioning.
 *
 * The polling loop, backoff and dead-lettering belong to AbstractOutboxRelay and are covered by its
 * own spec. What is specific here: the guest oid lands on the invitation in the SAME write that
 * marks the row sent, a permanent Graph refusal is terminal on the FIRST attempt rather than after
 * five, and a directory collision is recorded as a success with a legible note.
 *
 * And, since migration 0124, WHO SCHEDULES THE INVITATION EMAIL. It is scheduled here, once
 * provisioning has resolved, because a link that reaches the invitee before their directory object
 * exists cannot be acted on at all. The outcome matrix is the substance of this file: success and a
 * benign directory collision schedule it, a permanent refusal and a retryable fault do not, and both
 * writers use `invitation.id` as the idempotency key so one invitation can never produce two emails.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { EntraGuestInviteRelayService } from './entra-guest-invite-relay.service';
import {
  PermanentGuestInviteError,
  type EntraGuestInviteClient,
  type GuestInviteOutcome,
} from '@modules/workspace';
import type { AppConfigService, DrizzleDB, DrizzleTx } from '@platform';
import type { EmailSchedulerService } from '@platform/email';
import type { NotificationPubSubService } from '@platform/notifications';
import { guestInviteOutbox } from '../../../../db/schema/messaging';
import { workspaceInvitations } from '../../../../db/schema/workspace';

const RAW_TOKEN = 'raw-invite-token-abc';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

type Row = {
  id: string;
  attempts: number;
  invitationId: string;
  workspaceId: string;
  email: string;
  displayName: string | null;
  inviteToken: string | null;
};

const row = (o: Partial<Row> = {}): Row => ({
  id: 'gio-1',
  attempts: 0,
  invitationId: 'inv-1',
  workspaceId: 'ws-1',
  email: 'dana@partner.example',
  displayName: null,
  inviteToken: RAW_TOKEN,
  ...o,
});

/** The invitation row the relay re-reads before it will mail a link. */
type Invitation = { status: string; tokenHash: string; expiresAt: Date };
const invitation = (o: Partial<Invitation> = {}): Invitation => ({
  status: 'pending',
  tokenHash: TOKEN_HASH,
  expiresAt: new Date(Date.now() + 7 * 86_400_000),
  ...o,
});

/**
 * Captures every `update(table).set(values)` the relay issues inside the tx, and answers its two
 * SELECTs — the invitation (status + token hash + expiry) and the workspace name.
 */
function makeTx(opts: { invitation?: Invitation | null; workspaceName?: string | null } = {}) {
  const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inv = opts.invitation === undefined ? invitation() : opts.invitation;
  const workspaceName = opts.workspaceName === undefined ? 'NextGen' : opts.workspaceName;
  let selectCall = 0;

  const tx = {
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values });
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    // First select is the invitation, second is the workspace — the order the relay reads them in.
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            selectCall += 1;
            if (selectCall === 1) return Promise.resolve(inv ? [inv] : []);
            return Promise.resolve(workspaceName ? [{ name: workspaceName }] : []);
          },
        }),
      }),
    }),
  } as unknown as DrizzleTx;
  return { tx, updates };
}

function makeDb(tx: DrizzleTx): DrizzleDB {
  return {
    transaction: async (cb: (t: DrizzleTx) => Promise<void>) => cb(tx),
  } as unknown as DrizzleDB;
}

function makeConfig(enabled = true): AppConfigService {
  return {
    get: vi.fn((key: string) => {
      if (key === 'ENTRA_GUEST_INVITE_ENABLED') return enabled;
      if (key === 'APP_BASE_URL') return 'https://rova.example';
      return undefined;
    }),
  } as unknown as AppConfigService;
}

/** Subclass that supplies the batch directly, so no database is needed to drive one pass. */
class TestRelay extends EntraGuestInviteRelayService {
  batch: Row[] = [];
  protected override async fetchBatch(): Promise<Row[]> {
    return this.batch;
  }
}

function build(
  invite: (req: { email: string }) => Promise<GuestInviteOutcome>,
  opts: {
    enabled?: boolean;
    invitation?: Invitation | null;
    workspaceName?: string | null;
  } = {},
) {
  const { tx, updates } = makeTx(opts);
  const client = { invite: vi.fn(invite) } as unknown as EntraGuestInviteClient;
  const emailScheduler = {
    schedule: vi.fn().mockResolvedValue(undefined),
  } as unknown as EmailSchedulerService & { schedule: ReturnType<typeof vi.fn> };
  const pubSub = {
    subscribeGuestInviteRelayWake: vi.fn().mockResolvedValue(async () => undefined),
  } as unknown as NotificationPubSubService & {
    subscribeGuestInviteRelayWake: ReturnType<typeof vi.fn>;
  };
  const relay = new TestRelay(
    makeDb(tx),
    client,
    makeConfig(opts.enabled ?? true),
    emailScheduler,
    pubSub,
  );
  return { relay, updates, emailScheduler, pubSub, client };
}

const updatesTo = (
  updates: Array<{ table: unknown; values: Record<string, unknown> }>,
  table: unknown,
) => updates.filter((u) => u.table === table).map((u) => u.values);

describe('EntraGuestInviteRelayService', () => {
  describe('a successful invitation', () => {
    it('writes the guest oid onto the invitation in the same write that marks the row sent', async () => {
      // One transaction, two facts that must not be able to disagree.
      const { relay, updates } = build(async () => ({
        outcome: 'invited',
        guestObjectId: 'guest-oid-1',
      }));
      relay.batch = [row()];

      await relay.relay();

      const outbox = updatesTo(updates, guestInviteOutbox);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ status: 'sent', lastError: null });

      const invitationUpdates = updatesTo(updates, workspaceInvitations);
      expect(invitationUpdates).toHaveLength(1);
      expect(invitationUpdates[0]).toMatchObject({ entraGuestObjectId: 'guest-oid-1' });
    });

    it('touches no invitation when Graph returned no object id', async () => {
      const { relay, updates } = build(async () => ({ outcome: 'invited', guestObjectId: null }));
      relay.batch = [row()];

      await relay.relay();

      expect(updatesTo(updates, guestInviteOutbox)[0]).toMatchObject({ status: 'sent' });
      expect(updatesTo(updates, workspaceInvitations)).toEqual([]);
    });
  });

  describe('the invitation email', () => {
    it('is scheduled on success, on the SAME transaction that marks the row sent', async () => {
      // The whole point of migration 0124: the email exists only once the invitee has something to
      // authenticate against, and the two facts commit together or not at all.
      const { relay, emailScheduler, updates } = build(async () => ({
        outcome: 'invited',
        guestObjectId: 'guest-oid-1',
      }));
      relay.batch = [row()];

      await relay.relay();

      expect(emailScheduler.schedule).toHaveBeenCalledOnce();
      const [payload, handle] = (emailScheduler.schedule as ReturnType<typeof vi.fn>).mock
        .calls[0] as [Record<string, unknown>, unknown];
      expect(payload).toMatchObject({
        to: 'dana@partner.example',
        template: 'workspace-invitation',
        // The SAME key `WorkspaceService.inviteMember` uses on the flag-off path, so the unique
        // constraint makes two invitation emails impossible however the flag moves.
        idempotencyKey: 'inv-1',
      });
      expect(payload.vars).toMatchObject({
        inviteUrl: `https://rova.example/accept-invitation?token=${RAW_TOKEN}`,
        workspaceName: 'NextGen',
        recipientEmail: 'dana@partner.example',
      });
      // Enlisted on the relay's transaction, not a standalone write.
      expect(handle).toBeDefined();
      expect(updatesTo(updates, guestInviteOutbox)[0]).toMatchObject({ status: 'sent' });
    });

    it('scrubs the raw token in that same write', async () => {
      // A `sent` row must not keep a live bearer credential — the security half of migration 0124.
      const { relay, updates } = build(async () => ({
        outcome: 'invited',
        guestObjectId: 'guest-oid-1',
      }));
      relay.batch = [row()];

      await relay.relay();

      expect(updatesTo(updates, guestInviteOutbox)[0]).toMatchObject({ inviteToken: null });
    });

    it('reports the days REMAINING, not the configured TTL', async () => {
      // The mail leaves after provisioning and possibly several backoff windows, so the configured
      // TTL would overstate the window the invitee actually has.
      const { relay, emailScheduler } = build(
        async () => ({ outcome: 'invited', guestObjectId: 'g1' }),
        { invitation: invitation({ expiresAt: new Date(Date.now() + 2.2 * 86_400_000) }) },
      );
      relay.batch = [row()];

      await relay.relay();

      expect(emailScheduler.schedule).toHaveBeenCalledWith(
        expect.objectContaining({ vars: expect.objectContaining({ expiresInDays: '3' }) }),
        expect.anything(),
      );
    });

    it('is NOT scheduled when the row carries no token', async () => {
      // A `resendInvitation` re-enqueue: it mailed its own freshly-rotated token inline, so an email
      // from here would be a second one — carrying the superseded link.
      const { relay, emailScheduler, updates } = build(async () => ({
        outcome: 'invited',
        guestObjectId: 'g1',
      }));
      relay.batch = [row({ inviteToken: null })];

      await relay.relay();

      expect(emailScheduler.schedule).not.toHaveBeenCalled();
      // Provisioning still happened, recorded the oid, and SUCCEEDED — the row must be `sent`, not
      // merely email-less. Without the explicit no-token check this path throws on a null token and
      // the row fails, which would look identical if only the absent email were asserted.
      expect(updatesTo(updates, guestInviteOutbox)).toEqual([
        expect.objectContaining({ status: 'sent' }),
      ]);
      expect(updatesTo(updates, workspaceInvitations)[0]).toMatchObject({
        entraGuestObjectId: 'g1',
      });
    });

    it('is NOT scheduled when the invitation is no longer pending', async () => {
      // Cancelled, already accepted, or superseded by `cancelExistingForEmail` on a re-invite. The
      // link is dead, so mailing it would be a dead end.
      const { relay, emailScheduler } = build(
        async () => ({ outcome: 'invited', guestObjectId: 'g1' }),
        { invitation: invitation({ status: 'cancelled' }) },
      );
      relay.batch = [row()];

      await relay.relay();

      expect(emailScheduler.schedule).not.toHaveBeenCalled();
    });

    it('is NOT scheduled when a resend has rotated the token', async () => {
      // The queued row holds the superseded token; the resend already mailed the live one inline.
      const { relay, emailScheduler } = build(
        async () => ({ outcome: 'invited', guestObjectId: 'g1' }),
        { invitation: invitation({ tokenHash: 'a-different-hash' }) },
      );
      relay.batch = [row()];

      await relay.relay();

      expect(emailScheduler.schedule).not.toHaveBeenCalled();
    });
  });

  describe('an address that already resolves to a directory object', () => {
    it('is SENT with the reason recorded, not failed', async () => {
      // The ordinary outcome for a staff mailbox. Failing it would page the dead-letter alarm for
      // work that was never lost, and leaving `last_error` empty would leave "sent, yet no guest id"
      // unanswerable on the row itself.
      const { relay, updates } = build(async () => ({
        outcome: 'already-in-directory',
        detail: 'No guest created — proxyAddresses already exists.',
      }));
      relay.batch = [row({ email: 'staff@qnsc.vn' })];

      await relay.relay();

      const outbox = updatesTo(updates, guestInviteOutbox);
      expect(outbox[0]).toMatchObject({
        status: 'sent',
        lastError: expect.stringContaining('proxyAddresses'),
      });
      expect(updatesTo(updates, workspaceInvitations)).toEqual([]);
    });

    it('STILL schedules the invitation email — they can already authenticate', async () => {
      // A directory member needs no guest, so nothing is pending on their behalf and the link is
      // usable the moment it arrives.
      const { relay, emailScheduler } = build(async () => ({
        outcome: 'already-in-directory',
        detail: 'No guest created — proxyAddresses already exists.',
      }));
      relay.batch = [row({ email: 'staff@qnsc.vn' })];

      await relay.relay();

      expect(emailScheduler.schedule).toHaveBeenCalledOnce();
    });
  });

  describe('a permanent Graph refusal', () => {
    it('is terminal on the FIRST attempt, with the refusal in last_error', async () => {
      // Not after five attempts and ~15 minutes of backoff: Graph answers a rejected address
      // identically every time, and the retries keep the row out of `status = 'failed'`, which is
      // the only place anyone looks for work that needs a human.
      const { relay, updates } = build(async () => {
        throw new PermanentGuestInviteError(
          'Graph POST /invitations failed (400) Request_BadRequest: invalid address',
        );
      });
      relay.batch = [row({ attempts: 0 })];

      await relay.relay();

      const outbox = updatesTo(updates, guestInviteOutbox);
      expect(outbox[0]).toMatchObject({
        status: 'failed',
        attempts: 1,
        lastError: expect.stringContaining('Request_BadRequest'),
      });
      // A terminal row keeps its scheduled_at — fetchBatch never selects 'failed' again.
      expect(outbox[0]).not.toHaveProperty('scheduledAt');
    });

    it('schedules NO email, and scrubs the token it will never use', async () => {
      // The invitee has no object in our tenant and never will under this configuration, so a link
      // would be a dead end — and would burn the invitation's one-shot token on a login that cannot
      // complete. The dead-letter log and `last_error` are the signal; Resend is the human action.
      const { relay, updates, emailScheduler } = build(async () => {
        throw new PermanentGuestInviteError('Graph POST /invitations failed (403): unconsented');
      });
      relay.batch = [row()];

      await relay.relay();

      expect(emailScheduler.schedule).not.toHaveBeenCalled();
      expect(updatesTo(updates, guestInviteOutbox)[0]).toMatchObject({
        status: 'failed',
        inviteToken: null,
      });
    });

    it('recognises permanence by ERROR TYPE, so a transient fault keeps its retry budget', async () => {
      const { relay, updates } = build(async () => {
        throw new Error('Graph POST /invitations failed (503): try again');
      });
      relay.batch = [row({ attempts: 0 })];

      await relay.relay();

      const outbox = updatesTo(updates, guestInviteOutbox);
      expect(outbox[0]).toMatchObject({ status: 'pending', attempts: 1 });
      // A retry, so scheduled_at moves forward by the base class's backoff.
      expect(outbox[0].scheduledAt).toBeInstanceOf(Date);
    });

    it('a transient fault schedules no email and KEEPS the token for the retry', async () => {
      // Mailing on a non-final attempt would race the very ordering this relay exists to guarantee,
      // and clearing the token would leave the eventual success unable to build the link.
      const { relay, updates, emailScheduler } = build(async () => {
        throw new Error('Graph POST /invitations failed (503): try again');
      });
      relay.batch = [row()];

      await relay.relay();

      expect(emailScheduler.schedule).not.toHaveBeenCalled();
      expect(updatesTo(updates, guestInviteOutbox)[0]).not.toHaveProperty('inviteToken');
    });
  });

  describe('ENTRA_GUEST_INVITE_ENABLED off after rows were queued', () => {
    it('still DRAINS them, because the flag gates enqueueing and not draining', async () => {
      // It used to return before polling, which was defensible while a queued row only owed a
      // directory write. Now the row also owes the invitation email, so leaving it alone would
      // strand both for ever and the invitee would never hear anything at all.
      const { relay, updates, emailScheduler, client } = build(
        async () => ({ outcome: 'invited', guestObjectId: 'g1' }),
        { enabled: false },
      );
      relay.batch = [row()];

      await relay.relay();

      expect(client.invite).toHaveBeenCalledOnce();
      expect(updatesTo(updates, guestInviteOutbox)[0]).toMatchObject({ status: 'sent' });
      expect(emailScheduler.schedule).toHaveBeenCalledOnce();
    });
  });

  describe('the wake signal', () => {
    it('is subscribed on module init, so the invitee does not wait out the cron', async () => {
      const { relay, pubSub } = build(async () => ({ outcome: 'invited', guestObjectId: 'g1' }));

      await relay.onModuleInit();

      expect(pubSub.subscribeGuestInviteRelayWake).toHaveBeenCalledOnce();
    });
  });
});
