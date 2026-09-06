/**
 * EntraGuestInviteClient — the Graph half of B2B guest provisioning.
 *
 * What is worth pinning here is the CLASSIFICATION, not the happy path: which refusals are
 * permanent (so the relay dead-letters instead of burning five attempts over fifteen minutes),
 * which are transient (so retry and the circuit breaker apply), and which are not failures at all
 * (an address that already resolves to a directory object — the ordinary outcome for a staff
 * mailbox). Plus the request body, since a wrong `sendInvitationMessage` double-mails every
 * invitee, and the app-token cache, since one token per call would be a needless round-trip on
 * every row of a batch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntraGuestInviteClient, PermanentGuestInviteError } from './entra-guest-invite.client';
import type { AppConfigService, ResilienceService } from '@platform';

const CONFIG: Record<string, unknown> = {
  ENTRA_GUEST_INVITE_ENABLED: true,
  ENTRA_TENANT_ID: 'tenant-1',
  ENTRA_CLIENT_ID: 'client-1',
  ENTRA_CLIENT_SECRET: 'secret-1',
  APP_BASE_URL: 'https://rova.example',
};

function makeConfig(overrides: Record<string, unknown> = {}): AppConfigService {
  const values = { ...CONFIG, ...overrides };
  return { get: vi.fn((key: string) => values[key]) } as unknown as AppConfigService;
}

/**
 * Pass-through resilience: the real service is `handleAll` retry + breaker + timeout, none of which
 * this file is testing. It DOES matter that a permanent refusal never reaches it — that is asserted
 * by the throw happening outside `execute`, which the pass-through preserves.
 */
function makeResilience(): ResilienceService {
  return {
    execute: vi.fn(<T>(_name: string, op: () => Promise<T>) => op()),
  } as unknown as ResilienceService;
}

/** A successful client-credentials token response. */
const tokenOk = () =>
  new Response(JSON.stringify({ access_token: 'app-token', expires_in: 3600 }), { status: 200 });

const graphError = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status });

/**
 * Every request body this client sends is a string (`URLSearchParams.toString()` or
 * `JSON.stringify`), but `RequestInit['body']` is the whole `BodyInit` union — so read it through
 * one narrowing helper rather than stringifying a union at four call sites.
 */
const bodyOf = (init: RequestInit): string => init.body as string;

/** The Nth fetch call as a [url, init] pair. */
const callAt = (mock: ReturnType<typeof vi.fn>, index: number): [string, RequestInit] =>
  mock.mock.calls[index] as [string, RequestInit];

