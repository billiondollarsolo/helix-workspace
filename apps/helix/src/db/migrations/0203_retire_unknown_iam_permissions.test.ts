import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DELEGATED_ADMIN_ROLE_PERMISSIONS } from "../../platform/permissions/roles.js";
import { ALL_SCOPES, isKnownScope } from "../../platform/permissions/scope-catalog.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const org = "d2030000-0000-4000-8000-00000000000a";
const holder = "d2030000-0000-4000-8000-0000000000a1";
const delegate = "d2030000-0000-4000-8000-0000000000a2";
const billingRole = "d2030000-0000-4000-8000-0000000000b1";
const customRole = "d2030000-0000-4000-8000-0000000000b2";
const rootBinding = "d2030000-0000-4000-8000-0000000000c1";
const childBinding = "d2030000-0000-4000-8000-0000000000c2";
const viewerBinding = "d2030000-0000-4000-8000-0000000000c3";
const editorRole = "d2030000-0000-4000-8000-0000000000b3";
const editorBinding = "d2030000-0000-4000-8000-0000000000c4";
const editorOnlyCredential = "d2030000-0000-4000-8000-0000000000e1";
const mixedCredential = "d2030000-0000-4000-8000-0000000000e2";
const RETIRED = [
  "admin.billing",
  "docs.comment",
  "docs.read",
  "docs.write",
  "imap",
  "sheets.read",
  "sheets.write",
  "slides.read",
  "slides.write",
];
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

class Rollback extends Error {}

describe("0203 retire unknown IAM permissions migration", () => {
  it("lists exactly the application catalog and removes the retired permissions", async () => {
    const migration = await readFile(
      new URL("./0203_retire_unknown_iam_permissions.sql", import.meta.url),
      "utf8",
    );
    for (const permission of RETIRED) expect(isKnownScope(permission)).toBe(false);
    expect(Object.keys(DELEGATED_ADMIN_ROLE_PERMISSIONS)).not.toContain("billing_admin");
    expect(migration).toContain("insert into iam_delegation_events");
    expect(migration).not.toMatch(/disable trigger/iu);
    const known = /permission <> all \(array\[([^\]]*)\]/u.exec(migration)?.[1] ?? "";
    const listed = [...known.matchAll(/'([^']+)'/gu)].map((match) => match[1] ?? "");
    expect(listed.sort(byCodePoint)).toEqual([...ALL_SCOPES].sort(byCodePoint));
  });
});

