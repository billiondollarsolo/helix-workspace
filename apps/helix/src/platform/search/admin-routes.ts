import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SearchReindexJob, SearchReindexJobService } from "./durable.js";
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

const shadowReindexSchema = z.object({
  all: z.literal(true),
  batchSize: z.number().int().min(1).max(1000).optional(),
});

export interface RegisterSearchAdminRoutesOptions {
  readonly service: SearchReindexRunner;
  readonly jobs?: SearchReindexJobService | undefined;
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

  if (options.jobs !== undefined) {
    const jobs = options.jobs;
    app.post("/api/admin/search/reindex/jobs", async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canReindexSearch(actor)) return reply.code(403).send(permissionDenied);
      const parsed = shadowReindexSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid search reindex request.", issues: parsed.error.issues });
      }
      return serializeSearchReindexJob(
        await jobs.create(actor, {
          ...(parsed.data.batchSize === undefined ? {} : { batchSize: parsed.data.batchSize }),
        }),
      );
    });

    app.get<{ Params: { id: string } }>(
      "/api/admin/search/reindex/jobs/:id",
      async (request, reply) => {
        const actor = await options.actorFromRequest(request);
        if (!canReindexSearch(actor)) return reply.code(403).send(permissionDenied);
        const job = await jobs.get(request.params.id, actor.orgId);
        return job === undefined
          ? reply.code(404).send({ error: "Search reindex job not found." })
          : serializeSearchReindexJob(job);
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/admin/search/reindex/jobs/:id/cancel",
      async (request, reply) => {
        const actor = await options.actorFromRequest(request);
        if (!canReindexSearch(actor)) return reply.code(403).send(permissionDenied);
        return (await jobs.cancel(request.params.id, actor.orgId))
          ? { status: "cancelled" }
          : reply.code(409).send({ error: "Search reindex job is not cancellable." });
      },
    );
  }
}

export function serializeSearchReindexJob(job: SearchReindexJob): Record<string, unknown> {
  return {
    ...job,
    startMutationId: job.startMutationId.toString(),
    replayMutationId: job.replayMutationId.toString(),
    totalDocuments: job.totalDocuments.toString(),
  };
}

const reindexScopes = [
  adminConfigWriteScope,
  "admin.config.*",
  "admin.search.write",
  "admin.search.*",
  "admin.*",
] as const;

function canReindexSearch(actor: Actor): boolean {
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
