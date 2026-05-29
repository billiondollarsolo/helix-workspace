import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  hashSignupEmailVerificationToken,
  PostgresSignupEmailVerificationTokenStore,
  PostgresSignupOwnerEmailLookup,
  PostgresSignupVerifiedIdentityStore,
} from "./verification.js";
import {
  hashSignupOnboardingInviteToken,
  PostgresSignupOnboardingInviteTokenStore,
} from "./invites.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-05-24T00:00:00.000Z");
const expiresAt = new Date("2026-05-25T00:00:00.000Z");

describe("PostgresSignupEmailVerificationTokenStore", () => {
  it("issues a one-day token while storing only token and password hashes", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupEmailVerificationTokenStore(recording.sql);

    const issued = await store.issue({
      orgId,
      email: " Owner@Example.COM ",
      password: "correct-horse-battery-staple",
      metadata: { source: "signup" },
      now,
    });

    expect(issued).toMatchObject({
      orgId,
      email: "owner@example.com",
      expiresAt,
      consumedAt: null,
      metadata: { source: "signup" },
    });
    expect(issued.passwordHash).not.toBe("correct-horse-battery-staple");
    expect(issued.token).toMatch(/^helix_signup_/u);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("insert into signup_email_verifications");
    expect(recording.calls[0]?.text).toContain("on conflict (org_id) do update");
    expect(recording.calls[0]?.values).toContain(orgId);
    expect(recording.calls[0]?.values).toContain("owner@example.com");
    expect(recording.calls[0]?.values).toContain(hashSignupEmailVerificationToken(issued.token));
    expect(recording.calls[0]?.values).not.toContain(issued.token);
    expect(recording.calls[0]?.values).not.toContain("correct-horse-battery-staple");
  });

  it("looks up and consumes valid signup email verification tokens by hash", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupEmailVerificationTokenStore(recording.sql);

    await expect(store.findValid({ token: "raw-token", now })).resolves.toMatchObject({
      orgId,
      email: "owner@example.com",
      passwordHash: "stored-password-hash",
      expiresAt,
    });
    await expect(store.consume({ token: "raw-token", now })).resolves.toMatchObject({
      orgId,
      email: "owner@example.com",
      passwordHash: "stored-password-hash",
      expiresAt,
    });

    expect(recording.calls[0]?.text).toContain("from signup_email_verifications");
    expect(recording.calls[0]?.values).toContain(hashSignupEmailVerificationToken("raw-token"));
    expect(recording.calls[1]?.text).toContain("update signup_email_verifications");
    expect(recording.calls[1]?.text).toContain("consumed_at = ?");
  });

  it("reissues a verification token from an unconsumed stale token without exposing raw tokens", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupEmailVerificationTokenStore(recording.sql);

    const result = await store.reissueFromToken({ token: "old-token", now });

    expect(result).toMatchObject({
      status: "issued",
      verification: {
        orgId,
        email: "owner@example.com",
        passwordHash: "stored-password-hash",
        expiresAt,
      },
    });
    if (result.status !== "issued") {
      throw new Error("Expected reissued verification token.");
    }
    expect(result.verification.token).toMatch(/^helix_signup_/u);
    expect(result.verification.token).not.toBe("old-token");
    expect(recording.calls[0]?.text).toContain("from signup_email_verifications");
    expect(recording.calls[0]?.values).toContain(hashSignupEmailVerificationToken("old-token"));
    expect(recording.calls[1]?.text).toContain("update signup_email_verifications");
    expect(recording.calls[1]?.values).toContain(
      hashSignupEmailVerificationToken(result.verification.token),
    );
    expect(recording.calls.flatMap((call) => [...call.values])).not.toContain("old-token");
    expect(recording.calls.flatMap((call) => [...call.values])).not.toContain(
      result.verification.token,
    );
  });
});

describe("PostgresSignupVerifiedIdentityStore", () => {
  it("creates a verified Better Auth credential user linked to the owner actor", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupVerifiedIdentityStore(recording.sql);

    const identity = await store.createVerifiedCredentialUser({
      orgId,
      email: "Owner@Example.COM",
      passwordHash: "stored-password-hash",
    });

    expect(identity).toEqual({
      actorId,
      betterAuthUserId: `signup-${actorId}`,
    });
    expect(recording.calls.map((call) => call.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("from actors"),
        expect.stringContaining('from "user"'),
        expect.stringContaining('insert into "user"'),
        expect.stringContaining("insert into account"),
        expect.stringContaining("update actors"),
      ]),
    );
    expect(recording.calls.flatMap((call) => [...call.values])).toContain("stored-password-hash");
  });
});

