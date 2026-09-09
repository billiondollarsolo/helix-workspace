import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import { InMemoryTenantScimCredentialStore } from "../auth/scim-credentials.js";
import { registerAdminScimCredentialRoutes } from "./scim-credentials.js";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

function headers(scopes: string): Record<string, string> {
  return {
    "x-helix-actor-id": ACTOR_ID,
    "x-helix-org-id": ORG_ID,
    "x-helix-scopes": scopes,
  };
}

async function buildApp() {
  const app = fastify();
  const credentials = new InMemoryTenantScimCredentialStore();
  const audit: unknown[] = [];
  await registerAdminScimCredentialRoutes(app, {
    credentials,
    actorFromRequest,
    auditSink: {
      async append(record) {
        audit.push(record);
        return { id: "audit", thisHash: "hash" };
      },
    },
  });
  return { app, credentials, audit };
}

describe("admin SCIM credentials", () => {
  it("issues multiple independently scoped tokens and returns plaintext once", async () => {
    const { app, credentials, audit } = await buildApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("admin.console.write"),
      payload: {
        name: "Okta users",
        scopes: ["scim.users.read", "scim.users.write"],
        sourceCidrs: ["198.51.100.0/24"],
      },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("admin.console.write"),
      payload: { name: "Entra groups", scopes: ["scim.groups.read"] },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json()).toMatchObject({
      credential: {
        name: "Okta users",
        scopes: ["scim.users.read", "scim.users.write"],
        sourceCidrs: ["198.51.100.0/24"],
        lastUsedAt: null,
      },
    });
    const token = first.json<{ token: string }>().token;
    expect(token).toMatch(/^helix_scim_/u);
    expect(JSON.stringify(await credentials.list(ORG_ID))).not.toContain(token);

    const listed = await app.inject({
      method: "GET",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("admin.console.read"),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ credentials: unknown[] }>().credentials).toHaveLength(2);
    expect(listed.body).not.toContain(token);
    expect(audit).toHaveLength(2);
    await app.close();
  });

  it("revokes one staged credential without affecting another and is idempotent", async () => {
    const { app } = await buildApp();
    const create = (name: string) =>
      app.inject({
        method: "POST",
        url: "/api/admin/identity/scim-credentials",
        headers: headers("admin.console.write"),
        payload: { name },
      });
    const first = await create("Old IdP key");
    const second = await create("New IdP key");
    const firstId = first.json<{ credential: { id: string } }>().credential.id;

    const revoked = await app.inject({
      method: "POST",
      url: `/api/admin/identity/scim-credentials/${firstId}/revoke`,
      headers: headers("admin.console.write"),
    });
    const retried = await app.inject({
      method: "POST",
      url: `/api/admin/identity/scim-credentials/${firstId}/revoke`,
      headers: headers("admin.console.write"),
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ credential: { revokedByActorId: ACTOR_ID } });
    expect(retried.json<{ credential: { revokedAt: string } }>().credential.revokedAt).toBe(
      revoked.json<{ credential: { revokedAt: string } }>().credential.revokedAt,
    );
    expect(second.json()).toMatchObject({ credential: { revokedAt: null } });
    await app.close();
  });

  it("rejects invalid policy, excessive lifetime, duplicates, and missing admin scopes", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("admin.console.write"),
      payload: { name: "Duplicate" },
    });
    const invalidPolicy = await app.inject({
      method: "POST",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("admin.console.write"),
      payload: {
        name: "Bad policy",
        scopes: ["scim.users.read", "scim.users.read"],
        sourceCidrs: ["not-a-cidr"],
      },
    });
    const excessive = await app.inject({
      method: "POST",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("admin.console.write"),
      payload: {
        name: "Too long",
        expiresAt: new Date(Date.now() + 367 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("drive.read"),
    });
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/identity/scim-credentials",
      headers: headers("admin.console.write"),
      payload: { name: "duplicate" },
    });
    expect(invalidPolicy.statusCode).toBe(400);
    expect(excessive.statusCode).toBe(400);
    expect(duplicate.statusCode).toBe(409);
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  });
});
