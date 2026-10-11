// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyOptions } from "@/components/ui/toast";
import { axeViolations, key, unmountAll } from "@/test/ui";
import type { MailThreadDetail, MailThreadRow } from "./api";
import {
  buttonByText,
  byLabel,
  click,
  openMenu,
  renderWithClient,
  settle,
  typeBody,
  waitFor,
  addRecipient,
} from "@/test/mail-compose";
import { ThreadView } from "./mail-thread-view";

const api = vi.hoisted(() => ({
  replyToMail: vi.fn(),
  forwardMail: vi.fn(),
  saveMailDraft: vi.fn(),
  discardMailDraft: vi.fn(),
  cancelOutboundMail: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ notify: vi.fn<(options: NotifyOptions) => string>() }));

vi.mock("./api", async (original) => ({ ...(await original<object>()), ...api }));
vi.mock("@/components/ui/toast", () => ({ notify: toasts.notify }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useSearch: () => ({}) }));
vi.mock("@/features/people/api", () => ({
  usePeopleSearch: () => ({ people: [], loading: false, error: false }),
}));

const row = {
  threadId: "thread-1",
  messageId: "message-2",
  subject: "Plans",
  from: "Samara",
  fromEmail: "samara@example.com",
  preview: "",
  time: "2026-10-02T10:00:00.000Z",
  unread: false,
  starred: false,
  hasAttachment: true,
  messageCount: 3,
  labels: [],
  category: "primary",
  folder: "inbox",
  snoozedUntil: null,
  participants: [],
} as MailThreadRow;

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
  direction: "mixed",
  messages: [
    {
      id: "message-1",
      from: { address: "me@helix.test", name: "Me" },
      to: [{ address: "samara@example.com", name: "Samara" }],
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
      from: { address: "samara@example.com", name: "Samara" },
      to: [{ address: "me@helix.test", name: "Me" }],
      cc: [{ address: "carol@example.com", name: "Carol" }],
      bcc: [],
      sentAt: "2026-10-02T10:00:00.000Z",
      body: "Quarterly plans attached.",
      bodyFormat: "plain",
      hasAttachment: true,
      attachments: [
        {
          objectId: "44444444-4444-4444-8444-444444444444",
          filename: "plan.pdf",
          mimeType: "application/pdf",
          byteSize: 2048,
          disposition: "attachment",
          inline: false,
          downloadUrl: "/v1/api/mail/attachments/x",
        },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  const result = {
    id: "55555555-5555-4555-8555-555555555555",
    threadId: "thread-1",
    undoUntil: new Date(Date.now() + 30_000).toISOString(),
  };
  api.replyToMail.mockResolvedValue(result);
  api.forwardMail.mockResolvedValue({ ...result, threadId: "thread-2" });
  api.saveMailDraft.mockResolvedValue({ id: "66666666-6666-4666-8666-666666666666", revision: 1 });
  renderWithClient(
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
    />,
  );
});

afterEach(unmountAll);

function panel(): HTMLElement {
  const section = document.querySelector<HTMLElement>("section.reply-panel");
  if (section === null) throw new Error("No reply panel");
  return section;
}

async function openReply(label: "Reply" | "Reply all" | "Forward") {
  click(buttonByText(label));
  await waitFor(() => document.querySelector(`section[aria-label="${label}"]`) !== null);
}

describe("inline reply", () => {
  it("shows who the reply goes to, never me, and sends to exactly those chips", async () => {
    await openReply("Reply");
    const summary = panel().querySelector(".reply-recipients-summary");
    expect(summary?.textContent).toBe("To: Samara");
    expect(panel().textContent).not.toMatch(/Replying to|Me</u);
    expect(await axeViolations(panel())).toEqual([]);

    typeBody("<div>Sounds good</div>", panel());
    click(buttonByText("Send", panel()));
    await waitFor(() => api.replyToMail.mock.calls.length === 1);
    expect(api.replyToMail).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        messageId: "message-2",
        to: [{ address: "samara@example.com", name: "Samara" }],
        cc: [],
        subject: "Re: Plans",
        bodyText: "Sounds good",
      }),
    );
    expect(api.replyToMail.mock.calls[0]?.[0]).not.toHaveProperty("replyAll");
    await waitFor(() => document.querySelector("section.reply-panel") === null);
    expect(toasts.notify.mock.calls.at(-1)?.[0]).toMatchObject({
      message: "Message sent",
      action: { label: "Undo" },
      secondaryAction: { label: "View message" },
    });
  });

  it("Reply all adds the other recipients, and the recipients can be edited", async () => {
    await openReply("Reply all");
    expect(panel().querySelector(".reply-recipients-summary")?.textContent).toBe(
      "To: Samara, Carol",
    );
    click(panel().querySelector(".reply-recipients-summary"));
    await settle();
    expect(byLabel("To recipients", panel()).textContent).toContain("Samara");
    expect(byLabel("Cc recipients", panel()).textContent).toContain("Carol");
    click(byLabel("Remove Carol", panel()));
    addRecipient("To", "dana@example.com", panel());
    typeBody("<div>Thanks all</div>", panel());
    click(buttonByText("Send", panel()));
    await waitFor(() => api.replyToMail.mock.calls.length === 1);
    expect(api.replyToMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: [{ address: "samara@example.com", name: "Samara" }, { address: "dana@example.com" }],
        cc: [],
      }),
    );
  });

  it("switches between Reply, Reply all, and Forward and can edit the subject", async () => {
    await openReply("Reply");
    typeBody("<div>Draft text</div>", panel());
    await openMenu(byLabel("Reply: change response type", panel()));
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual([
      "Reply",
      "Reply all",
      "Forward",
      "Edit subject",
    ]);
    act(() => {
      items[1]?.focus();
    });
    await key("Enter");
    await waitFor(() => document.querySelector('section[aria-label="Reply all"]') !== null);
    expect(panel().querySelector(".reply-recipients-summary")?.textContent).toBe(
      "To: Samara, Carol",
    );
    expect(byLabel("Message body", panel()).innerHTML).toBe("<div>Draft text</div>");

    await openMenu(byLabel("Reply all: change response type", panel()));
    const edit = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).at(-1);
    act(() => {
      edit?.focus();
    });
    await key("Enter");
    expect(byLabel<HTMLInputElement>("Subject", panel()).value).toBe("Re: Plans");
  });

  it("forwards the original message with its attachments", async () => {
    await openReply("Forward");
    expect(byLabel<HTMLInputElement>("Subject", panel()).value).toBe("Fwd: Plans");
    const quote = byLabel("Forwarded message", panel()).textContent ?? "";
    expect(quote).toContain("---------- Forwarded message ---------");
    expect(quote).toContain("From: Samara <samara@example.com>");
    expect(quote).toContain("Quarterly plans attached.");
    expect(byLabel("Forwarded attachments", panel()).textContent).toContain("plan.pdf");

    addRecipient("To", "boss@example.com", panel());
    click(buttonByText("Send", panel()));
    await waitFor(() => api.forwardMail.mock.calls.length === 1);
    expect(api.forwardMail).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        messageId: "message-2",
        to: [{ address: "boss@example.com" }],
        subject: "Fwd: Plans",
        includeAttachments: true,
      }),
    );
    expect(api.replyToMail).not.toHaveBeenCalled();
  });

  it("can forward without the original attachments", async () => {
    await openReply("Forward");
    const toggle = Array.from(
      panel().querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    )[0];
    click(toggle ?? null);
    addRecipient("To", "boss@example.com", panel());
    click(buttonByText("Send", panel()));
    await waitFor(() => api.forwardMail.mock.calls.length === 1);
    expect(api.forwardMail).toHaveBeenCalledWith(
      expect.objectContaining({ includeAttachments: false }),
    );
  });
});
