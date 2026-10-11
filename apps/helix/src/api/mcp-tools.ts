import type {
  Actor,
  JsonObject,
  PendingToolInvocation,
  RequestContext,
  ToolDefinition,
} from "@helix/sdk-types";
import { createHash } from "node:crypto";
import {
  toolInvocationOptions,
  type ToolInvocationPrincipal,
} from "../platform/auth/tool-invocation-principal.js";
import type { RuntimeToolRegistry, ToolInvokeResult } from "../platform/tool-registry.js";
import { errorCodeForStatus } from "./error-envelope.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  InMemoryIdempotencyStore,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  type IdempotencyStore,
} from "./idempotency.js";
import {
  isRecord,
  jsonRpcError,
  jsonRpcResult,
  requestMeta,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./mcp-jsonrpc.js";
import { versionedApiPath } from "./version.js";

const MCP_MAX_IDENTIFIER_LENGTH = 256;
/**
 * Server-derived keys only need to cover client retries of one JSON-RPC
 * request, so they expire much sooner than client-supplied keys.
 */
const DERIVED_IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

export interface McpToolCallContext {
  readonly tools: RuntimeToolRegistry;
  readonly principal: ToolInvocationPrincipal;
  readonly request?: RequestContext;
  readonly idempotencyStore?: IdempotencyStore;
  /** `Mcp-Session-Id` the client echoed, when it did. */
  readonly sessionId?: string;
  /** Public origin (e.g. `https://helix.example.com`) used for approval links. */
  readonly publicBaseUrl?: string;
}

type ToolResult = Awaited<ReturnType<RuntimeToolRegistry["invoke"]>>;
type ToolFailure = Extract<ToolResult, { readonly ok: false }>;

const defaultIdempotencyStores = new WeakMap<RuntimeToolRegistry, IdempotencyStore>();
const inFlightMutations = new Map<
  string,
  { readonly requestHash: string; readonly result: Promise<ToolResult> }
>();

/** Projects a registry tool into the MCP `Tool` shape (MC8). */
export function projectMcpTool(tool: ToolDefinition, actor: Actor): JsonObject {
  return {
    name: tool.id,
    title: toolTitle(tool.id),
    description: toolDescription(tool, actor),
    inputSchema: mcpInputSchema(tool.inputSchema.toJsonSchema()),
    annotations: mcpToolAnnotations(tool),
    _meta: {
      "helix/permission": tool.permission,
      "helix/sideEffects": tool.sideEffects,
      "helix/confirmationRequired": tool.confirmationRequired ?? false,
      ...(tool.estimatedCostUsdMicros === undefined
        ? {}
        : { "helix/estimatedCostUsdMicros": tool.estimatedCostUsdMicros }),
    },
  };
}

/** Standard MCP tool annotations derived from the tool's side-effect class. */
function mcpToolAnnotations(tool: ToolDefinition): JsonObject {
  const readOnly = tool.sideEffects === "read";
  return {
    title: toolTitle(tool.id),
    readOnlyHint: readOnly,
    destructiveHint: tool.sideEffects === "destructive",
    idempotentHint: readOnly,
    openWorldHint: tool.sideEffects === "external_communication",
  };
}

function toolTitle(id: string): string {
  const words = id.split(/[._-]+/u).filter((word) => word.length > 0);
  const sentence = words.join(" ");
  return sentence.length === 0 ? id : `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

function toolDescription(tool: ToolDefinition, actor: Actor): string {
  if (tool.confirmationRequired === true) {
    return `${tool.description} Requires human approval in Helix before it runs; the call returns a pending action to poll with actions.get.`;
  }
  if (tool.sideEffects !== "read" && actor.type === "agent") {
    return `${tool.description} Agent calls wait for human approval in Helix unless an automation policy allows them; poll pending actions with actions.get.`;
  }
  return tool.description;
}

/** MCP requires `inputSchema.type === "object"`; wrap anything else. */
function mcpInputSchema(schema: JsonObject): JsonObject {
  if (schema.type === "object") return schema;
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    return { type: "object", ...schema };
  }
  return { type: "object", additionalProperties: true };
}

/** Handles `tools/call`, returning tool failures as `isError` results (MC7). */
export async function callMcpTool(
  request: JsonRpcRequest,
  context: McpToolCallContext,
): Promise<JsonRpcResponse> {
  const params = parseToolCallParams(request.params);
  if (params === undefined) {
    return jsonRpcError(request.id, -32602, "tools/call requires params.name.");
  }
  if (params.name.length > MCP_MAX_IDENTIFIER_LENGTH) {
    return jsonRpcError(request.id, -32602, "Tool name exceeds the allowed size.");
  }
  if (params.arguments !== undefined && !isRecord(params.arguments)) {
    return jsonRpcError(request.id, -32602, "tools/call params.arguments must be an object.");
  }
  const tool = context.tools.get(params.name);
  if (tool === undefined) {
    return jsonRpcError(request.id, -32602, `Unknown tool: ${params.name}`);
  }
  if (params.idempotencyKey !== undefined && !isValidIdempotencyKey(params.idempotencyKey)) {
    return jsonRpcError(
      request.id,
      -32602,
      "params._meta.idempotencyKey must be 8-200 printable ASCII characters without spaces.",
    );
  }
  const args = params.arguments ?? {};
  const isAgentMutation = context.principal.actor.type === "agent" && tool.sideEffects !== "read";
  // MC2: stock MCP clients never send an idempotency key. Derive a stable one
  // from the request so a client retry of the same JSON-RPC request dedupes.
  const idempotency =
    params.idempotencyKey !== undefined
      ? { key: params.idempotencyKey, ttlMs: DEFAULT_IDEMPOTENCY_TTL_MS }
      : isAgentMutation
        ? {
            key: derivedIdempotencyKey(context, request, params.name, args),
            ttlMs: DERIVED_IDEMPOTENCY_TTL_MS,
          }
        : undefined;

  const invoke = () =>
    context.tools.invoke(params.name, args, {
      ...toolInvocationOptions(context.principal, context.request),
      ...(idempotency === undefined
        ? {}
        : {
            executionIdempotencyKey: idempotency.key,
            idempotencyFingerprint: fingerprintRequestPayload(idempotency.key),
          }),
      policyContext: {
        effectiveClassification: "standard",
        sourceIds: [],
        containsUntrustedContext: false,
        requestChannel: "mcp",
        tenantId: context.principal.actor.orgId,
      },
      enforceConfirmation: true,
    });
  const result =
    isAgentMutation && idempotency !== undefined
      ? await invokeIdempotently(context, params.name, args, idempotency, invoke)
      : await invoke();

  if (!result.ok) {
    return jsonRpcResult(request.id, toolErrorResult(result));
  }
  if (result.status === "pending_confirmation") {
    return jsonRpcResult(request.id, pendingActionResult(result.pending, context.publicBaseUrl));
  }
  const structured = isRecord(result.output) ? result.output : { result: result.output };
  return jsonRpcResult(request.id, {
    content: [{ type: "text", text: JSON.stringify(result.output) }],
    structuredContent: structured,
  });
}

function parseToolCallParams(params: unknown):
  | {
      readonly name: string;
      readonly arguments?: unknown;
      readonly idempotencyKey?: string;
    }
  | undefined {
  if (!isRecord(params) || typeof params.name !== "string") {
    return undefined;
  }
  const meta = requestMeta(params);
  const idempotencyKey =
    typeof meta?.idempotencyKey === "string"
      ? meta.idempotencyKey
      : typeof params.idempotencyKey === "string"
        ? params.idempotencyKey
        : undefined;
  return {
    name: params.name,
    ...(params.arguments === undefined || params.arguments === null
      ? {}
      : { arguments: params.arguments }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function isValidIdempotencyKey(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && /^[\x21-\x7e]+$/u.test(value);
}

/**
 * Stable key for one JSON-RPC request: principal, credential, MCP session,
 * request id, tool, and a canonical hash of the arguments.
 */
function derivedIdempotencyKey(
  context: Pick<McpToolCallContext, "principal" | "sessionId">,
  request: JsonRpcRequest,
  toolName: string,
  args: unknown,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        context.principal.actor.orgId,
        context.principal.actor.id,
        context.principal.credentialId ?? null,
        context.sessionId ?? null,
        typeof request.id,
        request.id ?? null,
        toolName,
        createHash("sha256").update(canonicalJson(args)).digest("hex"),
      ]),
    )
    .digest("hex");
  return `mcp-derived-${digest}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

async function invokeIdempotently(
  context: McpToolCallContext,
  toolId: string,
  args: unknown,
  idempotency: { readonly key: string; readonly ttlMs: number },
  invoke: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const store = context.idempotencyStore ?? defaultIdempotencyStore(context.tools);
  const storageKey = idempotencyStorageKey({
    orgId: context.principal.actor.orgId,
    actorId: context.principal.actor.id,
    toolId,
    idempotencyKey: idempotency.key,
  });
  const requestHash = createHash("sha256")
    .update(canonicalJson({ toolId, arguments: args }))
    .digest("hex");
  const claim = await store.claim(storageKey, requestHash, idempotency.ttlMs);
  if (claim.kind === "conflict") {
    return failure(
      409,
      "params._meta.idempotencyKey was already used with different arguments. Use a new key for a different request.",
    );
  }
  if (claim.kind === "replay") {
    return claim.record.result;
  }
  if (claim.kind === "in_progress") {
    const local = inFlightMutations.get(storageKey);
    if (local !== undefined && local.requestHash === requestHash) {
      return local.result;
    }
    return failure(
      409,
      "A call with this idempotency key is still running. Wait a few seconds and retry the same request.",
      5,
    );
  }

  const result = invoke();
  inFlightMutations.set(storageKey, { requestHash, result });
  try {
    const completed = await result;
    await store.complete(storageKey, claim.claimToken, {
      result: completed,
      statusCode: completed.ok
        ? completed.status === "pending_confirmation"
          ? 202
          : 200
        : completed.statusCode,
      requestHash,
      expiresAt: Date.now() + idempotency.ttlMs,
    });
    return completed;
  } catch (error) {
    await store.release(storageKey, claim.claimToken);
    throw error;
  } finally {
    inFlightMutations.delete(storageKey);
  }
}

function failure(statusCode: number, error: string, retryAfterSeconds?: number): ToolFailure {
  return {
    ok: false,
    statusCode,
    error,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
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

interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * MCP tool-execution failure: a successful JSON-RPC result with `isError`
 * so the model sees an actionable message instead of a protocol error.
 */
function toolErrorResult(result: ToolInvokeResult & { readonly ok: false }): JsonObject {
  const code = errorCodeForStatus(result.statusCode);
  const retryAfterSeconds = result.retryAfterSeconds ?? result.rateLimit?.retryAfterSeconds;
  const issues = result.statusCode === 400 ? validationIssues(result) : [];
  const firstField = issues[0]?.path.join(".");
  const message =
    issues.length > 0
      ? `Invalid arguments: ${issues
          .slice(0, 5)
          .map((issue) =>
            issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
          )
          .join("; ")}`
      : result.error;
  const hint = errorHint(result.statusCode, retryAfterSeconds);
  const structured: Record<string, JsonObject[keyof JsonObject]> = {
    code,
    message,
    ...(firstField === undefined || firstField.length === 0 ? {} : { field: firstField }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(hint === undefined ? {} : { hint }),
  };
  if (issues.length > 0) {
    structured.issues = issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    }));
  }
  return {
    isError: true,
    content: [{ type: "text", text: hint === undefined ? message : `${message} ${hint}` }],
    structuredContent: structured,
  };
}

function validationIssues(result: { readonly error: string }): readonly ValidationIssue[] {
  // Prefer the registry's structured `details.issues`; older results carried
  // `issues` directly or a JSON-serialized zod issue list in `error`.
  const fromDetails = (result as { readonly details?: { readonly issues?: unknown } }).details
    ?.issues;
  const fromResult = (result as { readonly issues?: unknown }).issues;
  const candidates: unknown = Array.isArray(fromDetails)
    ? fromDetails
    : Array.isArray(fromResult)
      ? fromResult
      : parseJson(result.error);
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate): ValidationIssue[] => {
    if (!isRecord(candidate) || typeof candidate.message !== "string") return [];
    const path = Array.isArray(candidate.path)
      ? candidate.path.filter(
          (part): part is string | number => typeof part === "string" || typeof part === "number",
        )
      : typeof candidate.path === "string" && candidate.path.length > 0
        ? candidate.path.split(".")
        : [];
    return [{ path, message: candidate.message }];
  });
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function errorHint(statusCode: number, retryAfterSeconds: number | undefined): string | undefined {
  switch (statusCode) {
    case 400:
    case 422:
      return "Fix the arguments to match the tool's inputSchema and call the tool again.";
    case 401:
      return "Re-authenticate the MCP connection and retry.";
    case 403:
      return "The credential lacks a required scope or a policy denied the call. Ask a Helix administrator to grant access; retrying will not help.";
    case 404:
      return "Check the id; use a list or search tool to find a valid one.";
    case 409:
      return "The resource changed or the request conflicts with its current state. Re-read it before retrying.";
    case 429:
      return retryAfterSeconds === undefined
        ? "Rate limited. Wait before retrying."
        : `Rate limited. Retry after ${String(retryAfterSeconds)} seconds.`;
    case 503:
      return "Helix is temporarily unavailable. Retry later.";
    default:
      return undefined;
  }
}

/**
 * Pending-confirmation result (MC3): tells the agent to ask a human to
 * approve, where, until when, and how to poll for the outcome.
 */
function pendingActionResult(
  pending: PendingToolInvocation,
  publicBaseUrl: string | undefined,
): JsonObject {
  const links = pendingActionLinks(pending.id, publicBaseUrl);
  const decorated = { ...pending, ...links };
  const text = [
    `Helix queued "${pending.toolId}" as pending action ${pending.id}; it has NOT run yet.`,
    `Ask the user to approve it in Helix${
      links.approvalUrl === undefined ? "" : ` (approval endpoint: POST ${links.approvalUrl})`
    } before ${pending.expiresAt}.`,
    `Then poll the actions.get tool with {"id":"${pending.id}"} until status is executed, failed, cancelled, or expired.`,
    "Do not repeat the original call; that would queue a duplicate action.",
  ].join(" ");
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      status: "pending_confirmation",
      pending: decorated as unknown as JsonObject,
      expiresAt: pending.expiresAt,
      ...links,
      pollTool: "actions.get",
    },
  };
}

function pendingActionLinks(
  pendingId: string,
  publicBaseUrl: string | undefined,
): { readonly approvalUrl?: string; readonly statusUrl?: string } {
  if (publicBaseUrl === undefined || publicBaseUrl.length === 0) return {};
  const base = publicBaseUrl.replace(/\/+$/u, "");
  const id = encodeURIComponent(pendingId);
  return {
    approvalUrl: `${base}${versionedApiPath(`/api/tools/pending/${id}/approve`)}`,
    statusUrl: `${base}${versionedApiPath(`/actions/${id}`)}`,
  };
}
