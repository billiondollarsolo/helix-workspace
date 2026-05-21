import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import {
  AdminServicesCatalog,
  canReadAdminServices,
  registerAdminServicesRoutes,
  type AdminServiceActionsResponse,
  type AdminServiceAiResponse,
  type AdminServiceCapabilitiesResponse,
  type AdminServiceConfigurationResponse,
  type AdminServiceDataResponse,
  type AdminServiceDependenciesResponse,
  type AdminServiceMetricsResponse,
  type AdminServiceOperationsResponse,
  type AdminServiceReadinessResponse,
  type AdminServiceResponse,
  type AdminServiceRoutesResponse,
  type AdminServiceScopesResponse,
  type AdminServiceStatusResponse,
  type AdminServiceSurface,
  type AdminServicesStatusResponse,
} from "./services.js";
import type {
  AdminServiceRuntimeStatus,
  AdminServiceRuntimeStatusInput,
  AdminServiceRuntimeStatusStore,
} from "./service-status.js";

const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  displayName: "Admin",
  scopes: ["admin.config.read"],
};

describe("admin services catalog", () => {
  it("lists first-party services with runtime readiness and no secret values", () => {
    const catalog = new AdminServicesCatalog({
      env: {
        DATABASE_URL: "postgres://helix:secret-password@localhost/helix",
        RUSTFS_ENDPOINT: "http://127.0.0.1:39634",
        RUSTFS_SECRET_KEY: "rustfs-secret",
        MEILI_URL: "http://127.0.0.1:39633",
        MEILI_MASTER_KEY: "meili-secret",
        MAIL_SMTP_HOST: "smtp.example.com",
        MAIL_SMTP_PASS: "mail-secret",
        MEET_JITSI_JWT_SECRET: "jitsi-secret",
      },
      now: () => new Date("2026-05-21T14:00:00.000Z"),
    });

    const response = catalog.list();
    const serviceIds = response.services.map((service) => service.id);

    expect(serviceIds).toEqual([
      "mail",
      "chat",
      "drive",
      "docs",
      "calendar",
      "meet",
      "search",
      "storage",
      "ai",
      "assistant",
      "webhooks",
      "auth",
      "audit",
      "backups",
    ]);
    expect(response.generatedAt).toBe("2026-05-21T14:00:00.000Z");
    const mail = serviceById(response.services, "mail");
    const drive = serviceById(response.services, "drive");
    const docs = serviceById(response.services, "docs");
    const meet = serviceById(response.services, "meet");

    expect(mail).toMatchObject({
      pluginId: "com.helix.core.mail",
      status: "configured",
      adminScopes: ["mail.admin", "admin.config.read", "admin.config.write"],
    });
    expect(drive.capabilities).toEqual(
      expect.arrayContaining(["storage-client", "preview-renderer"]),
    );
    expect(drive.tools).toEqual(
      expect.arrayContaining(["drive.upload", "drive.share", "drive.search"]),
    );
    expect(drive.apiRoutes).toEqual(expect.arrayContaining(["/dav/files/*", "/mcp"]));
    expect(docs).toMatchObject({
      realtimeRoutes: ["/sync/docs/:docId"],
    });
    expect(meet.capabilities).toEqual(expect.arrayContaining(["video:jitsi", "jwt-minting"]));
    expect(JSON.stringify(response)).not.toContain("secret-password");
    expect(JSON.stringify(response)).not.toContain("rustfs-secret");
    expect(JSON.stringify(response)).not.toContain("meili-secret");
    expect(JSON.stringify(response)).not.toContain("mail-secret");
    expect(JSON.stringify(response)).not.toContain("jitsi-secret");
  });

  it("returns detail slices for service readiness, config, capabilities, tools, and actions", async () => {
    const app = fastify();
    await registerAdminServicesRoutes(app, {
      catalog: new AdminServicesCatalog({
        env: {
          DATABASE_URL: "postgres://helix@localhost/helix",
          HELIX_SERVICE_CHAT_ENABLED: "false",
          NATS_URL: "nats://127.0.0.1:4222",
          REDIS_URL: "redis://127.0.0.1:6379",
        },
        now: () => new Date("2026-05-21T14:30:00.000Z"),
      }),
      actorFromRequest: () => actor,
    });

    const detail = await app.inject({ method: "GET", url: "/api/admin/services/chat" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<AdminServiceResponse>()).toMatchObject({
      service: {
        id: "chat",
        enabled: false,
        status: "disabled",
      },
    });
    expect(detail.json<AdminServiceResponse>().service.realtimeRoutes).toEqual(
      expect.arrayContaining(["/ws/chat"]),
    );

    const readiness = await app.inject({
      method: "GET",
      url: "/api/admin/services/chat/readiness",
    });
    expect(readiness.statusCode).toBe(200);
    const readinessJson = readiness.json<AdminServiceReadinessResponse>();
    expect(readinessJson).toMatchObject({
      serviceId: "chat",
      status: "disabled",
      enabled: false,
    });
    expect(
      readinessJson.dependencies.find((dependency) => dependency.id === "postgres"),
    ).toMatchObject({
      status: "configured",
    });
    expect(
      readinessJson.dependencies.find((dependency) => dependency.id === "redis"),
    ).toMatchObject({
      status: "configured",
    });

    const configResponse = await app.inject({
      method: "GET",
      url: "/api/admin/services/mail/config",
    });
    expect(configResponse.statusCode).toBe(200);
    const configurationJson = configResponse.json<AdminServiceConfigurationResponse>();
    expect(configurationJson).toMatchObject({
      serviceId: "mail",
    });
    expect(
      configurationJson.configuration.find((item) => item.key === "smtpCredentials"),
    ).toMatchObject({
      sensitive: true,
    });

    const capabilities = await app.inject({
      method: "GET",
      url: "/api/admin/services/docs/capabilities",
    });
    expect(capabilities.statusCode).toBe(200);
    const capabilitiesJson = capabilities.json<AdminServiceCapabilitiesResponse>();
    expect(capabilitiesJson).toMatchObject({
      serviceId: "docs",
      routes: { realtime: ["/sync/docs/:docId"] },
    });
    expect(capabilitiesJson.capabilities).toEqual(
      expect.arrayContaining(["yjs-sync", "editor:tiptap"]),
    );

    const tools = await app.inject({ method: "GET", url: "/api/admin/services/drive/tools" });
    expect(tools.statusCode).toBe(200);
    const toolsJson = tools.json<{
      readonly serviceId: string;
      readonly tools: readonly string[];
      readonly scopes: readonly string[];
    }>();
    expect(toolsJson).toMatchObject({
      serviceId: "drive",
    });
    expect(toolsJson.tools).toEqual(
      expect.arrayContaining(["drive.upload", "drive.finalize", "drive.search"]),
    );
    expect(toolsJson.scopes).toEqual(expect.arrayContaining(["drive.read", "drive.write"]));

    const actions = await app.inject({
      method: "GET",
      url: "/api/admin/services/search/actions",
    });
    expect(actions.statusCode).toBe(200);
    const actionsJson = actions.json<AdminServiceActionsResponse>();
    expect(actionsJson).toMatchObject({
      serviceId: "search",
    });
    expect(actionsJson.actions[0]).toMatchObject({
      id: "search.reindex",
      method: "POST",
      path: "/api/admin/search/reindex",
    });

    await app.close();
  });

  it("returns route, scope, data, dependency, metric, ai, and operation slices", async () => {
    const app = fastify();
    await registerAdminServicesRoutes(app, {
      catalog: new AdminServicesCatalog({
        env: {
          DATABASE_URL: "postgres://helix@localhost/helix",
          RUSTFS_ENDPOINT: "http://127.0.0.1:39634",
          MEILI_URL: "http://127.0.0.1:39633",
          OLLAMA_BASE_URL: "http://127.0.0.1:11434",
          HELIX_BACKUP_SCRIPT: "infra/scripts/backup.sh",
        },
        now: () => new Date("2026-05-21T15:00:00.000Z"),
      }),
      actorFromRequest: () => actor,
    });

    const routes = await app.inject({ method: "GET", url: "/api/admin/services/drive/routes" });
    expect(routes.statusCode).toBe(200);
    const routesJson = routes.json<AdminServiceRoutesResponse>();
    expect(routesJson).toMatchObject({ serviceId: "drive" });
    expect(routesJson.routes.api).toEqual(
      expect.arrayContaining(["/dav/files/*", "/api/tools/drive.*", "/mcp"]),
    );

    const scopes = await app.inject({ method: "GET", url: "/api/admin/services/auth/scopes" });
    expect(scopes.statusCode).toBe(200);
    const scopesJson = scopes.json<AdminServiceScopesResponse>();
    expect(scopesJson.scopes).toEqual(expect.arrayContaining(["profile.read", "profile.write"]));
    expect(scopesJson.adminScopes).toEqual(expect.arrayContaining(["admin.users"]));

    const data = await app.inject({ method: "GET", url: "/api/admin/services/mail/data" });
    expect(data.statusCode).toBe(200);
    const dataJson = data.json<AdminServiceDataResponse>();
    expect(dataJson.dataStores).toEqual(
      expect.arrayContaining(["mail_outbound_messages", "mail_thread_state", "outbox"]),
    );

    const dependencies = await app.inject({
      method: "GET",
      url: "/api/admin/services/storage/dependencies",
    });
    expect(dependencies.statusCode).toBe(200);
    const dependenciesJson = dependencies.json<AdminServiceDependenciesResponse>();
    expect(
      dependenciesJson.dependencies.find((dependency) => dependency.id === "rustfs"),
    ).toMatchObject({ status: "configured" });

    const metrics = await app.inject({ method: "GET", url: "/api/admin/services/audit/metrics" });
    expect(metrics.statusCode).toBe(200);
    const metricsJson = metrics.json<AdminServiceMetricsResponse>();
    expect(metricsJson.metrics).toEqual(
      expect.arrayContaining(["helix_audit_activity_total", "helix_audit_shipping_failures_total"]),
    );

    const ai = await app.inject({ method: "GET", url: "/api/admin/services/ai/ai" });
    expect(ai.statusCode).toBe(200);
    const aiJson = ai.json<AdminServiceAiResponse>();
    expect(aiJson.aiSlots).toEqual(
      expect.arrayContaining(["assistant.chat", "mail.compose-help", "docs.smart-write"]),
    );
    expect(aiJson.enrichments).toEqual(expect.arrayContaining(["mail.classification"]));

    const operations = await app.inject({
      method: "GET",
      url: "/api/admin/services/backups/operations",
    });
    expect(operations.statusCode).toBe(200);
    const operationsJson = operations.json<AdminServiceOperationsResponse>();
    expect(operationsJson.actions.find((action) => action.id === "restore.create")).toMatchObject({
      path: "/api/admin/restores",
      destructive: true,
    });
    expect(operationsJson.metrics).toEqual(
      expect.arrayContaining(['helix_http_requests_total{route="/api/admin/backups"}']),
    );

    await app.close();
  });

  it("returns org-scoped runtime statuses for service operations dashboards", async () => {
    const statusStore = new FakeAdminServiceRuntimeStatusStore({
      mail: runtimeStatus("mail", [
        { key: "threads", label: "Mailbox threads", value: 12 },
        { key: "outboundQueued", label: "Outbound queued", value: 2 },
      ]),
      chat: runtimeStatus("chat", [{ key: "messages", label: "Messages", value: 34 }]),
    });
    const app = fastify();
    await registerAdminServicesRoutes(app, {
      catalog: new AdminServicesCatalog({
        env: { DATABASE_URL: "postgres://helix@localhost/helix" },
        now: () => new Date("2026-05-21T15:30:00.000Z"),
      }),
      statusStore,
      actorFromRequest: () => actor,
    });

    const aggregate = await app.inject({
      method: "GET",
      url: "/api/admin/services/status",
    });
    expect(aggregate.statusCode).toBe(200);
    const aggregateJson = aggregate.json<AdminServicesStatusResponse>();
    expect(aggregateJson).toMatchObject({
      generatedAt: "2026-05-21T15:30:00.000Z",
      statuses: [
        { serviceId: "mail", status: "ready" },
        { serviceId: "chat", status: "ready" },
      ],
    });
    expect(aggregateJson.statuses[0]?.counters).toEqual(
      expect.arrayContaining([
        { key: "threads", label: "Mailbox threads", value: 12 },
        { key: "outboundQueued", label: "Outbound queued", value: 2 },
      ]),
    );
    expect(statusStore.calls).toEqual(
      expect.arrayContaining([
        { serviceId: "mail", orgId: actor.orgId },
        { serviceId: "chat", orgId: actor.orgId },
      ]),
    );

    const detail = await app.inject({
      method: "GET",
      url: "/api/admin/services/mail/status",
    });
    expect(detail.statusCode).toBe(200);
    const detailJson = detail.json<AdminServiceStatusResponse>();
    expect(detailJson.status).toMatchObject({
      serviceId: "mail",
      evidence: "mail runtime status",
    });
    expect(detailJson.status.counters.find((counter) => counter.key === "threads")).toMatchObject({
      value: 12,
    });

    await app.close();
  });

  it("reports when runtime status storage is not configured", async () => {
    const app = fastify();
    await registerAdminServicesRoutes(app, {
      catalog: new AdminServicesCatalog({ env: {} }),
      actorFromRequest: () => actor,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/services/mail/status",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: "Admin service runtime status is not configured.",
    });

    await app.close();
  });

  it("protects shared admin service routes", async () => {
    const app = fastify();
    await registerAdminServicesRoutes(app, {
      catalog: new AdminServicesCatalog({ env: {} }),
      actorFromRequest: (request) => {
        const scopesHeader = request.headers["x-helix-scopes"];
        return {
          ...actor,
          scopes: typeof scopesHeader === "string" ? scopesHeader.split(" ") : [],
        };
      },
    });

    const forbidden = await app.inject({
      method: "GET",
      url: "/api/admin/services",
      headers: { "x-helix-scopes": "mail.read" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      requiredScope: "admin.config.read",
    });

    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/services",
      headers: { "x-helix-scopes": "admin.services.read" },
    });
    expect(allowed.statusCode).toBe(200);

    await app.close();
  });

  it("validates and 404s service identifiers", async () => {
    const app = fastify();
    await registerAdminServicesRoutes(app, {
      catalog: new AdminServicesCatalog({ env: {} }),
      actorFromRequest: () => actor,
    });

    const invalid = await app.inject({ method: "GET", url: "/api/admin/services/Mail" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "Invalid admin service identifier." });

    const missing = await app.inject({ method: "GET", url: "/api/admin/services/unknown" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: "Admin service not found." });

    await app.close();
  });
});

