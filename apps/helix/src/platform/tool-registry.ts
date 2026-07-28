import { nanoid } from "nanoid";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { FeatureFlagProvider } from "@helix/sdk";
import type {
  AuditRecord,
  Actor,
  JsonObject,
  JsonValue,
  PendingToolInvocation,
  RequestContext,
  ResourceRef,
  ToolContext,
  ToolDefinition,
} from "@helix/sdk-types";
import {
  ScopeToolAccessPolicy,
  checkScopeComposition,
  filterToolsForActor,
  toolResource,
  type ToolAccessPolicy,
} from "./permissions/tool-access.js";
import { confirmationRequiredForSideEffect, tierDefaults } from "./config/tier.js";
import type { ConfirmationGate } from "./tools/registry.js";
import type { TierSecurityDefaults } from "@helix/sdk-types";
import {
  resolveAgentLimitBudget,
  type AgentLimitBudget,
  type AgentLimitExceeded,
  type AgentRateCostLimiter,
} from "./limits/index.js";

export type ToolInvokeResult<Output = unknown> =
  | { readonly ok: true; readonly status?: "executed"; readonly output: Output }
  | {
      readonly ok: true;
      readonly status: "pending_confirmation";
      readonly output: Output;
      readonly pending: PendingToolInvocation;
    }
  | {
      readonly ok: false;
      readonly statusCode: number;
      readonly error: string;
      readonly retryAfterSeconds?: number;
      readonly rateLimit?: ToolRateLimitMetadata;
      readonly quotaLimit?: ToolQuotaLimitMetadata;
    };
export type ToolInvokeErrorResult = Extract<ToolInvokeResult, { readonly ok: false }>;

export interface ToolRateLimitMetadata {
  readonly reason: AgentLimitExceeded["reason"];
  readonly retryAfterSeconds: number;
  readonly usage: AgentLimitExceeded["usage"];
}

export interface ToolQuotaLimitMetadata {
  readonly quota: string;
  readonly limit: number;
  readonly used: number;
  readonly remaining: 0;
  readonly retryAfterSeconds: number;
  readonly resetsAt: string;
}

export interface ToolInvokeOptions {
  readonly request?: RequestContext;
  readonly actor?: Actor;
  /**
   * Identifier of the credential used to authenticate this call. This is
   * deliberately separate from the actor so registry-level audit records can
   * correlate credential revocation without serializing credential policy or
   * token material.
   */
  readonly credentialId?: string;
  /**
   * A caller-computed SHA-256 fingerprint, never the raw idempotency key.
   * Invalid/non-fingerprint values are omitted from audit records.
   */
  readonly idempotencyFingerprint?: string;
  /**
   * Internal correlation for execution of an already-approved pending action.
   */
  readonly pendingActionId?: string;
  readonly skipConfirmation?: boolean;
  readonly enforceConfirmation?: boolean;
  readonly estimatedCostUsdMicros?: number;
  /**
   * Per-credential policy overrides (PRD §9.2) resolved from the credential
   * that authenticated the request. When present, `confirmationOverride`
   * overrides the tier confirmation decision and `rateLimitOverrides` adjust
   * the agent rate / cost budget for this invocation.
   */
  readonly credentialPolicy?: CredentialPolicyOverrides;
}

/**
 * Subset of an agent credential's policy that affects tool invocation.
 * Kept structural so {@link AgentCredentialPolicy} from the auth module can be
 * passed directly without a dependency cycle.
 */
export interface CredentialPolicyOverrides {
  readonly confirmationOverride?: "always" | "never" | "inherit";
  readonly rateLimitOverrides?: {
    readonly requestsPerMinute?: number | null;
    readonly requestsPerDay?: number | null;
    readonly costPerDayUsdMicros?: number | null;
  };
}

export interface ToolAuditSink {
  append(record: AuditRecord & { readonly orgId: string }): Promise<unknown>;
}

export type ToolInvocationAuditVerb =
  | "tool.invocation.denied"
  | "tool.invocation.pending"
  | "tool.invocation.executed"
  | "tool.invocation.failed"
  | "tool.invocation.cancelled";

export type ToolInvocationAuditStatus = "denied" | "pending" | "executed" | "failed" | "cancelled";

export interface PendingToolActionOptions {
  readonly actor: Actor;
  readonly request?: RequestContext;
  readonly credentialId?: string;
  readonly credentialPolicy?: CredentialPolicyOverrides;
  readonly idempotencyFingerprint?: string;
}

export type ToolMetricStatus = "executed" | "pending_confirmation" | "error";

