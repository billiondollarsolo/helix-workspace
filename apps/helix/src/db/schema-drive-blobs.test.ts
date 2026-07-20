import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { driveBlobs } from "./schema.js";

describe("drive_blobs drizzle schema", () => {
  it("exposes drive_blobs with migration columns", () => {
    const config = getTableConfig(driveBlobs);
    expect(config.name).toBe("drive_blobs");
    const columns = new Set(config.columns.map((c) => c.name));
    for (const col of [
      "org_id",
      "sha256",
      "storage_key",
      "byte_size",
      "refcount",
      "created_at",
      "updated_at",
    ]) {
      expect(columns.has(col), `missing column ${col}`).toBe(true);
    }
  });
});
