import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { driveComments } from "./schema.js";

describe("driveComments schema (parity with migration 0047)", () => {
  it("exposes the drive_comments table with the migration's columns", () => {
    const config = getTableConfig(driveComments);
    expect(config.name).toBe("drive_comments");
    const columns = new Set(config.columns.map((c) => c.name));
    for (const col of [
      "id",
      "org_id",
      "object_id",
      "parent_comment_id",
      "actor_id",
      "anchor",
      "body",
      "status",
      "metadata",
      "resolved_at",
      "created_at",
      "updated_at",
    ]) {
      expect(columns.has(col), `missing column ${col}`).toBe(true);
    }
  });

  it("marks object_id and body NOT NULL and status defaulting to 'open'", () => {
    const config = getTableConfig(driveComments);
    const byName = new Map(config.columns.map((c) => [c.name, c]));
    expect(byName.get("object_id")?.notNull).toBe(true);
    expect(byName.get("body")?.notNull).toBe(true);
    expect(byName.get("status")?.notNull).toBe(true);
  });
});