export interface ToolInvocationMetrics {
  recordToolInvocation(input: {
    readonly toolId: string;
    readonly status: ToolMetricStatus;
    readonly durationSeconds: number;
  }): void;
  recordAgentToolLimiterDenial?(input: {
    readonly toolId: string;
    readonly tier: string;
    readonly actorType: string;
    readonly reason: string;
  }): void;
}

export type ToolFeatureFlagResolver = (tool: ToolDefinition) => string | undefined;

export interface RuntimeToolRegistry {
  register(tool: ToolDefinition): void;
  unregister(toolId: string): void;
  get(toolId: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  listVisible(actor: Actor): Promise<readonly ToolDefinition[]>;
  invoke<Output = unknown>(
    toolId: string,
    rawInput: unknown,
    options?: ToolInvokeOptions,
  ): Promise<ToolInvokeResult<Output>>;
  approvePending<Output = unknown>(
    pendingId: string,
    options: PendingToolActionOptions,
  ): Promise<ToolInvokeResult<Output>>;
  getPendingAction(
    pendingId: string,
    options: { readonly actor: Actor },
  ): Promise<
    | { readonly ok: true; readonly pending: PendingToolInvocation }
    | { readonly ok: false; readonly statusCode: number; readonly error: string }
  >;
  cancelPending(
    pendingId: string,
    options: PendingToolActionOptions,
  ): Promise<
    | { readonly ok: true; readonly status: "cancelled"; readonly pending: PendingToolInvocation }
    | { readonly ok: false; readonly statusCode: number; readonly error: string }
  >;
}

const systemActor: Actor = {
  id: "system",
  orgId: "00000000-0000-0000-0000-000000000000",
  type: "system",
  displayName: "System",
};

const unauthenticatedActor: Actor = {
  id: "anonymous",
  orgId: "00000000-0000-0000-0000-000000000000",
  type: "agent",
  displayName: "Unauthenticated",
  scopes: [],
};

const systemContext: ToolContext = {
  actor: systemActor,
  can: async () => true,
  requirePermission: async () => undefined,
  audit: async () => undefined,
};

export interface ToolRegistryOptions {
  readonly accessPolicy?: ToolAccessPolicy;
  readonly confirmationGate?: ConfirmationGate;
  readonly confirmationDefaults?: TierSecurityDefaults;
  /**
   * Generic invocation outcomes use the same durable sink as domain audit
   * events. Personal-tier and non-critical Business-tier outcomes are
   * best-effort during a sink outage. In Business and higher tiers, pending
   * actions, approved-pending executions, cancellations, destructive/external
   * calls, and credential/permission/policy mutations fail before a success
   * response can be returned unless their outcome append succeeds.
   */
  readonly auditSink?: ToolAuditSink;
  readonly agentRateCostLimiter?: AgentRateCostLimiter;
  readonly agentLimitTier?: TierSecurityDefaults["tier"];
  readonly agentLimitBudget?: Partial<AgentLimitBudget>;
  readonly metrics?: ToolInvocationMetrics;
  readonly featureFlags?: FeatureFlagProvider;
  readonly toolFeatureFlag?: ToolFeatureFlagResolver;
}

export function createToolRegistry(options: ToolRegistryOptions = {}): RuntimeToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  const accessPolicy = options.accessPolicy ?? new ScopeToolAccessPolicy();
  const confirmationDefaults = options.confirmationDefaults ?? tierDefaults.personal;
  const agentLimitTier = options.agentLimitTier ?? confirmationDefaults.tier;
  const agentLimitBudget = resolveAgentLimitBudget(agentLimitTier, options.agentLimitBudget);
  const invocationMetrics = options.metrics;

