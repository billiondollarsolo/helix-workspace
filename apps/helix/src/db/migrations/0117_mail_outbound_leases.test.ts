import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("0117 mail outbound leases", () => {
  const sql = readFileSync(new URL("./0117_mail_outbound_leases.sql", import.meta.url), "utf8");
  const store = readFileSync(new URL("../../platform/mail/store.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../../platform/mail/outbound.ts", import.meta.url), "utf8");

  it("adds stable handoff identity, leases, and only durable due indexes", () => {
    expect(sql).toContain("handoff_key uuid not null");
    expect(sql).toContain("lease_token uuid");
    expect(sql).toContain("mail_outbound_due_idx");
    expect(sql).toContain("where status = 'sending'");
    expect(sql).toContain("next_attempt_at = undo_until");
  });

  it("claims one due/stale row atomically and fences every completion", () => {
    expect(store).toContain("for update skip locked");
    expect(store).toContain("status = 'sending' and lease_expires_at <=");
    expect(store.match(/status = 'sending' and lease_token =/gu)).toHaveLength(3);
  });

  it("has one timestamp-driven scheduler and no broker or inline sleep path", () => {
    expect(worker).not.toContain("events.subscribe");
    expect(worker).not.toContain("dispatchOutboxPayload");
    expect(worker).not.toContain("await this.sleep");
    expect(worker).toContain("claimDueOutbound");
  });
});
