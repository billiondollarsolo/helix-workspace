import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  PostgresAccessTokenStore,
  PostgresOAuthClientStore,
  hashAccessToken,
} from "./postgres-store.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("Postgres OAuth stores", () => {
  it("creates OAuth clients in agent_credentials for the requested actor and org", async () => {
    const expiresAt = new Date("2026-05-20T12:00:00.000Z");
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "scrypt$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: null,
          expires_at: expiresAt,
          revoked_at: null,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);

    const client = await store.createClient({
      actorId: "actor-1",
      orgId: "org-1",
      clientId: "client-1",
      clientSecretHash: "scrypt$hash",
      scopes: ["tools:read", "tools:read"],
      expiresAt,
    });

    expect(client).toEqual({
      clientId: "client-1",
      clientSecretHash: "scrypt$hash",
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read"],
      redirectUris: [],
      expiresAt,
      revokedAt: null,
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
          secret_hash: "scrypt$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: ["https://app.example.com/callback"],
          expires_at: expiresAt,
          revoked_at: null,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);

    const client = await store.createClient({
      actorId: "actor-1",
      orgId: "org-1",
      clientId: "client-1",
      clientSecretHash: "scrypt$hash",
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
          secret_hash: "scrypt$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: ["https://app.example.com/cb"],
          expires_at: null,
          revoked_at: null,
        },
      ],
    ]);
    const store = new PostgresOAuthClientStore(recording.sql);
    const client = await store.findClient("client-1");
    expect(client?.redirectUris).toEqual(["https://app.example.com/cb"]);
    expect(recording.calls[0]?.text).toContain("c.redirect_uris");
  });

  it("replaces redirect_uris with setRedirectUris (CRITICAL-3)", async () => {
    const recording = createRecordingSql([
      [
        {
          client_id: "client-1",
          secret_hash: "scrypt$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read"],
          redirect_uris: ["https://app.example.com/v2"],
          expires_at: null,
          revoked_at: null,
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
          secret_hash: "scrypt$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["tools:read", "tools:write"],
          redirect_uris: null,
          expires_at: null,
          revoked_at: revokedAt,
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
          secret_hash: "scrypt$hash",
          actor_id: "actor-1",
          org_id: "org-1",
          scopes: ["mail.read"],
          redirect_uris: null,
          expires_at: null,
          revoked_at: revokedAt,
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
        clientSecretHash: "scrypt$hash",
        actorId: "actor-1",
        orgId: "org-1",
        scopes: ["mail.read"],
        redirectUris: [],
        expiresAt: null,
        revokedAt,
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
    const recording = createRecordingSql([[], []]);
    const store = new PostgresAccessTokenStore(recording.sql);

    await store.saveToken({
      token: "helix_at_secret",
      clientId: "client-1",
      actorId: "actor-1",
      orgId: "org-1",
      scopes: ["tools:read", "tools:read"],
      issuedAt,
      expiresAt,
    });

    expect(recording.calls[0]?.text).toContain("insert into oauth_access_tokens");
    expect(recording.calls[0]?.values).toContain(hashAccessToken("helix_at_secret"));
    expect(recording.calls[0]?.values).not.toContain("helix_at_secret");
    expect(recording.calls[1]?.text).toContain("set last_used_at");
    expect(recording.calls[1]?.values).toContain(issuedAt);
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
        },
      ],
    ]);
    const store = new PostgresAccessTokenStore(recording.sql);

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
    expect(recording.calls[0]?.values).toContain(hashAccessToken("helix_at_secret"));
  });
});

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
