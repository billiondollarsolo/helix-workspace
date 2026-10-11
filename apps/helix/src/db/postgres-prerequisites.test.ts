import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  compareExtensionVersions,
  evaluatePostgresPrerequisites,
  isTransientPostgresConnectionError,
  PostgresPrerequisiteError,
  waitForPostgresPrerequisites,
  type PostgresExtensionSnapshot,
  type PostgresServerSnapshot,
} from "./postgres-prerequisites.js";

const installed: readonly PostgresExtensionSnapshot[] = [
  { name: "vector", availableVersion: "0.8.5", installedVersion: "0.8.5", trusted: false },
  { name: "pgcrypto", availableVersion: "1.4", installedVersion: "1.4", trusted: true },
  { name: "pg_trgm", availableVersion: "1.6", installedVersion: "1.6", trusted: true },
];

function snapshot(overrides: Partial<PostgresServerSnapshot> = {}): PostgresServerSnapshot {
  return {
    serverVersionNum: 180_006,
    serverVersion: "18.6",
    databaseName: "helix",
    roleName: "helix_migrator",
    isSuperuser: false,
    canCreateInDatabase: true,
    extensions: installed,
    ...overrides,
  };
}

function withExtension(name: string, patch: Partial<PostgresExtensionSnapshot>) {
  return installed.map((extension) =>
    extension.name === name ? { ...extension, ...patch } : extension,
  );
}

