import { isJsonObject, type JsonObject } from "@helix/sdk-types";

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value ?? {})) as JsonObject;
}
import { BadRequestError } from "../../api/api-error.js";
import { createOutboundHttpClient } from "../outbound-http.js";
import type { AssistantVisibleTool } from "../assistant/types.js";

export interface ToolServerConfig {
  readonly id: string;
  readonly type: "openapi" | "mcp";
  readonly baseUrl: string;
  readonly specUrl?: string;
  readonly apiKey?: string;
  /** Test/inline catalog; production servers list tools over HTTP. */
  readonly tools?: readonly ToolServerRemoteTool[];
}

export interface ToolServerRemoteTool {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly method?: string;
  readonly path?: string;
  readonly sideEffects?: "read" | "write" | "external_communication";
}

export function prefixedToolId(serverId: string, remoteId: string): string {
  return `ext.${serverId}.${remoteId.replace(/[^a-zA-Z0-9._-]/gu, "_")}`.slice(0, 64);
}

export function parsePrefixedToolId(
  toolId: string,
): { readonly serverId: string; readonly remoteId: string } | undefined {
  const match = /^ext\.([^.]+)\.(.+)$/u.exec(toolId);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { serverId: match[1], remoteId: match[2] };
}

export function visibleToolsFromServers(
  servers: readonly ToolServerConfig[],
): readonly AssistantVisibleTool[] {
  return servers.flatMap((server) =>
    (server.tools ?? []).map((tool) => ({
      id: prefixedToolId(server.id, tool.id),
      description: `${server.id}: ${tool.description}`,
      permission: tool.sideEffects === "read" ? "assistant.read" : "assistant.write",
      sideEffects: tool.sideEffects ?? "external_communication",
      confirmationRequired: tool.sideEffects !== "read",
      inputSchema: tool.inputSchema,
    })),
  );
}

export function parseOpenApiTools(spec: JsonObject): readonly ToolServerRemoteTool[] {
  const paths = spec.paths;
  if (!isJsonObject(paths)) return [];
  const tools: ToolServerRemoteTool[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isJsonObject(item)) continue;
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      const operation = item[method];
      if (!isJsonObject(operation)) continue;
      const operationId =
        typeof operation.operationId === "string"
          ? operation.operationId
          : `${method}_${path.replace(/[^a-zA-Z0-9]+/gu, "_")}`;
      tools.push({
        id: operationId.slice(0, 48),
        description:
          typeof operation.description === "string"
            ? operation.description
            : typeof operation.summary === "string"
              ? operation.summary
              : operationId,
        inputSchema: { type: "object", additionalProperties: true },
        method,
        path,
        sideEffects: method === "get" ? "read" : "external_communication",
      });
    }
  }
  return tools.slice(0, 16);
}

const catalogCache = new Map<string, readonly ToolServerRemoteTool[]>();

export async function catalogsForServers(
  servers: readonly ToolServerConfig[],
): Promise<readonly ToolServerConfig[]> {
  return Promise.all(
    servers.map(async (server) => {
      if (server.tools !== undefined) return server;
      const cached = catalogCache.get(`${server.type}:${server.id}:${server.baseUrl}`);
      if (cached !== undefined) return { ...server, tools: cached };
      try {
        const tools =
          server.type === "mcp" ? await listMcpTools(server) : await listOpenApiTools(server);
        catalogCache.set(`${server.type}:${server.id}:${server.baseUrl}`, tools);
        return { ...server, tools };
      } catch {
        return { ...server, tools: [] };
      }
    }),
  );
}

async function listOpenApiTools(
  server: ToolServerConfig,
): Promise<readonly ToolServerRemoteTool[]> {
  const specUrl =
    server.specUrl ?? new URL("openapi.json", trailingSlash(server.baseUrl)).toString();
  const spec = await fetchJson(specUrl, server.apiKey);
  return isJsonObject(spec) ? parseOpenApiTools(asJsonObject(spec)) : [];
}

