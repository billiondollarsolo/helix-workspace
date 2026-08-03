// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizePendingApprovals,
  pendingApprovalsVisible,
  PendingApprovalsPanel,
  type PendingApprovalItem,
} from "./pending-approvals";
import { applyAssistantToolDecision, type ToolStatus } from "./tool-decisions";
import type { AssistantToolDecision, AssistantToolDecisionResult } from "./api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Mirrors setAgentOperationalControls-style API mock used by agent-controls tests. */
const { approvePendingTool, denyPendingTool } = vi.hoisted(() => {
  const approvePendingTool = vi.fn();
  const denyPendingTool = vi.fn();
  approvePendingTool.mockImplementation(() =>
    Promise.resolve({ status: "confirmed" } satisfies AssistantToolDecisionResult),
  );
  denyPendingTool.mockImplementation(() =>
    Promise.resolve({ status: "cancelled" } satisfies AssistantToolDecisionResult),
  );
  return { approvePendingTool, denyPendingTool };
});

describe("pending approvals helpers (A12)", () => {
  it("dedupes and drops empty ids", () => {
    expect(
      normalizePendingApprovals([
        { id: "p1", toolId: "mail.send" },
        { id: "p1", toolId: "mail.send" },
        { id: "", toolId: "x" },
        { id: "p2", toolId: "drive.upload" },
      ]),
    ).toEqual([
      { id: "p1", toolId: "mail.send" },
      { id: "p2", toolId: "drive.upload" },
    ]);
    expect(pendingApprovalsVisible([{ id: "p1", toolId: "mail.send", status: "confirmed" }])).toBe(
      false,
    );
    expect(pendingApprovalsVisible([{ id: "p1", toolId: "mail.send" }])).toBe(true);
  });
});

describe("PendingApprovalsPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    approvePendingTool.mockClear();
    denyPendingTool.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders confirm/deny and invokes handlers for shipped pending items", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const items: PendingApprovalItem[] = [{ id: "pending-1", toolId: "mail.send" }];

    act(() => {
      root.render(
        <PendingApprovalsPanel items={items} onConfirm={onConfirm} onCancel={onCancel} />,
      );
    });

    expect(container.querySelector('[data-testid="pending-approvals-panel"]')).not.toBeNull();
    expect(container.textContent).toContain("mail.send");

    const buttons = Array.from(container.querySelectorAll("button"));
    const deny = buttons.find((b) => b.textContent === "Deny");
    const approve = buttons.find((b) => b.textContent === "Approve");
    expect(deny).toBeDefined();
    expect(approve).toBeDefined();

    act(() => {
      deny?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledWith(items[0]);

    act(() => {
      approve?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onConfirm).toHaveBeenCalledWith(items[0]);
  });

  it("drives Approve/Deny through applyAssistantToolDecision API mocks (real path)", async () => {
    const items: PendingApprovalItem[] = [
      { id: "pending-calendar", toolId: "calendar.event.create", toolCallId: "tool-calendar" },
    ];
    const statusUpdates: Array<readonly [string, ToolStatus]> = [];
    const errorUpdates: Array<readonly [string, string | undefined]> = [];

    const decideToolCall = vi.fn(
      (input: {
        readonly conversationId: string;
        readonly pendingId: string;
        readonly decision: AssistantToolDecision;
      }) => {
        if (input.decision === "confirm") {
          return approvePendingTool(input);
        }
        return denyPendingTool(input);
      },
    );

    const runDecision = async (
      item: PendingApprovalItem,
      decision: AssistantToolDecision,
    ): Promise<void> => {
      await applyAssistantToolDecision({
        conversationId: "conv-approvals-1",
        pendingId: item.id,
        toolCallId: item.toolCallId ?? item.id,
        decision,
        decideToolCall,
        setToolError: (toolCallId, message) => {
          errorUpdates.push([toolCallId, message]);
        },
        setToolStatus: (toolCallId, status) => {
          statusUpdates.push([toolCallId, status]);
        },
      });
    };

    act(() => {
      root.render(
        <PendingApprovalsPanel
          items={items}
          onConfirm={(item) => {
            void runDecision(item, "confirm");
          }}
          onCancel={(item) => {
            void runDecision(item, "cancel");
          }}
        />,
      );
    });

    const deny = buttonByText("Deny");
    const approve = buttonByText("Approve");
    expect(deny).not.toBeNull();
    expect(approve).not.toBeNull();

    await act(async () => {
      deny?.click();
      await Promise.resolve();
    });

    expect(denyPendingTool).toHaveBeenCalledWith({
      conversationId: "conv-approvals-1",
      pendingId: "pending-calendar",
      decision: "cancel",
    });
    expect(approvePendingTool).not.toHaveBeenCalled();
    expect(decideToolCall).toHaveBeenCalledWith({
      conversationId: "conv-approvals-1",
      pendingId: "pending-calendar",
      decision: "cancel",
    });

    await act(async () => {
      approve?.click();
      await Promise.resolve();
    });

    expect(approvePendingTool).toHaveBeenCalledWith({
      conversationId: "conv-approvals-1",
      pendingId: "pending-calendar",
      decision: "confirm",
    });
    expect(statusUpdates).toEqual(
      expect.arrayContaining([
        ["tool-calendar", "running"],
        ["tool-calendar", "cancelled"],
        ["tool-calendar", "running"],
        ["tool-calendar", "confirmed"],
      ]),
    );
    expect(errorUpdates).toEqual([
      ["tool-calendar", undefined],
      ["tool-calendar", undefined],
    ]);
  });

  it("returns null when no pending items remain", () => {
    act(() => {
      root.render(
        <PendingApprovalsPanel
          items={[{ id: "done", toolId: "mail.send", status: "confirmed" }]}
          onConfirm={() => undefined}
          onCancel={() => undefined}
        />,
      );
    });
    expect(container.querySelector('[data-testid="pending-approvals-panel"]')).toBeNull();
  });

  function buttonByText(label: string): HTMLButtonElement | null {
    return (
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === label,
      ) ?? null
    );
  }
});
