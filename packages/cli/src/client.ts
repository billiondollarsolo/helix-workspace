import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { HelixCommand } from "./parser.js";

export interface HelixCliEnv {
  readonly HELIX_BASE_URL?: string;
  readonly HELIX_ACCESS_TOKEN?: string;
  readonly HELIX_TRACE_TOKEN?: string;
  readonly HELIX_CREDENTIALS_FILE?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly HOME?: string;
}

/**
 * Resolves the path of the stored Helix credentials file. Honors an explicit
 * `HELIX_CREDENTIALS_FILE` override, then `XDG_CONFIG_HOME`, then the home
 * directory. The file holds the access token persisted by `helix login` and is
 * removed by `helix logout`.
 */
export function credentialFilePath(env: HelixCliEnv): string {
  if (env.HELIX_CREDENTIALS_FILE !== undefined && env.HELIX_CREDENTIALS_FILE.length > 0) {
    return env.HELIX_CREDENTIALS_FILE;
  }

  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir(), ".config");

  return join(configHome, "helix", "credentials.json");
}

export interface HelixRequest {
  readonly url: string;
  readonly init: {
    readonly method: "GET" | "POST" | "PATCH";
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array;
  };
}

export function buildHelixRequest(
  command: HelixCommand,
  env: HelixCliEnv,
  input?: unknown,
): HelixRequest {
  switch (command.kind) {
    case "tool-list":
      if (command.source !== undefined && command.source !== "api") {
        throw new Error(`Command does not map to a REST tool list request: ${command.source}`);
      }
      return createRequest(env, "GET", "/api/tools");
    case "tool-call":
      if (command.transport !== undefined && command.transport !== "rest") {
        throw new Error(`Command does not map to a REST tool call request: ${command.transport}`);
      }
      return createRequest(
        env,
        "POST",
        `/api/tools/${encodeURIComponent(command.toolId)}`,
        input ?? {},
      );
    case "auth-token":
      return createFormRequest(env, "/oauth/token", {
        grant_type: "client_credentials",
        client_id: command.clientId,
        client_secret: command.clientSecret,
        ...(command.scope === undefined ? {} : { scope: command.scope }),
      });
    case "install-list":
      return createRequest(env, "POST", "/api/tools/plugin.list", {});
    case "install-plugin":
      return createRequest(env, "POST", "/api/tools/plugin.install", {
        ...(isRecord(input) ? input : {}),
        pluginId: command.pluginId,
        ...(command.version === undefined ? {} : { version: command.version }),
      });
    case "plugin-lifecycle":
      return createRequest(env, "POST", `/api/tools/plugin.${command.action}`, {
        ...(isRecord(input) ? input : {}),
        pluginId: command.pluginId,
      });
    case "admin-users-list":
      return createRequest(env, "GET", withQuery("/api/admin/users", command));
    case "admin-audit-list":
      return createRequest(env, "GET", withQuery("/api/admin/audit-log", command));
    case "admin-storage-test":
      return createRequest(env, "POST", "/api/admin/tenant-config/byo-storage/test", {});
    case "admin-storage-migration-list":
      return createRequest(
        env,
        "GET",
        withQuery("/api/admin/tenant-config/byo-storage/migrations", command),
      );
    case "admin-storage-migration-request":
      return createRequest(env, "POST", "/api/admin/tenant-config/byo-storage/migrations", {
        target: command.target,
        dryRun: command.dryRun,
        ...(command.sourceStorage === undefined ? {} : { sourceStorage: command.sourceStorage }),
        ...(command.targetStorage === undefined ? {} : { targetStorage: command.targetStorage }),
      });
    case "admin-storage-migration-get":
      return createRequest(
        env,
        "GET",
        `/api/admin/tenant-config/byo-storage/migrations/${encodeURIComponent(command.migrationId)}`,
      );
    case "admin-storage-migration-cutover":
      return createRequest(
        env,
        "POST",
        `/api/admin/tenant-config/byo-storage/migrations/${encodeURIComponent(command.migrationId)}/cutover`,
        { confirm: "CUTOVER" },
      );
    case "tenant-export-queue":
      return createRequest(
        env,
        "POST",
        `/api/admin/tenants/${encodeURIComponent(command.slug)}/export/jobs`,
        {
          includeObjectBytes: command.includeObjectBytes,
          ...(command.presignedUrlExpiresSeconds === undefined
            ? {}
            : { presignedUrlExpiresSeconds: command.presignedUrlExpiresSeconds }),
        },
      );
    case "tenant-export-list":
      return createRequest(
        env,
        "GET",
        withQuery(`/api/admin/tenants/${encodeURIComponent(command.slug)}/export/jobs`, {
          status: command.status,
          limit: command.limit,
          cursor: command.cursor,
        }),
      );
    case "tenant-export-status":
      return createRequest(
        env,
        "GET",
        `/api/admin/tenants/${encodeURIComponent(command.slug)}/export/jobs/${encodeURIComponent(command.jobId)}`,
      );
    case "tenant-import-dry-run":
      if (!(input instanceof Uint8Array)) {
        throw new Error("Tenant import dry-run request requires archive bytes.");
      }
      return createBinaryRequest(
        env,
        withQuery(
          `/api/admin/tenants/${encodeURIComponent(command.slug)}/import/dry-run`,
          command.conflictPolicy === undefined ? {} : { ...command.conflictPolicy },
        ),
        input,
        "application/x-tar",
      );
    case "tenant-import-list":
      return createRequest(
        env,
        "GET",
        withQuery(`/api/admin/tenants/${encodeURIComponent(command.slug)}/import/jobs`, {
          status: command.status,
          limit: command.limit,
          cursor: command.cursor,
        }),
      );
    case "tenant-import-status":
      return createRequest(
        env,
        "GET",
        `/api/admin/tenants/${encodeURIComponent(command.slug)}/import/jobs/${encodeURIComponent(command.jobId)}`,
      );
    case "backup-create":
      return createRequest(env, "POST", "/api/admin/backups", {});
    case "restore-from":
      return createRequest(env, "POST", "/api/admin/restores", {
        backupId: command.backupId,
        ...(command.encrypted === true ? { encrypted: true } : {}),
      });
    case "reindex-all":
      return createRequest(env, "POST", "/api/admin/search/reindex", { all: true });
    case "action-status":
      return createRequest(env, "GET", `/actions/${encodeURIComponent(command.actionId)}`);
    case "action-approve":
      return createRequest(
        env,
        "POST",
        `/api/tools/pending/${encodeURIComponent(command.actionId)}/approve`,
        {},
      );
    case "action-cancel":
      return createRequest(
        env,
        "POST",
        `/api/tools/pending/${encodeURIComponent(command.actionId)}/cancel`,
        {},
      );
    case "tier-set":
      return createRequest(env, "PATCH", "/api/admin/platform-config", {
        security: { tier: command.tier },
      });
    case "openapi-get":
      return createRequest(env, "GET", "/openapi.json");
    case "asyncapi-get":
      return createRequest(env, "GET", "/asyncapi.json");
    case "help":
    case "completion":
    case "logout":
    case "tenant-export-download":
    case "tool-describe":
    case "mcp-resource-list":
    case "mcp-resource-read":
    case "mcp-serve":
      throw new Error(`Command does not map to an HTTP request: ${command.kind}`);
  }
}

