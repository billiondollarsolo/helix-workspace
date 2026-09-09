import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const rulesUrl = new URL("./helix-agent-safety.yml", import.meta.url);

describe("agent safety Prometheus rules", () => {
  it("covers operational denials, approvals, cost, external sends, injection, and audit integrity", async () => {
    const rules = await readFile(rulesUrl, "utf8");

    for (const alert of [
      "HelixAgentOperationalControlDenialSpike",
      "HelixPendingApprovalVolumeHigh",
      "HelixAgentCostSpike",
      "HelixExternalSendSpike",
      "HelixPromptInjectionPolicyDenials",
      "HelixAuditIntegrityFailure",
    ]) {
      expect(rules).toContain(`alert: ${alert}`);
    }
    expect(rules).toContain("helix_agent_operational_control_denials_total");
    expect(rules).toContain("pending_confirmation");
    expect(rules).toContain("helix_llm_cost_usd_micros_total");
    expect(rules).toContain('tool_id=~"mail.send|mail.reply"');
    expect(rules).toContain('reason="untrusted_context_high_risk_blocked"');
    expect(rules).toContain("helix_audit_hash_chain_failures_total");
  });
});
