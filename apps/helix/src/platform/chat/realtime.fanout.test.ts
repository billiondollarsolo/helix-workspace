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

  it("delivers a message.created published on replica A to a subscriber on replica B", async () => {
    const shared = new SharedInMemoryEventBus();
    const replicaA = new EventBusChatRoomBus(shared, { subjectPrefix: "chat.room" });
    const replicaB = new EventBusChatRoomBus(shared, { subjectPrefix: "chat.room" });

    const delivered: unknown[] = [];
    await replicaB.subscribe(roomA, async (event) => {
      delivered.push(event);
    });

    await replicaA.publish(roomA, {
      type: "message.created",
      roomId: roomA,
      actorId: "11111111-1111-4111-8111-111111111111",
    });

    expect(delivered).toEqual([
      expect.objectContaining({ type: "message.created", roomId: roomA }),
    ]);
    expect(roomSubject(roomA)).toBe(`chat.room.${roomA}.events`);
  });

  it("keeps room subjects isolated", async () => {
    const shared = new SharedInMemoryEventBus();
    const bus = new EventBusChatRoomBus(shared);
    const a: unknown[] = [];
    const b: unknown[] = [];
    await bus.subscribe(roomA, async (e) => {
      a.push(e);
    });
    await bus.subscribe(roomB, async (e) => {
      b.push(e);
    });
    await bus.publish(roomA, { type: "typing", roomId: roomA });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("unsubscribing on one replica does not drop the other", async () => {
    const shared = new SharedInMemoryEventBus();
    const replicaA = new EventBusChatRoomBus(shared);
    const replicaB = new EventBusChatRoomBus(shared);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = await replicaA.subscribe(roomA, async (e) => {
      a.push(e);
    });
    await replicaB.subscribe(roomA, async (e) => {
      b.push(e);
    });
    await unsubA();
    await replicaA.publish(roomA, { type: "typing", roomId: roomA });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});
