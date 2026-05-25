import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  EDITORS_OOXML_FIDELITY_MODES,
  EDITORS_ROLE_IDS,
  type Actor,
  type EditorsDocumentCapabilities,
  type EditorsCoreAppModule,
  type EditorsHttpMethod,
  type EditorsHttpReply,
  type EditorsHttpRequest,
  type EditorsHttpRoute,
  type EditorsModuleRegistration,
  type EditorsOoxmlFidelityMode,
  type EditorsRoleId,
  type EditorsWebSocket,
  type EditorsWebSocketRoute,
  type EditorsWorker,
  type HelixConfig,
  type HelixEditorsRuntimeHost,
  type JsonObject,
  type JsonValue,
  type RegisterEditorsModuleOptions,
  type ToolDefinition,
} from "@helix/sdk-types";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import type { SupervisedWorker } from "../leader/election.js";

export const DEFAULT_EDITORS_CORE_APP_MODULE = "@helix/editors-core-app";
export type {
  EditorsCoreAppModule,
  EditorsHttpRoute,
  EditorsHost,
  EditorsModuleRegistration,
  EditorsOoxmlFidelityMode,
  EditorsRoleId,
  EditorsWorker,
  HelixEditorsRuntimeHost,
  RegisterEditorsModuleOptions,
} from "@helix/sdk-types";

export type EditorsCoreAppImporter = (specifier: string) => Promise<unknown>;

export interface EditorsCoreAppLogger {
  debug(input: JsonObject, message: string): void;
  info(input: JsonObject, message: string): void;
  warn(input: JsonObject, message: string): void;
  error(input: JsonObject, message: string): void;
}

export type EditorsCoreAppIntegrationResult =
  | {
      readonly status: "registered";
      readonly moduleSpecifier: string;
      readonly registration: EditorsModuleRegistration;
    }
  | {
      readonly status: "skipped";
      readonly moduleSpecifier: string;
      readonly reason: "module-not-installed" | "module-disabled";
    };

export interface RegisterEditorsCoreAppInput {
  readonly config: Pick<HelixConfig, "modules">;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger: EditorsCoreAppLogger;
  readonly importer?: EditorsCoreAppImporter;
  readonly host?: HelixEditorsRuntimeHost;
}

export interface EditorsRuntimeHostRegistrations {
  readonly routes: string[];
  readonly tools: string[];
  readonly workers: string[];
  readonly previewRenderers: string[];
  readonly aiSlots: string[];
  readonly collabGateways: string[];
}

export interface EditorsRuntimeHostWorkerSink {
  register(name: string, worker: SupervisedWorker): void;
}

export interface CreateEditorsRuntimeHostInput {
  readonly logger: EditorsCoreAppLogger;
  readonly env?: NodeJS.ProcessEnv;
  readonly app?: Pick<FastifyInstance, "route" | "get">;
  readonly actorFromRequest?: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly tools?: Pick<RuntimeToolRegistry, "register">;
  readonly workers?: EditorsRuntimeHostWorkerSink;
  readonly documents?: EditorsDocumentCapabilities;
  readonly metrics?: unknown;
  readonly events?: unknown;
}

export interface EditorsRuntimeHostBundle {
  readonly host: HelixEditorsRuntimeHost;
  readonly registrations: EditorsRuntimeHostRegistrations;
}

export async function registerEditorsCoreApp(
  input: RegisterEditorsCoreAppInput,
): Promise<EditorsCoreAppIntegrationResult> {
  const env = input.env ?? process.env;
  const moduleSpecifier =
    env.HELIX_EDITORS_CORE_APP_ENTRY ??
    env.HELIX_EDITORS_CORE_APP_MODULE ??
    DEFAULT_EDITORS_CORE_APP_MODULE;
  const required = env.HELIX_EDITORS_CORE_APP_REQUIRED === "true";
  const options = resolveEditorsModuleOptions(input.config, env);

  if (options.enabled === false) {
    input.logger.info({ moduleSpecifier }, "Editors core app disabled by config");
    return { status: "skipped", moduleSpecifier, reason: "module-disabled" };
  }

  const loaded = await loadEditorsCoreAppModule(moduleSpecifier, input.importer);
  if (loaded === null) {
    if (required) {
      throw new Error(`Editors core app package is required but not installed: ${moduleSpecifier}`);
    }
    input.logger.warn(
      { moduleSpecifier },
      "Editors core app package is not installed; skipping editors runtime registration",
    );
    return { status: "skipped", moduleSpecifier, reason: "module-not-installed" };
  }

  const host = input.host ?? createEditorsRuntimeHost({ logger: input.logger, env }).host;
  const register = loaded.registerEditorsCoreApp ?? loaded.registerEditorsModule;
  if (register === undefined) {
    throw new TypeError(
      `${moduleSpecifier} must export registerEditorsModule(host, options) as a function`,
    );
  }
  const registration = await register(host, options);
  input.logger.info(
    {
      moduleSpecifier,
      routes: registration.routes.length,
      tools: registration.tools.length,
      workers: registration.workers.length,
      previewRenderers: registration.previewRenderers.length,
      aiSlots: registration.aiSlots.length,
    },
    "Editors core app package registered",
  );
  return { status: "registered", moduleSpecifier, registration };
}

