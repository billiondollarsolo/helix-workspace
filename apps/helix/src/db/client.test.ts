import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl, resolveMigrationDatabaseUrl } from "./client.js";

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
