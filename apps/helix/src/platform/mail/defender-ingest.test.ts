import { describe, expect, it, vi } from "vitest";
import { applyAgentDefenderAfterIngest } from "./defender-ingest.js";
import type { AgentDefenderPolicy } from "./defender-policy.js";

const auth = { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" };
const policy: AgentDefenderPolicy = {
  actorId: "agent-1",
  orgId: "org-1",
  ownerActorId: "owner-1",
  receiveMode: "allowlist",
  loopEnabled: true,
  allowedSenders: ["alice@helix.local"],
  allowSend: false,
};

describe("applyAgentDefenderAfterIngest", () => {
  it("holds allowlist misses and does not enqueue a loop job", async () => {
    const updateThreadState = vi.fn().mockResolvedValue(undefined);
    const enqueueLoopJob = vi.fn();
    await applyAgentDefenderAfterIngest({
      mail: { updateThreadState },
      defender: {
        store: {
          getPolicy: vi.fn().mockResolvedValue(policy),
          enqueueLoopJob,
        } as never,
        lookupActorTypes: async () => new Map([["agent-1", "agent"]]),
      },
      orgId: "org-1",
      recipients: [{ orgId: "org-1", actorId: "agent-1", address: "bot@helix.local" }],
      fromAddress: "stranger@x.test",
      subject: "Hi",
      bodyText: "Hello",
      auth,
      alreadySpam: false,
      threadId: "thread-1",
      messageId: "msg-1",
      now: new Date("2026-09-11T00:00:00.000Z"),
    });
    expect(updateThreadState).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "agent-1", patch: { heldAt: expect.any(Date) } }),
    );
    expect(enqueueLoopJob).not.toHaveBeenCalled();
  });

  it("enqueues a loop job for allowlisted deliver", async () => {
    const updateThreadState = vi.fn();
    const enqueueLoopJob = vi.fn().mockResolvedValue(undefined);
    await applyAgentDefenderAfterIngest({
      mail: { updateThreadState },
      defender: {
        store: {
          getPolicy: vi.fn().mockResolvedValue(policy),
          enqueueLoopJob,
        } as never,
        lookupActorTypes: async () => new Map([["agent-1", "agent"]]),
      },
      orgId: "org-1",
      recipients: [{ orgId: "org-1", actorId: "agent-1", address: "bot@helix.local" }],
      fromAddress: "alice@helix.local",
      subject: "Hi",
      bodyText: "Hello",
      auth,
      alreadySpam: false,
      threadId: "thread-1",
      messageId: "msg-1",
      now: new Date("2026-09-11T00:00:00.000Z"),
    });
    expect(updateThreadState).not.toHaveBeenCalled();
    expect(enqueueLoopJob).toHaveBeenCalledWith({
      orgId: "org-1",
      agentActorId: "agent-1",
      messageId: "msg-1",
      threadId: "thread-1",
    });
  });
});
