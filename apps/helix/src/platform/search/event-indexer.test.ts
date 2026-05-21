import { describe, expect, it } from "vitest";
import { SearchEventIndexer, SearchIndexerRegistry } from "./event-indexer.js";
import type { EventBus, EventEnvelope, JsonValue, Unsubscribe } from "@helix/sdk-types";
import type { IndexDocument, SearchEngine, SearchIndexer } from "./types.js";

describe("SearchIndexerRegistry", () => {
  it("matches indexers by literal and wildcard subjects", () => {
    const registry = new SearchIndexerRegistry();
    const mailIndexer = fakeIndexer("mail", ["activity.mail.*"]);
    const globalIndexer = fakeIndexer("global", ["activity.>"]);
    registry.register(globalIndexer);
    registry.register(mailIndexer);

    expect(registry.matching("activity.mail.created")).toEqual([globalIndexer, mailIndexer]);
    expect(registry.matching("activity.chat.message.created")).toEqual([globalIndexer]);
  });

  it("unregisters indexers", () => {
    const registry = new SearchIndexerRegistry();
    registry.register(fakeIndexer("mail", ["activity.mail.*"]));

    expect(registry.unregister("mail")).toBe(true);
    expect(registry.unregister("mail")).toBe(false);
    expect(registry.list()).toEqual([]);
  });
});

describe("SearchEventIndexer", () => {
  it("subscribes to activity events and applies routed mutations", async () => {
    const events = new FakeEventBus();
    const engine = new FakeSearchEngine();
    const router = new SearchEventIndexer({ events, engine });
    const document = { id: "mail:1", type: "mail", title: "Hello" } satisfies IndexDocument;
    router.register({
      id: "mail",
      subjects: ["activity.mail.*"],
      route: async (event) => {
        expect(event.subject).toBe("activity.mail.created");
        return { upsert: [document] };
      },
    });

    await router.start();
    await events.emit({
      subject: "activity.mail.created",
      payload: { id: "mail:1" },
      occurredAt: "2026-05-20T00:00:00.000Z",
    });
    await router.stop();

    expect(events.subscriptions).toEqual(["activity.>"]);
    expect(events.unsubscribed).toBe(true);
    expect(engine.upserted).toEqual([[document]]);
  });

  it("applies deletes and reports indexer errors without blocking later indexers", async () => {
    const errors: unknown[] = [];
    const engine = new FakeSearchEngine();
    const router = new SearchEventIndexer({
      events: new FakeEventBus(),
      engine,
      onError: (error) => errors.push(error),
    });
    router.register({
      id: "broken",
      subjects: ["activity.mail.deleted"],
      route: async () => {
        throw new Error("projection failed");
      },
    });
    router.register({
      id: "mail",
      subjects: ["activity.mail.deleted"],
      route: async () => ({ delete: ["mail:1"] }),
    });

    await router.handle({
      subject: "activity.mail.deleted",
      payload: { id: "mail:1" },
      occurredAt: "2026-05-20T00:00:00.000Z",
    });

    expect(errors).toHaveLength(1);
    expect(engine.deleted).toEqual([["mail:1"]]);
  });
});

function fakeIndexer(id: string, subjects: readonly string[]): SearchIndexer {
  return {
    id,
    subjects,
    route: async () => undefined,
  };
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake";
  readonly indexed: IndexDocument[] = [];
  readonly upserted: IndexDocument[][] = [];
  readonly deleted: string[][] = [];

  async index(document: IndexDocument): Promise<void> {
    this.indexed.push(document);
  }

  async upsert(documents: readonly IndexDocument[]): Promise<void> {
    this.upserted.push([...documents]);
  }

  async delete(ids: readonly string[]): Promise<void> {
    this.deleted.push([...ids]);
  }

  async search(request = { query: "" }): Promise<{ readonly hits: readonly []; readonly query: string }> {
    return { hits: [], query: request.query };
  }
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
