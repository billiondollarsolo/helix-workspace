import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import {
  searchReindexTypes,
  type SearchReindexRequest,
  type SearchReindexRunner,
} from "./reindex.js";

const adminConfigWriteScope = "admin.config.write";

const reindexSchema = z.object({
  all: z.literal(true).optional(),
  types: z.array(z.enum(searchReindexTypes)).optional(),
  orgId: z.string().uuid().optional(),
  batchSize: z.number().int().min(1).max(1000).optional(),
  pruneStale: z.boolean().optional(),
});

export interface RegisterSearchAdminRoutesOptions {
  readonly service: SearchReindexRunner;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

export async function registerSearchAdminRoutes(
  app: FastifyInstance,
  options: RegisterSearchAdminRoutesOptions,
): Promise<void> {
  app.post("/api/admin/search/reindex", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReindexSearch(actor)) {
      return reply.code(403).send(permissionDenied);
    }

    const parsed = reindexSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid search reindex request.", issues: parsed.error.issues });
    }

    // Fail closed: tenant admins reindex only their own org. A missing body
    // orgId scopes to the actor org rather than the entire corpus.
    if (parsed.data.orgId !== undefined && parsed.data.orgId !== actor.orgId) {
      return reply.code(403).send(crossOrgDenied);
    }

    const input: SearchReindexRequest = {
      orgId: actor.orgId,
      ...(parsed.data.types === undefined ? {} : { types: parsed.data.types }),
      ...(parsed.data.batchSize === undefined ? {} : { batchSize: parsed.data.batchSize }),
      ...(parsed.data.pruneStale === undefined ? {} : { pruneStale: parsed.data.pruneStale }),
    };
    return options.service.reindex(input);
  });
}

const reindexScopes = [
  adminConfigWriteScope,
  "admin.config.*",
  "admin.search.write",
  "admin.search.*",
  "admin.*",
] as const;

export function canReindexSearch(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return reindexScopes.some((scope) => scopes.includes(scope));
}

const permissionDenied = {
  error: "Admin search reindex permission denied.",
  requiredScope: adminConfigWriteScope,
} as const;

const crossOrgDenied = {
  error: "Cross-organization search reindex denied.",
  code: "cross_org_reindex_denied",
} as const;
