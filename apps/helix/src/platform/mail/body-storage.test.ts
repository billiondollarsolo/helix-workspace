import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { contractStorage } from "../../test-support/s3-storage.js";
import { readMailBody, readStoredBody, stageMailBody } from "./body-storage.js";
import { mailBodyMatches } from "./body-search.js";
import type { SearchEngine } from "../search/types.js";
import { compactMailMutation, SearchMutationWorker } from "../search/durable.js";

const orgId = randomUUID();
const actorId = randomUUID();
const messageId = randomUUID();

describe("external mail bodies", () => {
  it("round trips large UTF-8 text and HTML, verifies bytes, and rejects corruption", async () => {
    const { storage } = await contractStorage();
    const { sql } = createRecordingSql();
    const content = {
      text: "A long résumé 📨\n".repeat(100_000),
      html: "<p>Hello &amp; goodbye</p>",
    };
    const resolver = () => ({
      client: storage,
      managedBy: "helix-default" as const,
      prefix: orgId,
    });
    const staged = await stageMailBody(sql, resolver, orgId, content);
    expect(staged).toBeDefined();
    if (staged === undefined) throw new Error("Missing stage");
    try {
      expect(staged.byteSize).toBeLessThan(staged.logicalSize / 10);
      expect(await readStoredBody(storage, staged)).toEqual({ version: 1, ...content });
      await expect(readStoredBody(storage, { ...staged, logicalSize: 2 })).rejects.toThrow();
      await expect(
        readStoredBody(storage, { ...staged, byteSize: staged.byteSize - 1 }),
      ).rejects.toThrow();
      await storage.put({ key: staged.storageKey, body: Buffer.alloc(staged.byteSize) });
      await expect(readStoredBody(storage, staged)).rejects.toThrow();
      await storage.delete(staged.storageKey);
      await expect(readStoredBody(storage, staged)).rejects.toThrow();
    } finally {
      await storage.delete(staged.storageKey);
    }
  });

  it("rejects unsupported payloads even with a matching hash", async () => {
    const { storage } = await contractStorage();
    const raw = Buffer.from(JSON.stringify({ version: 2, text: "body" }));
    const bytes = gzipSync(raw);
    const storageKey = `mail/bodies/${randomUUID()}.json.gz`;
    await storage.put({ key: storageKey, body: bytes });
    try {
      await expect(
        readStoredBody(storage, {
          storageKey,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteSize: bytes.length,
          logicalSize: raw.length,
        }),
      ).rejects.toThrow();
    } finally {
      await storage.delete(storageKey);
    }
  });

  it("does not contact storage when RLS hides the reference", async () => {
    const resolver = vi.fn();
    await expect(
      readMailBody(createRecordingSql().sql, resolver, orgId, messageId),
    ).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("requires search for external bodies and confines candidate IDs to the mailbox", async () => {
    await expect(mailBodyMatches(undefined, { orgId, actorId }, ["needle"], true)).rejects.toThrow(
      "search service",
    );
    const search = vi.fn().mockResolvedValue({
      hits: [
        { id: `mail:${actorId}:${messageId}` },
        { id: `mail:${randomUUID()}:${randomUUID()}` },
      ],
      estimatedTotalHits: 2,
    });
    const result = await mailBodyMatches(
      { search } as unknown as SearchEngine,
      { orgId, actorId },
      ["needle"],
      true,
    );
    expect(result.get("needle")).toEqual([messageId]);
    expect(search.mock.calls[0]?.[0].attributesToRetrieve).toEqual(["id", "type"]);
    expect(search.mock.calls[0]?.[0].filter).toEqual([
      `attributes.orgId = "${orgId}"`,
      `attributes.ragOwnerActorId = "${actorId}"`,
    ]);
    search.mockResolvedValue({ hits: [], estimatedTotalHits: 10001 });
    await expect(
      mailBodyMatches({ search } as unknown as SearchEngine, { orgId, actorId }, ["broad"], true),
    ).rejects.toThrow("too many");
  });

  it("queues references and reloads current authorized content for live indexing", async () => {
    const document = {
      id: `mail:${actorId}:${messageId}`,
      type: "mail" as const,
      body: "never in PG queue",
      attributes: { orgId, ragOwnerActorId: actorId, messageId },
    };
    const mutation = compactMailMutation({ upsert: [document] });
    expect(JSON.stringify(mutation)).not.toContain(document.body);
    expect(mutation.reloadMail).toEqual([{ orgId, actorId, messageId }]);
    const upsert = vi.fn();
    const completeMutation = vi.fn();
    const failMutation = vi.fn();
    const loadMail = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary body storage outage"))
      .mockResolvedValue(document);
    const worker = new SearchMutationWorker({
      store: {
        claimMutations: async () => [
          { id: 1n, orgId, mutation, leaseToken: "lease", attemptCount: 1 },
        ],
        activeShadowIndexUids: async () => [],
        completeMutation,
        failMutation,
        withTenant: async (_orgId: string, callback: () => Promise<unknown>) => callback(),
        withMutationSwapLock: async (callback: () => Promise<unknown>) => callback(),
      } as never,
      engine: { upsert } as unknown as SearchEngine,
      shadowEngine: () => {
        throw new Error("unexpected shadow");
      },
      loadMail,
    });
    await worker.drainOnce();
    expect(failMutation).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Temporary body storage outage", retryDelaySeconds: 2 }),
    );
    expect(completeMutation).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    await worker.drainOnce();
    expect(upsert).toHaveBeenCalledWith([document]);
    expect(completeMutation).toHaveBeenCalledOnce();
  });
});
