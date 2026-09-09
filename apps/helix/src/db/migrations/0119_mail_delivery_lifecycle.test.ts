import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("0119 mail delivery lifecycle", () => {
  const sql = readFileSync(new URL("./0119_mail_delivery_lifecycle.sql", import.meta.url), "utf8");
  const store = readFileSync(
    new URL("../../platform/mail/delivery-events.ts", import.meta.url),
    "utf8",
  );

  it("replaces ambiguous sent state and persists deduplicated feedback", () => {
    expect(sql).toContain("when status::text = 'sent' then 'accepted'");
    expect(sql).toContain("'delivered'");
    expect(sql).toContain("'deferred'");
    expect(sql).toContain("'bounced'");
    expect(sql).toContain("'complained'");
    expect(sql).toContain("unique (org_id, provider_id, provider_event_id)");
  });

  it("enforces permanent-feedback suppression and tenant isolation", () => {
    expect(sql).toContain("mail_suppressions_active_address_uidx");
    expect(sql).toContain("mail_delivery_events_retry_class_check");
    expect(store).toContain("when ${input.kind}::text = 'complained'");
    expect(store).toContain('input.kind === "bounced" || input.kind === "complained"');
    expect(store).toContain("on conflict (org_id, provider_id, provider_event_id) do nothing");
    expect(store).toContain("outbound.delivery_metadata->>'providerId' = provider.id::text");
    expect(sql.match(/enable row level security/gu)).toHaveLength(2);
    expect(sql.match(/force row level security/gu)).toHaveLength(2);
  });
});
