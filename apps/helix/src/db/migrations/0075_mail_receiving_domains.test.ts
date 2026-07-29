import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const live = describe.skipIf(process.env.DATABASE_URL === undefined);

live("0075 mail receiving-domain PostgreSQL invariants", () => {
  const orgOne = "f7500000-0000-4000-8000-000000000001";
  const orgTwo = "f7500000-0000-4000-8000-000000000002";
  const actorOne = "f7500000-0000-4000-8000-000000000011";
  const actorTwo = "f7500000-0000-4000-8000-000000000022";
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 2, prepare: false });
    await sql.unsafe(await readFile(migrationUrl, "utf8"));
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
    await sql`delete from orgs where id in (${orgOne}, ${orgTwo})`;
    await sql.end();
  });

  it("lets exactly one concurrent organization activate a shared domain", async () => {
    await sql`delete from mail_receiving_domains where org_id in (${orgOne}, ${orgTwo})`;
    const records = await sql<{ readonly id: string; readonly org_id: string }[]>`
      insert into mail_receiving_domains (
        org_id, domain, status, verification_token_hash, verified_at, created_by
      )
      values
        (
          ${orgOne}, 'race.example', 'verified',
          ${"1".repeat(64)}, now(), ${actorOne}
        ),
        (
          ${orgTwo}, 'race.example', 'verified',
          ${"2".repeat(64)}, now(), ${actorTwo}
        )
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
          org_id, domain, verification_token_hash, catch_all_actor_id, created_by
        )
        values (
          ${orgOne}, 'cross-org.example', ${"3".repeat(64)}, ${actorTwo}, ${actorOne}
        )
      `,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "mail_receiving_domains_catch_all_same_org",
    });
  });
});
