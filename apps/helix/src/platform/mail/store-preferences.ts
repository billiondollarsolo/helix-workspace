import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { toSqlJson } from "../util/sql.js";
import { normalizeAddress } from "./store-addresses.js";
import {
  type CreateMailFilterInput,
  type MailJournalSettings,
  type SetMailVacationInput,
  type UpdateMailFilterInput,
} from "./store-contracts.js";
import type {
  MailFilterActions,
  MailFilterCriteria,
  MailFilterRecord,
  MailUserSettings,
  MailVacationRecord,
} from "./types.js";

interface MailFilterRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly criteria: MailFilterCriteria;
  readonly actions: MailFilterActions;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MailVacationRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly enabled: boolean;
  readonly subject: string;
  readonly body: string;
  readonly starts_at: Date | null;
  readonly ends_at: Date | null;
  readonly metadata: JsonObject;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MailUserSettingsRow {
  readonly signature_text: string;
  readonly signature_html: string | null;
  readonly include_signature_on_replies: boolean;
  readonly blocked_senders: string[];
  readonly updated_at: Date;
}

interface MailJournalSettingsRow {
  readonly enabled: boolean;
  readonly retention_days: number;
  readonly updated_at: Date;
}

function mapFilter(row: MailFilterRow | undefined): MailFilterRecord {
  if (row === undefined) {
    throw new Error("Expected mail filter row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    criteria: row.criteria,
    actions: row.actions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVacation(row: MailVacationRow): MailVacationRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    enabled: row.enabled,
    subject: row.subject,
    body: row.body,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapUserSettings(row: MailUserSettingsRow): MailUserSettings {
  return {
    signatureText: row.signature_text,
    signatureHtml: row.signature_html,
    includeSignatureOnReplies: row.include_signature_on_replies,
    blockedSenders: row.blocked_senders,
    updatedAt: row.updated_at,
  };
}
export class MailPreferencesStore {
  constructor(private readonly sql: postgres.Sql) {}

  async getJournalSettings(orgId: string): Promise<MailJournalSettings> {
    const [settings, status] = await Promise.all([
      this.sql<MailJournalSettingsRow[]>`
        select enabled, retention_days, updated_at
        from mail_journal_settings where org_id = ${orgId}
      `,
      this.sql<{ readonly entry_count: number; readonly last_journaled_at: Date | null }[]>`
        select count(*)::integer as entry_count, max(created_at) as last_journaled_at
        from mail_journal_entries where org_id = ${orgId}
      `,
    ]);
    return {
      enabled: settings[0]?.enabled ?? false,
      retentionDays: settings[0]?.retention_days ?? 2555,
      entryCount: status[0]?.entry_count ?? 0,
      lastJournaledAt: status[0]?.last_journaled_at ?? null,
      updatedAt: settings[0]?.updated_at ?? null,
    };
  }

  async setJournalSettings(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly enabled: boolean;
    readonly retentionDays: number;
  }): Promise<MailJournalSettings> {
    await this.sql`
      insert into mail_journal_settings (
        org_id, enabled, retention_days, updated_by_actor_id, updated_at
      ) values (
        ${input.orgId}, ${input.enabled}, ${input.retentionDays}, ${input.actorId}, statement_timestamp()
      ) on conflict (org_id) do update set
        enabled = excluded.enabled,
        retention_days = excluded.retention_days,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = excluded.updated_at
    `;
    return this.getJournalSettings(input.orgId);
  }

  async recordSpamFeedback(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly messageId?: string | null;
    readonly label: "spam" | "ham";
    readonly source?: "user" | "auto_spamd" | "auto_ai" | "auto_rules";
    readonly evidence?: JsonObject;
  }): Promise<void> {
    try {
      await this.sql`
        insert into mail_spam_feedback (
          org_id, actor_id, thread_id, message_id, label, source, evidence
        )
        values (
          ${input.orgId},
          ${input.actorId},
          ${input.threadId},
          ${input.messageId ?? null},
          ${input.label},
          ${input.source ?? "user"},
          ${this.sql.json(toSqlJson(input.evidence ?? {}))}
        )
      `;
    } catch (error) {
      // Pre-migration deploys: do not fail spam mark/unmark on missing table.
      const message = error instanceof Error ? error.message : String(error);
      if (/mail_spam_feedback|does not exist/iu.test(message)) {
        return;
      }
      throw error;
    }
  }

  async createFilter(input: CreateMailFilterInput): Promise<MailFilterRecord> {
    const rows = await this.sql<MailFilterRow[]>`
      insert into mail_filters (org_id, actor_id, name, enabled, priority, criteria, actions)
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.name},
        ${input.enabled ?? true},
        ${input.priority ?? 100},
        ${this.sql.json(toSqlJson(input.criteria))},
        ${this.sql.json(toSqlJson(input.actions))}
      )
      returning *
    `;
    return mapFilter(rows[0]);
  }

  async updateFilter(input: UpdateMailFilterInput): Promise<MailFilterRecord | null> {
    const currentRows = await this.sql<MailFilterRow[]>`
      select * from mail_filters
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.id} and deleted_at is null
      limit 1
    `;
    const current = currentRows[0];
    if (current === undefined) {
      return null;
    }

    const rows = await this.sql<MailFilterRow[]>`
      update mail_filters
      set
        name = ${input.patch.name ?? current.name},
        enabled = ${input.patch.enabled ?? current.enabled},
        priority = ${input.patch.priority ?? current.priority},
        criteria = ${this.sql.json(toSqlJson(input.patch.criteria ?? current.criteria))},
        actions = ${this.sql.json(toSqlJson(input.patch.actions ?? current.actions))},
        updated_at = now()
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.id} and deleted_at is null
      returning *
    `;
    return rows[0] === undefined ? null : mapFilter(rows[0]);
  }

  async deleteFilter(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<boolean> {
    const rows = await this.sql`
      update mail_filters
      set deleted_at = now(), enabled = false, updated_at = now()
      where org_id = ${input.orgId} and actor_id = ${input.actorId} and id = ${input.id} and deleted_at is null
      returning id
    `;
    return rows.count > 0;
  }

  async listFilters(orgId: string, actorId: string): Promise<readonly MailFilterRecord[]> {
    const rows = await this.sql<MailFilterRow[]>`
      select * from mail_filters
      where org_id = ${orgId} and actor_id = ${actorId} and deleted_at is null
      order by priority asc, created_at asc
    `;
    return rows.map(mapFilter);
  }

  async getUserSettings(orgId: string, actorId: string): Promise<MailUserSettings> {
    const rows = await this.sql<MailUserSettingsRow[]>`
      select signature_text, signature_html, include_signature_on_replies,
        blocked_senders, updated_at
      from mail_user_settings
      where org_id = ${orgId} and actor_id = ${actorId}
    `;
    return rows[0] === undefined
      ? {
          signatureText: "",
          signatureHtml: null,
          includeSignatureOnReplies: true,
          blockedSenders: [],
          updatedAt: new Date(0),
        }
      : mapUserSettings(rows[0]);
  }

  async setUserSettings(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly signatureText: string;
    readonly signatureHtml: string | null;
    readonly includeSignatureOnReplies: boolean;
    readonly blockedSenders: readonly string[];
  }): Promise<MailUserSettings> {
    const blockedSenders = [...new Set(input.blockedSenders.map(normalizeAddress))].sort();
    const rows = await this.sql<MailUserSettingsRow[]>`
      insert into mail_user_settings (
        org_id, actor_id, signature_text, signature_html,
        include_signature_on_replies, blocked_senders
      ) values (
        ${input.orgId}, ${input.actorId}, ${input.signatureText}, ${input.signatureHtml},
        ${input.includeSignatureOnReplies}, ${blockedSenders}
      )
      on conflict (org_id, actor_id) do update set
        signature_text = excluded.signature_text,
        signature_html = excluded.signature_html,
        include_signature_on_replies = excluded.include_signature_on_replies,
        blocked_senders = excluded.blocked_senders,
        updated_at = now()
      returning signature_text, signature_html, include_signature_on_replies,
        blocked_senders, updated_at
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("Unable to save mail settings.");
    return mapUserSettings(row);
  }

  async getVacation(orgId: string, actorId: string): Promise<MailVacationRecord | null> {
    const rows = await this.sql<MailVacationRow[]>`
      select * from mail_vacation
      where org_id = ${orgId} and actor_id = ${actorId}
      limit 1
    `;
    return rows[0] === undefined ? null : mapVacation(rows[0]);
  }

  async setVacation(input: SetMailVacationInput): Promise<MailVacationRecord> {
    const rows = await this.sql<MailVacationRow[]>`
      insert into mail_vacation (
        org_id, actor_id, enabled, subject, body, starts_at, ends_at, metadata
      )
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.enabled},
        ${input.subject},
        ${input.body},
        ${input.startsAt},
        ${input.endsAt},
        ${this.sql.json(toSqlJson(input.metadata))}
      )
      on conflict (actor_id) do update
      set
        org_id = excluded.org_id,
        enabled = excluded.enabled,
        subject = excluded.subject,
        body = excluded.body,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        metadata = excluded.metadata,
        updated_at = now()
      returning *
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Unable to set mail vacation.");
    }
    return mapVacation(row);
  }

  async getActiveVacation(
    orgId: string,
    actorId: string,
    now: Date = new Date(),
  ): Promise<MailVacationRecord | null> {
    const rows = await this.sql<MailVacationRow[]>`
      select * from mail_vacation
      where org_id = ${orgId}
        and actor_id = ${actorId}
        and enabled = true
        and (starts_at is null or starts_at <= ${now})
        and (ends_at is null or ends_at >= ${now})
      limit 1
    `;
    return rows[0] === undefined ? null : mapVacation(rows[0]);
  }

  async hasVacationResponse(input: {
    readonly vacationId: string;
    readonly senderEmail: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      select exists(
        select 1 from mail_vacation_responses
        where vacation_id = ${input.vacationId} and lower(sender_email) = ${normalizeAddress(input.senderEmail)}
      ) as exists
    `;
    return rows[0]?.exists === true;
  }

  async recordVacationResponse(input: {
    readonly vacationId: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly senderEmail: string;
    readonly messageId?: string;
    readonly threadId?: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      insert into mail_vacation_responses (vacation_id, org_id, actor_id, sender_email, message_id, thread_id)
      values (
        ${input.vacationId},
        ${input.orgId},
        ${input.actorId},
        ${normalizeAddress(input.senderEmail)},
        ${input.messageId ?? null},
        ${input.threadId ?? null}
      )
      on conflict do nothing
      returning id
    `;
    return rows.length > 0;
  }
}
