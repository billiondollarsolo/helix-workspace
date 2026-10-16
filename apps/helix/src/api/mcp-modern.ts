import { z } from "zod";
import {
  isRecord,
  jsonRpcError,
  parseJsonRpcRequest,
  requestMeta,
  type JsonRpcErrorResponse,
} from "./mcp-jsonrpc.js";
import { MCP_PROTOCOL_VERSION } from "./version.js";

export const MCP_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export const MCP_VERSION_META = "io.modelcontextprotocol/protocolVersion";
export const MCP_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

/** Validate mirrors before dispatch so routing and authorization see the same request. */
export function validateModernMcpRequest(
  body: unknown,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): JsonRpcErrorResponse | undefined {
  const request = parseJsonRpcRequest(body),
    meta = requestMeta(request.params);
  const fail = (message: string, code = -32020) => jsonRpcError(request.id, code, message);
  if (
    headers["mcp-protocol-version"] !== MCP_PROTOCOL_VERSION ||
    meta?.[MCP_VERSION_META] !== MCP_PROTOCOL_VERSION
  )
    return fail("MCP-Protocol-Version must match the request protocol metadata.");
  if (
    !isRecord(body) ||
    body.jsonrpc !== "2.0" ||
    request.id === null ||
    request.id === undefined ||
    typeof request.method !== "string"
  )
    return fail("A JSON-RPC request with a string or numeric id is required.", -32600);
  if (!isRecord(meta[MCP_CAPABILITIES_META]))
    return fail("Per-request clientCapabilities must be an object.", -32602);
  const info = meta["io.modelcontextprotocol/clientInfo"];
  if (
    info !== undefined &&
    (!isRecord(info) || typeof info.name !== "string" || typeof info.version !== "string")
  )
    return fail("clientInfo requires name and version.", -32602);
  if (headers["mcp-method"] !== request.method || !/^[\x21-\x7e]+$/u.test(request.method))
    return fail("Mcp-Method must match the request method.");
  const params = isRecord(request.params) ? request.params : {};
  const name =
    request.method === "resources/read"
      ? params.uri
      : ["tools/call", "prompts/get"].includes(request.method)
        ? params.name
        : undefined;
  if (
    ["resources/read", "tools/call", "prompts/get"].includes(request.method) &&
    (typeof name !== "string" || decodeMcpHeader(headers["mcp-name"]) !== name)
  )
    return fail("Mcp-Name must match the requested name or URI.");
  return undefined;
}

function decodeMcpHeader(value: string | string[] | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex -- HTTP field values permit horizontal tabs.
  if (typeof value !== "string" || !/^[\x09\x20-\x7e]*$/u.test(value) || value.trim() !== value)
    return undefined;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2),
    bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export const mcpSubscriptionParamsSchema = z.object({
  notifications: z.object({
    resourceSubscriptions: z.array(z.string().max(2048)).max(100).optional(),
    toolsListChanged: z.boolean().optional(),
    promptsListChanged: z.boolean().optional(),
    resourcesListChanged: z.boolean().optional(),
  }),
});
