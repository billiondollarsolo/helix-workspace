import type { EventBus, TraceContext } from "@helix/sdk-types";
import type { TenantHourlyQuotaExceeded } from "./hourly-quota.js";

export interface TenantQuotaExceededEventInput {
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly subject: string;
  readonly orgId: string;
  readonly surface: string;
  readonly decision: TenantHourlyQuotaExceeded;
  readonly trace?: TraceContext | undefined;
  readonly metadata?: Record<string, string | number | boolean | null> | undefined;
}

export function emitTenantQuotaExceededEvent(input: TenantQuotaExceededEventInput): void {
  if (input.events === undefined) {
    return;
  }
  void input.events
    .publish(
      input.subject,
      {
        orgId: input.orgId,
        quota: input.decision.quota,
        surface: input.surface,
        limit: input.decision.limit,
        used: input.decision.used,
        remaining: input.decision.remaining,
        retryAfterSeconds: input.decision.retryAfterSeconds,
        resetsAt: input.decision.resetsAt,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
      input.trace,
    )
    .catch((error: unknown) => {
      input.onError?.(error);
    });
}
