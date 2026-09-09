import type { Actor, ResourceRef } from "@helix/sdk-types";
import { actorHasPermission, actorRoleDecision } from "../platform/permissions/roles.js";
import { ForbiddenError, UnauthorizedError } from "./api-error.js";

/**
 * Whether an actor holds a required OAuth/tool scope.
 * System actors always pass. Role permissions and binding scopes are exact.
 */
export function actorHasScope(actor: Actor, scope: string, resource?: ResourceRef): boolean {
  const target = resource ?? { type: "org", orgId: actor.orgId };
  if (actorRoleDecision(actor, scope, target) === "deny") return false;
  if (actorHasPermission(actor, scope, target)) return true;
  // Legacy direct admin scopes remain an issuance concern; role bindings never
  // expand wildcard or resource-prefix strings.
  const scopes = actor.scopes ?? [];
  return scopes.includes("*") || scopes.includes("admin.*");
}

/**
 * AuthN + scope gate for REST handlers.
 * Throws {@link UnauthorizedError} for anonymous, {@link ForbiddenError} when scope missing.
 */
export function requireActorScope(actor: Actor, scope: string): void {
  if (actor.id === "anonymous") {
    throw new UnauthorizedError("Authentication required.");
  }
  if (!actorHasScope(actor, scope)) {
    throw new ForbiddenError(`Insufficient scope: ${scope}`);
  }
}