  const registry: RuntimeToolRegistry = {
    register(tool) {
      tools.set(tool.id, tool);
    },
    unregister(toolId) {
      tools.delete(toolId);
    },
    get(toolId) {
      return tools.get(toolId);
    },
    list() {
      return [...tools.values()].sort((left, right) => left.id.localeCompare(right.id));
    },
    async listVisible(actor) {
      const visible = await filterToolsForActor(this.list(), actor, accessPolicy);
      return filterToolsByFeatureFlags(visible, actor);
    },
    async invoke<Output = unknown>(
      toolId: string,
      rawInput: unknown,
      invokeOptions?: ToolInvokeOptions,
    ): Promise<ToolInvokeResult<Output>> {
      const tool = tools.get(toolId);
      const actor = invokeOptions?.actor ?? unauthenticatedActor;
      const start = process.hrtime.bigint();
      const span = trace.getTracer("helix.tools").startSpan(`tool.${toolId}`, {
        attributes: {
          "helix.tool.actor_type": actor.type,
          "helix.tool.id": toolId,
          ...(tool === undefined
            ? {}
            : {
                "helix.tool.permission": tool.permission,
                "helix.tool.side_effects": tool.sideEffects,
              }),
        },
      });
      try {
        if (tool === undefined) {
          return await completeInvocation(
            span,
            {
              ok: false,
              statusCode: 404,
              error: `Unknown tool: ${toolId}`,
            },
            {
              actor,
              toolId,
              start,
              status: "denied",
              invokeOptions,
            },
          );
        }
        if (!(await accessPolicy.can(actor, tool.permission, toolResource(tool)))) {
          return await completeInvocation(
            span,
            {
              ok: false,
              statusCode: 403,
              error: `Actor cannot invoke tool: ${toolId}`,
            },
            {
              actor,
              tool,
              toolId,
              start,
              status: "denied",
              invokeOptions,
            },
          );
        }
        const featureFlagDecision = await evaluateToolFeatureFlag(tool, actor);
        if (!featureFlagDecision.enabled) {
          span.setAttribute("helix.tool.feature_flag", featureFlagDecision.flag);
          span.setAttribute("helix.tool.feature_flag_enabled", false);
          return await completeInvocation(
            span,
            {
              ok: false,
              statusCode: 403,
              error: `Tool ${toolId} is disabled by tenant feature flag: ${featureFlagDecision.flag}`,
            },
            {
              actor,
              tool,
              toolId,
              start,
              status: "denied",
              invokeOptions,
            },
          );
        }
        const estimatedCostUsdMicros = estimateToolInvocationCost(
          tool,
          invokeOptions?.estimatedCostUsdMicros,
        );
        const limitDecision = await consumeAgentLimit(
          tool.id,
          actor,
          estimatedCostUsdMicros,
          invokeOptions?.credentialPolicy?.rateLimitOverrides,
        );
        if (limitDecision !== null) {
          return await completeInvocation(span, limitDecision, {
            actor,
            tool,
            toolId,
            start,
            status: "denied",
            invokeOptions,
          });
        }

        let input: unknown;
        try {
          input = tool.inputSchema.parse(rawInput);
        } catch (error) {
          return await completeInvocation(
            span,
            {
              ok: false,
              statusCode: 400,
              error: error instanceof Error ? error.message : "Tool input validation failed",
            },
            {
              actor,
              tool,
              toolId,
              start,
              status: "denied",
              invokeOptions,
            },
          );
        }

        const compositionResult = checkScopeComposition(actor, tool, input);
        if (!compositionResult.ok) {
          span.setAttribute("helix.tool.missing_scopes", compositionResult.missingScopes.join(","));
          return await completeInvocation(
            span,
            {
              ok: false,
              statusCode: 403,
              error: `Actor is missing required scopes for tool ${toolId}: ${compositionResult.missingScopes.join(", ")}`,
            },
            {
              actor,
              tool,
              toolId,
              start,
              status: "denied",
              invokeOptions,
            },
          );
        }
        const context = createToolContext(
          invokeOptions?.request,
          actor,
          accessPolicy,
          tool,
          optionsAuditSink(),
        );
        const confirmationGate = registryOptionsConfirmationGate();
        if (
          invokeOptions?.enforceConfirmation === true &&
          confirmationGate !== undefined &&
          shouldQueueConfirmation(
            tool,
            actor,
            confirmationDefaults,
            invokeOptions.skipConfirmation,
            invokeOptions.credentialPolicy?.confirmationOverride,
          )
        ) {
          const pending = await confirmationGate.queue({
            tool,
            actor,
            input: toJsonValue(input),
            ...(invokeOptions.request === undefined ? {} : { request: invokeOptions.request }),
            ...(invokeOptions.request?.traceId === undefined
              ? {}
              : { traceId: invokeOptions.request.traceId }),
          });
          const pendingResult: ToolInvokeResult<Output> = {
            ok: true,
            status: "pending_confirmation",
            output: { status: "pending_confirmation", pending } as Output,
            pending,
          };
          const completed = await completeInvocation(span, pendingResult, {
            actor,
            tool,
            toolId,
            start,
            status: "pending",
            invokeOptions: {
              ...invokeOptions,
              pendingActionId: pending.id,
            },
          });
          if (!completed.ok) {
            // Do not leave an unaudited pending action available for later
            // execution when fail-closed audit persistence rejects the call.
            await confirmationGate.deny({ id: pending.id, actor }).catch(() => undefined);
          }
          return completed;
        }

        try {
          const output = await tool.handler(input, context);
          const parsedOutput = tool.outputSchema.parse(output) as Output;
          await recordAgentCost(
            actor,
            estimatedCostUsdMicros,
            invokeOptions?.credentialPolicy?.rateLimitOverrides,
          );
          return await completeInvocation(
            span,
            {
              ok: true,
              output: parsedOutput,
            },
            {
              actor,
              tool,
              toolId,
              start,
              status: "executed",
              invokeOptions,
            },
          );
        } catch (error) {
          const httpError = toolHttpError(error);
          const result: ToolInvokeErrorResult = {
            ok: false,
            statusCode:
              httpError?.statusCode ?? (error instanceof PermissionDeniedError ? 403 : 500),
            error: error instanceof Error ? error.message : "Tool invocation failed",
            ...(httpError?.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: httpError.retryAfterSeconds }),
            ...(httpError?.quotaLimit === undefined ? {} : { quotaLimit: httpError.quotaLimit }),
          };
          return await completeInvocation(span, result, {
            actor,
            tool,
            toolId,
            start,
            status:
              error instanceof PermissionDeniedError || result.statusCode === 403
                ? "denied"
                : "failed",
            invokeOptions,
          });
        }
      } catch (error) {
        return await completeInvocation(
          span,
          {
            ok: false,
            statusCode: 500,
            error: error instanceof Error ? error.message : "Tool invocation failed",
          },
          {
            actor,
            ...(tool === undefined ? {} : { tool }),
            toolId,
            start,
            status: "failed",
            invokeOptions,
          },
        );
      } finally {
        span.end();
      }
    },
    async approvePending<Output = unknown>(
      pendingId: string,
      approvalOptions: PendingToolActionOptions,
    ): Promise<ToolInvokeResult<Output>> {
      const gate = registryOptionsConfirmationGate();
      if (gate === undefined) {
        await auditPendingDecision({
          actor: approvalOptions.actor,
          pendingId,
          status: "denied",
          invokeOptions: approvalOptions,
        });
        return { ok: false, statusCode: 400, error: "Confirmation gate is not configured." };
      }
      let approved: PendingToolInvocation | null;
      try {
        approved = await gate.approve({
          id: pendingId,
          actor: approvalOptions.actor,
        });
      } catch {
        await auditPendingDecision({
          actor: approvalOptions.actor,
          pendingId,
          status: "failed",
          invokeOptions: approvalOptions,
        });
        return {
          ok: false,
          statusCode: 500,
          error: "Pending tool action approval failed.",
        };
      }
      if (approved === null || approved.status !== "confirmed") {
        await auditPendingDecision({
          actor: approvalOptions.actor,
          pendingId,
          status: "denied",
          invokeOptions: approvalOptions,
        });
        return {
          ok: false,
          statusCode: 404,
          error: `Pending tool action is not approvable: ${pendingId}`,
        };
      }

      const executionRequest =
        approved.traceId === undefined
          ? approvalOptions.request
          : {
              requestId: approvalOptions.request?.requestId ?? `pending:${pendingId}`,
              traceId: approved.traceId,
              ...(approvalOptions.request?.spanId === undefined
                ? {}
                : { spanId: approvalOptions.request.spanId }),
            };
      const result = await this.invoke<Output>(approved.toolId, approved.input, {
        actor: approvalOptions.actor,
        ...(executionRequest === undefined ? {} : { request: executionRequest }),
        ...(approvalOptions.credentialId === undefined
          ? {}
          : { credentialId: approvalOptions.credentialId }),
        ...(approvalOptions.credentialPolicy === undefined
          ? {}
          : { credentialPolicy: approvalOptions.credentialPolicy }),
        ...(approvalOptions.idempotencyFingerprint === undefined
          ? {}
          : { idempotencyFingerprint: approvalOptions.idempotencyFingerprint }),
        pendingActionId: pendingId,
        skipConfirmation: true,
      });
      await gate.recordExecution({
        id: pendingId,
        actor: approvalOptions.actor,
        ...(executionRequest?.traceId === undefined ? {} : { traceId: executionRequest.traceId }),
        ...(result.ok && result.status === "executed"
          ? { result: toJsonValue(result.output) }
          : { error: result.ok ? "Pending action did not execute." : result.error }),
      });
      return result;
    },
    async getPendingAction(pendingId: string, statusOptions: { readonly actor: Actor }) {
      const gate = registryOptionsConfirmationGate();
      if (gate === undefined) {
        return { ok: false, statusCode: 400, error: "Confirmation gate is not configured." };
      }
      const pending = await gate.get({
        id: pendingId,
        actor: statusOptions.actor,
      });
      if (pending === null) {
        return {
          ok: false,
          statusCode: 404,
          error: `Pending tool action was not found: ${pendingId}`,
        };
      }
      return { ok: true, pending };
    },
    async cancelPending(pendingId: string, cancelOptions: PendingToolActionOptions) {
      const gate = registryOptionsConfirmationGate();
      if (gate === undefined) {
        await auditPendingDecision({
          actor: cancelOptions.actor,
          pendingId,
          status: "denied",
          invokeOptions: cancelOptions,
        });
        return { ok: false, statusCode: 400, error: "Confirmation gate is not configured." };
      }
      let pending: PendingToolInvocation | null;
      try {
        pending = await gate.deny({
          id: pendingId,
          actor: cancelOptions.actor,
        });
      } catch {
        await auditPendingDecision({
          actor: cancelOptions.actor,
          pendingId,
          status: "failed",
          invokeOptions: cancelOptions,
        });
        return {
          ok: false,
          statusCode: 500,
          error: "Pending tool action cancellation failed.",
        };
      }
      if (pending === null || pending.status !== "cancelled") {
        await auditPendingDecision({
          actor: cancelOptions.actor,
          pendingId,
          status: "denied",
          invokeOptions: cancelOptions,
        });
        return {
          ok: false,
          statusCode: 404,
          error: `Pending tool action is not cancellable: ${pendingId}`,
        };
      }
      const audited = await auditPendingDecision({
        actor: cancelOptions.actor,
        pendingId,
        status: "cancelled",
        tool: tools.get(pending.toolId),
        toolId: pending.toolId,
        invokeOptions: cancelOptions,
      });
      if (!audited && auditMustFailClosed()) {
        return {
          ok: false,
          statusCode: 503,
          error: criticalAuditFailureMessage,
        };
      }
      return { ok: true, status: "cancelled", pending };
    },
  };

  registry.register({
    id: "platform.ping",
    description: "Platform health check tool.",
    permission: "platform.read",
    sideEffects: "read",
    inputSchema: {
      parse: () => ({}),
      toJsonSchema: () => ({ type: "object", additionalProperties: false }),
    },
    outputSchema: {
      parse: (value) => value,
      toJsonSchema: () => ({ type: "object" }),
    },
    handler: async () => ({ ok: true, id: nanoid(), service: "helix-app" }),
  });

  return registry;

  function registryOptionsConfirmationGate(): ConfirmationGate | undefined {
    return options.confirmationGate;
  }

  function optionsAuditSink(): ToolAuditSink | undefined {
    return options.auditSink;
  }

  async function completeInvocation<Output>(
    span: Span,
    result: ToolInvokeResult<Output>,
    audit: {
      readonly actor: Actor;
      readonly tool?: ToolDefinition | undefined;
      readonly toolId: string;
      readonly start: bigint;
      readonly status: ToolInvocationAuditStatus;
      readonly invokeOptions?: ToolInvokeOptions | undefined;
    },
  ): Promise<ToolInvokeResult<Output>> {
    const durationNanoseconds = process.hrtime.bigint() - audit.start;
    const persisted = await appendInvocationAudit({
      actor: audit.actor,
      ...(audit.tool === undefined ? {} : { tool: audit.tool }),
      toolId: audit.toolId,
      status: audit.status,
      durationNanoseconds,
      ...(audit.invokeOptions === undefined ? {} : { invokeOptions: audit.invokeOptions }),
    });
    const mustPersist =
      result.ok &&
      auditMustFailClosed() &&
      requiresDurableOutcome(audit.tool, audit.status, audit.invokeOptions?.pendingActionId);
    const finalResult: ToolInvokeResult<Output> =
      persisted || !mustPersist
        ? result
        : {
            ok: false,
            statusCode: 503,
            error: criticalAuditFailureMessage,
          };
    if (!persisted) {
      span.setAttribute("helix.tool.audit_persisted", false);
    }
    return toolInvokeResultWithSpan(
      span,
      finalResult,
      audit.toolId,
      audit.start,
      invocationMetrics,
    );
  }

  async function auditPendingDecision(input: {
    readonly actor: Actor;
    readonly pendingId: string;
    readonly status: Extract<ToolInvocationAuditStatus, "denied" | "failed" | "cancelled">;
    readonly tool?: ToolDefinition | undefined;
    readonly toolId?: string;
    readonly invokeOptions: PendingToolActionOptions;
  }): Promise<boolean> {
    return appendInvocationAudit({
      actor: input.actor,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      toolId: input.toolId ?? "pending-action",
      status: input.status,
      durationNanoseconds: 0n,
      invokeOptions: {
        ...input.invokeOptions,
        pendingActionId: input.pendingId,
      },
    });
  }

  async function appendInvocationAudit(input: {
    readonly actor: Actor;
    readonly tool?: ToolDefinition | undefined;
    readonly toolId: string;
    readonly status: ToolInvocationAuditStatus;
    readonly durationNanoseconds: bigint;
    readonly invokeOptions?: ToolInvokeOptions | undefined;
  }): Promise<boolean> {
    const auditSink = optionsAuditSink();
    if (auditSink === undefined) {
      return false;
    }
    const credentialId = input.invokeOptions?.credentialId;
    const idempotencyFingerprint = safeSha256Fingerprint(
      input.invokeOptions?.idempotencyFingerprint,
    );
    try {
      await auditSink.append({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        verb: invocationAuditVerb(input.status),
        objectType: "tool_invocation",
        toolId: input.toolId,
        ...auditTraceFromRequest(input.invokeOptions?.request),
        metadata: {
          orgId: input.actor.orgId,
          actorType: input.actor.type,
          ...(credentialId === undefined ? {} : { credentialId }),
          toolId: input.toolId,
          toolPermission: input.tool?.permission ?? "unknown",
          sideEffectClass: input.tool?.sideEffects ?? "unknown",
          status: input.status,
          durationBucket: durationBucket(input.durationNanoseconds),
          ...(idempotencyFingerprint === undefined ? {} : { idempotencyFingerprint }),
          ...(input.invokeOptions?.pendingActionId === undefined
            ? {}
            : { pendingActionId: input.invokeOptions.pendingActionId }),
        },
        createdAt: new Date().toISOString(),
      });
      return true;
    } catch {
      return false;
    }
  }

  function auditMustFailClosed(): boolean {
    return confirmationDefaults.tier !== "personal";
  }

  async function consumeAgentLimit(
    toolId: string,
    actor: Actor,
    estimatedCostUsdMicros: number | undefined,
    rateLimitOverrides: CredentialPolicyOverrides["rateLimitOverrides"],
  ): Promise<ToolInvokeErrorResult | null> {
    if (!shouldLimitActor(actor) || options.agentRateCostLimiter === undefined) {
      return null;
    }

    const decision = await options.agentRateCostLimiter.consume({
      orgId: actor.orgId,
      actorId: actor.id,
      tier: agentLimitTier,
      budget: applyCredentialRateLimitOverrides(agentLimitBudget, rateLimitOverrides),
      requestCount: 1,
      ...(estimatedCostUsdMicros === undefined ? {} : { estimatedCostUsdMicros }),
    });
    if (decision.allowed) {
      return null;
    }
    invocationMetrics?.recordAgentToolLimiterDenial?.({
      toolId,
      tier: agentLimitTier,
      actorType: actor.type,
      reason: decision.reason,
    });

    const rateLimit: ToolRateLimitMetadata = {
      reason: decision.reason,
      retryAfterSeconds: decision.retryAfterSeconds,
      usage: decision.usage,
    };
    return {
      ok: false,
      statusCode: 429,
      error: `Agent tool invocation limit exceeded: ${decision.reason}`,
      retryAfterSeconds: decision.retryAfterSeconds,
      rateLimit,
    };
  }

  async function recordAgentCost(
    actor: Actor,
    costUsdMicros: number | undefined,
    rateLimitOverrides: CredentialPolicyOverrides["rateLimitOverrides"],
  ): Promise<void> {
    if (
      costUsdMicros === undefined ||
      costUsdMicros <= 0 ||
      !shouldLimitActor(actor) ||
      options.agentRateCostLimiter === undefined
    ) {
      return;
    }

    await options.agentRateCostLimiter.recordCost({
      orgId: actor.orgId,
      actorId: actor.id,
      tier: agentLimitTier,
      budget: applyCredentialRateLimitOverrides(agentLimitBudget, rateLimitOverrides),
      costUsdMicros,
    });
  }

  async function filterToolsByFeatureFlags(
    candidateTools: readonly ToolDefinition[],
    actor: Actor,
  ): Promise<readonly ToolDefinition[]> {
    const filtered: ToolDefinition[] = [];
    for (const tool of candidateTools) {
      if ((await evaluateToolFeatureFlag(tool, actor)).enabled) {
        filtered.push(tool);
      }
    }
    return filtered;
  }

  async function evaluateToolFeatureFlag(
    tool: ToolDefinition,
    actor: Actor,
  ): Promise<{ readonly enabled: true } | { readonly enabled: false; readonly flag: string }> {
    const flag = (options.toolFeatureFlag ?? featureFlagForTool)(tool);
    if (flag === undefined || options.featureFlags === undefined) {
      return { enabled: true };
    }
    const enabled = await options.featureFlags.getAsync(flag, true, {
      orgId: actor.orgId,
      actorId: actor.id,
      attributes: { toolId: tool.id },
    });
    return enabled ? { enabled: true } : { enabled: false, flag };
  }
}