export function buildMcpRequest(env: HelixCliEnv, body: string): HelixRequest {
  return createRawJsonRequest(env, "/mcp", body);
}

export function buildMcpToolListRequest(env: HelixCliEnv): HelixRequest {
  return buildMcpRequest(
    env,
    JSON.stringify({ jsonrpc: "2.0", id: "helix-tool-list", method: "tools/list" }),
  );
}

export function buildMcpToolCallRequest(
  env: HelixCliEnv,
  toolId: string,
  input: unknown,
): HelixRequest {
  return buildMcpRequest(
    env,
    JSON.stringify({
      jsonrpc: "2.0",
      id: "helix-tool-call",
      method: "tools/call",
      params: {
        name: toolId,
        arguments: input ?? {},
      },
    }),
  );
}

export function buildMcpResourceListRequest(env: HelixCliEnv): HelixRequest {
  return buildMcpRequest(
    env,
    JSON.stringify({ jsonrpc: "2.0", id: "helix-resource-list", method: "resources/list" }),
  );
}

export function buildMcpResourceReadRequest(env: HelixCliEnv, uri: string): HelixRequest {
  return buildMcpRequest(
    env,
    JSON.stringify({
      jsonrpc: "2.0",
      id: "helix-resource-read",
      method: "resources/read",
      params: { uri },
    }),
  );
}