describe("PostgreSQL prerequisites", () => {
  it("accepts PostgreSQL 18 with every required extension installed", () => {
    expect(evaluatePostgresPrerequisites(snapshot(), "migration")).toEqual({
      errors: [],
      warnings: [],
    });
    expect(evaluatePostgresPrerequisites(snapshot(), "runtime")).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("rejects servers older than PostgreSQL 18", () => {
    const { errors } = evaluatePostgresPrerequisites(
      snapshot({ serverVersionNum: 170_005, serverVersion: "17.5" }),
      "migration",
    );
    expect(errors).toEqual([expect.stringContaining("PostgreSQL 18 or newer is required")]);
    expect(errors[0]).toContain("17.5");
  });

  it("tells a non-superuser owner how to pre-create the untrusted vector extension", () => {
    const { errors } = evaluatePostgresPrerequisites(
      snapshot({ extensions: withExtension("vector", { installedVersion: null }) }),
      "migration",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("role helix_migrator cannot create it");
    expect(errors[0]).toContain("not a trusted extension");
    expect(errors[0]).toContain("CREATE EXTENSION IF NOT EXISTS vector;");
    expect(errors[0]).toContain("postInitApplicationSQL");
  });

  it("lets a database owner create trusted extensions and a superuser create pgvector", () => {
    const missingTrusted = snapshot({
      extensions: withExtension("pg_trgm", { installedVersion: null }),
    });
    expect(evaluatePostgresPrerequisites(missingTrusted, "migration").errors).toEqual([]);
    const notOwner = evaluatePostgresPrerequisites(
      { ...missingTrusted, canCreateInDatabase: false },
      "migration",
    ).errors;
    expect(notOwner).toEqual([expect.stringContaining("no CREATE privilege on the database")]);
    const superuser = snapshot({
      isSuperuser: true,
      extensions: withExtension("vector", { installedVersion: null }),
    });
    expect(evaluatePostgresPrerequisites(superuser, "migration").errors).toEqual([]);
  });

  it("reports an unpackaged or too-old pgvector", () => {
    const unpackaged = evaluatePostgresPrerequisites(
      snapshot({
        isSuperuser: true,
        extensions: withExtension("vector", { installedVersion: null, availableVersion: null }),
      }),
      "migration",
    );
    expect(unpackaged.errors).toEqual([expect.stringContaining("is not available")]);

    const oldPackage = evaluatePostgresPrerequisites(
      snapshot({
        isSuperuser: true,
        extensions: withExtension("vector", { installedVersion: null, availableVersion: "0.7.4" }),
      }),
      "migration",
    );
    expect(oldPackage.errors).toEqual([expect.stringContaining("packages vector 0.7.4")]);
  });

  it("requires ALTER EXTENSION UPDATE below the minimum and warns when only behind", () => {
    const belowMinimum = evaluatePostgresPrerequisites(
      snapshot({ extensions: withExtension("vector", { installedVersion: "0.7.0" }) }),
      "runtime",
    );
    expect(belowMinimum.errors).toEqual([
      expect.stringContaining("ALTER EXTENSION vector UPDATE;"),
    ]);

    const behind = evaluatePostgresPrerequisites(
      snapshot({ extensions: withExtension("vector", { installedVersion: "0.8.1" }) }),
      "runtime",
    );
    expect(behind.errors).toEqual([]);
    expect(behind.warnings).toEqual([expect.stringContaining("server provides 0.8.5")]);
  });

  it("fails the runtime phase when the schema extension is missing", () => {
    const { errors } = evaluatePostgresPrerequisites(
      snapshot({ extensions: withExtension("vector", { installedVersion: null }) }),
      "runtime",
    );
    expect(errors).toEqual([expect.stringContaining("Run the Helix migration job")]);
  });

  it("compares dotted extension versions numerically", () => {
    expect(compareExtensionVersions("0.10.0", "0.8.5")).toBe(1);
    expect(compareExtensionVersions("0.8.0", "0.8")).toBe(0);
    expect(compareExtensionVersions("0.7.4", "0.8.0")).toBe(-1);
  });

  it("classifies only connection failures as transient", () => {
    expect(isTransientPostgresConnectionError({ code: "ECONNREFUSED" })).toBe(true);
    expect(isTransientPostgresConnectionError({ code: "57P03" })).toBe(true);
    expect(isTransientPostgresConnectionError({ code: "08006" })).toBe(true);
    expect(isTransientPostgresConnectionError({ code: "42501" })).toBe(false);
    expect(isTransientPostgresConnectionError(new Error("boom"))).toBe(false);
  });
});

describe("waitForPostgresPrerequisites", () => {
  function snapshotSql(fail: readonly unknown[]): postgres.Sql {
    const failures = [...fail];
    return vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("server_version_num")) {
        if (failures.length > 0) {
          throw failures.shift();
        }
        return [
          {
            server_version_num: 180_006,
            server_version: "18.6",
            database_name: "helix",
            role_name: "helix_migrator",
            is_superuser: false,
            can_create_in_database: true,
          },
        ];
      }
      return installed.map((extension) => ({
        name: extension.name,
        available_version: extension.availableVersion,
        installed_version: extension.installedVersion,
        trusted: extension.trusted,
      }));
    }) as unknown as postgres.Sql;
  }

  it("retries connection failures until the server answers", async () => {
    let clock = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      clock += milliseconds;
    });
    const onRetry = vi.fn();
    const sql = snapshotSql([{ code: "ECONNREFUSED" }, { code: "57P03" }]);
    await expect(
      waitForPostgresPrerequisites(sql, {
        phase: "migration",
        waitSeconds: 60,
        now: () => clock,
        sleep,
        onRetry,
      }),
    ).resolves.toEqual({ errors: [], warnings: [] });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("does not wait on configuration errors or past the deadline", async () => {
    const permission = Object.assign(new Error("permission denied"), { code: "42501" });
    await expect(
      waitForPostgresPrerequisites(snapshotSql([permission]), {
        phase: "migration",
        waitSeconds: 60,
        sleep: () => Promise.reject(new Error("must not sleep")),
      }),
    ).rejects.toBe(permission);

    const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    await expect(
      waitForPostgresPrerequisites(snapshotSql([refused]), { phase: "migration", waitSeconds: 0 }),
    ).rejects.toBe(refused);
  });

  it("throws an aggregated, actionable error", async () => {
    const error = new PostgresPrerequisiteError(["first", "second"]);
    expect(error.message).toBe(
      "PostgreSQL does not meet the Helix database prerequisites:\n  - first\n  - second",
    );
  });
});
