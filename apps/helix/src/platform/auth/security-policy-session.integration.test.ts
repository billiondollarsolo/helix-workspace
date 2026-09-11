import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSessionMfaAssurance } from "./mfa.js";

const databaseUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
describe.skipIf(!databaseUrl || !runtimeUrl)("security policy real session freshness", () => {
  let admin: postgres.Sql, sql: postgres.Sql;
  const userId = "security-policy-freshness-user";
  const token = "security-policy-server-token";
  let presented: string | null = token;
  let assurance: PostgresSessionMfaAssurance;
  const request = { headers: { "x-helix-mfa-verified": "true" } };
  beforeAll(async () => {
    if (!databaseUrl || !runtimeUrl) throw Error("Isolated database required");
    admin = postgres(databaseUrl, { max: 1 });
    sql = postgres(runtimeUrl, { max: 1 });
    await admin`insert into "user" (id,name,email) values (${userId},'Policy operator','policy-freshness@example.test')`;
    await admin`insert into "session" (id,"userId",token,"expiresAt") values ('security-policy-session',${userId},${token},now()+interval '1 day')`;
    assurance = new PostgresSessionMfaAssurance(
      sql,
      { getSessionUser: async () => null, getSessionToken: async () => presented },
      "https://helix.example.test",
    );
  });
  afterAll(async () => {
    {
      await admin`delete from "user" where id=${userId}`;
      await admin.end();
    }
    await sql.end();
  });
  it("accepts a fresh login without fabricating MFA, rejects expired/stale/forged/future sessions", async () => {
    expect(await assurance.isRecentlyAuthenticated(request)).toBe(true);
    expect(await assurance.isMfaVerified(request)).toBe(false);
    await admin`update "session" set "createdAt"=now()-interval '11 minutes' where token=${token}`;
    expect(await assurance.isRecentlyAuthenticated(request)).toBe(false);
    presented = null;
    expect(await assurance.isRecentlyAuthenticated(request)).toBe(false);
    presented = "forged-token";
    expect(await assurance.isRecentlyAuthenticated(request)).toBe(false);
    presented = token;
    await admin`update "session" set "createdAt"=now(),"expiresAt"=now()-interval '1 second' where token=${token}`;
    expect(await assurance.isRecentlyAuthenticated(request)).toBe(false);
    await admin`update "session" set "createdAt"=now()+interval '1 hour',"expiresAt"=now()+interval '1 day' where token=${token}`;
    expect(await assurance.isRecentlyAuthenticated(request)).toBe(false);
  });
});