export async function loadEditorsCoreAppModule(
  specifier = DEFAULT_EDITORS_CORE_APP_MODULE,
  importer?: EditorsCoreAppImporter,
): Promise<EditorsCoreAppModule | null> {
  try {
    const moduleSpecifier = importer === undefined ? resolveImportSpecifier(specifier) : specifier;
    const importModule: EditorsCoreAppImporter =
      importer ?? (async (resolvedSpecifier) => (await import(resolvedSpecifier)) as unknown);
    const loaded = await importModule(moduleSpecifier);
    if (!isEditorsCoreAppModule(loaded)) {
      throw new TypeError(
        `${specifier} must export registerEditorsModule(host, options) as a function`,
      );
    }
    return loaded;
  } catch (error) {
    if (isMissingModuleError(error, specifier)) {
      return null;
    }
    throw error;
  }
}

export function resolveEditorsModuleOptions(
  config: Pick<HelixConfig, "modules">,
  env: NodeJS.ProcessEnv = process.env,
): RegisterEditorsModuleOptions {
  const moduleConfig = config.modules?.editors;
  const editorConfig = moduleConfig?.config;
  const ooxmlFidelityMode = resolveOoxmlFidelityMode(editorConfig);
  return {
    enabled: moduleConfig?.enabled !== false,
    enabledRoles: resolveEditorsEnabledRoles(env),
    ...(ooxmlFidelityMode === undefined ? {} : { ooxmlFidelityMode }),
    registerPlaceholders: env.HELIX_EDITORS_REGISTER_PLACEHOLDERS === "true",
  };
}

export function resolveEditorsEnabledRoles(env: NodeJS.ProcessEnv): readonly EditorsRoleId[] {
  const candidates = [
    ...splitEnvList(env.HELIX_APPS),
    ...(env.HELIX_ROLE === undefined ? [] : [env.HELIX_ROLE]),
  ];
  const roles = candidates.filter(isEditorsRoleId);
  return roles.length === 0 ? ["editors"] : [...new Set(roles)];
}

export function isEditorsRoleId(value: string): value is EditorsRoleId {
  return (EDITORS_ROLE_IDS as readonly string[]).includes(value);
}

export function createEditorsRuntimeHost(
  input: CreateEditorsRuntimeHostInput,
): EditorsRuntimeHostBundle {
  const env = input.env ?? process.env;
  const registrations: EditorsRuntimeHostRegistrations = {
    routes: [],
    tools: [],
    workers: [],
    previewRenderers: [],
    aiSlots: [],
    collabGateways: [],
  };

  const host: HelixEditorsRuntimeHost = {
    ...(env.HELIX_ROLE === undefined ? {} : { role: env.HELIX_ROLE }),
    apps: splitEnvList(env.HELIX_APPS),
    registerRoute: (routeId) => {
      pushUnique(registrations.routes, routeId);
      input.logger.debug({ routeId }, "Editors route placeholder registered");
    },
    registerTool: (toolId) => {
      pushUnique(registrations.tools, toolId);
      input.logger.debug({ toolId }, "Editors tool placeholder registered");
    },
    registerWorker: (workerId) => {
      pushUnique(registrations.workers, workerId);
      input.logger.debug({ workerId }, "Editors worker placeholder registered");
    },
    registerPreviewRenderer: (mimeType) => {
      pushUnique(registrations.previewRenderers, mimeType);
      input.logger.debug({ mimeType }, "Editors preview renderer placeholder registered");
    },
    registerAiSlot: (slotId) => {
      pushUnique(registrations.aiSlots, slotId);
      input.logger.debug({ slotId }, "Editors AI slot placeholder registered");
    },
    registerCollabGateway: (gatewayId) => {
      pushUnique(registrations.collabGateways, gatewayId);
      input.logger.debug({ gatewayId }, "Editors collab gateway placeholder registered");
    },
    log: (level, message) => {
      input.logger[level]({}, message);
    },
  };

  if (input.app !== undefined) {
    const app = input.app;
    Object.assign(host, {
      http: {
        route: (route: EditorsHttpRoute) => {
          registerFastifyRoute(app, route, input.actorFromRequest);
          pushUnique(registrations.routes, routeLabel(route));
        },
        websocket: (route: EditorsWebSocketRoute) => {
          registerFastifyWebSocket(app, route);
          pushUnique(registrations.collabGateways, route.path);
        },
      },
    } satisfies Pick<HelixEditorsRuntimeHost, "http">);
  }

  if (input.tools !== undefined) {
    Object.assign(host, {
      tools: {
        register: (tool: ToolDefinition) => {
          input.tools?.register(tool);
          pushUnique(registrations.tools, tool.id);
        },
      },
    } satisfies Pick<HelixEditorsRuntimeHost, "tools">);
  }

  if (input.workers !== undefined) {
    Object.assign(host, {
      workers: {
        register: (name: string, worker: EditorsWorker) => {
          input.workers?.register(name, worker);
          pushUnique(registrations.workers, name);
        },
      },
    } satisfies Pick<HelixEditorsRuntimeHost, "workers">);
  }

  if (input.documents !== undefined) {
    Object.assign(host, {
      documents: input.documents,
    } satisfies Pick<HelixEditorsRuntimeHost, "documents">);
  }

  return { host, registrations };
}

