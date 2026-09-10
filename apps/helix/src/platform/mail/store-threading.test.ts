import type { StorageObject } from "@helix/sdk-types";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";
import { prepareMailRawSource } from "./raw-source.js";
import { PostgresMailStore } from "./store.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const secondActorId = "33333333-3333-4333-8333-333333333333";
const existingThreadId = "44444444-4444-4444-8444-444444444444";
const existingMessageId = "55555555-5555-4555-8555-555555555555";
const insertedMessageId = "66666666-6666-4666-8666-666666666666";
const sourceObjectId = "77777777-7777-4777-8777-777777777777";

describe("PostgresMailStore RFC threading and idempotency", () => {
  it("joins the nearest actor-visible referenced thread deterministically", async () => {
    const source = await rawSource("<reply@EXAMPLE.NET>", "Reply body");
    const storage = new RecordingStorage();
    const recording = recordingSql([
      [],
      [],
      [{ thread_id: existingThreadId }],
      [{ id: existingThreadId }],
      [{ id: insertedMessageId }],
      [{ id: sourceObjectId }],
      [],
      [{ actor_id: actorId }],
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      storageResolver: async () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    const result = await store.insertInboundMessage({
      orgId,
      actorId: null,
      mailboxActorIds: [actorId],
      messageId: "<reply@EXAMPLE.NET>",
      inReplyTo: "<parent@EXAMPLE.NET>",
      references: ["<root@example.net>", "<previous@EXAMPLE.NET>"],
      from: { address: "sender@example.net" },
      to: [{ address: "alice@example.com" }],
      subject: "Re: plan",
      bodyText: "Reply body",
      rawSource: source,
    });

    expect(result).toMatchObject({
      threadId: existingThreadId,
      messageId: insertedMessageId,
      created: true,
      deliveredActorIds: [actorId],
    });
    const referenceLookup = recording.calls.find((call) => call.text.includes("array_position"));
    expect(referenceLookup?.text).toContain("mailbox.actor_id");
    expect(referenceLookup?.values).toEqual(
      expect.arrayContaining([
        ["<parent@example.net>", "<previous@example.net>", "<root@example.net>"],
        [actorId],
      ]),
    );
    expect(recording.calls.some((call) => call.text.includes("insert into threads"))).toBe(false);
    expect(recording.calls.some((call) => call.text.includes("update threads"))).toBe(true);
  });

  it("returns an exact redelivery without storage, canonical rows, or side effects", async () => {
    const source = await rawSource("<same@example.net>", "Same");
    let storageResolutions = 0;
    const recording = recordingSql([[], [identityRow({ raw_sha256: source.sha256 })], []]);
    const store = new PostgresMailStore(recording.sql, {
      storageResolver: async () => {
        storageResolutions += 1;
        return { client: new RecordingStorage(), managedBy: "helix-default", prefix: "" };
      },
    });

    const result = await store.insertInboundMessage({
      orgId,
      mailboxActorIds: [actorId],
      messageId: "<same@example.net>",
      from: { address: "sender@example.net" },
      to: [{ address: "alice@example.com" }],
      subject: "Same",
      bodyText: "Same",
      rawSource: source,
    });

    expect(result).toEqual({
      threadId: existingThreadId,
      messageId: existingMessageId,
      attachmentObjectIds: [sourceObjectId],
      created: false,
      deliveredActorIds: [],
    });
    expect(storageResolutions).toBe(0);
    expect(recording.calls).toHaveLength(3);
    expect(recording.calls.some((call) => call.text.includes("insert into messages"))).toBe(false);
    expect(recording.calls.some((call) => call.text.includes("insert into outbox"))).toBe(false);
  });

  it("delivers a canonical retry once to a newly added local recipient", async () => {
    const source = await rawSource("<shared@example.net>", "Shared");
    const recording = recordingSql([
      [],
      [identityRow({ raw_sha256: source.sha256 })],
      [{ actor_id: secondActorId }],
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql);

    const result = await store.insertInboundMessage({
      orgId,
      mailboxActorIds: [actorId, secondActorId],
      messageId: "<shared@example.net>",
      from: { address: "sender@example.net" },
      to: [{ address: "alice@example.com" }],
      subject: "Shared",
      bodyText: "Shared",
      rawSource: source,
    });

    expect(result).toMatchObject({ created: false, deliveredActorIds: [secondActorId] });
    const event = recording.calls.find((call) => call.text.includes("insert into outbox"));
    expect(event?.values).toContainEqual([secondActorId]);
  });

  it("fails closed when Message-ID collides with different raw content", async () => {
    const source = await rawSource("<collision@example.net>", "Changed content");
    const recording = recordingSql([[], [identityRow({ raw_sha256: "a".repeat(64) })]]);
    const store = new PostgresMailStore(recording.sql);

    await expect(
      store.insertInboundMessage({
        orgId,
        mailboxActorIds: [actorId],
        messageId: "<collision@example.net>",
        from: { address: "attacker@example.net" },
        to: [{ address: "alice@example.com" }],
        subject: "Collision",
        bodyText: "Changed content",
        rawSource: source,
      }),
    ).rejects.toThrow("Inbound mail identity collision");
    expect(recording.calls).toHaveLength(2);
  });

  it("uses a trusted provider delivery ID when a provider reserializes the raw message", async () => {
    const source = await rawSource("<provider@example.net>", "Reserialized");
    const recording = recordingSql([
      [],
      [
        identityRow({
          raw_sha256: "b".repeat(64),
          provider_delivery_id: "provider-event-7",
        }),
      ],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await expect(
      store.insertInboundMessage({
        orgId,
        mailboxActorIds: [actorId],
        messageId: "<provider@example.net>",
        providerDeliveryId: "provider-event-7",
        from: { address: "sender@example.net" },
        to: [{ address: "alice@example.com" }],
        subject: "Provider retry",
        bodyText: "Reserialized",
        rawSource: source,
      }),
    ).resolves.toMatchObject({ created: false, deliveredActorIds: [] });
  });
});

async function rawSource(messageId: string, body: string) {
  const raw = Buffer.from(
    `From: sender@example.net\r\nTo: alice@example.com\r\nMessage-ID: ${messageId}\r\n\r\n${body}\r\n`,
  );
  return prepareMailRawSource(raw, await simpleParser(raw));
}

function identityRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    message_id: existingMessageId,
    thread_id: existingThreadId,
    raw_sha256: null,
    provider_delivery_id: null,
    attachment_object_ids: [sourceObjectId],
    ...overrides,
  };
}

class RecordingStorage implements TenantStorageClient {
  readonly puts: StorageObject[] = [];

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<StorageObject | null> {
    return null;
  }

  async delete(): Promise<void> {}
}
const recordingSql = (responses: readonly unknown[] = []) => sharedRecordingSql(responses, "?");
