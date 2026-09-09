import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import type postgres from "postgres";
import {
  actorHasAdminScope,
  evaluateAdminMfa,
  PostgresSessionMfaAssurance,
  authResponseSessionToken,
  newRecoveryCode,
  recoveryCodeDigest,
  tierRequiresAdminMfa,
  unverifiedMfaResolver,
  verifiedMfaSessionToken,
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
  scopes: ["mail.read", "chat.post"],
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

describe("unverifiedMfaResolver", () => {
  it("does not trust a client-supplied MFA header", () => {
    expect(unverifiedMfaResolver.isMfaVerified(requestWithHeader("true"))).toBe(false);
    expect(unverifiedMfaResolver.isMfaVerified(requestWithHeader("TRUE"))).toBe(false);
    expect(unverifiedMfaResolver.isMfaVerified(requestWithHeader(undefined))).toBe(false);
  });
});

describe("server-side MFA assurance", () => {
  it("marks and accepts only a fresh session bound to the configured audience", async () => {
    const recording = createRecordingSql([[{ id: "session-1" }], [{ ok: 1 }]]);
    const assurance = new PostgresSessionMfaAssurance(
      recording.sql,
      {
        async getSessionUser() {
          return null;
        },
        async getSessionToken() {
          return "server-session-token";
        },
      },
      "https://helix.example.test",
      600,
    );
    const verifiedAt = new Date("2026-09-02T12:00:00.000Z");

    await expect(assurance.markVerifiedSession("server-session-token", verifiedAt)).resolves.toBe(
      true,
    );
    await expect(assurance.isMfaVerified(requestWithHeader("true"))).resolves.toBe(true);

    expect(recording.calls[0]?.text).toContain("mfa_verified_at");
    expect(recording.calls[0]?.text).toContain('u."twoFactorEnabled" = true');
    expect(recording.calls[1]?.text).toContain("s.mfa_audience");
    expect(recording.calls[1]?.text).not.toContain("actor_id");
    expect(recording.calls.flatMap((call) => call.values)).toContain("https://helix.example.test");
  });

  it("cannot elevate from a forged header without a verified server session", async () => {
    const recording = createRecordingSql([]);
    const assurance = new PostgresSessionMfaAssurance(
      recording.sql,
      {
        async getSessionUser() {
          return null;
        },
      },
      "https://helix.example.test",
    );

    await expect(assurance.isMfaVerified(requestWithHeader("true"))).resolves.toBe(false);
    expect(recording.calls).toHaveLength(0);
  });

  it("recognizes only successful passkey, TOTP, or recovery-code verification responses", () => {
    expect(
      verifiedMfaSessionToken(
        "/api/auth/passkey/verify-authentication",
        200,
        JSON.stringify({ session: { token: "passkey-session" } }),
        "helix_session=passkey-session.signature; Path=/; HttpOnly",
      ),
    ).toBe("passkey-session");
    expect(
      verifiedMfaSessionToken(
        "/api/auth/two-factor/verify-totp",
        200,
        JSON.stringify({ token: "replaced-session" }),
        "__Secure-helix_session=fresh-session.signature; Path=/; HttpOnly; Secure",
      ),
    ).toBe("fresh-session");
    expect(
      verifiedMfaSessionToken(
        "/api/auth/two-factor/verify-backup-code?next=/admin",
        200,
        JSON.stringify({ token: "recovery-session" }),
      ),
    ).toBe("recovery-session");
    expect(
      verifiedMfaSessionToken(
        "/api/auth/sign-in/email",
        200,
        JSON.stringify({ token: "password-only" }),
      ),
    ).toBeNull();
    expect(
      verifiedMfaSessionToken(
        "/api/auth/two-factor/verify-totp",
        401,
        JSON.stringify({ token: "failed-factor" }),
      ),
    ).toBeNull();
  });

  it("extracts newly rotated session tokens without treating password login as MFA", () => {
    expect(authResponseSessionToken(JSON.stringify({ session: { token: "nested" } }))).toBe(
      "nested",
    );
    expect(
      authResponseSessionToken(null, "helix_session=rotated.signature; Path=/; HttpOnly"),
    ).toBe("rotated");
  });
});

describe("recovery code material", () => {
  it("generates high-entropy display codes and stable one-way digests", () => {
    const first = newRecoveryCode();
    const second = newRecoveryCode();
    expect(first).toMatch(/^[0-9A-F]{5}(?:-[0-9A-F]{5}){3}$/u);
    expect(second).not.toBe(first);
    expect(recoveryCodeDigest(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(recoveryCodeDigest(` ${first} `)).toBe(recoveryCodeDigest(first));
    expect(recoveryCodeDigest(first)).not.toContain(first.replaceAll("-", ""));
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

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
