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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
});
