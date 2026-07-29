import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import type {
  AdminServiceRuntimeStatus,
  AdminServiceRuntimeStatusStore,
} from "./service-status.js";

const adminConfigReadScope = "admin.config.read";
const adminConfigWriteScope = "admin.config.write";
const adminServicesReadScope = "admin.services.read";

const serviceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u);

const serviceParamsSchema = z.object({
  serviceId: serviceIdSchema,
});

export type AdminServiceStatus = "ready" | "configured" | "missing" | "degraded" | "disabled";
export type AdminServiceCategory =
  "workspace" | "communication" | "platform" | "security" | "integrations" | "ai";
export type AdminDependencyType =
  | "database"
  | "object-storage"
  | "event-bus"
  | "cache"
  | "search"
  | "external-service"
  | "secret"
  | "runtime";

export interface AdminServiceDependency {
  readonly id: string;
  readonly label: string;
  readonly type: AdminDependencyType;
  readonly required: boolean;
  readonly status: AdminServiceStatus;
  readonly envKeys: readonly string[];
  readonly evidence: string;
}

export interface AdminServiceConfigItem {
  readonly key: string;
  readonly label: string;
  readonly envKeys: readonly string[];
  readonly configured: boolean;
  readonly sensitive: boolean;
  readonly status: AdminServiceStatus;
  readonly evidence: string;
}

export interface AdminServiceAction {
  readonly id: string;
  readonly label: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly requiredScope: string;
  readonly destructive: boolean;
}

export interface AdminServiceSurface {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly summary: string;
  readonly category: AdminServiceCategory;
  readonly status: AdminServiceStatus;
  readonly enabled: boolean;
  readonly evidence: string;
  readonly scopes: readonly string[];
  readonly adminScopes: readonly string[];
  readonly uiRoutes: readonly string[];
  readonly apiRoutes: readonly string[];
  readonly realtimeRoutes: readonly string[];
  readonly tools: readonly string[];
  readonly capabilities: readonly string[];
  readonly consumes: readonly string[];
  readonly dataStores: readonly string[];
  readonly dependencies: readonly AdminServiceDependency[];
  readonly configuration: readonly AdminServiceConfigItem[];
  readonly aiSlots: readonly string[];
  readonly enrichments: readonly string[];
  readonly adminActions: readonly AdminServiceAction[];
  readonly metrics: readonly string[];
}

export interface AdminServicesResponse {
  readonly generatedAt: string;
  readonly services: readonly AdminServiceSurface[];
}

export interface AdminServiceResponse {
  readonly generatedAt: string;
  readonly service: AdminServiceSurface;
}

export interface AdminServiceReadinessResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly status: AdminServiceStatus;
  readonly enabled: boolean;
  readonly evidence: string;
  readonly dependencies: readonly AdminServiceDependency[];
}

export interface AdminServiceConfigurationResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly configuration: readonly AdminServiceConfigItem[];
}

export interface AdminServiceCapabilitiesResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly capabilities: readonly string[];
  readonly consumes: readonly string[];
  readonly aiSlots: readonly string[];
  readonly enrichments: readonly string[];
  readonly routes: {
    readonly ui: readonly string[];
    readonly api: readonly string[];
    readonly realtime: readonly string[];
  };
}

export interface AdminServiceToolsResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly tools: readonly string[];
  readonly scopes: readonly string[];
  readonly adminScopes: readonly string[];
}

export interface AdminServiceActionsResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly actions: readonly AdminServiceAction[];
}

export interface AdminServiceRoutesResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly routes: {
    readonly ui: readonly string[];
    readonly api: readonly string[];
    readonly realtime: readonly string[];
  };
}

export interface AdminServiceScopesResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly scopes: readonly string[];
  readonly adminScopes: readonly string[];
}

export interface AdminServiceDataResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly dataStores: readonly string[];
}

export interface AdminServiceDependenciesResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly dependencies: readonly AdminServiceDependency[];
}

export interface AdminServiceMetricsResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly metrics: readonly string[];
}

export interface AdminServiceAiResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly aiSlots: readonly string[];
  readonly enrichments: readonly string[];
}

export interface AdminServiceOperationsResponse {
  readonly generatedAt: string;
  readonly serviceId: string;
  readonly actions: readonly AdminServiceAction[];
  readonly metrics: readonly string[];
}

export interface AdminServicesStatusResponse {
  readonly generatedAt: string;
  readonly statuses: readonly AdminServiceRuntimeStatus[];
}

export interface AdminServiceStatusResponse {
  readonly generatedAt: string;
  readonly status: AdminServiceRuntimeStatus;
}

interface AdminServiceDefinition {
  readonly id: string;
  readonly pluginId: string;
  readonly label: string;
  readonly summary: string;
  readonly category: AdminServiceCategory;
  readonly scopes: readonly string[];
  readonly adminScopes: readonly string[];
  readonly uiRoutes: readonly string[];
  readonly apiRoutes: readonly string[];
  readonly realtimeRoutes: readonly string[];
  readonly tools: readonly string[];
  readonly capabilities: readonly string[];
  readonly consumes: readonly string[];
  readonly dataStores: readonly string[];
  readonly dependencies: readonly AdminDependencyDefinition[];
  readonly configuration: readonly AdminConfigDefinition[];
  readonly aiSlots: readonly string[];
  readonly enrichments: readonly string[];
  readonly adminActions: readonly AdminServiceAction[];
  readonly metrics: readonly string[];
}

interface AdminDependencyDefinition {
  readonly id: string;
  readonly label: string;
  readonly type: AdminDependencyType;
  readonly required: boolean;
  readonly envAnyOf: readonly string[];
  readonly evidenceWhenConfigured: string;
  readonly evidenceWhenMissing: string;
}

interface AdminConfigDefinition {
  readonly key: string;
  readonly label: string;
  readonly envAnyOf: readonly string[];
  readonly required: boolean;
  readonly sensitive?: boolean | undefined;
}

export interface AdminServicesCatalogOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly now?: (() => Date) | undefined;
}

export class AdminServicesCatalog {
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => Date;

  constructor(options: AdminServicesCatalogOptions) {
    this.#env = options.env;
    this.#now = options.now ?? (() => new Date());
  }

  list(): AdminServicesResponse {
    return {
      generatedAt: this.generatedAt(),
      services: serviceDefinitions.map((definition) => renderServiceSurface(definition, this.#env)),
    };
  }

  generatedAt(): string {
    return this.#now().toISOString();
  }

  get(serviceId: string): AdminServiceResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      service,
    };
  }

