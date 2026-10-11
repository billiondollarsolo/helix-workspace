import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The superuser bootstrap exists in two places: the Compose init scripts and
// the CloudNativePG postInitApplicationSQL rendered by the Helm chart. Both
// must install every extension the migrations create and provision the roles
// with exactly the attributes migration 0090 enforces, or a non-superuser
// migration owner fails on CREATE EXTENSION / ALTER ROLE.
const migrationsDir = resolve("apps/helix/src/db/migrations");
const migrationSql = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(resolve(migrationsDir, name), "utf8"))
  .join("\n");
const composeExtensions = readFileSync(resolve("infra/postgres/init/001_extensions.sql"), "utf8");
const composeRoles = readFileSync(resolve("infra/postgres/init/002_production_roles.sh"), "utf8");
const helmHelpers = readFileSync(resolve("infra/helm/helix/templates/_helpers.tpl"), "utf8");
const cnpgBootstrap = helmHelpers.slice(
  helmHelpers.indexOf('{{- define "helix.cloudnativepgBootstrapSQL" -}}'),
  helmHelpers.indexOf("{{- end -}}", helmHelpers.indexOf("helix.cloudnativepgBootstrapSQL")),
);
const roleMigration = readFileSync(
  resolve(migrationsDir, "0090_postgres_runtime_roles.sql"),
  "utf8",
);
const prerequisites = readFileSync(resolve("apps/helix/src/db/postgres-prerequisites.ts"), "utf8");

const migrationExtensions = [
  ...new Set(
    [...migrationSql.matchAll(/create extension if not exists ([a-z_]+)/giu)].map((match) =>
      match[1].toLowerCase(),
    ),
  ),
].sort();

function attributes(text) {
  return text
    .toUpperCase()
    .split(/\s+/u)
    .filter((word) =>
      /^(NO)?(LOGIN|SUPERUSER|BYPASSRLS|INHERIT|CREATEDB|CREATEROLE|REPLICATION)$/u.test(word),
    )
    .sort();
}

function roleAttributes(source, pattern) {
  return Object.fromEntries(
    [...source.matchAll(pattern)].map((match) => [match[1].toLowerCase(), attributes(match[2])]),
  );
}

describe("PostgreSQL bootstrap contract", () => {
  it("knows which extensions the migrations create", () => {
    expect(migrationExtensions).toEqual(["pg_trgm", "pgcrypto", "vector"]);
  });

  it("installs every migration extension in Compose, CloudNativePG, and the prerequisite check", () => {
    for (const extension of migrationExtensions) {
      expect(`${composeExtensions}\n${composeRoles}`).toContain(
        `CREATE EXTENSION IF NOT EXISTS ${extension};`,
      );
      expect(cnpgBootstrap).toContain(`- CREATE EXTENSION IF NOT EXISTS ${extension}\n`);
      expect(prerequisites).toContain(`name: "${extension}"`);
    }
  });

  it("provisions the role model with exactly the attributes migration 0090 enforces", () => {
    const expected = roleAttributes(roleMigration, /'alter role (helix_[a-z_]+) ([a-z ]+)'/gu);
    expect(Object.keys(expected).sort()).toEqual([
      "helix_app",
      "helix_migration_owner",
      "helix_readonly",
      "helix_worker",
    ]);
    const cnpg = roleAttributes(cnpgBootstrap, /CREATE ROLE (helix_[a-z_]+) ([A-Z ]+);/gu);
    expect(cnpg).toEqual(expected);

    const compose = {
      ...roleAttributes(composeRoles, /'CREATE ROLE (helix_[a-z_]+) ([A-Z %]+)'/gu),
      ...Object.fromEntries(
        ["helix_worker", "helix_readonly"].map((role) => [
          role,
          attributes(/'CREATE ROLE %I ([A-Z ]+)',\n\s+role_name/u.exec(composeRoles)?.[1] ?? ""),
        ]),
      ),
    };
    for (const [role, attrs] of Object.entries(expected)) {
      expect(compose[role], role).toEqual(attrs);
    }
  });

  it("creates pg_trgm after the function grants, as a superuser migration does", () => {
    const trgm = "CREATE EXTENSION IF NOT EXISTS pg_trgm";
    const revoke = "REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC";
    for (const source of [cnpgBootstrap, composeRoles]) {
      expect(source.indexOf(trgm)).toBeGreaterThan(source.indexOf(revoke));
    }
    expect(composeExtensions).not.toContain(trgm);
    expect(migrationSql.indexOf("create extension if not exists pg_trgm")).toBeGreaterThan(
      migrationSql.indexOf("revoke execute on all functions in schema public from public"),
    );
  });

  it("grants the migration login the schema owner role and matching function ACLs", () => {
    expect(cnpgBootstrap).toContain("- GRANT helix_migration_owner TO {{ $owner }}");
    expect(composeRoles).toContain("GRANT helix_migration_owner TO helix_migrator;");
    for (const source of [cnpgBootstrap, composeRoles]) {
      expect(source).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC");
      expect(source).toContain(
        "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO helix_migration_owner, helix_app, helix_worker",
      );
    }
    expect(roleMigration).toContain(
      "grant execute on all functions in schema public to helix_migration_owner, helix_app, helix_worker;",
    );
  });
});
