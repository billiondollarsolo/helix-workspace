import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { toSqlJson } from "../util/sql.js";
import type { ParsedMailSearchQuery } from "./store-search-query.js";
import type { MailDraftRecord, MailThreadListResult, MailThreadRowRecord } from "./types.js";

interface DraftEnvelope {
  readonly subject?: string;
  readonly text?: string;
  readonly bodyText?: string;
  readonly html?: string;
  readonly to?: readonly { readonly address?: string; readonly name?: string }[];
  readonly cc?: readonly { readonly address?: string; readonly name?: string }[];
  readonly attachments?: readonly unknown[];
}

type DraftFolderRow = MailThreadRowRecord & { readonly recipientsText: string };

/** Drafts and undo-window sends list their recipients as the participants. */
function draftFolderRow(input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly envelope: DraftEnvelope;
  readonly time: Date;
  readonly from: string;
  readonly messageCount: number;
}): DraftFolderRow {
  const recipients = [...(input.envelope.to ?? []), ...(input.envelope.cc ?? [])];
  const participants = recipients
    .filter((recipient) => typeof recipient.address === "string")
    .slice(0, 4)
    .map((recipient) => ({
      name: recipient.name ?? recipient.address?.split("@")[0] ?? "",
      email: recipient.address ?? "",
      isMe: false,
    }));
  return {
    threadId: input.threadId,
    messageId: input.messageId,
    subject: input.envelope.subject ?? "(no subject)",
    from: input.from,
    fromEmail: participants[0]?.email ?? "",
    preview: (input.envelope.text ?? input.envelope.html ?? "").slice(0, 240),
    time: input.time.toISOString(),
    unread: false,
    starred: false,
    hasAttachment: (input.envelope.attachments?.length ?? 0) > 0,
    messageCount: input.messageCount,
    labels: [],
    category: "primary",
    folder: "drafts",
    snoozedUntil: null,
    participants,
    recipientsText: recipients
      .map((recipient) => `${recipient.name ?? ""} ${recipient.address ?? ""}`)
      .join(" ")
      .toLowerCase(),
  };
}

function draftMatchesQuery(row: DraftFolderRow, query: ParsedMailSearchQuery): boolean {
  const text = `${row.subject} ${row.preview}`.toLowerCase();
  return (
    query.terms.every((term) => text.includes(term.toLowerCase())) &&
    query.from.every((term) => term.toLowerCase() === "me") &&
    query.subject.every((term) => row.subject.toLowerCase().includes(term.toLowerCase())) &&
    query.to.every((term) => row.recipientsText.includes(term.toLowerCase())) &&
    query.labels.length === 0 &&
    (query.hasAttachment === undefined || row.hasAttachment === query.hasAttachment)
  );
}

interface MailDraftRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly thread_id: string | null;
  readonly envelope: JsonObject;
  readonly revision: string | number;
  readonly expires_at: Date;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapDraft(row: MailDraftRow): MailDraftRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    threadId: row.thread_id,
    envelope: row.envelope,
    revision: Number(row.revision),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MailDraftConflictError extends Error {
  constructor() {
    super("This draft changed elsewhere. Reload it before saving again.");
    this.name = "MailDraftConflictError";
  }
}
export class MailDraftStore {
  constructor(private readonly sql: postgres.Sql) {}

