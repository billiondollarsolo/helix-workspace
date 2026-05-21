import type { EventEnvelope, JsonObject, JsonValue } from "@helix/sdk-types";

export interface EnrichmentEvent<Payload extends JsonValue = JsonValue> {
  readonly subject: string;
  readonly payload: Payload;
  readonly occurredAt: string;
  readonly traceId?: string | undefined;
}

export type EnrichmentStatus = "applied" | "skipped" | "failed";

export interface EnrichmentResult {
  readonly handlerId: string;
  readonly feature: string;
  readonly status: EnrichmentStatus;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface EnrichmentHandler<EventPayload extends JsonValue = JsonValue> {
  readonly id: string;
  readonly feature: string;
  readonly subjects: readonly string[];
  enrich(event: EnrichmentEvent<EventPayload>): Promise<EnrichmentResult | undefined>;
}

export interface EnrichmentWorkerSummary {
  readonly attempted: number;
  readonly applied: number;
  readonly skipped: number;
  readonly failed: number;
}

export type EnrichmentWorkerErrorHandler = (error: unknown, event: EventEnvelope, handler: EnrichmentHandler) => void;
