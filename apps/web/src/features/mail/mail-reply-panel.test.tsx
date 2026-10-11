// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailThreadDetail, MailThreadRow } from "./api";
import { forwardSubject } from "./mail-reply-panel";
import { ThreadView } from "./mail-thread-view";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const api = vi.hoisted(() => ({
  replyToMail: vi.fn(() => Promise.resolve({ status: "queued" })),
  forwardMail: vi.fn(() => Promise.resolve({ status: "queued" })),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  replyToMail: api.replyToMail,
  forwardMail: api.forwardMail,
}));

vi.mock("./mail-sender-select", () => ({
  useMailSender: () => ({
    from: "me@helix.test",
    setFrom: () => undefined,
    available: [{ address: "me@helix.test", sendAsEnabled: true }],
    addresses: { isPending: false, isError: false },
    authorized: true,
  }),
  MailSenderSelect: () => null,
}));

const row = {
  threadId: "thread-1",
  messageId: "message-2",
  subject: "Plans",
  from: "Friend",
  fromEmail: "friend@example.com",
  preview: "",
  time: "2026-10-02T10:00:00.000Z",
  unread: false,
  starred: false,
  hasAttachment: true,
  messageCount: 2,
  labels: [],
  category: "primary",
  folder: "inbox",
  snoozedUntil: null,
} as unknown as MailThreadRow;

const detail: MailThreadDetail = {
  id: "thread-1",
  subject: "Plans",
  preview: "",
  participants: [],
  labels: [],
  archivedAt: null,
  deletedAt: null,
  snoozedUntil: null,
  lastActivity: "2026-10-02T10:00:00.000Z",
  unread: false,
  starred: false,
  direction: "inbound",
  messages: [
    {
      id: "message-1",
      from: { address: "me@helix.test", name: "Me" },
      to: [{ address: "friend@example.com" }],
      cc: [],
      bcc: [],
      sentAt: "2026-10-01T10:00:00.000Z",
      body: "Shall we plan?",
      bodyFormat: "plain",
      hasAttachment: false,
      attachments: [],
    },
    {
      id: "message-2",
      subject: "Re: Plans",
      from: { address: "friend@example.com", name: "Friend" },
      to: [{ address: "me@helix.test" }],
      cc: [{ address: "carol@example.com" }],
      bcc: [],
      sentAt: "2026-10-02T10:00:00.000Z",
      body: "Quarterly plans attached.",
      bodyFormat: "plain",
      hasAttachment: true,
      attachments: [],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  api.replyToMail.mockClear();
  api.forwardMail.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ThreadView
          row={row}
          detail={detail}
          isLoading={false}
          isError={false}
          labelColors={new Map()}
          onClose={() => undefined}
          onArchive={() => undefined}
          onDelete={() => undefined}
          onSnooze={() => undefined}
          restoreLabel={null}
          onRestore={() => undefined}
          onToggleLabel={() => undefined}
          actionBusy={false}
          actionError={null}
        />
      </QueryClientProvider>,
    );
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function click(text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim().endsWith(text) === true,
  );
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const element = container.querySelector(`[aria-label="${label}"]`);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
    throw new Error(`Field not found: ${label}`);
  return element;
}

function type(label: string, value: string) {
  const input = field(label);
  const proto =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("thread reply actions (ML4e)", () => {
  it("Reply lets the server choose the sender's Reply-To/From and threading headers", async () => {
    click("Reply");
    type("Reply body", "Sounds good");
    click("Send");
    await flush();
    expect(api.replyToMail).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", replyAll: false, bodyText: "Sounds good" }),
    );
    const [input] = api.replyToMail.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input).not.toHaveProperty("to");
  });

  it("Reply all asks the server for every original recipient", async () => {
    click("Reply all");
    expect(container.textContent).toContain("Replying all");
    type("Reply body", "Thanks all");
    click("Send");
    await flush();
    expect(api.replyToMail).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1", replyAll: true, bodyText: "Thanks all" }),
    );
  });

  it("Forward opens a composer with Fwd: and the quoted original, then calls mail.forward", async () => {
    click("Forward");
    expect(field("Forward subject").value).toBe("Fwd: Plans");
    const quote = container.querySelector('[aria-label="Forwarded message"]')?.textContent ?? "";
    expect(quote).toContain("---------- Forwarded message ---------");
    expect(quote).toContain("From: Friend <friend@example.com>");
    expect(quote).toContain("Quarterly plans attached.");
    expect(quote).toContain("Attachments are forwarded with the message.");
    type("Forward recipients", "boss@example.com");
    click("Send");
    await flush();
    expect(api.forwardMail).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        messageId: "message-2",
        to: [{ address: "boss@example.com" }],
        subject: "Fwd: Plans",
      }),
    );
    expect(api.replyToMail).not.toHaveBeenCalled();
  });

  it("never doubles the forward prefix", () => {
    expect(forwardSubject("Fwd: Plans")).toBe("Fwd: Plans");
    expect(forwardSubject("FW: Plans")).toBe("FW: Plans");
    expect(forwardSubject("Re: Plans")).toBe("Fwd: Re: Plans");
  });
});