describe(
  "0203 retire unknown IAM permissions migration (PostgreSQL)",
  { skip: skipUnlessLiveDatabase("unknown IAM permission retirement") },
  () => {
    let sql: postgres.Sql;
    let migration = "";

    beforeAll(async () => {
      if (databaseUrl === undefined) throw new Error("Database URL is required.");
      sql = postgres(databaseUrl, { max: 1, prepare: false });
      migration = await readFile(
        new URL("./0203_retire_unknown_iam_permissions.sql", import.meta.url),
        "utf8",
      );
      await cleanupTestTenants(sql, [org]);
      await sql`insert into orgs (id, slug, display_name) values (${org}, 'retire-billing', 'Retire billing')`;
    });

    afterAll(async () => {
      await cleanupTestTenants(sql, [org]);
      await sql.end();
    });

    it("keeps the database permission catalog equal to the application catalog", async () => {
      const catalog = await sql<{ permission: string }[]>`
        select permission from iam_permission_catalog
      `;
      expect(catalog.map((row) => row.permission).sort(byCodePoint)).toEqual(
        [...ALL_SCOPES].sort(byCodePoint),
      );
    });

    it("leaves no billing role, permission or catalog entry behind", async () => {
      const [state] = await sql<{ roles: number; permissions: number; catalog: number }[]>`
        select
          (select count(*)::int from iam_roles where role_key = 'billing_admin') as roles,
          (select count(*)::int from iam_role_permissions where permission = 'admin.billing')
            as permissions,
          (select count(*)::int from iam_permission_catalog where permission = 'admin.billing')
            as catalog
      `;
      expect(state).toEqual({ roles: 0, permissions: 0, catalog: 0 });
      const roles = await sql<{ role_key: string }[]>`
        select role_key from iam_roles where org_id = ${org} and kind = 'built_in' order by role_key
      `;
      expect(roles.map((role) => role.role_key)).toEqual(
        [
          ...Object.keys(DELEGATED_ADMIN_ROLE_PERMISSIONS),
          "workspace_member",
          "workspace_viewer",
        ].sort(),
      );
    });

    it("retires existing grants, keeps other grants and records the revocations", async () => {
      const outcome = await sql
        .begin(async (tx) => {
          await tx`
            insert into iam_permission_catalog (permission, catalog_version)
            select permission, 2 from unnest(${RETIRED}::text[]) permission
          `;
          await tx`
            insert into actors (id, org_id, type, display_name, scopes)
            values
              (${holder}, ${org}, 'user', 'Holder', array['docs.read', 'platform.read', 'admin.billing']),
              (${delegate}, ${org}, 'user', 'Delegate', array['admin.billing'])
          `;
          await tx`
            insert into iam_roles (id, org_id, role_key, display_name, kind)
            values
              (${billingRole}, ${org}, 'billing_admin', 'Billing administrator', 'built_in'),
              (${customRole}, ${org}, 'finance_ops', 'Finance ops', 'custom'),
              (${editorRole}, ${org}, 'docs_editor', 'Docs editor', 'custom')
          `;
          await tx`
            insert into iam_role_permissions (org_id, role_id, permission, effect)
            values
              (${org}, ${billingRole}, 'admin.billing', 'allow'),
              (${org}, ${customRole}, 'admin.billing', 'allow'),
              (${org}, ${customRole}, 'admin.audit', 'allow'),
              (${org}, ${customRole}, 'sheets.write', 'deny'),
              (${org}, ${editorRole}, 'docs.read', 'allow'),
              (${org}, ${editorRole}, 'docs.write', 'allow')
          `;
          await tx`
            insert into iam_role_bindings
              (id, org_id, role_id, principal_type, membership_id, scope_type, can_delegate)
            select ${rootBinding}, ${org}, ${billingRole}, 'membership', id, 'org', true
            from organization_memberships where org_id = ${org} and actor_id = ${holder}
          `;
          await tx`
            insert into iam_role_bindings
              (id, org_id, role_id, principal_type, membership_id, scope_type)
            select ${viewerBinding}, ${org}, role.id, 'membership', membership.id, 'org'
            from organization_memberships membership
            join iam_roles role on role.org_id = membership.org_id and role.role_key = 'workspace_viewer'
            where membership.org_id = ${org} and membership.actor_id = ${holder}
          `;
          await tx`
            insert into iam_role_bindings
              (id, org_id, role_id, principal_type, membership_id, scope_type,
               granted_by_actor_id, parent_binding_id)
            select ${childBinding}, ${org}, ${billingRole}, 'membership', id, 'org',
                   ${holder}, ${rootBinding}
            from organization_memberships where org_id = ${org} and actor_id = ${delegate}
          `;
          await tx`
            insert into iam_role_bindings
              (id, org_id, role_id, principal_type, membership_id, scope_type)
            select ${editorBinding}, ${org}, ${editorRole}, 'membership', id, 'org'
            from organization_memberships where org_id = ${org} and actor_id = ${delegate}
          `;
          await tx`
            insert into agent_credentials
              (id, org_id, actor_id, owner_actor_id, credential_type, api_key_hash, scopes,
               expires_at, label, purpose)
            values
              (${editorOnlyCredential}, ${org}, ${holder}, ${holder}, 'api_key', 'retire-hash-1',
               array['sheets.read'], now() + interval '1 day', 'Sheets', 'Retired editor'),
              (${mixedCredential}, ${org}, ${holder}, ${holder}, 'api_key', 'retire-hash-2',
               array['slides.write', 'mail.read'], now() + interval '1 day', 'Mail', 'Mail')
          `;

          await tx.unsafe(migration);

          const bindings = await tx<{ id: string }[]>`
            select id from iam_role_bindings where org_id = ${org} order by id
          `;
          const custom = await tx<{ permission: string }[]>`
            select permission from iam_role_permissions where org_id = ${org} and role_id = ${customRole}
          `;
          const scopes = await tx<{ id: string; scopes: string[] }[]>`
            select id, scopes from actors where id in (${holder}, ${delegate}) order by id
          `;
          const events = await tx<{ binding_id: string; reason: string | null }[]>`
            select binding_id, binding_snapshot->>'revocationReason' as reason
            from iam_delegation_events
            where org_id = ${org} and event_type = 'revoked'
            order by binding_id
          `;
          const roles = await tx<{ role_key: string }[]>`
            select role_key from iam_roles where org_id = ${org} and kind = 'custom' order by role_key
          `;
          const credentials = await tx<{ id: string; scopes: string[]; revoked: boolean }[]>`
            select id, scopes, revoked_at is not null as revoked
            from agent_credentials where org_id = ${org} order by id
          `;
          const [catalog] = await tx<{ retired: number }[]>`
            select count(*)::int as retired from iam_permission_catalog
            where permission = any(${RETIRED}::text[])
          `;
          const [loaded] = await tx<{ bindings: { allow: string[] }[] }[]>`
            select helix_actor_role_bindings(${org}, ${holder}) as bindings
          `;
          throw new Rollback(
            JSON.stringify({
              bindings,
              custom,
              roles,
              credentials,
              catalog,
              scopes,
              events,
              loaded,
            }),
          );
        })
        .catch((error: unknown) => {
          if (error instanceof Rollback) return JSON.parse(error.message) as unknown;
          throw error;
        });

      expect(outcome).toEqual({
        bindings: [{ id: viewerBinding }],
        custom: [{ permission: "admin.audit" }],
        roles: [{ role_key: "finance_ops" }],
        credentials: [
          { id: editorOnlyCredential, scopes: ["sheets.read"], revoked: true },
          { id: mixedCredential, scopes: ["mail.read"], revoked: false },
        ],
        catalog: { retired: 0 },
        scopes: [
          { id: holder, scopes: ["platform.read"] },
          { id: delegate, scopes: [] },
        ],
        events: [
          { binding_id: rootBinding, reason: "permission_retired" },
          { binding_id: childBinding, reason: "permission_retired" },
          { binding_id: editorBinding, reason: "permission_retired" },
        ],
        loaded: {
          bindings: [
            expect.objectContaining({ allow: ["platform.read", "profile.read", "tools:read"] }),
            // The implicit built-in member grant (0208).
            expect.objectContaining({ allow: ["profile.read", "profile.write"] }),
          ],
        },
      });
    });
  },
);