  async saveDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id?: string;
    readonly threadId?: string | null;
    readonly envelope: JsonObject;
    readonly expectedRevision?: number;
    readonly idempotencyKey: string;
    readonly attachmentObjectIds: readonly string[];
  }): Promise<MailDraftRecord> {
    return this.sql.begin(async (tx) => {
      const replay = await tx<MailDraftRow[]>`
        select * from mail_drafts
        where org_id = ${input.orgId} and actor_id = ${input.actorId}
          and idempotency_key = ${input.idempotencyKey}
        limit 1
      `;
      if (replay[0] !== undefined) return mapDraft(replay[0]);

      if (input.attachmentObjectIds.length > 0) {
        const authorized = await tx<{ readonly id: string }[]>`
          select object.id from objects object
          where object.org_id = ${input.orgId}
            and object.id = any(${tx.array([...input.attachmentObjectIds])}::uuid[])
            and object.owner_actor_id = ${input.actorId}
            and object.deleted_at is null
            and coalesce(object.metadata->>'status', 'ready') = 'ready'
        `;
        if (authorized.length !== new Set(input.attachmentObjectIds).size) {
          throw new Error("A draft attachment is unavailable or inaccessible.");
        }
      }

      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000);
      let row: MailDraftRow | undefined;
      if (input.id !== undefined && input.expectedRevision !== undefined) {
        const updated = await tx<MailDraftRow[]>`
          update mail_drafts set
            thread_id = ${input.threadId ?? null}, envelope = ${tx.json(toSqlJson(input.envelope))},
            attachment_object_ids = ${tx.array([...input.attachmentObjectIds])}::uuid[],
            revision = revision + 1, idempotency_key = ${input.idempotencyKey},
            expires_at = ${expiresAt}, updated_at = now()
          where id = ${input.id} and org_id = ${input.orgId} and actor_id = ${input.actorId}
            and revision = ${input.expectedRevision}
          returning *
        `;
        row = updated[0];
        if (row === undefined) throw new MailDraftConflictError();
      } else {
        const inserted = await tx<MailDraftRow[]>`
          insert into mail_drafts (
            org_id, actor_id, thread_id, envelope, attachment_object_ids, idempotency_key, expires_at
          ) values (
            ${input.orgId}, ${input.actorId}, ${input.threadId ?? null},
            ${tx.json(toSqlJson(input.envelope))},
            ${tx.array([...input.attachmentObjectIds])}::uuid[], ${input.idempotencyKey}, ${expiresAt}
          ) returning *
        `;
        row = inserted[0];
        if (row === undefined) throw new Error("Failed to save mail draft.");
      }

      if (input.attachmentObjectIds.length > 0) {
        await tx`
          update mail_attachment_ingestions set expires_at = greatest(expires_at, ${expiresAt}),
            updated_at = now()
          where org_id = ${input.orgId} and owner_actor_id = ${input.actorId}
            and object_id = any(${tx.array([...input.attachmentObjectIds])}::uuid[])
            and status = 'clean' and cleaned_at is null
        `;
      }
      return mapDraft(row);
    });
  }

  async getDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<MailDraftRecord | null> {
    const rows = await this.sql<MailDraftRow[]>`
      select * from mail_drafts
      where id = ${input.id}
        and org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      limit 1
    `;
    return rows[0] === undefined ? null : mapDraft(rows[0]);
  }

  async listDrafts(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly MailDraftRecord[]> {
    const rows = await this.sql<MailDraftRow[]>`
      select * from mail_drafts
      where org_id = ${input.orgId}
        and actor_id = ${input.actorId}
      order by updated_at desc
    `;
    return rows.map(mapDraft);
  }

  /**
   * Drafts folder projection: first-class `mail_drafts` rows plus queued
   * outbound (undo-send window). Pure message-backed SQL cannot see drafts
   * that were never sent.
   */
  async listDraftFolderThreads(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query: ParsedMailSearchQuery;
    readonly limit: number;
    readonly offset: number;
  }): Promise<MailThreadListResult> {
    const drafts = await this.listDrafts({
      orgId: input.orgId,
      actorId: input.actorId,
    });
    const draftRows: DraftFolderRow[] = drafts.map((draft) => {
      const envelope = draft.envelope as DraftEnvelope;
      return draftFolderRow({
        threadId: draft.threadId ?? draft.id,
        messageId: draft.id,
        envelope:
          typeof envelope.bodyText === "string"
            ? { ...envelope, text: envelope.bodyText }
            : envelope,
        time: draft.updatedAt,
        from: "Draft",
        messageCount: 0,
      });
    });

    // Undo-window sends stay under Drafts until delivered or cancelled;
    // scheduled sends list in the Scheduled view instead.
    const queuedRows = await this.sql<
      {
        readonly thread_id: string;
        readonly message_id: string;
        readonly envelope: DraftEnvelope;
        readonly updated_at: Date;
      }[]
    >`
      select
        coalesce(ob.thread_id, ob.id) as thread_id,
        coalesce(ob.message_id, ob.id) as message_id,
        ob.envelope || case when ob.envelope->>'bodyStorage' = 'object-v1'
          then jsonb_build_object('text', message.metadata->>'preview') else '{}'::jsonb end as envelope,
        ob.updated_at
      from mail_outbound_messages ob
      join messages message on message.org_id = ob.org_id and message.id = ob.message_id
      where ob.org_id = ${input.orgId}
        and ob.actor_id = ${input.actorId}
        and ob.status = 'queued'
        and ob.scheduled_for is null
      order by ob.updated_at desc
    `;
    const outboundRows = queuedRows.map((row) =>
      draftFolderRow({
        threadId: row.thread_id,
        messageId: row.message_id,
        envelope: row.envelope,
        time: row.updated_at,
        from: "Outbox",
        messageCount: 1,
      }),
    );

    const merged = [...draftRows, ...outboundRows]
      .filter((row) => draftMatchesQuery(row, input.query))
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

    const total = merged.length;
    const threads = merged
      .slice(input.offset, input.offset + input.limit)
      .map(({ recipientsText: _recipients, ...row }) => row);
    return { threads, total, limit: input.limit, offset: input.offset };
  }

  async discardDraft(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly expectedRevision?: number;
  }): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      delete from mail_drafts
      where id = ${input.id}
        and org_id = ${input.orgId}
        and actor_id = ${input.actorId}
        and (${input.expectedRevision ?? null}::integer is null or revision = ${input.expectedRevision ?? null})
      returning id
    `;
    return rows[0] !== undefined;
  }
}
