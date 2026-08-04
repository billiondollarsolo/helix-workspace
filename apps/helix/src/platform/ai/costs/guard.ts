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
  const budget = resolveAICostBudget(options.tier, options.budget);
  // Tracks (orgId:actorId:utcDay) tuples that have already emitted a warning
  // so each actor is notified at most once per daily window.
  const warnedToday = new Set<string>();
  return {
    async reserve(input) {
      const decision = await options.limiter.check({
        ...costScope(input.actor, input.feature, options.tier, budget),
        estimatedCostUsdMicros: aiCentsToUsdMicros(input.estimatedCostCents),
        at: options.now?.(),
      });
      if (!decision.allowed) {
        throw new AICostLimitExceededError(
          `AI cost budget exceeded for ${input.feature}: ${decision.reason}.`,
          decision.reason,
          decision.retryAfterSeconds,
        );
      }
    },
    async record(input) {
      const at = options.now?.() ?? new Date();
      const result = await options.limiter.record({
        ...costScope(input.actor, input.feature, options.tier, budget),
        providerId: input.providerId,
        model: input.model,
        costUsdMicros: aiCentsToUsdMicros(input.costCents),
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
