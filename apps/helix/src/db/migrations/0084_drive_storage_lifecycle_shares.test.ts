import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("./0084_drive_storage_lifecycle_shares.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0084_drive_storage_lifecycle_shares.sql", import.meta.url);

describe("0084 Drive storage lifecycle and shares", () => {
  it("hashes link tokens and adds bounded link-use controls", async () => {
    const sql = (await readFile(migrationUrl, "utf8")).toLowerCase();
    expect(sql).toContain("token_hash bytea");
    expect(sql).toContain("digest(token, 'sha256')");
    expect(sql).toContain("update drive_share_links set token = null");
    expect(sql).toContain("drop constraint if exists drive_share_links_token_key");
    expect(sql).not.toContain("drop index if exists drive_share_links_token_key");
    expect(sql).toContain("max_downloads");
    expect(sql).toContain("rate_limit_per_hour");
  });

  it("adds tenant lifecycle policy, legal hold, and guarded rollback", async () => {
    const migration = (await readFile(migrationUrl, "utf8")).toLowerCase();
    const rollback = (await readFile(rollbackUrl, "utf8")).toLowerCase();
    expect(migration).toContain("drive_lifecycle_policies");
    expect(migration).toContain("drive_legal_hold");
    expect(migration).toContain("trash_expires_at");
    expect(migration).toContain("using (org_id = helix_current_org_id())");
    expect(migration).toContain("with check (org_id = helix_current_org_id())");
    expect(migration).not.toContain("app.current_org_id");
    expect(rollback).toContain("raw drive share tokens were irreversibly removed");
  });
});
