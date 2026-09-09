import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  setTenantPostgresActorId,
  tenantAwarePostgresSql,
  withTenantIoSagaPostgresContext,
  withTenantPostgresContext,
} from "./postgres-roles.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";

describe("withTenantPostgresContext", () => {
  it("sets the transaction-local org GUC before invoking the callback", async () => {
    const recording = createRecordingSql();

    const result = await withTenantPostgresContext(recording.sql, { orgId }, async (tx) => {
      await tx`select 1`;
      return "ok";
    });

    expect(result).toBe("ok");
    expect(recording.calls).toEqual([
      {
        kind: "begin",
      },
      {
        kind: "query",
        text: expect.stringContaining("set_config('helix.org_id', ?, true)"),
        values: [orgId, ""],
      },
      {
        kind: "query",
        text: "select 1",
        values: [],
      },
    ]);
  });

  it("rejects invalid org ids before opening a tenant query", async () => {
    const recording = createRecordingSql();
    await expect(
      withTenantPostgresContext(
        recording.sql,
        { orgId: `${orgId}"; reset role; --` },
        async () => undefined,
      ),
    ).rejects.toThrow("orgId must be a valid UUID");
  });

  it("routes shared-store and nested transaction queries through the active tenant and actor", async () => {
    const recording = createRecordingSql();
    const sql = tenantAwarePostgresSql(recording.sql);

    await withTenantPostgresContext(sql, { orgId }, async () => {
      await expect(setTenantPostgresActorId(actorId)).resolves.toBe(true);
      await sql`select display_name from actors`;
      await sql.begin(async (tx) => tx`select count(*) from objects`);
      await expect(
        withTenantPostgresContext(
          sql,
          { orgId: "33333333-3333-4333-8333-333333333333" },
          async () => undefined,
        ),
      ).rejects.toThrow("cannot switch tenant context");
    });

    expect(recording.calls).toEqual(
      expect.arrayContaining([
        {
          kind: "query",
          text: "select set_config('helix.actor_id', ?, true)",
          values: [actorId],
        },
        { kind: "query", text: "select display_name from actors", values: [] },
        { kind: "savepoint" },
        { kind: "query", text: "select count(*) from objects", values: [] },
      ]),
    );
  });

  it("runs an authenticated I/O saga phase in a fresh tenant-scoped transaction", async () => {
    const recording = createRecordingSql();
    const sql = tenantAwarePostgresSql(recording.sql);

    await withTenantPostgresContext(sql, { orgId }, async () => {
      await withTenantIoSagaPostgresContext(sql, { orgId, actorId }, async (tx) => {
        await tx`select 'short saga phase'`;
      });
      await sql`select 'ambient request phase'`;
    });

    expect(recording.calls.filter((call) => call.kind === "begin")).toHaveLength(2);
    expect(recording.calls.filter((call) => call.kind === "savepoint")).toHaveLength(0);
    expect(recording.calls).toEqual(
      expect.arrayContaining([
        {
          kind: "query",
          text: expect.stringContaining("set_config('helix.org_id', ?, true)"),
          values: [orgId, actorId],
        },
        { kind: "query", text: "select 'short saga phase'", values: [] },
        { kind: "query", text: "select 'ambient request phase'", values: [] },
      ]),
    );
  });

  it("requires service mode explicitly and never elevates an actor or crosses tenants", async () => {
    const recording = createRecordingSql();
    const sql = tenantAwarePostgresSql(recording.sql);

    await withTenantPostgresContext(sql, { orgId }, async () => {
      await expect(
        withTenantIoSagaPostgresContext(sql, { orgId }, async () => undefined),
      ).rejects.toThrow("requires an authenticated actor context");
      await withTenantIoSagaPostgresContext(sql, { orgId, serviceContext: true }, async (tx) => {
        await tx`select 'service phase'`;
      });
      await expect(
        withTenantIoSagaPostgresContext(
          sql,
          { orgId: "33333333-3333-4333-8333-333333333333", serviceContext: true },
          async () => undefined,
        ),
      ).rejects.toThrow("cannot switch tenant context");
    });

    await withTenantPostgresContext(sql, { orgId, actorId }, async () => {
      await expect(
        withTenantIoSagaPostgresContext(sql, { orgId, serviceContext: true }, async () => undefined),
      ).rejects.toThrow("requires an existing actor-free context");
    });
    expect(recording.calls).toContainEqual({
      kind: "query",
      text: expect.stringContaining("set_config('helix.org_id', ?, true)"),
      values: [orgId, ""],
    });
  });
});

type RecordedCall =
  | { readonly kind: "begin" }
  | { readonly kind: "savepoint" }
  | { readonly kind: "query"; readonly text: string; readonly values: readonly unknown[] };

function createRecordingSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ kind: "query", text: strings.join("?"), values });
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) => {
      calls.push({ kind: "begin" });
      return callback(sql as unknown as postgres.TransactionSql);
    },
    savepoint: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) => {
      calls.push({ kind: "savepoint" });
      return callback(sql as unknown as postgres.TransactionSql);
    },
  });
  return { sql: sql as unknown as postgres.Sql, calls };
}
