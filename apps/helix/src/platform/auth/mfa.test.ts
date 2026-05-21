import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import {
  actorHasAdminScope,
  evaluateAdminMfa,
  headerMfaVerificationResolver,
  tierRequiresAdminMfa,
} from "./mfa.js";

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

function requestWithHeader(value: string | undefined): FastifyRequest {
  return {
    headers: value === undefined ? {} : { "x-helix-mfa-verified": value },
  } as unknown as FastifyRequest;
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

describe("headerMfaVerificationResolver", () => {
  it("reads the x-helix-mfa-verified header", () => {
    expect(headerMfaVerificationResolver.isMfaVerified(requestWithHeader("true"))).toBe(true);
    expect(headerMfaVerificationResolver.isMfaVerified(requestWithHeader("TRUE"))).toBe(true);
    expect(headerMfaVerificationResolver.isMfaVerified(requestWithHeader("false"))).toBe(false);
    expect(headerMfaVerificationResolver.isMfaVerified(requestWithHeader(undefined))).toBe(false);
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
