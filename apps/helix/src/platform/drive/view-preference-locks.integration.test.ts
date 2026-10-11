import { SYSTEM_TENANT_CONFIG } from "@helix/sdk-types";
import fastify from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cacheSessionActorResolver,
  installSessionActorPrefetchHook,
} from "../../bootstrap/request-principal.js";
import { PostgresBetterAuthActorStore } from "../auth/better-auth.js";
import type { TenantContext } from "../tenancy/context.js";
import {
  installTenantContextHook,
  installTenantPostgresContextHook,
} from "../tenancy/middleware.js";
import {
  setTenantPostgresActorId,
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../tenancy/postgres-roles.js";
import { PostgresDriveStore } from "./store.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL ?? process.env.DATABASE_URL;
const orgId = "be001000-0000-4000-8000-000000000001";
const actorId = "be001000-0000-4000-8000-000000000011";
const authUserId = "be001-view-toggle-user";
const email = "be001-view-toggle@helix.test";
const operationTimeoutMs = 10_000;
const tenant: TenantContext = {
  orgId,
  orgSlug: "be001-view-toggle",
  orgTier: "personal",
  orgRegion: "default",
  effectiveConfig: SYSTEM_TENANT_CONFIG,
  org: {
    id: orgId,
    slug: "be001-view-toggle",
    displayName: "BE-001 view toggle",
    status: "active",
    tier: "personal",
    region: "default",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  },
};

/**
 * BE-001: a request that resolves its session actor (membership activation)
 * and then toggles the Drive layout must not wait on its own row locks from a
 * second pool connection, and later logins must never queue behind it.
 */
describe(
  "Drive layout preference writes under request-scoped identity activation",
  { skip: adminUrl === undefined || runtimeUrl === undefined },
  () => {
    let admin: postgres.Sql;
    let runtime: postgres.Sql;
    let actors: PostgresBetterAuthActorStore;
    let drive: PostgresDriveStore;

    beforeAll(async () => {
      if (adminUrl === undefined || runtimeUrl === undefined) {
        throw new Error("Admin and runtime database URLs are required.");
      }
      admin = postgres(adminUrl, { max: 1, prepare: false });
      runtime = tenantAwarePostgresSql(postgres(runtimeUrl, { max: 6, prepare: false }));
      await cleanup();
      await admin`
        insert into orgs (id, slug, display_name, status)
        values (${orgId}, 'be001-view-toggle', 'BE-001 view toggle', 'active')
        on conflict (id) do update set status = 'active'
      `;
      await withTenantPostgresContext(
        admin,
        { orgId },
        (tx) => tx`
          insert into actors (id, org_id, type, email, display_name, scopes)
          values (${actorId}, ${orgId}, 'user', ${email}, 'View toggler', array['drive.read'])
        `,
      );
      actors = new PostgresBetterAuthActorStore(runtime);
      drive = new PostgresDriveStore(runtime);
    });

    afterAll(async () => {
      await cleanup();
      await Promise.all([admin.end(), runtime.end()]);
    });

    const login = () =>
      actors.resolveVerifiedUser({ authUserId, orgId, email, displayName: "View toggler" });

    /** A request transaction that activates the membership itself, then writes the layout. */
    const toggleRequest = (view: "grid" | "list") =>
      withTenantPostgresContext(runtime, { orgId }, async () => {
        const actor = await login();
        expect(actor?.id).toBe(actorId);
        await setTenantPostgresActorId(actorId);
        return drive.setDocumentSurfaceView({ orgId, actorId, view });
      });

    it("completes a toggle in a request transaction that activated the membership", async () => {
      await expect(withTimeout(toggleRequest("list"))).resolves.toBe("list");
      await expect(
        withTimeout(
          withTenantPostgresContext(runtime, { orgId, actorId }, () =>
            drive.getDocumentSurfaceView({ orgId, actorId }),
          ),
        ),
      ).resolves.toBe("list");
    }, 30_000);

    it("keeps logins flowing while views toggle repeatedly and concurrently", async () => {
      const app = fastify();
      const resolver = cacheSessionActorResolver({
        async resolve() {
          const actor = await login();
          return actor === null
            ? null
            : { id: actor.id, orgId, type: "user", displayName: actor.displayName, scopes: [] };
        },
      });
      installTenantContextHook(app, { resolveTenantContext: () => Promise.resolve(tenant) });
      installSessionActorPrefetchHook(app, resolver);
      installTenantPostgresContextHook(app, runtime);
      app.post<{ Body: { readonly view: "grid" | "list" } }>("/toggle", async (request) => {
        const actor = await resolver.resolve(request);
        if (actor === null) throw new Error("Session actor was not resolved.");
        await setTenantPostgresActorId(actor.id);
        return {
          view: await drive.setDocumentSurfaceView({ orgId, actorId, view: request.body.view }),
        };
      });
      try {
        const work: Promise<unknown>[] = [];
        for (let round = 0; round < 12; round += 1) {
          const view = round % 2 === 0 ? "grid" : "list";
          work.push(
            app
              .inject({
                method: "POST",
                url: "/toggle",
                headers: { cookie: "session=1" },
                payload: { view },
              })
              .then((response) => {
                expect(response.statusCode).toBe(200);
                expect(response.json()).toEqual({ view });
              }),
          );
          work.push(login());
        }
        await expect(withTimeout(Promise.all(work))).resolves.toHaveLength(24);
      } finally {
        await app.close();
      }
      const waiting = await admin<{ readonly count: number }[]>`
        select count(*)::int as count
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `;
      expect(waiting[0]?.count).toBe(0);
    }, 30_000);

    async function cleanup(): Promise<void> {
      await admin`
        delete from identity_provider_subjects
        where provider = 'better-auth' and provider_subject = ${authUserId}
      `;
      await withTenantPostgresContext(admin, { orgId }, async (tx) => {
        await tx`delete from actors where id = ${actorId} and org_id = ${orgId}`;
      });
      await admin`delete from identity_subjects where lower(canonical_email) = ${email}`;
      await admin`delete from orgs where id = ${orgId}`;
    }
  },
);

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation did not finish in ${String(operationTimeoutMs)}ms.`));
    }, operationTimeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
