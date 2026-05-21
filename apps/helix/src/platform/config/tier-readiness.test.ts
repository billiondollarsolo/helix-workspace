import { describe, expect, it } from "vitest";
import { evaluateTierReadiness } from "./tier-readiness.js";

describe("evaluateTierReadiness (P2-1)", () => {
  it("never blocks Tier 1 and imposes no controls", () => {
    const result = evaluateTierReadiness("personal", {});
    expect(result.ok).toBe(true);
    expect(result.controls).toHaveLength(0);
    expect(result.failures).toHaveLength(0);
  });

  it("fails closed on Tier 2 when audit shipping is unconfigured", () => {
    const result = evaluateTierReadiness("business", {});
    expect(result.ok).toBe(false);
    expect(result.failures.map((failure) => failure.control)).toContain("audit-shipping");
  });

  it("passes Tier 2 when an audit shipping destination is configured", () => {
    const result = evaluateTierReadiness("business", {
      AUDIT_IMMUTABLE_S3_ENABLED: "true",
    });
    expect(result.ok).toBe(true);
    const shipping = result.controls.find((control) => control.control === "audit-shipping");
    expect(shipping?.status).toBe("satisfied");
  });

  it("requires Vault and SIEM on Tier 3 and fails closed without them", () => {
    const result = evaluateTierReadiness("enterprise", {
      AUDIT_IMMUTABLE_S3_ENABLED: "true",
    });
    expect(result.ok).toBe(false);
    const failedControls = result.failures.map((failure) => failure.control);
    expect(failedControls).toContain("secrets-vault");
    expect(failedControls).toContain("audit-siem");
  });

  it("passes Tier 3 when Vault and SIEM are configured", () => {
    const result = evaluateTierReadiness("enterprise", {
      AUDIT_SIEM_SYSLOG_ENABLED: "true",
      VAULT_ADDR: "https://vault.internal:8200",
    });
    expect(result.ok).toBe(true);
  });

  it("surfaces in-app-unverifiable controls as warnings, not failures", () => {
    const result = evaluateTierReadiness("enterprise", {
      AUDIT_SIEM_SYSLOG_ENABLED: "true",
      VAULT_ADDR: "https://vault.internal:8200",
    });
    const warningControls = result.warnings.map((warning) => warning.control);
    expect(warningControls).toContain("internal-mtls");
    expect(warningControls).toContain("encryption-at-rest");
    for (const warning of result.warnings) {
      expect(warning.status).toBe("unverifiable");
    }
  });
});
