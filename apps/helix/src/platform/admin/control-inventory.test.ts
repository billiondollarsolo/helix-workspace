import { describe, expect, it } from "vitest";
import {
  ADMIN_CONTROL_INVENTORY,
  adminControlById,
  adminControlsBySurface,
} from "./control-inventory.js";
import { SECURITY_POLICY_TYPES } from "./security-policies.js";

describe("ADMIN_CONTROL_INVENTORY (ADM.1)", () => {
  it("includes every security policy type as its own control", () => {
    for (const policyType of SECURITY_POLICY_TYPES) {
      expect(adminControlById(`security_policy.${policyType}`)).toBeDefined();
    }
  });

  it("covers identity SCIM, SSO/IdP, app passwords, and audit", () => {
    expect(adminControlById("identity.scim")?.mode).toBe("partial");
    expect(adminControlById("identity.idp_configs")?.mode).toBe("partial");
    expect(adminControlById("auth.app_passwords")?.mode).toBe("enforced");
    expect(adminControlById("audit.log")?.mode).toBe("enforced");
  });

  it("never marks recorded-only security policies as fully enforced", () => {
    for (const entry of adminControlsBySurface("security_policies")) {
      if (entry.id.endsWith(".sso") || entry.id.endsWith(".dlp") || entry.id.endsWith(".device_trust")) {
        expect(entry.mode).toBe("recorded_only");
      }
    }
  });

  it("requires every entry to name at least one real path", () => {
    for (const entry of ADMIN_CONTROL_INVENTORY) {
      expect(entry.paths.length).toBeGreaterThan(0);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.notes.length).toBeGreaterThan(0);
    }
  });

  it("uses unique control ids", () => {
    const ids = ADMIN_CONTROL_INVENTORY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
