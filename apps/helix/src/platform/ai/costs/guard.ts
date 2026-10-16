import { randomUUID } from "node:crypto";
import type { AICostLimitStore } from "./limit-store.js";
import type { Actor, SecurityTier } from "@helix/sdk-types";
import type { AICostGuard } from "../routing.js";
import { resolveAICostBudget, validateNonNegativeInteger } from "./budget.js";
import { utcDayKey } from "./daily-window.js";
import type {
  AICostBudget,
  AICostLimitReason,
  AICostLimiter,
  AICostRecordResult,
} from "./types.js";

/**
 * Emitted when an AI cost record crosses the (default 80%) warning threshold
 * of a daily budget window for the first time that day.
 */
export interface AICostWarningEvent {
  readonly actor: Actor;
  readonly feature: string;
  readonly providerId: string;
  readonly model: string;
  readonly result: AICostRecordResult;
}

export interface AICostGuardOptions {
  readonly limiter: AICostLimiter;
  readonly limitStore?: AICostLimitStore;
  readonly tier: SecurityTier;
  readonly budget?: Partial<AICostBudget> | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * Invoked the first time an actor crosses the budget warning threshold on a
   * given UTC day. P0-7: previously the limiter computed `warningReached` and
   * the guard discarded it — this callback turns it into a notification.
   */
  readonly onWarning?: ((event: AICostWarningEvent) => void | Promise<void>) | undefined;
}

export class AICostLimitExceededError extends Error {
  readonly statusCode = 429;
  constructor(
    message: string,
    readonly reason: AICostLimitReason,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "AICostLimitExceededError";
  }
}

export function createAICostGuard(options: AICostGuardOptions): AICostGuard {
  async function budgetFor(actor: Actor): Promise<AICostBudget> {
    const override =
      actor.type === "system"
        ? null
        : await options.limitStore?.get({ orgId: actor.orgId, actorId: actor.id });
    return resolveAICostBudget(options.tier, {
      ...options.budget,
      ...(override?.actorDailyUsdMicros == null
        ? {}
        : { actorDailyUsdMicros: override.actorDailyUsdMicros }),
      ...(override?.featureDailyUsdMicros == null
        ? {}
        : { featureDailyUsdMicros: override.featureDailyUsdMicros }),
    });
  }
  // Tracks (orgId:actorId:utcDay) tuples that have already emitted a warning
  // so each actor is notified at most once per daily window.
  const warnedToday = new Set<string>();
  return {
    async reserve(input) {
      const budget = await budgetFor(input.actor);
      const at = options.now?.() ?? new Date();
      const reservationId = randomUUID();
      const decision = await options.limiter.check({
        ...costScope(input.actor, input.feature, options.tier, budget),
        estimatedCostUsdMicros: aiCentsToUsdMicros(input.estimatedCostCents),
        at,
        reservationId,
      });
      if (!decision.allowed) {
        throw new AICostLimitExceededError(
          `AI cost budget exceeded for ${input.feature}: ${decision.reason}.`,
          decision.reason,
          decision.retryAfterSeconds,
        );
      }
      return { reservationId, at, estimatedCostCents: input.estimatedCostCents };
    },
    async record(input) {
      const budget = await budgetFor(input.actor);
      const at = input.reservation?.at ?? options.now?.() ?? new Date();
      const result = await options.limiter.record({
        ...costScope(input.actor, input.feature, options.tier, budget),
        providerId: input.providerId,
        model: input.model,
        costUsdMicros: aiCentsToUsdMicros(input.costCents),
        ...(input.reservation === undefined
          ? {}
          : { reservationId: input.reservation.reservationId }),
        at,
      });

      if (options.onWarning !== undefined && result.warningReached && !result.limitExceeded) {
        const warnKey = `${input.actor.orgId}:${input.actor.id}:${utcDayKey(at)}`;
        if (!warnedToday.has(warnKey)) {
          warnedToday.add(warnKey);
          await options.onWarning({
            actor: input.actor,
            feature: input.feature,
            providerId: input.providerId,
            model: input.model,
            result,
          });
        }
      }
    },
  };
}

export function aiCentsToUsdMicros(costCents: number): number {
  if (!Number.isFinite(costCents) || costCents < 0) {
    throw new Error("AI cost cents must be a non-negative finite number");
  }
  return validateNonNegativeInteger("costUsdMicros", Math.ceil(costCents * 10_000));
}

function costScope(actor: Actor, feature: string, tier: SecurityTier, budget: AICostBudget) {
  return {
    orgId: actor.orgId,
    actorId: actor.id,
    feature,
    tier,
    budget,
  };
}