describe('EntraGuestInviteClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = (config = makeConfig()) => new EntraGuestInviteClient(config, makeResilience());

  describe('isConfigured', () => {
    it('is false while the flag is off, even with every credential present', () => {
      expect(client(makeConfig({ ENTRA_GUEST_INVITE_ENABLED: false })).isConfigured()).toBe(false);
    });

    it('is false when the borrowed BFF credentials are incomplete', () => {
      expect(client(makeConfig({ ENTRA_CLIENT_SECRET: undefined })).isConfigured()).toBe(false);
    });

    it('is true with the flag on and all three Entra values set', () => {
      expect(client().isConfigured()).toBe(true);
    });
  });

  describe('invite — the Graph request', () => {
    it('posts the documented body and returns the guest object id', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ invitedUser: { id: 'guest-oid-1' } }), { status: 201 }),
        );

      const result = await client().invite({ email: 'dana@partner.example' });

      expect(result).toEqual({ outcome: 'invited', guestObjectId: 'guest-oid-1' });

      // 1st call: app-only client credentials against the tenant's v2.0 token endpoint.
      const [tokenUrl, tokenInit] = callAt(fetchMock, 0);
      expect(tokenUrl).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
      expect(bodyOf(tokenInit)).toContain('grant_type=client_credentials');
      expect(bodyOf(tokenInit)).toContain(
        `scope=${encodeURIComponent('https://graph.microsoft.com/.default')}`,
      );

      // 2nd call: the invitation itself.
      const [graphUrl, graphInit] = callAt(fetchMock, 1);
      expect(graphUrl).toBe('https://graph.microsoft.com/v1.0/invitations');
      expect(graphInit.method).toBe('POST');
      expect(JSON.parse(bodyOf(graphInit))).toEqual({
        invitedUserEmailAddress: 'dana@partner.example',
        // The SPA origin, not the tokenized accept link: this relay holds only the token's hash.
        inviteRedirectUrl: 'https://rova.example',
        // Rally sends its own invitation email — two would be two calls to action for one invite.
        sendInvitationMessage: false,
      });
      expect((graphInit.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer app-token',
      );
    });

    it('includes invitedUserDisplayName only when there is one', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ invitedUser: { id: 'guest-oid-1' } }), { status: 201 }),
        );

      await client().invite({ email: 'dana@partner.example', displayName: 'Dana Partner' });

      const body = JSON.parse(bodyOf(callAt(fetchMock, 1)[1])) as Record<string, unknown>;
      expect(body.invitedUserDisplayName).toBe('Dana Partner');
    });

    it('tolerates a success body with no invitedUser', async () => {
      // The row is still `sent` — the guest exists; we simply have no oid to record, which the
      // nullable column already expresses.
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(new Response('{}', { status: 201 }));

      await expect(client().invite({ email: 'dana@partner.example' })).resolves.toEqual({
        outcome: 'invited',
        guestObjectId: null,
      });
    });

    it('caches the app token across calls, minting it once', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(new Response('{}', { status: 201 }))
        .mockResolvedValueOnce(new Response('{}', { status: 201 }));

      const c = client();
      await c.invite({ email: 'a@partner.example' });
      await c.invite({ email: 'b@partner.example' });

      const tokenCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/oauth2/v2.0/token'),
      );
      expect(tokenCalls).toHaveLength(1);
    });
  });

  describe('invite — refusals that are PERMANENT', () => {
    it('an address Graph will not accept (invalid characters, e.g. `+`)', async () => {
      // ~25 characters are rejected outright, so no retry can ever succeed for that mailbox.
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(
          graphError(
            400,
            'Request_BadRequest',
            "Invalid value specified for property 'invitedUserEmailAddress' of resource 'Invitation'.",
          ),
        );

      await expect(client().invite({ email: 'a+b@partner.example' })).rejects.toBeInstanceOf(
        PermanentGuestInviteError,
      );
    });

    it('B2B invitations disabled tenant-wide — app-only permission does not bypass it', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(
          graphError(
            403,
            'Authorization_RequestDenied',
            'Guest invitations are not allowed for this tenant.',
          ),
        );

      await expect(client().invite({ email: 'dana@partner.example' })).rejects.toMatchObject({
        name: 'PermanentGuestInviteError',
        // The refusal reaches `last_error` legibly, code and message intact.
        message: expect.stringContaining('Authorization_RequestDenied'),
      });
    });

    it('a missing User.Invite.All grant (403) — what the feature flag exists to avoid', async () => {
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(
          graphError(403, 'Authorization_RequestDenied', 'Insufficient privileges.'),
        );

      await expect(client().invite({ email: 'dana@partner.example' })).rejects.toBeInstanceOf(
        PermanentGuestInviteError,
      );
    });

    it('credentials that are not all configured, WITHOUT reaching the network', async () => {
      // Resolved before the resilience wrapper, so it cannot burn three retries or count three
      // breaker failures for a condition no retry changes.
      await expect(
        client(makeConfig({ ENTRA_CLIENT_SECRET: undefined })).invite({
          email: 'dana@partner.example',
        }),
      ).rejects.toBeInstanceOf(PermanentGuestInviteError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('invite — a directory collision is a SUCCESS, not a refusal', () => {
    it('reports already-in-directory for a proxyAddresses conflict', async () => {
      // The population that reaches this is staff: a `@qnsc.vn` invitation names a directory MEMBER
      // who needs no guest. Dead-lettering it would page the `outboxDeadLetter` alarm for work that
      // was never lost.
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(
          graphError(
            400,
            'Request_BadRequest',
            'Another object with the same value for property proxyAddresses already exists.',
          ),
        );

      const result = await client().invite({ email: 'staff@qnsc.vn' });

      expect(result.outcome).toBe('already-in-directory');
      expect(result).toMatchObject({ detail: expect.stringContaining('proxyAddresses') });
    });
  });

  describe('invite — faults that are TRANSIENT', () => {
    it.each([
      ['500 Graph outage', 500],
      ['429 throttling', 429],
      ['408 timeout', 408],
    ])('%s throws a plain Error, keeping the full retry budget', async (_label, status) => {
      fetchMock
        .mockResolvedValueOnce(tokenOk())
        .mockResolvedValueOnce(graphError(status, 'serviceNotAvailable', 'Try again later.'));

      const err = await client()
        .invite({ email: 'dana@partner.example' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(PermanentGuestInviteError);
    });

    it('a failed token request never echoes the response body — it carries the client secret', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'invalid_client',
            error_codes: [7000215],
            error_description: 'client_secret=secret-1 was invalid',
          }),
          { status: 401 },
        ),
      );

      const err = await client()
        .invite({ email: 'dana@partner.example' })
        .catch((e: unknown) => e);

      expect((err as Error).message).toContain('invalid_client');
      expect((err as Error).message).toContain('7000215');
      expect((err as Error).message).not.toContain('secret-1');
      // Transient by classification: a rotated secret or a login-endpoint blip both resolve.
      expect(err).not.toBeInstanceOf(PermanentGuestInviteError);
    });
  });
});
