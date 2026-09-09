import { describe, expect, it } from "vitest";
import { createCardDavSearchIndexer } from "./search-indexer.js";

describe("CardDAV search projection", () => {
  it("projects mutation events and removes deleted contacts", async () => {
    const indexer = createCardDavSearchIndexer();
    const payload = {
      orgId: "org-1",
      actorId: "actor-1",
      contactId: "contact-1",
      addressBookId: "book-1",
      ownerActorId: "owner-1",
      displayName: "Ada Lovelace",
      email: "ada@example.test",
    };
    const upsert = await indexer.route({
      subject: "activity.carddav.contact.updated",
      payload,
      occurredAt: new Date(0).toISOString(),
    });
    expect(upsert).toMatchObject({
      orgId: "org-1",
      upsert: [{ id: "contact:contact-1", type: "contact", title: "Ada Lovelace" }],
    });
    expect(
      await indexer.route({
        subject: "activity.carddav.contact.deleted",
        payload,
        occurredAt: new Date(0).toISOString(),
      }),
    ).toEqual({ orgId: "org-1", delete: ["contact:contact-1"] });
  });
});