  readiness(serviceId: string): AdminServiceReadinessResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      status: service.status,
      enabled: service.enabled,
      evidence: service.evidence,
      dependencies: service.dependencies,
    };
  }

  configuration(serviceId: string): AdminServiceConfigurationResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      configuration: service.configuration,
    };
  }

  capabilities(serviceId: string): AdminServiceCapabilitiesResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      capabilities: service.capabilities,
      consumes: service.consumes,
      aiSlots: service.aiSlots,
      enrichments: service.enrichments,
      routes: {
        ui: service.uiRoutes,
        api: service.apiRoutes,
        realtime: service.realtimeRoutes,
      },
    };
  }

  tools(serviceId: string): AdminServiceToolsResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      tools: service.tools,
      scopes: service.scopes,
      adminScopes: service.adminScopes,
    };
  }

  actions(serviceId: string): AdminServiceActionsResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      actions: service.adminActions,
    };
  }

  routes(serviceId: string): AdminServiceRoutesResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      routes: {
        ui: service.uiRoutes,
        api: service.apiRoutes,
        realtime: service.realtimeRoutes,
      },
    };
  }

  scopes(serviceId: string): AdminServiceScopesResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      scopes: service.scopes,
      adminScopes: service.adminScopes,
    };
  }

  data(serviceId: string): AdminServiceDataResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      dataStores: service.dataStores,
    };
  }

  dependencies(serviceId: string): AdminServiceDependenciesResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      dependencies: service.dependencies,
    };
  }

  metrics(serviceId: string): AdminServiceMetricsResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      metrics: service.metrics,
    };
  }

  ai(serviceId: string): AdminServiceAiResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      aiSlots: service.aiSlots,
      enrichments: service.enrichments,
    };
  }

  operations(serviceId: string): AdminServiceOperationsResponse | null {
    const service = this.#surface(serviceId);
    if (service === null) {
      return null;
    }
    return {
      generatedAt: this.#now().toISOString(),
      serviceId: service.id,
      actions: service.adminActions,
      metrics: service.metrics,
    };
  }

  #surface(serviceId: string): AdminServiceSurface | null {
    const definition = serviceDefinitions.find((service) => service.id === serviceId);
    if (definition === undefined) {
      return null;
    }
    return renderServiceSurface(definition, this.#env);
  }
}

export interface RegisterAdminServicesRoutesOptions {
  readonly catalog: AdminServicesCatalog;
  readonly statusStore?: AdminServiceRuntimeStatusStore | undefined;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

export async function registerAdminServicesRoutes(
  app: FastifyInstance,
  options: RegisterAdminServicesRoutesOptions,
): Promise<void> {
  app.get("/api/admin/services", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }
    return options.catalog.list();
  });

  app.get("/api/admin/services/status", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const services = options.catalog.list().services;
    const statusStore = options.statusStore;
    const statuses =
      statusStore === undefined
        ? []
        : (
            await Promise.all(
              services.map((service) =>
                statusStore.get({ serviceId: service.id, orgId: actor.orgId }),
              ),
            )
          ).filter((status): status is AdminServiceRuntimeStatus => status !== null);

    return {
      generatedAt: options.catalog.generatedAt(),
      statuses,
    } satisfies AdminServicesStatusResponse;
  });

  app.get("/api/admin/services/:serviceId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const service = options.catalog.get(parsed.data.serviceId);
    if (service === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return service;
  });

  app.get("/api/admin/services/:serviceId/status", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const service = options.catalog.get(parsed.data.serviceId);
    if (service === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    if (options.statusStore === undefined) {
      return reply.code(503).send({ error: "Admin service runtime status is not configured." });
    }

    const status = await options.statusStore.get({
      serviceId: parsed.data.serviceId,
      orgId: actor.orgId,
    });
    if (status === null) {
      return reply.code(404).send({ error: "Admin service runtime status not found." });
    }

    return {
      generatedAt: options.catalog.generatedAt(),
      status,
    } satisfies AdminServiceStatusResponse;
  });

  app.get("/api/admin/services/:serviceId/readiness", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const readiness = options.catalog.readiness(parsed.data.serviceId);
    if (readiness === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return readiness;
  });

  app.get("/api/admin/services/:serviceId/config", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const configuration = options.catalog.configuration(parsed.data.serviceId);
    if (configuration === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return configuration;
  });

  app.get("/api/admin/services/:serviceId/capabilities", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const capabilities = options.catalog.capabilities(parsed.data.serviceId);
    if (capabilities === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return capabilities;
  });

  app.get("/api/admin/services/:serviceId/tools", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const tools = options.catalog.tools(parsed.data.serviceId);
    if (tools === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return tools;
  });

  app.get("/api/admin/services/:serviceId/actions", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const actions = options.catalog.actions(parsed.data.serviceId);
    if (actions === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return actions;
  });

  app.get("/api/admin/services/:serviceId/routes", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const routes = options.catalog.routes(parsed.data.serviceId);
    if (routes === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return routes;
  });

  app.get("/api/admin/services/:serviceId/scopes", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const scopes = options.catalog.scopes(parsed.data.serviceId);
    if (scopes === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return scopes;
  });

  app.get("/api/admin/services/:serviceId/data", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const data = options.catalog.data(parsed.data.serviceId);
    if (data === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return data;
  });

  app.get("/api/admin/services/:serviceId/dependencies", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const dependencies = options.catalog.dependencies(parsed.data.serviceId);
    if (dependencies === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return dependencies;
  });

  app.get("/api/admin/services/:serviceId/metrics", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const metrics = options.catalog.metrics(parsed.data.serviceId);
    if (metrics === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return metrics;
  });

  app.get("/api/admin/services/:serviceId/ai", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const ai = options.catalog.ai(parsed.data.serviceId);
    if (ai === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return ai;
  });

  app.get("/api/admin/services/:serviceId/operations", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminServices(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid admin service identifier.", issues: parsed.error.issues });
    }

    const operations = options.catalog.operations(parsed.data.serviceId);
    if (operations === null) {
      return reply.code(404).send({ error: "Admin service not found." });
    }
    return operations;
  });
}

export function canReadAdminServices(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return (
    scopes.includes(adminServicesReadScope) ||
    scopes.includes(adminConfigReadScope) ||
    scopes.includes(adminConfigWriteScope) ||
    scopes.includes("admin.config.*") ||
    scopes.includes("admin.*")
  );
}

function renderServiceSurface(
  definition: AdminServiceDefinition,
  env: NodeJS.ProcessEnv,
): AdminServiceSurface {
  const enabled = serviceEnabled(definition.id, env);
  const dependencies = definition.dependencies.map((dependency) =>
    renderDependency(dependency, env),
  );
  const configuration = definition.configuration.map((item) => renderConfigItem(item, env));
  const status = enabled ? serviceStatus(dependencies, configuration) : "disabled";
  return {
    id: definition.id,
    pluginId: definition.pluginId,
    label: definition.label,
    summary: definition.summary,
    category: definition.category,
    status,
    enabled,
    evidence: serviceEvidence(status, definition.label),
    scopes: definition.scopes,
    adminScopes: definition.adminScopes,
    uiRoutes: definition.uiRoutes,
    apiRoutes: definition.apiRoutes,
    realtimeRoutes: definition.realtimeRoutes,
    tools: definition.tools,
    capabilities: definition.capabilities,
    consumes: definition.consumes,
    dataStores: definition.dataStores,
    dependencies,
    configuration,
    aiSlots: definition.aiSlots,
    enrichments: definition.enrichments,
    adminActions: definition.adminActions,
    metrics: definition.metrics,
  };
}

function renderDependency(
  definition: AdminDependencyDefinition,
  env: NodeJS.ProcessEnv,
): AdminServiceDependency {
  const configured = anyConfigured(definition.envAnyOf, env);
  return {
    id: definition.id,
    label: definition.label,
    type: definition.type,
    required: definition.required,
    status: configured ? "configured" : "missing",
    envKeys: definition.envAnyOf,
    evidence: configured ? definition.evidenceWhenConfigured : definition.evidenceWhenMissing,
  };
}

