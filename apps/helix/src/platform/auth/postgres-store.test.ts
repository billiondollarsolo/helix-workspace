import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import {
  PostgresAccessTokenStore,
  PostgresOAuthClientStore,
  hashAccessToken,
} from "./postgres-store.js";

const testIssuer = "https://helix.example.test";

describe("Postgres OAuth stores", () => {
  it("creates OAuth clients in agent_credentials for the requested actor and org", async () => {
    const expiresAt = new Date("2026-05-20T12:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "$argon2id$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: null,
          expires_at: expiresAt,
          revoked_at: null,
          revocation_epoch: 0,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);

    const client = await store.createClient({
      actorId: "actor-1",
      orgId: "org-1",
      clientId: "client-1",
      clientSecretHash: "$argon2id$hash",
      scopes: ["tools:read", "tools:read"],
      expiresAt,
    });

    expect(client).toEqual({
      clientId: "client-1",
      clientSecretHash: "$argon2id$hash",
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read"],
      redirectUris: [],
      expiresAt,
      revokedAt: null,
      revocationEpoch: 0,
      lastUsedAt: null,
    });
    expect(recording.calls[0]?.text).toContain("insert into agent_credentials");
    expect(recording.calls[0]?.text).toContain("where id =");
    expect(recording.calls[0]?.values).toContain("org-1");
  });

  it("persists the redirect_uris allowlist on createClient (CRITICAL-3)", async () => {
    const expiresAt = new Date("2026-05-20T12:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "$argon2id$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: ["https://app.example.com/callback"],
          expires_at: expiresAt,
          revoked_at: null,
          revocation_epoch: 0,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);

    const client = await store.createClient({
      actorId: "actor-1",
      orgId: "org-1",
      clientId: "client-1",
      clientSecretHash: "$argon2id$hash",
      scopes: ["tools:read"],
      redirectUris: ["https://app.example.com/callback"],
      expiresAt,
    });

    expect(client.redirectUris).toEqual(["https://app.example.com/callback"]);
    expect(recording.calls[0]?.text).toContain("redirect_uris");
  });

  it("hydrates redirect_uris on findClient (CRITICAL-3)", async () => {
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "$argon2id$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: ["https://app.example.com/cb"],
          expires_at: null,
          revoked_at: null,
          revocation_epoch: 0,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);
    const client = await store.findClient("client-1");
    expect(client?.redirectUris).toEqual(["https://app.example.com/cb"]);
    expect(recording.calls[0]?.text).toContain("c.redirect_uris");
    expect(recording.calls[0]?.text).toContain("helix_credential_principal_is_active");
  });

  it("replaces redirect_uris with setRedirectUris (CRITICAL-3)", async () => {
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "$argon2id$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: ["https://app.example.com/v2"],
          expires_at: null,
          revoked_at: null,
          revocation_epoch: 0,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);
    const client = await store.setRedirectUris(
      "client-1",
      ["https://app.example.com/v2"],
      new Date(),
    );
    expect(client?.redirectUris).toEqual(["https://app.example.com/v2"]);
    expect(recording.calls[0]?.text).toContain("update agent_credentials");
    expect(recording.calls[0]?.text).toContain("set redirect_uris");
  });

  it("reads active and revoked OAuth clients through actors for org ownership", async () => {
    const revokedAt = new Date("2026-05-20T13:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "$argon2id$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read", "tools:write"],
          redirect_uris: null,
          expires_at: null,
          revoked_at: revokedAt,
          revocation_epoch: 1,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);

    const client = await store.findClient("client-1");

    expect(client).toMatchObject({
      clientId: "client-1",
      actorId: "actor-1",
      orgId: "org-1",
      revokedAt,
      revocationEpoch: 1,
    });
    expect(recording.calls[0]?.text).toContain("join actors");
    expect(recording.calls[0]?.values).toContain("client-1");
  });

  it("lists OAuth clients by org with optional actor and revoked filters", async () => {
    const revokedAt = new Date("2026-05-20T13:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "$argon2id$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["mail.read"],
          redirect_uris: null,
          expires_at: null,
          revoked_at: revokedAt,
          revocation_epoch: 1,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);

    const clients = await store.listClients({
      orgId: "org-1",
      actorId: "actor-1",
      includeRevoked: true,
    });

    expect(clients).toEqual([
      {
        clientId: "client-1",
        clientSecretHash: "$argon2id$hash",
        actorId: "actor-1",
        orgId: "org-1",
        scopes: ["mail.read"],
        redirectUris: [],
        expiresAt: null,
        revokedAt,
        revocationEpoch: 1,
        lastUsedAt: null,
      },
    ]);
    expect(recording.calls[0]?.text).toContain("where a.org_id =");
    expect(recording.calls[0]?.text).toContain("c.credential_type = 'oauth_client'");
    expect(recording.calls[0]?.text).toContain("c.revoked_at is null");
    expect(recording.calls[0]?.values).toContain("org-1");
    expect(recording.calls[0]?.values).toContain("actor-1");
    expect(recording.calls[0]?.values).toContain(true);
  });

  it("persists access-token hashes and updates credential last_used_at", async () => {
    const issuedAt = new Date("2026-05-20T14:00:00.000Z");
    const expiresAt = new Date("2026-05-20T15:00:00.000Z");
    const recording = createRecordingSql([[{ client_id: "client-1" }], [], []]);
    const store = new PostgresAccessTokenStore(recording.sql, testIssuer);

    await store.saveToken({
      token: "helix_at_secret",
      clientId: "client-1",
      actorId: "actor-1",
      orgId: "org-1",
      issuer: testIssuer,
      scopes: ["tools:read", "tools:read"],
      clientEpoch: 0,
      refreshFamilyId: null,
      issuedAt,
      expiresAt,
    });

    expect(recording.calls[0]?.text).toContain("for share of c");
    expect(recording.calls[1]?.text).toContain("insert into oauth_access_tokens");
    expect(recording.calls[1]?.values).toContain(hashAccessToken("helix_at_secret", testIssuer));
    expect(recording.calls[1]?.values).not.toContain("helix_at_secret");
    expect(recording.calls[2]?.text).toContain("set last_used_at");
    expect(recording.calls[2]?.values).toContain(issuedAt);
  });

  it("rejects a token minted for a different issuer before touching the database", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresAccessTokenStore(recording.sql, testIssuer);

    await expect(
      store.saveToken({
        token: "helix_at_foreign",
        clientId: "client-1",
        actorId: "actor-1",
        orgId: "org-1",
        issuer: "https://foreign.example.test",
        scopes: [],
        clientEpoch: 0,
        refreshFamilyId: null,
        issuedAt: new Date("2026-05-20T14:00:00.000Z"),
        expiresAt: new Date("2026-05-20T15:00:00.000Z"),
      }),
    ).rejects.toThrow("issuer");
    expect(recording.calls).toHaveLength(0);
    expect(hashAccessToken("same-token", testIssuer)).not.toBe(
      hashAccessToken("same-token", "https://foreign.example.test"),
    );
  });

  it("hydrates unexpired stored access tokens by hashed lookup", async () => {
    const issuedAt = new Date("2026-05-20T14:00:00.000Z");
    const expiresAt = new Date("2026-05-20T15:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          issued_at: issuedAt,
          expires_at: expiresAt,
          client_epoch: 0,
          refresh_family_id: null,
        },
      ],
    ]);
    const store = new PostgresAccessTokenStore(recording.sql, testIssuer);

    const token = await store.findToken("helix_at_secret");

    expect(token).toEqual({
      token: "helix_at_secret",
      clientId: "client-1",
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read"],
      issuedAt,
      expiresAt,
    });
    expect(recording.calls[0]?.text).toContain("where t.token_hash =");
    expect(recording.calls[0]?.text.match(/helix_credential_principal_is_active/gu)).toHaveLength(
      2,
    );
    expect(recording.calls[0]?.values).toContain(hashAccessToken("helix_at_secret", testIssuer));
  });

  it("increments the client epoch when rotating its secret", async () => {
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "new-hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: [],
          expires_at: null,
          revoked_at: null,
          revocation_epoch: 4,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);

    const client = await store.rotateClientSecret("client-1", "new-hash", new Date());

    expect(client?.revocationEpoch).toBe(4);
    expect(recording.calls[0]?.text).toContain("revocation_epoch = revocation_epoch + 1");
  });

  it("binds access-token lookup to the issuing client and current epoch", async () => {
    const recording = createRecordingSql([[]]);
    const store = new PostgresAccessTokenStore(recording.sql, testIssuer);

    await expect(
      store.findAccessTokenForClient("helix_at_client_a", "client-b"),
    ).resolves.toBeNull();

    expect(recording.calls[0]?.text).toContain("t.client_id =");
    expect(recording.calls[0]?.text).toContain("t.client_epoch = c.revocation_epoch");
    expect(recording.calls[0]?.text).toContain("helix_credential_principal_is_active");
    expect(recording.calls[0]?.values).toContain("client-b");
  });

  it("persists an authorization-code access/refresh pair in one transaction", async () => {
    const issuedAt = new Date("2026-05-20T14:00:00.000Z");
    const accessExpiresAt = new Date("2026-05-20T15:00:00.000Z");
    const refreshExpiresAt = new Date("2026-06-20T14:00:00.000Z");
    const recording = createRecordingSql([[{ client_id: "client-1" }], [], [], []]);
    const store = new PostgresAccessTokenStore(recording.sql, testIssuer);

    await store.saveAuthorizationCodeTokens(
      {
        token: "helix_at_secret",
        clientId: "client-1",
        actorId: "actor-1",
        orgId: "org-1",
        issuer: testIssuer,
        scopes: ["mail.read"],
        clientEpoch: 2,
        refreshFamilyId: "10000000-0000-4000-8000-000000000001",
        issuedAt,
        expiresAt: accessExpiresAt,
      },
      {
        token: "helix_rt_secret",
        familyId: "10000000-0000-4000-8000-000000000001",
        clientId: "client-1",
        actorId: "actor-1",
        orgId: "org-1",
        issuer: testIssuer,
        scopes: ["mail.read"],
        clientEpoch: 2,
        issuedAt,
        expiresAt: refreshExpiresAt,
      },
    );

    expect(recording.calls.map((call) => call.text)).toEqual([
      expect.stringContaining("for share of c"),
      expect.stringContaining("insert into oauth_access_tokens"),
      expect.stringContaining("insert into oauth_refresh_tokens"),
      expect.stringContaining("set last_used_at"),
    ]);
    expect(recording.calls[2]?.values).toContain(hashAccessToken("helix_rt_secret", testIssuer));
    expect(recording.calls[2]?.values).not.toContain("helix_rt_secret");
  });

  it("rotates refresh tokens under a row lock and retains the family expiry", async () => {
    const issuedAt = new Date("2026-05-20T14:00:00.000Z");
    const familyExpiresAt = new Date("2026-06-20T14:00:00.000Z");
    const rotatedAt = new Date("2026-05-21T14:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          family_id: "10000000-0000-4000-8000-000000000001",
          client_id: "client-1",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["mail.read", "mail.write"],
          client_epoch: 2,
          issued_at: issuedAt,
          expires_at: familyExpiresAt,
          consumed_at: null,
          revoked_at: null,
          client_revocation_epoch: 2,
          client_revoked_at: null,
          client_expires_at: null,
          actor_disabled_at: null,
          client_actor_disabled_at: null,
        },
      ],
      [],
      [],
      [],
      [],
    ]);
    const store = new PostgresAccessTokenStore(recording.sql, testIssuer);

    const result = await store.rotateRefreshToken({
      token: "helix_rt_old",
      clientId: "client-1",
      nextAccessToken: "helix_at_new",
      nextRefreshToken: "helix_rt_new",
      requestedScopes: ["mail.read"],
      rotatedAt,
      accessExpiresAt: new Date("2026-05-21T15:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "rotated",
      accessToken: { scopes: ["mail.read"] },
      refreshToken: { expiresAt: familyExpiresAt },
    });
    expect(recording.calls[0]?.text).toContain("for update of r, c");
    expect(recording.calls[1]?.text).toContain("set consumed_at");
    expect(recording.calls[2]?.text).toContain("insert into oauth_access_tokens");
    expect(recording.calls[3]?.text).toContain("insert into oauth_refresh_tokens");
  });

  it("revokes a refresh family on replay but not on cross-client presentation", async () => {
    const consumedAt = new Date("2026-05-21T14:00:00.000Z");
    const replayRecording = createRecordingSql([
      [
        {
          family_id: "10000000-0000-4000-8000-000000000001",
          client_id: "client-a",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["mail.read"],
          client_epoch: 0,
          issued_at: new Date("2026-05-20T14:00:00.000Z"),
          expires_at: new Date("2026-06-20T14:00:00.000Z"),
          consumed_at: consumedAt,
          revoked_at: null,
          client_revocation_epoch: 0,
          client_revoked_at: null,
          client_expires_at: null,
          actor_disabled_at: null,
          client_actor_disabled_at: null,
        },
      ],
      [],
    ]);
    const replayStore = new PostgresAccessTokenStore(replayRecording.sql, testIssuer);
    const rotation = {
      token: "helix_rt_old",
      clientId: "client-a",
      nextAccessToken: "helix_at_new",
      nextRefreshToken: "helix_rt_new",
      requestedScopes: [] as readonly string[],
      rotatedAt: new Date("2026-05-22T14:00:00.000Z"),
      accessExpiresAt: new Date("2026-05-22T15:00:00.000Z"),
    };

    await expect(replayStore.rotateRefreshToken(rotation)).resolves.toEqual({ status: "reused" });
    expect(replayRecording.calls[1]?.text).toContain("update oauth_refresh_tokens");
    expect(replayRecording.calls[1]?.text).toContain("update oauth_access_tokens");

    const crossClientRecording = createRecordingSql([[]]);
    const crossClientStore = new PostgresAccessTokenStore(crossClientRecording.sql, testIssuer);
    await expect(
      crossClientStore.rotateRefreshToken({ ...rotation, clientId: "client-b" }),
    ).resolves.toEqual({ status: "invalid" });
    expect(crossClientRecording.calls).toHaveLength(1);
  });
});
const createRecordingSql = (responses: readonly unknown[] = []) =>
  sharedRecordingSql(responses, "$");
