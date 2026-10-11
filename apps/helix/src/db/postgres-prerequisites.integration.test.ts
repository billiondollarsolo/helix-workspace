import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../test-support/live-suite.js";
import {
  assertPostgresPrerequisites,
  PostgresPrerequisiteError,
  readPostgresServerSnapshot,
} from "./postgres-prerequisites.js";

describe.skipIf(skipUnlessLiveDatabase("PostgreSQL prerequisites"))(
  "PostgreSQL prerequisites against a live server",
  () => {
    const admin = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    const cleanup: (() => Promise<unknown>)[] = [];

    afterAll(async () => {
      for (const step of cleanup.reverse()) await step();
      await admin.end();
    });

    it("serves the migrated schema on PostgreSQL 18 with pgvector >= 0.8", async () => {
      const snapshot = await readPostgresServerSnapshot(admin);
      expect(Math.floor(snapshot.serverVersionNum / 10_000)).toBeGreaterThanOrEqual(18);
      const vector = snapshot.extensions.find((extension) => extension.name === "vector");
      expect(vector?.installedVersion).toMatch(/^0\.(8|9|\d{2,})\./u);
      expect(vector?.trusted).toBe(false);
      await expect(assertPostgresPrerequisites(admin, "runtime")).resolves.toMatchObject({
        errors: [],
      });
    });

    it("explains how to bootstrap pgvector for a non-superuser database owner", async (context) => {
      const [{ is_superuser: isSuperuser } = { is_superuser: false }] = await admin<
        { is_superuser: boolean }[]
      >`select rolsuper as is_superuser from pg_roles where rolname = current_user`;
      if (!isSuperuser) {
        context.skip("needs a superuser DATABASE_URL to create a scratch owner and database");
      }
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const owner = `helix_prereq_owner_${suffix}`;
      const database = `helix_prereq_${suffix}`;
      const password = `Prereq_${randomUUID()}`;
      await admin.unsafe(
        `create role ${owner} login nosuperuser nocreatedb nocreaterole password '${password}'`,
      );
      cleanup.push(() => admin.unsafe(`drop role if exists ${owner}`));
      await admin.unsafe(`create database ${database} owner ${owner}`);
      cleanup.push(() => admin.unsafe(`drop database if exists ${database} with (force)`));

      const url = new URL(process.env.DATABASE_URL ?? "");
      url.username = owner;
      url.password = password;
      url.pathname = `/${database}`;
      const ownerSql = postgres(url.href, { max: 1 });
      try {
        const failure = await assertPostgresPrerequisites(ownerSql, "migration").catch(
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(PostgresPrerequisiteError);
        const problems = (failure as PostgresPrerequisiteError).problems;
        // pgcrypto and pg_trgm are trusted: the owning login's migrations create them.
        expect(problems).toEqual([expect.stringContaining("vector is not a trusted extension")]);
        await expect(ownerSql`create extension vector`).rejects.toMatchObject({ code: "42501" });

        const adminUrl = new URL(process.env.DATABASE_URL ?? "");
        adminUrl.pathname = `/${database}`;
        const adminInDatabase = postgres(adminUrl.href, { max: 1 });
        try {
          await adminInDatabase`create extension if not exists vector`;
        } finally {
          await adminInDatabase.end();
        }
        await expect(assertPostgresPrerequisites(ownerSql, "migration")).resolves.toMatchObject({
          errors: [],
        });
      } finally {
        await ownerSql.end();
      }
    });
  },
);
