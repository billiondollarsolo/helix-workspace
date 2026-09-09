import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { Redis } from "ioredis";
import type { JsonObject, JsonValue } from "@helix/sdk";
import type { AuditAnchorSigner, ImmutableAuditObjectStore } from "../audit/immutable-s3.js";
import { canonicalJson } from "../audit/hash.js";
import type { SearchEngine } from "../search/types.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import type { OrgRecord } from "./orgs.js";

export interface TenantDeletionProofRecord {
  readonly orgId: string;
  readonly status: "pending" | "blocked" | "running" | "completed" | "failed";
  readonly attemptCount: number;
  readonly objectKeys: readonly string[];
  readonly blockers: readonly JsonObject[];
  readonly systemActorId: string;
  readonly sqlCounts: JsonObject;
  readonly manifest: JsonObject | null;
  readonly manifestSha256: string | null;
  readonly proofSignature: string | null;
  readonly proofKeyId: string | null;
  readonly proofObjectKey: string | null;
  readonly completedAt: Date | null;
}

export interface TenantDeletionStore {
  prepare(orgId: string): Promise<TenantDeletionProofRecord>;
  recordStep(orgId: string, step: string): Promise<void>;
  purgeSql(orgId: string): Promise<JsonObject>;
  complete(input: {
    readonly orgId: string;
    readonly manifest: JsonObject;
    readonly manifestSha256: string;
    readonly proofSignature: string;
    readonly proofKeyId: string;
    readonly proofObjectKey: string;
  }): Promise<TenantDeletionProofRecord>;
  find(orgId: string): Promise<TenantDeletionProofRecord | null>;
}

export interface TenantDeletionSecretPurger {
  deleteTenantSecrets(input: { readonly orgId: string }): Promise<number>;
}

export interface TenantDeletionCachePurger {
  purgeTenant(orgId: string): Promise<number>;
}

export interface TenantDeletionResult {
  readonly manifest: JsonObject;
  readonly manifestSha256: string;
  readonly proofSignature: string;
  readonly proofObjectKey: string;
  readonly systemActorId: string;
}

interface TenantDeletionWorkflowOptions {
  readonly store: TenantDeletionStore;
  readonly storageResolver: TenantStorageResolver;
  readonly proofStore: ImmutableAuditObjectStore;
  readonly signer: AuditAnchorSigner;
  readonly search?: SearchEngine | undefined;
  readonly cache?: TenantDeletionCachePurger | undefined;
  readonly secrets?: TenantDeletionSecretPurger | undefined;
  readonly now?: (() => Date) | undefined;
  readonly proofRetentionDays?: number | undefined;
}

export class TenantDeletionBlockedError extends Error {
  constructor(readonly blockers: readonly JsonObject[]) {
    super("Tenant deletion is blocked by retention or legal hold.");
    this.name = "TenantDeletionBlockedError";
  }
}

export class TenantDeletionWorkflow {
  readonly #now: () => Date;
  readonly #retentionDays: number;

  constructor(private readonly options: TenantDeletionWorkflowOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#retentionDays = options.proofRetentionDays ?? 3650;
  }

