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
    expect(result.sampleTokenCommand).toContain("/oauth/token");
    expect(result.sampleTokenCommand).toContain("grant_type=client_credentials");
    expect(JSON.stringify(result)).not.toContain("scrypt$");

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[0]?.text).toContain("insert into actors");
    expect(recording.calls[0]?.text).toContain("on conflict (id) do update");
    expect(recording.calls[0]?.text).toContain("jsonb_typeof(actors.metadata)");
    expect(recording.calls[0]?.values).toContain(DEFAULT_LOCAL_OAUTH_ACTOR_ID);
    expect(recording.calls[0]?.values).toContain(DEFAULT_LOCAL_OAUTH_ORG_ID);
    expect(recording.calls[0]?.values).toContain("user");
    expect(recording.arrays).toContainEqual(
      expect.arrayContaining([
        "notifications.read",
        "search.read",
        "sheets.write",
        "slides.write",
        "admin.console.read",
      ]),
    );

    expect(recording.calls[1]?.text).toContain("insert into agent_credentials");
    expect(recording.calls[1]?.text).toContain("credential_type");
    expect(recording.calls[1]?.text).toContain(
      "on conflict (client_id) where revoked_at is null do update",
    );
    expect(recording.calls[1]?.values).toContain(DEFAULT_LOCAL_OAUTH_CLIENT_ID);
    expect(recording.calls[1]?.values).not.toContain(DEFAULT_LOCAL_OAUTH_CLIENT_SECRET);

    const secretHash = recording.calls[1]?.values.find(
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
      orgId: "org-2",
      actorId: "actor-2",
      actorType: "agent",
      clientId: "client-2",
      clientSecret: "secret-2",
      scopes: ["mail.read", "mail.read", "mail.send"],
      apiBaseUrl: "http://localhost:4317/",
    });

    expect(result).toMatchObject({
      clientId: "client-2",
      clientSecret: "secret-2",
      actorId: "actor-2",
      orgId: "org-2",
      scopes: ["mail.read", "mail.send"],
    });
    expect(result.sampleTokenCommand).toContain("http://localhost:4317/oauth/token");
    expect(recording.calls[0]?.values).toContain("org-2");
    expect(recording.calls[0]?.values).toContain("agent");
    expect(recording.calls[1]?.values).toContain("client-2");
    expect(recording.arrays).toContainEqual(["mail.read", "mail.send"]);
  });
});

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
  readonly arrays: readonly (readonly unknown[])[];
  readonly jsonValues: readonly unknown[];
} {
  const calls: RecordedQuery[] = [];
  const arrays: (readonly unknown[])[] = [];
  const jsonValues: unknown[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => {
      arrays.push(value);
      return value;
    },
    json: (value: unknown) => {
      jsonValues.push(value);
      return value;
    },
  }) as unknown as postgres.Sql;
  return { sql, calls, arrays, jsonValues };
}
