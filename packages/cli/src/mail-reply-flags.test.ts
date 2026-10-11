import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./parser.js";

describe("helix mail reply", () => {
  it("passes reply recipients, which API and agent replies must name", () => {
    // Without --to every CLI reply was rejected: agents must list recipients in `to`.
    expect(
      parseCliArgs([
        "mail",
        "reply",
        "--thread-id",
        "thread-1",
        "--to",
        "ada@example.com,grace@example.com",
        "--body",
        "Thanks",
      ]),
    ).toEqual({
      kind: "tool-call",
      toolId: "mail.reply",
      json: {
        source: "inline",
        value:
          '{"threadId":"thread-1","to":["ada@example.com","grace@example.com"],"bodyText":"Thanks"}',
      },
    });
  });
});