async function listMcpTools(server: ToolServerConfig): Promise<readonly ToolServerRemoteTool[]> {
  const payload = await fetchJsonRpc(server, "tools/list", {});
  const tools = isJsonObject(payload) && Array.isArray(payload.tools) ? payload.tools : [];
  return tools
    .flatMap((entry) => {
      if (!isJsonObject(entry) || typeof entry.name !== "string") return [];
      return [
        {
          id: entry.name.slice(0, 48),
          description: typeof entry.description === "string" ? entry.description : entry.name,
          inputSchema: isJsonObject(entry.inputSchema)
            ? asJsonObject(entry.inputSchema)
            : { type: "object", additionalProperties: true },
          sideEffects: "external_communication" as const,
        },
      ];
    })
    .slice(0, 16);
}

function trailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

async function fetchJson(url: string, apiKey?: string): Promise<unknown> {
  const send = createOutboundHttpClient({
    production: true,
    allowHttp: false,
    timeoutMs: 10_000,
    maxResponseBytes: 262_144,
    maxRedirects: 2,
  });
  const response = await send(url, {
    headers: {
      accept: "application/json",
      ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
    },
  });
  return JSON.parse(await response.text());
}

async function fetchJsonRpc(
  server: ToolServerConfig,
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  const send = createOutboundHttpClient({
    production: true,
    allowHttp: false,
    timeoutMs: 15_000,
    maxResponseBytes: 65_536,
    maxRedirects: 2,
  });
  const response = await send(server.baseUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(server.apiKey === undefined ? {} : { authorization: `Bearer ${server.apiKey}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload: unknown = JSON.parse(await response.text());
  if (!isJsonObject(payload))
    throw new BadRequestError("External MCP server returned invalid JSON.");
  if (isJsonObject(payload.error))
    throw new BadRequestError(
      typeof payload.error.message === "string" ? payload.error.message : "MCP request failed.",
    );
  return isJsonObject(payload.result) ? asJsonObject(payload.result) : { ok: true };
}

export async function invokeToolServer(
  servers: readonly ToolServerConfig[],
  toolId: string,
  input: JsonObject,
): Promise<JsonObject> {
  const parsed = parsePrefixedToolId(toolId);
  if (parsed === undefined) throw new BadRequestError("Unknown external tool.");
  const resolved = await catalogsForServers(servers);
  const server = resolved.find((entry) => entry.id === parsed.serverId);
  if (server === undefined) throw new BadRequestError("External tool server is not configured.");
  const remote = (server.tools ?? []).find((tool) => tool.id === parsed.remoteId);
  if (remote === undefined) throw new BadRequestError("External tool is not allowlisted.");
  if (server.type === "mcp") {
    const result = await fetchJsonRpc(server, "tools/call", { name: remote.id, arguments: input });
    return result;
  }
  return invokeOpenApiTool(server, remote, input);
}

async function invokeOpenApiTool(
  server: ToolServerConfig,
  tool: ToolServerRemoteTool,
  input: JsonObject,
): Promise<JsonObject> {
  const path = (tool.path ?? "/").replace(/\{([^}]+)\}/gu, (_, name: string) => {
    const value = input[name];
    return encodeURIComponent(
      typeof value === "string" || typeof value === "number" ? String(value) : "",
    );
  });
  const url = new URL(path, server.baseUrl.endsWith("/") ? server.baseUrl : `${server.baseUrl}/`);
  const method = (tool.method ?? "post").toUpperCase();
  const send = createOutboundHttpClient({
    production: true,
    allowHttp: false,
    timeoutMs: 15_000,
    maxResponseBytes: 65_536,
    maxRedirects: 2,
  });
  const response = await send(url.toString(), {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(server.apiKey === undefined ? {} : { authorization: `Bearer ${server.apiKey}` }),
    },
    ...(method === "GET" ? {} : { body: JSON.stringify(input) }),
  });
  const text = await response.text();
  if (!response.ok)
    throw new BadRequestError(`External tool returned HTTP ${String(response.status)}.`);
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? asJsonObject(parsed) : { result: text.slice(0, 4_000) };
  } catch {
    return { result: text.slice(0, 4_000) };
  }
}
