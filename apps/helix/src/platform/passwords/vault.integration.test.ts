import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresPasswordVaultStore } from "./vault.js";

const databaseUrl = process.env.DATABASE_URL;
describe(
  "personal vault PostgreSQL isolation and concurrent saves",
  { skip: databaseUrl === undefined },
  () => {
    const orgA = randomUUID(),
      orgB = randomUUID(),
      personA = randomUUID(),
      personB = randomUUID(),
      colleague = randomUUID();
    let sql: postgres.Sql;
    let store: PostgresPasswordVaultStore;
    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("A live test database is required.");
      sql = postgres(databaseUrl, { max: 6 });
      store = new PostgresPasswordVaultStore(tenantAwarePostgresSql(sql));
      await sql`insert into orgs (id, slug, display_name, status) values (${orgA}, ${`vault-test-${orgA}`}, 'Vault fixture A', 'active'), (${orgB}, ${`vault-test-${orgB}`}, 'Vault fixture B', 'active')`;
      await sql`insert into actors (id, org_id, type, display_name) values (${personA}, ${orgA}, 'user', 'Vault A'), (${colleague}, ${orgA}, 'user', 'Colleague'), (${personB}, ${orgB}, 'user', 'Vault B')`;
    });
    afterAll(async () => {
      await sql`delete from orgs where id in (${orgA}, ${orgB})`;
      await sql.end();
    });
    const asPerson = <T>(orgId: string, actorId: string, operation: () => Promise<T>) =>
      withTenantPostgresContext(sql, { orgId, actorId }, async (tx) => {
        await tx`set local role helix_app`;
        return operation();
      });
    it("allows one different-data writer and preserves an encrypted recovery copy", async () => {
      const first = Buffer.alloc(64, 1),
        second = Buffer.alloc(64, 2),
        third = Buffer.alloc(64, 3);
      expect(await asPerson(orgA, personA, () => store.put(orgA, personA, 0, first))).toBe(1);
      const attempts = await Promise.all([
        asPerson(orgA, personA, () => store.put(orgA, personA, 1, second)),
        asPerson(orgA, personA, () => store.put(orgA, personA, 1, third)),
      ]);
      expect(attempts.sort()).toEqual([2, null]);
      const current = await asPerson(orgA, personA, () => store.get(orgA, personA));
      expect(current.vault?.version).toBe(2);
      expect(current.previous?.ciphertext).toBe(first.toString("base64"));
      if (current.vault === null) throw new Error("The saved fixture vault is missing.");
      const winner = Buffer.from(current.vault.ciphertext, "base64");
      expect(await asPerson(orgA, personA, () => store.put(orgA, personA, 1, winner))).toBe(2);
      expect((await asPerson(orgA, personA, () => store.get(orgA, personA))).previous).toEqual(
        current.previous,
      );
    });
    it("RLS hides another person in the same tenant and all foreign tenant rows", async () => {
      expect(
        await asPerson(orgB, personB, () => store.put(orgB, personB, 0, Buffer.alloc(64, 4))),
      ).toBe(1);
      expect(await asPerson(orgA, colleague, () => store.get(orgA, personA))).toEqual({
        vault: null,
        previous: null,
      });
      expect(await asPerson(orgA, personA, () => store.get(orgB, personB))).toEqual({
        vault: null,
        previous: null,
      });
      expect(
        await asPerson(orgA, colleague, () => store.put(orgA, personA, 2, Buffer.alloc(64, 5))),
      ).toBeNull();
      await expect(
        asPerson(orgA, personA, () => store.put(orgB, personB, 0, Buffer.alloc(64, 6))),
      ).rejects.toMatchObject({ code: "42501" });
    });
  },
);
