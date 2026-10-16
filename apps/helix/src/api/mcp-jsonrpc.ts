/** JSON-RPC 2.0 envelope types and helpers shared by the MCP modules. */
import { isJsonObject as isRecord } from "@helix/sdk-types";

export { isRecord };

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  readonly jsonrpc?: string;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
};

export type JsonRpcResponse =
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
        readonly data?: unknown;
      };
    };

export type JsonRpcErrorResponse = Extract<JsonRpcResponse, { readonly error: unknown }>;

export function jsonRpcResult(id: JsonRpcId | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

export function jsonRpcError(
  id: JsonRpcId | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number" || value === null;
}

export function parseJsonRpcRequest(body: unknown): JsonRpcRequest {
  if (!isRecord(body)) {
    return { id: null };
  }
  const request: JsonRpcRequest = {
    id: isJsonRpcId(body.id) ? body.id : null,
    params: body.params,
  };
  return typeof body.method === "string" ? { ...request, method: body.method } : request;
}

/**
 * True for a JSON-RPC notification (a `method` with no `id` member) or a
 * client response to a server request (no `method`, but `result`/`error`).
 * Streamable HTTP answers both with `202 Accepted` and no body.
 */
export function isJsonRpcNotificationOrResponse(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (typeof body.method === "string") return !("id" in body);
  return !("method" in body) && ("result" in body || "error" in body);
}

/** Reads `params._meta` as a record when present. */
export function requestMeta(params: unknown): Record<string, unknown> | undefined {
  if (!isRecord(params)) return undefined;
  return isRecord(params._meta) ? params._meta : undefined;
}
