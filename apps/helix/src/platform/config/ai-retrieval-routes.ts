import type { Actor, AiConfig, HelixConfig } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { serializeSearchReindexJob } from "../search/admin-routes.js";
import type { SearchReindexJobService } from "../search/durable.js";
import { resolveTierDefaults } from "./tier.js";
import {
  canReadPlatformConfig,
  canWritePlatformConfig,
  platformConfigAdminScopes,
} from "./admin.js";

interface AiRetrievalTestResult {
  readonly ok: boolean;
  readonly message: string;
  readonly latencyMs: number;
  readonly checkedAt: string;
}
interface AiRetrievalRuntimeStatus {
  readonly enabled: boolean;
  readonly backend: string | null;
  readonly embeddingModel: string | null;
  readonly dimensions: number | null;
  readonly collection: string | null;
}
export interface RegisterAiRetrievalRoutesOptions {
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly config: () => HelixConfig;
  readonly vector: {
    test(orgId: string): Promise<AiRetrievalTestResult>;
    status(): AiRetrievalRuntimeStatus;
  };
  readonly web: {
    test(config: AiConfig["webSearch"]): Promise<AiRetrievalTestResult>;
    enabled(ai: AiConfig | undefined): boolean;
  };
  readonly jobs?: Pick<SearchReindexJobService, "create">;
}

const testSchema = z.object({ target: z.enum(["vector", "web"]) }).strict();
const emptyBodySchema = z.object({}).strict();

export async function registerAiRetrievalRoutes(
  app: FastifyInstance,
  options: RegisterAiRetrievalRoutesOptions,
): Promise<void> {
  app.get("/api/admin/ai-retrieval/status", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadPlatformConfig(actor))
      return reply.code(403).send(denied(platformConfigAdminScopes.read));
    return {
      vector: options.vector.status(),
      web: { enabled: webAllowed(options.config()) && options.web.enabled(options.config().ai) },
    };
  });
  app.post("/api/admin/ai-retrieval/test", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWritePlatformConfig(actor))
      return reply.code(403).send(denied(platformConfigAdminScopes.write));
    const parsed = testSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "Choose a saved vector or web configuration to test." });
    if (parsed.data.target === "web" && !webAllowed(options.config()))
      return reply
        .code(403)
        .send({ error: "Web search is blocked by the AI or data privacy policy." });
    const started = Date.now();
    try {
      return parsed.data.target === "vector"
        ? await options.vector.test(actor.orgId)
        : await options.web.test(options.config().ai?.webSearch);
    } catch {
      return {
        ok: false,
        message:
          "Connection test failed. Check the saved endpoint, credentials, and service availability.",
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
    }
  });
  app.post("/api/admin/ai-retrieval/reindex", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWritePlatformConfig(actor))
      return reply.code(403).send(denied(platformConfigAdminScopes.write));
    if (!emptyBodySchema.safeParse(request.body ?? {}).success)
      return reply
        .code(400)
        .send({ error: "Reindex uses the current organization and saved configuration." });
    if (!options.vector.status().enabled)
      return reply
        .code(409)
        .send({ error: "Enable workspace retrieval before rebuilding the index." });
    if (options.jobs === undefined)
      return reply.code(409).send({
        error:
          "Durable search indexing is unavailable. Configure the search service before rebuilding.",
      });
    return reply.code(202).send(serializeSearchReindexJob(await options.jobs.create(actor, {})));
  });
}
function webAllowed(config: HelixConfig): boolean {
  return (
    config.ai?.enabled !== false &&
    config.security.tier !== "sovereign" &&
    !resolveTierDefaults(config).localAiOnly &&
    !config.ai?.privacy?.blockExternalForClassifications?.includes("standard")
  );
}
function denied(scope: string) {
  return { error: "Admin retrieval configuration permission denied.", requiredScope: scope };
}
