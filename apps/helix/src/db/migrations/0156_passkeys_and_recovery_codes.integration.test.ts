import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresRecoveryCodeBroker, recoveryCodeDigest } from "../../platform/auth/mfa.js";
import { createBetterAuthRuntime } from "../../platform/auth/better-auth.js";
import { PostgresAdminUsersStore } from "../../platform/auth/admin-users.js";

describe.skipIf(process.env.DATABASE_URL === undefined)("Postgres passkey and recovery invariants", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const userId = "iam12-user";
  const secret = "iam12-test-secret-with-at-least-thirty-two-characters";
  const broker = new PostgresRecoveryCodeBroker(sql, secret);
  const orgId = "f1560000-0000-4000-8000-000000000001";
  const actorId = "f1560000-0000-4000-8000-000000000011";
  const adminActorId = "f1560000-0000-4000-8000-000000000012";
  let subjectId = "";

  beforeAll(async () => {
    await sql`insert into "user" (id, name, email, "emailVerified")
      values (${userId}, 'IAM 12', 'iam12@example.test', true)`;
    await sql`insert into orgs (id, slug, display_name) values (${orgId}, 'iam12-test', 'IAM 12')`;
    await sql`insert into actors (id, org_id, type, email, display_name)
      values (${actorId}, ${orgId}, 'user', 'iam12@example.test', 'IAM 12')`;
    await sql`insert into actors (id, org_id, type, display_name)
      values (${adminActorId}, ${orgId}, 'system', 'IAM 12 administrator')`;
    const subjects = await sql<{ readonly id: string }[]>`
      select id from identity_subjects where canonical_email = 'iam12@example.test'
    `;
    subjectId = subjects[0]?.id ?? "";
    await sql`insert into identity_provider_subjects (provider, provider_subject, subject_id)
      values ('better-auth', ${userId}, ${subjectId})`;
  });

  afterAll(async () => {
    await sql`delete from activity where org_id = ${orgId}`;
    await sql`delete from organization_memberships where subject_id = ${subjectId}`;
    await sql`delete from identity_provider_subjects where subject_id = ${subjectId}`;
    await sql`delete from actors where id in (${actorId}, ${adminActorId})`;
    await sql`delete from identity_subjects where id = ${subjectId}`;
    await sql`delete from orgs where id = ${orgId}`;
    await sql`delete from "user" where id = ${userId}`;
    await sql.end();
  });

  it("stores only digests and consumes a recovery code exactly once", async () => {
    const codes = await broker.replace(userId, ["bridge-one", "bridge-two"]);
    const rows = await sql<{
      readonly code_digest: string;
      readonly bridge_ciphertext: string;
    }[]>`select code_digest, bridge_ciphertext from auth_recovery_codes where auth_user_id = ${userId}`;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.code_digest)).toContain(recoveryCodeDigest(codes[0] ?? ""));
    expect(rows.every((row) => row.bridge_ciphertext.startsWith("$ba$1$"))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(codes[0]);

    await expect(broker.consume(codes[0] ?? "")).resolves.toBe("bridge-one");
    await expect(broker.consume(codes[0] ?? "")).resolves.toBeNull();
  });

  it("rejects duplicate credentials and a cloned single-device counter", async () => {
    await sql`insert into passkey (
      id, name, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp"
    ) values ('iam12-key', 'Security key', 'public-key', ${userId}, 'credential-iam12', 1, 'singleDevice', false)`;
    await sql`update passkey set counter = 2 where id = 'iam12-key'`;
    await expect(sql`update passkey set counter = 2 where id = 'iam12-key'`).rejects.toMatchObject({
      code: "23514",
    });
    await expect(sql`insert into passkey (
      id, "publicKey", "userId", "credentialID", counter, "deviceType", "backedUp"
    ) values ('iam12-clone', 'other-key', ${userId}, 'credential-iam12', 0, 'multiDevice', true)`).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("invalidates sibling sessions after factor enrollment or revocation", async () => {
    await sql`insert into "session" (id, "userId", token, "expiresAt") values
      ('iam12-keep', ${userId}, 'iam12-keep-token', now() + interval '1 hour'),
      ('iam12-revoke', ${userId}, 'iam12-revoke-token', now() + interval '1 hour')`;
    await broker.invalidateOtherSessions(userId, "iam12-keep-token");
    const sessions = await sql<{ readonly token: string }[]>`
      select token from "session" where "userId" = ${userId}
    `;
    expect(sessions.map((row) => row.token)).toEqual(["iam12-keep-token"]);
    await sql`delete from "session" where "userId" = ${userId}`;
  });

  it("consumes password reset tokens once and revokes every active session", async () => {
    let resetToken: string | null = null;
    const runtime = createBetterAuthRuntime({
      databaseUrl: process.env.DATABASE_URL ?? "",
      secret,
      baseUrl: "https://auth.helix.test",
      secureCookies: true,
      sendPasswordReset: async (input) => { resetToken = input.token; },
    });
    try {
      await sql`insert into "session" (id, "userId", token, "expiresAt")
        values ('iam12-session', ${userId}, 'iam12-active-token', now() + interval '1 hour')`;
      const requested = await runtime.auth.handler(new Request(
        "https://auth.helix.test/api/auth/request-password-reset",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://auth.helix.test" },
          body: JSON.stringify({ email: "iam12@example.test", redirectTo: "https://auth.helix.test/login" }),
        },
      ));
      expect(requested.status).toBe(200);
      expect(resetToken).not.toBeNull();

      const reset = () => runtime.auth.handler(new Request(
        "https://auth.helix.test/api/auth/reset-password",
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://auth.helix.test" },
          body: JSON.stringify({ token: resetToken, newPassword: "New-iam12-password-2026!" }),
        },
      ));
      expect((await reset()).status).toBe(200);
      expect((await reset()).status).toBe(400);
      const sessions = await sql`select 1 from "session" where "userId" = ${userId}`;
      expect(sessions).toHaveLength(0);
    } finally {
      await runtime.pool.end();
    }
  });

  it("atomically revokes every factor and session during an administrator reset", async () => {
    await broker.replace(userId, ["reset-bridge"]);
    await sql`insert into "session" (id, "userId", token, "expiresAt")
      values ('iam12-admin-reset', ${userId}, 'iam12-admin-reset-token', now() + interval '1 hour')`;
    await sql`update "user" set "twoFactorEnabled" = true where id = ${userId}`;

    await expect(new PostgresAdminUsersStore(sql).resetMfa({
      orgId,
      targetActorId: actorId,
      performedByActorId: adminActorId,
    })).resolves.toBe(true);
    const state = await sql<{
      readonly passkeys: number;
      readonly recovery_codes: number;
      readonly sessions: number;
      readonly two_factor_enabled: boolean;
    }[]>`
      select
        (select count(*)::int from passkey where "userId" = ${userId}) as passkeys,
        (select count(*)::int from auth_recovery_codes where auth_user_id = ${userId}) as recovery_codes,
        (select count(*)::int from "session" where "userId" = ${userId}) as sessions,
        "twoFactorEnabled" as two_factor_enabled
      from "user" where id = ${userId}
    `;
    expect(state[0]).toEqual({
      passkeys: 0,
      recovery_codes: 0,
      sessions: 0,
      two_factor_enabled: false,
    });
    const evidence = await sql<{ readonly verb: string; readonly this_hash: string }[]>`
      select verb, this_hash from activity where org_id = ${orgId} and actor_id = ${adminActorId}
    `;
    expect(evidence).toEqual([
      expect.objectContaining({ verb: "identity.mfa.reset", this_hash: expect.stringMatching(/^[a-f0-9]{64}$/u) }),
    ]);
  });
});
