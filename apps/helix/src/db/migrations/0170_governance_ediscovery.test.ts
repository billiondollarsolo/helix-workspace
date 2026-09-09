import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0170_governance_ediscovery.sql", import.meta.url),
  "utf8",
);

describe("0170 governance and eDiscovery", () => {
  it("uses one held/retained item model across every governed product and purge path", () => {
    for (const product of ["mail", "chat", "drive", "calendar", "comment", "recording"]) {
      expect(migration).toContain(`'${product}'`);
    }
    for (const trigger of [
      "messages_governance_purge_guard",
      "mail_deliveries_governance_purge_guard",
      "message_attachments_governance_purge_guard",
      "mail_raw_sources_governance_purge_guard",
      "mail_attachment_ingestions_governance_purge_guard",
      "objects_governance_purge_guard",
      "drive_versions_governance_purge_guard",
      "drive_folders_governance_purge_guard",
      "drive_comments_governance_purge_guard",
      "cal_events_governance_purge_guard",
    ]) {
      expect(migration).toContain(trigger);
    }
    expect(migration).toContain("max(input_created_at + make_interval");
    expect(migration).toContain("helix_governance_is_held");
    expect(migration).toContain("governance_hold_resources");
    expect(migration).toContain("helix_governance_capture_product_resource");
    expect(migration).toContain("Drive version content is immutable");
    expect(migration).toContain("helix_tenant_deletion_blockers");
  });

  it("provides scoped review/search and a fork-proof immutable custody chain", () => {
    expect(migration).toContain("governance_matter_custodians");
    expect(migration).toContain("governance_review_items");
    expect(migration).toContain("review item is not in the matter evidence set");
    expect(migration).toContain("helix_governance_search");
    expect(migration).toContain("governance_exports_chain_idx");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("previousManifestSha256");
    expect(migration).toContain("eDiscovery exports are immutable");
    expect(migration).toContain("force row level security");
  });
});
