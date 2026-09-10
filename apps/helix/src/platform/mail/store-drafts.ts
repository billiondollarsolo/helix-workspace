import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { toSqlJson } from "../util/sql.js";
import type { MailDraftRecord, MailThreadListResult, MailThreadRowRecord } from "./types.js";

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
    readonly query: string;
    readonly from?: string;
    readonly labels: readonly string[];
    readonly hasAttachment?: boolean;
    readonly limit: number;
    readonly offset: number;
  }): Promise<MailThreadListResult> {
    const drafts = await this.listDrafts({
      orgId: input.orgId,
      actorId: input.actorId,
    });
    const draftRows: MailThreadRowRecord[] = drafts.map((draft) => {
      const envelope = draft.envelope as {
        readonly subject?: string;
        readonly text?: string;
        readonly html?: string;
        readonly to?: readonly { readonly address?: string; readonly name?: string }[];
        readonly attachments?: readonly unknown[];
      };
      const to = envelope.to?.[0];
      const subject = envelope.subject ?? "(no subject)";
      const preview = (envelope.text ?? envelope.html ?? "").slice(0, 240);
      return {
        threadId: draft.threadId ?? draft.id,
        messageId: draft.id,
        subject,
        from: "Draft",
        fromEmail: to?.address ?? "",
        preview,
        time: draft.updatedAt.toISOString(),
        unread: false,
        starred: false,
        hasAttachment: (envelope.attachments?.length ?? 0) > 0,
        messageCount: 0,
        labels: [],
        category: "primary",
        folder: "drafts",
        snoozedUntil: null,
      };
    });

    // Queued outbound still appears under Drafts until delivered/cancelled.
    const queuedRows = await this.sql<
      {
        readonly thread_id: string;
        readonly message_id: string;
        readonly subject: string;
        readonly from_email: string;
        readonly body: string;
        readonly has_attachment: boolean;
        readonly sent_at: Date;
      }[]
    >`
      select
        coalesce(ob.thread_id, ob.id) as thread_id,
        coalesce(ob.message_id, ob.id) as message_id,
        coalesce(ob.envelope->>'subject', '(no subject)') as subject,
        coalesce(ob.envelope->'to'->0->>'address', '') as from_email,
        coalesce(ob.envelope->>'text', '') as body,
        jsonb_array_length(coalesce(ob.envelope->'attachments', '[]'::jsonb)) > 0 as has_attachment,
        ob.updated_at as sent_at
      from mail_outbound_messages ob
      where ob.org_id = ${input.orgId}
        and ob.actor_id = ${input.actorId}
        and ob.status = 'queued'
      order by ob.updated_at desc
    `;

    const outboundRows: MailThreadRowRecord[] = queuedRows.map((row) => ({
      threadId: row.thread_id,
      messageId: row.message_id,
      subject: row.subject,
      from: "Outbox",
      fromEmail: row.from_email,
      preview: row.body.slice(0, 240),
      time: row.sent_at.toISOString(),
      unread: false,
      starred: false,
      hasAttachment: row.has_attachment,
      messageCount: 1,
      labels: [],
      category: "primary",
      folder: "drafts",
      snoozedUntil: null,
    }));

    const q = input.query.trim().toLowerCase();
    const merged = [...draftRows, ...outboundRows]
      .filter((row) => {
        const matchesText =
          q.length === 0 ||
          row.subject.toLowerCase().includes(q) ||
          row.preview.toLowerCase().includes(q);
        const matchesFrom =
          input.from === undefined ||
          row.fromEmail.toLowerCase().includes(input.from.toLowerCase());
        const matchesLabels = input.labels.every((label) => row.labels.includes(label));
        const matchesAttachment =
          input.hasAttachment === undefined || row.hasAttachment === input.hasAttachment;
        return matchesText && matchesFrom && matchesLabels && matchesAttachment;
      })
      .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));

    const total = merged.length;
    const threads = merged.slice(input.offset, input.offset + input.limit);
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
