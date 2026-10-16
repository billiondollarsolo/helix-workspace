import { readMailBody } from "../body-storage.js";
import type { TenantStorageResolver } from "../../storage/tenant-resolver.js";
import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import type { DataClassification } from "../../ai/classification/types.js";
import { isDataClassification } from "../../ai/classification/effective.js";
import type { TenantEnvelopeCipher } from "../../secrets/envelope.js";
import { isRecord } from "../../util/json.js";
import { toSqlJson } from "../../util/sql.js";
import { classifyMailCategory, type MailCategoryTab } from "../category.js";
import { headerHasListUnsubscribe } from "../store-message-write.js";
import type { DecisionModelProviderId } from "./config.js";
import type { DecisionAction } from "./evidence.js";
import type { DecisionCandidate, TriageSummary } from "./triage.js";

const CREDENTIAL_PURPOSE = "mail-decision-model";

/** Everything the worker needs about one stored message, loaded in one RLS-scoped query. */
export interface LoadedDecisionCandidate {
  readonly candidate: DecisionCandidate;
  /** Arrived from outside (SMTP or provider ingest), not local delivery or a sent copy. */
  readonly external: boolean;
  readonly alreadyRecorded: boolean;
  readonly providerCallsToday: number;
  readonly explicitClassification?: DataClassification | undefined;
  readonly labels: readonly string[];
  /** The category the ingest heuristic chose; only that may be replaced. */
  readonly heuristicCategory: MailCategoryTab;
  readonly senderDomain: string | null;
}

export interface DecisionVerdictWrite {
  readonly orgId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly provider: DecisionModelProviderId;
  readonly model: string;
  readonly mode: "shadow" | "enforce";
  readonly configVersion: string;
  readonly outcome: "decided" | "skipped" | "error";
  readonly reason?: string | undefined;
  readonly summary?: TriageSummary | undefined;
  readonly actionTaken?: DecisionAction | undefined;
  readonly spamAssassin: DecisionCandidate["spamAssassin"];
  readonly senderDomain: string | null;
  readonly latencyMs?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
}

interface CandidateRow {
  readonly id: string;
  readonly thread_id: string;
  readonly actor_id: string | null;
  readonly subject: string | null;
  readonly body: string;
  readonly body_format: string;
  readonly metadata: JsonObject;
  readonly sent_at: Date;
  readonly attachments: readonly { readonly filename: string; readonly mimeType: string }[];
  readonly labels: readonly string[];
  readonly recorded: boolean;
  readonly provider_calls_today: number;
}

/**
 * Persistence for the decision-model feature. Every method runs on the
 * tenant-aware client, so callers wrap it in the org's RLS context.
 */
