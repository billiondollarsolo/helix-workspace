import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0105_drive_deletion_proofs.sql", import.meta.url),
  "utf8",
);

describe("0105 Drive deletion proofs migration", () => {
  it("retains an idempotent completed proof after physical deletion", () => {
    expect(migration).toContain("completed_at timestamptz");
    expect(migration).toContain("'pending', 'processing', 'completed'");
    expect(migration).toContain("status = 'completed'");
  });
});
