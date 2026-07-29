import { describe, expect, it } from "vitest";
import {
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  resolveIdempotency,
} from "./idempotency.js";
import type { ToolInvokeResult } from "../platform/tool-registry.js";
import type { Redis } from "ioredis";

const okResult: ToolInvokeResult = { ok: true, status: "executed", output: { sent: true } };

describe("idempotency", () => {
  it("namespaces storage keys by org, actor, tool, and key", () => {
    expect(
      idempotencyStorageKey({
        orgId: "org-1",
        actorId: "actor-1",
        toolId: "mail.send",
        idempotencyKey: "abc",
      }),
    ).toBe("idem:org-1:actor-1:mail.send:abc");
  });

  it("returns a miss for an unknown key", async () => {
    const store = new InMemoryIdempotencyStore();
    const outcome = await resolveIdempotency(store, "k", fingerprintRequestPayload({ a: 1 }));
    expect(outcome.kind).toBe("miss");
  });

  it("replays a stored result for a duplicate key with the same payload", async () => {
    const store = new InMemoryIdempotencyStore();
    const hash = fingerprintRequestPayload({ a: 1 });
    await store.set("k", {
      result: okResult,
      statusCode: 200,
      requestHash: hash,
      expiresAt: Date.now() + 60_000,
    });

    const outcome = await resolveIdempotency(store, "k", hash);
    expect(outcome.kind).toBe("replay");
    if (outcome.kind === "replay") {
      expect(outcome.record.result).toEqual(okResult);
    }
  });

  it("reports a conflict when the key is reused with a different payload", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.set("k", {
      result: okResult,
      statusCode: 200,
      requestHash: fingerprintRequestPayload({ a: 1 }),
      expiresAt: Date.now() + 60_000,
    });

    const outcome = await resolveIdempotency(store, "k", fingerprintRequestPayload({ a: 2 }));
    expect(outcome.kind).toBe("conflict");
  });

  it("expires records after the TTL window", async () => {
    let now = 1_000;
    const store = new InMemoryIdempotencyStore(() => now);
    const hash = fingerprintRequestPayload({});
    await store.set("k", {
      result: okResult,
      statusCode: 200,
      requestHash: hash,
      expiresAt: 2_000,
    });

    expect((await resolveIdempotency(store, "k", hash)).kind).toBe("replay");
    now = 3_000;
    expect((await resolveIdempotency(store, "k", hash)).kind).toBe("miss");
  });

  it("atomically permits only one in-memory mutation claim", async () => {
    const store = new InMemoryIdempotencyStore();
    const hash = fingerprintRequestPayload({ a: 1 });
    const [first, duplicate] = await Promise.all([
      store.claim("k", hash, 60_000),
      store.claim("k", hash, 60_000),
    ]);

    expect(first.kind).toBe("claimed");
    expect(duplicate.kind).toBe("in_progress");
    expect((await store.claim("k", fingerprintRequestPayload({ a: 2 }), 60_000)).kind).toBe(
      "conflict",
    );
  });

  it("shares an atomic Redis claim and replay across replica store instances", async () => {
    const redis = new FakeRedisIdempotencyClient();
    const replicaA = new RedisIdempotencyStore(redis as unknown as Redis);
    const replicaB = new RedisIdempotencyStore(redis as unknown as Redis);
    const hash = fingerprintRequestPayload({ a: 1 });
    const storageKey = "idem:org:actor:tool:raw-secret";
    const first = await replicaA.claim(storageKey, hash, 60_000);

    expect(first.kind).toBe("claimed");
    expect((await replicaB.claim(storageKey, hash, 60_000)).kind).toBe("in_progress");
    expect(
      (await replicaB.claim(storageKey, fingerprintRequestPayload({ a: 2 }), 60_000)).kind,
    ).toBe("conflict");
    if (first.kind !== "claimed") {
      throw new Error("Expected the first replica to own the claim.");
    }
    await replicaA.complete(storageKey, first.claimToken, {
      result: okResult,
      statusCode: 200,
      requestHash: hash,
      expiresAt: Date.now() + 60_000,
    });
    const replay = await replicaB.claim(storageKey, hash, 60_000);
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") {
      expect(replay.record.result).toEqual(okResult);
    }
    expect(redis.seenKeys.every((key) => key.includes("{") && key.includes("}"))).toBe(true);
    expect(redis.seenKeys.some((key) => key.includes("idem:org"))).toBe(false);
  });
});

class FakeRedisIdempotencyClient {
  private readonly values = new Map<string, string>();
  readonly seenKeys: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async eval(
    script: string,
    _keyCount: number,
    resultKey: string,
    hashKey: string,
    claimKey: string,
    ...args: (string | number)[]
  ): Promise<unknown> {
    this.seenKeys.push(resultKey, hashKey, claimKey);
    if (script.includes('return {"replay", result}')) {
      const [requestHash, claimToken] = args.map(String);
      const result = this.values.get(resultKey);
      const storedHash = this.values.get(hashKey);
      if (result !== undefined) {
        return storedHash === requestHash ? ["replay", result] : ["conflict"];
      }
      if (storedHash !== undefined && storedHash !== requestHash) {
        return ["conflict"];
      }
      this.values.set(hashKey, requestHash ?? "");
      if (this.values.has(claimKey)) {
        return ["in_progress"];
      }
      this.values.set(claimKey, claimToken ?? "");
      return ["claimed"];
    }
    if (script.includes('redis.call("SET", KEYS[1], ARGV[2]')) {
      const [claimToken, record] = args.map(String);
      if (this.values.get(claimKey) !== claimToken) {
        return 0;
      }
      this.values.set(resultKey, record ?? "");
      this.values.delete(claimKey);
      return 1;
    }
    const [claimToken] = args.map(String);
    if (this.values.get(claimKey) !== claimToken) {
      return 0;
    }
    this.values.delete(resultKey);
    this.values.delete(hashKey);
    this.values.delete(claimKey);
    return 1;
  }
}
