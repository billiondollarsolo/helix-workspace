import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";
import type {
  ChatRoomEvent,
  ChatRoomEventLog,
  ChatRoomReplayInput,
  ChatRoomReplayResult,
  SequencedChatRoomEvent,
} from "./realtime.js";

interface AppendedEventRow {
  readonly event_sequence: number | string;
  readonly stored_event: JsonObject;
}

interface ReplayRow {
  readonly authorized: boolean;
  readonly latest_cursor: number | string;
  readonly earliest_cursor: number | string;
  readonly events: readonly {
    readonly sequence: number | string;
    readonly event: JsonObject;
  }[];
}

/** PostgreSQL-backed ordered event log shared by every Chat replica. */
export class PostgresChatRoomEventLog implements ChatRoomEventLog {
  constructor(private readonly sql: postgres.Sql) {}

  append(event: ChatRoomEvent): Promise<SequencedChatRoomEvent> {
    return withTenantIoSagaPostgresContext(this.sql, { orgId: event.orgId }, async (tx) => {
      const rows = await tx<AppendedEventRow[]>`
        select event_sequence, stored_event
        from append_chat_room_event(
          ${event.orgId},
          ${event.roomId},
          ${tx.json(event)}
        )
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error("Unable to append Chat room event.");
      }
      return sequencedEvent(row.stored_event, safeCursor(row.event_sequence));
    });
  }

  replay(input: ChatRoomReplayInput): Promise<ChatRoomReplayResult> {
    return withTenantIoSagaPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const rows = await tx<ReplayRow[]>`
          with access as (
            select exists (
              select 1
              from permissions grant_row
              where chat_permission_is_valid(
                grant_row,
                ${input.orgId},
                ${input.actorId},
                ${input.roomId}
              )
            ) as authorized
          ), room_state as (
            select
              settings.next_event_sequence as latest_cursor,
              coalesce(
                (
                  select min(room_event.sequence)
                  from chat_room_events room_event
                  where room_event.org_id = settings.org_id
                    and room_event.room_id = settings.thread_id
                ),
                settings.next_event_sequence + 1
              ) as earliest_cursor
            from chat_room_settings settings
            where settings.org_id = ${input.orgId}
              and settings.thread_id = ${input.roomId}
          )
          select
            access.authorized,
            coalesce(room_state.latest_cursor, 0) as latest_cursor,
            coalesce(room_state.earliest_cursor, 1) as earliest_cursor,
            coalesce((
              select jsonb_agg(
                jsonb_build_object('sequence', selected.sequence, 'event', selected.event)
                order by selected.sequence
              )
              from (
                select room_event.sequence, room_event.event
                from chat_room_events room_event
                where access.authorized
                  and room_event.org_id = ${input.orgId}
                  and room_event.room_id = ${input.roomId}
                  and room_event.sequence > ${input.after}
                  and room_event.sequence <= room_state.latest_cursor
                  and exists (
                    select 1
                    from permissions replay_grant
                    join chat_room_settings replay_settings
                      on replay_settings.org_id = replay_grant.org_id
                     and replay_settings.thread_id = replay_grant.resource_id
                    where chat_permission_is_valid(
                      replay_grant,
                      ${input.orgId},
                      ${input.actorId},
                      ${input.roomId}
                    )
                      and (
                        coalesce(replay_settings.metadata->>'historyPolicy', 'full') = 'full'
                        or (
                          coalesce(replay_settings.metadata->>'historyPolicy', 'full') = 'since_join'
                          and room_event.created_at >= replay_grant.valid_from
                        )
                      )
                  )
                  and (
                    nullif(room_event.event->'message'->>'sentAt', '') is null
                    or helix_chat_message_visible_to(
                      ${input.orgId},
                      ${input.actorId},
                      ${input.roomId},
                      (room_event.event->'message'->>'sentAt')::timestamptz
                    )
                  )
                order by room_event.sequence
                limit ${input.limit + 1}
              ) selected
            ), '[]'::jsonb) as events
          from access
          left join room_state on true
          group by access.authorized, room_state.latest_cursor, room_state.earliest_cursor
        `;
        const row = rows[0];
        if (row === undefined || !row.authorized) {
          return deniedReplay(input.after);
        }

        const latestCursor = safeCursor(row.latest_cursor);
        const earliestCursor = safeCursor(row.earliest_cursor);
        const resetRequired = input.after > latestCursor || input.after + 1 < earliestCursor;
        if (resetRequired) {
          return {
            authorized: true,
            events: [],
            cursor: input.after,
            latestCursor,
            hasMore: false,
            resetRequired: true,
          };
        }

        const selected = row.events.slice(0, input.limit);
        const events = selected.map(({ event, sequence }) =>
          sequencedEvent(event, safeCursor(sequence)),
        );
        return {
          authorized: true,
          events,
          cursor: events.at(-1)?.cursor ?? input.after,
          latestCursor,
          hasMore: row.events.length > input.limit,
          resetRequired: false,
        };
      },
    );
  }
}

function deniedReplay(cursor: number): ChatRoomReplayResult {
  return {
    authorized: false,
    events: [],
    cursor,
    latestCursor: cursor,
    hasMore: false,
    resetRequired: false,
  };
}

function sequencedEvent(event: JsonObject, cursor: number): SequencedChatRoomEvent {
  if (
    typeof event.type !== "string" ||
    typeof event.roomId !== "string" ||
    typeof event.orgId !== "string"
  ) {
    throw new TypeError("Stored Chat room event is malformed.");
  }
  return { ...event, type: event.type, roomId: event.roomId, orgId: event.orgId, cursor };
}

function safeCursor(value: number | string): number {
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new RangeError("Chat event cursor is outside the safe integer range.");
  }
  return cursor;
}