describe("PostgresSignupOwnerEmailLookup", () => {
  it("checks pending and active tenant-owner emails without exposing unrelated users", async () => {
    const recording = createOwnerLookupRecordingSql();
    const store = new PostgresSignupOwnerEmailLookup(recording.sql);

    await expect(store.findOwnerByEmail(" Owner@Example.COM ")).resolves.toEqual({
      orgId,
      email: "owner@example.com",
    });

    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("from tenant_provisioning_state");
    expect(recording.calls[0]?.text).toContain("from actors");
    expect(recording.calls[0]?.text).toContain("tenantProvisioning");
    expect(recording.calls[0]?.values).toContain("owner@example.com");
  });
});

describe("PostgresSignupOnboardingInviteTokenStore", () => {
  it("issues hashed one-week invite tokens", async () => {
    const recording = createRecordingSql();
    const store = new PostgresSignupOnboardingInviteTokenStore(recording.sql);

    const invite = await store.issue({
      orgId,
      invitedByActorId: actorId,
      email: " Ada@Example.COM ",
      metadata: { source: "signup" },
      now,
    });

    expect(invite).toMatchObject({
      orgId,
      invitedByActorId: actorId,
      email: "ada@example.com",
      expiresAt: new Date("2026-05-31T00:00:00.000Z"),
      acceptedAt: null,
      acceptedByActorId: null,
      metadata: { source: "signup" },
    });
    expect(invite.token).toMatch(/^helix_invite_/u);
    expect(recording.calls[0]?.text).toContain("insert into signup_onboarding_invites");
    expect(recording.calls[0]?.values).toContain("ada@example.com");
    expect(recording.calls[0]?.values).toContain(hashSignupOnboardingInviteToken(invite.token));
    expect(recording.calls[0]?.values).not.toContain(invite.token);
  });

  it("accepts a matching actor and records the accepted actor id", async () => {
    const recording = createInviteAcceptanceRecordingSql();
    const store = new PostgresSignupOnboardingInviteTokenStore(recording.sql);

    await expect(
      store.accept({
        token: "raw-invite-token",
        actor: { id: actorId, orgId, email: "Ada@Example.com" },
        now,
      }),
    ).resolves.toMatchObject({
      status: "accepted",
      invite: {
        orgId,
        email: "ada@example.com",
        acceptedByActorId: actorId,
      },
    });

    expect(recording.calls[0]?.text).toContain("from signup_onboarding_invites");
    expect(recording.calls[0]?.values).toContain(
      hashSignupOnboardingInviteToken("raw-invite-token"),
    );
    expect(recording.calls[1]?.text).toContain("update signup_onboarding_invites");
    expect(recording.calls[1]?.values).toContain(actorId);
    expect(recording.calls[2]?.text).toContain("insert into permissions");
    expect(recording.calls.flatMap((call) => [...call.values])).not.toContain("raw-invite-token");
  });

  it("rejects invite acceptance when the signed-in actor email differs", async () => {
    const recording = createInviteAcceptanceRecordingSql();
    const store = new PostgresSignupOnboardingInviteTokenStore(recording.sql);

    await expect(
      store.accept({
        token: "raw-invite-token",
        actor: { id: actorId, orgId, email: "wrong@example.com" },
        now,
      }),
    ).resolves.toEqual({ status: "email_mismatch" });

    expect(recording.calls).toHaveLength(1);
  });
});

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (text.includes("from actors")) {
      return Promise.resolve([{ id: actorId, display_name: "Owner Example" }]);
    }
    if (text.includes('from "user"')) {
      return Promise.resolve([]);
    }
    if (text.includes("signup_onboarding_invites")) {
      return Promise.resolve([
        {
          org_id: orgId,
          invited_by_actor_id: actorId,
          email: "ada@example.com",
          expires_at: new Date("2026-05-31T00:00:00.000Z"),
          accepted_at: null,
          accepted_by_actor_id: null,
          metadata: { source: "signup" },
        },
      ]);
    }
    return Promise.resolve([
      {
        org_id: orgId,
        email: "owner@example.com",
        password_hash: "stored-password-hash",
        expires_at: expiresAt,
        consumed_at: null,
        metadata: { source: "signup" },
      },
    ]);
  };
  return {
    sql: Object.assign(tag, {
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
}

function createInviteAcceptanceRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    if (text.includes("insert into permissions")) {
      return Promise.resolve([]);
    }
    return Promise.resolve([
      {
        org_id: orgId,
        invited_by_actor_id: actorId,
        email: "ada@example.com",
        expires_at: new Date("2026-05-31T00:00:00.000Z"),
        accepted_at: text.includes("update") ? now : null,
        accepted_by_actor_id: text.includes("update") ? actorId : null,
        metadata: { source: "signup" },
      },
    ]);
  };
  return {
    sql: Object.assign(tag, {
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
}

function createOwnerLookupRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    calls.push({ text, values });
    return Promise.resolve([{ org_id: orgId, email: "owner@example.com" }]);
  };
  return {
    sql: Object.assign(tag, {
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
}
