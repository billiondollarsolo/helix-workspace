import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Actor, RequestContext } from "@helix/sdk-types";
import type { RuntimeToolRegistry } from "../platform/tool-registry.js";
import {
  toolInvocationOptions,
  type ToolInvocationPrincipal,
} from "../platform/auth/tool-invocation-principal.js";
import { createScopedSearchRequest, type GlobalSearchType } from "../platform/search/scope.js";
import type { SearchEngine, SearchHit } from "../platform/search/types.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  InMemoryIdempotencyStore,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  resolveIdempotency,
  type IdempotencyStore,
} from "./idempotency.js";
import { HELIX_SERVER_VERSION, MCP_PROTOCOL_VERSION } from "./version.js";

type JsonRpcId = string | number | null;
type JsonRpcRequest = {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
};

type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly error: {
        readonly code: number;
        readonly message: string;
      };
    };
type JsonRpcErrorResponse = Extract<JsonRpcResponse, { readonly error: unknown }>;

export const MCP_DEFAULT_MAX_BODY_BYTES = 256 * 1024;
export const MCP_MAX_IDENTIFIER_LENGTH = 256;
export const MCP_MAX_RESOURCE_URI_LENGTH = 2_048;

export interface McpRequestLimits {
  readonly maxBodyBytes?: number;
}

type McpHandlerInput = {
  readonly tools: RuntimeToolRegistry;
  readonly principal: ToolInvocationPrincipal;
  readonly request?: RequestContext;
  readonly body: unknown;
  readonly resources?: McpResourceProvider;
  readonly prompts?: McpPromptProvider;
  readonly idempotencyStore?: IdempotencyStore;
  readonly limits?: McpRequestLimits;
};

const defaultIdempotencyStores = new WeakMap<RuntimeToolRegistry, IdempotencyStore>();
const inFlightMutations = new Map<
  string,
  {
    readonly requestHash: string;
    readonly result: Promise<Awaited<ReturnType<RuntimeToolRegistry["invoke"]>>>;
  }
>();

/**
 * MCP prompt descriptor surfaced via `prompts/list` (P1-4).
 */
export interface McpPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
}

export interface McpPromptMessage {
  readonly role: "user" | "assistant";
  readonly content: { readonly type: "text"; readonly text: string };
}

export interface McpPromptResult {
  readonly description?: string;
  readonly messages: readonly McpPromptMessage[];
}

export interface McpPromptProvider {
  list(actor: Actor): Promise<readonly McpPrompt[]>;
  get(actor: Actor, name: string, args: Record<string, unknown>): Promise<McpPromptResult | null>;
}

/**
 * Handle an MCP JSON-RPC request inside an `mcp.<method>` span (P2-6).
 *
 * The span name carries the JSON-RPC method (e.g. `mcp.tools/call`) so MCP
 * surface traffic is observable per method alongside the existing LLM / tool /
 * permission spans.
 */
