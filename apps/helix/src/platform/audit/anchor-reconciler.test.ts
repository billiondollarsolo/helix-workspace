import type { AuditRecord } from "@helix/sdk";
import { describe, expect, it } from "vitest";
import { reconcileAuditAnchors, type AuditAnchorArchive } from "./anchor-reconciler.js";
import { computeAuditHash } from "./hash.js";
import {
  createHmacAuditAnchorAuthenticator,
  shipImmutableAuditBatch,
  type ImmutableAuditActivityRecord,
  type ImmutableAuditObject,
  type ImmutableAuditObjectStore,
} from "./immutable-s3.js";
import type { AuditVerificationStore } from "./verifier.js";

const authenticator = createHmacAuditAnchorAuthenticator("audit-key-1", "a".repeat(32));

describe("audit anchor reconciliation", () => {
  it("detects a privileged database rewrite even when the attacker regenerates a valid chain", async () => {
    const records = chain();
    const archive = await anchoredArchive(records);
    const rewritten = chain({ compromised: true });

    await expect(reconcileAuditAnchors(options(archive, records))).resolves.toEqual({
      manifestCount: 1,
      organizationCount: 1,
    });
    await expect(reconcileAuditAnchors(options(archive, rewritten))).rejects.toThrow(
      "does not match immutable anchor",
    );
  });

  it("detects deletion of an anchored database event", async () => {
    const records = chain();
    const archive = await anchoredArchive(records);

    await expect(reconcileAuditAnchors(options(archive, records.slice(0, 1)))).rejects.toThrow(
      "does not match immutable anchor",
    );
  });

  it("rejects tampering with an authenticated immutable manifest", async () => {
    const records = chain();
    const archive = await anchoredArchive(records);
    const key = [...archive.objects.keys()].find((candidate) =>
      candidate.endsWith(".manifest.json"),
    );
    if (key === undefined) throw new Error("missing test manifest");
    const manifest = JSON.parse(new TextDecoder().decode(archive.objects.get(key))) as {
      recordCount: number;
    };
    manifest.recordCount += 1;
    archive.objects.set(key, new TextEncoder().encode(JSON.stringify(manifest)));

    await expect(reconcileAuditAnchors(options(archive, records))).rejects.toThrow(
      "authentication failed",
    );
  });
});

class MemoryArchive implements ImmutableAuditObjectStore, AuditAnchorArchive {
  readonly objects = new Map<string, Uint8Array>();

  async putObject(object: ImmutableAuditObject): Promise<void> {
    this.objects.set(object.key, object.body.slice());
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.slice() ?? null;
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    for (const key of this.objects.keys()) if (key.startsWith(prefix)) yield key;
  }
}

async function anchoredArchive(
  records: readonly ImmutableAuditActivityRecord[],
): Promise<MemoryArchive> {
  const archive = new MemoryArchive();
  await shipImmutableAuditBatch(
    { store: archive, signer: authenticator, now: () => new Date("2026-09-03T12:00:00.000Z") },
    records,
  );
  return archive;
}

function options(archive: MemoryArchive, records: readonly ImmutableAuditActivityRecord[]) {
  const audit: AuditVerificationStore = { listVerificationRecords: async () => records };
  return { archive, audit, verifier: authenticator };
}

function chain(metadata: AuditRecord["metadata"] = {}): readonly ImmutableAuditActivityRecord[] {
  let previousHash: string | null = null;
  return ["event-1", "event-2"].map((id, index) => {
    const record = {
      id,
      orgId: "org-1",
      actorId: "actor-1",
      verb: "document.updated",
      objectType: "document",
      objectId: "document-1",
      metadata,
      createdAt: `2026-09-03T12:0${String(index)}:00.000Z`,
      schemaVersion: 1,
      sequence: String(index + 1),
    } satisfies Omit<ImmutableAuditActivityRecord, "thisHash">;
    const thisHash = computeAuditHash(record, previousHash).thisHash;
    const result: ImmutableAuditActivityRecord = { ...record, prevHash: previousHash, thisHash };
    previousHash = thisHash;
    return result;
  });
}
