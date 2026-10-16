import type { Actor, StandingAuthorization } from "@helix/sdk-types";
import { actorHasScope } from "../../api/scopes.js";

/** Routine work still passes the handler's tenant, ownership and resource ACL checks. */
export function collaborationAuthorization(permission: string) {
  return async (_input: unknown, actor: Actor): Promise<StandingAuthorization | null> =>
    actor.type === "agent" && actorHasScope(actor, permission)
      ? {
          id: `workspace-collaboration:${permission}`,
          version: "1",
          requestsPerMinute: 60,
          requestsPerDay: 2000,
        }
      : null;
}