function createFormRequest(
  env: HelixCliEnv,
  path: string,
  input: Record<string, string>,
): HelixRequest {
  const headers: Record<string, string> = {
    ...commonHeaders(env),
    "content-type": "application/x-www-form-urlencoded",
  };
  return {
    url: new URL(path, baseUrl(env).href).href,
    init: {
      method: "POST",
      headers,
      body: new URLSearchParams(input).toString(),
    },
  };
}

function createRequest(env: HelixCliEnv, method: "GET", path: string): HelixRequest;
function createRequest(
  env: HelixCliEnv,
  method: "POST" | "PATCH",
  path: string,
  input: unknown,
): HelixRequest;
function createRequest(
  env: HelixCliEnv,
  method: "GET" | "POST" | "PATCH",
  path: string,
  input?: unknown,
): HelixRequest {
  const headers = commonHeaders(env);

  const init =
    method !== "GET"
      ? {
          method,
          headers: {
            ...headers,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        }
      : {
          method,
          headers,
        };

  return {
    url: new URL(path, baseUrl(env).href).href,
    init,
  };
}

function createRawJsonRequest(env: HelixCliEnv, path: string, body: string): HelixRequest {
  return {
    url: new URL(path, baseUrl(env).href).href,
    init: {
      method: "POST",
      headers: {
        ...commonHeaders(env),
        "content-type": "application/json",
      },
      body,
    },
  };
}

function createBinaryRequest(
  env: HelixCliEnv,
  path: string,
  body: Uint8Array,
  contentType: string,
): HelixRequest {
  return {
    url: new URL(path, baseUrl(env).href).href,
    init: {
      method: "POST",
      headers: {
        ...commonHeaders(env),
        "content-type": contentType,
      },
      body,
    },
  };
}

let traceRequestSequence = 0;
const traceRunNonce = randomBytes(8).toString("hex");

function commonHeaders(env: HelixCliEnv): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
  };

  if (env.HELIX_ACCESS_TOKEN !== undefined && env.HELIX_ACCESS_TOKEN.length > 0) {
    headers.authorization = `Bearer ${env.HELIX_ACCESS_TOKEN}`;
  }

  const traceparent = traceparentHeader(env);
  if (traceparent !== undefined) {
    headers.traceparent = traceparent;
  }

  return headers;
}

function traceparentHeader(env: HelixCliEnv): string | undefined {
  const token = env.HELIX_TRACE_TOKEN?.trim();
  if (token === undefined || token.length === 0) {
    return undefined;
  }

  const traceId = traceIdFromToken(token);
  const sequence = String(traceRequestSequence++);
  const parentId = nonZeroHex(hashHex(`span:${token}:${traceRunNonce}:${sequence}`, 16), 16);
  return `00-${traceId}-${parentId}-01`;
}

function traceIdFromToken(token: string): string {
  const lowerToken = token.toLowerCase();
  const traceparentMatch = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(lowerToken);
  if (traceparentMatch?.[1] !== undefined && !isZeroHex(traceparentMatch[1])) {
    return traceparentMatch[1];
  }
  if (/^[0-9a-f]{32}$/.test(lowerToken) && !isZeroHex(lowerToken)) {
    return lowerToken;
  }
  return nonZeroHex(hashHex(`trace:${token}`, 32), 32);
}

function hashHex(input: string, length: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length);
}

function nonZeroHex(value: string, length: number): string {
  return isZeroHex(value) ? "1".padStart(length, "0") : value;
}

function isZeroHex(value: string): boolean {
  return /^0+$/.test(value);
}

function baseUrl(env: HelixCliEnv): URL {
  if (env.HELIX_BASE_URL === undefined || env.HELIX_BASE_URL.length === 0) {
    throw new Error("HELIX_BASE_URL is required");
  }

  try {
    return new URL(
      env.HELIX_BASE_URL.endsWith("/") ? env.HELIX_BASE_URL : `${env.HELIX_BASE_URL}/`,
    );
  } catch {
    throw new Error("HELIX_BASE_URL must be a valid URL");
  }
}

function withQuery(path: string, params: Record<string, unknown>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === "kind" || value === undefined) {
      continue;
    }
    searchParams.set(key, queryStringValue(value));
  }
  const query = searchParams.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

function queryStringValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  throw new Error("Query parameters must be primitive values.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
