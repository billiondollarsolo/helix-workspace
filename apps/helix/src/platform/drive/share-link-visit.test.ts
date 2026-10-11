import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { DriveStoreContext } from "./store/context.js";
import { resolveShareLink } from "./store/share-links.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OBJECT_ID = "33333333-3333-4333-8333-333333333333";
const LINK_ID = "44444444-4444-4444-8444-444444444444";

/**
 * A database that answers the share-link queries, recording the tenant
 * settings each transaction applies. The revoked link stops resolution right
 * after the tenant phase under test.
 */
function fakeDatabase() {
  const settings: string[] = [];
  const answer = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join("?");
    if (query.includes("set_config")) settings.push(values.map(String).join("|"));
    if (query.includes("helix_consume_drive_share_rate_limit")) return [{ allowed: true }];
    if (query.includes("helix_drive_share_link_by_token_hash"))
      return [
        {
          id: LINK_ID,
          org_id: ORG_ID,
          object_id: OBJECT_ID,
          rate_limit_per_hour: 120,
          revoked_at: new Date(),
        },
      ];
    if (query.includes("from objects")) return [{ id: OBJECT_ID, org_id: ORG_ID, metadata: {} }];
    return [];
  };
  const raw = Object.assign(answer, {
    json: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(Object.assign(answer, { json: (value: unknown) => value }) as never),
  }) as unknown as postgres.Sql;
  return { sql: tenantAwarePostgresSql(raw), settings };
}

describe("public share-link visits", () => {
  it("resolve for an anonymous visitor inside an actor-free request transaction", async () => {
    const { sql, settings } = fakeDatabase();
    const context = { sql } as unknown as DriveStoreContext;

    // Like a request to /api/drive/share/:token: the tenant transaction is open
    // and no one is signed in.
    const resolved = await withTenantPostgresContext(sql, { orgId: ORG_ID }, () =>
      resolveShareLink(context, {
        token: "a".repeat(43),
        clientKey: "b".repeat(64),
        actor: { id: "anonymous", orgId: ORG_ID },
      }),
    );

    // The revoked link is refused, after a tenant phase that runs as no actor.
    expect(resolved).toBeNull();
    expect(settings).toEqual([`${ORG_ID}|`, `${ORG_ID}|`]);
  });
});
