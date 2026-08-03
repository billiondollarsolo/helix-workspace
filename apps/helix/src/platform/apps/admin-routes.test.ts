import fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { PlatformConfigAdminService, PostgresPlatformConfigStore } from "../config/admin.js";
import { registerCoreAppsAdminRoutes, type CoreAppsAdminStatus } from "./admin-routes.js";
import { CORE_APP_IDS, resolveRoleAppSet } from "./core-apps.js";

/** Minimal in-memory `platform_config` table fake (matches admin.test.ts). */
class InMemoryPlatformConfigSql {
  private readonly rows = new Map<string, unknown>();

  constructor(initialRows: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initialRows)) {
      this.rows.set(key, value);
    }
  }

  readonly sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("$");
      if (text.includes("select key, value")) {
        return Promise.resolve([...this.rows.entries()].map(([key, value]) => ({ key, value })));
      }
      if (text.includes("insert into platform_config")) {
        const [key, value] = values;
        if (typeof key !== "string") {
          throw new TypeError("Expected platform config key.");
        }
        this.rows.set(key, value);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    {
      array: <T extends readonly unknown[]>(value: T) => value,
      json: (value: unknown) => value,
    },
  ) as unknown as postgres.Sql;
}

const adminActor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Admin",
  scopes: ["admin.config.read", "admin.config.write"],
};

const viewerActor: Actor = {
  ...adminActor,
  id: "33333333-3333-4333-8333-333333333333",
  scopes: ["mail.read"],
};

async function appWithCoreAppsRoutes(
  actor: Actor,
  initialRows: Record<string, unknown> = {},
  role = "all",
  /** `HELIX_APPS`. When set it wins over `role`, exactly as at boot. */
  apps?: string,
) {
  const store = new PostgresPlatformConfigStore(new InMemoryPlatformConfigSql(initialRows).sql);
  const service = new PlatformConfigAdminService(store, {});
  const app = fastify();
  /* Resolve once and pass both, mirroring `server.ts`: it builds a
     `CoreAppRegistrationPlan` at boot and hands the route its `role` *and*
     `appIds`. Passing only the role is the defect this harness must be able
     to reproduce. */
  const plan = resolveRoleAppSet(apps === undefined ? { role } : { apps });
  await registerCoreAppsAdminRoutes(app, {
    service,
    role: plan.role,
    appIds: plan.appIds,
    actorFromRequest: () => actor,
  });
  return app;
}

describe("core-app enablement admin routes", () => {
  it("lists every core app as enabled by default", async () => {
    const app = await appWithCoreAppsRoutes(adminActor);
    const response = await app.inject({ method: "GET", url: "/api/admin/core-apps" });
    expect(response.statusCode).toBe(200);
    const body = response.json<CoreAppsAdminStatus>();
    expect(body.role).toBe("all");
    expect(body.apps).toHaveLength(CORE_APP_IDS.length);
    for (const coreApp of body.apps) {
      expect(coreApp.enabled).toBe(true);
      expect(coreApp.registered).toBe(true);
    }
    await app.close();
  });

  it("reflects a disabled core app from stored config", async () => {
    const app = await appWithCoreAppsRoutes(adminActor, {
      modules: { chat: { enabled: false } },
    });
    const response = await app.inject({ method: "GET", url: "/api/admin/core-apps" });
    const body = response.json<CoreAppsAdminStatus>();
    const chat = body.apps.find((coreApp) => coreApp.id === "chat");
    expect(chat).toMatchObject({ enabled: false, registered: false });
    const mail = body.apps.find((coreApp) => coreApp.id === "mail");
    expect(mail).toMatchObject({ enabled: true, registered: true });
    await app.close();
  });

  it("toggles a core app off and persists the change", async () => {
    const app = await appWithCoreAppsRoutes(adminActor);
    const toggle = await app.inject({
      method: "PATCH",
      url: "/api/admin/core-apps/meet",
      payload: { enabled: false },
    });
    expect(toggle.statusCode).toBe(200);
    const body = toggle.json<CoreAppsAdminStatus & { changed: unknown }>();
    expect(body.changed).toMatchObject({
      appId: "meet",
      from: true,
      to: false,
      requiresRestart: true,
    });
    expect(body.apps.find((coreApp) => coreApp.id === "meet")?.enabled).toBe(false);

    // The change is persisted: a fresh read still reports meet disabled.
    const reread = await app.inject({ method: "GET", url: "/api/admin/core-apps" });
    expect(reread.json<CoreAppsAdminStatus>().apps.find((c) => c.id === "meet")?.enabled).toBe(
      false,
    );
    await app.close();
  });

  it("rejects toggling an unknown core app with 404", async () => {
    const app = await appWithCoreAppsRoutes(adminActor);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/core-apps/webhook",
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects an invalid toggle body with 400", async () => {
    const app = await appWithCoreAppsRoutes(adminActor);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/core-apps/mail",
      payload: { enabled: "nope" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("denies read access without the admin config scope", async () => {
    const app = await appWithCoreAppsRoutes(viewerActor);
    const response = await app.inject({ method: "GET", url: "/api/admin/core-apps" });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("denies write access without the admin config write scope", async () => {
    const app = await appWithCoreAppsRoutes(viewerActor);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/core-apps/mail",
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("marks apps outside the booting role as not registered", async () => {
    const app = await appWithCoreAppsRoutes(adminActor, {}, "realtime");
    const response = await app.inject({ method: "GET", url: "/api/admin/core-apps" });
    const body = response.json<CoreAppsAdminStatus>();
    expect(body.role).toBe("realtime");
    const mail = body.apps.find((coreApp) => coreApp.id === "mail");
    // Enabled org-wide, but the realtime role does not run mail.
    expect(mail).toMatchObject({ enabled: true, inRole: false, registered: false });
    const chat = body.apps.find((coreApp) => coreApp.id === "chat");
    expect(chat).toMatchObject({ enabled: true, inRole: true, registered: true });
    await app.close();
  });

  it("serves the status when the app set came from HELIX_APPS", async () => {
    /* The production configuration (docker-compose.production.yml). An explicit
       `HELIX_APPS` resolves to the sentinel role "custom", which is deliberately
       not a member of HELIX_ROLES — so re-deriving the app set from the role
       *name* threw `CoreAppRoleError` and this endpoint answered 500 for every
       production process. The admin console's Overview reported it as
       "Workspace apps could not be read".

       Asserting the body, not just the status: a 200 carrying every app as
       `inRole: false` would be the same outage wearing a success code. */
    const app = await appWithCoreAppsRoutes(adminActor, {}, "all", "mail,drive,chat,assistant");
    const response = await app.inject({ method: "GET", url: "/api/admin/core-apps" });

    expect(response.statusCode).toBe(200);
    const body = response.json<CoreAppsAdminStatus>();
    expect(body.role).toBe("custom");
    const registered = body.apps
      .filter((coreApp) => coreApp.registered)
      .map((coreApp) => coreApp.id)
      .sort();
    expect(registered).toEqual(["assistant", "chat", "drive", "mail"]);
    // The editor suite is excluded by the role, not disabled org-wide.
    expect(body.apps.find((coreApp) => coreApp.id === "editors")).toMatchObject({
      enabled: true,
      inRole: false,
      registered: false,
    });
    await app.close();
  });
});
