import { appendMeetActivity, type SqlLike } from "./room-writes.js";
import type { MeetStore } from "./store.js";
import type { MeetRoomRecord } from "./types.js";

export interface MeetRoomActivationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly roomId: string;
  readonly at: Date;
}

/**
 * Opens a scheduled room (one created by Calendar conferencing or scheduled
 * from the Meet hub) on its first authorized member join. Callers authorize
 * the actor first; the update only flips `scheduled` rooms and is recorded in
 * the activity log. The room opens empty, so the lifecycle worker ends it if
 * nobody connects to the media bridge.
 */
export async function activateScheduledMeetRoom(
  sql: SqlLike,
  input: MeetRoomActivationInput,
): Promise<void> {
  const rows = await sql`
    update meet_rooms set
      status = 'active',
      started_at = ${input.at},
      empty_since = coalesce(empty_since, ${input.at}),
      lifecycle_version = lifecycle_version + 1,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.roomId} and status = 'scheduled'
    returning id
  `;
  if (rows.length === 0) return;
  await appendMeetActivity(sql, input.orgId, input.actorId, "meet.room.opened", input.roomId, {
    openedAt: input.at.toISOString(),
  });
}

/**
 * Returns the room a member may join now: an active room as it is, a scheduled
 * room after opening it. `room` must come from an actor-scoped store read, and
 * the store re-checks the actor's access while opening it.
 */
export async function openRoomForMemberJoin(
  store: MeetStore,
  room: MeetRoomRecord,
  actorId: string,
): Promise<MeetRoomRecord> {
  if (room.status === "active") return room;
  const opened =
    room.status === "scheduled"
      ? await store.activateScheduledRoom({
          orgId: room.orgId,
          actorId,
          roomId: room.id,
          at: new Date(),
        })
      : null;
  if (opened?.status !== "active") throw new Error(`Meet room has ended: ${room.id}`);
  return opened;
}
