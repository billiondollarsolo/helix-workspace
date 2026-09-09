import { describe, expect, it, vi } from "vitest";
import { createMailSearchIndexer } from "./indexer.js";
import type { MailSearchProjectionStore, MailSearchRecord } from "../types.js";

const messageId = "message-1";
const actorA = "actor-a";
const actorB = "actor-b";

describe("mail search mailbox copies", () => {
  it("indexes one private document id per mailbox for the same canonical message", async () => {
    const store: MailSearchProjectionStore = {
      getMailSearchRecord: vi.fn(async ({ actorId }) => record(actorId)),
    };
    const indexer = createMailSearchIndexer(store);

    const [forA, forB] = await Promise.all(
      [actorA, actorB].map((actorId) =>
        indexer.route({
          subject: "activity.mail.received",
          payload: { orgId: "org-1", actorId, messageId },
          occurredAt: "2026-09-02T00:00:00.000Z",
        }),
      ),
    );

    expect(forA?.upsert?.[0]).toMatchObject({
      id: `mail:${actorA}:${messageId}`,
      attributes: { ragVisibility: "private", ragOwnerActorId: actorA },
    });
    expect(forB?.upsert?.[0]).toMatchObject({
      id: `mail:${actorB}:${messageId}`,
      attributes: { ragVisibility: "private", ragOwnerActorId: actorB },
    });
  });

  it("deletes only the event actor's mailbox document", async () => {
    const indexer = createMailSearchIndexer({ getMailSearchRecord: vi.fn() });

    await expect(
      indexer.route({
        subject: "activity.mail.deleted",
        payload: { orgId: "org-1", actorId: actorB, messageId },
        occurredAt: "2026-09-02T00:00:00.000Z",
      }),
    ).resolves.toEqual({ delete: [`mail:${actorB}:${messageId}`] });
  });
});

function record(ownerActorId: string): MailSearchRecord {
  return {
    id: messageId,
    orgId: "org-1",
    threadId: "thread-1",
    subject: "Shared delivery",
    body: "one canonical body",
    from: { address: "sender@example.net" },
    to: [{ address: "to@example.test" }],
    cc: [{ address: "cc@example.test" }],
    bcc: [],
    direction: "inbound",
    sentAt: "2026-09-02T00:00:00.000Z",
    ownerActorId,
  };
}
