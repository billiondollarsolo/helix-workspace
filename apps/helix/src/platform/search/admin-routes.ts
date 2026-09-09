import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  searchReindexTypes,
  type SearchReindexRequest,
  type SearchReindexRunner,
} from "./reindex.js";
import type { SearchReindexJob, SearchReindexJobService } from "./durable.js";

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

  if (options.jobs !== undefined) {
    const jobs = options.jobs;
    app.post("/api/admin/search/reindex/jobs", async (request, reply) => {
      const actor = await options.actorFromRequest(request);
      if (!canReindexSearch(actor)) return reply.code(403).send(permissionDeniedResponse());
      const parsed = shadowReindexSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Invalid search reindex request.", issues: parsed.error.issues });
      }
      return serializeJob(
        await jobs.create(actor, {
          ...(parsed.data.batchSize === undefined ? {} : { batchSize: parsed.data.batchSize }),
        }),
      );
    });

    app.get<{ Params: { id: string } }>(
      "/api/admin/search/reindex/jobs/:id",
      async (request, reply) => {
        const actor = await options.actorFromRequest(request);
        if (!canReindexSearch(actor)) return reply.code(403).send(permissionDeniedResponse());
        const job = await jobs.get(request.params.id, actor.orgId);
        return job === undefined
          ? reply.code(404).send({ error: "Search reindex job not found." })
          : serializeJob(job);
      },
    );

    app.post<{ Params: { id: string } }>(
      "/api/admin/search/reindex/jobs/:id/cancel",
      async (request, reply) => {
        const actor = await options.actorFromRequest(request);
        if (!canReindexSearch(actor)) return reply.code(403).send(permissionDeniedResponse());
        return (await jobs.cancel(request.params.id, actor.orgId))
          ? { status: "cancelled" }
          : reply.code(409).send({ error: "Search reindex job is not cancellable." });
      },
    );
  }
}

function toRequest(data: z.infer<typeof reindexSchema>): SearchReindexRequest {
  return {
    ...(data.types === undefined ? {} : { types: data.types }),
    ...(data.orgId === undefined ? {} : { orgId: data.orgId }),
    ...(data.batchSize === undefined ? {} : { batchSize: data.batchSize }),
    ...(data.pruneStale === undefined ? {} : { pruneStale: data.pruneStale }),
  };
}

function serializeJob(job: SearchReindexJob): Record<string, unknown> {
  return {
    ...job,
    startMutationId: job.startMutationId.toString(),
    replayMutationId: job.replayMutationId.toString(),
    totalDocuments: job.totalDocuments.toString(),
  };
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
