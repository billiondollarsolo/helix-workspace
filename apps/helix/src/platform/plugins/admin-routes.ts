import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod3";
import type {
  RuntimeToolRegistry,
  ToolInvokeErrorResult,
  ToolInvokeResult,
} from "../tool-registry.js";

const adminPluginsScope = "admin.plugins";

const pluginIdParamsSchema = z.object({
  pluginId: z.string().min(1).max(300),
});

const pluginListQuerySchema = z.object({
  includeConfirmations: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((value) => value !== "false" && value !== false),
});

const pluginInstallBodySchema = z.object({
  version: z.string().min(1).optional(),
  source: z.enum(["official", "sideload", "self-hosted"]).default("official"),
  confirmations: z.array(z.string().min(1)).default([]),
});

const pluginConfirmationsBodySchema = z.object({
  confirmations: z.array(z.string().min(1)).default([]),
});

export interface RegisterPluginAdminRoutesOptions {
  readonly tools: RuntimeToolRegistry;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

export async function registerPluginAdminRoutes(
  app: FastifyInstance,
  options: RegisterPluginAdminRoutesOptions,
): Promise<void> {
  app.get("/api/admin/plugins", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const parsed = pluginListQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid plugin list request.", issues: parsed.error.issues });
    }
    return sendToolResult(
      reply,
      await options.tools.invoke(
        "plugin.list",
        { includeConfirmations: parsed.data.includeConfirmations },
        { actor },
      ),
    );
  });

  app.get("/api/admin/plugins/:pluginId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const params = pluginIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: "Invalid plugin identifier.", issues: params.error.issues });
    }

    const result = await options.tools.invoke<Record<string, unknown>>(
      "plugin.list",
      { includeConfirmations: true },
      { actor },
    );
    if (!result.ok) {
      return sendToolError(reply, result);
    }
    const plugins = pluginArray(result.output);
    const plugin = plugins.find((candidate) => candidate.id === params.data.pluginId);
    if (plugin === undefined) {
      return reply.code(404).send({ error: "Admin plugin not found." });
    }
    return { plugin };
  });

  app.post("/api/admin/plugins/:pluginId/install", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const parsed = parsePluginActionRequest(request, pluginInstallBodySchema);
    if (!parsed.success) {
      return reply.code(400).send(parsed.error);
    }
    return sendToolResult(
      reply,
      await options.tools.invoke(
        "plugin.install",
        { pluginId: parsed.pluginId, ...parsed.body },
        { actor },
      ),
    );
  });

  app.post("/api/admin/plugins/:pluginId/enable", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const params = pluginIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: "Invalid plugin identifier.", issues: params.error.issues });
    }
    return sendToolResult(
      reply,
      await options.tools.invoke("plugin.enable", { pluginId: params.data.pluginId }, { actor }),
    );
  });

  app.post("/api/admin/plugins/:pluginId/disable", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const params = pluginIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: "Invalid plugin identifier.", issues: params.error.issues });
    }
    return sendToolResult(
      reply,
      await options.tools.invoke("plugin.disable", { pluginId: params.data.pluginId }, { actor }),
    );
  });

  app.post("/api/admin/plugins/:pluginId/uninstall", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const parsed = parsePluginActionRequest(request, pluginConfirmationsBodySchema);
    if (!parsed.success) {
      return reply.code(400).send(parsed.error);
    }
    return sendToolResult(
      reply,
      await options.tools.invoke(
        "plugin.uninstall",
        { pluginId: parsed.pluginId, ...parsed.body },
        { actor },
      ),
    );
  });
}

export function canAdminPlugins(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminPluginsScope) || scopes.includes("admin.*");
}

function parsePluginActionRequest<Body>(
  request: FastifyRequest,
  bodySchema: z.ZodType<Body>,
):
  | { readonly success: true; readonly pluginId: string; readonly body: Body }
  | {
      readonly success: false;
      readonly error: { readonly error: string; readonly issues: unknown };
    } {
  const params = pluginIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    return {
      success: false,
      error: { error: "Invalid plugin identifier.", issues: params.error.issues },
    };
  }
  const body = bodySchema.safeParse(request.body ?? {});
  if (!body.success) {
    return {
      success: false,
      error: { error: "Invalid plugin admin request.", issues: body.error.issues },
    };
  }
  return { success: true, pluginId: params.data.pluginId, body: body.data };
}

function sendToolResult(reply: FastifyReply, result: ToolInvokeResult) {
  if (!result.ok) {
    return sendToolError(reply, result);
  }
  return result.output;
}

function sendToolError(reply: FastifyReply, result: ToolInvokeErrorResult) {
  const isPermissionDenied = result.statusCode === 403;
  return reply.code(result.statusCode).send({
    error: isPermissionDenied ? "Admin plugin permission denied." : result.error,
    ...(isPermissionDenied ? { requiredScope: adminPluginsScope } : {}),
  });
}

function pluginArray(output: Record<string, unknown>): Array<{ readonly id: string }> {
  const plugins = output.plugins;
  if (!Array.isArray(plugins)) {
    return [];
  }
  return plugins.filter(hasPluginId);
}

function hasPluginId(value: unknown): value is { readonly id: string } {
  return isRecord(value) && typeof value.id === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
