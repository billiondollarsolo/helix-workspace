import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import {
  handleMcpJsonRpcRequest,
  handleMcpStreamingRequest,
  isAuthenticatedMcpPrincipal,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpHandlerInput,
  type McpStreamEvent,
} from "./mcp.js";
import {
  isJsonRpcNotificationOrResponse,
  jsonRpcError,
  parseJsonRpcRequest,
} from "./mcp-jsonrpc.js";
import { versionedApiPath } from "./version.js";

/**
 * Streamable HTTP transport rules for `/mcp` (MC5 / MC6), kept free of
 * Fastify so they can be tested directly.
 */
export type McpHttpOutcome =
  | {
      readonly kind: "json";
      readonly statusCode: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: unknown;
    }
  | {
      readonly kind: "stream";
      readonly statusCode: 200;
      readonly headers: Readonly<Record<string, string>>;
      readonly events: AsyncGenerator<McpStreamEvent>;
    };

export const MCP_SESSION_HEADER = "mcp-session-id";
export const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";
const MCP_SESSION_ID_PATTERN = /^[\x21-\x7e]{1,128}$/u;

/** URL of the RFC 9728 protected-resource metadata document. */
export function protectedResourceMetadataUrl(publicBaseUrl: string): string {
  return `${trimBase(publicBaseUrl)}/.well-known/oauth-protected-resource`;
}

/** The MCP endpoint as an OAuth protected resource identifier. */
export function mcpResourceUrl(publicBaseUrl: string): string {
  return `${trimBase(publicBaseUrl)}${versionedApiPath("/mcp")}`;
}

/** RFC 6750 / RFC 9728 challenge sent with every 401 from `/mcp`. */
export function mcpWwwAuthenticate(
  publicBaseUrl: string,
  error?: { readonly code: "invalid_token"; readonly description: string },
): string {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(publicBaseUrl)}"`];
  if (error !== undefined) {
    parts.push(`error="${error.code}"`, `error_description="${quoteSafe(error.description)}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}

/** RFC 9728 metadata for the MCP endpoint. */
export function buildProtectedResourceMetadata(input: {
  readonly publicBaseUrl: string;
  readonly authorizationServer: string;
  readonly tools: readonly ToolDefinition[];
}): JsonObject {
  return {
    resource: mcpResourceUrl(input.publicBaseUrl),
    authorization_servers: [trimBase(input.authorizationServer)],
    bearer_methods_supported: ["header"],
    scopes_supported: toolScopes(input.tools),
    resource_name: "Helix Workspace MCP",
  };
}

/** Every scope a registered tool can require, sorted for stable output. */
export function toolScopes(tools: readonly ToolDefinition[]): string[] {
  const scopes = new Set<string>();
  for (const tool of tools) {
    scopes.add(tool.permission);
    for (const scope of tool.scopeComposition?.requiredScopes ?? []) scopes.add(scope);
    for (const conditional of tool.scopeComposition?.conditionalScopes ?? []) {
      scopes.add(conditional.scope);
    }
  }
  return [...scopes].sort();
}

/** The 401 returned before any SSE stream opens when `/mcp` lacks valid credentials. */
export function mcpUnauthorizedOutcome(
  publicBaseUrl: string,
  invalidToken?: string,
): McpHttpOutcome {
  return {
    kind: "json",
    statusCode: 401,
    headers: {
      "www-authenticate": mcpWwwAuthenticate(
        publicBaseUrl,
        invalidToken === undefined
          ? undefined
          : { code: "invalid_token", description: invalidToken },
      ),
    },
    body: {
      error: {
        code: "unauthenticated",
        message:
          invalidToken ??
          "MCP requires an OAuth bearer token. Discover the authorization server from the resource_metadata URL in WWW-Authenticate.",
      },
    },
  };
}

/** `GET`/`DELETE /mcp`: no server-initiated stream and no session teardown. */
export function mcpMethodNotAllowedOutcome(): McpHttpOutcome {
  return {
    kind: "json",
    statusCode: 405,
    headers: { allow: "POST" },
    body: {
      error: {
        code: "method_not_allowed",
        message: "This MCP endpoint accepts JSON-RPC over POST only.",
      },
    },
  };
}

/**
 * Handles `POST /mcp` once the principal is resolved. Order matters:
 * authentication and header validation happen before any SSE stream opens.
 */
export function handleMcpHttpPost(
  input: McpHandlerInput & {
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly acceptsEventStream: boolean;
    readonly publicBaseUrl: string;
  },
): Promise<McpHttpOutcome> | McpHttpOutcome {
  if (!isAuthenticatedMcpPrincipal(input.principal)) {
    return mcpUnauthorizedOutcome(input.publicBaseUrl);
  }
  const protocolVersion = headerValue(input.headers[MCP_PROTOCOL_VERSION_HEADER]);
  if (protocolVersion !== undefined && !MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)) {
    return {
      kind: "json",
      statusCode: 400,
      headers: {},
      body: jsonRpcError(
        parseJsonRpcRequest(input.body).id,
        -32600,
        `Unsupported MCP-Protocol-Version "${protocolVersion}". Supported: ${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
      ),
    };
  }
  if (isJsonRpcNotificationOrResponse(input.body)) {
    // Notifications (e.g. notifications/initialized) and client responses
    // need no reply: 202 Accepted with an empty body.
    return { kind: "json", statusCode: 202, headers: {} };
  }

  const request = parseJsonRpcRequest(input.body);
  const clientSession = headerValue(input.headers[MCP_SESSION_HEADER]);
  const sessionId =
    clientSession !== undefined && MCP_SESSION_ID_PATTERN.test(clientSession)
      ? clientSession
      : undefined;
  // Issue a session id on initialize; the client echoes it on later requests
  // and it scopes server-derived idempotency keys.
  const issuedSession = request.method === "initialize" ? (sessionId ?? randomUUID()) : undefined;
  const headers: Record<string, string> =
    issuedSession === undefined ? {} : { [MCP_SESSION_HEADER]: issuedSession };
  const handlerInput: McpHandlerInput = {
    ...input,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
  if (input.acceptsEventStream) {
    return {
      kind: "stream",
      statusCode: 200,
      headers,
      events: handleMcpStreamingRequest(handlerInput),
    };
  }
  return handleMcpJsonRpcRequest(handlerInput).then((body) => ({
    kind: "json" as const,
    statusCode: 200,
    headers,
    body,
  }));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/u, "");
}

function quoteSafe(value: string): string {
  return value.replace(/["\\\r\n]/gu, " ");
}
