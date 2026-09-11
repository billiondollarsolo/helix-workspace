import { describe, expect, it, vi } from "vitest";
import { applyAssistantToolDecision, type ToolStatus } from "./tool-decisions";

describe("assistant tool decision state", () => {
  it("invokes the backend confirmation client and updates UI state on success", async () => {
    const statusUpdates: Array<readonly [string, ToolStatus]> = [];
    const errorUpdates: Array<readonly [string, string | undefined]> = [];
    const decideToolCall = vi.fn(() => Promise.resolve({ status: "confirmed" as const }));

    await expect(
      applyAssistantToolDecision({
        conversationId: "planning",
        pendingId: "pending-calendar",
        toolCallId: "tool-calendar",
        decision: "confirm",
        decideToolCall,
        setToolError: (toolCallId, message) => errorUpdates.push([toolCallId, message]),
        setToolStatus: (toolCallId, status) => statusUpdates.push([toolCallId, status]),
      }),
    ).resolves.toEqual({ status: "confirmed" });

    expect(decideToolCall).toHaveBeenCalledWith({
      conversationId: "planning",
      pendingId: "pending-calendar",
      decision: "confirm",
    });
    expect(errorUpdates).toEqual([["tool-calendar", undefined]]);
    expect(statusUpdates).toEqual([
      ["tool-calendar", "running"],
      ["tool-calendar", "confirmed"],
    ]);
  });
  it("retains a failed execution as terminal and exposes its error", async () => {
    const setToolStatus = vi.fn();
    const setToolError = vi.fn();
    await applyAssistantToolDecision({
      conversationId: "planning",
      toolCallId: "call",
      decision: "confirm",
      decideToolCall: () => Promise.resolve({ status: "failed", error: "Access revoked" }),
      setToolStatus,
      setToolError,
    });
    expect(setToolStatus).toHaveBeenLastCalledWith("call", "failed");
    expect(setToolError).toHaveBeenLastCalledWith("call", "Access revoked");
  });
});
