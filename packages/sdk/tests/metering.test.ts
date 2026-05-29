import { describe, expect, it } from "vitest";
import type { JsonValue, TraceContext } from "@helix/sdk-types";
import { createMeteringClient, EventBusMeteringClient } from "../src/metering.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("EventBusMeteringClient", () => {
  it("publishes canonical metering events to the org subject", async () => {
    const recording = createRecordingEventBus();
    const client = createMeteringClient(recording.events);
    const trace = { traceId: "trace-1", spanId: "span-1" };

    await client.emit(
      orgId,
      {
        type: "ai.tokens",
        quantity: 42,
        metadata: { model: "gpt-test" },
        occurredAt: "2026-05-24T12:00:00.000Z",
      },
      trace,
    );

    expect(recording.publications).toEqual([
      {
        subject: `metering.events.${orgId}`,
        payload: {
          orgId,
          eventType: "ai.tokens",
          quantity: "42",
          metadata: { model: "gpt-test" },
          occurredAt: "2026-05-24T12:00:00.000Z",
        },
        trace,
      },
    ]);
  });

  it("rejects unsupported event types before publishing", async () => {
    const recording = createRecordingEventBus();
    const client = new EventBusMeteringClient({ events: recording.events });

    await expect(
      client.emit(orgId, { type: "unknown.metric" as "api.call.billable", quantity: 1 }),
    ).rejects.toThrow("Unsupported metering event type");
    expect(recording.publications).toHaveLength(0);
  });

  it("publishes negative storage deltas without coercing them positive", async () => {
    const recording = createRecordingEventBus();
    const client = createMeteringClient(recording.events);

    await client.emit(orgId, {
      type: "storage.delta",
      quantity: -128,
      metadata: { bucket: "drive", byte_delta: -128 },
    });

    expect(recording.publications[0]?.payload).toEqual({
      orgId,
      eventType: "storage.delta",
      quantity: "-128",
      metadata: { bucket: "drive", byte_delta: -128 },
    });
  });
});

function createRecordingEventBus(): {
  readonly events: {
    publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void>;
  };
  readonly publications: readonly {
    readonly subject: string;
    readonly payload: JsonValue;
    readonly trace?: TraceContext;
  }[];
} {
  const publications: { subject: string; payload: JsonValue; trace?: TraceContext }[] = [];
  return {
    publications,
    events: {
      async publish(subject, payload, trace) {
        publications.push({ subject, payload, ...(trace === undefined ? {} : { trace }) });
      },
    },
  };
}