export function featureFlagForTool(tool: Pick<ToolDefinition, "id">): string | undefined {
  if (tool.id === "mail.send" || tool.id === "mail.reply") {
    return "mail_outbound";
  }
  if (tool.id === "drive.share" || tool.id.startsWith("drive.access.")) {
    return "b2b_sharing";
  }
  if (tool.id.startsWith("docs.")) {
    return "editors_native_document";
  }
  if (tool.id.startsWith("sheets.")) {
    return "editors_native_spreadsheet";
  }
  if (tool.id.startsWith("slides.")) {
    return "editors_native_presentation";
  }
  return undefined;
}

/**
 * Apply a credential's rate-limit overrides (PRD §9.2) on top of the tier
 * budget. `undefined` fields inherit the tier value; explicit `null` removes
 * the limit.
 */
function applyCredentialRateLimitOverrides(
  base: AgentLimitBudget,
  overrides: CredentialPolicyOverrides["rateLimitOverrides"],
): AgentLimitBudget {
  if (overrides === undefined) {
    return base;
  }
  return {
    requestsPerMinute:
      overrides.requestsPerMinute === undefined
        ? base.requestsPerMinute
        : overrides.requestsPerMinute,
    requestsPerDay:
      overrides.requestsPerDay === undefined ? base.requestsPerDay : overrides.requestsPerDay,
    costPerDayUsdMicros:
      overrides.costPerDayUsdMicros === undefined
        ? base.costPerDayUsdMicros
        : overrides.costPerDayUsdMicros,
    costWarningThresholdRatio: base.costWarningThresholdRatio,
  };
}

