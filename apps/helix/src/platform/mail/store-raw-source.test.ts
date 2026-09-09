import type postgres from "postgres";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import type { StorageObject } from "@helix/sdk-types";
import { MailRawSourceIntegrityError } from "./errors.js";
import { prepareMailRawSource } from "./raw-source.js";
import { PostgresMailStore } from "./store.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const raw = Buffer.from(
  "From: ada@example.net\r\nTo: alice@example.com\r\nSubject: Exact\r\n\r\nBody\r\n",
);

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("PostgresMailStore raw source", () => {
  it("stores one canonical content-addressed RFC822 object", async () => {
    const source = prepareMailRawSource(raw, await simpleParser(raw));
    const storage = new RecordingStorage();
    const recording = createRecordingSql([
      [],
      [],
      [{ id: threadId }],
      [{ id: messageId }],
      [{ id: objectId }],
      [],
      [{ actor_id: actorId }],
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      storageResolver: async () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    await store.insertInboundMessage({
      orgId,
      actorId: null,
      mailboxActorIds: [actorId],
      from: { address: "ada@example.net" },
      to: [{ address: "alice@example.com" }],
      subject: "Exact",
      bodyText: "Body",
      metadata: { direction: "inbound" },
      rawSource: source,
    });

    const expectedKey = `mail/sources/${messageId}/${source.sha256}.eml`;
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]).toMatchObject({
      key: expectedKey,
      body: raw,
      contentType: "message/rfc822",
      metadata: {
        objectId,
        messageId,
        sha256: source.sha256,
        parser: source.parser,
        projectionVersion: "1",
        projectionSha256: source.projectionSha256,
      },
    });
    expect(
      recording.calls.filter((call) => call.text.includes("insert into mail_raw_sources")),
    ).toHaveLength(1);
    const sourceObject = recording.calls.find(
      (call) => call.text.includes("insert into objects") && call.text.includes("'mail_source'"),
    );
    expect(sourceObject?.text).toContain("'message/rfc822'");
    expect(sourceObject?.values).toEqual(
      expect.arrayContaining([expectedKey, raw.byteLength, source.sha256]),
    );
  });

  it("reads only an actor-owned source and verifies bytes before returning it", async () => {
    const source = prepareMailRawSource(raw, await simpleParser(raw));
    const storageKey = `mail/sources/${messageId}/${source.sha256}.eml`;
    const storage = new RecordingStorage();
    storage.objects.set(storageKey, { key: storageKey, body: raw });
    const recording = createRecordingSql([
      [
        {
          message_id: messageId,
          parser: source.parser,
          projection_version: source.projectionVersion,
          projection: source.projection,
          projection_sha256: source.projectionSha256,
          storage_key: storageKey,
          byte_size: source.byteSize,
          sha256: source.sha256,
        },
      ],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      storageResolver: async () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    const result = await store.readRawSource({ orgId, actorId, messageId });

    expect(result?.bytes).toEqual(raw);
    expect(recording.calls[0]?.text).toContain("join mail_message_deliveries mailbox");
    expect(recording.calls[0]?.values).toEqual(expect.arrayContaining([actorId, orgId, messageId]));
  });

  it("fails closed when stored bytes have been changed", async () => {
    const source = prepareMailRawSource(raw, await simpleParser(raw));
    const storageKey = `mail/sources/${messageId}/${source.sha256}.eml`;
    const tampered = Buffer.from(raw);
    tampered[tampered.byteLength - 4] = 88;
    const storage = new RecordingStorage();
    storage.objects.set(storageKey, { key: storageKey, body: tampered });
    const recording = createRecordingSql([
      [
        {
          message_id: messageId,
          parser: source.parser,
          projection_version: source.projectionVersion,
          projection: source.projection,
          projection_sha256: source.projectionSha256,
          storage_key: storageKey,
          byte_size: source.byteSize,
          sha256: source.sha256,
        },
      ],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      storageResolver: async () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    await expect(store.readRawSource({ orgId, actorId, messageId })).rejects.toBeInstanceOf(
      MailRawSourceIntegrityError,
    );
  });

  it("does not resolve storage when the actor has no mailbox row", async () => {
    let storageResolutions = 0;
    const store = new PostgresMailStore(createRecordingSql([[]]).sql, {
      storageResolver: async () => {
        storageResolutions += 1;
        return { client: new RecordingStorage(), managedBy: "helix-default", prefix: "" };
      },
    });

    await expect(store.readRawSource({ orgId, actorId, messageId })).resolves.toBeNull();
    expect(storageResolutions).toBe(0);
  });
});

class RecordingStorage implements TenantStorageClient {
  readonly puts: StorageObject[] = [];
  readonly objects = new Map<string, StorageObject>();

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
    this.objects.set(object.key, object);
  }

  async get(key: string): Promise<StorageObject | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    array: (value: unknown) => value,
    begin: async (callback: (tx: postgres.TransactionSql) => Promise<unknown>) =>
      callback(sql as unknown as postgres.TransactionSql),
  }) as unknown as postgres.Sql;
  return { sql, calls };
}
