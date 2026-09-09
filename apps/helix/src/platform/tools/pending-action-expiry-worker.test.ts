import { describe, expect, it, vi } from "vitest";
import {
  defaultConfirmationTimeoutMs,
  InMemoryConfirmationGate,
  InMemoryPendingActionStore,
  type PendingActionRecord,
  type PendingActionStore,
} from "./registry.js";
import { PendingActionExpiryWorker } from "./pending-action-expiry-worker.js";
import type { ToolDefinition } from "@helix/sdk-types";

const actor = { id: "actor-1", orgId: "org-1", type: "agent" as const };

const testTool: ToolDefinition = {
  id: "platform.test",
  description: "Test tool",
  permission: "platform.write",
  sideEffects: "write",
  inputSchema: {
    parse: () => ({ value: true }),
    toJsonSchema: () => ({ type: "object" }),
  },
  outputSchema: {
    parse: (value) => value,
    toJsonSchema: () => ({ type: "object" }),
  },
  handler: async () => ({}),
};

describe("InMemoryPendingActionStore.expireStale", () => {
  it("fails an expired execution lease without re-claiming an unknown side effect", async () => {
    const store = new InMemoryPendingActionStore();
    const action = await store.create({
      ...pendingInput(),
      expiresAt: new Date("2026-05-21T13:00:00.000Z"),
    });
    await store.approve({
      id: action.id,
      approverActorId: "owner-1",
      approvedAt: new Date("2026-05-21T11:00:00.000Z"),
    });
    await store.claimExecution({
      id: action.id,
      approverActorId: "owner-1",
      executionActorId: "actor-1",
      startedAt: new Date("2026-05-21T11:01:00.000Z"),
      leaseExpiresAt: new Date("2026-05-21T11:02:00.000Z"),
    });

    const recovered = await store.recoverStaleExecutions({
      now: new Date("2026-05-21T11:02:01.000Z"),
    });
    const reclaimed = await store.claimExecution({
      id: action.id,
      approverActorId: "owner-1",
      executionActorId: "actor-1",
      startedAt: new Date("2026-05-21T11:02:02.000Z"),
      leaseExpiresAt: new Date("2026-05-21T11:03:02.000Z"),
    });

    expect(recovered[0]).toMatchObject({
      status: "failed",
      error: "execution_outcome_unknown",
      executionAttempts: 1,
    });
    expect(reclaimed).toBeNull();
  });

  it("transitions only past-due pending actions to expired", async () => {
    const store = new InMemoryPendingActionStore();
    const now = new Date("2026-05-21T12:00:00.000Z");
    const stale = await store.create({
      ...pendingInput(),
      expiresAt: new Date("2026-05-21T11:00:00.000Z"),
    });
    const fresh = await store.create({
      ...pendingInput(),
      expiresAt: new Date("2026-05-21T13:00:00.000Z"),
    });

    const expired = await store.expireStale({ now });

    expect(expired.map((record) => record.id)).toEqual([stale.id]);
    expect((await store.get(stale.id))?.status).toBe("expired");
    expect((await store.get(stale.id))?.decidedAt).toEqual(now);
    expect((await store.get(fresh.id))?.status).toBe("pending_confirmation");
  });

  it("expires an approved action that was not claimed before its deadline", async () => {
    const store = new InMemoryPendingActionStore();
    const record = await store.create({
      ...pendingInput(),
      expiresAt: new Date("2026-05-21T11:00:00.000Z"),
    });
    await store.approve({
      id: record.id,
      approverActorId: "actor-2",
      approvedAt: new Date("2026-05-21T11:30:00.000Z"),
    });

    const expired = await store.expireStale({ now: new Date("2026-05-21T12:00:00.000Z") });

    expect(expired).toHaveLength(1);
    expect((await store.get(record.id))?.status).toBe("expired");
  });

  it("honours the batch limit", async () => {
    const store = new InMemoryPendingActionStore();
    for (let index = 0; index < 5; index += 1) {
      await store.create({
        ...pendingInput(),
        expiresAt: new Date("2026-05-21T11:00:00.000Z"),
      });
    }

    const expired = await store.expireStale({
      now: new Date("2026-05-21T12:00:00.000Z"),
      limit: 2,
    });

    expect(expired).toHaveLength(2);
  });
});

