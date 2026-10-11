import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";

/**
 * Rebuild a Fastify request for the Better Auth handler with only trusted
 * forwarding headers. `path` and `method` call another Better Auth endpoint on
 * behalf of the same session (account security routes).
 */
export function createBetterAuthRequest(
  request: FastifyRequest,
  options: { readonly body?: unknown; readonly path?: string; readonly method?: string } = {},
): Request {
  const body = "body" in options ? options.body : request.body;
  const url = new URL(options.path ?? request.url, `${request.protocol}://${request.hostname}`);
  const headers = fromNodeHeaders(request.headers);
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-for", request.ip);
  headers.set("x-forwarded-host", request.hostname);
  headers.set("x-forwarded-proto", request.protocol);
  headers.delete("content-length");
  const method = options.method ?? request.method;
  if (options.path !== undefined) headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && body !== undefined) {
    init.body = requestBodyForFetch(body);
  }
  return new Request(url, init);
}

function requestBodyForFetch(body: unknown): NonNullable<RequestInit["body"]> {
  if (typeof body === "string" || body instanceof Blob || body instanceof FormData) {
    return body;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body as NonNullable<RequestInit["body"]>;
  }
  return JSON.stringify(body);
}
