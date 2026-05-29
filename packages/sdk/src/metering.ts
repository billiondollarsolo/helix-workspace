import {
  meteringEventTypes,
  meteringSubjectForOrg,
  type JsonObject,
  type MeteringClient,
  type MeteringEmitInput,
  type MeteringEvent,
  type MeteringEventBus,
  type MeteringEventPayload,
  type TraceContext,
} from "@helix/sdk-types";

const meteringEventTypeSet = new Set<string>(meteringEventTypes);

export interface EventBusMeteringClientOptions {
  readonly events: MeteringEventBus;
}

export class EventBusMeteringClient implements MeteringClient {
  constructor(private readonly options: EventBusMeteringClientOptions) {}

  emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void> {
    return this.emitBatch([{ orgId, event, ...(trace === undefined ? {} : { trace }) }]);
  }

  async emitBatch(events: readonly MeteringEmitInput[]): Promise<void> {
    for (const input of events) {
      const payload = normalizeMeteringPayload(input.orgId, input.event);
      await this.options.events.publish(meteringSubjectForOrg(payload.orgId), payload, input.trace);
    }
  }
}

export function createMeteringClient(events: MeteringEventBus): MeteringClient {
  return new EventBusMeteringClient({ events });
}

function normalizeMeteringPayload(orgId: string, event: MeteringEvent): MeteringEventPayload {
  const normalizedOrgId = orgId.trim();
  if (normalizedOrgId.length === 0) {
    throw new Error("Metering orgId is required.");
  }
  if (!meteringEventTypeSet.has(event.type)) {
    throw new Error(`Unsupported metering event type: ${event.type}`);
  }

  const quantity = normalizeQuantity(event.quantity);
  const metadata = event.metadata ?? {};
  assertJsonObject(metadata, "Metering metadata");

  return {
    orgId: normalizedOrgId,
    eventType: event.type,
    quantity,
    metadata,
    ...(event.occurredAt === undefined
      ? {}
      : { occurredAt: normalizeOccurredAt(event.occurredAt) }),
  };
}

function normalizeQuantity(quantity: number | string): string {
  if (typeof quantity === "number") {
    if (!Number.isFinite(quantity)) {
      throw new Error("Metering quantity must be finite.");
    }
    return String(quantity);
  }

  const trimmed = quantity.trim();
  if (trimmed.length === 0 || !Number.isFinite(Number(trimmed))) {
    throw new Error("Metering quantity must be numeric.");
  }
  return trimmed;
}

function normalizeOccurredAt(value: string): string {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("Metering occurredAt must be a valid timestamp.");
  }
  return timestamp.toISOString();
}

function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}
