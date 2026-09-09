import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { verifySecret } from "../platform/auth/oauth.js";
import {
  DEFAULT_LOCAL_OAUTH_ACTOR_ID,
  DEFAULT_LOCAL_OAUTH_CLIENT_ID,
  DEFAULT_LOCAL_OAUTH_CLIENT_SECRET,
  DEFAULT_LOCAL_OAUTH_ORG_ID,
  DEFAULT_LOCAL_OAUTH_SCOPES,
  seedLocalOAuth,
} from "./seed-local-oauth.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("seedLocalOAuth", () => {
  it("upserts the deterministic local actor and active OAuth client", async () => {
    const recording = createRecordingSql();

    const result = await seedLocalOAuth(recording.sql);

    expect(result).toMatchObject({
      clientId: DEFAULT_LOCAL_OAUTH_CLIENT_ID,
      clientSecret: DEFAULT_LOCAL_OAUTH_CLIENT_SECRET,
      actorId: DEFAULT_LOCAL_OAUTH_ACTOR_ID,
      orgId: DEFAULT_LOCAL_OAUTH_ORG_ID,
      scopes: [...DEFAULT_LOCAL_OAUTH_SCOPES],
    });
    expect(result.sampleTokenCommand).toContain("/v1/oauth/token");
    expect(result.sampleTokenCommand).toContain("grant_type=client_credentials");
    expect(JSON.stringify(result)).not.toContain("scrypt$");

    expect(recording.beginCalls).toBe(1);
    const actorUpsert = recording.calls.find((call) => call.text.includes("insert into actors"));
    expect(actorUpsert?.text).toContain("on conflict (id) do update");
    expect(actorUpsert?.values).toContain(DEFAULT_LOCAL_OAUTH_ACTOR_ID);
    expect(actorUpsert?.values).toContain(DEFAULT_LOCAL_OAUTH_ORG_ID);
    expect(actorUpsert?.values).toContain("user");

    const credentialUpsert = recording.calls.find((call) =>
      call.text.includes("insert into agent_credentials"),
    );
    expect(credentialUpsert?.text).toContain("credential_type");
    expect(credentialUpsert?.text).toContain(
      "on conflict (client_id) where credential_type = 'oauth_client' do update",
    );
    expect(credentialUpsert?.values).toContain(DEFAULT_LOCAL_OAUTH_CLIENT_ID);
    expect(credentialUpsert?.values).not.toContain(DEFAULT_LOCAL_OAUTH_CLIENT_SECRET);

    const secretHash = credentialUpsert?.values.find(
      (value): value is string => typeof value === "string" && value.startsWith("$argon2id$"),
    );
    expect(secretHash).toBeDefined();
    await expect(
      verifySecret(DEFAULT_LOCAL_OAUTH_CLIENT_SECRET, secretHash as string),
    ).resolves.toBe(true);
  });

  it("accepts explicit seed options and preserves unique scope order", async () => {
    const recording = createRecordingSql();

    const result = await seedLocalOAuth(recording.sql, {
      orgId: "00000000-0000-4000-8000-000000000200",
      actorId: "00000000-0000-4000-8000-000000000201",
      actorType: "agent",
      clientId: "client-2",
      clientSecret: "secret-2",
      scopes: ["mail.read", "mail.read", "mail.send"],
      apiBaseUrl: "http://localhost:4317/",
    });

    expect(result).toMatchObject({
      clientId: "client-2",
      clientSecret: "secret-2",
      actorId: "00000000-0000-4000-8000-000000000201",
      orgId: "00000000-0000-4000-8000-000000000200",
      scopes: ["mail.read", "mail.send"],
    });
    expect(result.sampleTokenCommand).toContain("http://localhost:4317/v1/oauth/token");
    expect(
      recording.calls.some((call) => call.values.includes("00000000-0000-4000-8000-000000000200")),
    ).toBe(true);
    expect(recording.calls.some((call) => call.values.includes("agent"))).toBe(true);
    expect(recording.calls.some((call) => call.values.includes("client-2"))).toBe(true);
    expect(recording.arrays).toContainEqual(["mail.read", "mail.send"]);
  });
});

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
  readonly arrays: readonly (readonly unknown[])[];
  readonly beginCalls: number;
} {
  const calls: RecordedQuery[] = [];
  const arrays: (readonly unknown[])[] = [];
  let beginCalls = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => {
      arrays.push(value);
      return value;
    },
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) => {
      beginCalls += 1;
      return callback(sql as unknown as postgres.TransactionSql);
    },
  }) as unknown as postgres.Sql;
  return {
    sql,
    calls,
    arrays,
    get beginCalls() {
      return beginCalls;
    },
  };
}
