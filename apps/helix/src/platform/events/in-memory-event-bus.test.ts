import { describe, expect, it } from "vitest";
import { InMemoryEventBus, subjectMatches } from "./in-memory-event-bus.js";

describe("InMemoryEventBus", () => {
  it("delivers matching events with trace context and timestamps", async () => {
    const bus = new InMemoryEventBus({
      clock: () => new Date("2026-05-21T12:00:00.000Z"),
    });
    const events: unknown[] = [];

    await bus.subscribe("activity.mail.>", async (event) => {
      events.push(event);
    });

    await bus.publish(
      "activity.mail.created",
      { messageId: "message-1" },
      { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
    );
    await bus.publish("activity.chat.created", { roomId: "room-1" });

    expect(events).toEqual([
      {
        subject: "activity.mail.created",
        payload: { messageId: "message-1" },
        trace: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
        occurredAt: "2026-05-21T12:00:00.000Z",
      },
    ]);
  });

  it("unsubscribes handlers and isolates handler failures", async () => {
    const errors: unknown[] = [];
    const bus = new InMemoryEventBus({ onError: (error) => errors.push(error) });
    const events: string[] = [];
    const unsubscribe = await bus.subscribe("activity.*.created", async (event) => {
      events.push(event.subject);
    });
    await bus.subscribe("activity.>", async () => {
      throw new Error("handler failed");
    });

    await bus.publish("activity.docs.created", { docId: "doc-1" });
    await unsubscribe();
    await bus.publish("activity.docs.created", { docId: "doc-2" });

    expect(events).toEqual(["activity.docs.created"]);
    expect(errors).toHaveLength(2);
  });

  it("matches exact, token wildcard, and terminal wildcard subjects", () => {
    expect(subjectMatches("activity.mail.created", "activity.mail.created")).toBe(true);
    expect(subjectMatches("activity.*.created", "activity.mail.created")).toBe(true);
    expect(subjectMatches("activity.>", "activity.mail.created")).toBe(true);
    expect(subjectMatches(">", "activity.mail.created")).toBe(true);
    expect(subjectMatches("activity.mail", "activity.mail.created")).toBe(false);
    expect(subjectMatches("activity.mail.created", "activity.mail")).toBe(false);
    expect(subjectMatches("activity.>.created", "activity.mail.created")).toBe(false);
    expect(subjectMatches("activity.>", "activity")).toBe(false);
  });
});
