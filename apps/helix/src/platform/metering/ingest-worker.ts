import {
  meteringEventTypes,
  type EventBus,
  type EventEnvelope,
  type JsonObject,
  type JsonValue,
  type MeteringEventType,
  type MeteringEventPayload,
  type Unsubscribe,
} from "@helix/sdk-types";
import type { MeteringEventStore, StoredMeteringEvent } from "./store.js";
import { meteringEventInsertFromPayload } from "./store.js";

export const meteringEventsSubject = "metering.events.*";

const meteringEventTypeSet = new Set<string>(meteringEventTypes);

export interface MeteringIngestWorkerOptions {
  readonly events: EventBus;
  readonly store: MeteringEventStore;
  readonly subject?: string;
  readonly onError?: (error: unknown) => void;
}

export class MeteringIngestWorker {
  private readonly subject: string;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: Unsubscribe | undefined;

  constructor(private readonly options: MeteringIngestWorkerOptions) {
    this.subject = options.subject ?? meteringEventsSubject;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      return;
    }

    this.unsubscribe = await this.options.events.subscribe(this.subject, async (event) => {
      await this.handle(event);
    });
  }

  async stop(): Promise<void> {
    if (this.unsubscribe === undefined) {
      return;
    }

    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe();
  }

  async handle(event: EventEnvelope): Promise<StoredMeteringEvent> {
    try {
      const payload = parseMeteringEventPayload(event.payload);
      validateMeteringSubjectOrg(event.subject, payload.orgId);
      return await this.options.store.insertEvent(
        meteringEventInsertFromPayload(payload, event.occurredAt),
      );
    } catch (error) {
      this.onError?.(error);
      throw error;
    }
  }
}

export function parseMeteringEventPayload(value: JsonValue): MeteringEventPayload {
  if (!isRecord(value)) {
    throw new Error("Invalid metering event payload.");
  }

  const { orgId, eventType, quantity, metadata, occurredAt } = value;
  if (typeof orgId !== "string" || orgId.trim().length === 0) {
    throw new Error("Metering orgId is required.");
  }
  if (typeof eventType !== "string" || !meteringEventTypeSet.has(eventType)) {
    throw new Error("Metering eventType is unsupported.");
  }
  if (
    typeof quantity !== "string" ||
    quantity.trim().length === 0 ||
    !Number.isFinite(Number(quantity))
  ) {
    throw new Error("Metering quantity must be numeric.");
  }
  if (!isRecord(metadata)) {
    throw new Error("Metering metadata must be a JSON object.");
  }
  if (
    occurredAt !== undefined &&
    (typeof occurredAt !== "string" || Number.isNaN(new Date(occurredAt).getTime()))
  ) {
    throw new Error("Metering occurredAt must be a valid timestamp.");
  }

  return {
    orgId,
    eventType: eventType as MeteringEventType,
    quantity,
    metadata,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

function validateMeteringSubjectOrg(subject: string, orgId: string): void {
  const prefix = "metering.events.";
  if (subject.startsWith(prefix) && subject.slice(prefix.length) !== orgId) {
    throw new Error("Metering subject orgId does not match payload orgId.");
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
