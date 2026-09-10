import { describe, expect, it } from "vitest";
import { parseReindexSearchArgs } from "./reindex-search.js";

describe("parseReindexSearchArgs", () => {
  it("parses full search reindex command options", () => {
    expect(
      parseReindexSearchArgs([
        "--",
        "--all",
        "--types",
        "mail,chat,drive",
        "--org-id",
        "11111111-1111-4111-8111-111111111111",
        "--batch-size",
        "25",
        "--no-prune-stale",
      ]),
    ).toEqual({
      requireAll: true,
      types: ["mail", "chat", "drive"],
      orgId: "11111111-1111-4111-8111-111111111111",
      batchSize: 25,
      pruneStale: false,
    });
  });

  it("requires an all marker or explicit type list", () => {
    expect(() => parseReindexSearchArgs([])).toThrow("Specify --all or --types");
  });

  it.each(["docs", "sheets", "slides"])("rejects the retired %s index source", (type) => {
    expect(() => parseReindexSearchArgs(["--types", type])).toThrow(
      `Unsupported search reindex type: ${type}`,
    );
  });

  it("rejects unsupported search types", () => {
    expect(() => parseReindexSearchArgs(["--types", "mail,unknown"])).toThrow(
      "Unsupported search reindex type: unknown",
    );
  });
});
