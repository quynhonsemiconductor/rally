import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { EnvSchema } from './env.schema';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

/** Minimum that satisfies the rest of the schema, so these tests isolate the key pair. */
function env(overrides: Record<string, string> = {}) {
  return {
    DATABASE_URL: 'postgres://u:p@localhost:5432/rova',
    REDIS_URL: 'redis://localhost:6379',
    JWT_PRIVATE_KEY: privatePem,
    CSRF_SECRET: 'x'.repeat(32),
    COOKIE_SECRET: 'y'.repeat(32),
    ENTRA_TENANT_ID: 'tenant',
    ENTRA_CLIENT_ID: 'client',
    ENTRA_CLIENT_SECRET: 'secret',
    ENTRA_REDIRECT_URI: 'https://rova.example/v1/bff/callback',
    ...overrides,
  };
}

describe('EnvSchema — JWT key pair', () => {
  // The point of the derivation: a mismatched pair is the one failure a key pair
  // cannot otherwise have (signing succeeds, every verification rejects) and nothing
  // upstream can detect it, because both halves are individually valid.
  it('derives JWT_PUBLIC_KEY from JWT_PRIVATE_KEY when it is not supplied', () => {
    const result = EnvSchema.safeParse(env());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.JWT_PUBLIC_KEY).toBe(publicPem);
  });

  it('derives a key that actually matches the private half', () => {
    const result = EnvSchema.safeParse(env());
    if (!result.success) throw new Error('expected parse to succeed');
    const fromPrivate = createPublicKey(result.data.JWT_PRIVATE_KEY)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    expect(result.data.JWT_PUBLIC_KEY).toBe(fromPrivate);
  });

  it('honours an explicitly supplied JWT_PUBLIC_KEY', () => {
    const result = EnvSchema.safeParse(env({ JWT_PUBLIC_KEY: publicPem }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.JWT_PUBLIC_KEY).toBe(publicPem);
  });

  it('accepts a base64-encoded private key and still derives from it', () => {
    const result = EnvSchema.safeParse(
      env({ JWT_PRIVATE_KEY: Buffer.from(privatePem).toString('base64') }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.JWT_PUBLIC_KEY).toBe(publicPem);
  });

  // A public key pasted into the private slot is well-formed PEM, so it passes the
  // field-level refine and would otherwise fail much later, at the first sign().
  it('fails with a message naming JWT_PRIVATE_KEY when a public key is supplied as the private one', () => {
    const result = EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: publicPem }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes('JWT_PRIVATE_KEY'));
    expect(issue?.message).toMatch(/not a PRIVATE key/);
  });

  // ES256 is P-256 specifically. Another curve signs fine and every verifier rejects
  // the result, which presents as a broken deploy with no obvious cause.
  it('rejects an EC key on the wrong curve', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const result = EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: p384 }));
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.includes('JWT_PRIVATE_KEY'));
    expect(issue?.message).toMatch(/must be an EC P-256 key for ES256/);
  });

  it('rejects an RSA key', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: rsa })).success).toBe(false);
  });

  it('still rejects a JWT_PRIVATE_KEY that is not PEM at all', () => {
    const result = EnvSchema.safeParse(env({ JWT_PRIVATE_KEY: 'not-a-key' }));
    expect(result.success).toBe(false);
  });
});

describe('EnvSchema — REDIS_URL', () => {
  // It used to default to redis://localhost:6379. That is harmless locally and
  // dangerous everywhere else: a deployed task missing the injection connected to
  // nothing on its own loopback instead of failing to boot. Sessions live only in
  // Valkey, and the token denylist and rate limiter both FAIL OPEN when it is
  // unreachable — so the service answered healthz with 200 while revoked tokens kept
  // working and rate limiting was off.
  it('is required, with no localhost fallback', () => {
    const withoutRedis = env();
    delete (withoutRedis as Record<string, unknown>).REDIS_URL;
    const result = EnvSchema.safeParse(withoutRedis);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain('REDIS_URL');
  });

  it('rejects a value that is not a URL', () => {
    expect(EnvSchema.safeParse(env({ REDIS_URL: 'not-a-url' })).success).toBe(false);
    expect(EnvSchema.safeParse(env({ REDIS_URL: '' })).success).toBe(false);
  });

  it('accepts both the deployed and local schemes', () => {
    // Deployed nodes enable transit encryption, so the scheme is always rediss://.
    expect(
      EnvSchema.safeParse(env({ REDIS_URL: 'rediss://master.x.cache.amazonaws.com:6379' })).success,
    ).toBe(true);
    expect(EnvSchema.safeParse(env({ REDIS_URL: 'redis://localhost:6379' })).success).toBe(true);
  });
});