export async function handleMcpJsonRpcRequest(input: McpHandlerInput): Promise<JsonRpcResponse> {
  const request = parseJsonRpcRequest(input.body);
  if (!isAuthenticatedMcpPrincipal(input.principal)) {
    return jsonRpcError(request.id, -32001, "MCP authentication is required.");
  }
  if (
    serializedByteLength(input.body) > (input.limits?.maxBodyBytes ?? MCP_DEFAULT_MAX_BODY_BYTES)
  ) {
    return jsonRpcError(request.id, -32600, "MCP request body exceeds the allowed size.");
  }
  if (Array.isArray(input.body)) {
    return jsonRpcError(request.id, -32600, "MCP JSON-RPC batch requests are not supported.");
  }
  const method = request.method ?? "invalid";
  return trace.getTracer("helix.mcp").startActiveSpan(
    `mcp.${method}`,
    {
      attributes: {
        "helix.mcp.method": method,
        "helix.mcp.actor_type": input.principal.actor.type,
      },
    },
    async (span) => {
      try {
        const response = await dispatchMcpJsonRpcRequest(request, input);
        if ("error" in response) {
          span.setAttribute("helix.mcp.error_code", response.error.code);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return response;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

async function dispatchMcpJsonRpcRequest(
  request: JsonRpcRequest,
  input: McpHandlerInput,
): Promise<JsonRpcResponse> {
  if (request.method === undefined) {
    return jsonRpcError(request.id, -32600, "Invalid MCP JSON-RPC request.");
  }
  if (request.method.length > MCP_MAX_IDENTIFIER_LENGTH) {
    return jsonRpcError(request.id, -32600, "MCP method name exceeds the allowed size.");
  }

  switch (request.method) {
    case "initialize":
      return jsonRpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: {
          name: "helix",
          version: HELIX_SERVER_VERSION,
        },
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
      });
    case "ping":
      return jsonRpcResult(request.id, {});
    case "tools/list":
      return jsonRpcResult(request.id, {
        tools: (await input.tools.listVisible(input.principal.actor)).map((tool) => ({
          name: tool.id,
          description: tool.description,
          inputSchema: tool.inputSchema.toJsonSchema(),
          annotations: {
            permission: tool.permission,
            sideEffects: tool.sideEffects,
            confirmationRequired: tool.confirmationRequired ?? false,
            ...(tool.estimatedCostUsdMicros === undefined
              ? {}
              : { estimatedCostUsdMicros: tool.estimatedCostUsdMicros }),
          },
        })),
      });
    case "tools/call": {
      const params = parseToolCallParams(request.params);
      if (params === undefined) {
        return jsonRpcError(request.id, -32602, "tools/call requires params.name.");
      }
      if (params.name.length > MCP_MAX_IDENTIFIER_LENGTH) {
        return jsonRpcError(request.id, -32602, "Tool name exceeds the allowed size.");
      }
      const tool = input.tools.get(params.name);
      const mutationRequiresIdempotency =
        input.principal.actor.type === "agent" && tool !== undefined && tool.sideEffects !== "read";
      if (mutationRequiresIdempotency && params.idempotencyKey === undefined) {
        return jsonRpcError(
          request.id,
          -32602,
          "Agent tools/call mutations require params._meta.idempotencyKey.",
        );
      }
      if (params.idempotencyKey !== undefined && !isValidIdempotencyKey(params.idempotencyKey)) {
        return jsonRpcError(request.id, -32602, "MCP idempotency key is invalid.");
      }
      const invoke = () =>
        input.tools.invoke(params.name, params.arguments ?? {}, {
          ...toolInvocationOptions(input.principal, input.request),
          ...(params.idempotencyKey === undefined
            ? {}
            : {
                executionIdempotencyKey: params.idempotencyKey,
                idempotencyFingerprint: fingerprintRequestPayload(params.idempotencyKey),
              }),
          policyContext: {
            effectiveClassification: "standard",
            sourceIds: [],
            containsUntrustedContext: false,
            requestChannel: "mcp",
            tenantId: input.principal.actor.orgId,
          },
          enforceConfirmation: true,
        });
      const result =
        mutationRequiresIdempotency && params.idempotencyKey !== undefined
          ? await invokeMcpMutationIdempotently({
              input,
              toolId: params.name,
              arguments: params.arguments ?? {},
              idempotencyKey: params.idempotencyKey,
              invoke,
            })
          : await invoke();
      if ("jsonrpc" in result) {
        return { ...result, id: request.id ?? null };
      }
      if (!result.ok) {
        return jsonRpcError(request.id, statusToJsonRpcCode(result.statusCode), result.error);
      }
      if (result.status === "pending_confirmation") {
        return jsonRpcResult(request.id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: result.status, pending: result.pending }),
            },
          ],
          structuredContent: { status: result.status, pending: result.pending },
        });
      }
      return jsonRpcResult(request.id, {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.output),
          },
        ],
        structuredContent: result.output,
      });
    }
    case "resources/list": {
      const provider = input.resources ?? emptyResourceProvider;
      return jsonRpcResult(request.id, {
        resources: await provider.list(input.principal.actor),
      });
    }
    case "resources/read": {
      const params = parseResourceReadParams(request.params);
      if (params === undefined) {
        return jsonRpcError(request.id, -32602, "resources/read requires params.uri.");
      }
      if (params.uri.length > MCP_MAX_RESOURCE_URI_LENGTH) {
        return jsonRpcError(request.id, -32602, "Resource URI exceeds the allowed size.");
      }
      const provider = input.resources ?? emptyResourceProvider;
      let resource: McpResourceContent | null;
      try {
        resource = await provider.read(input.principal.actor, params.uri);
      } catch (error) {
        const httpError = mcpHttpError(error);
        if (httpError !== null) {
          return jsonRpcError(
            request.id,
            statusToJsonRpcCode(httpError.statusCode),
            httpError.message,
          );
        }
        throw error;
      }
      if (resource === null) {
        return jsonRpcError(request.id, -32004, `Resource not found: ${params.uri}`);
      }
      return jsonRpcResult(request.id, {
        contents: [resource],
      });
    }
    case "prompts/list": {
      const provider = input.prompts ?? createToolPromptProvider(input.tools);
      return jsonRpcResult(request.id, {
        prompts: await provider.list(input.principal.actor),
      });
    }
    case "prompts/get": {
      const params = parsePromptGetParams(request.params);
      if (params === undefined) {
        return jsonRpcError(request.id, -32602, "prompts/get requires params.name.");
      }
      if (params.name.length > MCP_MAX_IDENTIFIER_LENGTH) {
        return jsonRpcError(request.id, -32602, "Prompt name exceeds the allowed size.");
      }
      const provider = input.prompts ?? createToolPromptProvider(input.tools);
      const prompt = await provider.get(input.principal.actor, params.name, params.arguments ?? {});
      if (prompt === null) {
        return jsonRpcError(request.id, -32004, `Prompt not found: ${params.name}`);
      }
      return jsonRpcResult(request.id, prompt);
    }
    default:
      return jsonRpcError(request.id, -32601, `Unsupported MCP method: ${request.method}`);
  }
}

