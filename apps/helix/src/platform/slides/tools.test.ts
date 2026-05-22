import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../tool-registry.js";
import { InMemorySlidesStore } from "./store.js";
import { createSlidesToolDefinitions, registerSlides, registerSlidesTools } from "./tools.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

const invokeContext = {
  actor: {
    id: actorId,
    orgId,
    type: "user" as const,
    scopes: ["slides.read", "slides.write"],
  },
};

interface ToolOutput {
  readonly [key: string]: unknown;
}

function output(result: { ok: boolean; output?: unknown }): ToolOutput {
  if (!result.ok) {
    throw new Error("Expected a successful tool invocation.");
  }
  return result.output as ToolOutput;
}

describe("slides tool definitions", () => {
  it("registers the full deck and slide tool surface with correct scopes", () => {
    const tools = createSlidesToolDefinitions({ store: new InMemorySlidesStore() });
    const byId = new Map(tools.map((tool) => [tool.id, tool]));
    expect([...byId.keys()].sort()).toEqual(
      [
        "slides.deck.create",
        "slides.deck.delete",
        "slides.deck.get",
        "slides.deck.list",
        "slides.deck.update",
        "slides.slide.create",
        "slides.slide.delete",
        "slides.slide.reorder",
        "slides.slide.update",
      ].sort(),
    );
    expect(byId.get("slides.deck.list")?.permission).toBe("slides.read");
    expect(byId.get("slides.deck.get")?.permission).toBe("slides.read");
    expect(byId.get("slides.deck.create")?.permission).toBe("slides.write");
    expect(byId.get("slides.deck.delete")?.sideEffects).toBe("destructive");
    expect(byId.get("slides.slide.delete")?.sideEffects).toBe("destructive");
  });

  it("exposes registerSlides as an alias of registerSlidesTools", () => {
    expect(registerSlides).toBe(registerSlidesTools);
  });
});

describe("slides tools end-to-end", () => {
  it("creates a deck, adds typed-layout slides, gets, and lists", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });

    const deck = output(
      await registry.invoke("slides.deck.create", { title: "Launch deck" }, invokeContext),
    );
    expect(deck.title).toBe("Launch deck");
    const deckId = deck.id as string;

    const title = output(
      await registry.invoke(
        "slides.slide.create",
        {
          deckId,
          content: { layout: "title", title: "Hello", bg: "accent" },
          speakerNotes: "warm welcome",
        },
        invokeContext,
      ),
    );
    expect(title.layout).toBe("title");
    expect(title.position).toBe(0);

    await registry.invoke(
      "slides.slide.create",
      {
        deckId,
        content: { layout: "stats", title: "Numbers", stats: [{ value: "9", label: "x" }] },
      },
      invokeContext,
    );

    const fetched = output(
      await registry.invoke("slides.deck.get", { deckId }, invokeContext),
    );
    expect((fetched.slides as unknown[]).length).toBe(2);
    expect((fetched.deck as ToolOutput).slideCount).toBe(2);

    const listed = output(
      await registry.invoke("slides.deck.list", {}, invokeContext),
    );
    expect(listed.total).toBe(1);
  });

  it("updates and reorders slides, then deletes a slide and the deck", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const deckId = (
      output(await registry.invoke("slides.deck.create", { title: "Deck" }, invokeContext)).id
    ) as string;

    const a = output(
      await registry.invoke(
        "slides.slide.create",
        { deckId, content: { layout: "agenda", title: "Agenda", items: ["A"] } },
        invokeContext,
      ),
    ).id as string;
    const b = output(
      await registry.invoke(
        "slides.slide.create",
        { deckId, content: { layout: "bullets", title: "Bullets", items: ["B"] } },
        invokeContext,
      ),
    ).id as string;

    const updated = output(
      await registry.invoke(
        "slides.slide.update",
        { slideId: a, speakerNotes: "revised" },
        invokeContext,
      ),
    );
    expect(updated.speakerNotes).toBe("revised");

    const reordered = output(
      await registry.invoke(
        "slides.slide.reorder",
        { deckId, slideIds: [b, a] },
        invokeContext,
      ),
    );
    expect((reordered.slides as ToolOutput[]).map((slide) => slide.id)).toEqual([b, a]);

    const deletedSlide = output(
      await registry.invoke("slides.slide.delete", { slideId: a }, invokeContext),
    );
    expect(deletedSlide.deleted).toBe(true);

    const deletedDeck = output(
      await registry.invoke("slides.deck.delete", { deckId }, invokeContext),
    );
    expect(deletedDeck.deleted).toBe(true);
  });

  it("rejects malformed layout content via the discriminated-union schema", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const deckId = (
      output(await registry.invoke("slides.deck.create", { title: "Deck" }, invokeContext)).id
    ) as string;

    // `stats` layout requires a `stats` array; supplying `items` is invalid.
    const result = await registry.invoke(
      "slides.slide.create",
      { deckId, content: { layout: "stats", title: "Bad", items: ["x"] } },
      invokeContext,
    );
    expect(result.ok).toBe(false);
  });

  it("fails to get an unknown deck", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const result = await registry.invoke(
      "slides.deck.get",
      { deckId: "33333333-3333-4333-8333-333333333333" },
      invokeContext,
    );
    expect(result.ok).toBe(false);
  });

  it("denies callers lacking slides scopes", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const result = await registry.invoke(
      "slides.deck.create",
      { title: "Deck" },
      { actor: { id: actorId, orgId, type: "user" as const, scopes: ["docs.read"] } },
    );
    expect(result.ok).toBe(false);
  });
});