function renderConfigItem(
  definition: AdminConfigDefinition,
  env: NodeJS.ProcessEnv,
): AdminServiceConfigItem {
  const configured = anyConfigured(definition.envAnyOf, env);
  return {
    key: definition.key,
    label: definition.label,
    envKeys: definition.envAnyOf,
    configured,
    sensitive: definition.sensitive ?? false,
    status: configured ? "configured" : definition.required ? "missing" : "ready",
    evidence: configured
      ? "Runtime configuration is present; values are not exposed through this admin surface."
      : definition.required
        ? "Required runtime configuration is missing."
        : "Optional runtime configuration is not set.",
  };
}

function serviceStatus(
  dependencies: readonly AdminServiceDependency[],
  configuration: readonly AdminServiceConfigItem[],
): AdminServiceStatus {
  if (
    dependencies.some((dependency) => dependency.required && dependency.status === "missing") ||
    configuration.some((item) => item.status === "missing")
  ) {
    return "missing";
  }
  if (dependencies.some((dependency) => !dependency.required && dependency.status === "missing")) {
    return "configured";
  }
  return "ready";
}

function serviceEvidence(status: AdminServiceStatus, label: string): string {
  switch (status) {
    case "ready":
      return `${label} has all required and optional runtime dependencies configured.`;
    case "configured":
      return `${label} has required runtime dependencies configured; optional dependencies are not fully configured.`;
    case "missing":
      return `${label} is missing required runtime configuration.`;
    case "degraded":
      return `${label} has degraded runtime evidence.`;
    case "disabled":
      return `${label} is disabled by runtime configuration.`;
  }
}

function serviceEnabled(serviceId: string, env: NodeJS.ProcessEnv): boolean {
  const normalized = serviceId.toUpperCase().replaceAll("-", "_");
  return envFlag(
    env[`HELIX_SERVICE_${normalized}_ENABLED`] ?? env[`HELIX_${normalized}_ENABLED`],
    true,
  );
}

function anyConfigured(keys: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (keys.length === 0) {
    return true;
  }
  return keys.some((key) => {
    const value = env[key];
    return value !== undefined && value.trim().length > 0;
  });
}

function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function permissionDeniedResponse(): {
  readonly error: string;
  readonly requiredScope: typeof adminConfigReadScope;
} {
  return {
    error: "Admin services permission denied.",
    requiredScope: adminConfigReadScope,
  };
}

function dependency(
  input: Omit<AdminDependencyDefinition, "evidenceWhenConfigured" | "evidenceWhenMissing"> & {
    readonly configured?: string | undefined;
    readonly missing?: string | undefined;
  },
): AdminDependencyDefinition {
  return {
    ...input,
    evidenceWhenConfigured: input.configured ?? `${input.label} runtime configuration is present.`,
    evidenceWhenMissing: input.missing ?? `${input.label} runtime configuration is missing.`,
  };
}

function config(input: AdminConfigDefinition): AdminConfigDefinition {
  return input;
}

function action(input: AdminServiceAction): AdminServiceAction {
  return input;
}

const postgresDependency = dependency({
  id: "postgres",
  label: "Postgres",
  type: "database",
  required: true,
  envAnyOf: ["DATABASE_URL"],
});

const natsDependency = dependency({
  id: "nats",
  label: "NATS event bus",
  type: "event-bus",
  required: false,
  envAnyOf: ["NATS_URL"],
  missing: "NATS_URL is not set; in-memory event bus is active for this process.",
});

const redisDependency = dependency({
  id: "redis",
  label: "Redis cache",
  type: "cache",
  required: false,
  envAnyOf: ["REDIS_URL"],
  missing: "REDIS_URL is not set; ephemeral in-process fallbacks are active.",
});

const searchDependency = dependency({
  id: "meilisearch",
  label: "Meilisearch",
  type: "search",
  required: false,
  envAnyOf: ["MEILI_URL", "MEILISEARCH_URL", "MEILI_HOST"],
  missing:
    "No Meilisearch URL is configured; keyword search falls back to store-backed behavior where available.",
});

const storageDependency = dependency({
  id: "rustfs",
  label: "RustFS / S3-compatible storage",
  type: "object-storage",
  required: false,
  envAnyOf: ["RUSTFS_ENDPOINT"],
  missing:
    "RUSTFS_ENDPOINT is not set; object storage-backed features use in-process fallbacks where available.",
});

const publicBaseUrlConfig = config({
  key: "publicBaseUrl",
  label: "Public base URL",
  envAnyOf: ["PUBLIC_BASE_URL", "HELIX_PUBLIC_URL"],
  required: false,
});

