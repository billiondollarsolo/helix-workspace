import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./parser.js";

function inlineInput(argv: readonly string[]): { toolId: string; input: Record<string, unknown> } {
  const parsed = parseCliArgs([...argv]);
  if (parsed.kind !== "tool-call" || parsed.json.source !== "inline") {
    throw new Error(`expected an inline tool call for ${argv.join(" ")}`);
  }
  return { toolId: parsed.toolId, input: JSON.parse(parsed.json.value) as Record<string, unknown> };
}

// Field names must match the mail tool schemas; the old `body`/`html`/`mail.list`
// mapping was rejected by the API (400 "bodyText Required", 404 unknown tool).
describe("mail command flag mapping", () => {
  it("maps send flags onto mail.send fields with an idempotency key", () => {
    expect(
      inlineInput([
        "mail",
        "send",
        "--to",
        "ada@example.com,grace@example.com",
        "--cc",
        "team@example.com",
        "--subject",
        "Launch",
        "--body",
        "Ready",
        "--html",
        "<p>Ready</p>",
        "--idempotency-key",
        "launch-0001",
      ]),
    ).toEqual({
      toolId: "mail.send",
      input: {
        to: ["ada@example.com", "grace@example.com"],
        cc: ["team@example.com"],
        subject: "Launch",
        bodyText: "Ready",
        bodyHtml: "<p>Ready</p>",
        idempotencyKey: "launch-0001",
      },
    });
  });

  it("generates an idempotency key for sends and replies when none is given", () => {
    // API credentials must send mail idempotently, or approval fails with a 400.
    for (const argv of [
      ["mail", "send", "--to", "ada@example.com", "--body", "Hi"],
      ["mail", "reply", "--thread-id", "thread-1", "--to", "ada@example.com", "--body", "Hi"],
    ]) {
      expect(inlineInput(argv).input.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    }
  });

  it("maps reply flags, including recipients and an explicit In-Reply-To", () => {
    expect(
      inlineInput([
        "mail",
        "reply",
        "--thread-id",
        "thread-1",
        "--to",
        "ada@example.com",
        "--in-reply-to",
        "<m1@example.com>",
        "--body",
        "Thanks",
        "--idempotency-key",
        "reply-0001",
      ]),
    ).toEqual({
      toolId: "mail.reply",
      input: {
        threadId: "thread-1",
        to: ["ada@example.com"],
        inReplyTo: "<m1@example.com>",
        bodyText: "Thanks",
        idempotencyKey: "reply-0001",
      },
    });
  });

  it("lists threads through mail.threads.list and keeps --mailbox as a folder alias", () => {
    expect(
      inlineInput(["mail", "list", "--folder", "inbox", "--limit", "25", "--offset", "50"]),
    ).toEqual({ toolId: "mail.threads.list", input: { folder: "inbox", limit: 25, offset: 50 } });
    expect(inlineInput(["mail", "list", "--mailbox", "sent"])).toEqual({
      toolId: "mail.threads.list",
      input: { folder: "sent" },
    });
  });

  it("sends search labels as the labels array", () => {
    expect(inlineInput(["mail", "search", "--query", "roadmap", "--label", "work,vip"])).toEqual({
      toolId: "mail.search",
      input: { query: "roadmap", labels: ["work", "vip"] },
    });
  });
});
