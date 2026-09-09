import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0095 calendar manager role", () => {
  it("adds one explicit management role without broadening writers", async () => {
    const migration = await readFile(
      new URL("./0095_calendar_manager_role.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("add value if not exists 'manager'");
    expect(migration).not.toContain("administrator");
  });
});
