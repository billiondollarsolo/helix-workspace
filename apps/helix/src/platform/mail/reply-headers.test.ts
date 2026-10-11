import { describe, expect, it } from "vitest";
import { replyHeaders } from "./reply-headers.js";

const actor = { id: "actor-1", orgId: "org-1" };
const store = {
  getReplyContext: async () => ({
    subject: "Launch plan",
    messageId: "<m2@example.net>",
    references: ["<m1@example.net>"],
  }),
};

// Without these defaults a reply to another mail system arrived there as a new
// thread titled "Re:" with no In-Reply-To or References.
describe("mail reply headers", () => {
  it("derives Re: subject, In-Reply-To, and References from the thread", async () => {
    await expect(replyHeaders({ threadId: "t-1", references: [] }, actor, store)).resolves.toEqual({
      subject: "Re: Launch plan",
      inReplyTo: "<m2@example.net>",
      references: ["<m1@example.net>", "<m2@example.net>"],
    });
  });

  it("keeps caller-supplied headers and an existing Re: prefix", async () => {
    await expect(
      replyHeaders(
        {
          threadId: "t-1",
          subject: "RE: Launch plan",
          inReplyTo: "<explicit@example.net>",
          references: ["<explicit@example.net>"],
        },
        actor,
        store,
      ),
    ).resolves.toEqual({
      subject: "RE: Launch plan",
      inReplyTo: "<explicit@example.net>",
      references: ["<explicit@example.net>"],
    });
    const prefixed = {
      getReplyContext: async () => ({ subject: "Re: Launch plan", references: [] }),
    };
    await expect(
      replyHeaders({ threadId: "t-1", references: [] }, actor, prefixed),
    ).resolves.toEqual({ subject: "Re: Launch plan", references: [] });
  });

  it("falls back to a bare Re: when the store cannot describe the thread", async () => {
    await expect(replyHeaders({ threadId: "t-1", references: [] }, actor, {})).resolves.toEqual({
      subject: "Re:",
      references: [],
    });
  });
});
