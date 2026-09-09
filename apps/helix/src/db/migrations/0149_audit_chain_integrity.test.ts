import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuditStore } from "../../platform/audit/store.js";
import { verifyAuditHashChain } from "../../platform/audit/verifier.js";
import { tenantAwarePostgresSql } from "../../platform/tenancy/postgres-roles.js";

const migration = readFileSync(
  new URL("./0149_audit_chain_integrity.sql", import.meta.url),
  "utf8",
);

describe("0149 audit chain integrity migration", () => {
  it("serializes a tenant-bound, schema-versioned chain in the database", () => {
    expect(migration).toContain("unique (org_id, sequence)");
    expect(migration).toContain("for update");
    expect(migration).toContain("'eventId', input_event_id::text");
    expect(migration).toContain("'orgId', input_org_id::text");
    expect(migration).toContain("'schemaVersion', input_schema_version");
    expect(migration).toContain("before insert on activity");
    expect(migration).toContain("helix_list_audit_org_ids()");
    expect(migration).toContain("helix_list_audit_shipping_records");
    expect(migration).toContain("helix_get_audit_shipping_backlog");
    expect(migration.match(/security definer/g)?.length).toBe(4);
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("concurrent audit chain", () => {
  const admin = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const role = "helix_audit_chain_test_app";
  const password = "helix_audit_chain_test_password";
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/helix");
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const runtime = postgres(runtimeUrl.toString(), { max: 20, prepare: false });
  const store = new PostgresAuditStore(tenantAwarePostgresSql(runtime));
  const orgId = "f1490000-0000-4000-8000-000000000001";
  const actorId = "f1490000-0000-4000-8000-000000000011";
  const otherOrgId = "f1490000-0000-4000-8000-000000000002";
  const otherActorId = "f1490000-0000-4000-8000-000000000012";

  async function cleanup() {
    await admin`delete from activity where org_id in (${orgId}, ${otherOrgId})`;
    await admin`delete from audit_chain_heads where org_id in (${orgId}, ${otherOrgId})`;
    await admin`delete from actors where org_id in (${orgId}, ${otherOrgId})`;
    await admin`delete from orgs where id in (${orgId}, ${otherOrgId})`;
  }

  beforeAll(async () => {
    await cleanup();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`insert into orgs (id, slug, display_name)
      values
        (${orgId}, 'audit-chain-test', 'Audit chain test'),
        (${otherOrgId}, 'audit-chain-test-other', 'Other audit chain test')`;
    await admin`insert into actors (id, org_id, type, display_name)
      values
        (${actorId}, ${orgId}, 'user', 'Audit Actor'),
        (${otherActorId}, ${otherOrgId}, 'user', 'Other Audit Actor')`;
  });

  afterAll(async () => {
    await cleanup();
    await runtime.end();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("makes 100 concurrent appends contiguous and detects reorder or transplant", async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.append({
          orgId,
          actorId,
          verb: "audit.concurrent",
          objectType: "test",
          metadata: { index },
        }),
      ),
    );

    const records = await store.listVerificationRecords({ orgId });
    expect(records.map((record) => Number(record.sequence))).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    if (records[0] === undefined || records[1] === undefined)
      throw new Error("Expected audit records");
    expect(verifyAuditHashChain(records).valid).toBe(true);
    expect(verifyAuditHashChain([records[1], records[0], ...records.slice(2)]).valid).toBe(false);
    expect(
      verifyAuditHashChain([{ ...records[0], orgId: "f1490000-0000-4000-8000-000000000099" }])
        .valid,
    ).toBe(false);

    await store.append({
      orgId: otherOrgId,
      actorId: otherActorId,
      verb: "audit.cross_tenant",
      objectType: "test",
    });
    expect(await store.listVerificationOrgIds()).toEqual(
      expect.arrayContaining([orgId, otherOrgId]),
    );
    expect(
      (await store.listAuditShippingRecords({ after: null, limit: 10_000 })).map(
        (record) => record.orgId,
      ),
    ).toEqual(expect.arrayContaining([orgId, otherOrgId]));
    expect((await store.getAuditShippingBacklog(null)).recordCount).toBeGreaterThanOrEqual(101);
  });
});
