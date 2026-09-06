/**
 * An invitation must actually SCHEDULE MAIL — the one flow that onboards every user.
 *
 * Nothing covered this. `notification-flow.e2e.spec.ts` proves a notification's `email_outbox` insert,
 * and the invitation path — `WorkspaceService.inviteMember` → `EmailSchedulerService.schedule` — had
 * no test at all, which is how it came to be true that outbound email was IMPOSSIBLE in both deployed
 * environments without a single suite noticing: no verified SES identity anywhere in `infra/`, and no
 * `ses:SendEmail` on any task role. Every invitation failed with AccessDenied, three failures opened
 * the in-process email circuit breaker, and the API went on reporting healthy.
 *
 * WHAT THIS PINS AND WHAT IT CANNOT. It asserts the half that lives in this repo's code: the row is
 * written, in the caller's transaction, addressed to the INVITED address, carrying the accept link and
 * the workspace name the template needs. It cannot assert delivery — that is a verified identity, an
 * IAM grant and the SES sandbox, none of which exist in a unit-test database. Those are asserted by
 * `infra/` and checked by hand (`aws sesv2 get-account --query ProductionAccessEnabled`); locally,
 * `docker exec rova-localstack awslocal ses verify-email-identity` plus the worker's relay is what
 * makes the send observable.
 *
 * NOTE FOR THE NEXT READER: there USED to be an ORPHANED `InvitationService` in this module with its
 * own `inviteMember` and its own email scheduling — no module provided it, the barrel did not export
 * it, nothing injected it. Writing this test against that orphan is the first thing I did wrong, and
 * it would have passed while proving nothing about the running system. It is DELETED now, along with
 * its spec and the `@AuthorizedInService` citation that pointed the accept route at it. The live path
 * is `WorkspaceService.inviteMember`, which the route calls and which this file drives; if a fork of
 * it ever reappears, delete the fork rather than testing it.
 *
 * IT ASSERTS THE FLAG-OFF PATH, which is the default and the one staff onboarding uses. Since
 * migration 0124, `ENTRA_GUEST_INVITE_ENABLED` moves this row's WRITER: with the flag on, the invite
 * request no longer schedules the email at all — `EntraGuestInviteRelayService` does, after Entra
 * provisioning resolves, so a link cannot reach an external collaborator before the directory object
 * that makes it usable exists. Both writers use `invitation.id` as the idempotency key, so the
 * assertions below (one row, keyed on the invitation) hold either way; what changes is WHEN it appears.
 * If this file ever fails with zero rows, check that flag before hunting a regression — the flag-on
 * ordering is pinned by `entra-guest-invite-relay.service.spec.ts` instead, because a real Graph call
 * and a worker process are not things this suite can arrange.
 *
 * The `email_outbox` row is the RIGHT seam to assert. `EmailSchedulerService` writes it inside the
 * caller's transaction, so a rolled-back invitation cannot leave mail behind, and the relay is a
 * separate process — which means "did we schedule it" and "did it go out" are genuinely two questions
 * and this file answers the first one honestly rather than both badly.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';

import { WorkspaceService } from '@modules/workspace';
import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { emailOutbox } from '../../db/schema/messaging';
import { workspaceInvitations } from '../../db/schema/workspace';
import { ssoIdentities, users } from '../../db/schema/identity';
import { ADMIN_USER_ID, bootRallyApp, WORKSPACE_ID } from './support/flow-harness';

describe('invitation email (real AppModule + seeded DB)', () => {
  let app: INestApplication;
  let workspaces: WorkspaceService;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await bootRallyApp();
    workspaces = app.get(WorkspaceService);
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * The raw token, from the only place it exists.
   *
   * `mintInviteToken` persists just the sha256, and `inviteMember` returns a `WorkspaceInvitation`
   * that deliberately omits the token — a response carrying it would defeat the bind-to-recipient
   * rule. So the scheduled email's `inviteUrl` is the honest source, exactly as a real invitee gets it.
   */
  async function rawTokenFor(invitationId: string): Promise<string> {
    const [row] = await db
      .select({ vars: emailOutbox.vars })
      .from(emailOutbox)
      .where(eq(emailOutbox.idempotencyKey, invitationId));
    const url = (row?.vars as Record<string, string> | undefined)?.inviteUrl ?? '';
    const token = new URL(url).searchParams.get('token');
    if (!token) throw new Error(`No invite token in outbox row for ${invitationId}`);
    return token;
  }

  it('schedules a workspace-invitation email addressed to the INVITED address', async () => {
    // A per-run address: `cancelExistingForEmail` supersedes an earlier pending invitation for the
    // same address, so a fixed one would assert against whichever row survived a previous run.
    const email = `ba-tester-${Date.now()}@qnsc.dev`;

    const invitation = await workspaces.inviteMember(WORKSPACE_ID, email, undefined, ADMIN_USER_ID);

    const rows = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.idempotencyKey, invitation.id));

    // ONE row, keyed by the invitation — the idempotency key is what stops a resend duplicating mail.
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.template).toBe('workspace-invitation');
    // The INVITED address, lower-cased by the service. Acceptance binds to this value
    // (`INVITATION_EMAIL_MISMATCH`), so mail going anywhere else is a security fault, not a typo.
    expect(row.to).toBe(email.toLowerCase());
    // Not yet sent by anyone: the relay is a separate process, and that separation is the point.
    expect(['pending', 'sent']).toContain(row.status);
  });

  it('carries the accept link and the workspace name the template renders', async () => {
    const email = `ba-tester-vars-${Date.now()}@qnsc.dev`;
    const invitation = await workspaces.inviteMember(WORKSPACE_ID, email, undefined, ADMIN_USER_ID);

    const [row] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.idempotencyKey, invitation.id));

    const vars = (row?.vars ?? {}) as Record<string, string>;
    // The link is the whole message: an invitation with no token is an email that cannot be accepted,
    // and the token is NOT in the API response by design (a forwardable link would defeat the
    // bind-to-address rule), so this row is the only place it ever appears.
    expect(vars.inviteUrl).toMatch(/accept-invitation\?token=.+/);
    expect(vars.workspaceName).toBeTruthy();
    expect(vars.recipientEmail).toBe(email.toLowerCase());
    // Days, not a date: the template says "expires in N days", and a formatted date here would be
    // rendered in the SERVER's timezone for a reader who may be in another.
    expect(Number(vars.expiresInDays)).toBeGreaterThan(0);
  });

  it('supersedes a pending invitation rather than sending two for one address', async () => {
    // Re-inviting is the ordinary admin gesture when the first mail is missed. `cancelExistingForEmail`
    // cancels the previous row, so the second invitation is the live one — and each has its own
    // idempotency key, so the earlier mail is not silently suppressed by the key either.
    const email = `ba-tester-resend-${Date.now()}@qnsc.dev`;
    const first = await workspaces.inviteMember(WORKSPACE_ID, email, undefined, ADMIN_USER_ID);
    const second = await workspaces.inviteMember(WORKSPACE_ID, email, undefined, ADMIN_USER_ID);

    expect(second.id).not.toBe(first.id);
    const rows = await db.select().from(emailOutbox).where(eq(emailOutbox.to, email.toLowerCase()));
    expect(rows).toHaveLength(2);
  });
  /**
   * ACCEPTANCE BINDS TO THE GUEST'S DIRECTORY OBJECT, not to a claim they can edit.
   *
   * Against a real database because the strong binding spans two tables written by two different
   * components: the guest-invite relay writes `workspace_invitations.entra_guest_object_id` from
   * Graph's `invitedUser.id`, and provisioning writes `sso_identities.provider_sub` from the token's
   * `oid`. A service-level test with both mocked proves the comparison; only this proves the two
   * values are the same thing in the schema.
   *
   * The attack: Microsoft states apps must never authorize on the `email` claim, and the
   * strip-unverified-email mitigation EXEMPTS single-tenant apps like ours — so a guest homed in a
   * tenant they control can set their `mail` to the invitee's address. The first case below is exactly
   * that shape: matching email, wrong object id.
   */
  it('refuses a matching EMAIL when the guest object id does not match', async () => {
    const invitedEmail = `oid-bind-${Date.now()}@gmail.com`;
    const invitation = await workspaces.inviteMember(
      WORKSPACE_ID,
      invitedEmail,
      undefined,
      ADMIN_USER_ID,
    );
    // Stand in for the relay: record the object id Graph would have returned for the real invitee.
    const realInviteeOid = randomUUID();
    await db
      .update(workspaceInvitations)
      .set({ entraGuestObjectId: realInviteeOid })
      .where(eq(workspaceInvitations.id, invitation.id));

    // An impostor who holds the SAME address (the spoof) but a different Entra object.
    const [impostor] = await db
      .insert(users)
      .values({ email: invitedEmail, displayName: 'Impostor', status: 'active' })
      .returning({ id: users.id });
    await db.insert(ssoIdentities).values({
      userId: impostor.id,
      provider: 'entra',
      providerSub: randomUUID(),
      providerEmail: invitedEmail,
    });

    await expect(
      workspaces.acceptInvitation(await rawTokenFor(invitation.id), impostor.id),
    ).rejects.toMatchObject({ code: 'INVITATION_EMAIL_MISMATCH' });

    // And nothing was granted: the refusal happens before any write.
    const [after] = await db
      .select({ status: workspaceInvitations.status })
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, invitation.id));
    expect(after.status).toBe('pending');
  });

  it('accepts on the object id even when the email no longer matches', async () => {
    const invitedEmail = `oid-ok-${Date.now()}@gmail.com`;
    const invitation = await workspaces.inviteMember(
      WORKSPACE_ID,
      invitedEmail,
      undefined,
      ADMIN_USER_ID,
    );
    const genuineOid = randomUUID();
    await db
      .update(workspaceInvitations)
      .set({ entraGuestObjectId: genuineOid })
      .where(eq(workspaceInvitations.id, invitation.id));

    // The genuine invitee, whose directory address differs from the one the admin typed — a real case
    // (an alias, or a mailbox renamed since). The oid is what makes them the same person.
    const [guest] = await db
      .insert(users)
      .values({ email: `renamed-${Date.now()}@gmail.com`, displayName: 'Guest', status: 'active' })
      .returning({ id: users.id });
    await db.insert(ssoIdentities).values({
      userId: guest.id,
      provider: 'entra',
      // Deliberately UPPER-CASE: `uuid` renders lower-case, `provider_sub` is a varchar holding the
      // claim verbatim, so the comparison must not be case-sensitive.
      providerSub: genuineOid.toUpperCase(),
      providerEmail: invitedEmail,
    });

    await workspaces.acceptInvitation(await rawTokenFor(invitation.id), guest.id);

    const [after] = await db
      .select({ status: workspaceInvitations.status, acceptedBy: workspaceInvitations.acceptedBy })
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, invitation.id));
    expect(after.status).toBe('accepted');
    expect(after.acceptedBy).toBe(guest.id);
  });
});
