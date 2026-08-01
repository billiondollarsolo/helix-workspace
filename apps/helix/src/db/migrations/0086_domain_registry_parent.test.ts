/* Executes 0086's backfill against a live database.
 *
 * The neighbouring migration tests read their own .sql and assert it contains
 * a substring. That cannot check a backfill: this migration's correctness is
 * entirely in how a three-way join lands, and a join that matches the wrong
 * rows, matches none, or matches too many produces a file whose text is
 * identical to a correct one. The failure mode is silent -- capability rows
 * pointing at another org's domain, or a `set not null` that aborts the
 * migration on a row the join missed.
 *
 * Gated on DATABASE_URL, matching the other live-Postgres suites in this repo. */

import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationUrl = new URL("./0086_domain_registry_parent.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0086_domain_registry_parent.sql", import.meta.url);
const live = describe.skipIf(process.env.DATABASE_URL === undefined);

live("0086 domain registry parent — backfill", () => {
  /* A dedicated schema per run: the migration alters shared tables, so it is
     replayed against copies rather than the real ones. */
  const schema = "helix_0086_backfill_test";
  const orgA = "86000000-0000-4000-8000-0000000000a0";
  const orgB = "86000000-0000-4000-8000-0000000000b0";
  let sql: postgres.Sql;

  /** The capability tables and their parent, reduced to what 0086 touches. */
  async function buildFixture(): Promise<void> {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}, public`);
    await sql.unsafe(`
      create table admin_domains (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        domain text not null,
        is_primary boolean not null default false,
        verification_status text not null default 'pending',
        verified_at timestamptz,
        created_by uuid,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create unique index admin_domains_org_domain_idx
        on admin_domains (org_id, lower(domain));

      create table mail_sending_domains (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        domain text not null,
        is_default boolean not null default false,
        verified_at timestamptz,
        created_by uuid,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table mail_receiving_domains (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        domain text not null,
        status text not null default 'pending',
        verification_token_hash text not null default repeat('a', 64),
        verified_at timestamptz,
        catch_all_actor_id uuid,
        created_by uuid,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
  }

  async function runMigration(): Promise<void> {
    const migration = await readFile(migrationUrl, "utf8");
    await sql.unsafe(`set search_path to ${schema}, public`);
    await sql.unsafe(migration);
  }

  async function parentOf(table: string, domain: string): Promise<Record<string, unknown> | null> {
    const rows = await sql.unsafe(
      `select p.domain, p.org_id, p.verification_status, p.verified_at
       from ${schema}.${table} c
       join ${schema}.admin_domains p on p.id = c.admin_domain_id
       where c.domain = $1`,
      [domain],
    );
    return (rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
    await buildFixture();
  });

  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });

  it("creates a parent for a capability that has none", async () => {
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.mail_sending_domains (org_id, domain)
      values ('${orgA}', 'orphan.example');
    `);

    await runMigration();

    const parent = await parentOf("mail_sending_domains", "orphan.example");
    expect(parent?.domain).toBe("orphan.example");
    expect(parent?.org_id).toBe(orgA);
  });

  it("reuses the existing parent instead of creating a second one", async () => {
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.admin_domains (org_id, domain) values ('${orgA}', 'shared.example');
      insert into ${schema}.mail_sending_domains (org_id, domain)
        values ('${orgA}', 'shared.example');
      insert into ${schema}.mail_receiving_domains (org_id, domain, status, verified_at)
        values ('${orgA}', 'shared.example', 'active', now());
    `);

    await runMigration();

    const count = await sql.unsafe(
      `select count(*)::int as n from ${schema}.admin_domains where domain = 'shared.example'`,
    );
    expect((count[0] as unknown as { n: number }).n).toBe(1);
    // Both capabilities must land on that one parent.
    const sending = await parentOf("mail_sending_domains", "shared.example");
    const receiving = await parentOf("mail_receiving_domains", "shared.example");
    expect(sending?.domain).toBe("shared.example");
    expect(receiving?.domain).toBe("shared.example");
  });

  it("matches an existing parent whose case differs", async () => {
    /* admin_domains never normalised case -- only its index is on
       lower(domain) -- so a parent stored as "Mixed.Example" must still adopt a
       capability stored lowercase, or the migration creates a duplicate and
       the unique index aborts it. */
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.admin_domains (org_id, domain) values ('${orgA}', 'Mixed.Example');
      insert into ${schema}.mail_receiving_domains (org_id, domain)
        values ('${orgA}', 'mixed.example');
    `);

    await runMigration();

    const parent = await parentOf("mail_receiving_domains", "mixed.example");
    expect(parent?.domain).toBe("Mixed.Example");
  });

  it("keeps identical domains in different orgs apart", async () => {
    // A join on domain alone would cross tenants — the worst outcome here.
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.mail_receiving_domains (org_id, domain)
        values ('${orgA}', 'same.example'), ('${orgB}', 'same.example');
    `);

    await runMigration();

    const rows = await sql.unsafe(`
      select c.org_id as capability_org, p.org_id as parent_org
      from ${schema}.mail_receiving_domains c
      join ${schema}.admin_domains p on p.id = c.admin_domain_id
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows as unknown as { capability_org: string; parent_org: string }[]) {
      expect(row.parent_org).toBe(row.capability_org);
    }
  });

  it("inherits proven ownership from a verified receiving domain", async () => {
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.mail_receiving_domains (org_id, domain, status, verified_at)
        values ('${orgA}', 'proven.example', 'active', now());
    `);

    await runMigration();

    const parent = await parentOf("mail_receiving_domains", "proven.example");
    expect(parent?.verification_status).toBe("verified");
    expect(parent?.verified_at).not.toBeNull();
  });

  it("does not launder a sending domain's self-asserted verification", async () => {
    /* mail_sending_domains.verified_at was written from a client-supplied
       boolean with no DNS lookup. Promoting it to the parent would turn an
       unproven assertion into the record of ownership the whole model rests
       on, and every later capability check would trust it. */
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.mail_sending_domains (org_id, domain, verified_at)
        values ('${orgA}', 'asserted.example', now());
    `);

    await runMigration();

    const parent = await parentOf("mail_sending_domains", "asserted.example");
    expect(parent?.verification_status).toBe("pending");
    expect(parent?.verified_at).toBeNull();
  });

  it("leaves no capability row without a parent", async () => {
    // `set not null` would abort the migration; this states the intent directly.
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.admin_domains (org_id, domain) values ('${orgA}', 'a.example');
      insert into ${schema}.mail_sending_domains (org_id, domain)
        values ('${orgA}', 'a.example'), ('${orgA}', 'b.example');
      insert into ${schema}.mail_receiving_domains (org_id, domain)
        values ('${orgB}', 'c.example');
    `);

    await runMigration();

    const orphans = await sql.unsafe(`
      select
        (select count(*) from ${schema}.mail_sending_domains where admin_domain_id is null)::int
          as sending,
        (select count(*) from ${schema}.mail_receiving_domains where admin_domain_id is null)::int
          as receiving
    `);
    expect(orphans[0]).toEqual({ sending: 0, receiving: 0 });
  });

  it("is idempotent when replayed", async () => {
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.mail_sending_domains (org_id, domain)
        values ('${orgA}', 'replay.example');
    `);

    await runMigration();
    await runMigration();

    const count = await sql.unsafe(
      `select count(*)::int as n from ${schema}.admin_domains where domain = 'replay.example'`,
    );
    expect((count[0] as unknown as { n: number }).n).toBe(1);
  });

  it("refuses a second capability of the same kind on one domain", async () => {
    await buildFixture();
    await sql.unsafe(`
      insert into ${schema}.mail_sending_domains (org_id, domain)
        values ('${orgA}', 'dup.example');
    `);
    await runMigration();

    const parentId = (
      (await sql.unsafe(
        `select id from ${schema}.admin_domains where domain = 'dup.example'`,
      )) as unknown as { id: string }[]
    )[0]?.id;

    await expect(
      sql.unsafe(
        `insert into ${schema}.mail_sending_domains (org_id, domain, admin_domain_id)
         values ('${orgA}', 'dup.example', '${parentId ?? ""}')`,
      ),
    ).rejects.toThrow();
  });
});

describe("0086 domain registry parent — rollback", () => {
  it("keeps backfilled parents rather than deleting domains in use", async () => {
    /* Dropping the columns is reversible; deleting an admin_domains row is not,
       and a backfilled parent is indistinguishable from one an operator
       registered and then attached DNS records to. */
    const rollback = (await readFile(rollbackUrl, "utf8")).toLowerCase();
    expect(rollback).toContain("drop column if exists admin_domain_id");
    expect(rollback).not.toContain("delete from admin_domains");
  });
});
