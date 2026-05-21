import { describe, expect, it } from "vitest";
import {
  InMemoryIdempotencyStore,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  resolveIdempotency,
} from "./idempotency.js";
import type { ToolInvokeResult } from "../platform/tool-registry.js";

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
    await store.set("k", { result: okResult, statusCode: 200, requestHash: hash, expiresAt: Date.now() + 60_000 });

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
    await store.set("k", { result: okResult, statusCode: 200, requestHash: hash, expiresAt: 2_000 });

    expect((await resolveIdempotency(store, "k", hash)).kind).toBe("replay");
    now = 3_000;
    expect((await resolveIdempotency(store, "k", hash)).kind).toBe("miss");
  });
});
