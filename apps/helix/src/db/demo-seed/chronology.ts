import type postgres from "postgres";

/**
 * Store APIs stamp rows with the transaction clock. A workspace that "has been
 * used for years" needs those rows dated across that history, so each phase
 * records when its rows really happened and this ledger rewrites only those
 * temporal columns, in set-based batches, after the rows exist.
 *
 * It never touches `activity`: audit rows are hashed over their timestamp and
 * are written with their historical time up front (see `audit-history.ts`).
 */
type Key = Readonly<Record<string, string>>;
type Times = Readonly<Record<string, Date | null>>;

interface Entry {
  readonly key: Key;
  readonly times: Times;
}

/** How rows of a table without `org_id` are confined to the demo tenant. */
const SCOPES: Partial<Record<string, string>> = {
  user: "$2::uuid is not null",
  orgs: "target.id = $2::uuid",
  app_passwords:
    "exists (select 1 from actors where actors.id = target.actor_id and actors.org_id = $2::uuid)",
};

/** Temporal columns the ledger may rewrite, per table. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  orgs: ["created_at", "updated_at"],
  actors: ["created_at", "updated_at", "disabled_at"],
  user: ["createdAt", "updatedAt"],
  admin_org_units: ["created_at", "updated_at"],
  admin_groups: ["created_at", "updated_at"],
  admin_group_members: ["created_at"],
  admin_domains: ["created_at", "updated_at", "verified_at"],
  threads: ["created_at", "updated_at"],
  messages: ["created_at", "sent_at", "edited_at", "deleted_at"],
  mail_message_deliveries: ["received_at"],
  mail_thread_state: [
    "updated_at",
    "read_at",
    "archived_at",
    "snoozed_until",
    "deleted_at",
    "spam_at",
  ],
  mail_outbound_messages: ["created_at", "updated_at", "sent_at", "undo_until", "next_attempt_at"],
  mail_labels: ["created_at", "updated_at"],
  mail_filters: ["created_at", "updated_at"],
  objects: ["created_at", "updated_at", "deleted_at"],
  drive_folders: ["created_at", "updated_at", "deleted_at"],
  drive_share_links: ["created_at"],
  permissions: ["created_at"],
  cal_events: ["created_at", "updated_at"],
  cal_attendees: ["created_at", "updated_at", "responded_at"],
  chat_room_settings: ["created_at", "updated_at"],
  chat_reactions: ["created_at"],
  chat_pins: ["created_at"],
  chat_read_receipts: ["last_read_at", "updated_at"],
  carddav_contacts: ["created_at", "updated_at"],
  meet_rooms: ["created_at", "updated_at"],
  assistant_conversations: ["created_at", "updated_at"],
  assistant_message_feedback: ["created_at", "updated_at"],
  memory_items: ["created_at", "updated_at"],
  notifications: ["created_at", "read_at"],
  app_passwords: ["created_at", "last_used_at"],
  agent_credentials: ["created_at", "updated_at", "last_used_at"],
  drive_s3_access_keys: ["created_at", "last_used_at"],
  outbound_webhooks: ["created_at", "updated_at"],
  webhook_deliveries: ["created_at", "updated_at", "delivered_at", "next_attempt_at"],
  admin_oauth_apps: ["created_at", "updated_at"],
  admin_security_policies: ["created_at", "updated_at"],
};

export class ChronologyLedger {
  readonly #entries = new Map<string, Map<string, Entry>>();

  /** Date one row: `key` identifies it, `times` are the columns to rewrite. */
  at(table: string, key: Key, times: Times): void {
    const allowed = ALLOWED[table];
    if (allowed === undefined) throw new Error(`Chronology does not manage table ${table}.`);
    for (const column of Object.keys(times)) {
      if (!allowed.includes(column)) {
        throw new Error(`Chronology does not manage ${table}.${column}.`);
      }
    }
    const group = `${table}|${Object.keys(key).sort().join(",")}|${Object.keys(times).sort().join(",")}`;
    const entries = this.#entries.get(group) ?? new Map<string, Entry>();
    // A later record for the same row replaces the earlier one.
    entries.set(JSON.stringify(Object.entries(key).sort()), { key, times });
    this.#entries.set(group, entries);
  }

  get size(): number {
    let total = 0;
    for (const entries of this.#entries.values()) total += entries.size;
    return total;
  }

  /** Applies every recorded timestamp inside the caller's tenant transaction. */
  async apply(tx: postgres.TransactionSql, orgId: string): Promise<number> {
    let updated = 0;
    for (const [group, rows] of this.#entries) {
      const entries = [...rows.values()];
      const [table = "", keyList = "", timeList = ""] = group.split("|");
      const keys = keyList.split(",");
      const times = timeList.split(",");
      for (let start = 0; start < entries.length; start += 2000) {
        const batch = entries.slice(start, start + 2000).map((entry) => ({
          ...entry.key,
          ...Object.fromEntries(
            Object.entries(entry.times).map(([column, value]) => [
              column,
              value?.toISOString() ?? null,
            ]),
          ),
        }));
        const columns = [
          ...keys.map((column) => `${quote(column)} text`),
          ...times.map((column) => `${quote(column)} timestamptz`),
        ].join(", ");
        const assignments = times
          .map((column) => `${quote(column)} = v.${quote(column)}`)
          .join(", ");
        const matches = keys
          .map((column) => `target.${quote(column)}::text = v.${quote(column)}`)
          .join(" and ");
        const scoped = SCOPES[table] ?? `target.org_id = $2::uuid`;
        const result = await tx.unsafe(
          `update ${quote(table)} as target set ${assignments}
           from jsonb_to_recordset($1::text::jsonb) as v(${columns})
           where ${matches} and ${scoped}`,
          [JSON.stringify(batch), orgId],
        );
        updated += result.count;
      }
    }
    this.#entries.clear();
    return updated;
  }
}

function quote(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe identifier ${identifier}.`);
  }
  return `"${identifier}"`;
}
