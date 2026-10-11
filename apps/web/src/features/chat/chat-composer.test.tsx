// @vitest-environment jsdom

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, byRole, click, mount, press, settle, unmountAll } from "@/test/ui";
import { uploadChatAttachment } from "./api";
import { ChatComposer, type ChatComposerSubmission } from "./chat-composer";
import type { ChatMemberView } from "./view-model";

vi.mock("./api", () => ({
  chatAttachmentContentUrl: (objectId: string) => `/chat-media/${objectId}`,
  uploadChatAttachment: vi.fn(),
}));

vi.mock("@/features/drive/api", () => ({
  listDrive: vi.fn().mockResolvedValue({ entries: [] }),
}));

const ROOM = "33333333-3333-4333-8333-333333333333";
const members: readonly ChatMemberView[] = [
  { actorId: "me", name: "Maya Chen", email: "maya@example.com", role: "owner" },
  { actorId: "dan", name: "Daniel Cho", email: "daniel@example.com", role: "member" },
];

afterEach(() => {
  unmountAll();
  vi.clearAllMocks();
});

function render(
  onSend: (submission: ChatComposerSubmission) => void,
  extra: { onStartMeeting?: () => Promise<void>; draftKey?: string } = {},
) {
  return mount(
    <ChatComposer
      roomId={ROOM}
      draftKey={extra.draftKey ?? `${ROOM}:${String(Math.random())}`}
      label="Message Platform"
      disabled={false}
      members={members}
      selfActorId="me"
      onSend={onSend}
      onTyping={vi.fn()}
      onStartMeeting={extra.onStartMeeting}
    />,
  ).container;
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  const element = container.querySelector<HTMLTextAreaElement>("textarea");
  if (element === null) throw new Error("Expected the composer input.");
  return element;
}

function type(input: HTMLTextAreaElement, value: string) {
  act(() => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`Expected button ${label}`);
  return found;
}

describe("ChatComposer", () => {
  it("is a labelled single line that sends on Enter and not on Shift+Enter", async () => {
    const onSend = vi.fn();
    const container = render(onSend);
    const input = textarea(container);
    expect(input.rows).toBe(1);
    expect(input.getAttribute("aria-label")).toBe("Message Platform");
    expect(await axeViolations(container)).toEqual([]);

    type(input, "Looks good");
    press("Enter", { shiftKey: true }, input);
    expect(onSend).not.toHaveBeenCalled();

    press("Enter", {}, input);
    expect(onSend).toHaveBeenCalledWith({
      body: "Looks good",
      bodyFormat: "plain",
      attachmentObjectIds: [],
      attachments: [],
    });
    expect(input.value).toBe("");
  });

  it("suggests members for @ and inserts the handle the server resolves", () => {
    const onSend = vi.fn();
    const container = render(onSend);
    const input = textarea(container);
    type(input, "Thanks @da");

    const listbox = container.querySelector('[role="listbox"]');
    expect(listbox?.getAttribute("aria-label")).toBe("Mention someone");
    const options = byRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Daniel Cho@daniel"]);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    press("Enter", {}, input);
    expect(input.value).toBe("Thanks @daniel ");
    expect(onSend).not.toHaveBeenCalled();
    expect(container.querySelector('[role="listbox"]')).toBeNull();

    press("Enter", {}, input);
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Thanks @daniel", bodyFormat: "plain" }),
    );
  });

  it("formats the selection from the formatting bar and sends Markdown", () => {
    const onSend = vi.fn();
    const container = render(onSend);
    const input = textarea(container);
    type(input, "ship it");
    act(() => input.setSelectionRange(5, 7));

    click(button(container, "Show formatting"));
    expect(button(container, "Hide formatting").getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[role="toolbar"][aria-label="Formatting"]')).not.toBeNull();
    click(button(container, "Bold"));
    expect(input.value).toBe("ship **it**");

    click(button(container, "Send message"));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: "ship **it**", bodyFormat: "markdown" }),
    );
  });

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
    const input = textarea(container);
    const file = new File(["GIF89a...."], "animated.gif", { type: "image/gif" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [file] } });

    await act(async () => {
      input.dispatchEvent(event);
      await Promise.resolve();
    });
    expect(uploadChatAttachment).toHaveBeenCalledWith(ROOM, file);
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('img[src*="/chat-media/"]')).not.toBeNull();

    click(button(container, "Send message"));
    expect(onSend).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "",
        attachmentObjectIds: ["44444444-4444-4444-8444-444444444444"],
      }),
    );
  });

  it("starts a meeting and explains a failure", async () => {
    const onStartMeeting = vi.fn().mockRejectedValue(new Error("Meet is not configured."));
    const container = render(vi.fn(), { onStartMeeting });
    click(button(container, "Start a meeting"));
    await settle();
    expect(onStartMeeting).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn’t start a meeting: Meet is not configured.",
    );
  });

  it("keeps an unsent draft per conversation", () => {
    const first = render(vi.fn(), { draftKey: "room-a" });
    type(textarea(first), "half a thought");
    unmountAll();
    expect(textarea(render(vi.fn(), { draftKey: "room-a" })).value).toBe("half a thought");
    expect(textarea(render(vi.fn(), { draftKey: "room-b" })).value).toBe("");
  });
});
