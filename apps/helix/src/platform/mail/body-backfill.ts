import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { compactMailMutation } from "../search/durable.js";
import type { SearchIndexMutation } from "../search/types.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { toSqlJson } from "../util/sql.js";
import { linkMailBody, releaseMailBody, stageMailBody } from "./body-storage.js";
import { mailPreviewText } from "./store-thread-projection.js";

interface InlineBody {
  readonly id: string;
  readonly body: string;
  readonly body_format: string;
  readonly metadata: JsonObject;
  readonly retained: boolean;
}

/** Operator-only, resumable conversion. Existing evidence snapshots are never rewritten. */
export async function backfillMailBodies(
  sql: postgres.Sql,
  resolver: TenantStorageResolver,
  orgId: string,
) {
  const result = {
    migrated: 0,
    retained: 0,
    raced: 0,
    inlineBytesRemoved: 0,
    mutationsCompacted: 0,
    vectorsCompacted: 0,
  };
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await sql<InlineBody[]>`
      select m.id, m.body, m.body_format, m.metadata,
        (exists (select 1 from mail_journal_entries j where j.org_id = m.org_id and j.message_id = m.id)
         or exists (select 1 from governance_review_items r where r.org_id = m.org_id and r.item_key = 'mail:message:' || m.id::text || ':current')
         or exists (select 1 from governance_legal_holds h where h.org_id = m.org_id and h.released_at is null)) as retained
      from messages m where m.org_id = ${orgId} and m.kind = 'mail' and m.id > ${after}
        and m.metadata->>'bodyStorage' is distinct from 'object-v1'
      order by m.id limit 1
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.id;
      if (row.retained) {
        result.retained += 1;
        continue;
      }
      const text =
        row.body_format === "html" && typeof row.metadata.plainBody === "string"
          ? row.metadata.plainBody
          : row.body_format === "html"
            ? ""
            : row.body;
      const html = row.body_format === "html" ? row.body : undefined;
      const stage = await stageMailBody(sql, resolver, orgId, {
        text,
        ...(html === undefined ? {} : { html }),
      });
      if (stage === undefined) throw new Error("Mail body storage is not configured.");
      try {
        const migrated = await sql.begin("isolation level serializable", async (tx) => {
          await tx`set local role helix_migration_owner`;
          await tx`select set_config('helix.mail_body_backfill', 'on', true)`;
          const current = await tx<
            InlineBody[]
          >`select id, body, body_format, metadata from messages
            where org_id = ${orgId} and id = ${row.id} for update`;
          const message = current[0];
          if (message === undefined || message.metadata.bodyStorage === "object-v1") return false;
          if (message.body !== row.body || message.metadata.plainBody !== row.metadata.plainBody)
            throw new Error("Mail content changed during migration.");
          // A hold or review can have been created while the body was uploading.
          const retained =
            await tx`select 1 from governance_legal_holds where org_id = ${orgId} and released_at is null
            union all select 1 from mail_journal_entries where org_id = ${orgId} and message_id = ${row.id}
            union all select 1 from governance_review_items where org_id = ${orgId} and item_key = 'mail:message:' || ${row.id}::text || ':current' limit 1`;
          if (retained.length > 0) return false;
          const queues = await tx<
            { envelope: JsonObject }[]
          >`select envelope from mail_outbound_messages
            where org_id = ${orgId} and message_id = ${row.id} for update`;
          if (
            queues.some(
              (queue) =>
                queue.envelope.bodyStorage !== "object-v1" &&
                (queue.envelope.text !== text || queue.envelope.html !== html),
            )
          ) {
            throw new Error(
              "Outbound content differs from canonical mail; refusing to discard either copy.",
            );
          }
          await linkMailBody(tx, row.id, stage);
          const preview = mailPreviewText({
            body: row.body,
            bodyFormat: row.body_format,
            plainBody: row.metadata.plainBody,
          });
          await tx`update messages set body = '', metadata = (metadata - 'plainBody') || ${tx.json({ bodyStorage: "object-v1", preview })}
            where org_id = ${orgId} and id = ${row.id}`;
          await tx`update mail_outbound_messages set envelope = (envelope - 'html') || ${tx.json({ text: "", bodyStorage: "object-v1" })}
            where org_id = ${orgId} and message_id = ${row.id}`;
          // Canonical text can replace indexed HTML; refresh keyword and vector passages together.
          await tx`select helix_enqueue_search_index_mutation(
            ${orgId}, 'mail.body-backfill',
            jsonb_build_object('reloadMail', jsonb_agg(jsonb_build_object(
              'orgId', ${orgId}::text, 'actorId', mailbox.actor_id::text, 'messageId', ${row.id}::text
            ))), statement_timestamp()
          ) from mail_thread_state mailbox
          join messages message on message.org_id = mailbox.org_id and message.thread_id = mailbox.thread_id
          where message.org_id = ${orgId} and message.id = ${row.id} and message.deleted_at is null
            and (message.actor_id = mailbox.actor_id or exists (
              select 1 from mail_message_deliveries delivery
              where delivery.org_id = message.org_id and delivery.message_id = message.id
                and delivery.actor_id = mailbox.actor_id
            ))
          having count(*) > 0`;
          return true;
        });
        if (migrated) {
          result.migrated += 1;
          result.inlineBytesRemoved +=
            Buffer.byteLength(row.body) +
            Buffer.byteLength(
              typeof row.metadata.plainBody === "string" ? row.metadata.plainBody : "",
            );
        } else {
          result.raced += 1;
          await releaseMailBody(sql, stage);
        }
      } catch (error) {
        await releaseMailBody(sql, stage).catch(() => undefined);
        throw error;
      }
    }
  }
  let mutationAfter = "0";
  for (;;) {
    const rows = await sql<{ id: string; mutation: SearchIndexMutation }[]>`
      select id::text, mutation from search_index_mutations where org_id = ${orgId} and id > ${mutationAfter}::bigint order by id limit 1
    `;
    if (rows.length === 0) break;
    for (const row of rows) {
      mutationAfter = row.id;
      if (!row.mutation.upsert?.some((doc) => doc.type === "mail")) continue;
      await sql`update search_index_mutations set mutation = ${sql.json(toSqlJson(compactMailMutation(row.mutation)))}
        where org_id = ${orgId} and id = ${row.id}::bigint`;
      result.mutationsCompacted += 1;
    }
  }
  const vectors = await sql`
    update vector_items v set metadata = (v.metadata #- '{document,body}') #- '{document,attributes,metadata,plainBody}'
    where v.org_id = ${orgId} and v.metadata->'document'->>'type' = 'mail'
      and ((v.metadata->'document') ? 'body' or (v.metadata->'document'->'attributes'->'metadata') ? 'plainBody')
      and exists (select 1 from mail_message_bodies b where b.org_id = v.org_id
        and b.message_id::text = v.metadata->'document'->'attributes'->>'messageId')
  `;
  result.vectorsCompacted = vectors.count;
  return result;
}
