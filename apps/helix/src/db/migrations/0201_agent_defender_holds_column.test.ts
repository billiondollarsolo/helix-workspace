import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0201_agent_defender_holds_column.sql", import.meta.url),
  "utf8",
);

describe("0201 Agent Defender hold list", () => {
  it("prefers table columns over RETURNS TABLE names", () => {
    expect(migration).toContain("#variable_conflict use_column");
    expect(migration).toContain("helix_agent_defender_list_holds");
  });
});
