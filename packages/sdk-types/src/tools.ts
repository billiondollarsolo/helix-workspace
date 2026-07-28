import type { Actor, RequestContext, ResourceRef } from "./core.js";
import type { JsonObject, JsonValue } from "./json.js";

export interface SchemaAdapter<T> {
  readonly description?: string;
  parse(value: unknown): T;
  toJsonSchema(): JsonObject;
}

export type ToolSideEffect = "read" | "write" | "destructive" | "external_communication";

export interface RateLimitWindow {
  readonly perMinute?: number;
  readonly perHour?: number;
  readonly perDay?: number;
}

export interface RateLimitSpec {
  readonly perActor?: RateLimitWindow;
  readonly perOrg?: RateLimitWindow;
}

export interface ToolContext {
  readonly actor: Actor;
  readonly request?: RequestContext;
  readonly traceId?: string;
  /**
   * Stable execution key for a side-effecting invocation.
   *
   * Approved pending actions receive the same opaque key for their entire
   * lifetime. Domain handlers should persist it with an external operation or
   * pass it to providers that support idempotency, so a lost response can be
   * reconciled without issuing the side effect twice. The key is deliberately
   * available only to the handler and must not be written to audit metadata.
   */
  readonly idempotencyKey?: string;
  can(action: string, resource?: ResourceRef): Promise<boolean>;
  requirePermission(action: string, resource?: ResourceRef): Promise<void>;
  audit(verb: string, metadata?: JsonObject): Promise<void>;
}

/**
 * A scope requirement that only applies when the call's parsed input matches a
 * predicate. Used to model composite OAuth scopes such as `mail.external`,
 * which is only required when a `mail.send` call addresses an external
 * recipient. The base `permission` of a tool is always required; conditional
 * scopes are additive on top of it.
 */
export interface ConditionalScopeRequirement<Input = unknown> {
  /** Scope token the actor must additionally hold when {@link when} returns true. */
  readonly scope: string;
  /** Human-readable explanation, surfaced in denial messages and docs. */
  readonly reason: string;
  /** Predicate evaluated against the tool's parsed input. */
  when(input: Input): boolean;
}

/**
 * Declares the OAuth scope composition a tool requires. The base `permission`
 * is enforced separately; `requiredScopes` are unconditional additional scopes
 * and `conditionalScopes` are evaluated against the parsed call input.
 */
export interface ToolScopeComposition<Input = unknown> {
  /** Scopes always required in addition to the tool's base `permission`. */
  readonly requiredScopes?: readonly string[];
  /** Scopes required only when their predicate matches the call input. */
  readonly conditionalScopes?: readonly ConditionalScopeRequirement<Input>[];
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: SchemaAdapter<Input>;
  readonly outputSchema: SchemaAdapter<Output>;
  readonly permission: string;
  readonly sideEffects: ToolSideEffect;
  readonly confirmationRequired?: boolean;
  readonly rateLimit?: RateLimitSpec;
  readonly estimatedCostUsdMicros?: number;
  /**
   * Optional composite-scope requirements enforced by the tool registry in
   * addition to {@link ToolDefinition.permission}. See PRD §9.4.
   */
  readonly scopeComposition?: ToolScopeComposition<Input>;
  handler(input: Input, ctx: ToolContext): Promise<Output>;
}

export type PendingActionStatus =
  | "pending_confirmation"
  | "approved"
  | "executing"
  | "executed"
  | "failed"
  | "cancelled"
  | "expired";

export interface PendingActionPreview {
  readonly toolId: string;
  readonly action: string;
  readonly resourceIds: readonly string[];
  readonly recipients: readonly string[];
  readonly targets: readonly string[];
  readonly consequence: string;
}

export interface PendingToolInvocation {
  readonly id: string;
  readonly toolId: string;
  /** Backwards-compatible alias of requesterActorId. */
  readonly actorId: string;
  readonly requesterActorId: string;
  readonly requesterCredentialId?: string;
  readonly approverActorId?: string;
  readonly executionActorId?: string;
  readonly preview: PendingActionPreview;
  readonly status: PendingActionStatus;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedAt?: string;
  readonly executionStartedAt?: string;
  readonly executionCompletedAt?: string;
  readonly traceId?: string;
}
