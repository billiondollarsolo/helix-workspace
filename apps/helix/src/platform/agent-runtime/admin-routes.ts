import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor } from "@helix/sdk-types";
import { z } from "zod";
import { agentRuntimeConfigSchema } from "@helix/contracts";
import { BadRequestError, ForbiddenError } from "../../api/api-error.js";
import {
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type { AssistantModelCatalog } from "../assistant/types.js";
import type { AgentRuntimeStore } from "./store.js";
export function registerAgentRuntimeRoutes(
  app: FastifyInstance,
  options: {
    store: AgentRuntimeStore;
    actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
    auditSink: AdminConsoleAuditSink;
    models: () => Promise<AssistantModelCatalog>;
  },
) {
  const actor = async (request: FastifyRequest, write = false) => {
    const a = await options.actorFromRequest(request);
    if (
      a.type !== "user" ||
      !(write ? canWriteAdminConsole(a, "admin.agents") : canReadAdminConsole(a, "admin.agents"))
    )
      throw new ForbiddenError(
        "A human administrator with agent-management permission is required.",
      );
    return a;
  };
  app.get("/api/admin/agent-runtimes", async (request) => {
    const a = await actor(request);
    return { items: await options.store.list(a), models: await options.models() };
  });
  app.put("/api/admin/agent-runtimes/:actorId", async (request) => {
    const a = await actor(request, true),
      params = z.object({ actorId: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ config: agentRuntimeConfigSchema, resetToNow: z.boolean().default(false) })
      .strict()
      .parse(request.body);
    const config = { ...body.config, enabled: body.config.mode === "helix" && body.config.enabled };
    if (
      config.enabled &&
      !(await options.models()).models.some((model) => model.id === config.modelId)
    )
      throw new BadRequestError(
        "Select an available Assistant model in AI settings before enabling this agent.",
      );
    const saved = await options.store.configure(a, params.actorId, config, body.resetToNow);
    await auditAdminAction(options.auditSink, {
      orgId: a.orgId,
      actorId: a.id,
      verb: "agent.hosting.configured",
      objectType: "actor",
      objectId: params.actorId,
      metadata: {
        mode: config.mode,
        enabled: config.enabled,
        credentialId: config.credentialId,
        modelId: config.modelId,
        events: config.events,
        turnsPerHour: config.turnsPerHour,
        resetToNow: body.resetToNow,
        version: saved.version,
      },
    });
    return { runtime: saved };
  });
}
