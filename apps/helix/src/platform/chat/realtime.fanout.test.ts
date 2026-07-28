import { describe, expect, it } from "vitest";
import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import { EventBusChatRoomBus, roomSubject } from "./realtime.js";

class SharedInMemoryEventBus implements EventBus {
  readonly #handlers = new Map<string, Set<(event: EventEnvelope) => Promise<void>>>();

  async publish(subject: string, payload: JsonValue): Promise<void> {
    const envelope: EventEnvelope = {
      subject,
      payload,
      occurredAt: new Date().toISOString(),
    };
    const handlers = [...(this.#handlers.get(subject) ?? [])];
    await Promise.all(handlers.map((h) => h(envelope)));
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    const wrapped = handler as (event: EventEnvelope) => Promise<void>;
    const set = this.#handlers.get(subject) ?? new Set<(event: EventEnvelope) => Promise<void>>();
    set.add(wrapped);
    this.#handlers.set(subject, set);
    return () => {
      set.delete(wrapped);
      if (set.size === 0) {
        this.#handlers.delete(subject);
      }
    };
  }
}

describe("EventBusChatRoomBus multi-replica fan-out", () => {
  const roomA = "33333333-3333-4333-8333-333333333333";
  const roomB = "44444444-4444-4444-8444-444444444444";
  const orgId = "22222222-2222-4222-8222-222222222222";

  it("delivers a message.created published on replica A to a subscriber on replica B", async () => {
    const shared = new SharedInMemoryEventBus();
    const replicaA = new EventBusChatRoomBus(shared, { subjectPrefix: "chat.room" });
    const replicaB = new EventBusChatRoomBus(shared, { subjectPrefix: "chat.room" });

    const delivered: unknown[] = [];
    await replicaB.subscribe(orgId, roomA, async (event) => {
      delivered.push(event);
    });

    await replicaA.publish(orgId, roomA, {
      type: "message.created",
      eventId: "event-1",
      orgId,
      roomId: roomA,
      actorId: "11111111-1111-4111-8111-111111111111",
    });

    expect(delivered).toEqual([
      expect.objectContaining({ type: "message.created", roomId: roomA }),
    ]);
    expect(roomSubject(orgId, roomA)).toBe(`chat.org.${orgId}.room.${roomA}.events`);
  });

  it("keeps room subjects isolated", async () => {
    const shared = new SharedInMemoryEventBus();
    const bus = new EventBusChatRoomBus(shared);
    const a: unknown[] = [];
    const b: unknown[] = [];
    await bus.subscribe(orgId, roomA, async (e) => {
      a.push(e);
    });
    await bus.subscribe(orgId, roomB, async (e) => {
      b.push(e);
    });
    await bus.publish(orgId, roomA, {
      type: "typing",
      eventId: "event-2",
      orgId,
      roomId: roomA,
    });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("unsubscribing on one replica does not drop the other", async () => {
    const shared = new SharedInMemoryEventBus();
    const replicaA = new EventBusChatRoomBus(shared);
    const replicaB = new EventBusChatRoomBus(shared);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = await replicaA.subscribe(orgId, roomA, async (e) => {
      a.push(e);
    });
    await replicaB.subscribe(orgId, roomA, async (e) => {
      b.push(e);
    });
    await unsubA();
    await replicaA.publish(orgId, roomA, {
      type: "typing",
      eventId: "event-3",
      orgId,
      roomId: roomA,
    });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it("drops forged wrong-organization payloads and duplicate deliveries", async () => {
    const shared = new SharedInMemoryEventBus();
    const bus = new EventBusChatRoomBus(shared);
    const delivered: unknown[] = [];
    const unsubscribe = await bus.subscribe(orgId, roomA, async (event) => {
      delivered.push(event);
    });
    const subject = roomSubject(orgId, roomA);
    await shared.publish(subject, {
      type: "typing",
      eventId: "forged",
      orgId: "99999999-9999-4999-8999-999999999999",
      roomId: roomA,
    });
    const valid = {
      type: "typing",
      eventId: "dedupe",
      orgId,
      roomId: roomA,
    } as const;
    await shared.publish(subject, valid);
    await shared.publish(subject, valid);
    await unsubscribe();
    expect(delivered).toEqual([valid]);
  });

  it("bounds pending delivery for a slow consumer", async () => {
    const shared = new SharedInMemoryEventBus();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let slowConsumerCount = 0;
    const bus = new EventBusChatRoomBus(shared, {
      maxPendingEvents: 1,
      onSlowConsumer: () => {
        slowConsumerCount += 1;
      },
    });
    const delivered: string[] = [];
    const unsubscribe = await bus.subscribe(orgId, roomA, async (event) => {
      delivered.push(event.eventId);
      await gate;
    });
    await bus.publish(orgId, roomA, {
      type: "typing",
      eventId: "first",
      orgId,
      roomId: roomA,
    });
    await bus.publish(orgId, roomA, {
      type: "typing",
      eventId: "dropped",
      orgId,
      roomId: roomA,
    });
    expect(slowConsumerCount).toBe(1);
    release?.();
    await unsubscribe();
    expect(delivered).toEqual(["first"]);
  });
});
