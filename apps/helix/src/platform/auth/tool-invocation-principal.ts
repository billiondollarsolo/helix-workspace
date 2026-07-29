import type { Actor, RequestContext } from "@helix/sdk-types";
import type { ToolInvokeOptions } from "../tool-registry.js";
import type { AgentCredentialPolicy } from "./credentials.js";

/**
 * Authentication result used by every surface that can invoke a tool.
 *
 * Credential policy remains server-internal: callers pass this object directly
 * to {@link toolInvocationOptions}; it is never included in an API response.
 */
export interface ToolInvocationPrincipal {
  readonly actor: Actor;
  readonly credentialId?: string;
  readonly credentialOwnerActorId?: string;
  readonly credentialPolicy?: AgentCredentialPolicy;
}

export type PrincipalToolInvokeOptions = ToolInvokeOptions & {
  readonly actor: Actor;
};

const principalByActor = new WeakMap<Actor, ToolInvocationPrincipal>();

/** Create an actor-only principal for a human session or trusted system actor. */
export function actorToolInvocationPrincipal(actor: Actor): ToolInvocationPrincipal {
  return principalByActor.get(actor) ?? { actor };
}

/** Create and retain the principal resolved from an agent credential. */
export function credentialToolInvocationPrincipal(input: {
  readonly actor: Actor;
  readonly credentialId: string;
  readonly credentialOwnerActorId?: string | null;
  readonly credentialPolicy: AgentCredentialPolicy;
}): ToolInvocationPrincipal {
  const principal = { actor: input.actor } as {
    actor: Actor;
    credentialId?: string;
    credentialOwnerActorId?: string;
    credentialPolicy?: AgentCredentialPolicy;
  };
  // Defense in depth: even if a principal is accidentally handed to a JSON
  // serializer, credential identity/policy do not become ordinary response
  // fields. Registry conversion still reads the non-enumerable properties.
  Object.defineProperties(principal, {
    credentialId: {
      configurable: false,
      enumerable: false,
      value: input.credentialId,
      writable: false,
    },
    ...(input.credentialOwnerActorId === undefined || input.credentialOwnerActorId === null
      ? {}
      : {
          credentialOwnerActorId: {
            configurable: false,
            enumerable: false,
            value: input.credentialOwnerActorId,
            writable: false,
          },
        }),
    credentialPolicy: {
      configurable: false,
      enumerable: false,
      value: input.credentialPolicy,
      writable: false,
    },
  });
  principalByActor.set(input.actor, principal);
  return Object.freeze(principal);
}

/**
 * Build the one registry invocation context shared by REST, MCP, tRPC and the
 * Assistant. Keeping this conversion here prevents a surface from passing only
 * the actor and silently dropping credential confirmation/rate policy.
 */
export function toolInvocationOptions(
  principal: ToolInvocationPrincipal,
  request?: RequestContext,
): PrincipalToolInvokeOptions {
  return {
    actor: principal.actor,
    ...(request === undefined ? {} : { request }),
    // REST is the default projection for the shared principal conversion.
    // MCP, tRPC, Assistant, and pending execution replace this with their
    // explicit server-known channel before invoking the registry.
    policyContext: {
      effectiveClassification: "standard",
      sourceIds: [],
      containsUntrustedContext: false,
      requestChannel: "rest",
      tenantId: principal.actor.orgId,
    },
    ...(principal.credentialId === undefined ? {} : { credentialId: principal.credentialId }),
    ...(principal.credentialOwnerActorId === undefined
      ? {}
      : { credentialOwnerActorId: principal.credentialOwnerActorId }),
    ...(principal.credentialPolicy === undefined
      ? {}
      : { credentialPolicy: principal.credentialPolicy }),
  };
}
