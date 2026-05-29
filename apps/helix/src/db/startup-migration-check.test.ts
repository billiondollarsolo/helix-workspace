import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import {
  assertNoPendingStartupMigrations,
  shouldCheckStartupMigrations,
} from "./startup-migration-check.js";

describe("startup migration check", () => {
  it("defaults on for local/dev and off for production", () => {
    expect(shouldCheckStartupMigrations({ NODE_ENV: "development" })).toBe(true);
    expect(shouldCheckStartupMigrations({ NODE_ENV: "test" })).toBe(true);
    expect(shouldCheckStartupMigrations({ NODE_ENV: "production" })).toBe(false);
  });

  it("honors explicit overrides", () => {
    expect(
      shouldCheckStartupMigrations({
        NODE_ENV: "production",
        HELIX_STARTUP_MIGRATION_CHECK: "true",
      }),
    ).toBe(true);
    expect(
      shouldCheckStartupMigrations({
        NODE_ENV: "development",
        HELIX_STARTUP_MIGRATION_CHECK: "false",
      }),
    ).toBe(false);
  });

  it("fails fast with actionable pending migration details", async () => {
    const end = vi.fn(async () => undefined);
    const sql = fakeSql(end);

    await expect(
      assertNoPendingStartupMigrations({
        env: { NODE_ENV: "development" },
        createSql: () => sql,
        resolveSources: async () => [{ namespace: "platform", migrations: [] }],
        listPending: async () => [
          { namespace: "platform", name: "0062_slides_per_slide_revision.sql" },
        ],
      }),
    ).rejects.toMatchObject({
      name: "PendingStartupMigrationsError",
      pending: [{ namespace: "platform", name: "0062_slides_per_slide_revision.sql" }],
    });

    await expect(
      assertNoPendingStartupMigrations({
        env: { NODE_ENV: "development" },
        createSql: () => fakeSql(),
        resolveSources: async () => [{ namespace: "platform", migrations: [] }],
        listPending: async () => [
          { namespace: "platform", name: "0062_slides_per_slide_revision.sql" },
        ],
      }),
    ).rejects.toThrow("pnpm --filter @helix/app db:migrate");
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it("skips database access when disabled", async () => {
    const createSql = vi.fn(() => fakeSql());

    await expect(
      assertNoPendingStartupMigrations({
        env: { NODE_ENV: "development", HELIX_STARTUP_MIGRATION_CHECK: "false" },
        createSql,
      }),
    ).resolves.toEqual({ checked: false, pending: [] });
    expect(createSql).not.toHaveBeenCalled();
  });

  it("returns checked when there are no pending migrations", async () => {
    await expect(
      assertNoPendingStartupMigrations({
        env: { NODE_ENV: "development" },
        createSql: () => fakeSql(),
        resolveSources: async () => [{ namespace: "platform", migrations: [] }],
        listPending: async () => [],
      }),
    ).resolves.toEqual({ checked: true, pending: [] });
  });
});

function fakeSql(
  end: (options?: { readonly timeout?: number }) => Promise<void> = vi.fn(async () => undefined),
): postgres.Sql {
  return {
    end,
  } as unknown as postgres.Sql;
}
