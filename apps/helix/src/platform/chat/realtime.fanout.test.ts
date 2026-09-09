import { describe, expect, it } from "vitest";
import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import {
  EventBusChatRoomBus,
  InMemoryChatRoomBus,
  InMemoryChatRoomEventLog,
  roomSubject,
} from "./realtime.js";

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

function replica(eventBus: EventBus, subjectPrefix?: string): EventBusChatRoomBus {
  return new EventBusChatRoomBus(eventBus, {
    events: new InMemoryChatRoomEventLog(),
    ...(subjectPrefix === undefined ? {} : { subjectPrefix }),
  });
}

describe("EventBusChatRoomBus multi-replica fan-out", () => {
  const orgId = "22222222-2222-4222-8222-222222222222";
  const roomA = "33333333-3333-4333-8333-333333333333";
  const roomB = "44444444-4444-4444-8444-444444444444";

  it("delivers a message.created published on replica A to a subscriber on replica B", async () => {
    const shared = new SharedInMemoryEventBus();
    const replicaA = replica(shared, "chat.room");
    const replicaB = replica(shared, "chat.room");

    const delivered: unknown[] = [];
    await replicaB.subscribe(roomA, async (event) => {
      delivered.push(event);
    });

    await replicaA.publish(roomA, {
      type: "message.created",
      roomId: roomA,
      orgId,
      actorId: "11111111-1111-4111-8111-111111111111",
    });

    expect(delivered).toEqual([
      expect.objectContaining({ type: "message.created", roomId: roomA }),
    ]);
    expect(roomSubject(roomA)).toBe(`chat.room.${roomA}.events`);
  });

  it("keeps room subjects isolated", async () => {
    const shared = new SharedInMemoryEventBus();
    const bus = replica(shared);
    const a: unknown[] = [];
    const b: unknown[] = [];
    await bus.subscribe(roomA, async (e) => {
      a.push(e);
    });
    await bus.subscribe(roomB, async (e) => {
      b.push(e);
    });
    await bus.publish(roomA, { type: "typing", roomId: roomA, orgId });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it("delivers the same inline-media and fenced-code projection to two clients", async () => {
    const shared = new SharedInMemoryEventBus();
    const sender = replica(shared);
    const clients = [replica(shared), replica(shared)];
    const received: unknown[][] = [[], []];
    await Promise.all(
      clients.map((client, index) =>
        client.subscribe(roomA, async (event) => {
          received[index]?.push(event);
        }),
      ),
    );
    await sender.publish(roomA, {
      version: 1,
      type: "message.created",
      roomId: roomA,
      orgId,
      message: {
        body: "```ts\nconst ready = true;\n```",
        bodyFormat: "markdown",
        attachmentObjectIds: ["55555555-5555-4555-8555-555555555555"],
        attachments: [
          {
            objectId: "55555555-5555-4555-8555-555555555555",
            source: "chat",
            filename: "animated.gif",
            mimeType: "image/gif",
            byteSize: 42,
          },
        ],
      },
    });

    expect(received[0]).toEqual(received[1]);
    expect(received[0]?.[0]).toMatchObject({
      message: {
        bodyFormat: "markdown",
        attachments: [{ source: "chat", filename: "animated.gif" }],
      },
    });
  });

  it("unsubscribing on one replica does not drop the other", async () => {
    const shared = new SharedInMemoryEventBus();
    const replicaA = replica(shared);
    const replicaB = replica(shared);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const unsubA = await replicaA.subscribe(roomA, async (e) => {
      a.push(e);
    });
    await replicaB.subscribe(roomA, async (e) => {
      b.push(e);
    });
    await unsubA();
    await replicaA.publish(roomA, { type: "typing", roomId: roomA, orgId });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });

  it("retains only durable events and pages them in sequence order", async () => {
    const bus = new InMemoryChatRoomBus();
    await bus.publish(roomA, { type: "typing", roomId: roomA, orgId, isTyping: true });
    for (const id of ["one", "two", "three"]) {
      await bus.publish(roomA, {
        type: "message.created",
        roomId: roomA,
        orgId,
        message: { id },
      });
    }

    const first = await bus.replay({ orgId, actorId: "actor", roomId: roomA, after: 0, limit: 2 });
    const second = await bus.replay({
      orgId,
      actorId: "actor",
      roomId: roomA,
      after: first.cursor,
      limit: 2,
    });

    expect(first.events.map((event) => event.cursor)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    expect(second.events.map((event) => event.cursor)).toEqual([3]);
    expect(second.hasMore).toBe(false);
  });
});
