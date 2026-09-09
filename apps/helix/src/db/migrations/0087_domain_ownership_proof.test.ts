/* Executes 0087 against a live database.
 *
 * The risk here is silent de-verification: a domain an operator proved and put
 * into production must not come out of this migration unproven, because the
 * capabilities gate on the parent's status afterwards. Nothing about the file's
 * text can show that — only running it against rows in each state.
 *
 * Gated on DATABASE_URL, matching the other live-Postgres suites in this repo. */

import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../platform/test/live-suite.js";

const migrationUrl = new URL("./0087_domain_ownership_proof.sql", import.meta.url);
const rollbackUrl = new URL("./rollbacks/0087_domain_ownership_proof.sql", import.meta.url);
const live = describe.skipIf(skipUnlessLiveDatabase("migration 0087 domain ownership proof"));

live("0087 domain ownership proof", () => {
  const schema = "helix_0087_ownership_test";
  const orgA = "87000000-0000-4000-8000-0000000000a0";
  const proofHash = "a".repeat(64);
  let sql: postgres.Sql;

  async function buildFixture(): Promise<void> {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}, public`);
    await sql.unsafe(`
      create table orgs (id uuid primary key, name text not null default 'org');

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

      create table mail_receiving_domains (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        admin_domain_id uuid not null references admin_domains (id) on delete cascade,
        domain text not null,
        status text not null default 'pending',
        verification_token_hash text not null,
        verified_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      insert into orgs (id) values ('${orgA}');
    `);
  }

  /** A domain identity with an optional receiving capability in `status`. */
  async function seed(
    domain: string,
    capability?: { status: string; hash: string; verifiedAt: string | null },
  ): Promise<string> {
    const rows = (await sql.unsafe(
      `insert into ${schema}.admin_domains (org_id, domain) values ($1, $2) returning id`,
      [orgA, domain],
    )) as unknown as { id: string }[];
    const parentId = rows[0]?.id ?? "";
    if (capability !== undefined) {
      await sql.unsafe(
        `insert into ${schema}.mail_receiving_domains
           (org_id, admin_domain_id, domain, status, verification_token_hash, verified_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [orgA, parentId, domain, capability.status, capability.hash, capability.verifiedAt],
      );
    }
    return parentId;
  }

  async function runMigration(): Promise<void> {
    await sql.unsafe(`set search_path to ${schema}, public`);
    await sql.unsafe(await readFile(migrationUrl, "utf8"));
  }

  async function parent(id: string): Promise<Record<string, unknown>> {
    const rows = await sql.unsafe(`select * from ${schema}.admin_domains where id = $1`, [id]);
    return rows[0] as unknown as Record<string, unknown>;
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
    await buildFixture();
  });

  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });

  it("keeps a proven domain proven", async () => {
    /* The dangerous direction: this domain is accepting production mail. If it
       came out `pending`, every capability gating on the parent would refuse. */
    await buildFixture();
    const id = await seed("proven.example", {
      status: "active",
      hash: proofHash,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });

    await runMigration();

    const row = await parent(id);
    expect(row.verification_status).toBe("verified");
    expect(row.verification_token_hash).toBe(proofHash);
    expect(row.verified_at).not.toBeNull();
  });

  it("carries an outstanding challenge across, so a published TXT still works", async () => {
    // An operator mid-setup should not have to republish what they just added.
    await buildFixture();
    const id = await seed("midway.example", {
      status: "pending",
      hash: proofHash,
      verifiedAt: null,
    });

    await runMigration();

    const row = await parent(id);
    expect(row.verification_token_hash).toBe(proofHash);
    // Carrying the challenge is not the same as satisfying it.
    expect(row.verification_status).toBe("pending");
  });

  it("leaves a domain with no capability unproven", async () => {
    await buildFixture();
    const id = await seed("bare.example");

    await runMigration();

    const row = await parent(id);
    expect(row.verification_token_hash).toBeNull();
    expect(row.verification_status).toBe("pending");
  });

  it("lower-cases stored domains before constraining them", async () => {
    /* admin_domains only ever normalised in its index, so mixed case is real
       data. Adding the constraint without canonicalising first would abort. */
    await buildFixture();
    const id = await seed("Mixed.Example");

    await runMigration();

    expect((await parent(id)).domain).toBe("mixed.example");
  });

  it("rejects a non-canonical domain once constrained", async () => {
    await buildFixture();
    await runMigration();

    await expect(
      sql.unsafe(
        `insert into ${schema}.admin_domains (org_id, domain) values ($1, 'BAD.Example')`,
        [orgA],
      ),
    ).rejects.toThrow();
  });

  it("removes an org's domains with the org", async () => {
    // The missing FK is why test rows outlived the tenants that owned them.
    await buildFixture();
    await seed("cascade.example");
    await runMigration();

    await sql.unsafe(`delete from ${schema}.orgs where id = $1`, [orgA]);

    const remaining = await sql.unsafe(`select count(*)::int as n from ${schema}.admin_domains`);
    expect((remaining[0] as unknown as { n: number }).n).toBe(0);
  });

  it("drops the capability's duplicate copy of the proof", async () => {
    await buildFixture();
    await seed("dedupe.example", { status: "active", hash: proofHash, verifiedAt: "2026-01-01" });
    await runMigration();

    const columns = await sql.unsafe(
      `select column_name from information_schema.columns
       where table_schema = $1 and table_name = 'mail_receiving_domains'`,
      [schema],
    );
    const names = (columns as unknown as { column_name: string }[]).map((c) => c.column_name);
    expect(names).not.toContain("verification_token_hash");
  });

  it("is idempotent when replayed", async () => {
    await buildFixture();
    const id = await seed("replay.example", {
      status: "active",
      hash: proofHash,
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });

    await runMigration();
    await runMigration();

    expect((await parent(id)).verification_token_hash).toBe(proofHash);
  });
});

describe("0087 rollback", () => {
  it("restores the column with a digest nobody can satisfy", async () => {
    /* Only digests were ever stored, so the tokens cannot come back. A
       placeholder that no TXT record matches is the honest state — the
       alternative is a column that looks satisfiable and is not. */
    const rollback = (await readFile(rollbackUrl, "utf8")).toLowerCase();
    expect(rollback).toContain("add column if not exists verification_token_hash");
    expect(rollback).toContain("repeat('0', 64)");
    expect(rollback).toContain("reissuing the challenge is the recovery path");
  });
});
