import type { EventBus, TraceContext } from "./core.js";
import type { JsonObject } from "./json.js";

export const meteringEventTypes = [
  "ai.tokens",
  "ai.image.generated",
  "storage.delta",
  "export.completed",
] as const;

export type MeteringEventType = (typeof meteringEventTypes)[number];

export const meteringRollupMetricKeys = [
  "ai_tokens",
  "storage_delta_bytes",
  "exports_count",
  "ai_images_generated",
  "storage_avg_bytes",
] as const;

export type MeteringRollupMetricKey = (typeof meteringRollupMetricKeys)[number];

export const meteringRollupMetricKeyByEventType = {
  "ai.tokens": "ai_tokens",
  "ai.image.generated": "ai_images_generated",
  "storage.delta": "storage_delta_bytes",
  "export.completed": "exports_count",
} as const satisfies Record<MeteringEventType, MeteringRollupMetricKey>;

export interface MeteringEvent {
  readonly type: MeteringEventType;
  readonly quantity: number | string;
  readonly metadata?: JsonObject;
  readonly occurredAt?: string;
}

export interface MeteringEmitInput {
  readonly orgId: string;
  readonly event: MeteringEvent;
  readonly trace?: TraceContext;
}

export interface MeteringEventPayload extends JsonObject {
  readonly orgId: string;
  readonly eventType: MeteringEventType;
  readonly quantity: string;
  readonly metadata: JsonObject;
  readonly occurredAt?: string;
}

export interface MeteringClient {
  emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void>;
  emitBatch(events: readonly MeteringEmitInput[]): Promise<void>;
}

export type MeteringEventBus = Pick<EventBus, "publish">;

export function meteringSubjectForOrg(orgId: string): string {
  return `metering.events.${orgId}`;
}

export function isMeteringRollupMetricKey(value: string): value is MeteringRollupMetricKey {
  return (meteringRollupMetricKeys as readonly string[]).includes(value);
}