/**
 * Default prompt provider derived from the tool registry (P1-4): each visible
 * tool is surfaced as a "run this tool" prompt so MCP clients without a bespoke
 * prompt catalog still get a discoverable, schema-aware prompt surface.
 */
export function createToolPromptProvider(tools: RuntimeToolRegistry): McpPromptProvider {
  return {
    async list(actor) {
      return (await tools.listVisible(actor)).map((tool) => ({
        name: `tool:${tool.id}`,
        description: `Invoke the ${tool.id} tool: ${tool.description}`,
        arguments: [
          {
            name: "input",
            description: `JSON arguments for ${tool.id}, matching its input schema.`,
            required: tool.sideEffects !== "read",
          },
        ],
      }));
    },
    async get(actor, name, args) {
      if (!name.startsWith("tool:")) {
        return null;
      }
      const toolId = name.slice("tool:".length);
      const visible = await tools.listVisible(actor);
      const tool = visible.find((candidate) => candidate.id === toolId);
      if (tool === undefined) {
        return null;
      }
      const inputText = args.input === undefined ? "{}" : JSON.stringify(args.input, null, 2);
      return {
        description: `Invoke the ${tool.id} tool.`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Call the Helix tool \`${tool.id}\` (${tool.description}).`,
                `Input schema: ${JSON.stringify(tool.inputSchema.toJsonSchema())}`,
                `Arguments: ${inputText}`,
              ].join("\n"),
            },
          },
        ],
      };
    },
  };
}

/**
 * Result of an MCP request handled over the streaming/SSE transport (PRD §9.5).
 * `events` are emitted in order; for non-streaming methods this is a single
 * `message` event carrying the JSON-RPC response.
 */
export interface McpStreamEvent {
  readonly event: "message" | "progress";
  readonly data: unknown;
}

/**
 * Handles an MCP request over the SSE/streaming transport. Long-running
 * `tools/call` invocations emit an initial `progress` event so clients (and
 * proxies) keep the connection warm, followed by the terminal `message` event
 * with the JSON-RPC response. Short methods emit a single `message` event.
 */
export async function* handleMcpStreamingRequest(input: {
  readonly tools: RuntimeToolRegistry;
  readonly principal: ToolInvocationPrincipal;
  readonly request?: RequestContext;
  readonly body: unknown;
  readonly resources?: McpResourceProvider;
  readonly prompts?: McpPromptProvider;
  readonly idempotencyStore?: IdempotencyStore;
  readonly limits?: McpRequestLimits;
}): AsyncGenerator<McpStreamEvent> {
  const request = parseJsonRpcRequest(input.body);
  if (request.method === "tools/call") {
    yield {
      event: "progress",
      data: { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 0 } },
    };
  }
  const response = await handleMcpJsonRpcRequest(input);
  yield { event: "message", data: response };
}

