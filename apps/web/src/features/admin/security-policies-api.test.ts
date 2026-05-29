import { describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import { testSsoLogin } from "./security-policies-api";

describe("security policies api", () => {
  it("tests SSO login readiness without starting an SSO redirect", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        testLogin: {
          status: "runtime_pending",
          message: "Configuration saved. SAML/OIDC runtime is not connected yet.",
        },
      }),
    );

    const result = await testSsoLogin(fetchImpl);

    expect(result.status).toBe("runtime_pending");
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/security-policies/sso/test-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });
});