  async run(org: OrgRecord): Promise<TenantDeletionResult> {
    const prepared = await this.options.store.prepare(org.id);
    if (prepared.status === "completed") return completedResult(prepared);
    if (prepared.blockers.length > 0) throw new TenantDeletionBlockedError(prepared.blockers);

    const storage = await this.options.storageResolver({ orgId: org.id, refresh: true });
    if (storage?.client.listKeys === undefined) {
      throw new Error("Tenant storage must support namespace listing before hard deletion.");
    }
    let deletedObjects = 0;
    for await (const key of storage.client.listKeys("")) {
      await storage.client.delete(key);
      deletedObjects += 1;
    }
    for await (const key of storage.client.listKeys("")) {
      throw new Error(`Tenant object namespace still contains ${key}.`);
    }
    await this.options.store.recordStep(org.id, "objects");

    const deletedSearchDocuments =
      this.options.search === undefined ? 0 : await purgeTenantSearch(this.options.search, org.id);
    await this.options.store.recordStep(org.id, "search");
    const deletedCacheEntries = await this.options.cache?.purgeTenant(org.id);
    await this.options.store.recordStep(org.id, "cache");
    const deletedSecrets = await this.options.secrets?.deleteTenantSecrets({ orgId: org.id });
    await this.options.store.recordStep(org.id, "secrets");

    const sqlCounts = await this.options.store.purgeSql(org.id);
    const completedAt = this.#now();
    const manifest: JsonObject = {
      version: 1,
      orgId: org.id,
      orgSlug: org.slug,
      softDeletedAt: org.softDeletedAt?.toISOString() ?? null,
      completedAt: completedAt.toISOString(),
      purged: {
        objectNamespace: {
          discoveredDatabaseKeys: prepared.objectKeys.length,
          deletedThisAttempt: deletedObjects,
          verifiedEmpty: true,
        },
        search: { deletedDocuments: deletedSearchDocuments },
        cache: { deletedEntries: deletedCacheEntries ?? 0 },
        secrets: {
          deletedExternalSecrets: deletedSecrets ?? 0,
          sqlCredentialsIncludedInSqlPurge: true,
        },
        postgres: sqlCounts,
      },
      retainedEvidence: {
        orgTombstone: true,
        auditChain: true,
        redactedAuditPrincipals: true,
        deletionProof: true,
      },
      backups: {
        status: "declared_retained_until_expiry",
        restoreGuard: "hard_deleted tenant tombstone denies restoration",
        disposition: "encrypted backup blocks expire under the operator backup lifecycle",
        proofDoesNotClaimImmediatePhysicalBackupErasure: true,
      },
    };
    const bytes = Buffer.from(canonicalJson(manifest as JsonValue));
    const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
    const proofSignature = await this.options.signer.sign(bytes);
    const proofObjectKey = `compliance/tenant-deletions/${org.id}/${manifestSha256}.json`;
    const proof = Buffer.from(
      canonicalJson({
        authentication: {
          algorithm: "HMAC-SHA256",
          keyId: this.options.signer.keyId,
          signature: proofSignature,
        },
        manifest,
        manifestSha256,
      }),
    );
    await this.options.proofStore.putObject({
      key: proofObjectKey,
      body: proof,
      contentType: "application/json; charset=utf-8",
      metadata: { "manifest-sha256": manifestSha256, "tenant-id": org.id },
      objectLock: {
        mode: "COMPLIANCE",
        retainUntil: new Date(
          completedAt.getTime() + this.#retentionDays * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    });
    const completed = await this.options.store.complete({
      orgId: org.id,
      manifest,
      manifestSha256,
      proofSignature,
      proofKeyId: this.options.signer.keyId,
      proofObjectKey,
    });
    return completedResult(completed);
  }
}

export class PostgresTenantDeletionStore implements TenantDeletionStore {
  constructor(private readonly sql: postgres.Sql) {}

  async prepare(orgId: string): Promise<TenantDeletionProofRecord> {
    const rows = await this.sql`select * from helix_prepare_tenant_deletion(${orgId})`;
    return mapProof(rows[0]);
  }

  async recordStep(orgId: string, step: string): Promise<void> {
    await this.sql`select helix_record_tenant_deletion_step(${orgId}, ${step})`;
  }

  async purgeSql(orgId: string): Promise<JsonObject> {
    const rows = await this.sql`select helix_purge_tenant_sql(${orgId}) as counts`;
    return (rows[0]?.counts ?? {}) as JsonObject;
  }

  async complete(input: Parameters<TenantDeletionStore["complete"]>[0]): Promise<TenantDeletionProofRecord> {
    const rows = await this.sql`
      select * from helix_complete_tenant_deletion(
        ${input.orgId}, ${this.sql.json(input.manifest)}, ${input.manifestSha256},
        ${input.proofSignature}, ${input.proofKeyId}, ${input.proofObjectKey}
      )
    `;
    return mapProof(rows[0]);
  }

  async find(orgId: string): Promise<TenantDeletionProofRecord | null> {
    const rows = await this.sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${orgId}, true)`;
      return tx`select * from tenant_deletion_proofs where org_id = ${orgId}`;
    });
    return rows[0] === undefined ? null : mapProof(rows[0]);
  }
}

export function createRedisTenantDeletionCachePurger(
  redis: Pick<Redis, "scan" | "del">,
): TenantDeletionCachePurger {
  return {
    async purgeTenant(orgId) {
      let cursor = "0";
      let deleted = 0;
      do {
        const [next, keys] = await redis.scan(cursor, "MATCH", `*${orgId}*`, "COUNT", 500);
        if (keys.length > 0) deleted += await redis.del(...keys);
        cursor = next;
      } while (cursor !== "0");
      return deleted;
    },
  };
}

async function purgeTenantSearch(engine: SearchEngine, orgId: string): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await engine.search({
      query: "",
      filter: `attributes.orgId = "${orgId}"`,
      limit: 1000,
      offset: 0,
      attributesToRetrieve: ["id", "type"],
    });
    const ids = page.hits.map((hit) => hit.id);
    if (ids.length === 0) return deleted;
    await engine.delete(ids);
    deleted += ids.length;
  }
}

function completedResult(record: TenantDeletionProofRecord): TenantDeletionResult {
  if (
    record.manifest === null ||
    record.manifestSha256 === null ||
    record.proofSignature === null ||
    record.proofObjectKey === null
  ) {
    throw new Error("Completed tenant deletion is missing proof material.");
  }
  return {
    manifest: record.manifest,
    manifestSha256: record.manifestSha256,
    proofSignature: record.proofSignature,
    proofObjectKey: record.proofObjectKey,
    systemActorId: record.systemActorId,
  };
}

function mapProof(row: Record<string, unknown> | undefined): TenantDeletionProofRecord {
  if (row === undefined) throw new Error("Tenant deletion proof query returned no row.");
  return {
    orgId: String(row.org_id),
    status: row.status as TenantDeletionProofRecord["status"],
    attemptCount: Number(row.attempt_count),
    objectKeys: stringArray(row.object_keys),
    blockers: objectArray(row.blockers),
    systemActorId: String(row.system_actor_id),
    sqlCounts: objectValue(row.sql_counts),
    manifest: row.manifest === null ? null : objectValue(row.manifest),
    manifestSha256: nullableString(row.manifest_sha256),
    proofSignature: nullableString(row.proof_signature),
    proofKeyId: nullableString(row.proof_key_id),
    proofObjectKey: nullableString(row.proof_object_key),
    completedAt: row.completed_at instanceof Date ? row.completed_at : null,
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectArray(value: unknown): readonly JsonObject[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
    : [];
}

function objectValue(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