/** Serializes a stream event to the SSE wire format. */
export function formatSseEvent(event: McpStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export interface McpResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface McpResourceProvider {
  list(actor: Actor): Promise<readonly McpResource[]>;
  read(actor: Actor, uri: string): Promise<McpResourceContent | null>;
}

export function createSearchMcpResourceProvider(engine: SearchEngine): McpResourceProvider {
  return {
    async list(actor) {
      const request = createScopedSearchRequest(actor, {
        query: "",
        limit: 25,
        attributesToRetrieve: ["id", "type", "title", "body", "url", "attributes", "updatedAt"],
      });
      if (request === undefined) {
        return [];
      }
      const response = await engine.search(request);
      return response.hits.map(hitToResource);
    },
    async read(actor, uri) {
      const parsed = parseResourceUri(uri);
      if (parsed === null) {
        return null;
      }
      const request = createScopedSearchRequest(actor, {
        query: "",
        types: [parsed.type],
        limit: 1,
        filter: `id = ${JSON.stringify(parsed.id)}`,
        attributesToRetrieve: ["id", "type", "title", "body", "url", "attributes", "updatedAt"],
      });
      if (request === undefined) {
        return null;
      }
      const response = await engine.search(request);
      const hit = response.hits.find((candidate) => candidate.id === parsed.id) ?? null;
      return hit === null
        ? null
        : {
            uri,
            mimeType: "text/markdown",
            text: hitToMarkdown(hit),
          };
    },
  };
}

function parseJsonRpcRequest(body: unknown): JsonRpcRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { id: null };
  }
  const record = body as Record<string, unknown>;
  const request: JsonRpcRequest = {
    id: isJsonRpcId(record.id) ? record.id : null,
    params: record.params,
  };
  return typeof record.method === "string" ? { ...request, method: record.method } : request;
}

function parseToolCallParams(params: unknown):
  | {
      readonly name: string;
      readonly arguments?: unknown;
      readonly idempotencyKey?: string;
    }
  | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  const metadata =
    typeof record._meta === "object" && record._meta !== null && !Array.isArray(record._meta)
      ? (record._meta as Record<string, unknown>)
      : undefined;
  const idempotencyKey =
    typeof metadata?.idempotencyKey === "string"
      ? metadata.idempotencyKey
      : typeof record.idempotencyKey === "string"
        ? record.idempotencyKey
        : undefined;
  return typeof record.name === "string"
    ? {
        name: record.name,
        arguments: record.arguments,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      }
    : undefined;
}

async function invokeMcpMutationIdempotently(input: {
  readonly input: McpHandlerInput;
  readonly toolId: string;
  readonly arguments: unknown;
  readonly idempotencyKey: string;
  readonly invoke: () => ReturnType<RuntimeToolRegistry["invoke"]>;
}): Promise<Awaited<ReturnType<RuntimeToolRegistry["invoke"]>> | JsonRpcErrorResponse> {
  const store = input.input.idempotencyStore ?? defaultIdempotencyStore(input.input.tools);
  const storageKey = idempotencyStorageKey({
    orgId: input.input.principal.actor.orgId,
    actorId: input.input.principal.actor.id,
    toolId: input.toolId,
    idempotencyKey: input.idempotencyKey,
  });
  const requestHash = fingerprintRequestPayload({
    toolId: input.toolId,
    arguments: input.arguments,
  });
  const outcome = await resolveIdempotency(store, storageKey, requestHash);
  if (outcome.kind === "conflict") {
    return jsonRpcError(null, -32009, "MCP idempotency key was reused with different arguments.");
  }
  if (outcome.kind === "replay") {
    return outcome.record.result;
  }

  const existing = inFlightMutations.get(storageKey);
  if (existing !== undefined) {
    return existing.requestHash === requestHash
      ? existing.result
      : jsonRpcError(null, -32009, "MCP idempotency key was reused with different arguments.");
  }

  const result = input.invoke();
  inFlightMutations.set(storageKey, { requestHash, result });
  try {
    const completed = await result;
    await store.set(storageKey, {
      result: completed,
      statusCode: completed.ok
        ? completed.status === "pending_confirmation"
          ? 202
          : 200
        : completed.statusCode,
      requestHash,
      expiresAt: Date.now() + DEFAULT_IDEMPOTENCY_TTL_MS,
    });
    return completed;
  } finally {
    inFlightMutations.delete(storageKey);
  }
}

