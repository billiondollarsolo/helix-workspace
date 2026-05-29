import { describe, expect, it } from "vitest";
import { meteringSubjectForOrg } from "@helix/sdk-types";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import {
  MeteringIngestWorker,
  parseMeteringEventPayload,
  type MeteringEventStore,
} from "./index.js";
import type { MeteringEventInsert, StoredMeteringEvent } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("MeteringIngestWorker", () => {
  it("subscribes to metering event subjects and stores valid payloads", async () => {
    const store = new InMemoryMeteringEventStore();
    const bus = new InMemoryEventBus({ clock: () => new Date("2026-05-24T12:00:00.000Z") });
    const worker = new MeteringIngestWorker({ events: bus, store });
    await worker.start();

    await bus.publish(meteringSubjectForOrg(orgId), {
      orgId,
      eventType: "storage.delta",
      quantity: "3",
      metadata: { bucket: "drive" },
    });

    expect(store.events).toEqual([
      {
        orgId,
        eventType: "storage.delta",
        quantity: "3",
        metadata: { bucket: "drive" },
        occurredAt: new Date("2026-05-24T12:00:00.000Z"),
      },
    ]);

    await worker.stop();
  });

  it("rejects malformed payloads and subject org mismatches", async () => {
    expect(() =>
      parseMeteringEventPayload({ orgId, eventType: "other", quantity: "1", metadata: {} }),
    ).toThrow("unsupported");

    const store = new InMemoryMeteringEventStore();
    const worker = new MeteringIngestWorker({
      events: new InMemoryEventBus(),
      store,
    });
    await expect(
      worker.handle({
        subject: meteringSubjectForOrg("22222222-2222-4222-8222-222222222222"),
        payload: { orgId, eventType: "api.call.billable", quantity: "1", metadata: {} },
        occurredAt: "2026-05-24T12:00:00.000Z",
      }),
    ).rejects.toThrow("does not match");
    expect(store.events).toHaveLength(0);
  });
});

class InMemoryMeteringEventStore implements MeteringEventStore {
  readonly events: MeteringEventInsert[] = [];

  async insertEvent(event: MeteringEventInsert): Promise<StoredMeteringEvent> {
    this.events.push(event);
    return toStored(event);
  }

  async insertEvents(
    events: readonly MeteringEventInsert[],
  ): Promise<readonly StoredMeteringEvent[]> {
    this.events.push(...events);
    return events.map((event) => toStored(event));
  }
}

function toStored(event: MeteringEventInsert): StoredMeteringEvent {
  return {
    id: `event-${event.eventType}`,
    orgId: event.orgId,
    eventType: event.eventType,
    quantity: event.quantity,
    metadata: event.metadata,
    occurredAt: (event.occurredAt ?? new Date("2026-05-24T12:00:00.000Z")).toISOString(),
  };
}
