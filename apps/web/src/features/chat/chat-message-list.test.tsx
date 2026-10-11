// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, unmountAll } from "@/test/ui";
import { ChatMessageList } from "./chat-message-list";
import type { ChatMessageActions } from "./chat-message-row";
import type { ChatMessageView } from "./view-model";

const actions: ChatMessageActions = {
  onReact: vi.fn(),
  onOpenThread: vi.fn(),
  onForward: vi.fn(),
  onCopyLink: vi.fn(),
  onTogglePin: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onRetryPending: vi.fn(),
};

function message(id: string, minute: number, actorId = "ana"): ChatMessageView {
  return {
    id,
    actorId,
    authorName: actorId,
    sentAt: new Date(2026, 2, 5, 10, minute).toISOString(),
    time: `10:${String(minute).padStart(2, "0")}`,
    body: `Message ${id}`,
    bodyFormat: "plain",
    attachmentObjectIds: [],
    attachments: [],
    isMine: false,
    editedAt: null,
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    pinned: false,
    readBy: 0,
  };
}

/** Give the log a real scroll range: 2000px of content in a 500px window. */
function layout(log: HTMLElement) {
  Object.defineProperty(log, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(log, "clientHeight", { configurable: true, value: 500 });
}

afterEach(unmountAll);

describe("ChatMessageList", () => {
  it("is a labelled log that opens at the newest message", () => {
    const { container } = mount(
      <ChatMessageList label="Messages in Launch" messages={[message("a", 0)]} actions={actions} />,
    );
    const log = container.querySelector<HTMLElement>('[role="log"]');
    expect(log?.getAttribute("aria-label")).toBe("Messages in Launch");
    // The test layout shim gives every element a 600px scroll height.
    expect(log?.scrollTop).toBe(600);
  });

  it("offers Jump to newest when a message arrives while scrolled up", () => {
    const first = [message("a", 0), message("b", 1)];
    const view = mount(<ChatMessageList label="Messages" messages={first} actions={actions} />);
    const log = view.container.querySelector<HTMLElement>('[role="log"]');
    if (log === null) throw new Error("Expected the log.");
    layout(log);

    act(() => {
      log.scrollTop = 200;
      log.dispatchEvent(new Event("scroll"));
    });
    view.rerender(
      <ChatMessageList
        label="Messages"
        messages={[...first, message("c", 30, "ben")]}
        actions={actions}
      />,
    );
    expect(log.scrollTop).toBe(200);
    const jump = view.container.querySelector<HTMLButtonElement>(".chat-jump-newest");
    expect(jump?.textContent).toBe("Jump to newest1 new");

    click(jump);
    expect(log.scrollTop).toBe(2000);
    expect(view.container.querySelector(".chat-jump-newest")).toBeNull();
  });

  it("follows new messages while the reader is at the bottom", () => {
    const view = mount(
      <ChatMessageList label="Messages" messages={[message("a", 0)]} actions={actions} />,
    );
    const log = view.container.querySelector<HTMLElement>('[role="log"]');
    if (log === null) throw new Error("Expected the log.");
    layout(log);
    view.rerender(
      <ChatMessageList
        label="Messages"
        messages={[message("a", 0), message("b", 1)]}
        actions={actions}
      />,
    );
    expect(log.scrollTop).toBe(2000);
    expect(view.container.querySelector(".chat-jump-newest")).toBeNull();
  });

  it("marks the unread position and highlights a message it jumps to", () => {
    const onFocusHandled = vi.fn();
    const view = mount(
      <ChatMessageList
        label="Messages"
        messages={[message("a", 0), message("b", 1, "ben")]}
        actions={actions}
        firstUnreadId="b"
        focusMessageId="a"
        onFocusHandled={onFocusHandled}
      />,
    );
    const separators = Array.from(view.container.querySelectorAll('[role="separator"]'));
    expect(separators.map((node) => node.getAttribute("aria-label"))).toContain("Unread messages");
    expect(
      view.container.querySelector('[data-message-id="a"]')?.getAttribute("data-highlighted"),
    ).toBe("true");
    expect(onFocusHandled).toHaveBeenCalled();
  });
});
