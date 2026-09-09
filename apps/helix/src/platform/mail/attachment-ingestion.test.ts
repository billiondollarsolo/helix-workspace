import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { StorageObject, StorageObjectHead } from "@helix/sdk-types";
import { PostgresMailAttachmentIngestor } from "./attachment-ingestion.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

describe("PostgresMailAttachmentIngestor", () => {
  it("uses immutable distinct keys for equal filenames and exposes only clean object references", async () => {
    const sql = recordingSql();
    const storage = new MemoryStorage();
    const ingestor = new PostgresMailAttachmentIngestor(sql.sql, {
      storageResolver: () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
      scanner: cleanScanner,
    });

    const first = await ingestor.stage({
      orgId,
      ownerActorId: actorId,
      attachment: { filename: "same.txt", mimeType: "text/plain", content: Buffer.from("one") },
    });
    const second = await ingestor.stage({
      orgId,
      ownerActorId: actorId,
      attachment: { filename: "same.txt", mimeType: "text/plain", content: Buffer.from("two") },
    });

    expect(first.storageKey).not.toBe(second.storageKey);
    expect(storage.bytes(first.storageKey)).toEqual(Buffer.from("one"));
    expect(storage.bytes(second.storageKey)).toEqual(Buffer.from("two"));
    expect(first.attachment).toMatchObject({ filename: "same.txt", objectId: first.objectId });
    expect(first.attachment.content).toBeUndefined();
    expect(sql.queries.filter((query) => query.includes("status = 'clean'"))).toHaveLength(2);
  });

  it("fails closed and cleans uploaded bytes when scanning is unavailable", async () => {
    const sql = recordingSql();
    const storage = new MemoryStorage();
    const ingestor = new PostgresMailAttachmentIngestor(sql.sql, {
      storageResolver: () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    await expect(
      ingestor.stage({
        orgId,
        attachment: {
          filename: "unscanned.bin",
          mimeType: "application/octet-stream",
          content: Buffer.from("unsafe until proven clean"),
        },
      }),
    ).rejects.toThrow("scanning is unavailable");

    expect(storage.keys()).toEqual([]);
    expect(sql.queries.some((query) => query.includes("status = 'rejected'"))).toBe(true);
    expect(sql.queries.some((query) => query.includes("deleted_at = coalesce"))).toBe(true);
  });

  it("durably retries an orphan delete and then tombstones its metadata", async () => {
    const claim = {
      id: "33333333-3333-4333-8333-333333333333",
      org_id: orgId,
      owner_actor_id: actorId,
      object_id: "44444444-4444-4444-8444-444444444444",
      storage_key: "mail/attachments/orphan/hash",
    };
    const sql = recordingSql(claim);
    const storage = new MemoryStorage(1);
    await storage.put({ key: claim.storage_key, body: Buffer.from("old") });
    const ingestor = new PostgresMailAttachmentIngestor(sql.sql, {
      storageResolver: () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
      scanner: cleanScanner,
    });

    await expect(ingestor.cleanupAbandoned()).resolves.toBe(0);
    expect(sql.queries.some((query) => query.includes("last_cleanup_error ="))).toBe(true);
    await expect(ingestor.cleanupAbandoned()).resolves.toBe(1);
    expect(storage.keys()).toEqual([]);
    expect(sql.queries.some((query) => query.includes("cleaned_at = now()"))).toBe(true);
  });
});

const cleanScanner = {
  async scan() {
    return {
      infected: false,
      signature: null,
      scanned: true,
      evidence: { scanned: true, engine: "test" },
    } as const;
  },
};

function recordingSql(claim?: Record<string, unknown>): {
  readonly sql: postgres.Sql;
  readonly queries: readonly string[];
} {
  const queries: string[] = [];
  const tag = (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    queries.push(query);
    return Promise.resolve(
      query.includes("helix_claim_mail_attachment_cleanup")
        ? claim === undefined
          ? []
          : [claim]
        : query.includes("returning id")
          ? [{ id: "stage" }]
          : [],
    );
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
      callback(sql as unknown as postgres.TransactionSql),
  });
  return { sql: sql as unknown as postgres.Sql, queries };
}

class MemoryStorage implements TenantStorageClient {
  readonly #objects = new Map<string, StorageObject>();
  #deleteFailures: number;

  constructor(deleteFailures = 0) {
    this.#deleteFailures = deleteFailures;
  }

  async put(object: StorageObject): Promise<void> {
    this.#objects.set(object.key, { ...object, body: Buffer.from(object.body as Uint8Array) });
  }

  async get(key: string): Promise<StorageObject | null> {
    return this.#objects.get(key) ?? null;
  }

  async head(key: string): Promise<StorageObjectHead | null> {
    const object = this.#objects.get(key);
    if (object === undefined) return null;
    return {
      key,
      byteSize: (object.body as Uint8Array).byteLength,
      ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
    };
  }

  async delete(key: string): Promise<void> {
    if (this.#deleteFailures > 0) {
      this.#deleteFailures -= 1;
      throw new Error("injected object delete failure");
    }
    this.#objects.delete(key);
  }

  bytes(key: string): Buffer | undefined {
    const body = this.#objects.get(key)?.body;
    return body === undefined ? undefined : Buffer.from(body as Uint8Array);
  }

  keys(): readonly string[] {
    return [...this.#objects.keys()];
  }
}
