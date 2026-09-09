import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0168 CardDAV scalability migration", () => {
  it("adds shared address books, indexed bounded sync, and governed tombstone cleanup", async () => {
    const sql = await readFile(new URL("./0168_carddav_scalability.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table carddav_addressbooks");
    expect(sql).toContain("actors_create_default_carddav_addressbook");
    expect(sql).toContain("references actors(org_id, id)");
    expect(sql).toContain("carddav_contacts_book_sync_idx");
    expect(sql).toContain("gin_trgm_ops");
    expect(sql).toContain("helix_purge_carddav_contacts");
    expect(sql).toContain("not legal_hold");
    expect(sql).toContain("retain_until is null or retain_until <= statement_timestamp()");
    expect(sql).toContain("contact_hold_or_retention");
    expect(sql).toContain("carddav.retention.purged");
    expect(sql).toContain("alter table carddav_contacts no force row level security");
    expect(sql).toContain("alter table carddav_contacts force row level security");
    expect(sql).toContain("force row level security");
  });
});
