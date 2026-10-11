import type { Actor } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import type { MailStore } from "./store.js";
import { createMailToolDefinitions } from "./tools.js";
import { createMailLabelAndScheduleToolDefinitions } from "./tools-labels.js";
import type { MailLabelRecord, MailScheduledSendRecord } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const delegatorId = "33333333-3333-4333-8333-333333333333";
const labelId = "44444444-4444-4444-8444-444444444444";
const outboundId = "55555555-5555-4555-8555-555555555555";
const actor: Actor = { id: actorId, orgId, type: "user", scopes: ["mail.read", "mail.write"] };
const at = new Date("2026-10-11T10:00:00.000Z");
const label: MailLabelRecord = {
  id: labelId,
  orgId,
  ownerActorId: delegatorId,
  parentId: null,
  slug: "clients",
  name: "Clients",
  color: "#00792f",
  sortOrder: 100,
  threadCount: 3,
  unreadCount: 1,
  createdAt: at,
  updatedAt: at,
};
const scheduled: MailScheduledSendRecord = {
  outboundId,
  threadId: "66666666-6666-4666-8666-666666666666",
  messageId: "77777777-7777-4777-8777-777777777777",
  subject: "Quarterly update",
  preview: "Numbers attached",
  to: [{ address: "board@example.test" }],
  cc: [],
  bcc: [],
  hasAttachment: true,
  sendAt: new Date("2026-10-12T08:00:00.000Z"),
  createdAt: at,
  envelope: {
    from: { address: "me@example.test" },
    text: "Numbers attached",
    attachments: [{ objectId: "88888888-8888-4888-8888-888888888888", filename: "q3.pdf" }],
  },
};

function registry(store: Partial<MailStore>) {
  const tools = createToolRegistry();
  for (const tool of createMailLabelAndScheduleToolDefinitions({ store: store as MailStore }))
    tools.register(tool);
  return tools;
}

describe("mail label and scheduled-send tools", () => {
  it("creates a label in the delegated mailbox and serializes palette and counts", async () => {
    const createLabel = vi.fn<NonNullable<MailStore["createLabel"]>>().mockResolvedValue(label);
    const result = await registry({ createLabel }).invoke(
      "mail.label.create",
      { name: " Clients ", color: "green", mailboxActorId: delegatorId },
      { actor },
    );

    expect(createLabel).toHaveBeenCalledWith({
      orgId,
      actorId: delegatorId,
      name: "Clients",
      color: "green",
      parentId: null,
    });
    expect(result).toMatchObject({
      ok: true,
      output: {
        label: { id: labelId, colorName: "green", color: "#00792f", unreadCount: 1, shared: false },
      },
    });
  });

  it("lists folders, including All mail and Scheduled, and labels with unread counts", async () => {
    const tools = createToolRegistry();
    for (const tool of createMailToolDefinitions({
      store: {
        listFolders: async () => [
          { id: "inbox", label: "Inbox", total: 24, unread: 6 },
          { id: "scheduled", label: "Scheduled", total: 2, unread: 0 },
          { id: "all", label: "All mail", total: 80, unread: 9 },
        ],
        listLabels: async () => [{ ...label, ownerActorId: null }],
      } as unknown as MailStore,
    }))
      tools.register(tool);

    expect(await tools.invoke("mail.folders.list", {}, { actor })).toMatchObject({
      ok: true,
      output: { folders: [{ id: "inbox", unread: 6 }, { id: "scheduled" }, { id: "all" }] },
    });
    expect(await tools.invoke("mail.labels.list", {}, { actor })).toMatchObject({
      ok: true,
      output: {
        labels: [
          {
            slug: "clients",
            color: "#00792f",
            colorName: "green",
            parentId: null,
            threadCount: 3,
            unreadCount: 1,
            shared: true,
          },
        ],
      },
    });
  });

  it("rejects colours outside the palette and empty updates", async () => {
    const tools = registry({});
    expect(
      await tools.invoke("mail.label.create", { name: "x", color: "#ff0000" }, { actor }),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(await tools.invoke("mail.label.update", { id: labelId }, { actor })).toMatchObject({
      ok: false,
      statusCode: 400,
    });
  });

  it("returns a cancelled scheduled send to Drafts with its attachments", async () => {
    const saveDraft = vi.fn<NonNullable<MailStore["saveDraft"]>>().mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
    } as Awaited<ReturnType<NonNullable<MailStore["saveDraft"]>>>);
    const cancelOutbound = vi.fn<MailStore["cancelOutbound"]>().mockResolvedValue({
      id: outboundId,
    } as Awaited<ReturnType<MailStore["cancelOutbound"]>>);
    const result = await registry({
      listScheduledSends: async () => ({ scheduled: [scheduled], total: 1 }),
      saveDraft,
      cancelOutbound,
      discardDraft: vi.fn(),
    }).invoke("mail.scheduled.cancel", { outboundId }, { actor });

    expect(result).toMatchObject({
      ok: true,
      output: { cancelled: true, draftId: "99999999-9999-4999-8999-999999999999" },
    });
    expect(saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: outboundId,
        threadId: scheduled.threadId,
        attachmentObjectIds: ["88888888-8888-4888-8888-888888888888"],
        envelope: expect.objectContaining({
          subject: "Quarterly update",
          bodyText: "Numbers attached",
          to: [{ address: "board@example.test" }],
        }),
      }),
    );
    expect(saveDraft.mock.invocationCallOrder[0]).toBeLessThan(
      cancelOutbound.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("discards the draft when the send already started", async () => {
    const discardDraft = vi.fn<NonNullable<MailStore["discardDraft"]>>().mockResolvedValue(true);
    const result = await registry({
      listScheduledSends: async () => ({ scheduled: [scheduled], total: 1 }),
      saveDraft: async () =>
        ({ id: "draft-1" }) as Awaited<ReturnType<NonNullable<MailStore["saveDraft"]>>>,
      cancelOutbound: async () => null,
      discardDraft,
    }).invoke("mail.scheduled.cancel", { outboundId }, { actor });

    expect(result).toMatchObject({ ok: true, output: { cancelled: false, draftId: null } });
    expect(discardDraft).toHaveBeenCalledWith({ orgId, actorId, id: "draft-1" });
  });

  it("refuses to reschedule into the past", async () => {
    const rescheduleSend = vi.fn();
    expect(
      await registry({ rescheduleSend }).invoke(
        "mail.scheduled.reschedule",
        { outboundId, sendAt: "2020-01-01T00:00:00.000Z" },
        { actor },
      ),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(rescheduleSend).not.toHaveBeenCalled();
  });
});
