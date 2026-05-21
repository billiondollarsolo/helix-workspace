import { describe, expect, it } from "vitest";
import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import { EnrichmentHandlerRegistry, EnrichmentWorker } from "./index.js";
import type { EnrichmentHandler, EnrichmentResult } from "./types.js";

describe("EnrichmentHandlerRegistry", () => {
  it("matches enrichment handlers with activity wildcard subjects", () => {
    const registry = new EnrichmentHandlerRegistry();
    const mail = fakeHandler("mail", "mail.entity-extract", ["activity.mail.*"]);
    const allActivity = fakeHandler("all", "audit.activity", ["activity.>"]);
    registry.register(mail);
    registry.register(allActivity);

    expect(registry.matching("activity.mail.created")).toEqual([allActivity, mail]);
    expect(registry.matching("activity.chat.message.created")).toEqual([allActivity]);
  });

  it("unregisters handlers", () => {
    const registry = new EnrichmentHandlerRegistry();
    registry.register(fakeHandler("mail", "mail.classification", ["activity.mail.*"]));

    expect(registry.unregister("mail")).toBe(true);
    expect(registry.unregister("mail")).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});

describe("EnrichmentWorker", () => {
  it("subscribes to activity events and invokes registered handlers", async () => {
    const events = new FakeEventBus();
    const results: EnrichmentResult[] = [];
    const worker = new EnrichmentWorker({
      events,
      onResult: (result) => {
        results.push(result);
      },
    });

    worker.register({
      id: "mail-entities",
      feature: "mail.entity-extract",
      subjects: ["activity.mail.created"],
      enrich: async (event) => ({
        handlerId: "mail-entities",
        feature: "mail.entity-extract",
        status: "applied",
        resourceType: "mail.message",
        resourceId: stringField(event.payload, "id"),
      }),
    });

    await worker.start();
    await events.emit({
      subject: "activity.mail.created",
      payload: { id: "msg-1" },
      trace: { traceId: "trace-1" },
      occurredAt: "2026-05-20T00:00:00.000Z",
    });
    await worker.stop();

    expect(events.subscriptions).toEqual(["activity.*"]);
    expect(events.unsubscribed).toBe(true);
    expect(results).toEqual([
      {
        handlerId: "mail-entities",
        feature: "mail.entity-extract",
        status: "applied",
        resourceType: "mail.message",
        resourceId: "msg-1",
      },
    ]);
  });

  it("reports handler errors and continues other enrichments", async () => {
    const errors: unknown[] = [];
    const worker = new EnrichmentWorker({
      events: new FakeEventBus(),
      onError: (error) => errors.push(error),
    });
    worker.register({
      id: "broken",
      feature: "mail.classification",
      subjects: ["activity.mail.*"],
      enrich: async () => {
        throw new Error("classification failed");
      },
    });
    worker.register({
      id: "ok",
      feature: "mail.entity-extract",
      subjects: ["activity.mail.*"],
      enrich: async () => ({
        handlerId: "ok",
        feature: "mail.entity-extract",
        status: "skipped",
      }),
    });

    const summary = await worker.handle({
      subject: "activity.mail.created",
      payload: { id: "msg-1" },
      occurredAt: "2026-05-20T00:00:00.000Z",
    });

    expect(errors).toHaveLength(1);
    expect(summary).toEqual({ attempted: 2, applied: 0, skipped: 1, failed: 1 });
  });
});

function fakeHandler(id: string, feature: string, subjects: readonly string[]): EnrichmentHandler {
  return {
    id,
    feature,
    subjects,
    enrich: async () => undefined,
  };
}

function stringField(value: JsonValue, key: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, JsonValue>)[key];
  return typeof field === "string" ? field : undefined;
}

class FakeEventBus implements EventBus {
  readonly subscriptions: string[] = [];
  unsubscribed = false;
  private handler: ((event: EventEnvelope) => Promise<void>) | undefined;

  async publish(): Promise<void> {}

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    this.subscriptions.push(subject);
    this.handler = handler as (event: EventEnvelope) => Promise<void>;
    return () => {
      this.unsubscribed = true;
    };
  }

  async emit(event: EventEnvelope): Promise<void> {
    if (this.handler === undefined) {
      throw new Error("no subscription");
    }
    await this.handler(event);
  }
}
