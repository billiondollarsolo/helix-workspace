import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCrownJewelApprovalStore } from "../../platform/auth/crown-jewel.js";

const migration = readFileSync(
  new URL("./0155_crown_jewel_approvals.sql", import.meta.url),
  "utf8",
);

describe("0155 crown-jewel approvals migration", () => {
  it("adds distinct-actor and one-use database invariants", () => {
    expect(migration).toContain("approval_kind = 'distinct_actor'");
    expect(migration).toContain("approved_by_actor_id <> actor_id");
    expect(migration).toContain("consumed_at timestamptz");
    expect(migration).toContain("foreign key (org_id, approved_by_actor_id)");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("Postgres crown-jewel approvals", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const store = new PostgresCrownJewelApprovalStore(sql);
  const orgId = "f1550000-0000-4000-8000-000000000001";
  const requesterId = "f1550000-0000-4000-8000-000000000011";
  const approverId = "f1550000-0000-4000-8000-000000000012";

  beforeAll(async () => {
    await sql`insert into orgs (id, slug, display_name) values (${orgId}, 'crown-jewel-test', 'Crown Jewel Test')`;
    await sql`insert into actors (id, org_id, type, display_name) values
      (${requesterId}, ${orgId}, 'user', 'Requester'),
      (${approverId}, ${orgId}, 'user', 'Approver')`;
  });

  afterAll(async () => {
    await sql`delete from activity where org_id = ${orgId}`;
    await sql`delete from audit_chain_heads where org_id = ${orgId}`;
    await sql`delete from pending_actions where org_id = ${orgId}`;
    await sql`delete from actors where org_id = ${orgId}`;
    await sql`delete from orgs where id = ${orgId}`;
    await sql.end();
  });

  it("atomically records evidence and permits one distinct-actor consumption", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const approval = await store.request({
      orgId,
      actorId: requesterId,
      action: { id: "tenant.delete", permission: "admin.tenants.delete" },
      fingerprint: "a".repeat(64),
      expiresAt,
    });
    await expect(
      store.approve({ orgId, id: approval.id, actorId: requesterId, now: new Date() }),
    ).resolves.toEqual({ kind: "self_approval" });

    const approved = await store.approve({
      orgId,
      id: approval.id,
      actorId: approverId,
      now: new Date(),
    });
    expect(approved.kind).toBe("approved");
    const consumed = await store.consume({
      orgId,
      id: approval.id,
      actorId: requesterId,
      fingerprint: "a".repeat(64),
      now: new Date(),
    });
    expect(consumed.kind).toBe("consumed");
    await expect(
      store.consume({
        orgId,
        id: approval.id,
        actorId: requesterId,
        fingerprint: "a".repeat(64),
        now: new Date(),
      }),
    ).resolves.toEqual({ kind: "already_consumed" });

    const evidence = await sql<{ readonly verb: string; readonly this_hash: string }[]>`
      select verb, this_hash from activity
      where org_id = ${orgId} and object_id = ${approval.id}
      order by sequence
    `;
    expect(evidence.map((entry) => entry.verb)).toEqual([
      "crown_jewel.approval.requested",
      "crown_jewel.approval.rejected",
      "crown_jewel.approval.approved",
      "crown_jewel.approval.consumed",
    ]);
    expect(evidence.every((entry) => /^[a-f0-9]{64}$/u.test(entry.this_hash))).toBe(true);
  });
});
