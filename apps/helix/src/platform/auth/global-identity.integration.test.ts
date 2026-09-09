import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresBetterAuthActorStore } from "./better-auth.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL ?? process.env.DATABASE_URL;
const orgA = "96000000-0000-4000-8000-000000000001";
const orgB = "96000000-0000-4000-8000-000000000002";
const actorA = "96000000-0000-4000-8000-000000000011";
const actorB = "96000000-0000-4000-8000-000000000012";
const authUserId = "global-identity-integration-user";
const email = "global-identity-integration@helix.test";

describe(
  "global identity membership activation",
  {
    skip: adminUrl === undefined || runtimeUrl === undefined,
  },
  () => {
    let admin: postgres.Sql;
    let runtime: postgres.Sql;
    let store: PostgresBetterAuthActorStore;

    beforeAll(async () => {
      if (adminUrl === undefined || runtimeUrl === undefined) {
        throw new Error("Admin and runtime database URLs are required.");
      }
      admin = postgres(adminUrl, { max: 1, prepare: false });
      runtime = postgres(runtimeUrl, { max: 4, prepare: false });
      const ready = await admin<{ readonly ready: boolean }[]>`
      select to_regprocedure(
        'helix_activate_identity_membership(text,text,uuid,text,text)'
      ) is not null as ready
    `;
      if (ready[0]?.ready !== true) throw new Error("Run migration 0096 before this test.");
      await cleanup();
      await admin`
      insert into orgs (id, slug, display_name, status)
      values
        (${orgA}, 'identity-integration-a', 'Identity integration A', 'active'),
        (${orgB}, 'identity-integration-b', 'Identity integration B', 'active')
      on conflict (id) do update set status = 'active'
    `;
      await withTenantPostgresContext(
        admin,
        { orgId: orgA },
        (tx) => tx`
      insert into actors (id, org_id, type, email, display_name, scopes)
      values (${actorA}, ${orgA}, 'user', ${email}, 'Person A', array['mail.read'])
    `,
      );
      await withTenantPostgresContext(
        admin,
        { orgId: orgB },
        (tx) => tx`
      insert into actors (id, org_id, type, email, display_name, scopes)
      values (${actorB}, ${orgB}, 'user', ${email}, 'Person B', array['drive.read'])
    `,
      );
      store = new PostgresBetterAuthActorStore(runtime);
    });

    afterAll(async () => {
      await cleanup();
      await Promise.all([admin.end(), runtime.end()]);
    });

    it("creates one provider link under concurrent first login and switches org authority", async () => {
      const input = {
        authUserId,
        orgId: orgA,
        email,
        displayName: "Global Person",
      };
      const [first, retry] = await Promise.all([
        store.resolveVerifiedUser(input),
        store.resolveVerifiedUser(input),
      ]);
      expect(first?.id).toBe(actorA);
      expect(retry?.id).toBe(actorA);

      const links = await admin`
      select subject_id from identity_provider_subjects
      where provider = 'better-auth' and provider_subject = ${authUserId}
    `;
      expect(links).toHaveLength(1);

      await expect(store.resolveVerifiedUser({ ...input, orgId: orgB })).resolves.toMatchObject({
        id: actorB,
        orgId: orgB,
        scopes: ["drive.read"],
      });

      await withTenantPostgresContext(
        admin,
        { orgId: orgB },
        (tx) => tx`
      update organization_memberships
      set status = 'suspended', suspended_at = now(), ended_at = null
      where actor_id = ${actorB}
    `,
      );
      await expect(store.resolveVerifiedUser({ ...input, orgId: orgB })).resolves.toBeNull();
      await expect(store.resolveVerifiedUser(input)).resolves.toMatchObject({ id: actorA });
    });

    async function cleanup(): Promise<void> {
      await admin`
      delete from identity_provider_subjects
      where provider = 'better-auth' and provider_subject = ${authUserId}
    `;
      for (const [orgId, actorId] of [
        [orgA, actorA],
        [orgB, actorB],
      ] as const) {
        await withTenantPostgresContext(admin, { orgId }, async (tx) => {
          await tx`delete from actors where id = ${actorId} and org_id = ${orgId}`;
        });
      }
      await admin`delete from identity_subjects where canonical_email = ${email}`;
      await admin`delete from orgs where id in (${orgA}, ${orgB})`;
    }
  },
);
