import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0153_drive_storage_reservations.sql", import.meta.url),
  "utf8",
);

describe("0153 Drive storage reservations", () => {
  it("keeps scans out of the atomic quota path and meters through the outbox", () => {
    const reserve = migration.slice(
      migration.indexOf("create function helix_reserve_drive_storage"),
      migration.indexOf("create function helix_commit_storage_usage"),
    );
    expect(reserve).toContain("for update");
    expect(reserve).toContain("used_bytes + counter.reserved_bytes + input_bytes");
    expect(reserve).not.toContain("drive_versions");
    expect(migration).toContain(
      "foreign key (org_id, object_id) references objects(org_id, id) on delete cascade",
    );
    expect(migration).toContain("helix_authoritative_storage_usage_bytes");
    expect(migration).toContain("insert into public.outbox");
    expect(migration).toContain("input_org_id is distinct from public.helix_current_org_id()");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("atomic Drive storage quota", () => {
  const admin = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const role = "helix_drive_quota_test_app";
  const password = "helix_drive_quota_test_password";
  const runtimeUrl = new URL(process.env.DATABASE_URL ?? "postgres://localhost/helix");
  runtimeUrl.username = role;
  runtimeUrl.password = password;
  const runtime = postgres(runtimeUrl.toString(), { max: 20, prepare: false });
  const orgId = "f1530000-0000-4000-8000-000000000001";
  const actorId = "f1530000-0000-4000-8000-000000000011";
  const objectIds = Array.from(
    { length: 20 },
    (_, index) => `f1530000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
  );

  async function cleanup() {
    await cleanupTestTenants(admin, [orgId]);
  }

  async function asTenant<T>(callback: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return (await runtime.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${orgId}, true)`;
      await tx`select set_config('helix.actor_id', ${actorId}, true)`;
      return callback(tx);
    })) as T;
  }

  beforeAll(async () => {
    await cleanup();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`insert into orgs (id, slug, display_name, quotas)
      values (${orgId}, 'drive-quota-test', 'Drive quota test', ${admin.json({ storage_bytes_limit: 100 })})`;
    await admin`insert into actors (id, org_id, type, display_name)
      values (${actorId}, ${orgId}, 'user', 'Quota Actor')`;
    for (const [index, objectId] of objectIds.entries()) {
      await admin`insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata
      ) values (
        ${objectId}, ${orgId}, ${actorId}, 'file', ${`drive/${orgId}/${objectId}`},
        'application/octet-stream', 10, ${admin.json({ status: "pending_upload", index })}
      )`;
    }
  });

  afterAll(async () => {
    await cleanup();
    await runtime.end();
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("never overbooks concurrent reservations and repairs expiry, deletion, and counter drift", async () => {
    await expect(
      runtime.begin(async (tx) => {
        const missingOrgId = "f1530000-0000-4000-8000-000000000099";
        await tx`select set_config('helix.org_id', ${missingOrgId}, true)`;
        return tx`select helix_storage_usage_bytes(${missingOrgId})`;
      }),
    ).rejects.toThrow("unknown storage tenant");

    const decisions = await Promise.all(
      objectIds.map((objectId) =>
        asTenant(async (tx) => {
          const rows = await tx<{ accepted: boolean }[]>`
            select accepted from helix_reserve_drive_storage(
              ${orgId}, ${objectId}, 10, statement_timestamp() + interval '1 hour'
            )
          `;
          return rows[0]?.accepted ?? false;
        }),
      ),
    );
    expect(decisions.filter(Boolean)).toHaveLength(10);
    await expect(
      admin`select used_bytes, reserved_bytes from storage_usage_counters where org_id = ${orgId}`,
    ).resolves.toMatchObject([{ used_bytes: "0", reserved_bytes: "100" }]);

    const acceptedIds = objectIds.filter((_, index) => decisions[index]);
    const [committedId, deletedId, expiredId] = acceptedIds;
    if (committedId === undefined || deletedId === undefined || expiredId === undefined) {
      throw new Error("Expected at least three accepted storage reservations.");
    }
    await asTenant(
      (tx) => tx`select * from helix_commit_storage_usage(${orgId}, ${committedId}, 10, 'drive')`,
    );
    await admin`delete from objects where org_id = ${orgId} and id = ${deletedId}`;
    await admin`update drive_storage_reservations set expires_at = statement_timestamp() - interval '1 second'
      where org_id = ${orgId} and object_id = ${expiredId}`;
    await admin`update storage_usage_counters set used_bytes = 99 where org_id = ${orgId}`;

    const repaired = await asTenant(
      (tx) => tx<{ used_bytes: string; reserved_bytes: string; correction_bytes: string }[]>`
        select * from helix_reconcile_storage_usage(${orgId})
      `,
    );
    expect(repaired).toEqual([{ used_bytes: "0", reserved_bytes: "70", correction_bytes: "-99" }]);
    const outbox = await admin`
      select payload from outbox where subject = ${`metering.events.${orgId}`} order by created_at
    `;
    expect(outbox.map((row) => row.payload.quantity)).toEqual(["10", "-99"]);
  });
});
