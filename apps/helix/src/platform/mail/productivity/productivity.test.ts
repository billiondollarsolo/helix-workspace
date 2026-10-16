import assert from "node:assert/strict";
import { describe, it, expect, vi } from "vitest";
import { mailProductivityPreferencesSchema } from "@helix/contracts";
import type { Actor } from "@helix/sdk-types";
import { createToolRegistry } from "../../tool-registry.js";
import type { MailStore } from "../store.js";
import type { MailThreadDetail } from "../types.js";
import { MailProductivityService, messageMatches } from "./service.js";
import { createMailProductivityTools } from "./tools.js";
import type { MailProductivityStore, ArtifactRow } from "./store.js";
import { parseMailSearchQuery } from "../store-search-query.js";
const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  scopes: ["mail.read", "mail.write"],
};
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
function setup() {
  const thread: MailThreadDetail = {
    id: threadId,
    subject: "Invoice",
    preview: "",
    participants: [],
    messages: [
      {
        id: messageId,
        from: { address: "billing@example.test" },
        to: [],
        cc: [],
        bcc: [],
        sentAt: new Date(),
        body: "Could you review?",
        bodyFormat: "plain",
        hasAttachment: false,
        attachments: [],
      },
    ],
    labels: [],
    archivedAt: null,
    deletedAt: null,
    snoozedUntil: null,
    lastActivity: new Date(),
    unread: true,
    starred: false,
    direction: "inbound",
  };
  const artifact: ArtifactRow = {
    id: messageId,
    kind: "reply",
    source_key: threadId,
    thread_id: threadId,
    message_id: messageId,
    event_id: null,
    status: "working",
    body: "",
    object_id: null,
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    lease_token: messageId,
  };
  const getThread = vi.fn(async () => thread);
  const chat = vi.fn(async () => ({
    message: "Suggested reply",
    providerId: "test",
    model: "test",
  }));
  const enabled = vi.fn(async () => true);
  const finish = vi.fn(async (_actor: Actor, _claim: ArtifactRow, text: string) => {
    artifact.status = "ready";
    artifact.body = text;
  });
  const fail = vi.fn(async () => {});
  const store = {
    preferences: vi.fn(async () => mailProductivityPreferencesSchema.parse({})),
    claim: vi.fn(async () => artifact),
    finish,
    fail,
    find: vi.fn(async () => artifact),
    recent: vi.fn(async () => [artifact]),
  } as unknown as MailProductivityStore;
  const mail = {
    getThread,
    listLabels: vi.fn(async () => [{ slug: "finance" }]),
  } as unknown as MailStore;
  const service = new MailProductivityService({
    store,
    mail,
    ai: { chat },
    enabled,
    classifyThread: async () => "restricted",
  });
  const registry = createToolRegistry();
  for (const tool of createMailProductivityTools(service)) registry.register(tool);
  return { service, registry, store, thread, getThread, chat, enabled, finish, fail };
}
describe("native mail productivity", () => {
  it("keeps automation off until opted in", () => {
    expect(mailProductivityPreferencesSchema.parse({})).toMatchObject({
      preparedReplies: false,
      meetingBriefs: false,
      dailyDigest: false,
      filingRules: [],
    });
  });
  it("parses follow-up views without turning them into body searches", () => {
    expect(parseMailSearchQuery("is:needs-reply is:overdue invoice")).toMatchObject({
      followUp: "needs_reply",
      overdue: true,
      terms: ["invoice"],
    });
    expect(parseMailSearchQuery("is:waiting-on").followUp).toBe("waiting_on");
  });
  it("prepares actor-authorized text without saving or sending a human draft", async () => {
    const h = setup();
    const result = await h.service.prepareReply(actor, threadId);
    expect(result.text).toBe("Suggested reply");
    expect(h.getThread).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: actor.orgId, actorId: actor.id, threadId }),
    );
    expect(h.chat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor, classification: "restricted" }),
    );
    expect(h.finish).toHaveBeenCalledOnce();
  });
  it("does not call AI when disabled", async () => {
    const h = setup();
    h.enabled.mockResolvedValue(false);
    await expect(h.service.prepareReply(actor, threadId)).rejects.toThrow("disabled");
    expect(h.chat).not.toHaveBeenCalled();
  });
  it("does not regenerate a concurrently claimed suggestion", async () => {
    const h = setup();
    vi.mocked(h.store.claim).mockResolvedValue(null);
    await h.service.prepareReply(actor, threadId);
    expect(h.chat).not.toHaveBeenCalled();
  });
  it("rejects a reply when new mail arrives during generation", async () => {
    const h = setup();
    const original = h.thread.messages[0];
    assert(original);
    h.chat.mockImplementation(async () => {
      h.getThread.mockResolvedValue({
        ...h.thread,
        messages: [{ ...original, id: "new-message" }],
      });
      return { message: "stale", providerId: "test", model: "test" };
    });
    await expect(h.service.prepareReply(actor, threadId)).rejects.toThrow("New mail");
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenCalledOnce();
  });
  it.each([
    {
      name: "Forward",
      criteria: { fromContains: "x" },
      actions: { forward: "attacker@test.example" },
    },
    { name: "Delete", criteria: { fromContains: "x" }, actions: { delete: true } },
    { name: "All", criteria: {}, actions: { archive: true } },
    {
      name: "Unknown label",
      criteria: { fromContains: "x" },
      actions: { applyLabels: ["secret"] },
    },
  ])("rejects unsupported model rule output", async (proposal) => {
    const h = setup();
    h.chat.mockResolvedValue({
      message: JSON.stringify(proposal),
      providerId: "test",
      model: "test",
    });
    await expect(h.service.proposeRule(actor, "Make a rule")).rejects.toThrow("safely");
  });
  it("accepts a bounded structured rule without applying it", async () => {
    const h = setup();
    const rule = {
      name: "Invoices",
      criteria: { subjectContains: "invoice" },
      actions: { applyLabels: ["finance"] },
    };
    h.chat.mockResolvedValue({ message: JSON.stringify(rule), providerId: "test", model: "test" });
    expect(await h.service.proposeRule(actor, "Label invoices finance")).toEqual(rule);
  });
  it("uses the inbound literal matcher for previews", () => {
    const h = setup();
    const original = h.thread.messages[0];
    assert(original);
    expect(
      messageMatches(h.thread.subject, original, {
        fromContains: "BILLING@",
        bodyContains: "review",
      }),
    ).toBe(true);
    expect(messageMatches(h.thread.subject, original, { bodyContains: ".*" })).toBe(false);
  });
  it("requires both mailbox and Drive scopes before filing", async () => {
    const h = setup();
    const result = await h.registry.invoke(
      "mail.attachment.file",
      { threadId, messageId, objectId: messageId, folderId: threadId },
      { actor: { ...actor, type: "agent", scopes: ["drive.write"] } },
    );
    expect(result.ok).toBe(false);
    expect(h.getThread).not.toHaveBeenCalled();
  });
  it("publishes concrete MCP input fields", async () => {
    const h = setup();
    const definitions = await h.registry.listVisible(actor);
    const schema = definitions
      .find((tool) => tool.id === "mail.reply.prepare")
      ?.inputSchema.toJsonSchema();
    expect(schema).toMatchObject({ properties: { threadId: { type: "string" } } });
  });
});
