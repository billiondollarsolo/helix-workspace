import { describe, expect, it } from "vitest";
import { QdrantVectorStore } from "./qdrant.js";

describe("Qdrant privacy and collection contracts", () => {
  it("uses protected payload fields and stable UUIDs for arbitrary source IDs", async () => {
    const bodies: Record<string, unknown>[] = [];
    const store = new QdrantVectorStore({
      baseUrl: "https://vectors.example.test",
      fetch: async (_url, init) => {
        bodies.push(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
        );
        return Response.json({ result: true });
      },
    });
    const id = "mail:actor:message";
    await store.upsert("org", "docs", [
      {
        id,
        vector: [1, 0],
        visibility: "private",
        ownerActorId: "owner",
        metadata: { _helixVisibility: "org", _helixOwner: "attacker" },
      },
    ]);
    const point = (bodies[0]?.points as { id: string; payload: unknown }[])[0];
    expect(point?.id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    expect(point?.payload).toEqual({
      _helixId: id,
      _helixVisibility: "private",
      _helixOwner: "owner",
      metadata: { _helixVisibility: "org", _helixOwner: "attacker" },
    });
    await store.delete("org", "docs", [id]);
    expect(bodies[1]?.points).toEqual([point?.id]);
    await expect(
      store.upsert("org", "docs", [{ id, vector: [1, 0], visibility: "private" }]),
    ).rejects.toThrow("ownerActorId");
    expect(bodies).toHaveLength(2);
  });

  it("requires org visibility or the matching private owner alongside every metadata filter", async () => {
    const bodies: unknown[] = [];
    const store = new QdrantVectorStore({
      baseUrl: "https://vectors.example.test",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown);
        return Response.json({ result: [] });
      },
    });
    await store.query("org", "docs", [1, 0], { actorId: "owner", filter: { kind: "mail" } });
    expect(bodies[0]).toMatchObject({
      filter: {
        must: [{ key: "metadata.kind", match: { value: "mail" } }],
        should: [
          { key: "_helixVisibility", match: { value: "org" } },
          {
            must: [
              { key: "_helixVisibility", match: { value: "private" } },
              { key: "_helixOwner", match: { value: "owner" } },
            ],
          },
        ],
      },
    });
    await store.query("org", "docs", [1, 0]);
    expect(bodies[1]).toMatchObject({
      filter: { should: [{ key: "_helixVisibility", match: { value: "org" } }] },
    });
  });

  it("accepts compatible existing collections and rejects dimension/metric drift", async () => {
    let requests = 0;
    const store = new QdrantVectorStore({
      baseUrl: "https://vectors.example.test",
      fetch: async () => {
        requests++;
        return Response.json({
          result: { config: { params: { vectors: { size: 3, distance: "Cosine" } } } },
        });
      },
    });
    await store.createCollection("org", "docs", 3, "cosine");
    await expect(store.createCollection("org", "docs", 4, "cosine")).rejects.toThrow(
      "do not match",
    );
    await expect(store.createCollection("org", "docs", 3, "dot")).rejects.toThrow("do not match");
    expect(requests).toBe(3);
  });

  it("treats deleting absent collections as idempotent but propagates service failures", async () => {
    let status = 404;
    const store = new QdrantVectorStore({
      baseUrl: "https://vectors.example.test",
      fetch: async () => new Response("", { status }),
    });
    await store.delete("org", "docs", ["absent"]);
    await store.deleteByDocumentIds("org", "docs", ["absent"]);
    status = 503;
    await expect(store.delete("org", "docs", ["absent"])).rejects.toThrow("HTTP 503");
    await expect(store.deleteByDocumentIds("org", "docs", ["absent"])).rejects.toThrow("HTTP 503");
  });

  it("removes every passage of only the requested tenant and document", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const store = new QdrantVectorStore({
      baseUrl: "https://vectors.example.test",
      fetch: async (url, init) => {
        const request = new Request(url, init);
        calls.push({ url: request.url, body: (await request.json()) as unknown });
        return Response.json({ result: true });
      },
    });
    await store.deleteByDocumentIds("tenant-a", "docs", []);
    await store.deleteByDocumentIds("tenant-a", "docs", ["drive:one", "drive:two"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/collections/org_tenant-a__docs/points/delete?wait=true");
    expect(calls[0]?.body).toEqual({
      filter: {
        should: [
          { key: "metadata.document.id", match: { any: ["drive:one", "drive:two"] } },
          { key: "_helixId", match: { any: ["drive:one", "drive:two"] } },
        ],
      },
    });
  });
});
