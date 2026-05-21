import { describe, expect, it } from "vitest";
import { createMeilisearchHttpClient, MeilisearchHttpError } from "./meilisearch-http.js";

describe("Meilisearch HTTP client", () => {
  it("maps client operations to Meilisearch HTTP endpoints", async () => {
    const fetch = new FakeFetch([
      response({ taskUid: 1 }),
      response({ taskUid: 2 }),
      response({ taskUid: 3 }),
      response({ taskUid: 4 }),
      response({
        hits: [
          {
            id: "mail:1",
            type: "mail",
            title: "Hello",
            _rankingScore: 0.8,
            _formatted: { title: "<em>Hello</em>" },
          },
        ],
        query: "hello",
        estimatedTotalHits: 1,
        processingTimeMs: 4,
      }),
    ]);
    const client = createMeilisearchHttpClient({
      baseUrl: "http://127.0.0.1:7799",
      apiKey: "master",
      fetch: fetch.fetch,
    });

    await client.createIndex?.("helix_search", { primaryKey: "id" });
    await client.index("helix_search").updateSettings?.({
      filterableAttributes: ["type", "attributes.orgId"],
      searchableAttributes: ["title", "body"],
    });
    await client.index("helix_search").addDocuments([{ id: "mail:1", type: "mail", title: "Hello" }], {
      primaryKey: "id",
    });
    await client.index("helix_search").deleteDocuments(["mail:1"]);
    const result = await client.index("helix_search").search("hello", {
      limit: 5,
      filter: "type = mail",
      attributesToRetrieve: ["id", "title"],
    });

    expect(fetch.calls).toEqual([
      {
        url: "http://127.0.0.1:7799/indexes",
        method: "POST",
        authorization: "Bearer master",
        body: { uid: "helix_search", primaryKey: "id" },
      },
      {
        url: "http://127.0.0.1:7799/indexes/helix_search/settings",
        method: "PATCH",
        authorization: "Bearer master",
        body: {
          filterableAttributes: ["type", "attributes.orgId"],
          searchableAttributes: ["title", "body"],
        },
      },
      {
        url: "http://127.0.0.1:7799/indexes/helix_search/documents?primaryKey=id",
        method: "POST",
        authorization: "Bearer master",
        body: [{ id: "mail:1", type: "mail", title: "Hello" }],
      },
      {
        url: "http://127.0.0.1:7799/indexes/helix_search/documents/delete-batch",
        method: "POST",
        authorization: "Bearer master",
        body: ["mail:1"],
      },
      {
        url: "http://127.0.0.1:7799/indexes/helix_search/search",
        method: "POST",
        authorization: "Bearer master",
        body: {
          q: "hello",
          limit: 5,
          filter: "type = mail",
          attributesToRetrieve: ["id", "title"],
        },
      },
    ]);
    expect(result).toEqual({
      hits: [
        {
          id: "mail:1",
          type: "mail",
          title: "Hello",
          _rankingScore: 0.8,
          _formatted: { title: "<em>Hello</em>" },
        },
      ],
      query: "hello",
      estimatedTotalHits: 1,
      processingTimeMs: 4,
    });
  });

  it("treats index conflict as idempotent and throws other HTTP failures", async () => {
    const fetch = new FakeFetch([
      response({ message: "Index already exists" }, { status: 409, statusText: "Conflict" }),
      response({ message: "bad" }, { status: 500, statusText: "Internal Server Error" }),
    ]);
    const client = createMeilisearchHttpClient({
      baseUrl: "http://127.0.0.1:7799",
      fetch: fetch.fetch,
    });

    await expect(client.createIndex?.("helix_search")).resolves.toEqual({
      message: "Index already exists",
    });
    await expect(client.index("helix_search").deleteDocuments(["mail:1"])).rejects.toBeInstanceOf(
      MeilisearchHttpError,
    );
  });
});

function response(body: unknown, options?: { readonly status?: number; readonly statusText?: string }): Response {
  return new Response(JSON.stringify(body), {
    status: options?.status ?? 200,
    statusText: options?.statusText ?? "OK",
    headers: { "content-type": "application/json" },
  });
}

class FakeFetch {
  readonly calls: Array<{
    readonly url: string;
    readonly method: string;
    readonly authorization?: string | undefined;
    readonly body: unknown;
  }> = [];
  #responses: Response[];

  constructor(responses: Response[]) {
    this.#responses = [...responses];
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : "null";
    this.calls.push({
      url: requestUrl(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization") ?? undefined,
      body: JSON.parse(body) as unknown,
    });
    const next = this.#responses.shift();
    if (next === undefined) {
      throw new Error("Unexpected fetch call.");
    }
    return next;
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}
