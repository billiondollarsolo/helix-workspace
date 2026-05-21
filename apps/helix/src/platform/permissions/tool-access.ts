import type { Actor, JsonObject, ResourceRef, ToolDefinition } from "@helix/sdk-types";
import { SpanStatusCode, trace } from "@opentelemetry/api";

/**
 * Resolve every scope an actor must hold to invoke {@link tool} for a specific
 * call, given the tool's parsed `input`. This is the unconditional `permission`
 * plus the tool's explicitly declared scope composition (PRD §9.4):
 * unconditional `requiredScopes` and conditional scopes whose predicate matches
 * the input.
 *
 * Composition is opt-in: a tool that needs a `*.destructive` or `*.external`
 * composite scope declares it via {@link ToolDefinition.scopeComposition}.
 * Nothing is inferred from `sideEffects` so the mechanism never silently
 * tightens an existing tool.
 *
 * Returns a de-duplicated, stable-ordered list. System actors are unaffected;
 * callers should short-circuit those before invoking enforcement.
 */
export function requiredScopesForCall(tool: ToolDefinition, input: unknown): readonly string[] {
  const scopes = new Set<string>([tool.permission]);
  const composition = tool.scopeComposition;
  if (composition !== undefined) {
    for (const scope of composition.requiredScopes ?? []) {
      scopes.add(scope);
    }
    for (const conditional of composition.conditionalScopes ?? []) {
      let matched = false;
      try {
        matched = conditional.when(input);
      } catch {
        // A predicate that throws on unexpected input must fail closed: treat
        // the conditional scope as required so the call is denied unless the
        // actor holds it.
        matched = true;
      }
      if (matched) {
        scopes.add(conditional.scope);
      }
    }
  }
  return [...scopes];
}

/** Outcome of a scope-composition check. */
export type ScopeCompositionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly missingScopes: readonly string[] };

/**
 * Verify an actor holds ALL scopes required for a specific tool call, including
 * conditional composite scopes evaluated against the parsed input. The base
 * `permission` is included so this is a complete check, but the tool registry
 * also runs the access policy for the base permission first; the overlap is
 * intentional and harmless.
 *
 * System actors always pass. Any other actor must explicitly hold each scope —
 * there is no wildcard expansion, matching {@link ScopeToolAccessPolicy}.
 */
export function checkScopeComposition(
  actor: Actor,
  tool: ToolDefinition,
  input: unknown,
): ScopeCompositionResult {
  if (actor.type === "system") {
    return { ok: true };
  }
  const held = new Set(actor.scopes ?? []);
  const missing = requiredScopesForCall(tool, input).filter((scope) => !held.has(scope));
  return missing.length === 0 ? { ok: true } : { ok: false, missingScopes: missing };
}

export interface ToolAccessPolicy {
  can(actor: Actor, action: string, resource: ResourceRef): Promise<boolean>;
}

export interface PermissionCheckMetrics {
  recordPermissionCheck(input: {
    readonly action: string;
    readonly actorType: string;
    readonly decision: "allow" | "deny" | "error";
    readonly durationSeconds: number;
    readonly policy: string;
    readonly resourceType: string;
  }): void;
}

export class ScopeToolAccessPolicy implements ToolAccessPolicy {
  async can(actor: Actor, action: string): Promise<boolean> {
    if (actor.type === "system") {
      return true;
    }
    return actor.scopes?.includes(action) ?? false;
  }
}

export class AllowAllToolAccessPolicy implements ToolAccessPolicy {
  async can(): Promise<boolean> {
    return true;
  }
}

export interface ObservedToolAccessPolicyOptions {
  readonly metrics: PermissionCheckMetrics;
  readonly policyId: string;
}

export class ObservedToolAccessPolicy implements ToolAccessPolicy {
  constructor(
    private readonly delegate: ToolAccessPolicy,
    private readonly options: ObservedToolAccessPolicyOptions,
  ) {}

