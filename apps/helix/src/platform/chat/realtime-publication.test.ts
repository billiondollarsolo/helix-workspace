import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "../events/in-memory-event-bus.js";
import { EventBusChatRoomBus, roomSubject } from "./realtime.js";

// A persisted cursor is not necessarily committed when an HTTP handler publishes it.
describe("committed Chat fanout", () => {
  it("waits for the transactional outbox before announcing stored events", async () => {
    const transport = new InMemoryEventBus();
    const events = { append: vi.fn(), replay: vi.fn() };
    const bus = new EventBusChatRoomBus(transport, { events });
    const receive = vi.fn(async () => {});
    const unsubscribe = await bus.subscribe("org", "room", receive);
    const event = { type: "message.created", orgId: "org", roomId: "room", cursor: 1 };
    await bus.publish("org", "room", event);
    expect(receive).not.toHaveBeenCalled();
    expect(events.append).not.toHaveBeenCalled();
    await transport.publish(roomSubject("org", "room"), event);
    await unsubscribe();
    expect(receive).toHaveBeenCalledExactlyOnceWith(event);
  });
});
