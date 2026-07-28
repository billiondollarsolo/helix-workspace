import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import type { ListNotificationsInput, NotificationInsert, NotificationRecord } from "./types.js";

interface NotificationRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly verb: string;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly summary: string;
  readonly body: string | null;
  readonly payload: JsonObject;
  readonly created_at: Date;
  readonly read_at: Date | null;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export interface NotificationStore {
  insert(input: NotificationInsert): Promise<NotificationRecord>;
  insertMany(inputs: readonly NotificationInsert[]): Promise<readonly NotificationRecord[]>;
  list(input: ListNotificationsInput): Promise<readonly NotificationRecord[]>;
  countUnread(orgId: string, actorId: string): Promise<number>;
  markRead(orgId: string, actorId: string, ids: readonly string[]): Promise<number>;
  markAllRead(orgId: string, actorId: string): Promise<number>;
}

/** Insert one notification using the given SQL handle. Exported so other
 *  stores (e.g. MeetStore.attachRecording) can fan out within their own
 *  transaction. */
export async function insertNotification(
  sql: SqlLike,
  input: NotificationInsert,
): Promise<NotificationRecord> {
  const rows = (await sql`
    insert into notifications (
      org_id, actor_id, verb, object_type, object_id, summary, body, payload
    )
    values (
      ${input.orgId},
      ${input.actorId},
      ${input.verb},
      ${input.objectType},
      ${input.objectId ?? null},
      ${input.summary},
      ${input.body ?? null},
      ${sql.json(input.payload ?? {})}
    )
    returning *
  `) as unknown as readonly NotificationRow[];
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to insert notification.");
  }
  return mapRow(row);
}

export class PostgresNotificationStore implements NotificationStore {
  constructor(private readonly sql: postgres.Sql) {}

  async insert(input: NotificationInsert): Promise<NotificationRecord> {
    return insertNotification(this.sql, input);
  }

  async insertMany(inputs: readonly NotificationInsert[]): Promise<readonly NotificationRecord[]> {
    if (inputs.length === 0) {
      return [];
    }
    return this.sql.begin(async (tx) =>
      Promise.all(inputs.map((input) => insertNotification(tx, input))),
    );
  }

  async list(input: ListNotificationsInput): Promise<readonly NotificationRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = input.unreadOnly
      ? ((await this.sql`
          select * from notifications
          where org_id = ${input.orgId}
            and actor_id = ${input.actorId}
            and read_at is null
          order by created_at desc
          limit ${limit}
        `) as unknown as readonly NotificationRow[])
      : ((await this.sql`
          select * from notifications
          where org_id = ${input.orgId}
            and actor_id = ${input.actorId}
          order by created_at desc
          limit ${limit}
        `) as unknown as readonly NotificationRow[]);
    return rows.map(mapRow);
  }

  async countUnread(orgId: string, actorId: string): Promise<number> {
    const rows = (await this.sql`
      select count(*)::int as c from notifications
      where org_id = ${orgId} and actor_id = ${actorId} and read_at is null
    `) as unknown as readonly { readonly c: number }[];
    return rows[0]?.c ?? 0;
  }

  async markRead(orgId: string, actorId: string, ids: readonly string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const rows = (await this.sql`
      update notifications
      set read_at = now()
      where org_id = ${orgId} and actor_id = ${actorId} and read_at is null
        and id in ${this.sql(ids)}
      returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length;
  }

  async markAllRead(orgId: string, actorId: string): Promise<number> {
    const rows = (await this.sql`
      update notifications
      set read_at = now()
      where org_id = ${orgId} and actor_id = ${actorId} and read_at is null
      returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows.length;
  }
}

function mapRow(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    verb: row.verb,
    objectType: row.object_type,
    objectId: row.object_id,
    summary: row.summary,
    body: row.body,
    payload: row.payload,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
