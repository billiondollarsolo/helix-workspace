import type { Actor } from "@helix/sdk-types";
import type { FastifyRequest } from "fastify";
import { unauthenticatedActor } from "./actor.js";

/** Test-only adapter for route unit tests that do not boot the real authenticator. */
export function actorFromRequest(request: FastifyRequest): Actor {
  const actorId = first(request.headers["x-helix-actor-id"]);
  const orgId = first(request.headers["x-helix-org-id"]);
  if (actorId === undefined || orgId === undefined) {
    return unauthenticatedActor;
  }
  const actorType = first(request.headers["x-helix-actor-type"]);
  const scopes = [
    ...new Set((first(request.headers["x-helix-scopes"]) ?? "").split(/[,\s]+/u).filter(Boolean)),
  ];
  return {
    id: actorId,
    orgId,
    type:
      actorType === "agent" || actorType === "service_account" || actorType === "user"
        ? actorType
        : "user",
    ...(scopes.length === 0 ? {} : { scopes }),
  };
}

function first(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
