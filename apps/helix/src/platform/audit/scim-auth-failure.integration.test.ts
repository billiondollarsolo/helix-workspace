import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuditStore } from "./store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_DATABASE_URL = process.env.HELIX_MIGRATION_DATABASE_URL ?? DATABASE_URL;
const ORG_ID = "e1610000-0000-4000-8000-000000000001";
const SECURITY_ACTOR_ID = "00000000-0000-4000-8000-000000000016";

describe("SCIM authentication failure audit", { skip: DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let adminSql: postgres.Sql;

  beforeAll(async () => {
    if (DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(DATABASE_URL, { max: 2, prepare: false });
    adminSql = postgres(ADMIN_DATABASE_URL ?? DATABASE_URL, { max: 1, prepare: false });
    const principal = await adminSql<{ readonly exists: boolean }[]>`
      select exists (
        select 1 from actors
        where id = ${SECURITY_ACTOR_ID} and type = 'system'
      ) as exists
    `;
    if (principal[0]?.exists !== true) {
      throw new Error("Run database migration 0087 before the SCIM failure audit test.");
    }
    await cleanup();
    await adminSql`
      insert into orgs (id, slug, display_name, status)
      values (${ORG_ID}, 'scim-audit-test', 'SCIM audit test', 'active')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([sql.end(), adminSql.end()]);
  });

  it("persists unattributed failures without a cross-tenant security principal", async () => {
    const audit = new PostgresAuditStore(sql);
    await expect(
      audit.append({
        orgId: ORG_ID,
        actorId: SECURITY_ACTOR_ID,
        verb: "scim.auth.failed",
        objectType: "scim_endpoint",
      }),
    ).rejects.toMatchObject({ code: "23503" });
    await audit.append({
      orgId: ORG_ID,
      actorId: null,
      verb: "scim.auth.failed",
      objectType: "scim_endpoint",
      metadata: { reason: "invalid_bearer", path: "/api/scim/v2/:tenantSlug/Users" },
    });
    await expect(
      audit.listRecords({ orgId: ORG_ID, verb: "scim.auth.failed", limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({
        actorId: null,
        payload: expect.objectContaining({ reason: "invalid_bearer" }),
      }),
    ]);
  });

  async function cleanup(): Promise<void> {
    await adminSql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${ORG_ID}, true)`;
      await tx`delete from activity where org_id = ${ORG_ID} and verb = 'scim.auth.failed'`;
    });
    await adminSql`delete from orgs where id = ${ORG_ID}`;
  }
});
