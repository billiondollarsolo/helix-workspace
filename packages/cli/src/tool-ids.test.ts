import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_TOOL_IDS } from "./tool-ids.js";

function literals(file: string, pattern: RegExp): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [...source.matchAll(pattern)].map((match) => match[1] ?? "");
}

describe("CLI_TOOL_IDS", () => {
  it("lists exactly the tool ids the parser and upload flow can call", () => {
    const emitted = new Set([
      ...literals("./parser.ts", /toolId: "([^"]+)"/gu),
      ...literals("./drive-s3-keys.ts", /toolId: "([^"]+)"/gu),
      ...literals("./upload.ts", /invoke\("([^"]+)"/gu),
    ]);

    expect([...emitted].sort()).toEqual([...CLI_TOOL_IDS].sort());
  });

  it("maps mail list to the registered mail.threads.list tool (CA1)", () => {
    expect(CLI_TOOL_IDS).toContain("mail.threads.list");
    expect(CLI_TOOL_IDS).not.toContain("mail.list");
  });
});
