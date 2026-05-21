import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { searchReindexTypes, type SearchReindexRequest, type SearchReindexRunner } from "./reindex.js";

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
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = reindexSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid search reindex request.", issues: parsed.error.issues });
    }

    const input: SearchReindexRequest = {
      ...(parsed.data.types === undefined ? {} : { types: parsed.data.types }),
      ...(parsed.data.orgId === undefined ? {} : { orgId: parsed.data.orgId }),
      ...(parsed.data.batchSize === undefined ? {} : { batchSize: parsed.data.batchSize }),
      ...(parsed.data.pruneStale === undefined ? {} : { pruneStale: parsed.data.pruneStale }),
    };
    return options.service.reindex(input);
  });
}

export function canReindexSearch(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return (
    scopes.includes(adminConfigWriteScope) ||
    scopes.includes("admin.config.*") ||
    scopes.includes("admin.search.write") ||
    scopes.includes("admin.search.*") ||
    scopes.includes("admin.*")
  );
}

function permissionDeniedResponse(): {
  readonly error: string;
  readonly requiredScope: typeof adminConfigWriteScope;
} {
  return {
    error: "Admin search reindex permission denied.",
    requiredScope: adminConfigWriteScope,
  };
}
