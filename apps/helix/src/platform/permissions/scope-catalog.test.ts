import { describe, expect, it } from "vitest";
import {
  ALL_SCOPES,
  SCOPE_CATALOG,
  agentCredentialScopeCatalog,
  appPasswordScopeCatalog,
  getScopeDefinition,
  isCompositeScope,
  isKnownScope,
  openApiScopeCatalog,
  scopesForSurface,
} from "./scope-catalog.js";

describe("canonical scope catalog", () => {
  it("has no duplicate scope tokens", () => {
    const seen = new Set<string>();
    for (const entry of SCOPE_CATALOG) {
      expect(seen.has(entry.scope), `duplicate scope: ${entry.scope}`).toBe(false);
      seen.add(entry.scope);
    }
    expect(ALL_SCOPES).toHaveLength(SCOPE_CATALOG.length);
  });

  it("is reconciled with PRD §9.4: no non-PRD chat.write, uses tools:read/tools:write", () => {
    expect(isKnownScope("chat.write")).toBe(false);
    expect(isKnownScope("chat.post")).toBe(true);
    expect(isKnownScope("chat.create")).toBe(true);
    expect(isKnownScope("tools:read")).toBe(true);
    expect(isKnownScope("tools:write")).toBe(true);
    expect(isKnownScope("tools")).toBe(false);
  });

  it("flags composite scopes that are never sufficient on their own", () => {
    expect(isCompositeScope("mail.external")).toBe(true);
    expect(isCompositeScope("calendar.external")).toBe(true);
    expect(isCompositeScope("mail.send")).toBe(false);
    expect(getScopeDefinition("mail.external")?.composite).toBe(true);
  });

  it("rejects unknown scopes", () => {
    expect(isKnownScope("not.a.scope")).toBe(false);
    expect(getScopeDefinition("not.a.scope")).toBeUndefined();
  });

  it("derives the agent credential catalog from the agent + platform + admin surfaces", () => {
    expect(agentCredentialScopeCatalog).toContain("mail.send");
    expect(agentCredentialScopeCatalog).toContain("mail.external");
    expect(agentCredentialScopeCatalog).toContain("admin.agents");
    expect(agentCredentialScopeCatalog).toContain("tools:write");
    // Legacy DAV protocol scopes are not issuable on agent OAuth credentials.
    expect(agentCredentialScopeCatalog).not.toContain("caldav");
    // No drift: every catalog entry is a known canonical scope.
    for (const scope of agentCredentialScopeCatalog) {
      expect(isKnownScope(scope)).toBe(true);
    }
  });

  it("derives the app-password catalog from the app_password surface", () => {
    expect(appPasswordScopeCatalog).toContain("caldav");
    expect(appPasswordScopeCatalog).toContain("imap");
    expect(appPasswordScopeCatalog).toContain("smtp");
    expect(appPasswordScopeCatalog).toContain("mail.send");
    // Composite/agent-only scopes are not issuable on app passwords.
    expect(appPasswordScopeCatalog).not.toContain("mail.external");
    expect(appPasswordScopeCatalog).not.toContain("chat.post");
    for (const scope of scopesForSurface("app_password")) {
      expect(isKnownScope(scope)).toBe(true);
    }
  });

  it("builds the OpenAPI scope map from the canonical catalog with canonical descriptions", () => {
    const map = openApiScopeCatalog(["mail.send", "platform.read"]);
    expect(map["mail.send"]).toBe("Send mail to internal recipients.");
    expect(map["mail.external"]).toBe(
      "Send mail to recipients outside the organization's domains.",
    );
    // A transitional tool permission not yet in the catalog still gets documented.
    const withUnknown = openApiScopeCatalog(["legacy.permission"]);
    expect(withUnknown["legacy.permission"]).toBe("Allows legacy.permission tool operations.");
  });
});
