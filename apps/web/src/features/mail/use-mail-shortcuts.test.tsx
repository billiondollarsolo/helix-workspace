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
  onCheckedChange: vi.fn(),
  onCompose: vi.fn(),
  onOpen: vi.fn(),
  onBack: vi.fn(),
  onStar: vi.fn(),
  onArchive: vi.fn(),
  onDelete: vi.fn(),
  onSpam: vi.fn(),
  onRead: vi.fn(),
};

function Harness({
  openThreadId,
  checkedIds = new Set(),
}: {
  readonly openThreadId: string | null;
  readonly checkedIds?: ReadonlySet<string>;
}) {
  useMailShortcuts({ threads, openThreadId, checkedIds, ...handlers });
  return (
    <div>
      {threads.map((thread) => (
        <div key={thread.threadId} role="button" tabIndex={0} data-thread-id={thread.threadId}>
          {thread.threadId}
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

const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.threadId;

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
    expect(handlers.onCheckedChange).toHaveBeenCalledWith(new Set(["t2"]));
    press("s");
    expect(handlers.onStar).toHaveBeenCalledWith(new Set(["t2"]), false);
    press("e");
    expect(handlers.onArchive).toHaveBeenCalledWith(new Set(["t2"]));
    press("#", { shiftKey: true });
    expect(handlers.onDelete).toHaveBeenCalledWith(new Set(["t2"]));
    press("!", { shiftKey: true });
    expect(handlers.onSpam).toHaveBeenCalledWith(new Set(["t2"]));
    press("I", { shiftKey: true });
    expect(handlers.onRead).toHaveBeenLastCalledWith(new Set(["t2"]), false);
    press("U", { shiftKey: true });
    expect(handlers.onRead).toHaveBeenLastCalledWith(new Set(["t2"]), true);
    press("c");
    expect(handlers.onCompose).toHaveBeenCalledTimes(1);
  });

  it("prefers checked conversations and declines actions with no target", () => {
    act(() => root.render(<Harness openThreadId={null} checkedIds={new Set(["t1", "t3"])} />));
    press("s");
    expect(handlers.onStar).toHaveBeenCalledWith(new Set(["t1", "t3"]), true);

    act(() => root.render(<Harness openThreadId={null} />));
    (document.activeElement as HTMLElement | null)?.blur();
    press("e");
    expect(handlers.onArchive).not.toHaveBeenCalled();
  });

  it("steps between conversations and returns to the list from an open thread", () => {
    act(() => root.render(<Harness openThreadId="t2" />));

    press("j");
    expect(handlers.onOpen).toHaveBeenLastCalledWith("t3");
    press("k");
    expect(handlers.onOpen).toHaveBeenLastCalledWith("t1");
    press("e");
    expect(handlers.onArchive).toHaveBeenCalledWith(new Set(["t2"]));
    press("u");
    expect(handlers.onBack).toHaveBeenCalledTimes(1);
    press("x");
    expect(handlers.onCheckedChange).not.toHaveBeenCalled();
  });
});
