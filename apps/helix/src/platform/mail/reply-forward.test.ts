import { describe, expect, it, vi } from "vitest";
import { dlpToolInvocation } from "../dlp.js";
import { featureFlagForTool } from "../tool-registry.js";
import { MAX_REFERENCES, replyThreadingHeaders } from "./reply-context.js";
import type { CreateOutboundMailInput } from "./store-contracts.js";
import type { MailStore } from "./store.js";
import { createMailToolDefinitions, type CreateMailToolDefinitionsOptions } from "./tools.js";
import type { MailThreadDetail, MailThreadMessage } from "./types.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const threadId = "00000000-0000-4000-8000-000000000003";
const inboundId = "00000000-0000-4000-8000-000000000010";
const sentId = "00000000-0000-4000-8000-000000000011";
const objectId = "00000000-0000-4000-8000-000000000020";

const inbound: MailThreadMessage = {
  id: inboundId,
  from: { address: "friend@example.com", name: "Friend" },
  replyTo: [{ address: "desk@example.com", name: "Desk" }],
  to: [{ address: "me@helix.test" }, { address: "colleague@example.com" }],
  cc: [
    { address: "ME.ALIAS@helix.test" },
    { address: "carol@example.com", name: "Carol" },
    { address: "COLLEAGUE@example.com" },
  ],
  bcc: [],
  sentAt: new Date("2026-10-01T10:00:00Z"),
  body: "<p>Quarterly <b>plans</b></p>",
  bodyFormat: "html",
  plainBody: "Quarterly plans",
  hasAttachment: true,
  attachments: [
    {
      objectId,
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteSize: 4,
      disposition: "attachment",
    },
  ],
  messageIdHeader: "<m1@example.com>",
  references: ["<root@example.com>"],
  subject: "Plans",
};

const sent: MailThreadMessage = {
  id: sentId,
  from: { address: "me@helix.test", name: "Me" },
  to: [{ address: "friend@example.com", name: "Friend" }],
  cc: [{ address: "dana@example.com" }],
  bcc: [],
  sentAt: new Date("2026-10-02T10:00:00Z"),
  body: "Thanks!",
  bodyFormat: "plain",
  hasAttachment: false,
  attachments: [],
  messageIdHeader: "<m2@helix.test>",
  references: ["<root@example.com>", "<m1@example.com>"],
  subject: "Re: Plans",
};

function thread(messages: readonly MailThreadMessage[]): MailThreadDetail {
  return {
    id: threadId,
    subject: "Plans",
    preview: "",
    participants: [],
    messages,
    labels: [],
    archivedAt: null,
    deletedAt: null,
    snoozedUntil: null,
    lastActivity: new Date(),
    unread: false,
    starred: false,
    direction: "mixed",
  };
}

function setup(
  messages: readonly MailThreadMessage[] = [inbound, sent],
  extra: Partial<CreateMailToolDefinitionsOptions> = {},
) {
  const queued: CreateOutboundMailInput[] = [];
  const readMessageAttachment = vi.fn(async () => ({
    content: Buffer.from("%PDF"),
    mimeType: "application/pdf",
    filename: "report.pdf",
    disposition: "attachment",
  }));
  const store = {
    getThread: vi.fn(async () => thread(messages)),
    listAliases: vi.fn(async () => [{ email: "me.alias@helix.test", displayName: null }]),
    readMessageAttachment,
    createOutbound: vi.fn(async (input: CreateOutboundMailInput) => {
      queued.push(input);
      return {
        id: "outbound-1",
        messageId: "message-new",
        threadId: input.threadId ?? "thread-new",
        status: "queued",
        undoUntil: new Date(),
        createdAt: new Date(),
        deliveryMetadata: {},
      };
    }),
  } as unknown as MailStore;
  const tools = createMailToolDefinitions({ store, ...extra });
  const tool = (id: string) => {
    const found = tools.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`missing ${id}`);
    return found;
  };
  const requirePermission = vi.fn(async () => undefined);
  const invoke = async (
    id: string,
    input: unknown,
    actorType: "user" | "agent" = "user",
  ): Promise<unknown> =>
    await tool(id).handler(tool(id).inputSchema.parse(input), {
      actor: {
        id: actorId,
        orgId,
        type: actorType,
        email: "me@helix.test",
        displayName: "Me",
        scopes: ["mail.send", "mail.external"],
      },
      requirePermission,
    } as never);
  return { queued, invoke, tool, requirePermission, readMessageAttachment };
}

const addresses = (list: readonly { address: string }[] | undefined) =>
  (list ?? []).map((entry) => entry.address);

