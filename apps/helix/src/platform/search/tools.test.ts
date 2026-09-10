import { describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { createScopedSearchRequest } from "./scope.js";
import { registerSearchTools } from "./tools.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actor: Actor = {
  id: "22222222-2222-4222-8222-222222222222",
  orgId,
  type: "user",
  scopes: ["platform.read", "mail.read", "drive.read"],
};
const driveAclFilter = `(type != "drive" OR attributes.allowedActorIds = ${JSON.stringify(actor.id)})`;

describe("search tools", () => {
  it("registers a unified global search tool", () => {
    const registry = createToolRegistry();
    registerSearchTools(registry, { engine: new FakeSearchEngine() });

    expect(
      registry
        .list()
        .filter((tool) => tool.id.startsWith("search."))
        .map((tool) => tool.id),
    ).toEqual(["search.query"]);
  });

  it("scopes global search to the actor org and readable indexed domains", async () => {
    const engine = new FakeSearchEngine([
      { id: "mail:1", type: "mail", title: "Launch mail" },
      { id: "drive:1", type: "drive", title: "Launch deck" },
    ]);
    const registry = createToolRegistry();
    registerSearchTools(registry, { engine });

    await expect(
      registry.invoke(
        "search.query",
        { query: " launch ", types: ["mail", "chat", "drive"], limit: 5, offset: 10 },
        { actor },
      ),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        hits: [
          { id: "mail:1", type: "mail", title: "Launch mail" },
          { id: "drive:1", type: "drive", title: "Launch deck" },
        ],
        query: "launch",
        estimatedTotalHits: 2,
      },
    });
    expect(engine.searches).toEqual([
      {
        query: "launch",
        types: ["mail", "drive"],
        limit: 5,
        offset: 10,
        filter: [`attributes.orgId = ${JSON.stringify(orgId)}`, driveAclFilter],
        // Server-set RAG actor identity (see createScopedSearchRequest).
        forActorId: actor.id,
      },
    ]);
  });

  it.each([
    { types: "mail", expectedTypes: ["mail"] },
    { types: ["mail", "chat", "drive"], expectedTypes: ["mail", "drive"] },
    { types: '["mail","chat","drive"]', expectedTypes: ["mail", "drive"] },
  ])(
    "parses GET-shaped query input and scopes readable types for $types",
    async ({ types, expectedTypes }) => {
      const engine = new FakeSearchEngine();
      const registry = createToolRegistry();
      registerSearchTools(registry, { engine });

      await expect(
        registry.invoke(
          "search.query",
          { query: " launch ", types, limit: "5", offset: "10" },
          { actor },
        ),
      ).resolves.toMatchObject({
        ok: true,
        output: {
          query: "launch",
        },
      });

      expect(engine.searches).toEqual([
        {
          query: "launch",
          types: expectedTypes,
          limit: 5,
          offset: 10,
          filter: expectedTypes.includes("drive")
            ? [`attributes.orgId = ${JSON.stringify(orgId)}`, driveAclFilter]
            : `attributes.orgId = ${JSON.stringify(orgId)}`,
          forActorId: actor.id,
        },
      ]);
    },
  );

  it.each(["docs", "sheets", "slides"])("rejects the retired %s search type", async (type) => {
    const engine = new FakeSearchEngine();
    const registry = createToolRegistry();
    registerSearchTools(registry, { engine });

    await expect(
      registry.invoke("search.query", { query: "launch", types: [type] }, { actor }),
    ).resolves.toMatchObject({ ok: false });
    expect(engine.searches).toEqual([]);
  });

  it("returns an empty result without calling the engine when no requested type is readable", async () => {
    const engine = new FakeSearchEngine();
    const registry = createToolRegistry();
    registerSearchTools(registry, { engine });

    await expect(
      registry.invoke("search.query", { query: "launch", types: ["chat"] }, { actor }),
    ).resolves.toEqual({
      ok: true,
      output: { hits: [], query: "launch", estimatedTotalHits: 0 },
    });
    expect(engine.searches).toEqual([]);
  });
});

describe("createScopedSearchRequest", () => {
  it("limits system discovery to the supported application domains", () => {
    expect(
      createScopedSearchRequest({ ...actor, type: "system" }, { query: "launch" })?.types,
    ).toEqual(["mail", "chat", "drive", "calendar"]);
  });

  it("preserves extra filters as an AND with the required org filter", () => {
    expect(
      createScopedSearchRequest(actor, {
        query: "launch",
        filter: ["attributes.classification = internal"],
      }),
    ).toMatchObject({
      query: "launch",
      types: ["mail", "drive"],
      filter: [
        `attributes.orgId = ${JSON.stringify(orgId)}`,
        driveAclFilter,
        "attributes.classification = internal",
      ],
    });
  });

  it("requires the caller principal for Drive-only discovery", () => {
    expect(createScopedSearchRequest(actor, { query: "secret", types: ["drive"] })).toMatchObject({
      filter: [
        `attributes.orgId = ${JSON.stringify(orgId)}`,
        `attributes.allowedActorIds = ${JSON.stringify(actor.id)}`,
      ],
    });
  });

  it("requires the caller principal for Chat retrieval", () => {
    expect(
      createScopedSearchRequest(
        { ...actor, scopes: ["chat.read"] },
        { query: "incident", types: ["chat"] },
      ),
    ).toMatchObject({
      filter: [
        `attributes.orgId = ${JSON.stringify(orgId)}`,
        `attributes.allowedActorIds = ${JSON.stringify(actor.id)}`,
      ],
      forActorId: actor.id,
    });
  });
});

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly searches: SearchRequest[] = [];

  constructor(private readonly hits: readonly IndexDocument[] = []) {}

  async index(): Promise<void> {}

  async upsert(): Promise<void> {}

  async delete(): Promise<void> {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    this.searches.push(request);
    return {
      hits: this.hits,
      query: request.query,
      estimatedTotalHits: this.hits.length,
      processingTimeMs: 1,
    };
  }
}
