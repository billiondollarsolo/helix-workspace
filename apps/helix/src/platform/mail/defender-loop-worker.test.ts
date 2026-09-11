import { describe, expect, it, vi } from "vitest";
import { AgentDefenderLoopWorker } from "./defender-loop-worker.js";

const job = {
  id: "job-1",
  orgId: "org-1",
  agentActorId: "agent-1",
  messageId: "msg-1",
  threadId: "thread-1",
  canary: "canary-1",
  attempts: 1,
};

describe("AgentDefenderLoopWorker", () => {
  it("runs a mail-loop turn with the small Helix catalog and no web search", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ conversationId: "c1" });
    const markJob = vi.fn().mockResolvedValue(undefined);
    const worker = new AgentDefenderLoopWorker({
      defender: {
        claimDue: vi.fn().mockResolvedValue([job]),
        getPolicy: vi.fn().mockResolvedValue({
          actorId: "agent-1",
          orgId: "org-1",
          ownerActorId: "owner-1",
          receiveMode: "allowlist",
          loopEnabled: true,
          allowedSenders: ["a@b.test"],
          allowSend: false,
        }),
        markJob,
      } as never,
      mail: {
        getThread: vi.fn().mockResolvedValue({
          subject: "Hello",
          messages: [
            {
              from: { address: "a@b.test" },
              body: "Please review",
              bodyFormat: "text",
            },
          ],
        }),
      },
      orchestrator: { sendMessage } as never,
      loadActor: async () => ({
        id: "agent-1",
        orgId: "org-1",
        type: "agent",
        displayName: "Bot",
        scopes: ["mail.read", "mail.write"],
      }),
    });
    expect(await worker.run()).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        webSearch: false,
        toolGroups: ["mail"],
        toolIds: expect.arrayContaining(["mail.draft.save", "mail.thread.get"]),
      }),
    );
    expect(sendMessage.mock.calls[0]?.[0].toolIds).not.toContain("mail.send");
    expect(sendMessage.mock.calls[0]?.[0].content).toContain("<untrusted-email>");
    expect(markJob).toHaveBeenCalledWith("job-1", { status: "done" });
  });

  it("skips when the loop is disabled", async () => {
    const sendMessage = vi.fn();
    const markJob = vi.fn().mockResolvedValue(undefined);
    const worker = new AgentDefenderLoopWorker({
      defender: {
        claimDue: vi.fn().mockResolvedValue([job]),
        getPolicy: vi.fn().mockResolvedValue({ loopEnabled: false }),
        markJob,
      } as never,
      mail: { getThread: vi.fn() },
      orchestrator: { sendMessage } as never,
      loadActor: async () => null,
    });
    await worker.run();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(markJob).toHaveBeenCalledWith("job-1", { status: "skipped" });
  });
});
