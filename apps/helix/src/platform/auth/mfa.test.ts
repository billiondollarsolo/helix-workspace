import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import {
  actorHasAdminScope,
  createMfaAssertionVerificationResolver,
  evaluateAdminMfa,
  MFA_ASSERTION_HEADER,
  tierRequiresAdminMfa,
} from "./mfa.js";

const assertionSecret = "mfa-assertion-secret-with-at-least-32-bytes";
const assertionIssuer = "https://auth.example.test";
const assertionAudience = "helix-workspace";
const nowSeconds = 1_784_908_800;

const adminActor: Actor = {
  id: "admin-1",
  orgId: "org-1",
  type: "user",
  scopes: ["admin.users", "mail.read"],
};

const nonAdminActor: Actor = {
  id: "user-1",
  orgId: "org-1",
  type: "user",
  scopes: ["mail.read", "chat.write"],
};

function requestWithHeaders(
  headers: Record<string, string | string[] | undefined>,
): FastifyRequest {
  return {
    headers,
  } as unknown as FastifyRequest;
}

function signedAssertion(
  overrides: Partial<{
    v: number;
    iss: string;
    aud: string;
    sub: string;
    org: string;
    amr: string;
    iat: number;
    exp: number;
  }> = {},
  secret = assertionSecret,
): string {
  const claims = {
    v: 1,
    iss: assertionIssuer,
    aud: assertionAudience,
    sub: adminActor.id,
    org: adminActor.orgId,
    amr: "mfa",
    iat: nowSeconds - 10,
    exp: nowSeconds + 120,
    ...overrides,
  };
  return signClaims(claims, secret);
}

function signClaims(claims: unknown, secret = assertionSecret): string {
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedClaims).digest("base64url");
  return `${encodedClaims}.${signature}`;
}

function resolver() {
  return createMfaAssertionVerificationResolver({
    secret: assertionSecret,
    issuer: assertionIssuer,
    audience: assertionAudience,
    now: () => nowSeconds,
  });
}

describe("tierRequiresAdminMfa (P2-1)", () => {
  it("requires admin MFA on Tier 2+", () => {
    expect(tierRequiresAdminMfa("business")).toBe(true);
    expect(tierRequiresAdminMfa("enterprise")).toBe(true);
    expect(tierRequiresAdminMfa("sovereign")).toBe(true);
  });

  it("does not require admin MFA on Tier 1", () => {
    expect(tierRequiresAdminMfa("personal")).toBe(false);
  });
});

describe("actorHasAdminScope", () => {
  it("detects namespaced and wildcard admin scopes", () => {
    expect(actorHasAdminScope(adminActor)).toBe(true);
    expect(actorHasAdminScope({ ...adminActor, scopes: ["admin.*"] })).toBe(true);
  });

  it("returns false for non-admin actors", () => {
    expect(actorHasAdminScope(nonAdminActor)).toBe(false);
    const noScopes: Actor = { id: "u", orgId: "org-1", type: "user" };
    expect(actorHasAdminScope(noScopes)).toBe(false);
  });
});