describe("mail.reply (ML4a-c)", () => {
  it("replies to Reply-To with In-Reply-To and References from the parent", async () => {
    const { queued, invoke } = setup();
    await invoke("mail.reply", { threadId, bodyText: "On it." });
    const call = queued[0];
    expect(addresses(call?.envelope.to)).toEqual(["desk@example.com"]);
    expect(call?.envelope.cc).toEqual([]);
    expect(call?.envelope.inReplyTo).toBe("<m1@example.com>");
    expect(call?.envelope.references).toEqual(["<root@example.com>", "<m1@example.com>"]);
    expect(call?.envelope.subject).toBe("Re: Plans");
    expect(call?.threadId).toBe(threadId);
  });

  it("reply all adds the parent's To/Cc minus the user's addresses and aliases, deduped", async () => {
    const { queued, invoke } = setup();
    await invoke("mail.reply", { threadId, bodyText: "All good.", replyAll: true });
    const envelope = queued[0]?.envelope;
    expect(addresses(envelope?.to)).toEqual(["desk@example.com", "colleague@example.com"]);
    expect(addresses(envelope?.cc)).toEqual(["carol@example.com"]);
  });

  it("never replies to self: answering the user's own message goes to its recipients", async () => {
    const { queued, invoke } = setup();
    await invoke("mail.reply", {
      threadId,
      messageId: sentId,
      bodyText: "Follow-up",
      replyAll: true,
    });
    const envelope = queued[0]?.envelope;
    expect(addresses(envelope?.to)).toEqual(["friend@example.com"]);
    expect(addresses(envelope?.cc)).toEqual(["dana@example.com"]);
    expect(envelope?.inReplyTo).toBe("<m2@helix.test>");
    expect(envelope?.references).toEqual([
      "<root@example.com>",
      "<m1@example.com>",
      "<m2@helix.test>",
    ]);
    expect(envelope?.subject).toBe("Re: Plans");
  });

  it("requires mail.external for derived external recipients", async () => {
    const { invoke, requirePermission } = setup(undefined, { internalDomains: ["helix.test"] });
    await invoke("mail.reply", { threadId, bodyText: "Hi" });
    expect(requirePermission).toHaveBeenCalledWith("mail.external");
  });

  it("makes agents name recipients so confirmation shows them", async () => {
    const { invoke, queued } = setup();
    await expect(invoke("mail.reply", { threadId, bodyText: "Hi" }, "agent")).rejects.toThrow(
      /must list reply recipients/u,
    );
    await invoke(
      "mail.reply",
      { threadId, bodyText: "Hi", to: ["desk@example.com"], idempotencyKey: "agent-reply-1" },
      "agent",
    );
    expect(addresses(queued[0]?.envelope.to)).toEqual(["desk@example.com"]);
  });

  it("caps References to the root plus the most recent ancestors", () => {
    const references = Array.from({ length: 40 }, (_, index) => `<r${String(index)}@x.test>`);
    const headers = replyThreadingHeaders({ messageIdHeader: "<parent@x.test>", references });
    expect(headers.references).toHaveLength(MAX_REFERENCES);
    expect(headers.references[0]).toBe("<r0@x.test>");
    expect(headers.references.at(-1)).toBe("<parent@x.test>");
    expect(headers.references.at(-2)).toBe("<r39@x.test>");
  });
});

describe("mail.forward (ML4d)", () => {
  it("is gated exactly like mail.send", () => {
    const { tool } = setup();
    const send = tool("mail.send");
    const forward = tool("mail.forward");
    expect(forward.permission).toBe(send.permission);
    expect(forward.sideEffects).toBe(send.sideEffects);
    expect(forward.confirmationRequired).toBe(true);
    expect(forward.rateLimit).toEqual(send.rateLimit);
    expect(forward.scopeComposition?.conditionalScopes?.[0]?.scope).toBe("mail.external");
  });

  it("shares mail.send's outbound feature flag and DLP boundary, including the source label", () => {
    expect(featureFlagForTool({ id: "mail.forward" })).toBe(
      featureFlagForTool({ id: "mail.send" }),
    );
    expect(
      dlpToolInvocation(
        "mail.forward",
        { messageId: inboundId, to: ["x@example.com"] },
        { type: "user" },
      ),
    ).toMatchObject({
      boundary: "mail_send",
      resources: [{ resourceType: "mail.message", resourceId: inboundId }],
    });
  });

  it("starts a new thread with Fwd:, the quoted original, and its attachments", async () => {
    const { queued, invoke, readMessageAttachment } = setup();
    await invoke("mail.forward", {
      threadId,
      messageId: inboundId,
      to: ["boss@example.com"],
      bodyText: "FYI",
    });
    const call = queued[0];
    expect(call?.threadId).toBeUndefined();
    expect(call?.envelope.inReplyTo).toBeUndefined();
    expect(call?.envelope.subject).toBe("Fwd: Plans");
    expect(call?.envelope.text).toMatch(/^FYI\n\n---------- Forwarded message ---------\n/u);
    expect(call?.envelope.text).toContain("From: Friend <friend@example.com>");
    expect(call?.envelope.text).toContain("Quarterly plans");
    expect(call?.envelope.html).toContain("<blockquote><p>Quarterly <b>plans</b></p></blockquote>");
    expect(readMessageAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ orgId, actorId, messageId: inboundId, objectId }),
    );
    expect(call?.envelope.attachments).toEqual([
      expect.objectContaining({ filename: "report.pdf", content: Buffer.from("%PDF") }),
    ]);
  });

  it("does not double the Fwd: prefix and can skip attachments", async () => {
    const { queued, invoke, readMessageAttachment } = setup();
    await invoke("mail.forward", {
      threadId,
      messageId: inboundId,
      to: ["boss@example.com"],
      subject: "Fwd: Plans",
      includeAttachments: false,
    });
    expect(queued[0]?.envelope.subject).toBe("Fwd: Plans");
    expect(readMessageAttachment).not.toHaveBeenCalled();
    expect(queued[0]?.envelope.attachments).toEqual([]);
  });
});

describe("Reply-To on send (ML11)", () => {
  it("validates and carries replyTo on the envelope", async () => {
    const { queued, invoke } = setup();
    await invoke("mail.send", {
      to: ["bob@example.com"],
      subject: "Hi",
      bodyText: "Body",
      replyTo: { address: "desk@helix.test", name: "Desk" },
    });
    expect(queued[0]?.envelope.replyTo).toEqual({ address: "desk@helix.test", name: "Desk" });
    await expect(
      invoke("mail.send", {
        to: ["bob@example.com"],
        subject: "Hi",
        bodyText: "B",
        replyTo: "nope",
      }),
    ).rejects.toThrow();
  });
});
