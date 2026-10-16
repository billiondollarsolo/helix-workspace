import { describe, expect, it, vi } from "vitest";
import { createToolRegistry } from "../../tool-registry.js";
import { AICostLimitExceededError } from "../../ai/costs/guard.js";
import { createMailAiTools } from "./tools.js";
import type { MailThreadDetail } from "../types.js";
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user" as const,
  scopes: ["mail.read"],
};
const threadId = "33333333-3333-4333-8333-333333333333";
const thread: MailThreadDetail = {
  id: threadId,
  subject: "Review",
  preview: "hello",
  participants: [],
  unread: false,
  starred: false,
  direction: "inbound",
  messages: [
    {
      id: "message",
      to: [],
      cc: [],
      bcc: [],
      sentAt: new Date(),
      body: "Original question",
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
};
function setup(enabled = true) {
  const chat = vi.fn(async () => ({
    message: "Suggested text",
    providerId: "test",
    model: "test",
  }));
  const getThread = vi.fn(async (): Promise<MailThreadDetail | null> => thread);
  const tools = createToolRegistry();
  for (const tool of createMailAiTools({
    store: { getThread },
    ai: { chat },
    enabled: async () => enabled,
    classifyThread: async () => "restricted",
  }))
    tools.register(tool);
  return { chat, getThread, tools };
}
describe("mail AI assistance", () => {
  it.each(["compose", "rewrite", "reply", "summarize"])(
    "generates %s with server-owned context and never sends or saves",
    async (action) => {
      const { chat, getThread, tools } = setup();
      const result = await tools.invoke(
        "mail.ai.suggest",
        { action, threadId, body: "Draft" },
        { actor },
      );
      expect(result).toMatchObject({
        ok: true,
        output: { text: "Suggested text", classification: "restricted" },
      });
      expect(getThread).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: actor.orgId, actorId: actor.id, threadId }),
      );
      expect(chat).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            expect.objectContaining({ content: expect.stringContaining("Original question") }),
          ]),
        }),
        expect.objectContaining({ actor, classification: "restricted" }),
      );
      expect(
        tools
          .list()
          .filter((tool) => tool.id.startsWith("mail."))
          .map((tool) => tool.id),
      ).toEqual(["mail.ai.status", "mail.ai.suggest"]);
    },
  );
  it("refuses disabled features, inaccessible threads, and client classification overrides", async () => {
    const off = setup(false);
    expect(
      await off.tools.invoke("mail.ai.suggest", { action: "compose" }, { actor }),
    ).toMatchObject({ ok: false, statusCode: 403 });
    expect(off.chat).not.toHaveBeenCalled();
    const on = setup();
    on.getThread.mockResolvedValue(null);
    expect(
      await on.tools.invoke("mail.ai.suggest", { action: "reply", threadId }, { actor }),
    ).toMatchObject({ ok: false, statusCode: 404 });
    expect(
      await on.tools.invoke(
        "mail.ai.suggest",
        { action: "compose", classification: "public" },
        { actor },
      ),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(on.chat).not.toHaveBeenCalled();
  });
  it("returns an actionable budget limit instead of a generic server error", async () => {
    const { tools, chat } = setup();
    chat.mockRejectedValue(
      new AICostLimitExceededError(
        "AI cost budget exceeded for mail.compose-help: actor_daily_cost.",
        "actor_daily_cost",
        3600,
      ),
    );
    expect(await tools.invoke("mail.ai.suggest", { action: "compose" }, { actor })).toMatchObject({
      ok: false,
      statusCode: 429,
      error: expect.stringContaining("budget exceeded"),
    });
  });
  it("rejects incomplete context instead of inventing a summary", async () => {
    const { tools, getThread, chat } = setup();
    getThread.mockResolvedValue({ ...thread, bodyTruncated: true });
    expect(
      await tools.invoke("mail.ai.suggest", { action: "summarize", threadId }, { actor }),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(chat).not.toHaveBeenCalled();
  });
});