describe("signed MFA assertion verification", () => {
  it("accepts a valid, short-lived assertion bound to the authenticated actor", () => {
    expect(
      resolver().isMfaVerified(
        requestWithHeaders({ [MFA_ASSERTION_HEADER]: signedAssertion() }),
        adminActor,
      ),
    ).toBe(true);
  });

  it("never trusts the legacy client-controlled verification header", () => {
    expect(
      resolver().isMfaVerified(requestWithHeaders({ "x-helix-mfa-verified": "true" }), adminActor),
    ).toBe(false);
  });

  it.each([
    ["actor", { sub: "other-admin" }],
    ["organization", { org: "other-org" }],
    ["authentication method", { amr: "pwd" }],
    ["contract version", { v: 2 }],
    ["issuer", { iss: "https://attacker.example" }],
    ["audience", { aud: "other-service" }],
  ])("rejects an assertion with the wrong %s binding", (_label, overrides) => {
    expect(
      resolver().isMfaVerified(
        requestWithHeaders({ [MFA_ASSERTION_HEADER]: signedAssertion(overrides) }),
        adminActor,
      ),
    ).toBe(false);
  });

  it("rejects tampering without comparing signatures as ordinary strings", () => {
    const assertion = signedAssertion();
    const tampered = `${assertion.slice(0, -1)}${assertion.endsWith("A") ? "B" : "A"}`;
    expect(
      resolver().isMfaVerified(
        requestWithHeaders({ [MFA_ASSERTION_HEADER]: tampered }),
        adminActor,
      ),
    ).toBe(false);
  });

  it("rejects an assertion signed with a different key", () => {
    expect(
      resolver().isMfaVerified(
        requestWithHeaders({
          [MFA_ASSERTION_HEADER]: signedAssertion(
            {},
            "different-mfa-assertion-secret-with-at-least-32-bytes",
          ),
        }),
        adminActor,
      ),
    ).toBe(false);
  });

  it("rejects signed but non-canonical claim shapes", () => {
    expect(
      resolver().isMfaVerified(
        requestWithHeaders({
          [MFA_ASSERTION_HEADER]: signClaims({
            v: 1,
            iss: assertionIssuer,
            aud: assertionAudience,
            sub: adminActor.id,
            org: adminActor.orgId,
            amr: "mfa",
            iat: nowSeconds - 10,
            exp: nowSeconds + 60,
            unexpected: true,
          }),
        }),
        adminActor,
      ),
    ).toBe(false);
    expect(
      resolver().isMfaVerified(
        requestWithHeaders({ [MFA_ASSERTION_HEADER]: signClaims(["mfa"]) }),
        adminActor,
      ),
    ).toBe(false);
  });

  it.each([
    ["expired", { iat: nowSeconds - 120, exp: nowSeconds }],
    ["issued in the future", { iat: nowSeconds + 1, exp: nowSeconds + 60 }],
    ["non-positive lifetime", { iat: nowSeconds - 10, exp: nowSeconds - 10 }],
    ["overlong lifetime", { iat: nowSeconds - 10, exp: nowSeconds + 291 }],
  ])("rejects an %s assertion", (_label, overrides) => {
    expect(
      resolver().isMfaVerified(
        requestWithHeaders({ [MFA_ASSERTION_HEADER]: signedAssertion(overrides) }),
        adminActor,
      ),
    ).toBe(false);
  });

  it.each([undefined, "", "not-an-assertion", "abc.def.extra", "!!!!.!!!!", ["one", "two"]])(
    "rejects absent, malformed, or repeated assertions",
    (value) => {
      expect(
        resolver().isMfaVerified(
          requestWithHeaders(value === undefined ? {} : { [MFA_ASSERTION_HEADER]: value }),
          adminActor,
        ),
      ).toBe(false);
    },
  );

  it("fails closed without a configured verifier and rejects partial or weak configuration", () => {
    expect(
      createMfaAssertionVerificationResolver({}).isMfaVerified(
        requestWithHeaders({ [MFA_ASSERTION_HEADER]: signedAssertion() }),
        adminActor,
      ),
    ).toBe(false);
    expect(() =>
      createMfaAssertionVerificationResolver({
        secret: "short",
        issuer: assertionIssuer,
        audience: assertionAudience,
      }),
    ).toThrow(/at least 32 bytes/u);
    expect(() =>
      createMfaAssertionVerificationResolver({
        secret: assertionSecret,
        issuer: assertionIssuer,
      }),
    ).toThrow(/configured together/u);
  });
});

describe("evaluateAdminMfa", () => {
  it("rejects an admin actor without a verified factor on Tier 2+", () => {
    const decision = evaluateAdminMfa({
      tier: "enterprise",
      actor: adminActor,
      mfaVerified: false,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.statusCode).toBe(403);
      expect(decision.code).toBe("admin_mfa_required");
    }
  });

  it("allows an admin actor with a verified factor on Tier 2+", () => {
    expect(
      evaluateAdminMfa({ tier: "enterprise", actor: adminActor, mfaVerified: true }).allowed,
    ).toBe(true);
  });

  it("allows non-admin actors regardless of MFA", () => {
    expect(
      evaluateAdminMfa({ tier: "enterprise", actor: nonAdminActor, mfaVerified: false }).allowed,
    ).toBe(true);
  });

  it("allows admin actors without MFA on Tier 1", () => {
    expect(
      evaluateAdminMfa({ tier: "personal", actor: adminActor, mfaVerified: false }).allowed,
    ).toBe(true);
  });
});