const serviceDefinitions: readonly AdminServiceDefinition[] = [
  {
    id: "mail",
    pluginId: "com.helix.core.mail",
    label: "Mail",
    summary: "SMTP ingress, outbound relay, filters, labels, vacation responders, and mail search.",
    category: "communication",
    // `mail.system` is service-only (REVIEW.md CRITICAL-4): it is included
    // here for catalog completeness but the scope catalog flags it under the
    // `service` surface so it cannot be issued on agent OAuth clients or app
    // passwords.
    scopes: ["mail.read", "mail.write", "mail.send", "mail.external", "mail.delete", "mail.system"],
    adminScopes: ["mail.admin", adminConfigReadScope, adminConfigWriteScope],
    uiRoutes: ["/mail"],
    apiRoutes: [
      "/api/admin/mail/config",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/mail.*",
      "/openapi.json",
    ],
    realtimeRoutes: [],
    tools: [
      "mail.send",
      "mail.reply",
      "mail.inbound.accept",
      "mail.label.apply",
      "mail.thread.get",
      "mail.read.set",
      "mail.star.set",
      "mail.snooze",
      "mail.filter.create",
      "mail.filter.update",
      "mail.filter.delete",
      "mail.vacation.get",
      "mail.vacation.set",
      "mail.search",
      "mail.outbound.get",
    ],
    capabilities: [
      "smtp-listener",
      "smtp-relay",
      "undo-send",
      "mail-filters",
      "vacation-responder",
      "indexer:mail",
      "enrichment:mail.entity-extract",
      "enrichment:mail.classification",
      "notification-source:mail.received",
    ],
    consumes: ["storage", "search-engine", "event-bus", "ai-router"],
    dataStores: [
      "threads",
      "messages",
      "message_attachments",
      "objects",
      "mail_filters",
      "mail_aliases",
      "mail_vacation",
      "mail_vacation_responses",
      "mail_thread_state",
      "mail_outbound_messages",
      "outbox",
    ],
    dependencies: [
      postgresDependency,
      natsDependency,
      storageDependency,
      searchDependency,
      dependency({
        id: "smtp-outbound",
        label: "Outbound SMTP relay",
        type: "external-service",
        required: false,
        envAnyOf: ["MAIL_SMTP_HOST", "SES_SMTP_HOST"],
      }),
      dependency({
        id: "smtp-receiver",
        label: "Inbound SMTP receiver",
        type: "runtime",
        required: false,
        envAnyOf: ["MAIL_SMTP_RECEIVER_ENABLED"],
      }),
    ],
    configuration: [
      config({
        key: "domains",
        label: "Accepted and sender domains",
        envAnyOf: ["HELIX_MAIL_DOMAINS", "MAIL_DOMAINS", "MAIL_FROM_DOMAIN"],
        required: false,
      }),
      config({
        key: "smtpCredentials",
        label: "Outbound SMTP credentials",
        envAnyOf: ["MAIL_SMTP_PASS", "SES_SMTP_PASS"],
        required: false,
        sensitive: true,
      }),
      config({
        key: "smtpReceiver",
        label: "Inbound SMTP receiver bind settings",
        envAnyOf: ["MAIL_SMTP_RECEIVER_HOST", "MAIL_SMTP_RECEIVER_PORT"],
        required: false,
      }),
      config({
        key: "smtpRateLimits",
        label: "SMTP send rate and size limits",
        envAnyOf: [
          "MAIL_SEND_RATE_LIMIT_PER_HOUR",
          "MAIL_SEND_RATE_LIMIT_PER_DAY",
          "MAIL_MAX_MESSAGE_BYTES",
        ],
        required: false,
      }),
      config({
        key: "dnsReadiness",
        label: "MX/SPF/DKIM/DMARC readiness evidence",
        envAnyOf: [
          "MAIL_DNS_MX_VERIFIED",
          "MAIL_DNS_SPF_VERIFIED",
          "MAIL_DNS_DKIM_VERIFIED",
          "MAIL_DNS_DMARC_VERIFIED",
          "MAIL_DNS_MX_EXPECTED",
          "MAIL_SPF_RECORD",
          "MAIL_DKIM_SELECTOR",
          "MAIL_DKIM_RECORD",
          "MAIL_DMARC_POLICY",
        ],
        required: false,
      }),
    ],
    aiSlots: [
      "mail.compose-help",
      "mail.subject-from-body",
      "mail.summarize-thread",
      "mail.suggest-reply",
    ],
    enrichments: ["mail.entity-extract", "mail.classification"],
    adminActions: [
      action({
        id: "mail.config.read",
        label: "Read mail configuration status",
        method: "GET",
        path: "/api/admin/mail/config",
        requiredScope: adminConfigReadScope,
        destructive: false,
      }),
    ],
    metrics: [
      'helix_tool_invocations_total{tool_id="mail.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="mail.*"}',
      'helix_permission_checks_total{resource_type="tool",action="mail.*"}',
      'helix_audit_activity_total{object_type="tool"}',
    ],
  },
  {
    id: "chat",
    pluginId: "com.helix.core.chat",
    label: "Chat",
    summary: "Rooms, DMs, message history, reactions, presence, and room search.",
    category: "communication",
    scopes: ["chat.read", "chat.write", "chat.post", "chat.create"],
    adminScopes: ["chat.admin", adminConfigReadScope],
    uiRoutes: ["/chat"],
    apiRoutes: ["/api/tools", "/api/tools/:toolId", "/api/tools/chat.*", "/openapi.json"],
    realtimeRoutes: ["/ws/chat", "/events/ws?subject=activity.chat.>"],
    tools: [
      "chat.send",
      "chat.react",
      "chat.room.list",
      "chat.message.list",
      "chat.edit",
      "chat.delete",
      "chat.create_room",
      "chat.invite",
      "chat.search",
    ],
    capabilities: [
      "websocket:chat",
      "presence",
      "direct-messages",
      "room-membership",
      "reactions",
      "read-receipts",
      "indexer:chat",
      "enrichment:chat.action-items",
      "notification-source:chat.message",
    ],
    consumes: ["event-bus", "cache", "search-engine", "ai-router"],
    dataStores: [
      "threads",
      "messages",
      "chat_reactions",
      "chat_room_settings",
      "chat_pins",
      "chat_read_receipts",
      "activity",
    ],
    dependencies: [postgresDependency, natsDependency, redisDependency, searchDependency],
    configuration: [
      config({
        key: "presenceTtl",
        label: "Presence TTL",
        envAnyOf: ["CHAT_PRESENCE_TTL_SECONDS"],
        required: false,
      }),
    ],
    aiSlots: ["chat.suggest-reply", "chat.summarize-room"],
    enrichments: ["chat.action-items"],
    adminActions: [],
    metrics: [
      'helix_tool_invocations_total{tool_id="chat.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="chat.*"}',
      'helix_permission_checks_total{resource_type="tool",action="chat.*"}',
      'helix_audit_activity_total{object_type="tool"}',
    ],
  },
  {
    id: "drive",
    pluginId: "com.helix.core.drive",
    label: "Drive",
    summary: "Files, folders, versions, previews, sharing, trash, and Drive search.",
    category: "workspace",
    scopes: [
      "drive.read",
      "drive.read:shared",
      "drive.write",
      "drive.write:shared",
      "drive.delete",
    ],
    adminScopes: ["drive.admin", adminConfigReadScope],
    uiRoutes: ["/drive"],
    apiRoutes: [
      "/dav/files/*",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/drive.*",
      "/openapi.json",
      "/mcp",
    ],
    realtimeRoutes: [],
    tools: [
      "drive.upload",
      "drive.finalize",
      "drive.list",
      "drive.share",
      "drive.move",
      "drive.trash",
      "drive.restore",
      "drive.delete",
      "drive.search",
    ],
    capabilities: [
      "storage-client",
      "webdav",
      "webdav-locking",
      "folder-tree",
      "file-versioning",
      "preview-renderer",
      "sharing",
      "trash-restore",
      "indexer:drive",
      "notification-source:drive.activity",
    ],
    consumes: ["storage", "search-engine", "event-bus", "ai-router"],
    dataStores: ["objects", "drive_folders", "drive_versions", "permissions", "activity"],
    dependencies: [
      postgresDependency,
      storageDependency,
      searchDependency,
      dependency({
        id: "office-preview",
        label: "Office preview renderer",
        type: "external-service",
        required: false,
        envAnyOf: ["HELIX_DRIVE_OFFICE_PREVIEW_URL"],
      }),
    ],
    configuration: [
      config({
        key: "storageBucket",
        label: "Object storage bucket",
        envAnyOf: ["RUSTFS_BUCKET"],
        required: false,
      }),
      config({
        key: "serverSideEncryption",
        label: "Object storage server-side encryption",
        envAnyOf: ["RUSTFS_SERVER_SIDE_ENCRYPTION"],
        required: false,
      }),
      config({
        key: "officePreviewEndpoint",
        label: "Office preview endpoint",
        envAnyOf: ["HELIX_DRIVE_OFFICE_PREVIEW_URL"],
        required: false,
      }),
    ],
    aiSlots: ["drive.summarize-file", "drive.describe-image"],
    enrichments: ["drive.auto-tag"],
    adminActions: [],
    metrics: [
      'helix_tool_invocations_total{tool_id="drive.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="drive.*"}',
      'helix_permission_checks_total{resource_type="tool",action="drive.*"}',
      'helix_audit_activity_total{object_type="tool"}',
    ],
  },
  {
    id: "docs",
    pluginId: "com.helix.core.docs",
    label: "Docs",
    summary: "Collaborative documents, Yjs sync, comments, export, and document search.",
    category: "workspace",
    scopes: ["docs.read", "docs.write", "docs.comment", "drive.read", "drive.write"],
    adminScopes: ["docs.admin", adminConfigReadScope],
    uiRoutes: ["/docs"],
    apiRoutes: ["/api/tools", "/api/tools/:toolId", "/api/tools/docs.*", "/openapi.json", "/mcp"],
    realtimeRoutes: ["/sync/docs/:docId"],
    tools: [
      "docs.create",
      "docs.list",
      "docs.update-title",
      "docs.get",
      "docs.export",
      "docs.comment.create",
    ],
    capabilities: [
      "yjs-sync",
      "editor:tiptap",
      "comments",
      "export:markdown",
      "export:pdf",
      "export:docx",
      "indexer:docs",
      "exporter:docs",
      "enrichment:docs.outline",
    ],
    consumes: ["event-bus", "search-engine", "ai-router", "drive"],
    dataStores: ["docs_documents", "docs_updates", "docs_comments", "threads", "messages"],
    dependencies: [postgresDependency, natsDependency, searchDependency],
    configuration: [],
    aiSlots: ["docs.smart-write", "docs.summarize", "docs.translate"],
    enrichments: ["docs.outline"],
    adminActions: [],
    metrics: [
      'helix_tool_invocations_total{tool_id="docs.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="docs.*"}',
      'helix_permission_checks_total{resource_type="tool",action="docs.*"}',
      'helix_audit_activity_total{object_type="tool"}',
    ],
  },
  {
    id: "calendar",
    pluginId: "com.helix.core.calendar",
    label: "Calendar",
    summary: "Calendars, events, attendees, invitations, RSVP links, and free/busy.",
    category: "workspace",
    scopes: ["calendar.read", "calendar.read:freebusy", "calendar.write", "calendar.write:respond"],
    adminScopes: ["calendar.admin", adminConfigReadScope],
    uiRoutes: ["/calendar"],
    apiRoutes: [
      "/dav/cal/*",
      "/dav/cal/rsvp/:token",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/calendar.*",
      "/openapi.json",
      "/mcp",
    ],
    realtimeRoutes: [],
    tools: [
      "calendar.event.create",
      "calendar.event.update",
      "calendar.event.delete",
      "calendar.event.respond",
      "calendar.event.list",
      "calendar.find-time",
    ],
    capabilities: [
      "caldav",
      "caldav-propfind",
      "caldav-report",
      "ics-invitations",
      "rsvp-links",
      "freebusy",
      "recurrence-expansion",
      "indexer:calendar",
    ],
    consumes: ["mail.send", "event-bus", "search-engine", "ai-router"],
    dataStores: ["cal_calendars", "cal_events", "cal_attendees", "activity"],
    dependencies: [postgresDependency, natsDependency, searchDependency],
    configuration: [publicBaseUrlConfig],
    aiSlots: ["calendar.suggest-meeting-time", "calendar.draft-agenda"],
    enrichments: [],
    adminActions: [],
    metrics: [
      'helix_tool_invocations_total{tool_id="calendar.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="calendar.*"}',
      'helix_permission_checks_total{resource_type="tool",action="calendar.*"}',
      'helix_audit_activity_total{object_type="tool"}',
    ],
  },
  {
    id: "meet",
    pluginId: "com.helix.core.meet-jitsi",
    label: "Meet",
    summary: "Jitsi-backed rooms, JWT token minting, webhooks, and call lifecycle.",
    category: "communication",
    scopes: ["meet.read", "meet.write"],
    adminScopes: ["meet.admin", adminConfigReadScope],
    uiRoutes: ["/meet"],
    apiRoutes: [
      "/webhook/jitsi",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/meet.*",
      "/openapi.json",
    ],
    realtimeRoutes: [],
    tools: ["meet.create-room", "meet.room.list", "meet.mint-token", "meet.end-room"],
    capabilities: [
      "video:jitsi",
      "jwt-minting",
      "room-lifecycle",
      "recording-ingest",
      "webhook:jitsi",
    ],
    consumes: ["storage", "event-bus", "chat"],
    dataStores: ["meet_rooms", "threads", "activity"],
    dependencies: [
      postgresDependency,
      storageDependency,
      dependency({
        id: "jitsi-domain",
        label: "Jitsi domain",
        type: "external-service",
        required: false,
        envAnyOf: ["MEET_JITSI_DOMAIN", "JITSI_DOMAIN"],
      }),
      dependency({
        id: "jitsi-jwt-secret",
        label: "Jitsi JWT secret",
        type: "secret",
        required: false,
        envAnyOf: ["MEET_JITSI_JWT_SECRET", "JITSI_JWT_SECRET"],
      }),
    ],
    configuration: [
      publicBaseUrlConfig,
      config({
        key: "jitsiWebhookSecret",
        label: "Jitsi webhook shared secret",
        envAnyOf: ["MEET_JITSI_WEBHOOK_SHARED_SECRET", "JITSI_WEBHOOK_SECRET"],
        required: false,
        sensitive: true,
      }),
      config({
        key: "jitsiJwtClaims",
        label: "Jitsi JWT claims",
        envAnyOf: [
          "MEET_JITSI_JWT_APP_ID",
          "JITSI_JWT_APP_ID",
          "MEET_JITSI_JWT_ISSUER",
          "JITSI_JWT_ISSUER",
          "MEET_JITSI_JWT_AUDIENCE",
        ],
        required: false,
      }),
    ],
    aiSlots: ["meet.transcribe", "meet.summarize"],
    enrichments: ["meet.recording-summary"],
    adminActions: [],
    metrics: [
      'helix_tool_invocations_total{tool_id="meet.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="meet.*"}',
      'helix_permission_checks_total{resource_type="tool",action="meet.*"}',
      'helix_audit_activity_total{object_type="tool"}',
    ],
  },
  {
    id: "search",
    pluginId: "com.helix.core.search-meilisearch",
    label: "Search",
    summary: "Unified keyword and semantic search across mail, chat, drive, docs, and calendar.",
    category: "platform",
    scopes: ["search.read", "platform.read"],
    adminScopes: ["admin.search.write", adminConfigReadScope, adminConfigWriteScope],
    uiRoutes: ["/search"],
    apiRoutes: [
      "/api/admin/search/reindex",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/search.*",
      "/openapi.json",
      "/mcp",
    ],
    realtimeRoutes: ["/events/ws?subject=>"],
    tools: ["search.query"],
    capabilities: [
      "search-engine",
      "keyword-search",
      "semantic-search",
      "indexer-dispatch",
      "reindex-admin",
      "mcp-resource-search",
    ],
    consumes: [
      "event-bus",
      "vector-store",
      "embedding-provider",
      "mail",
      "chat",
      "drive",
      "docs",
      "calendar",
    ],
    dataStores: [
      "search index",
      "vector_collections",
      "vector_items",
      "objects",
      "threads",
      "messages",
      "cal_events",
      "docs_documents",
    ],
    dependencies: [postgresDependency, searchDependency, natsDependency],
    configuration: [
      config({
        key: "searchIndex",
        label: "Meilisearch index",
        envAnyOf: ["MEILI_INDEX_UID", "MEILISEARCH_INDEX_UID"],
        required: false,
      }),
      config({
        key: "searchApiKey",
        label: "Meilisearch API key",
        envAnyOf: ["MEILI_MASTER_KEY", "MEILI_API_KEY", "MEILISEARCH_API_KEY"],
        required: false,
        sensitive: true,
      }),
      config({
        key: "searchIndexer",
        label: "Search indexer controls",
        envAnyOf: ["SEARCH_EVENT_SUBJECT", "SEARCH_REINDEX_BATCH_SIZE"],
        required: false,
      }),
    ],
    aiSlots: [],
    enrichments: [],
    adminActions: [
      action({
        id: "search.reindex",
        label: "Run search reindex",
        method: "POST",
        path: "/api/admin/search/reindex",
        requiredScope: adminConfigWriteScope,
        destructive: false,
      }),
    ],
    metrics: [
      'helix_tool_invocations_total{tool_id="search.query"}',
      'helix_tool_invocation_duration_seconds{tool_id="search.query"}',
      'helix_permission_checks_total{resource_type="tool",action="platform.read"}',
    ],
  },
  {
    id: "storage",
    pluginId: "com.helix.core.storage-rustfs",
    label: "Storage",
    summary:
      "S3-compatible object storage for Drive files, mail attachments, previews, and recordings.",
    category: "platform",
    scopes: ["storage.read", "storage.write"],
    adminScopes: ["storage.admin", adminConfigReadScope],
    uiRoutes: [],
    apiRoutes: [
      "/dav/files/*",
      "/api/tools/drive.upload",
      "/api/tools/drive.finalize",
      "/openapi.json",
    ],
    realtimeRoutes: [],
    tools: ["drive.upload", "drive.finalize"],
    capabilities: ["storage", "s3-compatible", "presigned-urls", "sse-s3", "attachment-storage"],
    consumes: ["filesystem-fallback"],
    dataStores: ["objects", "RustFS bucket", "drive_versions", "message_attachments"],
    dependencies: [storageDependency],
    configuration: [
      config({
        key: "endpoint",
        label: "S3 endpoint",
        envAnyOf: ["RUSTFS_ENDPOINT"],
        required: false,
      }),
      config({
        key: "credentials",
        label: "S3 credentials",
        envAnyOf: ["RUSTFS_ACCESS_KEY", "RUSTFS_SECRET_KEY"],
        required: false,
        sensitive: true,
      }),
      config({
        key: "bucket",
        label: "S3 bucket",
        envAnyOf: ["RUSTFS_BUCKET"],
        required: false,
      }),
      config({
        key: "region",
        label: "S3 region",
        envAnyOf: ["RUSTFS_REGION"],
        required: false,
      }),
    ],
    aiSlots: [],
    enrichments: [],
    adminActions: [],
    metrics: [
      'helix_tool_invocations_total{tool_id="drive.upload"}',
      'helix_tool_invocations_total{tool_id="drive.finalize"}',
      'helix_tool_invocation_duration_seconds{tool_id="drive.upload"}',
    ],
  },
  {
    id: "ai",
    pluginId: "com.helix.core-ai-routing",
    label: "AI routing",
    summary:
      "Provider routing, cost limits, embeddings, vector stores, provenance, and enrichment workers.",
    category: "ai",
    scopes: ["ai.invoke", "assistant.chat"],
    adminScopes: ["admin.config.read", "admin.config.write", "ai.admin", "admin.plugins"],
    uiRoutes: ["/assistant", "/admin#ai"],
    apiRoutes: [
      "/api/admin/platform-config",
      "/api/admin/plugins",
      "/api/admin/plugins/:pluginId",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/assistant.*",
      "/api/tools/plugin.*",
      "/openapi.json",
      "/mcp",
    ],
    realtimeRoutes: [],
    tools: ["plugin.list", "plugin.install", "plugin.enable", "plugin.disable", "plugin.uninstall"],
    capabilities: [
      "llm-router",
      "embedding-provider",
      "vector-store",
      "cost-guard",
      "provenance",
      "plugin-provider-management",
      "enrichment-worker",
    ],
    consumes: ["secrets", "event-bus", "plugin-runtime"],
    dataStores: [
      "ai_artifacts",
      "memory_items",
      "vector_collections",
      "vector_items",
      "installed_plugins",
      "plugin_migrations",
    ],
    dependencies: [
      postgresDependency,
      natsDependency,
      dependency({
        id: "llm-provider",
        label: "LLM provider",
        type: "external-service",
        required: false,
        envAnyOf: [
          "OLLAMA_BASE_URL",
          "OPENAI_API_KEY",
          "ANTHROPIC_API_KEY",
          "BEDROCK_REGION",
          "VERTEX_PROJECT",
        ],
      }),
      dependency({
        id: "vector-store",
        label: "Vector store",
        type: "external-service",
        required: false,
        envAnyOf: [
          "PGVECTOR_DATABASE_URL",
          "QDRANT_URL",
          "MILVUS_ADDRESS",
          "CHROMA_URL",
          "WEAVIATE_URL",
        ],
      }),
    ],
    configuration: [
      config({
        key: "assistantProvider",
        label: "Assistant provider",
        envAnyOf: ["ASSISTANT_AI_PROVIDER_ID", "AI_DEFAULT_PROVIDER_ID"],
        required: false,
      }),
      config({
        key: "openAiKey",
        label: "OpenAI-compatible API key",
        envAnyOf: ["OPENAI_API_KEY"],
        required: false,
        sensitive: true,
      }),
      config({
        key: "openAiCompatible",
        label: "OpenAI-compatible endpoint and model",
        envAnyOf: ["OPENAI_BASE_URL", "OPENAI_MODEL"],
        required: false,
      }),
      config({
        key: "pluginDirectory",
        label: "Plugin directory",
        envAnyOf: ["HELIX_PLUGINS_DIR"],
        required: false,
      }),
    ],
    aiSlots: [
      "assistant.chat",
      "mail.compose-help",
      "docs.smart-write",
      "calendar.suggest-meeting-time",
    ],
    enrichments: [
      "mail.entity-extract",
      "mail.classification",
      "chat.action-items",
      "docs.outline",
    ],
    adminActions: [
      action({
        id: "ai.config.read",
        label: "Read AI routing and cost policy",
        method: "GET",
        path: "/api/admin/platform-config",
        requiredScope: adminConfigReadScope,
        destructive: false,
      }),
      action({
        id: "plugin.list",
        label: "List installable plugins",
        method: "GET",
        path: "/api/admin/plugins",
        requiredScope: "admin.plugins",
        destructive: false,
      }),
      action({
        id: "plugin.install",
        label: "Install plugin",
        method: "POST",
        path: "/api/admin/plugins/:pluginId/install",
        requiredScope: "admin.plugins",
        destructive: false,
      }),
      action({
        id: "plugin.disable",
        label: "Disable plugin",
        method: "POST",
        path: "/api/admin/plugins/:pluginId/disable",
        requiredScope: "admin.plugins",
        destructive: false,
      }),
      action({
        id: "plugin.uninstall",
        label: "Uninstall plugin",
        method: "POST",
        path: "/api/admin/plugins/:pluginId/uninstall",
        requiredScope: "admin.plugins",
        destructive: true,
      }),
    ],
    metrics: [
      "helix_llm_calls_total",
      "helix_llm_cost_usd_micros_total",
      "helix_llm_errors_total",
      "helix_llm_latency_seconds",
      "helix_llm_routing_fallback_total",
      'helix_tool_invocations_total{tool_id="plugin.*"}',
    ],
  },
  {
    id: "assistant",
    pluginId: "com.helix.core.assistant",
    label: "Assistant",
    summary:
      "Conversational assistant, slash commands, memories, and tool-call confirmation workflow.",
    category: "ai",
    scopes: [
      "assistant.chat",
      "assistant.write",
      "assistant.memory",
      "profile.read",
      "profile.write",
    ],
    adminScopes: ["assistant.admin", adminConfigReadScope],
    uiRoutes: ["/assistant"],
    apiRoutes: [
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/assistant.*",
      "/api/tools/pending/:pendingId/approve",
      "/api/tools/pending/:pendingId/cancel",
      "/openapi.json",
      "/mcp",
    ],
    realtimeRoutes: [],
    tools: [
      "assistant.conversation.create",
      "assistant.chat",
      "assistant.memory.forget",
      "assistant.confirmation.approve",
      "assistant.confirmation.cancel",
    ],
    capabilities: [
      "tool-orchestration",
      "confirmation-gates",
      "pending-action-approval",
      "memory",
      "mcp-tools",
      "slash-command-hooks",
    ],
    consumes: ["ai-router", "tool-registry", "permissions", "audit", "mcp"],
    dataStores: [
      "assistant_conversations",
      "assistant_messages",
      "memory_items",
      "assistant_memory_preferences",
      "pending_actions",
    ],
    dependencies: [postgresDependency],
    configuration: [
      config({
        key: "agentLimits",
        label: "Agent rate and cost limits",
        envAnyOf: [
          "HELIX_AGENT_LIMIT_REQUESTS_PER_MINUTE",
          "HELIX_AGENT_LIMIT_REQUESTS_PER_DAY",
          "HELIX_AGENT_LIMIT_COST_PER_DAY_USD_MICROS",
          "HELIX_AGENT_LIMIT_COST_WARNING_RATIO",
        ],
        required: false,
      }),
    ],
    aiSlots: ["assistant.chat"],
    enrichments: [],
    adminActions: [
      action({
        id: "pending.approve",
        label: "Approve pending tool action",
        method: "POST",
        path: "/api/tools/pending/:pendingId/approve",
        requiredScope: "assistant.write",
        destructive: false,
      }),
      action({
        id: "pending.cancel",
        label: "Cancel pending tool action",
        method: "POST",
        path: "/api/tools/pending/:pendingId/cancel",
        requiredScope: "assistant.write",
        destructive: false,
      }),
    ],
    metrics: [
      'helix_tool_invocations_total{tool_id="assistant.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="assistant.*"}',
      "helix_agent_tool_limiter_denials_total",
      'helix_llm_calls_total{feature="assistant.chat"}',
    ],
  },
  {
    id: "webhooks",
    pluginId: "com.helix.webhook-engine",
    label: "Webhooks",
    summary:
      "Outbound deliveries, inbound HMAC sources, retry worker, replay, and verification docs.",
    category: "integrations",
    scopes: ["webhook.read", "webhook.write"],
    adminScopes: ["admin.webhooks", adminConfigReadScope],
    uiRoutes: ["/admin#webhooks"],
    apiRoutes: [
      "/webhooks/:slug",
      "/docs/webhooks/verify",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/webhook.*",
      "/openapi.json",
      "/asyncapi.json",
    ],
    realtimeRoutes: ["/events/ws?subject=>"],
    tools: [
      "webhook.outbound.create",
      "webhook.outbound.update",
      "webhook.outbound.delete",
      "webhook.outbound.list",
      "webhook.outbound.test",
      "webhook.outbound.replay",
      "webhook.inbound.create",
      "webhook.inbound.update",
      "webhook.inbound.delete",
      "webhook.inbound.rotate-secret",
      "webhook.inbound.list",
      "webhook.delivery.get",
      "webhook.delivery.list",
    ],
    capabilities: [
      "webhook-delivery",
      "webhook-ingress",
      "hmac-verification",
      "retry-worker",
      "delivery-replay",
      "provider-parsing",
      "verification-docs",
    ],
    consumes: ["event-bus", "tool-registry", "secrets"],
    dataStores: ["outbound_webhooks", "inbound_webhooks", "webhook_deliveries"],
    dependencies: [postgresDependency, natsDependency],
    configuration: [
      config({
        key: "retryCadence",
        label: "Retry worker cadence",
        envAnyOf: ["WEBHOOK_RETRY_BATCH_SIZE", "WEBHOOK_RETRY_INTERVAL_MS"],
        required: false,
      }),
      config({
        key: "eventSubject",
        label: "Webhook event subject",
        envAnyOf: ["WEBHOOK_EVENT_SUBJECT"],
        required: false,
      }),
    ],
    aiSlots: [],
    enrichments: [],
    adminActions: [
      action({
        id: "webhook.outbound.test",
        label: "Send outbound webhook test event",
        method: "POST",
        path: "/api/tools/webhook.outbound.test",
        requiredScope: "admin.webhooks",
        destructive: false,
      }),
      action({
        id: "webhook.outbound.replay",
        label: "Replay failed outbound webhook delivery",
        method: "POST",
        path: "/api/tools/webhook.outbound.replay",
        requiredScope: "admin.webhooks",
        destructive: false,
      }),
    ],
    metrics: [
      'helix_tool_invocations_total{tool_id="webhook.*"}',
      'helix_tool_invocation_duration_seconds{tool_id="webhook.*"}',
      'helix_permission_checks_total{resource_type="tool",action="admin.webhooks"}',
      'helix_audit_activity_total{object_type="tool"}',
    ],
  },
  {
    id: "auth",
    pluginId: "com.helix.core.auth-better-auth",
    label: "Auth and actors",
    summary: "Better-Auth sessions, users, agents, app passwords, OAuth clients, and scopes.",
    category: "security",
    scopes: ["profile.read", "profile.write"],
    adminScopes: ["admin.users", "admin.agents", "admin.config.read"],
    uiRoutes: ["/admin#users", "/admin#access"],
    apiRoutes: [
      "/api/auth/*",
      "/api/admin/users",
      "/oauth/token",
      "/api/tools",
      "/api/tools/:toolId",
      "/api/tools/agent.credentials.*",
      "/api/tools/app.passwords.*",
      "/openapi.json",
    ],
    realtimeRoutes: [],
    tools: [
      "agent.credentials.create",
      "agent.credentials.list",
      "agent.credentials.revoke",
      "app.passwords.create",
      "app.passwords.list",
      "app.passwords.revoke",
    ],
    capabilities: [
      "session-auth",
      "better-auth",
      "app-passwords",
      "dav-basic-auth",
      "oauth-client-credentials",
      "actor-directory",
      "scoped-credentials",
    ],
    consumes: ["database", "cache", "audit"],
    dataStores: [
      "actors",
      "oauth_clients",
      "oauth_access_tokens",
      "app_passwords",
      "agent_credentials",
    ],
    dependencies: [postgresDependency, redisDependency],
    configuration: [
      config({
        key: "betterAuthSecret",
        label: "Better-Auth secret",
        envAnyOf: ["BETTER_AUTH_SECRET"],
        required: false,
        sensitive: true,
      }),
      config({
        key: "betterAuthDatabase",
        label: "Better-Auth database URL",
        envAnyOf: ["BETTER_AUTH_DATABASE_URL", "DATABASE_URL"],
        required: false,
        sensitive: true,
      }),
      config({
        key: "trustedOrigins",
        label: "Trusted origins",
        envAnyOf: ["BETTER_AUTH_TRUSTED_ORIGINS", "CLIENT_ORIGIN"],
        required: false,
      }),
      config({
        key: "betterAuthUrl",
        label: "Better-Auth public URL",
        envAnyOf: ["BETTER_AUTH_URL", "HELIX_PUBLIC_URL", "PUBLIC_BASE_URL"],
        required: false,
      }),
    ],
    aiSlots: [],
    enrichments: [],
    adminActions: [
      action({
        id: "users.list",
        label: "List users and actors",
        method: "GET",
        path: "/api/admin/users",
        requiredScope: "admin.users",
        destructive: false,
      }),
      action({
        id: "agent.credentials.create",
        label: "Create scoped agent credential",
        method: "POST",
        path: "/api/tools/agent.credentials.create",
        requiredScope: "admin.agents",
        destructive: false,
      }),
      action({
        id: "app.passwords.create",
        label: "Create scoped app password",
        method: "POST",
        path: "/api/tools/app.passwords.create",
        requiredScope: "admin.users",
        destructive: false,
      }),
    ],
    metrics: [
      'helix_tool_invocations_total{tool_id="agent.credentials.*"}',
      'helix_tool_invocations_total{tool_id="app.passwords.*"}',
      'helix_permission_checks_total{resource_type="tool",action="admin.users"}',
      'helix_permission_checks_total{resource_type="tool",action="admin.agents"}',
      'helix_audit_activity_total{verb="agent.credential.*",object_type="tool"}',
      'helix_audit_activity_total{verb="app.password.*",object_type="tool"}',
    ],
  },
  {
    id: "audit",
    pluginId: "com.helix.core.audit",
    label: "Audit",
    summary: "Immutable activity records, hash-chain verification, shipping, and restore evidence.",
    category: "security",
    scopes: ["admin.audit"],
    adminScopes: ["admin.audit", adminConfigReadScope],
    uiRoutes: ["/admin#audit"],
    apiRoutes: ["/api/admin/audit-log", "/openapi.json"],
    realtimeRoutes: ["/events/ws?subject=>"],
    tools: [],
    capabilities: [
      "audit-log",
      "hash-chain",
      "audit-verifier",
      "audit-shipping",
      "immutable-object-lock",
    ],
    consumes: ["storage", "event-bus", "tool-registry"],
    dataStores: ["activity", "immutable S3 audit bucket"],
    dependencies: [
      postgresDependency,
      natsDependency,
      dependency({
        id: "immutable-audit-storage",
        label: "Immutable audit object storage",
        type: "object-storage",
        required: false,
        envAnyOf: ["AUDIT_IMMUTABLE_S3_ENDPOINT", "AUDIT_S3_ENDPOINT"],
      }),
    ],
    configuration: [
      config({
        key: "immutableShipping",
        label: "Immutable audit shipping",
        envAnyOf: [
          "AUDIT_IMMUTABLE_S3_ENABLED",
          "AUDIT_IMMUTABLE_S3_ENDPOINT",
          "AUDIT_S3_ENDPOINT",
        ],
        required: false,
      }),
      config({
        key: "immutableShippingCredentials",
        label: "Immutable audit storage credentials",
        envAnyOf: [
          "AUDIT_IMMUTABLE_S3_ACCESS_KEY",
          "AUDIT_S3_ACCESS_KEY",
          "AUDIT_IMMUTABLE_S3_SECRET_KEY",
          "AUDIT_S3_SECRET_KEY",
        ],
        required: false,
        sensitive: true,
      }),
      config({
        key: "immutableShippingPolicy",
        label: "Immutable audit storage policy",
        envAnyOf: [
          "AUDIT_IMMUTABLE_S3_BUCKET",
          "AUDIT_S3_BUCKET",
          "AUDIT_IMMUTABLE_S3_REGION",
          "AUDIT_S3_REGION",
          "AUDIT_IMMUTABLE_S3_PREFIX",
          "AUDIT_S3_PREFIX",
          "AUDIT_IMMUTABLE_S3_RETENTION_DAYS",
          "AUDIT_IMMUTABLE_S3_OBJECT_LOCK_MODE",
        ],
        required: false,
      }),
      config({
        key: "verifierCadence",
        label: "Audit verifier cadence",
        envAnyOf: [
          "AUDIT_VERIFIER_ENABLED",
          "AUDIT_VERIFIER_INTERVAL_MS",
          "AUDIT_VERIFIER_LEADER_LEASE",
        ],
        required: false,
      }),
    ],
    aiSlots: [],
    enrichments: [],
    adminActions: [
      action({
        id: "audit.read",
        label: "Read audit log",
        method: "GET",
        path: "/api/admin/audit-log",
        requiredScope: "admin.audit",
        destructive: false,
      }),
    ],
    metrics: [
      "helix_audit_activity_total",
      "helix_audit_hash_chain_failures_total",
      "helix_audit_hash_chain_last_verified_timestamp_seconds",
      "helix_audit_shipping_records_total",
      "helix_audit_shipping_failures_total",
      "helix_audit_shipping_lag_seconds",
      "helix_audit_shipping_backlog_records",
    ],
  },
  {
    id: "backups",
    pluginId: "com.helix.core.backups",
    label: "Backups and restore",
    summary:
      "Scripted backup and restore orchestration for Postgres, object storage, and audit evidence.",
    category: "platform",
    scopes: [],
    adminScopes: [adminConfigWriteScope],
    uiRoutes: ["/admin#security"],
    apiRoutes: ["/api/admin/backups", "/api/admin/restores", "/openapi.json"],
    realtimeRoutes: [],
    tools: [],
    capabilities: [
      "backup-orchestration",
      "restore-orchestration",
      "dry-run-by-default",
      "postgres-backup",
      "object-storage-backup",
      "audit-evidence-backup",
    ],
    consumes: ["database", "storage", "audit"],
    dataStores: ["backup archives", "restore logs", "objects", "activity"],
    dependencies: [
      dependency({
        id: "backup-script",
        label: "Backup script",
        type: "runtime",
        required: false,
        envAnyOf: ["HELIX_BACKUP_SCRIPT"],
        missing: "HELIX_BACKUP_SCRIPT is not set; default infra/scripts/backup.sh will be used.",
      }),
      dependency({
        id: "restore-script",
        label: "Restore script",
        type: "runtime",
        required: false,
        envAnyOf: ["HELIX_RESTORE_SCRIPT"],
        missing: "HELIX_RESTORE_SCRIPT is not set; default infra/scripts/restore.sh will be used.",
      }),
    ],
    configuration: [
      config({
        key: "backupDirectory",
        label: "Backup directory",
        envAnyOf: ["HELIX_BACKUP_DIR"],
        required: false,
      }),
      config({
        key: "securityTier",
        label: "Security tier",
        envAnyOf: ["HELIX_SECURITY_TIER", "HELIX_TIER"],
        required: false,
      }),
      config({
        key: "backupExecution",
        label: "Admin backup execution switch",
        envAnyOf: ["HELIX_ADMIN_BACKUP_EXECUTE"],
        required: false,
      }),
    ],
    aiSlots: [],
    enrichments: [],
    adminActions: [
      action({
        id: "backup.create",
        label: "Create backup",
        method: "POST",
        path: "/api/admin/backups",
        requiredScope: adminConfigWriteScope,
        destructive: false,
      }),
      action({
        id: "restore.create",
        label: "Restore backup",
        method: "POST",
        path: "/api/admin/restores",
        requiredScope: adminConfigWriteScope,
        destructive: true,
      }),
    ],
    metrics: [
      'helix_http_requests_total{route="/api/admin/backups"}',
      'helix_http_requests_total{route="/api/admin/restores"}',
      'helix_http_request_duration_seconds{route="/api/admin/backups"}',
      'helix_http_request_duration_seconds{route="/api/admin/restores"}',
    ],
  },
];
