import postgres from "postgres";
import { tenantAwarePostgresSql } from "../platform/tenancy/postgres-roles.js";
import { env as loadValidatedEnv, type Env, type MigrationEnv } from "../config/env.js";
import {
  resolvePostgresSsl,
  type PostgresConnectionEnvironment,
} from "../config/postgres-connection.js";
import {
  assertProductionDeploymentConfiguration,
  assertProductionPostgresConfiguration,
} from "../config/production-assertions.js";

const DEFAULT_DATABASE_URL = "postgres://helix:helix_dev_password@localhost:28432/helix";

export interface DatabaseUrlEnvironment {
  readonly DATABASE_URL?: string | undefined;
  readonly HELIX_MIGRATION_DATABASE_URL?: string | undefined;
  readonly MIGRATION_DATABASE_URL?: string | undefined;
}

/** Read a field that is present on the source object and holds a string value. */
function presentStringField(source: object, key: string): string | undefined {
  if (!(key in source)) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function resolveDatabaseUrl(source: DatabaseUrlEnvironment | Env = process.env): string {
  const url = presentStringField(source, "DATABASE_URL");
  return url && url.length > 0 ? url : DEFAULT_DATABASE_URL;
}

export function resolveMigrationDatabaseUrl(
  source: DatabaseUrlEnvironment | Env = process.env,
): string {
  // The first *present* string override wins, and only then is it tested for
  // emptiness: a present-but-empty HELIX_MIGRATION_DATABASE_URL therefore falls
  // through to DATABASE_URL rather than to MIGRATION_DATABASE_URL.
  const migrationUrl =
    presentStringField(source, "HELIX_MIGRATION_DATABASE_URL") ??
    presentStringField(source, "MIGRATION_DATABASE_URL");
  return migrationUrl && migrationUrl.length > 0 ? migrationUrl : resolveDatabaseUrl(source);
}

export interface SqlClientOptions {
  readonly poolMax?: number;
  readonly environment?: PostgresConnectionEnvironment;
  readonly readTlsFile?: (path: string) => Buffer;
}

export function createSqlClient(
  databaseUrl = resolveDatabaseUrl(),
  options: SqlClientOptions = {},
): postgres.Sql {
  const validatedEnv = loadValidatedEnv();
  return tenantAwarePostgresSql(
    createConfiguredSqlClient(databaseUrl, {
      poolMax: options.poolMax ?? validatedEnv.POSTGRES_POOL_MAX,
      environment: options.environment ?? validatedEnv,
      readTlsFile: options.readTlsFile,
    }),
  );
}

export interface MigrationSqlClientOptions {
  readonly readTlsFile?: (path: string) => Buffer;
}

/**
 * Build the one-shot migrator connection without loading application-only
 * production configuration.
 */
export function createMigrationSqlClient(
  migrationEnv: MigrationEnv,
  options: MigrationSqlClientOptions = {},
): postgres.Sql {
  const databaseUrl = resolveMigrationDatabaseUrl(migrationEnv);
  assertProductionDeploymentConfiguration(migrationEnv);
  assertProductionPostgresConfiguration(databaseUrl, migrationEnv);
  return createConfiguredSqlClient(databaseUrl, {
    poolMax: migrationEnv.POSTGRES_POOL_MAX,
    environment: migrationEnv,
    readTlsFile: options.readTlsFile,
  });
}

interface ConfiguredSqlClientOptions {
  readonly poolMax: number;
  readonly environment: PostgresConnectionEnvironment;
  readonly readTlsFile: ((path: string) => Buffer) | undefined;
}

function createConfiguredSqlClient(
  databaseUrl: string,
  options: ConfiguredSqlClientOptions,
): postgres.Sql {
  const ssl = resolvePostgresSsl(options.environment, options.readTlsFile);
  return postgres(databaseUrl, {
    max: options.poolMax,
    prepare: false,
    ssl,
  });
}

interface RuntimeRoleSafetyRow {
  readonly role_name: string;
  readonly session_role_name: string;
  readonly is_superuser: boolean;
  readonly bypasses_rls: boolean;
  readonly owns_tenant_table: boolean;
  readonly can_assume_privileged_role: boolean;
}

interface TenantRlsGapRow {
  readonly table_name: string;
}

/** Refuse a production runtime identity that can bypass tenant RLS. */
export async function assertTenantSafeDatabaseRole(sql: postgres.Sql): Promise<void> {
  const rows = (await sql`
    select
      current_user as role_name,
      session_user as session_role_name,
      current_role_row.rolsuper as is_superuser,
      current_role_row.rolbypassrls as bypasses_rls,
      exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public'
          and c.relkind in ('r', 'p')
          and a.attname = 'org_id'
          and not a.attisdropped
          and c.relowner = current_role_row.oid
      ) as owns_tenant_table,
      exists (
        select 1
        from pg_roles assumable
        where assumable.oid <> current_role_row.oid
          and pg_has_role(current_user, assumable.oid, 'MEMBER')
          and (
            assumable.rolsuper
            or assumable.rolbypassrls
            or exists (
              select 1
              from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
              join pg_attribute a on a.attrelid = c.oid
              where n.nspname = 'public'
              and c.relkind in ('r', 'p')
                and a.attname = 'org_id'
                and not a.attisdropped
                and c.relowner = assumable.oid
            )
          )
      ) as can_assume_privileged_role
    from pg_roles current_role_row
    where current_role_row.rolname = current_user
  `) as unknown as readonly RuntimeRoleSafetyRow[];
  const role = rows[0];
  if (
    role === undefined ||
    role.session_role_name !== role.role_name ||
    role.is_superuser ||
    role.bypasses_rls ||
    role.owns_tenant_table ||
    role.can_assume_privileged_role
  ) {
    throw new Error(
      `Unsafe runtime database role '${role?.role_name ?? "unknown"}': connect directly as a non-owner, NOSUPERUSER, NOBYPASSRLS application role.`,
    );
  }
}

/** Fail deployment when any public org_id table lacks the one canonical forced-RLS policy. */
export async function assertTenantRlsCoverage(sql: postgres.Sql): Promise<void> {
  const gaps = (await sql`
    select c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.attname = 'org_id'
      and not a.attisdropped
      and (
        not c.relrowsecurity
        or not c.relforcerowsecurity
        or 1 <> (
          select count(*)
          from pg_policy p
          where p.polrelid = c.oid
            and p.polname = 'helix_tenant_isolation'
            and p.polcmd = '*'
            and position('helix_current_org_id()' in pg_get_expr(p.polqual, p.polrelid)) > 0
            and position('helix_current_org_id()' in pg_get_expr(p.polwithcheck, p.polrelid)) > 0
        )
        or 1 <> (select count(*) from pg_policy p where p.polrelid = c.oid)
      )
    order by c.relname
  `) as unknown as readonly TenantRlsGapRow[];
  if (gaps.length > 0) {
    throw new Error(
      `Tenant RLS coverage is incomplete: ${gaps.map((row) => row.table_name).join(", ")}`,
    );
  }
}
