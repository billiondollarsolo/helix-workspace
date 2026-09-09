import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("0123 staged mail attachments", () => {
  const sql = readFileSync(new URL("./0123_mail_attachment_ingestion.sql", import.meta.url), "utf8");

  it("models only staged, verified, scanned attachment promotion", () => {
    for (const state of [
      "pending_upload",
      "quarantined",
      "scanning",
      "clean",
      "attached",
      "rejected",
    ]) {
      expect(sql).toContain(`'${state}'`);
    }
    expect(sql).toContain("message_attachments_require_clean_stage");
    expect(sql).toContain("status = 'clean' and message_id is null");
    expect(sql).toContain("create or replace function helix_attach_clean_mail_object()");
  });

  it("retains due cleanup evidence behind forced tenant RLS", () => {
    expect(sql).toContain("mail_attachment_ingestions_cleanup_idx");
    expect(sql).toContain("helix_claim_mail_attachment_cleanup");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set row_security = off");
    expect(sql).toContain("cleanup requires an unscoped worker context");
    expect(sql).toContain("stage.status in ('clean', 'attached')");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("foreign key (org_id, object_id)");
  });
});
