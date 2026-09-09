import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0130 Meet recording promotion migration", () => {
  it("requires validation before one-way completion and freezes content identity", async () => {
    const sql = await readFile(
      new URL("./0130_meet_recording_promotion.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("status in ('prepared', 'ready', 'completed')");
    expect(sql).toContain("helix_mark_meet_recording_ready");
    expect(sql).toContain("status = 'ready'");
    expect(sql).toContain("validated Meet recording content is immutable");
    expect(sql).toContain("before update on objects");
  });
});