function registerFastifyRoute(
  app: Pick<FastifyInstance, "route">,
  route: EditorsHttpRoute,
  actorFromRequest?: (request: FastifyRequest) => Actor | Promise<Actor>,
): void {
  app.route({
    method: route.method,
    url: route.path,
    ...(route.schema === undefined ? {} : { schema: route.schema }),
    handler: async (request, reply) => {
      await route.handler(
        await toEditorsHttpRequest(request, actorFromRequest),
        toEditorsHttpReply(reply),
      );
    },
  });
}

function registerFastifyWebSocket(
  app: Pick<FastifyInstance, "get">,
  route: EditorsWebSocketRoute,
): void {
  app.get(route.path, { websocket: true }, async (socket, request) => {
    await route.handler(toEditorsWebSocket(socket), await toEditorsHttpRequest(request));
  });
}

function routeLabel(route: EditorsHttpRoute): string {
  return `${route.method.toUpperCase()} ${route.path}`;
}

async function toEditorsHttpRequest(
  request: FastifyRequest,
  actorFromRequest?: (request: FastifyRequest) => Actor | Promise<Actor>,
): Promise<EditorsHttpRequest> {
  const actor = await actorFromRequest?.(request);
  const tenant = (request as unknown as { readonly tenant?: { readonly orgId?: string } | null })
    .tenant;
  return {
    method: request.method as EditorsHttpMethod,
    url: request.url,
    headers: normalizeStringRecord(request.headers),
    params: normalizeParams(request.params),
    query: normalizeStringRecord(request.query),
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(actor === undefined ? {} : { actor }),
    ...(tenant?.orgId === undefined ? {} : { orgId: tenant.orgId }),
    traceId: request.id,
  };
}

function toEditorsHttpReply(reply: FastifyReply): EditorsHttpReply {
  return {
    status(code) {
      reply.code(code);
      return this;
    },
    header(name, value) {
      reply.header(name, value);
      return this;
    },
    async send(payload) {
      await reply.send(payload);
    },
  };
}

function toEditorsWebSocket(socket: unknown): EditorsWebSocket {
  return socket as EditorsWebSocket;
}

function normalizeParams(value: unknown): Record<string, string> {
  if (!isObjectRecord(value)) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      normalized[key] = item;
    }
  }
  return normalized;
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string | readonly string[] | undefined> {
  if (!isObjectRecord(value)) {
    return {};
  }
  const normalized: Record<string, string | readonly string[] | undefined> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || item === undefined) {
      normalized[key] = item;
    } else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
      normalized[key] = item;
    }
  }
  return normalized;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveOoxmlFidelityMode(
  config: JsonObject | undefined,
): EditorsOoxmlFidelityMode | undefined {
  const value = config?.ooxmlFidelityMode ?? config?.ooxml;
  return typeof value === "string" && isOoxmlFidelityMode(value) ? value : undefined;
}

function isOoxmlFidelityMode(value: string): value is EditorsOoxmlFidelityMode {
  return (EDITORS_OOXML_FIDELITY_MODES as readonly string[]).includes(value);
}

function isEditorsCoreAppModule(value: unknown): value is EditorsCoreAppModule {
  return (
    typeof value === "object" &&
    value !== null &&
    (("registerEditorsModule" in value && typeof value.registerEditorsModule === "function") ||
      ("registerEditorsCoreApp" in value && typeof value.registerEditorsCoreApp === "function"))
  );
}

function resolveImportSpecifier(specifier: string): string {
  if (specifier.startsWith("file:")) {
    return specifier;
  }
  const require = createRequire(import.meta.url);
  const resolved = require.resolve(specifier);
  return pathToFileURL(resolved).href;
}

function isMissingModuleError(error: unknown, specifier: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = errorCode(error);
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  return error.message.includes(specifier);
}

function errorCode(error: Error): string | undefined {
  const value = (error as Error & { readonly code?: JsonValue }).code;
  return typeof value === "string" ? value : undefined;
}

function splitEnvList(value: string | undefined): readonly string[] {
  return (
    value
      ?.split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0) ?? []
  );
}

function pushUnique<T>(target: T[], value: T): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}
