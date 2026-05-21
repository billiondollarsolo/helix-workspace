import { describe, expect, it } from "vitest";
import { OutboxWorker } from "./outbox.js";
import type { EventBus, EventEnvelope, JsonValue, OutboxMessage, TraceContext, Unsubscribe } from "@helix/sdk-types";
import type { OutboxStore, StoredOutboxMessage } from "./outbox.js";

describe("OutboxWorker", () => {
  it("publishes claimed messages and marks them delivered", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      tracestate: "vendor=value",
    };
    const store = new InMemoryOutboxStore([
      storedMessage("msg-1", "helix.test", { ok: true }, trace),
    ]);
    const events = new RecordingEventBus();
    const worker = new OutboxWorker({ store, events, batchSize: 10 });

    await expect(worker.drainOnce()).resolves.toEqual({ delivered: 1, failed: 0 });

    expect(events.published).toEqual([
      {
        subject: "helix.test",
        payload: { ok: true },
        trace,
      },
    ]);
    expect(store.delivered).toEqual(["msg-1"]);
    expect(store.failed).toEqual([]);
  });

  it("marks failed messages without delivering them", async () => {
    const store = new InMemoryOutboxStore([
      storedMessage("msg-1", "helix.fail", { ok: false }),
    ]);
    const events = new RecordingEventBus(new Error("NATS unavailable"));
    const worker = new OutboxWorker({ store, events, batchSize: 10 });

    await expect(worker.drainOnce()).resolves.toEqual({ delivered: 0, failed: 1 });

    expect(store.delivered).toEqual([]);
    expect(store.failed).toEqual([{ id: "msg-1", error: "NATS unavailable" }]);
  });
});

class InMemoryOutboxStore implements OutboxStore {
  readonly delivered: string[] = [];
  readonly failed: { readonly id: string; readonly error: string }[] = [];

  constructor(private readonly messages: readonly StoredOutboxMessage[]) {}

  async insert(message: OutboxMessage): Promise<string> {
    void message;
    throw new Error("insert is not used by these tests");
  }

  async claimUndelivered(limit: number): Promise<readonly StoredOutboxMessage[]> {
    return this.messages.slice(0, limit);
  }

  async markDelivered(id: string): Promise<void> {
    this.delivered.push(id);
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.failed.push({ id, error });
  }
}

class RecordingEventBus implements EventBus {
  readonly published: {
    readonly subject: string;
    readonly payload: JsonValue;
    readonly trace?: TraceContext;
  }[] = [];

  constructor(private readonly publishError?: Error) {}

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    if (this.publishError !== undefined) {
      throw this.publishError;
    }

    this.published.push({ subject, payload, ...(trace === undefined ? {} : { trace }) });
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    void subject;
    void handler;
    return () => {};
  }
}

function storedMessage(
  id: string,
  subject: string,
  payload: JsonValue,
  trace?: TraceContext,
): StoredOutboxMessage {
  return {
    id,
    subject,
    payload,
    attempts: 0,
    createdAt: "2026-05-20T00:00:00.000Z",
    ...(trace === undefined ? {} : { trace }),
  };
}
