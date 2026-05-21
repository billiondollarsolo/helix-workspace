import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { registerConnectorsAdminRoute, type ConnectorsAdminStatus } from "./admin-routes.js";
import { ConnectorRegistry } from "./registry.js";
import type { ConnectorLoadResult } from "./runtime.js";

const adminActor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Admin",
  scopes: ["admin.config.read"],
};

const viewerActor: Actor = { ...adminActor, scopes: ["mail.read"] };

function fakeConnectorResult(): ConnectorLoadResult {
  const registry = new ConnectorRegistry();
  registry.registerWebhookFormat({
    id: "slack",
    render: () => ({ contentType: "application/json", body: {} }),
  });
  return {
    registry,
    loaded: [
      {
        rootDir: "/plugins/com.helix.webhook-out-slack",
        manifest: {
          id: "com.helix.webhook-out-slack",
          name: "Slack Outbound Webhooks",
          version: "1.0.0",
          sdkVersion: "^1.0.0",
          kind: "in-process",
          capabilities: { provides: ["webhook.out.format.slack"], consumes: ["webhook.engine"] },
          permissions: {
            scopes: ["webhooks.write"],
            "outbound-network": ["hooks.slack.com"],
            filesystem: [],
            envVars: [],
          },
          // category is an additional manifest property.
          ...{ category: "connector" },
        },
      },
    ],
  };
}

async function appWithConnectorRoute(actor: Actor) {
  const app = fastify();
  registerConnectorsAdminRoute(app, {
    connectors: fakeConnectorResult(),
    actorFromRequest: () => actor,
  });
  return app;
}

describe("connectors admin route", () => {
  it("lists loaded connectors and their contributed extension points", async () => {
    const app = await appWithConnectorRoute(adminActor);
    const response = await app.inject({ method: "GET", url: "/api/admin/connectors" });
    expect(response.statusCode).toBe(200);
    const body = response.json<ConnectorsAdminStatus>();
    expect(body.loaded.map((connector) => connector.id)).toEqual([
      "com.helix.webhook-out-slack",
    ]);
    expect(body.loaded[0]).toMatchObject({ category: "connector", kind: "in-process" });
    expect(body.webhookFormats).toEqual(["slack"]);
    await app.close();
  });

  it("denies access without the admin config read scope", async () => {
    const app = await appWithConnectorRoute(viewerActor);
    const response = await app.inject({ method: "GET", url: "/api/admin/connectors" });
    expect(response.statusCode).toBe(403);
    await app.close();
  });
});
