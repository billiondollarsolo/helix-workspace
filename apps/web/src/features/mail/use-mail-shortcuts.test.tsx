// @vitest-environment jsdom

import { shortcutRegistry } from "@/lib/shortcuts/registry";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailThreadRow } from "./api";
import { useMailShortcuts } from "./use-mail-shortcuts";

const threads = ["t1", "t2", "t3"].map(
  (threadId, index) => ({ threadId, starred: index === 1 }) as unknown as MailThreadRow,
);

const handlers = {
  onSelectedChange: vi.fn(),
  onCompose: vi.fn(),
  onOpen: vi.fn(),
  onBack: vi.fn(),
  onAction: vi.fn(),
};

function Harness({
  openThreadId,
  selectedIds = new Set(),
  canReportSpam = true,
}: {
  readonly openThreadId: string | null;
  readonly selectedIds?: ReadonlySet<string>;
  readonly canReportSpam?: boolean;
}) {
  useMailShortcuts({ threads, openThreadId, selectedIds, canReportSpam, ...handlers });
  return (
    <div role="grid" aria-label="Conversations">
      {threads.map((thread) => (
        <div key={thread.threadId} role="row" tabIndex={-1}>
          <div role="gridcell" data-thread-id={thread.threadId}>
            {thread.threadId}
          </div>
        </div>
      ))}
    </div>
  );
}

function press(key: string, init: KeyboardEventInit = {}) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

const focusedId = () =>
  document.activeElement?.querySelector<HTMLElement>("[data-thread-id]")?.dataset.threadId;

describe("useMailShortcuts", () => {
  let container: HTMLDivElement;
  let root: Root;
  const dispatch = (event: KeyboardEvent) => {
    shortcutRegistry.handleKeyDown(event, { enabled: true, overlayOpen: false, isMac: false });
  };

  beforeEach(() => {
    window.addEventListener("keydown", dispatch);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.removeEventListener("keydown", dispatch);
    vi.clearAllMocks();
  });

  it("moves the list cursor with j/k and acts on the focused conversation", () => {
    act(() => root.render(<Harness openThreadId={null} />));

    press("j");
    expect(focusedId()).toBe("t1");
    press("j");
    press("j");
    press("j");
    expect(focusedId()).toBe("t3");
    press("k");
    expect(focusedId()).toBe("t2");

    press("o");
    expect(handlers.onOpen).toHaveBeenCalledWith("t2");
    press("x");
    expect(handlers.onSelectedChange).toHaveBeenCalledWith(new Set(["t2"]));
    press("s");
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t2"], { kind: "star", starred: false });
    press("e");
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t2"], { kind: "archive" });
    press("#", { shiftKey: true });
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t2"], { kind: "trash" });
    press("!", { shiftKey: true });
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t2"], { kind: "spam" });
    press("I", { shiftKey: true });
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t2"], { kind: "read", unread: false });
    press("U", { shiftKey: true });
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t2"], { kind: "read", unread: true });
    press("c");
    expect(handlers.onCompose).toHaveBeenCalledTimes(1);
  });

  it("prefers selected conversations, skips spam in Spam, and declines without a target", () => {
    act(() =>
      root.render(
        <Harness openThreadId={null} selectedIds={new Set(["t1", "t3"])} canReportSpam={false} />,
      ),
    );
    press("s");
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t1", "t3"], {
      kind: "star",
      starred: true,
    });
    press("!", { shiftKey: true });
    expect(handlers.onAction).toHaveBeenCalledTimes(1);

    act(() => root.render(<Harness openThreadId={null} />));
    (document.activeElement as HTMLElement | null)?.blur();
    press("e");
    expect(handlers.onAction).toHaveBeenCalledTimes(1);
  });

  it("steps between conversations and returns to the list from an open thread", () => {
    act(() => root.render(<Harness openThreadId="t2" />));

    press("j");
    expect(handlers.onOpen).toHaveBeenLastCalledWith("t3");
    press("k");
    expect(handlers.onOpen).toHaveBeenLastCalledWith("t1");
    press("e");
    expect(handlers.onAction).toHaveBeenLastCalledWith(["t2"], { kind: "archive" });
    press("u");
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    press("x");
    expect(handlers.onSelectedChange).not.toHaveBeenCalled();
  });
});
