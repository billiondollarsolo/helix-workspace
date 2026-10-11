/* What a saved Assistant answer carries for its reader beyond its text: the
 * workspace records it cited and the reader's own thumbs up/down.
 *
 * Citations are persisted as references only (kind, record id and the title
 * shown when the answer was written). Every read re-checks the reader's access
 * to each record, so a citation disappears, title included, once the reader
 * can no longer open the record. */

import type { Actor, JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { z } from "zod";
import { allowedSearchTypesForActor, type GlobalSearchType } from "../search/scope.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { projectAssistantMessages } from "./attachments.js";
import type {
  AssistantCitation,
  AssistantCitationAccess,
  AssistantCitationRef,
  AssistantFeedbackStore,
  AssistantMessage,
  AssistantMessageAnnotations,
  AssistantMessageFeedback,
  AssistantSetFeedbackInput,
  AssistantSource,
  AssistantStore,
} from "./types.js";

type AssistantFeedbackRating = AssistantMessageFeedback["rating"];

const citationKinds = ["mail", "chat", "drive", "calendar"] as const;
const citationRefSchema = z
  .object({
    kind: z.enum(citationKinds),
    id: z.string().uuid(),
    title: z.string().max(200).nullable(),
  })
  .strict();

/** The record id each search type's hit carries, keyed by its attribute name. */
const citationIdAttribute: Record<GlobalSearchType, string> = {
  mail: "messageId",
  chat: "messageId",
  drive: "fileId",
  calendar: "eventId",
};

/** The citable record behind a workspace search hit, if any. */
export function citationForSearchHit(hit: {
  readonly type: string;
  readonly attributes?: JsonObject | undefined;
}): AssistantSource["citation"] {
  const kind = citationKinds.find((candidate) => candidate === hit.type);
  if (kind === undefined) return undefined;
  const id = hit.attributes?.[citationIdAttribute[kind]];
  return typeof id === "string" && z.string().uuid().safeParse(id).success
    ? { kind, id }
    : undefined;
}

/**
 * What an answer persists about its sources: retrieved workspace records
 * become references, and only the remaining (web and attachment) sources keep
 * their projection, without bodies or media.
 */
export function assistantSourceMetadata(sources: readonly AssistantSource[]): {
  readonly sources: readonly Omit<AssistantSource, "body" | "media">[];
  readonly citations: readonly AssistantCitationRef[];
} {
  const citations = new Map<string, AssistantCitationRef>();
  const kept: Omit<AssistantSource, "body" | "media">[] = [];
  for (const { body: _body, media: _media, ...source } of sources) {
    if (source.citation === undefined) {
      kept.push(source);
      continue;
    }
    const key = `${source.citation.kind}:${source.citation.id}`;
    if (!citations.has(key))
      citations.set(key, { ...source.citation, title: source.title?.slice(0, 200) ?? null });
  }
  return { sources: kept, citations: [...citations.values()] };
}

/** A conversation's saved messages as its owner reads them now. */
export async function readerMessages(
  actor: Actor,
  conversationId: string,
  options: {
    readonly store: AssistantStore;
    readonly annotations?: AssistantMessageAnnotations | undefined;
  },
): Promise<readonly AssistantMessage[]> {
  const messages = await options.store.listMessages({
    orgId: actor.orgId,
    conversationId,
    limit: 100,
  });
  return withReaderAnnotations(actor, projectAssistantMessages(messages), options.annotations);
}

/**
 * Adds the reader's view to saved messages: cited records they can open now
 * and their own feedback. Raw citation references never leave the server.
 */
export async function withReaderAnnotations(
  actor: Actor,
  messages: readonly AssistantMessage[],
  annotations: AssistantMessageAnnotations | undefined,
): Promise<readonly AssistantMessage[]> {
  const answers = messages.filter((message) => message.role === "assistant");
  const [citations, feedback] = await Promise.all([
    readableCitations(actor, answers, annotations?.citationAccess),
    annotations?.feedback === undefined || answers.length === 0
      ? new Map<string, AssistantMessageFeedback>()
      : annotations.feedback.listFeedback({
          actor,
          messageIds: answers.map((message) => message.id),
        }),
  ]);
  return messages.map((message) => {
    const { citations: _references, ...metadata } = message.metadata;
    const cited = citations.get(message.id);
    const rated = feedback.get(message.id);
    return {
      ...message,
      metadata,
      ...(cited === undefined || cited.length === 0 ? {} : { citations: cited }),
      ...(rated === undefined ? {} : { feedback: rated }),
    };
  });
}

async function readableCitations(
  actor: Actor,
  answers: readonly AssistantMessage[],
  access: AssistantCitationAccess | undefined,
): Promise<ReadonlyMap<string, readonly AssistantCitation[]>> {
  const result = new Map<string, readonly AssistantCitation[]>();
  if (access === undefined) return result;
  const readableKinds = new Set<string>(allowedSearchTypesForActor(actor));
  const checks = new Map<string, Promise<{ readonly path: string } | null>>();
  const check = (ref: AssistantCitationRef) => {
    const key = `${ref.kind}:${ref.id}`;
    let pending = checks.get(key);
    if (pending === undefined) {
      pending = readableKinds.has(ref.kind)
        ? access(actor, ref).catch(() => null)
        : Promise.resolve(null);
      checks.set(key, pending);
    }
    return pending;
  };
  await Promise.all(
    answers.map(async (message) => {
      const refs = citationRefs(message.metadata.citations);
      const readable = await Promise.all(
        refs.map(async (ref) => {
          const found = await check(ref);
          return found === null ? null : { ...ref, path: found.path };
        }),
      );
      result.set(
        message.id,
        readable.filter((citation) => citation !== null),
      );
    }),
  );
  return result;
}

function citationRefs(value: unknown): readonly AssistantCitationRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = citationRefSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

interface FeedbackRow {
  readonly message_id: string;
  readonly rating: AssistantFeedbackRating;
  readonly comment: string | null;
  readonly updated_at: Date;
}

/** Feedback rows scoped to the tenant and to the conversation owner. */
export class PostgresAssistantFeedbackStore implements AssistantFeedbackStore {
  constructor(private readonly sql: postgres.Sql) {}

  setFeedback(
    input: AssistantSetFeedbackInput,
  ): Promise<{ readonly feedback: AssistantMessageFeedback | null } | null> {
    const { actor } = input;
    return withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const owned = await tx`
          select message.id
          from assistant_messages message
          join assistant_conversations conversation
            on conversation.id = message.conversation_id
           and conversation.org_id = message.org_id
          where message.org_id = ${actor.orgId}
            and message.id = ${input.messageId}
            and message.conversation_id = ${input.conversationId}
            and message.role = 'assistant'
            and conversation.actor_id = ${actor.id}
            and conversation.archived_at is null
          for update of message
        `;
        if (owned.length === 0) return null;
        const comment = input.comment?.trim() || null;
        let feedback: AssistantMessageFeedback | null = null;
        if (input.rating === null) {
          await tx`
            delete from assistant_message_feedback
            where org_id = ${actor.orgId} and message_id = ${input.messageId}
              and actor_id = ${actor.id}
          `;
        } else {
          const rows = await tx<FeedbackRow[]>`
            insert into assistant_message_feedback (org_id, message_id, actor_id, rating, comment)
            values (${actor.orgId}, ${input.messageId}, ${actor.id}, ${input.rating}, ${comment})
            on conflict (message_id, actor_id) do update
              set rating = excluded.rating, comment = excluded.comment, updated_at = now()
            returning message_id, rating, comment, updated_at
          `;
          feedback = rows[0] === undefined ? null : mapFeedback(rows[0]);
        }
        // The comment text stays out of the activity log; it records the rating only.
        const verb =
          input.rating === null
            ? "assistant.message.feedback.cleared"
            : "assistant.message.feedback";
        const payload = {
          conversationId: input.conversationId,
          rating: input.rating,
          hasComment: comment !== null,
        };
        await tx`
          insert into activity (org_id, actor_id, verb, object_type, object_id, payload)
          values (${actor.orgId}, ${actor.id}, ${verb}, 'assistant_message', ${input.messageId},
            ${tx.json(payload)})
        `;
        return { feedback };
      },
    );
  }

  async listFeedback(input: {
    readonly actor: Actor;
    readonly messageIds: readonly string[];
  }): Promise<ReadonlyMap<string, AssistantMessageFeedback>> {
    const { actor } = input;
    const rows = await withTenantPostgresContext(
      this.sql,
      { orgId: actor.orgId, actorId: actor.id },
      (tx) => tx<FeedbackRow[]>`
        select message_id, rating, comment, updated_at
        from assistant_message_feedback
        where org_id = ${actor.orgId} and actor_id = ${actor.id}
          and message_id = any(${tx.array([...input.messageIds])}::uuid[])
      `,
    );
    return new Map(rows.map((row) => [row.message_id, mapFeedback(row)]));
  }
}

function mapFeedback(row: FeedbackRow): AssistantMessageFeedback {
  return { rating: row.rating, comment: row.comment, updatedAt: row.updated_at.toISOString() };
}
