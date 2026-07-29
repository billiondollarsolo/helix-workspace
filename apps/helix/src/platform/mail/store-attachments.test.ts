import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { StorageObject } from "@helix/sdk-types";
import { PostgresMailStore } from "./store.js";
import type { TenantStorageClient } from "../storage/tenant-resolver.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const objectId = "44444444-4444-4444-8444-444444444444";
const outboundId = "55555555-5555-4555-8555-555555555555";
const outboxId = "66666666-6666-4666-8666-666666666666";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("PostgresMailStore attachment storage", () => {
  it("persists inbound attachment bytes through the tenant storage resolver", async () => {
    const storage = new RecordingStorageClient();
    const resolvedOrgIds: string[] = [];
    const recording = createRecordingSql([
      [{ id: threadId }],
      [{ id: messageId }],
      [{ id: objectId }],
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      storageResolver: async ({ orgId: resolvedOrgId }) => {
        resolvedOrgIds.push(resolvedOrgId);
        return {
          client: storage,
          managedBy: "helix-default",
          prefix: `tenants/${resolvedOrgId}/`,
        };
      },
    });

    await expect(
      store.insertInboundMessage({
        orgId,
        from: { address: "sender@example.com" },
        to: [{ address: "recipient@example.com" }],
        subject: "Attachment",
        bodyText: "See attached.",
        attachments: [
          {
            filename: "report.txt",
            mimeType: "text/plain",
            content: Buffer.from("hello attachment"),
            contentId: "cid-report",
            disposition: "attachment",
          },
        ],
      }),
    ).resolves.toEqual({
      threadId,
      messageId,
      attachmentObjectIds: [objectId],
    });

    expect(resolvedOrgIds).toEqual([orgId]);
    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]).toMatchObject({
      key: `mail/${messageId}/report.txt`,
      body: Buffer.from("hello attachment"),
      contentType: "text/plain",
      metadata: {
        objectId,
        messageId,
        sha256: "7fa36b95d5c98859ed72b4787f3c28b29eaa103970786755c9711cbb19be631c",
        filename: "report.txt",
        contentId: "cid-report",
        disposition: "attachment",
      },
    });
    const objectInsert = recording.calls.find((call) => call.text.includes("insert into objects"));
    expect(objectInsert?.values).toEqual(
      expect.arrayContaining([
        `mail/${messageId}/report.txt`,
        "text/plain",
        Buffer.from("hello attachment").byteLength,
      ]),
    );
  });

  it("keeps metadata-only attachment rows when no storage resolver is configured", async () => {
    const recording = createRecordingSql([
      [{ id: threadId }],
      [{ id: messageId }],
      [{ id: objectId }],
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await expect(
      store.insertInboundMessage({
        orgId,
        from: { address: "sender@example.com" },
        to: [{ address: "recipient@example.com" }],
        subject: "Attachment",
        bodyText: "See attached.",
        attachments: [
          {
            filename: "report.txt",
            mimeType: "text/plain",
            content: Buffer.from("hello attachment"),
          },
        ],
      }),
    ).resolves.toMatchObject({ attachmentObjectIds: [objectId] });
  });

  it("persists outbound attachment bytes through the tenant storage resolver", async () => {
    const storage = new RecordingStorageClient();
    const recording = createRecordingSql([
      [{ id: threadId }],
      [{ id: messageId }],
      [{ id: objectId }],
      [],
      [],
      [{ id: outboxId }],
      [outboundRow()],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      storageResolver: async () => ({
        client: storage,
        managedBy: "helix-default",
        prefix: `tenants/${orgId}/`,
      }),
    });

    await expect(
      store.createOutbound({
        orgId,
        actorId: "actor-1",
        envelope: {
          from: { address: "sender@example.com" },
          to: [{ address: "recipient@example.com" }],
          cc: [],
          bcc: [],
          subject: "Attachment",
          text: "See attached.",
          attachments: [
            {
              filename: "invoice.pdf",
              mimeType: "application/pdf",
              content: Buffer.from("pdf bytes"),
            },
          ],
        },
        undoUntil: new Date("2026-05-24T12:00:00.000Z"),
        outboxSubject: "mail.outbound.send",
      }),
    ).resolves.toMatchObject({
      id: outboundId,
      messageId,
      threadId,
    });

    expect(storage.puts).toHaveLength(1);
    expect(storage.puts[0]?.key).toBe(`mail/${messageId}/invoice.pdf`);
    expect(storage.puts[0]?.contentType).toBe("application/pdf");
    expect(storage.puts[0]?.body).toEqual(Buffer.from("pdf bytes"));
  });
});

describe("PostgresMailStore mailbox visibility", () => {
  it("authorizes every mailbox read by message ownership or inbound recipient", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresMailStore(recording.sql);
    const actorId = "77777777-7777-4777-8777-777777777777";

    await store.search({ orgId, actorId });
    await store.getThread({ orgId, actorId, threadId });
    await store.listThreads({ orgId, actorId });
    await store.listFolders({ orgId, actorId });

    const mailboxReadQueries = recording.calls.filter(
      (call) =>
        (call.text.includes("join threads t") || call.text.includes("from threads t")) &&
        call.text.includes("visible_message"),
    );
    expect(mailboxReadQueries).toHaveLength(5);
    for (const query of mailboxReadQueries) {
      expect(query.text).toContain("visible_message.actor_id = ?");
      expect(query.text).toContain("join mail_inbound_deliveries visible_delivery");
      expect(query.text).toContain("join mail_inbound_recipients visible_recipient");
      expect(query.text).toContain("visible_recipient.actor_id = ?");
      expect(query.values).toContain(actorId);
      expect(query.values).toContain(orgId);
    }
  });
});

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

function outboundRow(): Record<string, unknown> {
  return {
    id: outboundId,
    org_id: orgId,
    actor_id: "actor-1",
    message_id: messageId,
    thread_id: threadId,
    outbox_id: outboxId,
    status: "queued",
    envelope: {
      from: { address: "sender@example.com" },
      to: [{ address: "recipient@example.com" }],
      cc: [],
      bcc: [],
      subject: "Attachment",
      text: "See attached.",
      attachments: [],
    },
    undo_until: new Date("2026-05-24T12:00:00.000Z"),
    sent_at: null,
    cancelled_at: null,
    failed_at: null,
    last_error: null,
    provider_message_id: null,
    delivery_metadata: {},
    created_at: new Date("2026-05-24T12:00:00.000Z"),
    updated_at: new Date("2026-05-24T12:00:00.000Z"),
  };
}

class RecordingStorageClient implements TenantStorageClient {
  readonly puts: StorageObject[] = [];

  async put(object: StorageObject): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<StorageObject | null> {
    throw new Error("Not implemented for mail attachment tests.");
  }

  async delete(): Promise<void> {
    throw new Error("Not implemented for mail attachment tests.");
  }
}
