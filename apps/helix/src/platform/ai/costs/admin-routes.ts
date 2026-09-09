import type { Actor, SecurityTier } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { resolveAICostBudget } from "./budget.js";
import type { AICostLimitOverride, AICostLimitStore } from "./limit-store.js";

const adminAIScope = "admin.ai";

const upsertBodySchema = z
  .object({
    actorId: z.string().uuid(),
    actorDailyUsd: z.number().nonnegative().max(1_000_000).nullable().optional(),
    featureDailyUsd: z.number().nonnegative().max(1_000_000).nullable().optional(),
  })
  .strict();

const actorParamsSchema = z.object({ actorId: z.string().uuid() });

const USD_MICROS = 1_000_000;

export interface RegisterAICostLimitAdminRoutesOptions {
  readonly store: AICostLimitStore;
  readonly securityTier: SecurityTier;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

/**
 * Admin API for per-user AI cost limits (P0-7 / PRD TASK-217 "limit" half).
 *
 *  - `GET    /api/admin/ai/cost-limits`             — list overrides + tier defaults
 *  - `GET    /api/admin/ai/cost-limits/:actorId`    — one user's effective limit
 *  - `PUT    /api/admin/ai/cost-limits/:actorId`    — set/raise/lower a user's limit
 *  - `DELETE /api/admin/ai/cost-limits/:actorId`    — clear an override (revert to tier)
 */
export function registerAICostLimitAdminRoutes(
  app: FastifyInstance,
  options: RegisterAICostLimitAdminRoutesOptions,
): void {
  const tierBudget = resolveAICostBudget(options.securityTier);

  app.get("/api/admin/ai/cost-limits", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canManageAICosts(actor)) {
      return reply.code(403).send(permissionDenied());
    }
    const overrides = await options.store.list({ orgId: actor.orgId });
    return {
      tierDefault: {
        tier: options.securityTier,
        actorDailyUsd: microsToUsd(tierBudget.actorDailyUsdMicros),
        featureDailyUsd: microsToUsd(tierBudget.featureDailyUsdMicros),
      },
      limits: overrides.map(toResponse),
    };
  });

  app.get("/api/admin/ai/cost-limits/:actorId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canManageAICosts(actor)) {
      return reply.code(403).send(permissionDenied());
    }
    const params = actorParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid actor id." });
    }
    const override = await options.store.get({
      orgId: actor.orgId,
      actorId: params.data.actorId,
    });
    return {
      tier: options.securityTier,
      override: override === null ? null : toResponse(override),
      effective: effectiveLimit(override, tierBudget),
    };
  });

  app.put("/api/admin/ai/cost-limits/:actorId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canManageAICosts(actor)) {
      return reply.code(403).send(permissionDenied());
    }
    const params = actorParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid actor id." });
    }
    const body = upsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: "Invalid AI cost limit.", issues: body.error.issues });
    }
    if (body.data.actorId !== params.data.actorId) {
      return reply.code(400).send({ error: "actorId in body and path must match." });
    }
    const override = await options.store.upsert({
      orgId: actor.orgId,
      actorId: params.data.actorId,
      actorDailyUsdMicros: usdToMicros(body.data.actorDailyUsd ?? null),
      featureDailyUsdMicros: usdToMicros(body.data.featureDailyUsd ?? null),
      updatedByActorId: actor.id,
    });
    return { override: toResponse(override), effective: effectiveLimit(override, tierBudget) };
  });

  app.delete("/api/admin/ai/cost-limits/:actorId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canManageAICosts(actor)) {
      return reply.code(403).send(permissionDenied());
    }
    const params = actorParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid actor id." });
    }
    const removed = await options.store.remove({
      orgId: actor.orgId,
      actorId: params.data.actorId,
    });
    return { status: removed ? "removed" : "not_found" };
  });
}

export function canManageAICosts(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(adminAIScope) || scopes.includes("admin.*");
}

interface AICostLimitResponse {
  readonly actorId: string;
  readonly actorDailyUsd: number | null;
  readonly featureDailyUsd: number | null;
  readonly updatedByActorId: string | null;
  readonly updatedAt: string;
}

function toResponse(override: AICostLimitOverride): AICostLimitResponse {
  return {
    actorId: override.actorId,
    actorDailyUsd: microsToUsd(override.actorDailyUsdMicros),
    featureDailyUsd: microsToUsd(override.featureDailyUsdMicros),
    updatedByActorId: override.updatedByActorId,
    updatedAt: override.updatedAt,
  };
}

function effectiveLimit(
  override: AICostLimitOverride | null,
  tierBudget: { readonly actorDailyUsdMicros: number | null; readonly featureDailyUsdMicros: number | null },
): { readonly actorDailyUsd: number | null; readonly featureDailyUsd: number | null } {
  return {
    actorDailyUsd: microsToUsd(override?.actorDailyUsdMicros ?? tierBudget.actorDailyUsdMicros),
    featureDailyUsd: microsToUsd(
      override?.featureDailyUsdMicros ?? tierBudget.featureDailyUsdMicros,
    ),
  };
}

function microsToUsd(value: number | null): number | null {
  return value === null ? null : value / USD_MICROS;
}

function usdToMicros(value: number | null): number | null {
  return value === null ? null : Math.round(value * USD_MICROS);
}

function permissionDenied(): { readonly error: string; readonly requiredScope: string } {
  return { error: "Admin AI cost permission denied.", requiredScope: adminAIScope };
}
