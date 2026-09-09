// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer, type ChatComposerSubmission } from "./chat-composer";
import { uploadChatAttachment } from "./api";

vi.mock("./api", () => ({
  chatAttachmentContentUrl: (objectId: string) => `/chat-media/${objectId}`,
  uploadChatAttachment: vi.fn(),
}));

vi.mock("@/features/drive/api", () => ({
  listDrive: vi.fn().mockResolvedValue([]),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("ChatComposer", () => {
  it("uploads a pasted GIF and can send it without a text body", async () => {
    vi.mocked(uploadChatAttachment).mockResolvedValue({
      objectId: "44444444-4444-4444-8444-444444444444",
      source: "chat",
      filename: "animated.gif",
      mimeType: "image/gif",
      byteSize: 10,
    });
    const onSend = vi.fn();
    const container = render(onSend);
    const textarea = required(container.querySelector<HTMLTextAreaElement>("textarea"));
    const file = new File(["GIF89a...."], "animated.gif", { type: "image/gif" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file] } });

    await act(async () => {
      textarea.dispatchEvent(event);
      await Promise.resolve();
    });
    expect(uploadChatAttachment).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", file);
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('img[src*="/chat-media/"]')).not.toBeNull();

    act(() => {
      click(container, "Send");
    });
    expect(onSend).toHaveBeenCalledWith({
      body: "",
      bodyFormat: "plain",
      attachmentObjectIds: ["44444444-4444-4444-8444-444444444444"],
      attachments: [
        {
          objectId: "44444444-4444-4444-8444-444444444444",
          source: "chat",
          filename: "animated.gif",
          mimeType: "image/gif",
          byteSize: 10,
        },
      ],
    });
  });

  it("inserts triple-backtick and inline-code markup from functioning toolbar controls", () => {
    const container = render(vi.fn());
    const textarea = required(container.querySelector<HTMLTextAreaElement>("textarea"));
    act(() => {
      setInputValue(textarea, "const value = 1;");
      textarea.setSelectionRange(0, textarea.value.length);
      click(container, "Code block");
    });
    expect(textarea.value).toBe("```\nconst value = 1;\n```");

    act(() => {
      setInputValue(textarea, "value");
      textarea.setSelectionRange(0, 5);
      click(container, "Inline code");
    });
    expect(textarea.value).toBe("`value`");
  });
});

function render(onSend: (submission: ChatComposerSubmission) => void): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <ChatComposer
        roomId="33333333-3333-4333-8333-333333333333"
        placeholder="Message room"
        disabled={false}
        onSend={onSend}
        onTyping={vi.fn()}
      />,
    );
  });
  return container;
}

function click(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) =>
      candidate.textContent === label || candidate.getAttribute("aria-label") === label,
  );
  required(button).click();
}

function setInputValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test element.");
  return value;
}
