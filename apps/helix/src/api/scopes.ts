import type { Actor } from "@helix/sdk-types";
import { ForbiddenError, UnauthorizedError } from "./api-error.js";

/**
 * Whether an actor holds a required OAuth/tool scope.
 * System actors always pass. Wildcards `*` and `admin.*` grant all scopes.
 */
export function actorHasScope(actor: Actor, scope: string): boolean {
  if (actor.type === "system") return true;
  const scopes = actor.scopes ?? [];
  if (scopes.includes("*") || scopes.includes("admin.*")) return true;
  return scopes.includes(scope);
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