function createToolContext(
  request: RequestContext | undefined,
  actor: Actor,
  accessPolicy: ToolAccessPolicy,
  tool: ToolDefinition,
  auditSink: ToolAuditSink | undefined,
): ToolContext {
  const defaultResource = toolResource(tool);
  return {
    ...systemContext,
    actor,
    ...(request === undefined ? {} : { request }),
    ...(request?.traceId === undefined ? {} : { traceId: request.traceId }),
    can: (action: string, resource?: ResourceRef) =>
      accessPolicy.can(actor, action, resource ?? defaultResource),
    requirePermission: async (action: string, resource?: ResourceRef) => {
      if (!(await accessPolicy.can(actor, action, resource ?? defaultResource))) {
        throw new PermissionDeniedError(`Actor cannot perform action: ${action}`);
      }
    },
    audit: async (verb: string, metadata?: JsonObject) => {
      if (auditSink === undefined) {
        return;
      }
      await auditSink.append({
        orgId: actor.orgId,
        actorId: actor.id,
        verb,
        objectType: "tool",
        ...(uuidPattern.test(tool.id) ? { objectId: tool.id } : {}),
        toolId: tool.id,
        ...auditTraceFromRequest(request),
        metadata: {
          actorType: actor.type,
          toolPermission: tool.permission,
          ...(metadata ?? {}),
        },
        createdAt: new Date().toISOString(),
      });
    },
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256HexPattern = /^[0-9a-f]{64}$/u;
const criticalControlChangePattern = /(?:credential|permission|policy|role|scope)/iu;
const criticalAuditFailureMessage =
  "Critical tool outcome could not be durably audited; retry only with the same idempotency key.";

function invocationAuditVerb(status: ToolInvocationAuditStatus): ToolInvocationAuditVerb {
  switch (status) {
    case "denied":
      return "tool.invocation.denied";
    case "pending":
      return "tool.invocation.pending";
    case "executed":
      return "tool.invocation.executed";
    case "failed":
      return "tool.invocation.failed";
    case "cancelled":
      return "tool.invocation.cancelled";
  }
}

function durationBucket(durationNanoseconds: bigint): string {
  const durationMilliseconds = Number(durationNanoseconds) / 1_000_000;
  if (durationMilliseconds < 10) {
    return "lt_10ms";
  }
  if (durationMilliseconds < 100) {
    return "10ms_to_99ms";
  }
  if (durationMilliseconds < 1_000) {
    return "100ms_to_999ms";
  }
  if (durationMilliseconds < 10_000) {
    return "1s_to_9s";
  }
  return "gte_10s";
}

function safeSha256Fingerprint(value: string | undefined): string | undefined {
  return value !== undefined && sha256HexPattern.test(value) ? value : undefined;
}

function requiresDurableOutcome(
  tool: ToolDefinition | undefined,
  status: ToolInvocationAuditStatus,
  pendingActionId: string | undefined,
): boolean {
  if (status === "pending" || status === "cancelled" || pendingActionId !== undefined) {
    return true;
  }
  if (status !== "executed" || tool === undefined) {
    return false;
  }
  return (
    tool.sideEffects === "destructive" ||
    tool.sideEffects === "external_communication" ||
    isCriticalControlChange(tool)
  );
}

function isCriticalControlChange(
  tool: Pick<ToolDefinition, "id" | "permission" | "sideEffects">,
): boolean {
  return (
    tool.sideEffects !== "read" &&
    criticalControlChangePattern.test(`${tool.id} ${tool.permission}`)
  );
}

function toolInvokeResultWithSpan<Output>(
  span: Span,
  result: ToolInvokeResult<Output>,
  toolId: string,
  start: bigint,
  metrics: ToolInvocationMetrics | undefined,
): ToolInvokeResult<Output> {
  const status = result.ok ? (result.status ?? "executed") : "error";
  span.setAttribute("helix.tool.status", status);
  if (!result.ok) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: result.error });
  }
  metrics?.recordToolInvocation({
    toolId,
    status,
    durationSeconds: Number(process.hrtime.bigint() - start) / 1_000_000_000,
  });
  return result;
}

