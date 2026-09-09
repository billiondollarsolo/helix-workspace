import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresMailStore } from "./store.js";
import type { StagedMailAttachment } from "./attachment-ingestion.js";
import type { MailAttachmentInput } from "./types.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const threadId = "22222222-2222-4222-8222-222222222222";
const messageId = "33333333-3333-4333-8333-333333333333";
const objectId = "44444444-4444-4444-8444-444444444444";
const outboundId = "55555555-5555-4555-8555-555555555555";
const outboxId = "66666666-6666-4666-8666-666666666666";
const mailboxActorIds = [
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
] as const;

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("PostgresMailStore attachment storage", () => {
  it("rejects ownerless mail before creating content", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresMailStore(recording.sql);

    await expect(
      store.insertInboundMessage({
        orgId,
        actorId: null,
        mailboxActorIds: [],
        from: { address: "sender@example.com" },
        to: [],
        subject: "Ownerless",
        bodyText: "Must not persist",
      }),
    ).rejects.toThrow("Mail requires at least one mailbox owner.");
    expect(recording.calls).toEqual([]);
  });

  it("attaches only the clean object returned by staged ingestion", async () => {
    const recording = createRecordingSql([
      [{ id: objectId, byte_size: 16, mime_type: "text/plain" }],
      [{ id: threadId }],
      [{ id: messageId }],
      [],
      [{ actor_id: mailboxActorIds[0] }],
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      attachmentIngestor: cleanAttachmentIngestor(),
    });

    await expect(
      store.insertInboundMessage({
        orgId,
        mailboxActorIds: [mailboxActorIds[0]],
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
      created: true,
      deliveredActorIds: [mailboxActorIds[0]],
    });

    expect(recording.calls.some((call) => call.text.includes("insert into objects"))).toBe(false);
    expect(
      recording.calls.find((call) => call.text.includes("message_attachments"))?.values,
    ).toContain(objectId);
  });

  it("fails closed when inline ingestion is not configured", async () => {
    const recording = createRecordingSql([]);
    const store = new PostgresMailStore(recording.sql);

    await expect(
      store.insertInboundMessage({
        orgId,
        mailboxActorIds: [mailboxActorIds[0]],
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
    ).rejects.toThrow("Mail attachment ingestion is unavailable");
    expect(recording.calls).toEqual([]);
  });

  it("creates one message and one independent mailbox row and event per local recipient", async () => {
    const recording = createRecordingSql([
      [{ id: threadId }],
      [{ id: messageId }],
      mailboxActorIds.map((actor_id) => ({ actor_id })),
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await store.insertInboundMessage({
      orgId,
      actorId: null,
      mailboxActorIds,
      from: { address: "sender@example.com" },
      to: [{ address: "to@example.com" }],
      cc: [{ address: "cc@example.com" }],
      bcc: [],
      subject: "One canonical copy",
      bodyText: "Shared body",
      metadata: { direction: "inbound" },
    });

    expect(
      recording.calls.filter((call) => call.text.includes("insert into messages")),
    ).toHaveLength(1);
    const mailboxInsert = recording.calls.find((call) =>
      call.text.includes("insert into mail_thread_state"),
    );
    expect(mailboxInsert?.text).toContain("from unnest");
    expect(mailboxInsert?.values).toContainEqual([...mailboxActorIds]);
    const activityInsert = recording.calls.find((call) => call.text.includes("insert into outbox"));
    expect(activityInsert?.text).toContain("from unnest");
    expect(activityInsert?.values).toContainEqual([...mailboxActorIds]);
  });

  it("preserves the MIME plain alternative with an HTML message", async () => {
    const recording = createRecordingSql([
      [{ id: threadId }],
      [{ id: messageId }],
      [{ actor_id: mailboxActorIds[0] }],
      [],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await store.insertInboundMessage({
      orgId,
      actorId: null,
      mailboxActorIds: [mailboxActorIds[0]],
      from: { address: "sender@example.com" },
      to: [{ address: "recipient@example.com" }],
      subject: "Multipart",
      bodyText: "Readable fallback",
      bodyHtml: "<strong>Readable fallback</strong>",
    });

    const messageInsert = recording.calls.find((call) =>
      call.text.includes("insert into messages"),
    );
    expect(messageInsert?.values).toContainEqual(
      expect.objectContaining({ plainBody: "Readable fallback" }),
    );
  });

  it("stages outbound bytes before the message transaction", async () => {
    const recording = createRecordingSql([
      [],
      [],
      [{ id: objectId, byte_size: 9, mime_type: "application/pdf" }],
      [{ id: threadId }],
      [{ id: messageId }],
      [],
      [],
      [],
      [],
      [{ id: outboxId }],
      [outboundRow()],
      [],
    ]);
    const store = new PostgresMailStore(recording.sql, {
      attachmentIngestor: cleanAttachmentIngestor(),
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

    expect(recording.calls.some((call) => call.text.includes("insert into objects"))).toBe(false);
    const outboundInsert = recording.calls.find((call) =>
      call.text.includes("insert into mail_outbound_messages"),
    );
    expect(outboundInsert?.values).toContainEqual(
      expect.objectContaining({
        attachments: [expect.objectContaining({ contentType: "application/pdf" })],
      }),
    );
  });

  it("rejects aggregate authoritative bytes before creating a message", async () => {
    const secondObjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const recording = createRecordingSql([
      [],
      [],
      [
        { id: objectId, byte_size: 13 * 1024 * 1024, mime_type: "application/octet-stream" },
        {
          id: secondObjectId,
          byte_size: 13 * 1024 * 1024,
          mime_type: "application/octet-stream",
        },
      ],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await expect(
      store.createOutbound({
        orgId,
        actorId: "actor-1",
        envelope: {
          from: { address: "sender@example.com" },
          to: [{ address: "recipient@example.com" }],
          cc: [],
          bcc: [],
          subject: "Too large",
          text: "Body",
          attachments: [
            { objectId, mimeType: "client/lie" },
            { objectId: secondObjectId, mimeType: "client/lie" },
          ],
        },
        undoUntil: new Date(),
        outboxSubject: "mail.outbound.send",
      }),
    ).rejects.toThrow("25 MiB message limit");
    expect(recording.calls.some((call) => call.text.includes("insert into threads"))).toBe(false);
    expect(recording.calls.find((call) => call.text.includes("from objects"))?.text).toContain(
      "metadata->>'status', 'ready'",
    );
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

function cleanAttachmentIngestor() {
  return {
    async stage(input: {
      readonly orgId: string;
      readonly ownerActorId?: string;
      readonly attachment: MailAttachmentInput & { readonly content: Buffer };
    }): Promise<StagedMailAttachment> {
      const { content: _content, ...attachment } = input.attachment;
      return {
        stageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        objectId,
        orgId: input.orgId,
        ...(input.ownerActorId === undefined ? {} : { ownerActorId: input.ownerActorId }),
        storageKey: `mail/attachments/stage/hash`,
        attachment: { ...attachment, objectId },
      };
    },
    async release() {},
  };
}
