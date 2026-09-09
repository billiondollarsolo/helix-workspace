import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../platform/test/live-suite.js";

const migrationUrl = new URL("./0075_mail_receiving_domains.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0075_mail_receiving_domains.sql", import.meta.url);

describe("0075 mail receiving-domain migration contract", () => {
  it("creates the lifecycle model and globally serializes active ownership", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).toContain("create table if not exists mail_receiving_domains");
    for (const column of [
      "org_id uuid not null",
      "domain text not null",
      "status mail_receiving_domain_status",
      /* 0075 declared this; 0087 moved the proof to admin_domains and dropped
         it. Asserted here because this test reads 0075's own text, not the
         current schema. */
      "verification_token_hash text not null",
      "verified_at timestamptz",
      "catch_all_actor_id uuid",
      "created_by uuid",
    ]) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain("mail_receiving_domains_active_domain_idx");
    expect(migration).toMatch(/on mail_receiving_domains \(domain\)\s+where status = 'active'/u);
    expect(migration).toContain("mail_receiving_domains_catch_all_same_org");
    expect(migration).toContain("mail_receiving_domains_guard_actor_org_change");
    expect(migration).toContain("alter table mail_receiving_domains enable row level security");
  });

  it("contains no implicit tenant/domain backfill", async () => {
    const migration = await readFile(migrationUrl, "utf8");
    expect(migration).not.toMatch(/insert\s+into\s+mail_receiving_domains/iu);
    expect(migration).toContain("Deliberately no automatic backfill");
  });

  it("ships explicit rollback evidence outside the forward migration stream", async () => {
    const rollback = await readFile(rollbackUrl, "utf8");
    expect(rollback).toContain("drop trigger if exists mail_receiving_domains_catch_all_same_org");
    expect(rollback).toContain(
      "drop trigger if exists mail_receiving_domains_guard_actor_org_change",
    );
    expect(rollback).toContain("drop function if exists mail_receiving_domains_validate_catch_all");
    expect(rollback).toContain("drop table if exists mail_receiving_domains");
    expect(rollback).toContain("drop type if exists mail_receiving_domain_status");
  });
});

const live = describe.skipIf(skipUnlessLiveDatabase("migration 0075 mail receiving domains"));

live("0075 mail receiving-domain PostgreSQL invariants", () => {
  const orgOne = "f7500000-0000-4000-8000-000000000001";
  const orgTwo = "f7500000-0000-4000-8000-000000000002";
  const actorOne = "f7500000-0000-4000-8000-000000000011";
  const actorTwo = "f7500000-0000-4000-8000-000000000022";
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 2, prepare: false });
    /* Deliberately NOT replaying 0075 here. It creates an index on
       `verification_token_hash`, a column 0087 later drops, so replaying an old
       migration against a fully-migrated database fails. These tests assert
       invariants of the CURRENT schema, so `db:migrate` is the prerequisite —
       the same assumption every other live-Postgres suite in this repo makes. */
    await sql`
      insert into orgs (id, slug, display_name)
      values
        (${orgOne}, 'm1-migration-test-one', 'M1 migration test one'),
        (${orgTwo}, 'm1-migration-test-two', 'M1 migration test two')
      on conflict (id) do nothing
    `;
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes)
      values
        (${actorOne}, ${orgOne}, 'user', 'owner@race.example', 'M1 owner one', '{}'),
        (${actorTwo}, ${orgTwo}, 'user', 'owner@race.example', 'M1 owner two', '{}')
      on conflict (id) do nothing
    `;
  });

  afterAll(async () => {
    await sql`delete from mail_receiving_domains where org_id in (${orgOne}, ${orgTwo})`;
    await sql`delete from actors where id in (${actorOne}, ${actorTwo})`;
    /* admin_domains gained its FK to orgs in 0087, so this now cascades. Kept
       explicit so the suite still cleans up if run against an older schema. */
    await sql`delete from admin_domains where org_id in (${orgOne}, ${orgTwo})`;
    await sql`delete from orgs where id in (${orgOne}, ${orgTwo})`;
    await sql.end();
  });

  /** The admin_domains identity a receiving domain now requires. */
  async function ensureParent(orgId: string, domain: string, actorId: string): Promise<string> {
    const rows = await sql<{ readonly id: string }[]>`
      insert into admin_domains (org_id, domain, verification_status, created_by)
      values (${orgId}, ${domain}, 'verified', ${actorId})
      on conflict (org_id, (lower(domain))) do update set updated_at = now()
      returning id
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`could not create a domain identity for ${domain}`);
    }
    return row.id;
  }

  it("lets exactly one concurrent organization activate a shared domain", async () => {
    await sql`delete from mail_receiving_domains where org_id in (${orgOne}, ${orgTwo})`;
    /* Since 0086 a receiving domain hangs off an admin_domains identity. Two
       orgs claiming the same name get two separate parents — which is the
       point of this test: the race is decided per-domain across orgs, not by
       the parent link. */
    const [parentOne, parentTwo] = await Promise.all([
      ensureParent(orgOne, "race.example", actorOne),
      ensureParent(orgTwo, "race.example", actorTwo),
    ]);
    const records = await sql<{ readonly id: string; readonly org_id: string }[]>`
      insert into mail_receiving_domains (
        org_id, admin_domain_id, domain, status, verified_at, created_by
      )
      values
        (${orgOne}, ${parentOne}, 'race.example', 'verified', now(), ${actorOne}),
        (${orgTwo}, ${parentTwo}, 'race.example', 'verified', now(), ${actorTwo})
      returning id, org_id
    `;
    const results = await Promise.allSettled(
      records.map(
        async (record) =>
          await sql`
            update mail_receiving_domains
            set status = 'active', updated_at = now()
            where id = ${record.id}
          `,
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const active = await sql<{ readonly count: string }[]>`
      select count(*) as count
      from mail_receiving_domains
      where domain = 'race.example' and status = 'active'
    `;
    expect(Number(active[0]?.count)).toBe(1);
  });

  it("enforces same-organization catch-all ownership in the database", async () => {
    await expect(
      sql`
        insert into mail_receiving_domains (
          org_id, admin_domain_id, domain, catch_all_actor_id, created_by
        )
        values (
          ${orgOne}, ${await ensureParent(orgOne, "cross-org.example", actorOne)},
          'cross-org.example', ${actorTwo}, ${actorOne}
        )
      `,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "mail_receiving_domains_catch_all_same_org",
    });
  });
});
