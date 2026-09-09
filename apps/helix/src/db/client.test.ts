import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import {
  assertTenantRlsCoverage,
  assertTenantSafeDatabaseRole,
  resolveDatabaseUrl,
  resolveMigrationDatabaseUrl,
} from "./client.js";

describe("database URL resolution", () => {
  it("uses the local development database URL by default", () => {
    expect(resolveDatabaseUrl({})).toBe(
      "postgres://helix:helix_dev_password@localhost:28432/helix",
    );
  });

  it("uses DATABASE_URL for the runtime app connection", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://app/runtime" })).toBe(
      "postgres://app/runtime",
    );
  });

  it("allows migrations to use elevated database credentials", () => {
    expect(
      resolveMigrationDatabaseUrl({
        DATABASE_URL: "postgres://app/runtime",
        HELIX_MIGRATION_DATABASE_URL: "postgres://admin/migrations",
      }),
    ).toBe("postgres://admin/migrations");
  });

  it("keeps MIGRATION_DATABASE_URL as a shorter alias for local tooling", () => {
    expect(
      resolveMigrationDatabaseUrl({
        DATABASE_URL: "postgres://app/runtime",
        MIGRATION_DATABASE_URL: "postgres://admin/alias",
      }),
    ).toBe("postgres://admin/alias");
  });
});

describe("runtime database role safety", () => {
  it("accepts only a non-owner role without RLS bypass authority", async () => {
    await expect(
      assertTenantSafeDatabaseRole(roleSql({ role_name: "helix_app" })),
    ).resolves.toBeUndefined();
  });

  for (const unsafe of [
    { session_role_name: "helix_owner" },
    { is_superuser: true },
    { bypasses_rls: true },
    { owns_tenant_table: true },
    { can_assume_privileged_role: true },
  ]) {
    it(`rejects ${Object.keys(unsafe)[0] ?? "unknown"} runtime authority`, async () => {
      await expect(assertTenantSafeDatabaseRole(roleSql(unsafe))).rejects.toThrow(
        "non-owner, NOSUPERUSER, NOBYPASSRLS",
      );
    });
  }
});

describe("tenant RLS schema coverage", () => {
  it("accepts a schema with no uncovered org_id table", async () => {
    await expect(assertTenantRlsCoverage(rowsSql([]))).resolves.toBeUndefined();
  });

  it("names every uncovered org_id table", async () => {
    await expect(
      assertTenantRlsCoverage(
        rowsSql([{ table_name: "docs_revisions" }, { table_name: "drive_blobs" }]),
      ),
    ).rejects.toThrow("docs_revisions, drive_blobs");
  });
});

function roleSql(
  overrides: Partial<{
    role_name: string;
    session_role_name: string;
    is_superuser: boolean;
    bypasses_rls: boolean;
    owns_tenant_table: boolean;
    can_assume_privileged_role: boolean;
  }>,
): postgres.Sql {
  const row = {
    role_name: "helix_app",
    session_role_name: "helix_app",
    is_superuser: false,
    bypasses_rls: false,
    owns_tenant_table: false,
    can_assume_privileged_role: false,
    ...overrides,
  };
  return (() => Promise.resolve([row])) as unknown as postgres.Sql;
}

function rowsSql(rows: readonly { readonly table_name: string }[]): postgres.Sql {
  return (() => Promise.resolve(rows)) as unknown as postgres.Sql;
}