function defaultIdempotencyStore(tools: RuntimeToolRegistry): IdempotencyStore {
  const existing = defaultIdempotencyStores.get(tools);
  if (existing !== undefined) {
    return existing;
  }
  const created = new InMemoryIdempotencyStore();
  defaultIdempotencyStores.set(tools, created);
  return created;
}

function isAuthenticatedMcpPrincipal(principal: ToolInvocationPrincipal): boolean {
  return principal.actor.id !== "anonymous" && principal.actor.type !== "system"
    ? principal.actor.orgId !== "00000000-0000-0000-0000-000000000000"
    : principal.actor.type === "system";
}

function serializedByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isValidIdempotencyKey(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && /^[\x21-\x7e]+$/u.test(value);
}

function parseResourceReadParams(params: unknown): { readonly uri: string } | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  return typeof record.uri === "string" ? { uri: record.uri } : undefined;
}

function parsePromptGetParams(
  params: unknown,
): { readonly name: string; readonly arguments?: Record<string, unknown> } | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  if (typeof record.name !== "string") {
    return undefined;
  }
  const args =
    typeof record.arguments === "object" &&
    record.arguments !== null &&
    !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : undefined;
  return { name: record.name, ...(args === undefined ? {} : { arguments: args }) };
}

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function mcpHttpError(
  error: unknown,
): { readonly statusCode: number; readonly message: string } | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (
    typeof statusCode !== "number" ||
    !Number.isInteger(statusCode) ||
    statusCode < 400 ||
    statusCode > 599
  ) {
    return null;
  }
  return {
    statusCode,
    message: error instanceof Error ? error.message : "MCP resource read failed.",
  };
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

function statusToJsonRpcCode(statusCode: number): number {
  if (statusCode === 400) {
    return -32602;
  }
  if (statusCode === 403) {
    return -32003;
  }
  if (statusCode === 404) {
    return -32601;
  }
  if (statusCode === 429) {
    return -32029;
  }
  return -32603;
}

const emptyResourceProvider: McpResourceProvider = {
  async list() {
    return [];
  },
  async read() {
    return null;
  },
};

function hitToResource(hit: SearchHit): McpResource {
  return {
    uri: resourceUri(hit.type, hit.id),
    name: hit.title ?? hit.id,
    description: resourceDescription(hit),
    mimeType: "text/markdown",
  };
}

function resourceDescription(hit: SearchHit): string {
  const updated = hit.updatedAt === undefined ? "" : ` updated ${hit.updatedAt}`;
  return `${hit.type} resource${updated}`;
}

function hitToMarkdown(hit: SearchHit): string {
  return [
    `# ${hit.title ?? hit.id}`,
    "",
    `Type: ${hit.type}`,
    `ID: ${hit.id}`,
    ...(hit.url === undefined ? [] : [`URL: ${hit.url}`]),
    ...(hit.updatedAt === undefined ? [] : [`Updated: ${hit.updatedAt}`]),
    "",
    hit.body ?? "",
  ]
    .join("\n")
    .trimEnd();
}

function resourceUri(type: string, id: string): string {
  return `helix://resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}`;
}

function parseResourceUri(
  uri: string,
): { readonly type: GlobalSearchType; readonly id: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return null;
  }
  if (parsed.protocol !== "helix:" || parsed.hostname !== "resources") {
    return null;
  }
  const [rawType, ...idParts] = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (!isGlobalSearchType(rawType) || idParts.length === 0) {
    return null;
  }
  return { type: rawType, id: decodeURIComponent(idParts.join("/")) };
}

function isGlobalSearchType(value: string | undefined): value is GlobalSearchType {
  return (
    value === "mail" ||
    value === "chat" ||
    value === "docs" ||
    value === "drive" ||
    value === "calendar"
  );
}