function auditTraceFromRequest(request: RequestContext | undefined): Pick<AuditRecord, "trace"> {
  if (request === undefined) {
    return {};
  }
  const trace = {
    ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
    ...(request.spanId === undefined ? {} : { spanId: request.spanId }),
  };
  return Object.keys(trace).length === 0 ? {} : { trace };
}

class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

function shouldQueueConfirmation(
  tool: ToolDefinition,
  actor: Actor,
  defaults: TierSecurityDefaults,
  skipConfirmation: boolean | undefined,
  confirmationOverride: CredentialPolicyOverrides["confirmationOverride"],
): boolean {
  if (skipConfirmation === true) {
    return false;
  }
  // RD-5: reads are immediate for agents, while every agent-originated
  // mutation is confirmation-gated unless a separately validated, bounded
  // automation policy authorizes this exact action. The legacy credential-wide
  // "never" value is not sufficiently narrow and therefore fails closed.
  if (actor.type === "agent") {
    return tool.sideEffects !== "read";
  }
  const tierDecision = confirmationRequiredForSideEffect(
    tool.sideEffects,
    defaults,
    tool.confirmationRequired,
  );
  // Human session behavior retains the configured tier/override semantics.
  switch (confirmationOverride) {
    case "always":
      return true;
    case "never":
      return false;
    case "inherit":
    case undefined:
      return tierDecision;
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function toolHttpError(error: unknown): {
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;
  readonly quotaLimit?: ToolQuotaLimitMetadata;
} | null {
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
  const retryAfterSeconds = (error as { readonly retryAfterSeconds?: unknown }).retryAfterSeconds;
  const quotaLimit = toolQuotaLimit(error);
  return {
    statusCode,
    ...(typeof retryAfterSeconds === "number" &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? { retryAfterSeconds }
      : {}),
    ...(quotaLimit === null ? {} : { quotaLimit }),
  };
}

function toolQuotaLimit(error: object): ToolQuotaLimitMetadata | null {
  const raw = (error as { readonly quotaLimit?: unknown }).quotaLimit;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const quotaLimit = raw as {
    readonly quota?: unknown;
    readonly limit?: unknown;
    readonly used?: unknown;
    readonly remaining?: unknown;
    readonly retryAfterSeconds?: unknown;
    readonly resetsAt?: unknown;
  };
  if (
    typeof quotaLimit.quota !== "string" ||
    typeof quotaLimit.limit !== "number" ||
    typeof quotaLimit.used !== "number" ||
    quotaLimit.remaining !== 0 ||
    typeof quotaLimit.retryAfterSeconds !== "number" ||
    typeof quotaLimit.resetsAt !== "string"
  ) {
    return null;
  }
  return {
    quota: quotaLimit.quota,
    limit: quotaLimit.limit,
    used: quotaLimit.used,
    remaining: 0,
    retryAfterSeconds: quotaLimit.retryAfterSeconds,
    resetsAt: quotaLimit.resetsAt,
  };
}

function shouldLimitActor(actor: Actor): boolean {
  return actor.type === "agent" || actor.type === "service_account";
}

function estimateToolInvocationCost(
  tool: ToolDefinition,
  requestEstimateUsdMicros: number | undefined,
): number | undefined {
  return requestEstimateUsdMicros ?? tool.estimatedCostUsdMicros;
}
