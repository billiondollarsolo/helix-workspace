import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("raw mail source migration", () => {
  it("stores one tenant-scoped immutable evidence object per message", async () => {
    const migration = await readFile(
      new URL("./0079_mail_raw_sources.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("alter type object_kind add value if not exists 'mail_source'");
    expect(migration).toContain("create table if not exists mail_raw_sources");
    expect(migration).toContain("message_id uuid primary key");
    expect(migration).toContain("object_id uuid not null unique");
    expect(migration).toContain("foreign key (org_id, message_id)");
    expect(migration).toContain("foreign key (org_id, object_id)");
    expect(migration).toContain("projection_sha256 text not null");
    expect(migration).toContain("alter table mail_raw_sources enable row level security");
    expect(migration).toContain("create trigger mail_raw_sources_immutable");
    expect(migration).toContain("create trigger objects_mail_source_immutable");
  });
});
