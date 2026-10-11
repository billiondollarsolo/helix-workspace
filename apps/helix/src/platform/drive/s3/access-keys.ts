import type { Actor } from "@helix/sdk-types";
import type postgres from "postgres";
import { actorHasScope } from "../../../api/scopes.js";
import { getCryptoProvider } from "../../crypto/index.js";
import { parseActorRoleBindings } from "../../permissions/roles.js";
import type { TenantEnvelopeCipher } from "../../secrets/envelope.js";

/** Drive scopes an S3 access key may carry; the same grants WebDAV desktop sync uses. */
export const DRIVE_S3_KEY_SCOPES = ["drive.read", "drive.write", "drive.delete"] as const;
export type DriveS3KeyScope = (typeof DRIVE_S3_KEY_SCOPES)[number];

const ENVELOPE_PURPOSE = "drive.s3-access-key";
const ACCESS_KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ACCESS_KEY_ID_RE = /^HLX[A-Z2-7]{17}$/u;
/** Write `last_used_at` at most this often per key so reads stay read-only. */
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export interface DriveS3AccessKeyRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly accessKeyId: string;
  readonly label: string;
  readonly scopes: readonly DriveS3KeyScope[];
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface DriveS3AccessKeyCreation {
  readonly accessKey: DriveS3AccessKeyRecord;
  /** Returned once; only the tenant envelope is persisted. */
  readonly secretAccessKey: string;
}

export interface AuthenticatedDriveS3Key {
  readonly key: DriveS3AccessKeyRecord;
  /** The key's actor, with scopes narrowed to the key's grant. */
  readonly actor: Actor;
  readonly secretAccessKey: string;
}

export interface DriveS3AccessKeyStore {
  create(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly label: string;
    readonly scopes: readonly DriveS3KeyScope[];
    readonly expiresAt?: Date | null;
  }): Promise<DriveS3AccessKeyCreation>;
  list(input: {
    readonly orgId: string;
    readonly actorId?: string;
    readonly includeRevoked?: boolean;
  }): Promise<readonly DriveS3AccessKeyRecord[]>;
  revoke(input: {
    readonly orgId: string;
    readonly id: string;
    /** Restrict revocation to this actor's own keys. */
    readonly actorId?: string;
  }): Promise<DriveS3AccessKeyRecord | null>;
  /** Resolves an active key for SigV4 verification, or null when unknown or inactive. */
  authenticate(accessKeyId: string): Promise<AuthenticatedDriveS3Key | null>;
  /** Records a verified use of the key (throttled); call only after the signature checks out. */
  recordUse(key: DriveS3AccessKeyRecord): Promise<void>;
}

type EnvelopeCipher = Pick<TenantEnvelopeCipher, "seal" | "open">;

interface AccessKeyRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly access_key_id: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly last_used_at: Date | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

interface AccessKeyAuthRow extends AccessKeyRow {
  readonly secret_envelope: string;
  readonly actor_type: Actor["type"];
  readonly actor_email: string | null;
  readonly actor_display_name: string | null;
  readonly actor_scopes: readonly string[] | null;
  readonly role_bindings: unknown;
}

function generateAccessKeyId(): string {
  const bytes = getCryptoProvider().randomBytes(17);
  let id = "HLX";
  for (const byte of bytes) id += ACCESS_KEY_ALPHABET.charAt(byte % 32);
  return id;
}

function generateSecretAccessKey(): string {
  return getCryptoProvider().randomBytes(30).toString("base64url");
}

function isDriveS3KeyScope(value: string): value is DriveS3KeyScope {
  return (DRIVE_S3_KEY_SCOPES as readonly string[]).includes(value);
}

