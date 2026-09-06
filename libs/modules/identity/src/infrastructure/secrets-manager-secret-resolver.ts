import { Injectable, Optional } from '@nestjs/common';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { AppConfigService, buildAwsClientConfig } from '@platform';
import type { ISecretResolver } from '@quynhonsemiconductor/identity';

/**
 * A ref in ECS `valueFrom` form: "<secret arn>:<json key>:<version stage>:<version id>",
 * where the last two are usually empty — infra emits "<arn>:<key>::". Those trailing
 * fields are NOT part of the ARN, so passing the whole string to `GetSecretValue` fails
 * with `ValidationException: Invalid name`.
 *
 * An ARN has six colons of its own (arn:aws:secretsmanager:<region>:<account>:secret:<name>),
 * so the JSON key is field 7 and anything past it is the version selector.
 */
const ARN_FIELD_COUNT = 7;

function parseRef(ref: string): { secretId: string; jsonKey?: string } {
  if (!ref.startsWith('arn:')) return { secretId: ref };

  const fields = ref.split(':');
  if (fields.length <= ARN_FIELD_COUNT) return { secretId: ref };

  const jsonKey = fields[ARN_FIELD_COUNT];
  return {
    secretId: fields.slice(0, ARN_FIELD_COUNT).join(':'),
    // "<arn>::" selects no key — a bare container ARN with empty trailing fields.
    jsonKey: jsonKey === '' ? undefined : jsonKey,
  };
}

/**
 * Pulls one key out of a bundled secret's JSON. Every failure names the key and the
 * container but never the value — a resolver error reaches the global exception filter,
 * which logs the message.
 */
function extractKey(secretString: string, secretId: string, jsonKey: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error(
      `Secrets Manager secret ${secretId} is not JSON, but the reference selects key "${jsonKey}"`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `Secrets Manager secret ${secretId} is not a JSON object, but the reference selects key "${jsonKey}"`,
    );
  }

  const value = (parsed as Record<string, unknown>)[jsonKey];
  if (typeof value !== 'string') {
    throw new Error(
      value === undefined
        ? `Secrets Manager secret ${secretId} has no key "${jsonKey}"`
        : `Secrets Manager secret ${secretId} key "${jsonKey}" is not a string`,
    );
  }
  if (value === '') {
    throw new Error(`Secrets Manager secret ${secretId} key "${jsonKey}" is empty`);
  }
  return value;
}

/**
 * Resolves per-connection OIDC client secrets from AWS Secrets Manager — the
 * infra's paved path for sensitive values (CMK-encrypted; created empty in IaC,
 * value set out-of-band). Secrets live under `rova/${env}/sso/*`. Fetched at
 * use by the ECS task role (runtime), in-memory TTL-cached.
 *
 * Accepts BOTH forms the secrets module's `secret_arns` output emits: a plain ARN when
 * secrets are standalone, and "<bundle arn>:<key>::" when they are bundled into one JSON
 * secret. Call sites store whichever they were given — the seed writes it into
 * `sso_connections.client_secret_ref` — so this resolver is what makes the two infra
 * postures interchangeable, which is the promise that output's docs already make.
 */
@Injectable()
export class SecretsManagerSecretResolver implements ISecretResolver {
  private readonly client: SecretsManagerClient;
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();
  private readonly ttlMs = 300_000;

  /** `client` is an injectable seam for tests; production builds it from config. */
  constructor(config: AppConfigService, @Optional() client?: SecretsManagerClient) {
    this.client = client ?? new SecretsManagerClient(buildAwsClientConfig(config));
  }

  async get(ref: string): Promise<string> {
    const hit = this.cache.get(ref);
    if (hit && hit.expiresAt > Date.now()) return hit.value;

    const { secretId, jsonKey } = parseRef(ref);

    const out = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
    const secretString = out.SecretString;
    if (!secretString) {
      throw new Error(`Secrets Manager secret is empty or binary-only: ${secretId}`);
    }

    const value =
      jsonKey === undefined ? secretString : extractKey(secretString, secretId, jsonKey);

    // Cached on the FULL ref, so two keys out of one bundle stay distinct.
    this.cache.set(ref, { value, expiresAt: Date.now() + this.ttlMs });
    return value;
  }
}
