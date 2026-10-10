import type { Actor, RequestContext } from "@helix/sdk-types";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ToolInvocationPrincipal } from "../platform/auth/tool-invocation-principal.js";
import {
  createScopedSearchRequest,
  globalSearchTypes,
  type GlobalSearchType,
} from "../platform/search/scope.js";
import type { SearchEngine, SearchHit } from "../platform/search/types.js";
import type { RuntimeToolRegistry } from "../platform/tool-registry.js";
import type { IdempotencyStore } from "./idempotency.js";
import {
  isRecord,
  jsonRpcError,
  jsonRpcResult,
  parseJsonRpcRequest,
  requestMeta,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./mcp-jsonrpc.js";
import { createCuratedPromptProvider, type McpPromptProvider } from "./mcp-prompts.js";
import { callMcpTool, projectMcpTool } from "./mcp-tools.js";
import { HELIX_SERVER_VERSION, MCP_PROTOCOL_VERSION } from "./version.js";

const MCP_DEFAULT_MAX_BODY_BYTES = 256 * 1024;
const MCP_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MCP_MAX_IDENTIFIER_LENGTH = 256;
const MCP_MAX_RESOURCE_URI_LENGTH = 2_048;

/** Protocol revisions this server speaks, newest first. */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
];

export interface McpRequestLimits {
  readonly maxBodyBytes?: number;
  readonly requestTimeoutMs?: number;
}

export type McpHandlerInput = {
  readonly tools: RuntimeToolRegistry;
  readonly principal: ToolInvocationPrincipal;
  readonly request?: RequestContext;
  readonly body: unknown;
  readonly resources?: McpResourceProvider;
  readonly prompts?: McpPromptProvider;
  readonly idempotencyStore?: IdempotencyStore;
  readonly limits?: McpRequestLimits;
  /** `Mcp-Session-Id` echoed by the client, if any. */
  readonly sessionId?: string;
  /** Public origin used to build approval links for pending actions. */
  readonly publicBaseUrl?: string;
};

export type { McpPromptProvider } from "./mcp-prompts.js";
export type { JsonRpcResponse } from "./mcp-jsonrpc.js";

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
        const response = await dispatchWithDeadline(
          dispatchMcpJsonRpcRequest(request, input),
          input.limits?.requestTimeoutMs ?? MCP_DEFAULT_REQUEST_TIMEOUT_MS,
          request.id,
        );
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
        protocolVersion: negotiateProtocolVersion(request.params),
        serverInfo: {
          name: "helix",
          title: "Helix Workspace",
          version: HELIX_SERVER_VERSION,
        },
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
        instructions:
          "Helix tools act on the signed-in user's Mail, Drive, Chat, and Calendar. Write tools called by an agent usually return a pending action that a human must approve in Helix; ask the user to approve it and poll actions.get instead of retrying.",
      });
    case "ping":
      return jsonRpcResult(request.id, {});
    case "tools/list":
      return jsonRpcResult(request.id, {
        tools: (await input.tools.listVisible(input.principal.actor)).map((tool) =>
          projectMcpTool(tool, input.principal.actor),
        ),
      });
    case "tools/call":
      return callMcpTool(request, {
        tools: input.tools,
        principal: input.principal,
        ...(input.request === undefined ? {} : { request: input.request }),
        ...(input.idempotencyStore === undefined
          ? {}
          : { idempotencyStore: input.idempotencyStore }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        ...(input.publicBaseUrl === undefined ? {} : { publicBaseUrl: input.publicBaseUrl }),
      });
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
      const provider = input.prompts ?? createCuratedPromptProvider(input.tools);
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
      const provider = input.prompts ?? createCuratedPromptProvider(input.tools);
      const args = params.arguments ?? {};
      const listed = (await provider.list(input.principal.actor)).find(
        (prompt) => prompt.name === params.name,
      );
      const missing = (listed?.arguments ?? []).filter(
        (argument) => argument.required === true && args[argument.name] === undefined,
      );
      if (missing.length > 0) {
        return jsonRpcError(
          request.id,
          -32602,
          `Prompt ${params.name} requires arguments: ${missing.map((entry) => entry.name).join(", ")}.`,
        );
      }
      const prompt = await provider.get(input.principal.actor, params.name, args);
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
 * Picks the protocol revision for `initialize`: the client's requested
 * revision when this server supports it, otherwise the newest one.
 */
function negotiateProtocolVersion(params: unknown): string {
  const requested = isRecord(params) ? params.protocolVersion : undefined;
  return typeof requested === "string" && MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

/**
 * A server-to-client message on the Streamable HTTP SSE stream. Every event
 * uses the standard SSE `message` event carrying one JSON-RPC message.
 */
export interface McpStreamEvent {
  readonly event: "message";
  readonly data: unknown;
}

/**
 * Handles an MCP request over the SSE response of Streamable HTTP. When the
 * client supplied `params._meta.progressToken`, a `tools/call` first emits a
 * `notifications/progress` message for that token (keeping proxies warm);
 * the terminal event is always the JSON-RPC response.
 */
export async function* handleMcpStreamingRequest(
  input: McpHandlerInput,
): AsyncGenerator<McpStreamEvent> {
  const request = parseJsonRpcRequest(input.body);
  const progressToken = requestMeta(request.params)?.progressToken;
  if (
    request.method === "tools/call" &&
    (typeof progressToken === "string" || typeof progressToken === "number")
  ) {
    yield {
      event: "message",
      data: {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken, progress: 0, message: "Tool call started." },
      },
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

export function isAuthenticatedMcpPrincipal(principal: ToolInvocationPrincipal): boolean {
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

async function dispatchWithDeadline(
  operation: Promise<JsonRpcResponse>,
  timeoutMs: number,
  id: JsonRpcId | undefined,
): Promise<JsonRpcResponse> {
  const boundedTimeoutMs = Math.min(Math.max(Math.trunc(timeoutMs), 1), 120_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<JsonRpcResponse>((resolve) => {
        timeout = setTimeout(() => {
          resolve(jsonRpcError(id, -32008, "MCP request exceeded its execution deadline."));
        }, boundedTimeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
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

function statusToJsonRpcCode(statusCode: number): number {
  if (statusCode === 400) {
    return -32602;
  }
  if (statusCode === 403) {
    return -32003;
  }
  if (statusCode === 404) {
    return -32004;
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
  return globalSearchTypes.some((type) => type === value);
}
