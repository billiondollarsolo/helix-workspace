import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "./parser.js";

describe("global search arguments", () => {
  it("parses global search as a tool call", () => {
    expect(parseCliArgs(["search", "project zenith"])).toEqual({
      kind: "tool-call",
      toolId: "search.query",
      json: { source: "inline", value: '{"query":"project zenith"}' },
    });
    expect(
      parseCliArgs(["search", "--query", "project zenith", "--type", "mail,drive", "--limit", "5"]),
    ).toEqual({
      kind: "tool-call",
      toolId: "search.query",
      json: {
        source: "inline",
        value: '{"query":"project zenith","limit":5,"types":["mail","drive"]}',
      },
    });
    expect(parseCliArgs(["search", "--json", '{"query":"project zenith"}'])).toEqual({
      kind: "tool-call",
      toolId: "search.query",
      json: { source: "inline", value: '{"query":"project zenith"}' },
    });
  });

  it.each(["docs", "sheets", "slides"])("rejects the retired %s search filter", (type) => {
    expect(() => parseCliArgs(["search", "launch", "--type", type])).toThrow(CliUsageError);
  });
});
