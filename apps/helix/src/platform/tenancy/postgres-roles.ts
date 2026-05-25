import type postgres from "postgres";

export const DEFAULT_TENANT_APP_ROLE = "helix_app_role";
export const TENANT_ROLE_PREFIX = "helix_tenant_";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const POSTGRES_IDENTIFIER_MAX_BYTES = 63;

export interface TenantPostgresRoleProvisioner {
  ensureRoleForOrg(orgId: string): Promise<void>;
}

export interface TenantRoleProvisioningInput {
  readonly orgId: string;
  readonly appRole?: string;
}

export interface TenantPostgresContextInput {
  readonly orgId: string;
  readonly setRole?: boolean;
}

export class PostgresTenantRoleProvisioner implements TenantPostgresRoleProvisioner {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: { readonly appRole?: string } = {},
  ) {}

  async ensureRoleForOrg(orgId: string): Promise<void> {
    await this.sql.unsafe(
      buildTenantRoleProvisioningSql({
        orgId,
        ...(this.options.appRole === undefined ? {} : { appRole: this.options.appRole }),
      }),
    );
  }
}

export async function withTenantPostgresContext<T>(
  sql: postgres.Sql,
  input: TenantPostgresContextInput,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await applyTenantPostgresContext(tx, input);
    return callback(tx);
  });
  return result as T;
}

export async function applyTenantPostgresContext(
  tx: postgres.TransactionSql,
  input: TenantPostgresContextInput,
): Promise<void> {
  const orgId = normalizeOrgId(input.orgId);
  if (input.setRole !== false) {
    await tx.unsafe(buildTenantSetLocalRoleSql(orgId));
  }
  await tx`select set_config('helix.org_id', ${orgId}, true)`;
}

export function buildTenantSetLocalRoleSql(orgId: string): string {
  return `set local role ${quoteIdentifier(tenantPostgresRoleName(orgId))}`;
}

export function buildTenantRoleProvisioningSql(input: TenantRoleProvisioningInput): string {
  const roleName = tenantPostgresRoleName(input.orgId);
  const appRole = normalizePostgresIdentifier(input.appRole ?? DEFAULT_TENANT_APP_ROLE, "appRole");

  return [
    "do $$",
    "begin",
    `  if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(roleName)}) then`,
    `    create role ${quoteIdentifier(roleName)} noinherit nologin;`,
    "  end if;",
    `  grant ${quoteIdentifier(appRole)} to ${quoteIdentifier(roleName)};`,
    "end",
    "$$;",
  ].join("\n");
}

export function tenantPostgresRoleName(orgId: string): string {
  const normalizedOrgId = normalizeOrgId(orgId);
  return normalizePostgresIdentifier(
    `${TENANT_ROLE_PREFIX}${normalizedOrgId.replaceAll("-", "_")}`,
    "tenantRole",
  );
}

function normalizeOrgId(orgId: string): string {
  const normalizedOrgId = orgId.toLowerCase();
  if (!UUID_PATTERN.test(normalizedOrgId)) {
    throw new TypeError("orgId must be a valid UUID before deriving a tenant Postgres role");
  }
  return normalizedOrgId;
}

function normalizePostgresIdentifier(value: string, label: string): string {
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  if (Buffer.byteLength(value, "utf8") > POSTGRES_IDENTIFIER_MAX_BYTES) {
    throw new TypeError(`${label} must be ${String(POSTGRES_IDENTIFIER_MAX_BYTES)} bytes or fewer`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${label} must not contain NUL bytes`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