describe('EnvSchema — email sender', () => {
  /**
   * The sender is required whenever mail actually leaves the process.
   *
   * `MAIL_FROM_EMAIL` documented itself as "Required when EMAIL_PROVIDER != 'dev'" and was
   * `.optional()`, so nothing enforced it — and both deployed environments ran
   * `EMAIL_PROVIDER=ses` with no sender. Every message went out as `"Mini Rally" <>`, SES rejected
   * each one, three failures opened the email circuit breaker for the life of the process, and the
   * task went on reporting healthy. Invitations, notifications and password resets simply never
   * arrived, with nothing in the health checks to say so.
   */
  it('REFUSES to boot with a real provider and no sender', () => {
    const result = EnvSchema.safeParse(env({ EMAIL_PROVIDER: 'ses' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    // The message has to name the way out, both of them: set a sender, or stop sending.
    const issue = result.error.issues.find((i) => i.path.includes('MAIL_FROM_EMAIL'));
    expect(issue?.message).toMatch(/MAIL_FROM_EMAIL/);
    expect(issue?.message).toMatch(/EMAIL_PROVIDER=dev/);
  });

  it('boots with a sender', () => {
    const result = EnvSchema.safeParse(
      env({ EMAIL_PROVIDER: 'ses', MAIL_FROM_EMAIL: 'noreply@qnsc.vn' }),
    );
    expect(result.success).toBe(true);
  });

  it('needs no sender for the dev provider, which only logs', () => {
    // The default. Local development and CI must not have to configure mail at all.
    expect(EnvSchema.safeParse(env({ EMAIL_PROVIDER: 'dev' })).success).toBe(true);
    expect(EnvSchema.safeParse(env()).success).toBe(true);
  });

  it('rejects a resend deployment with no sender too — the rule is about SENDING', () => {
    const result = EnvSchema.safeParse(env({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k' }));
    expect(result.success).toBe(false);
  });
});

describe('EnvSchema — refinements are not disabled by an early return', () => {
  /**
   * The storage-credential rule existed and never ran.
   *
   * `superRefine` opened with `if (env.DATABASE_URL) return;`, which returned out of the WHOLE
   * block — so every rule written after the database check was dead for any deploy that used a
   * database URL, which is every deploy we have. Both live rules are asserted here with
   * `DATABASE_URL` set, which is the configuration that used to skip them.
   */
  it('still checks the public-storage credential PAIR when DATABASE_URL is set', () => {
    const half = EnvSchema.safeParse(env({ STORAGE_PUBLIC_ACCESS_KEY_ID: 'AKIA' }));
    expect(half.success).toBe(false);

    const other = EnvSchema.safeParse(env({ STORAGE_PUBLIC_SECRET_ACCESS_KEY: 'secret' }));
    expect(other.success).toBe(false);

    const both = EnvSchema.safeParse(
      env({ STORAGE_PUBLIC_ACCESS_KEY_ID: 'AKIA', STORAGE_PUBLIC_SECRET_ACCESS_KEY: 'secret' }),
    );
    expect(both.success).toBe(true);
  });

  it('still reports missing database parts when DATABASE_URL is absent', () => {
    const { DATABASE_URL, ...withoutUrl } = env();
    // Asserted, not discarded: if the fixture ever stops setting a URL, this test would otherwise
    // "pass" while proving nothing about the branch it is here to cover. (It also keeps the binding
    // used — `no-unused-vars` only exempts `^_` for arguments, not for destructured variables.)
    expect(DATABASE_URL).toBeTruthy();

    const result = EnvSchema.safeParse(withoutUrl);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((i) => i.message.includes('DATABASE_HOST'))).toBe(true);
  });
});
