import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrationEnv } from "../../config/env.js";
import { createMigrationSqlClient, createSqlClient } from "../client.js";
import { seedDemo } from "./index.js";

// Needs Postgres (DATABASE_URL naming the helix_app runtime role and
// HELIX_MIGRATION_DATABASE_URL the owner, which the live-database setup point at
// a fresh copy of the migrated template), RustFS, ClamAV and Meilisearch, so it
// runs in the live demo-data CI job rather than the unit suite.
const enabled = process.env.HELIX_DEMO_SEED_INTEGRATION === "1";
const now = new Date();
now.setUTCSeconds(0, 0);

describe.runIf(enabled)("demo seed", () => {
  let sql: postgres.Sql;
  let privilegedSql: postgres.Sql;
  beforeAll(() => {
    // The same tenant-aware clients the CLI uses.
    sql = createSqlClient();
    privilegedSql = createMigrationSqlClient(loadMigrationEnv());
  });
  afterAll(async () => {
    await sql.end();
    await privilegedSql.end();
  });

  it(
    "seeds the small preset on a fresh database and passes its own validation",
    { timeout: 900_000 },
    async () => {
      const log = () => undefined;
      const options = { size: "small", reset: false, accountsOnly: false, now } as const;
      const first = await seedDemo({ sql, privilegedSql, options, log });

      expect(first.seeded).toBe(true);
      expect(first.validation.counts).toMatchObject({ people: 60 });
      expect(first.validation.objectsChecked).toBeGreaterThan(400);
      expect(first.validation.driveContentChecked).toBeGreaterThan(100);
      expect(first.validation.indexed?.drive).toBe(first.validation.driveContentChecked);
      expect(first.validation.indexed?.mail).toBeGreaterThan(0);
      expect(first.validation.indexed?.chat).toBeGreaterThan(0);
      expect(first.validation.indexed?.calendar).toBeGreaterThan(0);
      expect(first.validation.reconciledDocuments).toBeGreaterThan(0);
      expect(first.validation.auditRecords).toBeGreaterThan(0);
      expect(first.validation.loginsChecked).toBeGreaterThanOrEqual(3);
      expect(first.logins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ email: "admin@helix.local", password: "helix-admin-password" }),
          expect.objectContaining({ email: "user@helix.local", password: "helix-user-password" }),
        ]),
      );

      // An identical second run adds nothing and validates the same tenant again.
      const second = await seedDemo({ sql, privilegedSql, options, log });
      expect(second.seeded).toBe(false);
      expect(second.validation.counts).toEqual(first.validation.counts);
    },
  );
});
