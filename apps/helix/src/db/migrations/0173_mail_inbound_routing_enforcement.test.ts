import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0173_mail_inbound_routing_enforcement.sql", import.meta.url),
  "utf8",
);

describe("0173 inbound routing enforcement", () => {
  it("keeps routing tenant-owned, validated, idempotent, and ingress-only", () => {
    expect(migration).toContain("helix_mail_pattern_is_local");
    expect(migration).toContain("domain.status = 'verified'");
    expect(migration).toContain("org.status = 'active'");
    expect(migration).toContain("mail forwarding cycle detected");
    expect(migration).toContain("external forwarding is blocked by policy");
    expect(migration).toContain("mail_outbound_idempotency_key_uidx");
    expect(migration).toContain("mail_journal_entries");
    expect(migration).toContain("helix_record_mail_journal");
    expect(migration).toContain("mail_journal_message_delete_guard");
    expect(migration).toContain("helix_governance_is_held");
    expect(migration).toContain("mail_journal_retention");
    expect(migration).toContain("contact_hold_or_retention");
    expect(migration).toContain(
      "revoke all on function helix_resolve_inbound_routing_rules(text, text) from public",
    );
    expect(migration).toContain(
      "grant execute on function helix_resolve_inbound_routing_rules(text, text) to helix_app",
    );
  });
});
