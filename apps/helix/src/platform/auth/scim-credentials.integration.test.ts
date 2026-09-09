import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import {
  PostgresTenantScimCredentialStore,
  SCIM_CREDENTIAL_SCOPES,
  ScimCredentialConflictError,
  issueScimBearerToken,
} from "./scim-credentials.js";

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_DATABASE_URL = process.env.HELIX_MIGRATION_DATABASE_URL ?? DATABASE_URL;
const ORG_A = "e1600000-0000-4000-8000-000000000001";
const ORG_B = "e1600000-0000-4000-8000-000000000002";
const ADMIN_A = "e1600000-0000-4000-8000-000000000011";

describe("Postgres SCIM credential governance", { skip: DATABASE_URL === undefined }, () => {
  let sql: postgres.Sql;
  let adminSql: postgres.Sql;
  let store: PostgresTenantScimCredentialStore;

  beforeAll(async () => {
    if (DATABASE_URL === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(DATABASE_URL, { max: 3, prepare: false });
    adminSql = postgres(ADMIN_DATABASE_URL ?? DATABASE_URL, { max: 1, prepare: false });
    const ready = await adminSql<{ readonly ready: boolean }[]>`
      select exists (
        select 1 from information_schema.columns
        where table_name = 'tenant_scim_credentials' and column_name = 'last_used_at'
      ) as ready
    `;
    if (ready[0]?.ready !== true) {
      throw new Error("Run database migration 0087 before the live SCIM credential test.");
    }
    store = new PostgresTenantScimCredentialStore(sql);
    await cleanup();
    await adminSql`
      insert into orgs (id, slug, display_name, status)
      values
        (${ORG_A}, 'scim-credential-test-a', 'SCIM credential test A', 'active'),
        (${ORG_B}, 'scim-credential-test-b', 'SCIM credential test B', 'active')
      on conflict (id) do nothing
    `;
    await withTenantPostgresContext(adminSql, { orgId: ORG_A }, async (tx) => {
      await tx`
        insert into actors (id, org_id, type, display_name)
        values (${ADMIN_A}, ${ORG_A}, 'user', 'SCIM credential admin')
      `;
    });
  });

  afterAll(async () => {
    await cleanup();
    await Promise.all([sql.end(), adminSql.end()]);
  });

  it("persists overlapping scoped keys, use metadata, expiry, and independent revocation", async () => {
    const oldToken = await issueScimBearerToken();
    const newToken = await issueScimBearerToken();
    const expiresAt = new Date(Date.now() + 86_400_000);
    await store.create({
      id: oldToken.id,
      tokenHash: oldToken.tokenHash,
      tokenHint: oldToken.tokenHint,
      orgId: ORG_A,
      name: "Old integration key",
      scopes: ["scim.users.read"],
      sourceCidrs: ["198.51.100.0/24"],
      expiresAt,
      createdByActorId: ADMIN_A,
    });
    await store.create({
      id: newToken.id,
      tokenHash: newToken.tokenHash,
      tokenHint: newToken.tokenHint,
      orgId: ORG_A,
      name: "New integration key",
      scopes: SCIM_CREDENTIAL_SCOPES,
      sourceCidrs: [],
      expiresAt,
      createdByActorId: ADMIN_A,
    });

    await expect(store.list(ORG_A)).resolves.toHaveLength(2);
    await expect(store.findById(ORG_B, oldToken.id)).resolves.toBeNull();
    await expect(store.markUsed(ORG_A, newToken.id, new Date(), "198.51.100.7")).resolves.toBe(
      true,
    );
    await expect(store.findById(ORG_A, newToken.id)).resolves.toMatchObject({
      lastUsedAt: expect.any(Date),
      lastUsedIp: "198.51.100.7/32",
    });
    const revoked = await store.revoke(ORG_A, oldToken.id, ADMIN_A);
    expect(revoked).toMatchObject({ revokedByActorId: ADMIN_A });
    await expect(store.markUsed(ORG_A, oldToken.id, new Date(), "198.51.100.7")).resolves.toBe(
      false,
    );
    await expect(store.findById(ORG_A, newToken.id)).resolves.toMatchObject({ revokedAt: null });

    const duplicate = await issueScimBearerToken();
    await expect(
      store.create({
        id: duplicate.id,
        tokenHash: duplicate.tokenHash,
        tokenHint: duplicate.tokenHint,
        orgId: ORG_A,
        name: "new integration key",
        scopes: SCIM_CREDENTIAL_SCOPES,
        sourceCidrs: [],
        expiresAt,
        createdByActorId: ADMIN_A,
      }),
    ).rejects.toBeInstanceOf(ScimCredentialConflictError);
  });

  async function cleanup(): Promise<void> {
    await withTenantPostgresContext(adminSql, { orgId: ORG_A }, async (tx) => {
      await tx`delete from tenant_scim_credentials where org_id = ${ORG_A}`;
      await tx`delete from actors where id = ${ADMIN_A}`;
    });
    await adminSql`delete from orgs where id in (${ORG_A}, ${ORG_B})`;
  }
});
