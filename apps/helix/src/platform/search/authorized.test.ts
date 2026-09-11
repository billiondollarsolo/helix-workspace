import { describe, expect, it, vi } from "vitest";
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
          mail: { getMailSearchRecord: async () => null },
          drive: { getDriveSearchRecord: async () => null },
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
    expect(checked).toEqual([{ orgId: "org-1", actorId: "actor-1", contactId: "contact-1" }]);
  });

  it("never returns another mailbox's keyword/Bcc projection, even for the same message", async () => {
    const mail = { getMailSearchRecord: vi.fn(async () => ({})) };
    const source = new FakeEngine(
      ["sender", "recipient"].map((owner) => ({
        id: `mail:${owner}:message`,
        type: "mail",
        body: owner === "sender" ? "Bcc secret@example.test" : "launch",
        attributes: {
          orgId: "org",
          messageId: "message",
          ragVisibility: "private",
          ragOwnerActorId: owner,
        },
      })),
    );
    const engine = new AuthorizingSearchEngine({
      engine: source,
      authorize: (request, hit) =>
        authorizeWorkspaceSearchHit(
          {
            mail,
            drive: { getDriveSearchRecord: async () => null },
            chat: { getRoomForActor: async () => null },
            contacts: { getContactByIdForActor: async () => null },
          },
          request,
          hit,
        ),
    });
    const result = await engine.search({
      query: "secret",
      forActorId: "recipient",
      forOrgId: "org",
    });
    expect(result.hits.map((hit) => hit.id)).toEqual(["mail:recipient:message"]);
    expect(JSON.stringify(result)).not.toContain("secret@example.test");
    expect(mail.getMailSearchRecord).toHaveBeenCalledOnce();
    mail.getMailSearchRecord.mockResolvedValueOnce(null as never);
    expect(
      (await engine.search({ query: "launch", forActorId: "recipient", forOrgId: "org" })).hits,
    ).toEqual([]);
    expect(
      (await engine.search({ query: "launch", forActorId: "recipient", forOrgId: "foreign" })).hits,
    ).toEqual([]);
  });

  it("removes stale Drive keyword and semantic hits immediately when canonical access is revoked", async () => {
    const drive = {
      getDriveSearchRecord: vi.fn(async () => ({ orgId: "org", allowedActorIds: ["reader"] })),
    };
    const source = new FakeEngine(
      ["keyword", "semantic"].map((searchProvenance) => ({
        id: `drive:${searchProvenance}`,
        type: "drive",
        body: "private plan",
        attributes: { orgId: "org", fileId: "file", allowedActorIds: ["reader"], searchProvenance },
      })),
    );
    const engine = new AuthorizingSearchEngine({
      engine: source,
      authorize: (request, hit) =>
        authorizeWorkspaceSearchHit(
          {
            drive,
            mail: { getMailSearchRecord: async () => null },
            chat: { getRoomForActor: async () => null },
            contacts: { getContactByIdForActor: async () => null },
          },
          request,
          hit,
        ),
    });
    const request = { query: "plan", forOrgId: "org", forActorId: "reader" };
    expect((await engine.search(request)).hits).toHaveLength(2);
    drive.getDriveSearchRecord.mockResolvedValue({ orgId: "org", allowedActorIds: [] });
    expect((await engine.search(request)).hits).toEqual([]);
    drive.getDriveSearchRecord.mockResolvedValue({ orgId: "foreign", allowedActorIds: ["reader"] });
    expect((await engine.search(request)).hits).toEqual([]);
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