  async can(actor: Actor, action: string, resource: ResourceRef): Promise<boolean> {
    return trace.getTracer("helix.permissions").startActiveSpan(
      "permission.check",
      {
        attributes: {
          "helix.permission.action": action,
          "helix.permission.actor_type": actor.type,
          "helix.permission.policy": this.options.policyId,
          "helix.permission.resource_type": resource.type,
        },
      },
      async (span) => {
        const start = process.hrtime.bigint();
        try {
          const allowed = await this.delegate.can(actor, action, resource);
          const decision = allowed ? "allow" : "deny";
          span.setAttribute("helix.permission.decision", decision);
          this.record(actor, action, resource, decision, start);
          return allowed;
        } catch (error) {
          span.setAttribute("helix.permission.decision", "error");
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
          this.record(actor, action, resource, "error", start);
          return false;
        } finally {
          span.end();
        }
      },
    );
  }

  private record(
    actor: Actor,
    action: string,
    resource: ResourceRef,
    decision: "allow" | "deny" | "error",
    start: bigint,
  ) {
    this.options.metrics.recordPermissionCheck({
      action,
      actorType: actor.type,
      decision,
      durationSeconds: Number(process.hrtime.bigint() - start) / 1_000_000_000,
      policy: this.options.policyId,
      resourceType: resource.type,
    });
  }
}

export interface CerbosToolAccessPolicyOptions {
  readonly endpoint: string;
  readonly fetch?: typeof fetch;
  readonly requestIdPrefix?: string;
}

interface CerbosCheckResourcesResponse {
  readonly results?: readonly {
    readonly actions?: Record<string, string>;
  }[];
}

export class CerbosToolAccessPolicy implements ToolAccessPolicy {
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #requestIdPrefix: string;

  constructor(options: CerbosToolAccessPolicyOptions) {
    this.#endpoint = options.endpoint.replace(/\/+$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#requestIdPrefix = options.requestIdPrefix ?? "helix-tool-access";
  }

  async can(actor: Actor, action: string, resource: ResourceRef): Promise<boolean> {
    if (actor.type === "system") {
      return true;
    }

    const response = await this.#fetch(`${this.#endpoint}/api/check/resources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: `${this.#requestIdPrefix}:${actor.orgId}:${actor.id}:${action}`,
        principal: principalForActor(actor),
        resources: [
          {
            resource: resourceForCerbos(actor, resource),
            actions: [action],
          },
        ],
      }),
    });
    if (!response.ok) {
      return false;
    }

    const body = (await response.json().catch(() => ({}))) as CerbosCheckResourcesResponse;
    return body.results?.[0]?.actions?.[action] === "EFFECT_ALLOW";
  }
}

export function toolResource(tool: ToolDefinition): ResourceRef {
  return {
    type: "tool",
    id: tool.id,
    attributes: {
      permission: tool.permission,
      sideEffects: tool.sideEffects,
    },
  };
}

function principalForActor(actor: Actor): JsonObject {
  return {
    id: actor.id,
    roles: rolesForActor(actor),
    attr: {
      org_id: actor.orgId,
      type: actor.type,
      scopes: [...(actor.scopes ?? [])],
    },
  };
}

function rolesForActor(actor: Actor): readonly string[] {
  const roles = new Set<string>([actor.type]);
  if (actor.scopes?.some((scope) => scope === "admin" || scope.startsWith("admin."))) {
    roles.add("admin");
  }
  return [...roles];
}

function resourceForCerbos(actor: Actor, resource: ResourceRef): JsonObject {
  return {
    id: resource.id ?? `${resource.type}:default`,
    kind: resource.type,
    attr: {
      org_id: resource.orgId ?? actor.orgId,
      ...(resource.attributes ?? {}),
    },
  };
}

export async function filterToolsForActor(
  tools: readonly ToolDefinition[],
  actor: Actor,
  policy: ToolAccessPolicy,
): Promise<readonly ToolDefinition[]> {
  const visible: ToolDefinition[] = [];
  for (const tool of tools) {
    if (await policy.can(actor, tool.permission, toolResource(tool))) {
      visible.push(tool);
    }
  }
  return visible;
}
