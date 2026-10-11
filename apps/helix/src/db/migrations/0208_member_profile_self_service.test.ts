import type { Actor } from "@helix/sdk-types";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresAccountPreferencesStore,
  registerAccountPreferenceTools,
} from "../../platform/auth/account-preferences.js";
import {
  PostgresAppPasswordStore,
  registerAppPasswordTools,
} from "../../platform/auth/app-passwords.js";
import { actorHasPermission, parseActorRoleBindings } from "../../platform/permissions/roles.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../../platform/tenancy/postgres-roles.js";
import { createToolRegistry, type RuntimeToolRegistry } from "../../platform/tool-registry.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const org = "d2080000-0000-4000-8000-00000000000a";
const laterOrg = "d2080000-0000-4000-8000-00000000000b";
const person = "d2080000-0000-4000-8000-0000000000a1";
const suspended = "d2080000-0000-4000-8000-0000000000a2";
const agent = "d2080000-0000-4000-8000-0000000000a3";
const serviceAccount = "d2080000-0000-4000-8000-0000000000a4";
const denied = "d2080000-0000-4000-8000-0000000000a5";
const planner = "d2080000-0000-4000-8000-0000000000a6";
const denyRole = "d2080000-0000-4000-8000-0000000000b1";

describe("0208 member profile self-service migration", () => {
  it("adds permissions without disabling IAM triggers or updating role rows", async () => {
    const migration = await readFile(
      new URL("./0208_member_profile_self_service.sql", import.meta.url),
      "utf8",
    );
    expect(migration).not.toMatch(/disable trigger/iu);
    expect(migration).not.toMatch(/update\s+iam_/iu);
    expect(migration).toContain("'workspace_member', 'Member', 'built_in'");
  });
});