export class PostgresMailDecisionStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly cipher: Pick<TenantEnvelopeCipher, "seal" | "open">,
    private readonly storageResolver?: TenantStorageResolver,
  ) {}

  async credentialStatus(
    orgId: string,
  ): Promise<{ readonly provider: DecisionModelProviderId; readonly updatedAt: Date } | null> {
    const rows = await this.sql<{ provider: DecisionModelProviderId; updated_at: Date }[]>`
      select provider, updated_at from mail_decision_model_credentials where org_id = ${orgId}
    `;
    const row = rows[0];
    return row === undefined ? null : { provider: row.provider, updatedAt: row.updated_at };
  }

  async readCredential(orgId: string, provider: DecisionModelProviderId): Promise<string | null> {
    const rows = await this.sql<{ secret_ciphertext: string }[]>`
      select secret_ciphertext from mail_decision_model_credentials
      where org_id = ${orgId} and provider = ${provider}
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : this.cipher.open(orgId, CREDENTIAL_PURPOSE, row.secret_ciphertext);
  }

  async saveCredential(input: {
    readonly orgId: string;
    readonly provider: DecisionModelProviderId;
    readonly credential: string;
    readonly actorId: string;
  }): Promise<void> {
    const ciphertext = this.cipher.seal(input.orgId, CREDENTIAL_PURPOSE, input.credential);
    await this.sql`
      insert into mail_decision_model_credentials (org_id, provider, secret_ciphertext, updated_by_actor_id)
      values (${input.orgId}, ${input.provider}, ${ciphertext}, ${input.actorId})
      on conflict (org_id) do update set
        provider = excluded.provider,
        secret_ciphertext = excluded.secret_ciphertext,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = statement_timestamp()
    `;
  }

  async clearCredential(orgId: string): Promise<boolean> {
    const rows = await this.sql`
      delete from mail_decision_model_credentials where org_id = ${orgId} returning org_id
    `;
    return rows.length > 0;
  }

  async loadCandidate(input: {
    readonly orgId: string;
    readonly messageId: string;
  }): Promise<LoadedDecisionCandidate | null> {
    const rows = await this.sql<CandidateRow[]>`
      select
        m.id, m.thread_id, m.actor_id, t.subject, m.body, m.body_format, m.metadata, m.sent_at,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'filename', coalesce(o.metadata->>'filename', 'attachment'),
            'mimeType', o.mime_type
          ) order by o.created_at, o.id)
          from message_attachments ma join objects o on o.id = ma.object_id
          where ma.org_id = m.org_id and ma.message_id = m.id
        ), '[]'::jsonb) as attachments,
        coalesce((
          select array_agg(distinct label order by label)
          from mail_thread_state mts
          join mail_message_deliveries d
            on d.org_id = mts.org_id and d.actor_id = mts.actor_id and d.message_id = m.id
          cross join lateral unnest(mts.labels) as label
          where mts.org_id = m.org_id and mts.thread_id = m.thread_id
        ), '{}'::text[]) as labels,
        exists (
          select 1 from mail_decision_verdicts v where v.org_id = m.org_id and v.message_id = m.id
        ) as recorded,
        (
          select count(*) from mail_decision_verdicts v
          where v.org_id = m.org_id and v.outcome in ('decided', 'error')
            and v.created_at >= date_trunc('day', statement_timestamp(), 'UTC')
        )::int as provider_calls_today
      from messages m
      join threads t on t.id = m.thread_id and t.org_id = m.org_id
      where m.org_id = ${input.orgId} and m.id = ${input.messageId}
        and m.kind = 'mail' and m.deleted_at is null
    `;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.metadata.bodyStorage !== "object-v1") return mapCandidate(input.orgId, row);
    const content = await readMailBody(
      this.sql,
      this.storageResolver,
      input.orgId,
      input.messageId,
    );
    return mapCandidate(input.orgId, {
      ...row,
      body: content.html ?? content.text,
      metadata: { ...row.metadata, plainBody: content.text },
    });
  }

  /** Reserve the message before network I/O; caller holds the tenant transaction. */
  async claimProviderCall(
    input: Omit<DecisionVerdictWrite, "outcome">,
    cap: number,
  ): Promise<"claimed" | "daily_cap" | "already_recorded"> {
    await this
      .sql`select pg_advisory_xact_lock(hashtextextended(${"mail-decision:" + input.orgId}, 0))`;
    const existing = await this
      .sql`select id from mail_decision_verdicts where org_id = ${input.orgId} and message_id = ${input.messageId}`;
    if (existing.length > 0) return "already_recorded";
    const usage = await this.sql<
      { count: number }[]
    >`select count(*)::int as count from mail_decision_verdicts where org_id = ${input.orgId} and outcome in ('decided', 'error') and created_at >= date_trunc('day', statement_timestamp(), 'UTC')`;
    if ((usage[0]?.count ?? 0) >= cap) return "daily_cap";
    // A crashed call remains accounted for and never replays paid inference automatically.
    await this.recordVerdict({
      ...input,
      outcome: "error",
      reason: "provider_pending_or_interrupted",
    });
    return "claimed";
  }

  /** Insert the one verdict for a message; false when another worker already recorded it. */
  async recordVerdict(input: DecisionVerdictWrite): Promise<boolean> {
    const summary = input.summary;
    const rows = await this.sql`
      insert into mail_decision_verdicts (
        org_id, message_id, thread_id, provider, model, mode, config_version, outcome, reason,
        verdict, verdict_confidence, verdict_probabilities,
        category, category_confidence, category_probabilities,
        needs_reply_probability, urgency, urgency_confidence, urgency_probabilities,
        spamassassin_score, spamassassin_is_spam, sender_domain,
        proposed_action, action_taken, latency_ms, input_tokens, output_tokens
      ) values (
        ${input.orgId}, ${input.messageId}, ${input.threadId}, ${input.provider},
        ${input.model.slice(0, 200)}, ${input.mode}, ${input.configVersion}, ${input.outcome},
        ${input.reason?.slice(0, 200) ?? null},
        ${summary?.verdict ?? null}, ${summary?.verdictConfidence ?? null},
        ${this.sql.json(toSqlJson(summary?.verdictProbabilities ?? {}))},
        ${summary?.category ?? null}, ${summary?.categoryConfidence ?? null},
        ${this.sql.json(toSqlJson(summary?.categoryProbabilities ?? {}))},
        ${summary?.needsReplyProbability ?? null}, ${summary?.urgency ?? null},
        ${summary?.urgencyConfidence ?? null},
        ${this.sql.json(toSqlJson(summary?.urgencyProbabilities ?? {}))},
        ${input.spamAssassin?.score ?? null}, ${input.spamAssassin?.isSpam ?? null},
        ${input.senderDomain}, ${summary?.proposedAction ?? "none"}, ${input.actionTaken ?? "none"},
        ${input.latencyMs ?? null}, ${input.inputTokens ?? null}, ${input.outputTokens ?? null}
      )
      on conflict (org_id, message_id) do update set
        model = excluded.model, outcome = excluded.outcome, reason = excluded.reason,
        verdict = excluded.verdict, verdict_confidence = excluded.verdict_confidence,
        verdict_probabilities = excluded.verdict_probabilities,
        category = excluded.category, category_confidence = excluded.category_confidence,
        category_probabilities = excluded.category_probabilities,
        needs_reply_probability = excluded.needs_reply_probability,
        urgency = excluded.urgency, urgency_confidence = excluded.urgency_confidence,
        urgency_probabilities = excluded.urgency_probabilities,
        proposed_action = excluded.proposed_action, action_taken = excluded.action_taken,
        latency_ms = excluded.latency_ms, input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens
      where mail_decision_verdicts.reason = 'provider_pending_or_interrupted'
        and excluded.reason is distinct from 'provider_pending_or_interrupted'
      returning id
    `;
    return rows.length > 0;
  }

  async setActionTaken(input: {
    readonly orgId: string;
    readonly messageId: string;
    readonly action: DecisionAction;
  }): Promise<void> {
    await this.sql`
      update mail_decision_verdicts set action_taken = ${input.action}
      where org_id = ${input.orgId} and message_id = ${input.messageId} and outcome = 'decided'
    `;
  }

  /** Summary for the thread view (`messages.metadata.decision`). */
  async writeEvidence(orgId: string, messageId: string, evidence: JsonObject): Promise<void> {
    await this.sql`
      update messages
      set metadata = jsonb_set(metadata, '{decision}', ${this.sql.json(toSqlJson(evidence))}::jsonb, true),
        updated_at = now()
      where org_id = ${orgId} and id = ${messageId} and kind = 'mail'
    `;
  }

  /**
   * File the thread into Spam for every recipient exactly as ingest does
   * (`spam_at`), except mailboxes already in Spam or whose owner said "Not spam"
   * for this thread. Returns the mailboxes that changed.
   */
  async markSpam(input: {
    readonly orgId: string;
    readonly messageId: string;
    readonly threadId: string;
    readonly evidence: JsonObject;
  }): Promise<readonly string[]> {
    const rows = await this.sql<{ actor_id: string }[]>`
      update mail_thread_state mts
      set spam_at = statement_timestamp(), updated_at = now()
      where mts.org_id = ${input.orgId} and mts.thread_id = ${input.threadId}
        and mts.spam_at is null and mts.deleted_at is null
        and exists (
          select 1 from mail_message_deliveries d
          where d.org_id = mts.org_id and d.actor_id = mts.actor_id and d.message_id = ${input.messageId}
        )
        and not exists (
          select 1 from mail_spam_feedback f
          where f.org_id = mts.org_id and f.actor_id = mts.actor_id and f.thread_id = mts.thread_id
            and f.source = 'user' and f.label = 'ham'
        )
      returning mts.actor_id
    `;
    const actorIds = rows.map((row) => row.actor_id);
    if (actorIds.length > 0) {
      await this.sql`
        insert into mail_spam_feedback (org_id, actor_id, thread_id, message_id, label, source, evidence)
        select ${input.orgId}, actor_id, ${input.threadId}, ${input.messageId}, 'spam',
          'auto_decision_model', ${this.sql.json(toSqlJson(input.evidence))}
        from unnest(${this.sql.array(actorIds)}::uuid[]) as actor_id
      `;
    }
    return actorIds;
  }

  /** Re-tab recipients whose category still holds the ingest heuristic's choice. */
  async applyCategory(input: {
    readonly orgId: string;
    readonly messageId: string;
    readonly threadId: string;
    readonly category: MailCategoryTab;
    readonly heuristicCategory: MailCategoryTab;
  }): Promise<readonly string[]> {
    if (input.category === input.heuristicCategory) return [];
    const rows = await this.sql<{ actor_id: string }[]>`
      update mail_thread_state mts
      set category = ${input.category}::mail_category_tab, updated_at = now()
      where mts.org_id = ${input.orgId} and mts.thread_id = ${input.threadId}
        and mts.category = ${input.heuristicCategory}::mail_category_tab
        and exists (
          select 1 from mail_message_deliveries d
          where d.org_id = mts.org_id and d.actor_id = mts.actor_id and d.message_id = ${input.messageId}
        )
      returning mts.actor_id
    `;
    return rows.map((row) => row.actor_id);
  }

  /** `activity.mail.updated` per changed mailbox: open inboxes refresh, search reindexes. */
  async publishMailboxUpdates(input: {
    readonly orgId: string;
    readonly messageId: string;
    readonly threadId: string;
    readonly actorIds: readonly string[];
    readonly action: DecisionAction;
  }): Promise<void> {
    if (input.actorIds.length === 0) return;
    await this.sql`
      insert into outbox (subject, payload)
      select 'activity.mail.updated', jsonb_build_object(
        'orgId', ${input.orgId}::text,
        'actorId', actor_id::text,
        'threadId', ${input.threadId}::text,
        'messageId', ${input.messageId}::text,
        'reason', 'decision-model',
        'action', ${input.action}::text
      )
      from unnest(${this.sql.array([...input.actorIds])}::uuid[]) as actor_id
    `;
  }

  /** Threads auto-filed into Spam in the window, for the Spam filtering status card. */
  async countAutoSpamSince(orgId: string, since: Date): Promise<number> {
    const rows = await this.sql<{ count: number }[]>`
      select count(distinct thread_id)::int as count from mail_spam_feedback
      where org_id = ${orgId} and label = 'spam' and source <> 'user' and created_at >= ${since}
    `;
    return rows[0]?.count ?? 0;
  }
}

function mapCandidate(orgId: string, row: CandidateRow): LoadedDecisionCandidate {
  const metadata = row.metadata;
  const from = isRecord(metadata.from) ? metadata.from : {};
  const fromAddress = typeof from.address === "string" ? from.address : "";
  const fromName = typeof from.name === "string" && from.name.length > 0 ? from.name : undefined;
  const subject = typeof metadata.subject === "string" ? metadata.subject : (row.subject ?? "");
  const auth = isRecord(metadata.auth) ? metadata.auth : undefined;
  const spam = isRecord(metadata.spam) ? metadata.spam : undefined;
  const headers: Record<string, string> = {};
  if (isRecord(metadata.headers)) {
    for (const [key, value] of Object.entries(metadata.headers)) {
      if (typeof value === "string") headers[key.toLowerCase()] = value;
    }
  }
  const domain = fromAddress.includes("@") ? fromAddress.split("@").at(-1) : undefined;
  const candidate: DecisionCandidate = {
    orgId,
    messageId: row.id,
    threadId: row.thread_id,
    subject,
    fromAddress,
    ...(fromName === undefined ? {} : { fromName }),
    replyTo: addresses(metadata.replyTo),
    toCount: Array.isArray(metadata.to) ? metadata.to.length : 0,
    ccCount: Array.isArray(metadata.cc) ? metadata.cc.length : 0,
    sentAt: row.sent_at,
    headers,
    auth:
      auth === undefined
        ? null
        : { spf: text(auth.spf), dkim: text(auth.dkim), dmarc: text(auth.dmarc) },
    spamAssassin:
      spam !== undefined && typeof spam.score === "number"
        ? {
            score: spam.score,
            isSpam: spam.isSpam === true,
            symbols: Array.isArray(spam.symbols)
              ? spam.symbols.filter((symbol): symbol is string => typeof symbol === "string")
              : [],
          }
        : null,
    body: row.body,
    bodyFormat: row.body_format === "html" ? "html" : "plain",
    ...(typeof metadata.plainBody === "string" ? { plainBody: metadata.plainBody } : {}),
    attachments: row.attachments,
  };
  return {
    candidate,
    external: metadata.direction === "inbound" && row.actor_id === null && auth !== undefined,
    alreadyRecorded: row.recorded,
    providerCallsToday: row.provider_calls_today,
    ...(isDataClassification(metadata.classification)
      ? { explicitClassification: metadata.classification }
      : {}),
    labels: row.labels,
    heuristicCategory: classifyMailCategory({
      fromAddress,
      ...(fromName === undefined ? {} : { fromName }),
      subject,
      hasListUnsubscribe: headerHasListUnsubscribe(metadata),
    }),
    senderDomain: domain === undefined || domain.length === 0 ? null : domain.toLowerCase(),
  };
}

function addresses(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry: unknown) =>
      isRecord(entry) && typeof entry.address === "string" ? entry.address : undefined,
    )
    .filter((entry): entry is string => entry !== undefined);
}

function text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "none";
}
