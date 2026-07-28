import { TRPCError, initTRPC } from "@trpc/server";
import { z, type ZodTypeAny } from "zod3";
import type { Actor, RequestContext, ToolDefinition } from "@helix/sdk-types";
import type { PlatformMetrics } from "./metrics.js";
import {
  canReadPlatformConfig,
  canWritePlatformConfig,
  platformConfigAdminScopes,
  platformConfigUpdateSchema,
  type PlatformConfigAdminService,
} from "../platform/config/admin.js";
import { projectToolListItem } from "./tool-projection.js";
import { jsonSchemaToZod } from "./json-schema-zod.js";
import type { RuntimeToolRegistry, ToolInvokeResult } from "../platform/tool-registry.js";

export interface HelixTRPCContext {
  readonly request: RequestContext;
  readonly actor: Actor;
}

const trpc = initTRPC.context<HelixTRPCContext>().create();
const adminConfigReadProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (!canReadPlatformConfig(ctx.actor)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Missing required scope: ${platformConfigAdminScopes.read}`,
    });
  }
  return next();
});
const adminConfigWriteProcedure = trpc.procedure.use(({ ctx, next }) => {
  if (!canWritePlatformConfig(ctx.actor)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Missing required scope: ${platformConfigAdminScopes.write}`,
    });
  }
  return next();
});

const toolCallSchema = z.object({
  toolId: z.string().min(1),
  input: z.unknown().optional(),
});

/**
 * Builds a per-tool tRPC procedure (P1-3). Each registered tool projects into a
 * dedicated typed procedure whose input/output Zod schemas are derived from the
 * same tool registry the REST and MCP surfaces use, so the web SPA gets
 * end-to-end type inference per tool rather than an opaque `unknown`.
 *
 * Read-only tools (`sideEffects: "read"`) become `query` procedures; everything
 * else becomes a `mutation`.
 */
function buildToolProcedure(tools: RuntimeToolRegistry, tool: ToolDefinition) {
  const inputSchema: ZodTypeAny = jsonSchemaToZod(tool.inputSchema.toJsonSchema());
  const outputSchema: ZodTypeAny = jsonSchemaToZod(tool.outputSchema.toJsonSchema());
  const resolve = async ({ ctx, input }: { ctx: HelixTRPCContext; input: unknown }) => {
    const result = await tools.invoke(tool.id, input, {
      request: ctx.request,
      actor: ctx.actor,
      enforceConfirmation: true,
    });
    return unwrapToolResult(result);
  };

  if (tool.sideEffects === "read") {
    return trpc.procedure
      .input(inputSchema)
      .output(z.union([outputSchema, pendingConfirmationSchema]))
      .query(resolve);
  }
  return trpc.procedure
    .input(inputSchema)
    .output(z.union([outputSchema, pendingConfirmationSchema]))
    .mutation(resolve);
}

const pendingConfirmationSchema = z
  .object({
    status: z.literal("pending_confirmation"),
    pending: z.unknown(),
  })
  .passthrough();

/**
 * Builds the per-tool projection sub-router. Tool ids are namespaced
 * (`mail.send`) so they are exposed under a nested router structure
 * (`byId.mail.send`) keyed by the full id to avoid collisions, plus a flat
 * `byId` map keyed by the verbatim tool id.
 */
function buildToolProjectionRouter(tools: RuntimeToolRegistry) {
  const procedures: Record<string, ReturnType<typeof buildToolProcedure>> = {};
  for (const tool of tools.list()) {
    procedures[tool.id] = buildToolProcedure(tools, tool);
  }
  return trpc.router(procedures);
}

export function createHelixTRPCRouter(input: {
  readonly tools: RuntimeToolRegistry;
  readonly metrics: PlatformMetrics;
  readonly platformConfig?: PlatformConfigAdminService;
}) {
  return trpc.router({
    health: trpc.procedure.query(() => ({ ok: true })),
    admin: trpc.router({
      platformConfig: trpc.router({
        get: adminConfigReadProcedure.query(async () => {
          if (input.platformConfig === undefined) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Platform config service is not configured.",
            });
          }
          return input.platformConfig.getStatus();
        }),
        readiness: adminConfigReadProcedure.query(async () => {
          if (input.platformConfig === undefined) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Platform config service is not configured.",
            });
          }
          return (await input.platformConfig.getStatus()).readiness;
        }),
        update: adminConfigWriteProcedure
          .input(platformConfigUpdateSchema)
          .mutation(async ({ ctx, input: update }) => {
            if (input.platformConfig === undefined) {
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: "Platform config service is not configured.",
              });
            }
            return input.platformConfig.update(update, ctx.actor);
          }),
      }),
    }),
    tools: trpc.router({
      list: trpc.procedure.query(async ({ ctx }) => ({
        tools: (await input.tools.listVisible(ctx.actor)).map(projectToolListItem),
      })),
      visible: trpc.procedure.query(async ({ ctx }) => ({
        tools: (await input.tools.listVisible(ctx.actor)).map(projectToolListItem),
      })),
      // Generic back-compat procedure — kept so untyped callers and dynamic
      // tooling keep working alongside the per-tool projection below.
      invoke: trpc.procedure.input(toolCallSchema).mutation(async ({ ctx, input: call }) => {
        const result = await input.tools.invoke(call.toolId, call.input, {
          request: ctx.request,
          actor: ctx.actor,
          enforceConfirmation: true,
        });
        return unwrapToolResult(result);
      }),
      // P1-3: one typed procedure per registered tool, keyed by verbatim id.
      byId: buildToolProjectionRouter(input.tools),
    }),
  });
}

export type HelixTRPCRouter = ReturnType<typeof createHelixTRPCRouter>;

function unwrapToolResult(result: ToolInvokeResult): unknown {
  if (result.ok) {
    return result.status === "pending_confirmation"
      ? { status: result.status, pending: result.pending }
      : result.output;
  }

  throw new TRPCError({
    code: statusCodeToTRPCCode(result.statusCode),
    message: result.error,
  });
}

function statusCodeToTRPCCode(
  statusCode: number,
): "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR" {
  if (statusCode === 400) {
    return "BAD_REQUEST";
  }
  if (statusCode === 403) {
    return "FORBIDDEN";
  }
  if (statusCode === 404) {
    return "NOT_FOUND";
  }
  if (statusCode === 429) {
    return "TOO_MANY_REQUESTS";
  }
  return "INTERNAL_SERVER_ERROR";
}