describe(
  "0208 member profile self-service (PostgreSQL)",
  { skip: skipUnlessLiveDatabase("built-in member role grants profile self-service") },
  () => {
    let sql: postgres.Sql;
    let app: postgres.Sql;

    beforeAll(async () => {
      if (databaseUrl === undefined || appUrl === undefined)
        throw new Error("Migration and app database URLs are required.");
      sql = postgres(databaseUrl, { max: 1, prepare: false });
      app = tenantAwarePostgresSql(postgres(appUrl, { max: 2 }));
      await cleanup();
      await sql`insert into orgs (id, slug, display_name) values (${org}, 'member-role', 'Member role')`;
      // An ordinary person holds product scopes but no profile.* scope of their own.
      await sql`
        insert into actors (id, org_id, type, email, display_name, scopes) values
          (${person}, ${org}, 'user', 'person@member-role.test', 'Person', array['mail.read', 'smtp']),
          (${suspended}, ${org}, 'user', 'gone@member-role.test', 'Gone', array['smtp']),
          (${denied}, ${org}, 'user', 'denied@member-role.test', 'Denied', array['smtp']),
          (${planner}, ${org}, 'user', 'planner@member-role.test', 'Planner',
            array['calendar.read', 'calendar.write']),
          (${agent}, ${org}, 'agent', null, 'Agent', array['mail.read']),
          (${serviceAccount}, ${org}, 'service_account', null, 'Robot', array['mail.read'])
      `;
      await sql`
        update organization_memberships
        set status = 'suspended', suspended_at = now()
        where org_id = ${org} and actor_id = ${suspended}
      `;
      await sql`
        insert into iam_roles (id, org_id, role_key, display_name, kind)
        values (${denyRole}, ${org}, 'no_profile_edits', 'No profile edits', 'custom')
      `;
      await sql`
        insert into iam_role_permissions (org_id, role_id, permission, effect)
        values (${org}, ${denyRole}, 'profile.write', 'deny')
      `;
      await sql`
        insert into iam_role_bindings (org_id, role_id, principal_type, membership_id, scope_type)
        select ${org}, ${denyRole}, 'membership', id, 'org'
        from organization_memberships where org_id = ${org} and actor_id = ${denied}
      `;
    });

    afterAll(async () => {
      await cleanup();
      await Promise.all([sql.end(), app.end()]);
    });

    /** app_passwords has no org_id, so tenant cleanup cannot see it. */
    async function cleanup(): Promise<void> {
      await sql`delete from app_passwords where actor_id = ${person}`;
      await cleanupTestTenants(sql, [org, laterOrg]);
    }

    async function loadActor(actorId: string): Promise<Actor> {
      const rows = await withTenantPostgresContext(
        app,
        { orgId: org },
        (tx) =>
          tx<{ type: Actor["type"]; scopes: string[]; role_bindings: unknown }[]>`
          select type, scopes, helix_actor_role_bindings(org_id, id) as role_bindings
          from actors where org_id = ${org} and id = ${actorId}
        `,
      );
      const row = rows[0];
      if (row === undefined) throw new Error(`Actor ${actorId} is missing.`);
      const roleBindings = parseActorRoleBindings(row.role_bindings);
      return {
        id: actorId,
        orgId: org,
        type: row.type,
        scopes: row.scopes,
        ...(roleBindings.length === 0 ? {} : { roleBindings }),
      };
    }

    /** Tools run inside the request's tenant transaction, as the API does. */
    function asRequest(
      registry: RuntimeToolRegistry,
      ...[toolId, input, options]: Parameters<RuntimeToolRegistry["invoke"]>
    ) {
      return withTenantPostgresContext(app, { orgId: org, actorId: options?.actor?.id }, () =>
        registry.invoke(toolId, input, options),
      );
    }

    it("seeds the member role with exactly profile.read and profile.write in every org", async () => {
      await sql`insert into orgs (id, slug, display_name) values (${laterOrg}, 'member-role-later', 'Later')`;
      const roles = await sql<{ org_id: string; permissions: string[] }[]>`
        select role.org_id, array_agg(held.permission || ':' || held.effect order by held.permission)
          as permissions
        from iam_roles role
        join iam_role_permissions held on held.org_id = role.org_id and held.role_id = role.id
        where role.role_key = 'workspace_member' and role.kind = 'built_in'
          and role.org_id in (${org}, ${laterOrg})
        group by role.org_id order by role.org_id
      `;
      expect(roles).toEqual([
        { org_id: org, permissions: ["profile.read:allow", "profile.write:allow"] },
        { org_id: laterOrg, permissions: ["profile.read:allow", "profile.write:allow"] },
      ]);
      const [missing] = await sql<{ count: number }[]>`
        select count(*)::int as count from orgs organization
        where not exists (
          select 1 from iam_roles role
          where role.org_id = organization.id and role.role_key = 'workspace_member'
        )
      `;
      expect(missing?.count).toBe(0);
    });

    it("grants every active person, but never agents, service accounts or suspended members", async () => {
      const grants = async (actorId: string) =>
        (await loadActor(actorId)).roleBindings?.flatMap((binding) => binding.allow) ?? [];
      expect(await grants(person)).toEqual(["profile.read", "profile.write"]);
      expect(await grants(suspended)).toEqual([]);
      expect(await grants(agent)).toEqual([]);
      expect(await grants(serviceAccount)).toEqual([]);
    });

    it("adds free/busy and RSVP to people who already read and write calendars", async () => {
      const actor = await loadActor(planner);
      expect(actor.roleBindings?.flatMap((binding) => binding.allow)).toEqual([
        "calendar.read:freebusy",
        "calendar.write:respond",
        "profile.read",
        "profile.write",
      ]);
      expect(actorHasPermission(actor, "calendar.read:freebusy")).toBe(true);
      expect(actorHasPermission(actor, "calendar.manage")).toBe(false);
      const member = await loadActor(person);
      expect(actorHasPermission(member, "calendar.read:freebusy")).toBe(false);
      // Derived, not stored: the person's own scopes are untouched.
      const [stored] = await sql<{ scopes: string[] }[]>`
        select scopes from actors where id = ${planner}
      `;
      expect(stored?.scopes).toEqual(["calendar.read", "calendar.write"]);
    });

    it("lets an ordinary person manage their own preferences and app passwords", async () => {
      const registry = createToolRegistry();
      registerAccountPreferenceTools(registry, {
        store: new PostgresAccountPreferencesStore(app),
      });
      registerAppPasswordTools(registry, { store: new PostgresAppPasswordStore(app) });
      const actor = await loadActor(person);

      expect(
        await asRequest(registry, "account.preferences.set", { timeFormat: "24h" }, { actor }),
      ).toMatchObject({ ok: true, output: { timeFormat: "24h" } });
      expect(await asRequest(registry, "account.preferences.get", {}, { actor })).toMatchObject({
        ok: true,
        output: { timeFormat: "24h" },
      });
      const created = await asRequest(
        registry,
        "app.passwords.create",
        { label: "Phone mail", scopes: ["smtp"] },
        { actor, skipConfirmation: true },
      );
      expect(created).toMatchObject({
        ok: true,
        output: { appPassword: { actorId: person, label: "Phone mail", scopes: ["smtp"] } },
      });
      expect(
        await asRequest(registry, "app.passwords.list", { actorId: person }, { actor }),
      ).toMatchObject({ ok: true, output: { appPasswords: [{ label: "Phone mail" }] } });

      // Scopes the person does not hold stay out of reach.
      expect(
        await asRequest(
          registry,
          "app.passwords.create",
          { label: "Calendar", scopes: ["caldav"] },
          { actor, skipConfirmation: true },
        ),
      ).toMatchObject({ ok: false, statusCode: 403 });
    });

    it("keeps an explicit deny and the agent boundary in force", async () => {
      const registry = createToolRegistry();
      registerAccountPreferenceTools(registry, {
        store: new PostgresAccountPreferencesStore(app),
      });
      const deniedActor = await loadActor(denied);
      expect(
        await asRequest(registry, "account.preferences.get", {}, { actor: deniedActor }),
      ).toMatchObject({ ok: true });
      expect(
        await asRequest(
          registry,
          "account.preferences.set",
          { weekStart: 1 },
          { actor: deniedActor },
        ),
      ).toMatchObject({ ok: false, statusCode: 403 });
      expect(
        await asRequest(registry, "account.preferences.get", {}, { actor: await loadActor(agent) }),
      ).toMatchObject({ ok: false, statusCode: 403 });
    });
  },
);
