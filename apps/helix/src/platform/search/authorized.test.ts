import { describe, expect, it } from "vitest";
import {
  AuthorizingSearchEngine,
  authorizeChatSearchHit,
  authorizeWorkspaceSearchHit,
} from "./authorized.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "./types.js";

describe("AuthorizingSearchEngine", () => {
  it("drops stale unauthorized hits at the final result boundary", async () => {
    const source = new FakeEngine([
      { id: "chat:stale", type: "chat", attributes: { roomId: "revoked" } },
      { id: "chat:allowed", type: "chat", attributes: { roomId: "current" } },
      { id: "mail:mine", type: "mail" },
    ]);
    const engine = new AuthorizingSearchEngine({
      engine: source,
      authorize: (_request, hit) => hit.attributes?.roomId !== "revoked",
    });

    await expect(
      engine.search({ query: "launch", limit: 2, forActorId: "actor-1" }),
    ).resolves.toEqual(
      expect.objectContaining({
        hits: [
          expect.objectContaining({ id: "chat:allowed" }),
          expect.objectContaining({ id: "mail:mine" }),
        ],
      }),
    );
    expect(source.requests[0]?.limit).toBe(6);
  });

  it("rechecks Chat room access instead of trusting projected principals", async () => {
    const checked: unknown[] = [];
    const store = {
      getRoomForActor: async (input: unknown) => {
        checked.push(input);
        return null;
      },
    };
    await expect(
      authorizeChatSearchHit(
        store,
        { query: "secret", forActorId: "actor-1" },
        {
          id: "chat:1",
          type: "chat",
          attributes: { orgId: "org-1", roomId: "room-1", allowedActorIds: ["actor-1"] },
        },
      ),
    ).resolves.toBe(false);
    expect(checked).toEqual([{ orgId: "org-1", actorId: "actor-1", roomId: "room-1" }]);
  });

  it("rechecks contact address-book access instead of trusting the projection", async () => {
    const checked: unknown[] = [];
    await expect(
      authorizeWorkspaceSearchHit(
        {
          chat: { getRoomForActor: async () => null },
          contacts: {
            getContactByIdForActor: async (input) => {
              checked.push(input);
              return null;
            },
          },
        },
        { query: "private", forActorId: "actor-1" },
        {
          id: "contact:1",
          type: "contact",
          attributes: { orgId: "org-1", contactId: "contact-1", ownerActorId: "actor-1" },
        },
      ),
    ).resolves.toBe(false);
    expect(checked).toEqual([
      { orgId: "org-1", actorId: "actor-1", contactId: "contact-1" },
    ]);
  });
});

class FakeEngine implements SearchEngine {
  readonly id = "fake";
  readonly requests: SearchRequest[] = [];

  constructor(private readonly hits: readonly IndexDocument[]) {}

  async index(): Promise<void> {}
  async upsert(): Promise<void> {}
  async delete(): Promise<void> {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    this.requests.push(request);
    return { query: request.query, hits: this.hits };
  }
}