describe("PendingActionExpiryWorker", () => {
  it("expires stale actions on a single run", async () => {
    const store = new InMemoryPendingActionStore();
    const stale = await store.create({
      ...pendingInput(),
      expiresAt: new Date("2026-05-21T11:00:00.000Z"),
    });
    const worker = new PendingActionExpiryWorker({
      store,
      now: () => new Date("2026-05-21T12:00:00.000Z"),
    });

    const result = await worker.runOnce();

    expect(result.expiredCount).toBe(1);
    expect(result.expired[0]?.id).toBe(stale.id);
    expect((await store.get(stale.id))?.status).toBe("expired");
  });

  it("reports errors via onError without throwing", async () => {
    const failingStore: PendingActionStore = {
      create: vi.fn(),
      get: vi.fn(),
      approve: vi.fn(),
      cancel: vi.fn(),
      claimExecution: vi.fn(),
      completeExecution: vi.fn(),
      recoverStaleExecutions: vi.fn().mockResolvedValue([]),
      expireStale: vi
        .fn<PendingActionStore["expireStale"]>()
        .mockRejectedValue(new Error("db down")),
    };
    const errors: unknown[] = [];
    const worker = new PendingActionExpiryWorker({
      store: failingStore,
      intervalMs: 60_000,
      onError: (error) => errors.push(error),
    });

    worker.start();
    await worker.stop();

    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});

function pendingInput() {
  const id = crypto.randomUUID();
  return {
    id,
    orgId: "org-1",
    actorId: "actor-1",
    requesterActorId: "actor-1",
    requesterCredentialId: null,
    requesterPrincipal: actor,
    requesterIp: null,
    approvalOwnerActorId: null,
    toolId: "platform.test",
    input: {},
    inputHash: "0".repeat(64),
    policySnapshot: {},
    policyVersion: "actor-session",
    preview: {
      toolId: "platform.test",
      action: "platform.write",
      resourceIds: [],
      recipients: [],
      targets: [],
      consequence: "Test.",
    },
    createdAt: new Date("2026-05-21T10:00:00.000Z"),
    executionIdempotencyKey: `pending-action:${id}`,
    traceId: null,
  } as const;
}

describe("InMemoryConfirmationGate confirmation timeout", () => {
  it("defaults the confirmation window to 10 minutes (PRD §9.9)", async () => {
    expect(defaultConfirmationTimeoutMs).toBe(10 * 60 * 1000);
    const store = new InMemoryPendingActionStore();
    const gate = new InMemoryConfirmationGate(store);
    const before = Date.now();
    const pending = await gate.queue({ tool: testTool, actor, input: {} });
    const elapsed = Date.parse(pending.expiresAt) - Date.parse(pending.createdAt);
    expect(elapsed).toBe(defaultConfirmationTimeoutMs);
    expect(Date.parse(pending.createdAt)).toBeGreaterThanOrEqual(before);
  });

  it("honours a per-tier confirmation timeout override", async () => {
    const store = new InMemoryPendingActionStore();
    const gate = new InMemoryConfirmationGate(store, { confirmationTimeoutMs: 3 * 60 * 1000 });
    const pending = await gate.queue({ tool: testTool, actor, input: {} });
    expect(Date.parse(pending.expiresAt) - Date.parse(pending.createdAt)).toBe(3 * 60 * 1000);
  });

  it("invokes onPendingActionCreated with the created record", async () => {
    const created: PendingActionRecord[] = [];
    const gate = new InMemoryConfirmationGate(new InMemoryPendingActionStore(), {
      onPendingActionCreated: async (record) => {
        created.push(record);
      },
    });

    const pending = await gate.queue({ tool: testTool, actor, input: { value: true } });

    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe(pending.id);
    expect(created[0]?.actorId).toBe("actor-1");
  });
});
