import { describe, expect, it } from "vitest";
import {
  formatMailSseEvent,
  frameForMailActivity,
  handleMailStreamEventForTest,
} from "./stream.js";

describe("mail SSE stream", () => {
  it("frames activity.mail.received for the subscribed org", () => {
    const frame = frameForMailActivity({
      subject: "activity.mail.received",
      payload: { threadId: "t1", orgId: "o1" },
      actorOrgId: "o1",
    });
    expect(frame).toEqual({ type: "mail.received", threadId: "t1", orgId: "o1" });
    if (frame === null) throw new Error("Expected a mail activity frame");
    expect(formatMailSseEvent(frame)).toContain('data: {"type":"mail.received"');
  });

  it("frames activity.mail.sent", () => {
    const frame = frameForMailActivity({
      subject: "activity.mail.sent",
      payload: { threadId: "t2", orgId: "o1" },
      actorOrgId: "o1",
    });
    expect(frame?.type).toBe("mail.sent");
  });

  it("does not deliver events for a different org (authz filter)", async () => {
    const chunks: string[] = [];
    const delivered = await handleMailStreamEventForTest(
      { write: (c) => chunks.push(c) },
      {
        subject: "activity.mail.received",
        payload: { threadId: "t1", orgId: "other-org" },
        actorOrgId: "o1",
      },
    );
    expect(delivered).toBe(false);
    expect(chunks).toEqual([]);
  });

  it("writes an SSE data frame when org matches", async () => {
    const chunks: string[] = [];
    const delivered = await handleMailStreamEventForTest(
      { write: (c) => chunks.push(c) },
      {
        subject: "activity.mail.received",
        payload: { threadId: "t1", orgId: "o1" },
        actorOrgId: "o1",
      },
    );
    expect(delivered).toBe(true);
    expect(chunks[0]).toMatch(/^data: /);
    expect(chunks[0]).toContain("mail.received");
  });
});
