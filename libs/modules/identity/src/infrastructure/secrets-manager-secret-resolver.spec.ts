import { describe, it, expect, vi } from 'vitest';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { AppConfigService } from '@platform';
import { SecretsManagerSecretResolver } from './secrets-manager-secret-resolver';

const config = {} as AppConfigService; // unused when a client is injected

function makeResolver(send: ReturnType<typeof vi.fn>) {
  const client = { send } as unknown as SecretsManagerClient;
  return new SecretsManagerSecretResolver(config, client);
}

describe('SecretsManagerSecretResolver', () => {
  it('fetches and returns the SecretString', async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: 's3cr3t' });
    expect(await makeResolver(send).get('rova/dev/sso/home')).toBe('s3cr3t');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('caches within the TTL (one fetch for repeated refs)', async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: 's3cr3t' });
    const r = makeResolver(send);
    await r.get('rova/dev/sso/home');
    await r.get('rova/dev/sso/home');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fetches distinct refs separately', async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: 's3cr3t' });
    const r = makeResolver(send);
    await r.get('rova/dev/sso/a');
    await r.get('rova/dev/sso/b');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws when the secret has no string value (empty or binary-only)', async () => {
    const send = vi.fn().mockResolvedValue({ SecretString: undefined });
    await expect(makeResolver(send).get('rova/dev/sso/home')).rejects.toThrow(
      /empty or binary-only/,
    );
  });

  // A bundled ref is "<arn>:<key>::" — the ECS valueFrom form. Passed to GetSecretValue
  // verbatim it fails with `ValidationException: Invalid name`, which is exactly what
  // broke SSO login on develop when the secrets module switched to `use_bundle`.
  describe('bundled refs ("<arn>:<key>::")', () => {
    const BUNDLE =
      'arn:aws:secretsmanager:ap-southeast-1:608983206583:secret:rally/develop/app-bH4nIC';
    const REF = `${BUNDLE}:entra-client-secret::`;

    it('strips the key suffix before calling GetSecretValue', async () => {
      const send = vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({ 'entra-client-secret': 's3cr3t' }),
      });
      await makeResolver(send).get(REF);
      expect(send.mock.calls[0][0].input.SecretId).toBe(BUNDLE);
    });

    it('returns the selected key, not the whole JSON', async () => {
      const send = vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({ 'entra-client-secret': 's3cr3t', 'csrf-secret': 'other' }),
      });
      expect(await makeResolver(send).get(REF)).toBe('s3cr3t');
    });

    it('caches on the full ref, so two keys in one bundle stay distinct', async () => {
      const send = vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({ a: 'value-a', b: 'value-b' }),
      });
      const r = makeResolver(send);
      expect(await r.get(`${BUNDLE}:a::`)).toBe('value-a');
      expect(await r.get(`${BUNDLE}:b::`)).toBe('value-b');
    });

    it('names the missing key rather than returning undefined', async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ other: 'x' }) });
      await expect(makeResolver(send).get(REF)).rejects.toThrow(/has no key "entra-client-secret"/);
    });

    it('rejects a present-but-empty key instead of authenticating with ""', async () => {
      const send = vi.fn().mockResolvedValue({
        SecretString: JSON.stringify({ 'entra-client-secret': '' }),
      });
      await expect(makeResolver(send).get(REF)).rejects.toThrow(/is empty/);
    });

    it('explains a non-JSON body rather than surfacing a parse error', async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: 'a-plain-standalone-value' });
      await expect(makeResolver(send).get(REF)).rejects.toThrow(/is not JSON/);
    });
  });

  // Standalone ARNs must keep working untouched: `use_bundle` is reversible, and that
  // rollback must not require an app release.
  describe('standalone ARNs', () => {
    const ARN =
      'arn:aws:secretsmanager:ap-southeast-1:608983206583:secret:rally/develop/jwt-private-AbCdEf';

    it('passes a plain ARN through and returns the whole string', async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: 'not-json-at-all' });
      expect(await makeResolver(send).get(ARN)).toBe('not-json-at-all');
      expect(send.mock.calls[0][0].input.SecretId).toBe(ARN);
    });

    it('treats an empty key selector as "no key" and returns the whole string', async () => {
      const send = vi.fn().mockResolvedValue({ SecretString: 'whole-value' });
      expect(await makeResolver(send).get(`${ARN}::`)).toBe('whole-value');
      expect(send.mock.calls[0][0].input.SecretId).toBe(ARN);
    });
  });
});
