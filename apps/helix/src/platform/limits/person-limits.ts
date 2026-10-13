import type postgres from "postgres";
import { RateLimitedError } from "../../api/api-error.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

/**
 * Limits for one person, agent or service account: how much they may store
 * (their Drive files plus their mailbox) and how much mail they may send.
 *
 * The organization sets a default for everyone; an administrator can give one
 * actor a different value. `null` in an override means "the organization's
 * default"; `null` in the effective limits means "no limit".
 */

export interface PersonLimitValues {
  readonly storageBytes: number | null;
  readonly mailSendPerHour: number | null;
  readonly mailSendPerDay: number | null;
}

interface PersonLimitUsage {
  readonly storageBytes: number;
  readonly mailSentLastHour: number;
  readonly mailSentLastDay: number;
}

export interface PersonLimitRecord {
  readonly actorId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly type: string;
  /** What an administrator set for this actor. */
  readonly overrides: PersonLimitValues;
  /** What applies: the override where there is one, else the organization's default. */
  readonly effective: PersonLimitValues;
  readonly usage: PersonLimitUsage;
}

/** Mail the limit does not count: notices Helix sends in a person's name. */
export const UNCOUNTED_MAIL_KEY_PREFIX = "notice:";

interface LimitRow {
  readonly actor_id: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly type: string;
  readonly storage_bytes_limit: string | number | null;
  readonly mail_send_per_hour: number | null;
  readonly mail_send_per_day: number | null;
  readonly storage_used_bytes: string | number | null;
  readonly sent_last_hour: number;
  readonly sent_last_day: number;
}

const toNumber = (value: string | number | null): number | null =>
  value === null ? null : Number(value);

function toRecord(row: LimitRow, defaults: PersonLimitValues): PersonLimitRecord {
  const overrides: PersonLimitValues = {
    storageBytes: toNumber(row.storage_bytes_limit),
    mailSendPerHour: row.mail_send_per_hour,
    mailSendPerDay: row.mail_send_per_day,
  };
  return {
    actorId: row.actor_id,
    displayName: row.display_name,
    email: row.email,
    type: row.type,
    overrides,
    effective: {
      storageBytes: overrides.storageBytes ?? defaults.storageBytes,
      mailSendPerHour: overrides.mailSendPerHour ?? defaults.mailSendPerHour,
      mailSendPerDay: overrides.mailSendPerDay ?? defaults.mailSendPerDay,
    },
    usage: {
      storageBytes: toNumber(row.storage_used_bytes) ?? 0,
      mailSentLastHour: row.sent_last_hour,
      mailSentLastDay: row.sent_last_day,
    },
  };
}

export class PostgresPersonLimitStore {
  constructor(
    private readonly sql: postgres.Sql,
    /** The organization's defaults for each person, from its effective settings. */
    private readonly defaultsFor: (orgId: string) => Promise<PersonLimitValues>,
  ) {}

  /** One actor's limits and usage, or `null` for an actor outside the organization. */
  async get(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<PersonLimitRecord | null> {
    const [record] = await this.read(input.orgId, [input.actorId]);
    return record ?? null;
  }

  /** Every actor an administrator has given a limit of their own. */
  async listOverrides(orgId: string): Promise<readonly PersonLimitRecord[]> {
    return this.read(orgId, null);
  }

  /** Set one actor's own limits. All three `null` returns the actor to the defaults. */
  async setOverrides(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly updatedByActorId: string;
    readonly overrides: PersonLimitValues;
  }): Promise<PersonLimitRecord | null> {
    const { storageBytes, mailSendPerHour, mailSendPerDay } = input.overrides;
    const changed = await withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId },
      async (tx) => {
        const actors = await tx`
          select 1 from actors where org_id = ${input.orgId} and id = ${input.actorId}
        `;
        if (actors.length === 0) return false;
        if (storageBytes === null && mailSendPerHour === null && mailSendPerDay === null) {
          await tx`
            delete from actor_limits where org_id = ${input.orgId} and actor_id = ${input.actorId}
          `;
          return true;
        }
        await tx`
          insert into actor_limits (
            org_id, actor_id, storage_bytes_limit, mail_send_per_hour, mail_send_per_day,
            updated_by_actor_id
          ) values (
            ${input.orgId}, ${input.actorId}, ${storageBytes}, ${mailSendPerHour},
            ${mailSendPerDay}, ${input.updatedByActorId}
          )
          on conflict (org_id, actor_id) do update set
            storage_bytes_limit = excluded.storage_bytes_limit,
            mail_send_per_hour = excluded.mail_send_per_hour,
            mail_send_per_day = excluded.mail_send_per_day,
            updated_by_actor_id = excluded.updated_by_actor_id,
            updated_at = statement_timestamp()
        `;
        return true;
      },
    );
    return changed ? this.get(input) : null;
  }

  /**
   * Refuse a message that would take the sender past their hourly or daily
   * limit. Mail waiting to be sent counts; cancelled mail and notices Helix
   * sends in the person's name do not.
   */
  async assertMaySend(input: { readonly orgId: string; readonly actorId: string }): Promise<void> {
    const record = await this.get(input);
    if (record === null) return;
    const { effective, usage } = record;
    const over = (limit: number | null, sent: number) => limit !== null && sent >= limit;
    const window = over(effective.mailSendPerHour, usage.mailSentLastHour)
      ? ({ limit: effective.mailSendPerHour, unit: "hour" } as const)
      : over(effective.mailSendPerDay, usage.mailSentLastDay)
        ? ({ limit: effective.mailSendPerDay, unit: "day" } as const)
        : null;
    if (window === null) return;
    throw new RateLimitedError(
      `You have reached your limit of ${String(window.limit)} message${window.limit === 1 ? "" : "s"} a${window.unit === "hour" ? "n" : ""} ${window.unit}. Try again later, or ask an administrator to raise it.`,
      { details: { mailCode: "mail.send_limit_reached", limit: window.limit, per: window.unit } },
    );
  }

  private async read(
    orgId: string,
    actorIds: readonly string[] | null,
  ): Promise<readonly PersonLimitRecord[]> {
    const defaults = await this.defaultsFor(orgId);
    const rows = await withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      return tx<LimitRow[]>`
        select actor.id as actor_id, actor.display_name, actor.email, actor.type,
          own.storage_bytes_limit, own.mail_send_per_hour, own.mail_send_per_day,
          helix_actor_storage_usage_bytes(actor.org_id, actor.id) as storage_used_bytes,
          sent.last_hour as sent_last_hour, sent.last_day as sent_last_day
        from actors actor
        left join actor_limits own on own.org_id = actor.org_id and own.actor_id = actor.id
        cross join lateral (
          select
            helix_actor_mail_sent_count(actor.org_id, actor.id, now() - interval '1 hour')
              as last_hour,
            helix_actor_mail_sent_count(actor.org_id, actor.id, now() - interval '1 day')
              as last_day
        ) sent
        where actor.org_id = ${orgId}
          and ${
            actorIds === null ? tx`own.actor_id is not null` : tx`actor.id in ${tx([...actorIds])}`
          }
        order by actor.display_name, actor.id
        limit 500
      `;
    });
    return rows.map((row) => toRecord(row, defaults));
  }
}