class FakeAdminServiceRuntimeStatusStore implements AdminServiceRuntimeStatusStore {
  readonly calls: AdminServiceRuntimeStatusInput[] = [];

  constructor(private readonly statuses: Partial<Record<string, AdminServiceRuntimeStatus>>) {}

  async get(input: AdminServiceRuntimeStatusInput): Promise<AdminServiceRuntimeStatus | null> {
    this.calls.push(input);
    return this.statuses[input.serviceId] ?? null;
  }
}

function runtimeStatus(
  serviceId: string,
  counters: AdminServiceRuntimeStatus["counters"],
): AdminServiceRuntimeStatus {
  return {
    generatedAt: "2026-05-21T15:30:00.000Z",
    serviceId,
    status: "ready",
    evidence: `${serviceId} runtime status`,
    counters,
    checks: [],
  };
}

function serviceById(
  services: readonly AdminServiceSurface[],
  serviceId: string,
): AdminServiceSurface {
  const service = services.find((candidate) => candidate.id === serviceId);
  if (service === undefined) {
    throw new Error(`Expected ${serviceId} admin service.`);
  }
  return service;
}

describe("admin service permissions", () => {
  it("allows config and services readers", () => {
    expect(canReadAdminServices({ ...actor, scopes: ["admin.services.read"] })).toBe(true);
    expect(canReadAdminServices({ ...actor, scopes: ["admin.config.read"] })).toBe(true);
    expect(canReadAdminServices({ ...actor, scopes: ["admin.config.write"] })).toBe(true);
    expect(canReadAdminServices({ ...actor, scopes: ["admin.*"] })).toBe(true);
    expect(canReadAdminServices({ ...actor, scopes: ["mail.read"] })).toBe(false);
  });
});