export class PostgresDriveS3AccessKeyStore implements DriveS3AccessKeyStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly cipher: EnvelopeCipher,
  ) {}

  async create(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly label: string;
    readonly scopes: readonly DriveS3KeyScope[];
    readonly expiresAt?: Date | null;
  }): Promise<DriveS3AccessKeyCreation> {
    const accessKeyId = generateAccessKeyId();
    const secretAccessKey = generateSecretAccessKey();
    const envelope = this.cipher.seal(input.orgId, ENVELOPE_PURPOSE, secretAccessKey);
    const rows = await this.sql<AccessKeyRow[]>`
      insert into drive_s3_access_keys (
        org_id, actor_id, access_key_id, secret_envelope, label, scopes, expires_at
      )
      select ${input.orgId}, actors.id, ${accessKeyId}, ${envelope}, ${input.label},
        ${this.sql.array([...new Set(input.scopes)])}, ${input.expiresAt ?? null}
      from actors
      where actors.id = ${input.actorId} and actors.org_id = ${input.orgId}
        and actors.disabled_at is null
      returning id, org_id, actor_id, access_key_id, label, scopes, last_used_at,
        expires_at, revoked_at, created_at
    `;
    const accessKey = mapRow(rows[0]);
    if (accessKey === null) throw new Error("Cannot create an S3 access key for this actor.");
    return { accessKey, secretAccessKey };
  }

  async list(input: {
    readonly orgId: string;
    readonly actorId?: string;
    readonly includeRevoked?: boolean;
  }): Promise<readonly DriveS3AccessKeyRecord[]> {
    const rows = await this.sql<AccessKeyRow[]>`
      select id, org_id, actor_id, access_key_id, label, scopes, last_used_at,
        expires_at, revoked_at, created_at
      from drive_s3_access_keys
      where org_id = ${input.orgId}
        and (${input.actorId ?? null}::uuid is null or actor_id = ${input.actorId ?? null}::uuid)
        and (${input.includeRevoked === true}::boolean or revoked_at is null)
      order by created_at desc, id
    `;
    return rows.flatMap((row) => mapRow(row) ?? []);
  }

  async revoke(input: {
    readonly orgId: string;
    readonly id: string;
    readonly actorId?: string;
  }): Promise<DriveS3AccessKeyRecord | null> {
    const rows = await this.sql<AccessKeyRow[]>`
      update drive_s3_access_keys
      set revoked_at = now()
      where org_id = ${input.orgId} and id = ${input.id} and revoked_at is null
        and (${input.actorId ?? null}::uuid is null or actor_id = ${input.actorId ?? null}::uuid)
      returning id, org_id, actor_id, access_key_id, label, scopes, last_used_at,
        expires_at, revoked_at, created_at
    `;
    return mapRow(rows[0]);
  }

  async recordUse(key: DriveS3AccessKeyRecord): Promise<void> {
    if (
      key.lastUsedAt !== null &&
      Date.now() - key.lastUsedAt.getTime() <= LAST_USED_WRITE_INTERVAL_MS
    ) {
      return;
    }
    await this.sql`
      update drive_s3_access_keys set last_used_at = now()
      where id = ${key.id} and org_id = ${key.orgId}
    `;
  }

  async authenticate(accessKeyId: string): Promise<AuthenticatedDriveS3Key | null> {
    if (!ACCESS_KEY_ID_RE.test(accessKeyId)) return null;
    const rows = await this.sql<AccessKeyAuthRow[]>`
      select k.id, k.org_id, k.actor_id, k.access_key_id, k.label, k.scopes, k.last_used_at,
        k.expires_at, k.revoked_at, k.created_at, k.secret_envelope,
        a.type as actor_type, a.email as actor_email, a.display_name as actor_display_name,
        a.scopes as actor_scopes, helix_actor_role_bindings(a.org_id, a.id) as role_bindings
      from drive_s3_access_keys k
      join actors a on a.id = k.actor_id and a.org_id = k.org_id
      where k.access_key_id = ${accessKeyId}
        and k.revoked_at is null
        and (k.expires_at is null or k.expires_at > now())
        and a.disabled_at is null
        and helix_credential_principal_is_active(a.id, a.org_id)
      limit 1
    `;
    const row = rows[0];
    const key = mapRow(row);
    if (row === undefined || key === null) return null;
    let secretAccessKey: string;
    try {
      secretAccessKey = this.cipher.open(row.org_id, ENVELOPE_PURPOSE, row.secret_envelope);
    } catch {
      return null;
    }
    const roleBindings = parseActorRoleBindings(row.role_bindings);
    return {
      key,
      secretAccessKey,
      actor: {
        id: row.actor_id,
        orgId: row.org_id,
        type: row.actor_type,
        ...(row.actor_display_name === null ? {} : { displayName: row.actor_display_name }),
        ...(row.actor_email === null ? {} : { email: row.actor_email }),
        scopes: row.actor_scopes ?? [],
        ...(roleBindings.length === 0 ? {} : { roleBindings }),
      },
    };
  }
}

/**
 * Narrows a key's actor to the key's grant and the actor's current authority.
 * Returns null when either one lacks `requiredScope`, mirroring app passwords.
 */
export function restrictDriveS3Actor(
  authenticated: AuthenticatedDriveS3Key,
  requiredScope: DriveS3KeyScope,
): Actor | null {
  const { actor, key } = authenticated;
  if (actor.type !== "user" || !actorHasScope(actor, requiredScope)) return null;
  if (!key.scopes.includes(requiredScope)) return null;
  // The key's grant replaces ambient scopes and role bindings for the request.
  const { roleBindings: _ambient, ...restricted } = actor;
  return { ...restricted, scopes: key.scopes.filter((scope) => actorHasScope(actor, scope)) };
}

function mapRow(row: AccessKeyRow | undefined): DriveS3AccessKeyRecord | null {
  if (row === undefined) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    accessKeyId: row.access_key_id,
    label: row.label,
    scopes: row.scopes.filter(isDriveS3KeyScope),
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}
