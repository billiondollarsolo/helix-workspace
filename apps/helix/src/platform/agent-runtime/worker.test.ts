import { describe, it, expect, vi } from "vitest";
import { agentRuntimeConfigSchema, type AgentRuntime, type LiveEvent } from "@helix/contracts";
import type { Actor } from "@helix/sdk-types";
import { HostedAgentWorker, type HostedAgentDependencies } from "./worker.js";
import type { AssistantSendMessageInput } from "../assistant/types.js";
const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  type: "agent",
  scopes: ["notifications.read", "assistant.write", "chat.read", "chat.post"],
};
const credentialId = "00000000-0000-4000-8000-000000000003";
const event: LiveEvent = {
  id: "event-1",
  cursor: 1,
  type: "chat.direct",
  resourceId: "00000000-0000-4000-8000-000000000004",
  parentId: "00000000-0000-4000-8000-000000000005",
  createdAt: "2026-10-15T00:00:00Z",
};
function fixture() {
  const runtime: AgentRuntime = {
    actorId: actor.id,
    config: agentRuntimeConfigSchema.parse({
      mode: "helix",
      enabled: true,
      credentialId,
      modelId: "test",
    }),
    cursor: 0,
    version: 1,
    state: "listening",
    lastError: null,
    lastRunAt: null,
    conversationId: null,
    interrupted: false,
  };
  const store = {
    sql: { listen: vi.fn(async () => ({ unlisten: async () => {} })) },
    candidates: vi.fn(async () => [{ org_id: actor.orgId, actor_id: actor.id }]),
    get: vi.fn(async () => runtime),
    scoped: vi.fn(async (_actor: unknown, run: () => Promise<unknown>) => run()),
    humanChat: vi.fn(async () => true),
    begin: vi.fn(async () => true),
    advance: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  };
  const principal = { actor, credentialId, credentialPolicy: undefined };
  const resolve = vi.fn(async () => principal as typeof principal | null);
  const live = {
    heartbeat: vi.fn(),
    list: vi.fn(async () => ({
      events: [event],
      cursor: 1,
      latestCursor: 1,
      hasMore: false,
      resetRequired: false,
    })),
  };
  const sendMessage = vi.fn(async (input: AssistantSendMessageInput) => {
    await input.beforeStep?.();
    return {
      response: { content: "Hello" },
      conversation: { id: "conversation" },
      pendingConfirmations: [],
      toolCalls: [],
      sources: [],
      effectiveClassification: "standard",
    };
  });
  const invoke = vi.fn(async () => ({ ok: true, status: "executed", output: {} }));
  const worker = new HostedAgentWorker({
    store,
    live,
    assistant: { sendMessage },
    tools: { invoke },
    resolve,
    allowed: () => true,
    onError: vi.fn(),
  } as unknown as HostedAgentDependencies);
  const run = async () => {
    try {
      await worker.start();
      await worker.run();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await worker.stop();
    }
  };
  return { runtime, store, resolve, live, sendMessage, invoke, run, worker };
}
describe("Hosted agent event execution", () => {
  it("allows another agent to work while a model is waiting", async () => {
    const f = fixture();
    const peer = { ...actor, id: "00000000-0000-4000-8000-000000000099" };
    f.store.candidates.mockResolvedValue(
      [actor, peer].map((a) => ({ actor_id: a.id, org_id: a.orgId })),
    );
    f.resolve.mockImplementation(async (_orgId?: string, actorId?: string) => ({
      actor: actorId === peer.id ? peer : actor,
      credentialId,
      credentialPolicy: undefined,
    }));
    const original = f.sendMessage.getMockImplementation();
    if (!original) throw new Error("Missing test model implementation");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.sendMessage.mockImplementation(async (input) => {
      await gate;
      return original(input);
    });
    try {
      await f.worker.start();
      await f.worker.run();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
      await f.worker.run();
      expect(f.sendMessage).toHaveBeenCalledTimes(2);
      expect(f.store.fail).not.toHaveBeenCalled();
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(f.store.complete).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await f.worker.stop();
    }
  });
  it("uses the existing scoped principal and sends its reply through approval policy", async () => {
    const f = fixture();
    await f.run();
    expect(f.sendMessage).toHaveBeenCalledOnce();
    expect(f.sendMessage.mock.calls[0]?.[0]).toMatchObject({
      actor,
      principal: { credentialId },
      modelId: "test",
      maxToolRounds: 8,
      memoryOptIn: false,
      webSearch: false,
    });
    expect(f.invoke).toHaveBeenCalledWith(
      "chat.send",
      { roomId: event.parentId, body: "Hello", clientMessageId: "hosted:event-1:reply" },
      expect.objectContaining({ credentialId, enforceConfirmation: true }),
    );
    expect(f.store.complete).toHaveBeenCalledWith(actor, event, "conversation", false);
  });
  it.each(["external", "idle", "agent-origin", "budget", "interrupted", "revoked"] as const)(
    "does not call a model for %s",
    async (reason) => {
      const f = fixture();
      if (reason === "external") f.runtime.config.mode = "external";
      if (reason === "idle")
        f.live.list.mockResolvedValue({
          events: [],
          cursor: 0,
          latestCursor: 0,
          hasMore: false,
          resetRequired: false,
        });
      if (reason === "agent-origin") f.store.humanChat.mockResolvedValue(false);
      if (reason === "budget") f.store.begin.mockResolvedValue(false);
      if (reason === "interrupted") f.runtime.interrupted = true;
      if (reason === "revoked") f.resolve.mockResolvedValue(null);
      await f.run();
      expect(f.sendMessage).not.toHaveBeenCalled();
    },
  );
  it("stops before the next step when a credential is revoked", async () => {
    const f = fixture();
    f.sendMessage.mockImplementation(async (input) => {
      f.resolve.mockResolvedValue(null);
      await input.beforeStep?.();
      throw new Error("Should not reach model");
    });
    await f.run();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalled();
  });
  it("keeps pending replies pending and reports waiting presence", async () => {
    const f = fixture();
    f.invoke.mockResolvedValue({ ok: true, status: "pending_confirmation", output: {} });
    await f.run();
    expect(f.store.complete).toHaveBeenCalledWith(actor, event, "conversation", true);
    expect(f.live.heartbeat).toHaveBeenCalledWith(actor, actor.id, "waiting_approval");
  });
  it("pauses on model failure without advancing the event", async () => {
    const f = fixture();
    f.sendMessage.mockRejectedValue(new Error("Provider unavailable"));
    await f.run();
    expect(f.store.complete).not.toHaveBeenCalled();
    expect(f.store.advance).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalled();
  });
});
