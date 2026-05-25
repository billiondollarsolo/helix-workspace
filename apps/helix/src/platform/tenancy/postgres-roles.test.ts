import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TENANT_APP_ROLE,
  PostgresTenantRoleProvisioner,
  buildTenantSetLocalRoleSql,
  buildTenantRoleProvisioningSql,
  tenantPostgresRoleName,
  withTenantPostgresContext,
} from "./postgres-roles.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const defaultOrgId = "00000000-0000-0000-0000-000000000000";

describe("tenantPostgresRoleName", () => {
  it("derives a deterministic Postgres-safe role name from the org UUID", () => {
    expect(tenantPostgresRoleName(orgId)).toBe("helix_tenant_11111111_1111_4111_8111_111111111111");
  });

  it("accepts the nil UUID used by the single-tenant default org", () => {
    expect(tenantPostgresRoleName(defaultOrgId)).toBe(
      "helix_tenant_00000000_0000_0000_0000_000000000000",
    );
  });

  it("rejects unvalidated org ids before building SQL identifiers", () => {
    expect(() =>
      tenantPostgresRoleName('11111111-1111-4111-8111-111111111111"; drop role x; --'),
    ).toThrow("orgId must be a valid UUID");
  });
});

describe("buildTenantRoleProvisioningSql", () => {
  it("builds idempotent role creation and app-role grant SQL", () => {
    const sql = buildTenantRoleProvisioningSql({ orgId });

    expect(sql).toContain("if not exists (select 1 from pg_roles");
    expect(sql).toContain('"helix_tenant_11111111_1111_4111_8111_111111111111" noinherit nologin');
    expect(sql).toContain(
      `grant "${DEFAULT_TENANT_APP_ROLE}" to "helix_tenant_11111111_1111_4111_8111_111111111111"`,
    );
    expect(sql).not.toContain(orgId);
  });

  it("quotes configured app role identifiers", () => {
    const sql = buildTenantRoleProvisioningSql({ orgId, appRole: 'app"role' });

    expect(sql).toContain(
      'grant "app""role" to "helix_tenant_11111111_1111_4111_8111_111111111111"',
    );
  });
});

describe("buildTenantSetLocalRoleSql", () => {
  it("quotes the normalized tenant role identifier", () => {
    expect(buildTenantSetLocalRoleSql(orgId)).toBe(
      'set local role "helix_tenant_11111111_1111_4111_8111_111111111111"',
    );
  });
});

describe("withTenantPostgresContext", () => {
  it("sets the tenant role and org GUC before invoking the callback", async () => {
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
        kind: "unsafe",
        text: 'set local role "helix_tenant_11111111_1111_4111_8111_111111111111"',
      },
      {
        kind: "query",
        text: "select set_config('helix.org_id', ?, true)",
        values: [orgId],
      },
      {
        kind: "query",
        text: "select 1",
        values: [],
      },
    ]);
  });

  it("can set only the org GUC for readiness tests before role grants exist", async () => {
    const recording = createRecordingSql();

    await withTenantPostgresContext(recording.sql, { orgId, setRole: false }, async () => {});

    expect(recording.calls).toEqual([
      {
        kind: "begin",
      },
      {
        kind: "query",
        text: "select set_config('helix.org_id', ?, true)",
        values: [orgId],
      },
    ]);
  });
});

describe("PostgresTenantRoleProvisioner", () => {
  it("executes the generated role provisioning statement with unsafe SQL", async () => {
    const executed: string[] = [];
    const provisioner = new PostgresTenantRoleProvisioner({
      unsafe(statement: string) {
        executed.push(statement);
        return Promise.resolve([]);
      },
    } as unknown as postgres.Sql);

    await provisioner.ensureRoleForOrg(orgId);

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("create role");
  });
});

type RecordedCall =
  | { readonly kind: "begin" }
  | { readonly kind: "unsafe"; readonly text: string }
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
    unsafe: (text: string) => {
      calls.push({ kind: "unsafe", text });
      return Promise.resolve([]);
    },
  });
  return { sql: sql as unknown as postgres.Sql, calls };
}
