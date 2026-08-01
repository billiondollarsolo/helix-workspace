/* Executes 0088 against a live database.
 *
 * The two properties that matter are opposites, and a text assertion cannot
 * tell them apart: the constraint must REJECT a new malformed row while
 * ACCEPTING the malformed rows already in the table. Only running it shows
 * both.
 *
 * Gated on DATABASE_URL, matching the other live-Postgres suites in this repo. */

import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationUrl = new URL("./0088_activity_hash_shape.sql", import.meta.url);
const live = describe.skipIf(process.env.DATABASE_URL === undefined);

live("0088 activity hash shape", () => {
  const schema = "helix_0088_activity_test";
  const orgId = "88000000-0000-4000-8000-0000000000a0";
  const digest = "a".repeat(64);
  /* The shape the bug produced: a chain transcript rather than a digest. */
  const legacy = `root:sheets.sheet.created:${"b".repeat(3000)}`;
  let sql: postgres.Sql;

  async function buildFixture(): Promise<void> {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.unsafe(`create schema ${schema}`);
    await sql.unsafe(`set search_path to ${schema}, public`);
    await sql.unsafe(`
      create table activity (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null,
        verb text not null,
        prev_hash text,
        this_hash text not null,
        created_at timestamptz not null default now()
      );
    `);
    // A row from before the fix, present when the constraint is added.
    await sql.unsafe(
      `insert into ${schema}.activity (org_id, verb, this_hash) values ($1, 'legacy', $2)`,
      [orgId, legacy],
    );
  }

  async function runMigration(): Promise<void> {
    await sql.unsafe(`set search_path to ${schema}, public`);
    await sql.unsafe(await readFile(migrationUrl, "utf8"));
  }

  beforeAll(async () => {
    sql = postgres(process.env.DATABASE_URL ?? "", { max: 1, onnotice: () => undefined });
    await buildFixture();
  });

  afterAll(async () => {
    await sql.unsafe(`drop schema if exists ${schema} cascade`);
    await sql.end();
  });

  it("applies even though a malformed row is already present", async () => {
    /* The whole reason for NOT VALID. A validating constraint would abort here,
       and the only way to make it apply would be to delete or rewrite audit
       history — which is the tampering this chain exists to detect. */
    await buildFixture();

    await expect(runMigration()).resolves.toBeUndefined();
  });

  it("leaves the pre-existing row readable", async () => {
    await buildFixture();
    await runMigration();

    const rows = await sql.unsafe(
      `select length(this_hash) as n from ${schema}.activity where verb = 'legacy'`,
    );
    expect((rows[0] as unknown as { n: number }).n).toBe(legacy.length);
  });

  it("rejects a new row whose hash is a chain transcript", async () => {
    await buildFixture();
    await runMigration();

    await expect(
      sql.unsafe(
        `insert into ${schema}.activity (org_id, verb, this_hash) values ($1, 'new', $2)`,
        [orgId, `${digest}:sheets.sheet.created:x`],
      ),
    ).rejects.toThrow(/activity_this_hash_sha256/u);
  });

  it("accepts a real digest", async () => {
    await buildFixture();
    await runMigration();

    await expect(
      sql.unsafe(
        `insert into ${schema}.activity (org_id, verb, this_hash) values ($1, 'new', $2)`,
        [orgId, digest],
      ),
    ).resolves.toBeDefined();
  });

  it("allows a null prev_hash for the first row in an organization", async () => {
    await buildFixture();
    await runMigration();

    await expect(
      sql.unsafe(
        `insert into ${schema}.activity (org_id, verb, this_hash, prev_hash)
         values ($1, 'first', $2, null)`,
        [orgId, digest],
      ),
    ).resolves.toBeDefined();
  });

  it("holds prev_hash to the same shape when it is set", async () => {
    await buildFixture();
    await runMigration();

    await expect(
      sql.unsafe(
        `insert into ${schema}.activity (org_id, verb, this_hash, prev_hash)
         values ($1, 'chained', $2, $3)`,
        [orgId, digest, "root:sheets.sheet.created:x"],
      ),
    ).rejects.toThrow(/activity_prev_hash_sha256/u);
  });

  it("rejects an UPDATE that rewrites a hash into a transcript", async () => {
    // A constraint that only guards INSERT would leave the same door open.
    await buildFixture();
    await runMigration();
    await sql.unsafe(
      `insert into ${schema}.activity (org_id, verb, this_hash) values ($1, 'new', $2)`,
      [orgId, digest],
    );

    await expect(
      sql.unsafe(`update ${schema}.activity set this_hash = $1 where verb = 'new'`, [
        `${digest}:tampered`,
      ]),
    ).rejects.toThrow(/activity_this_hash_sha256/u);
  });

  it("is idempotent when replayed", async () => {
    await buildFixture();
    await runMigration();

    await expect(runMigration()).resolves.toBeUndefined();
  });
});
