import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  InMemoryOAuthAppsStore,
  registerAdminOAuthAppsRoutes,
  type OAuthAppRecord,
} from "./oauth-apps.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

function headers(scopes: string): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}

function body(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

function field(response: { json: () => unknown }, key: string): unknown {
  return body(response)[key];
}

async function buildApp(options?: {
  onRevoke?: (input: { orgId: string; app: OAuthAppRecord }) => void;
}) {
  let clock = 0;
  const store = new InMemoryOAuthAppsStore({
    now: () => new Date(Date.UTC(2026, 4, 21, 0, 0, (clock += 1))),
  });
  const app = fastify();
  await registerAdminOAuthAppsRoutes(app, {
    store,
    actorFromRequest,
    ...(options?.onRevoke === undefined ? {} : { onRevoke: options.onRevoke }),
  });
  return { app, store };
}

async function seed(app: Awaited<ReturnType<typeof buildApp>>["app"], name: string, risk = "low") {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/oauth-apps",
    headers: headers("admin.console.write"),
    payload: { name, risk, scopes: ["mail.read"], scopeSummary: "Read mail" },
  });
  return (field(response, "app") as { id: string }).id;
}

describe("admin oauth apps routes", () => {
  it("registers an app and lists it back", async () => {
    const { app } = await buildApp();
    await seed(app, "GitHub");
    const list = await app.inject({
      method: "GET",
      url: "/api/admin/oauth-apps",
      headers: headers("admin.console.read"),
    });
    expect(list.statusCode).toBe(200);
    const apps = field(list, "apps") as { name: string; status: string }[];
    expect(apps).toHaveLength(1);
    expect(apps[0]?.name).toBe("GitHub");
    expect(apps[0]?.status).toBe("pending");
  });

  it("paginates with a keyset cursor", async () => {
    const { app } = await buildApp();
    await seed(app, "App A");
    await seed(app, "App B");
    await seed(app, "App C");

    const firstPage = await app.inject({
      method: "GET",
      url: "/api/admin/oauth-apps?limit=2",
      headers: headers("admin.console.read"),
    });
    expect(field(firstPage, "apps") as unknown[]).toHaveLength(2);
    const cursor = field(firstPage, "nextCursor") as string;
    expect(cursor).not.toBeNull();

    const secondPage = await app.inject({
      method: "GET",
      url: `/api/admin/oauth-apps?limit=2&cursor=${encodeURIComponent(cursor)}`,
      headers: headers("admin.console.read"),
    });
    expect(field(secondPage, "apps") as unknown[]).toHaveLength(1);
    expect(body(secondPage).nextCursor).toBeNull();
  });

  it("filters by status and risk", async () => {
    const { app } = await buildApp();
    const highId = await seed(app, "Apollo", "high");
    await seed(app, "Linear", "low");
    await app.inject({
      method: "PATCH",
      url: `/api/admin/oauth-apps/${highId}/status`,
      headers: headers("admin.console.write"),
      payload: { status: "blocked" },
    });
    const blocked = await app.inject({
      method: "GET",
      url: "/api/admin/oauth-apps?status=blocked",
      headers: headers("admin.console.read"),
    });
    const blockedApps = field(blocked, "apps") as { name: string }[];
    expect(blockedApps).toHaveLength(1);
    expect(blockedApps[0]?.name).toBe("Apollo");

    const highRisk = await app.inject({
      method: "GET",
      url: "/api/admin/oauth-apps?risk=high",
      headers: headers("admin.console.read"),
    });
    expect(field(highRisk, "apps") as unknown[]).toHaveLength(1);
  });

  it("revokes an app and fires the onRevoke hook", async () => {
    const revoked: string[] = [];
    const { app } = await buildApp({
      onRevoke: ({ app: oauthApp }) => {
        revoked.push(oauthApp.name);
      },
    });
    const id = await seed(app, "helper-bot", "high");
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/oauth-apps/${id}/revoke`,
      headers: headers("admin.console.write"),
    });
    expect(response.statusCode).toBe(200);
    expect((field(response, "app") as { status: string }).status).toBe("revoked");
    expect(revoked).toEqual(["helper-bot"]);
  });

  it("rejects a malformed cursor with a 400 envelope", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/oauth-apps?cursor=not-valid",
      headers: headers("admin.console.read"),
    });
    expect(response.statusCode).toBe(400);
    expect(body(response).code).toBe("invalid_cursor");
  });

  it("rejects the revoked status via the status endpoint", async () => {
    const { app } = await buildApp();
    const id = await seed(app, "Notion");
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/oauth-apps/${id}/status`,
      headers: headers("admin.console.write"),
      payload: { status: "revoked" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires the write scope to revoke", async () => {
    const { app } = await buildApp();
    const id = await seed(app, "Loom");
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/oauth-apps/${id}/revoke`,
      headers: headers("admin.console.read"),
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 404 for an unknown app", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/oauth-apps/44444444-4444-4444-8444-444444444444",
      headers: headers("admin.console.read"),
    });
    expect(response.statusCode).toBe(404);
  });
});
