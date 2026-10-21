/* The Meet lobby. With the lobby on, a guest who has not been let in waits:
   each check-in refreshes their place in the host's list, and they get no media
   token until a host or co-host admits them. Organization members, hosts and
   co-hosts never wait. Locks and bans are still enforced by authorizeJoin. */

import type postgres from "postgres";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { appendMeetActivity } from "./room-writes.js";

/** A guest who stops checking in for this long drops out of the host's list. */
export const LOBBY_PRESENCE_MS = 30_000;

export type MeetLobbyEntry =
  /** Continue to authorizeJoin: no lobby applies, or the guest was let in. */
  | { readonly status: "proceed" }
  | {
      readonly status: "waiting";
      /** True when the guest just started waiting, so hosts should be told. */
      readonly first: boolean;
      readonly moderatorIds: readonly string[];
    }
  | { readonly status: "denied" };

export interface MeetLobbyRequest {
  readonly participantSubject: string;
  readonly displayName: string;
  readonly requestedAt: Date;
}

export interface MeetLobbyStore {
  /** Null when the meeting is not active. */
  enter(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly participantSubject: string;
    readonly displayName: string;
  }): Promise<MeetLobbyEntry | null>;
  /** Guests waiting right now (checked in within LOBBY_PRESENCE_MS). */
  listWaiting(input: {
    readonly orgId: string;
    readonly roomId: string;
  }): Promise<readonly MeetLobbyRequest[]>;
  /** Records a host's answer. False when nobody with that subject is waiting. */
  decide(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly participantSubject: string;
    readonly actorId: string;
    readonly decision: "admitted" | "denied";
  }): Promise<boolean>;
  /**
   * Lets a host or co-host allow or block guests for the meeting. Blocking stops
   * every outstanding invitation from working. False when the actor can't.
   */
  setGuestsAllowed(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly allowed: boolean;
  }): Promise<boolean>;
}

interface RoomLobbyRow {
  readonly lobby_enabled: boolean;
  readonly host_actor_id: string | null;
  readonly cohost_actor_ids: readonly string[] | null;
  readonly admitted_participant_subjects: readonly string[] | null;
}

/** Whether this subject must wait, given the room's controls. */
function mustWait(room: RoomLobbyRow, subject: string): boolean {
  const moderators = [room.host_actor_id, ...(room.cohost_actor_ids ?? [])];
  return (
    room.lobby_enabled &&
    !moderators.includes(subject) &&
    room.admitted_participant_subjects?.includes(subject) !== true
  );
}

const moderatorIds = (room: RoomLobbyRow) =>
  [room.host_actor_id, ...(room.cohost_actor_ids ?? [])].filter((id): id is string => id !== null);

export class PostgresMeetLobbyStore implements MeetLobbyStore {
  constructor(private readonly sql: postgres.Sql) {}

  async enter(input: Parameters<MeetLobbyStore["enter"]>[0]): Promise<MeetLobbyEntry | null> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rooms = await tx<RoomLobbyRow[]>`
        select lobby_enabled, host_actor_id, cohost_actor_ids, admitted_participant_subjects
        from meet_rooms
        where org_id = ${input.orgId} and id = ${input.roomId} and status = 'active'
        for update
      `;
      const room = rooms[0];
      if (room === undefined) return null;
      if (!mustWait(room, input.participantSubject)) return { status: "proceed" };
      const prior = await tx<{ readonly status: string }[]>`
        select status from meet_lobby_requests
        where org_id = ${input.orgId} and room_id = ${input.roomId}
          and participant_subject = ${input.participantSubject}
      `;
      if (prior[0]?.status === "denied") return { status: "denied" };
      await tx`
        insert into meet_lobby_requests (org_id, room_id, participant_subject, display_name)
        values (${input.orgId}, ${input.roomId}, ${input.participantSubject}, ${input.displayName})
        on conflict (org_id, room_id, participant_subject) do update set
          display_name = excluded.display_name,
          last_seen_at = now(),
          requested_at = case when meet_lobby_requests.status = 'waiting'
            then meet_lobby_requests.requested_at else now() end,
          status = 'waiting',
          decided_at = null,
          decided_by_actor_id = null
      `;
      return {
        status: "waiting",
        first: prior[0]?.status !== "waiting",
        moderatorIds: moderatorIds(room),
      };
    });
  }

  async listWaiting(input: { readonly orgId: string; readonly roomId: string }) {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx<
        { participant_subject: string; display_name: string; requested_at: Date }[]
      >`
        select participant_subject, display_name, requested_at
        from meet_lobby_requests
        where org_id = ${input.orgId} and room_id = ${input.roomId} and status = 'waiting'
          and last_seen_at > now() - ${LOBBY_PRESENCE_MS} * interval '1 millisecond'
        order by requested_at, participant_subject
        limit 100
      `;
      return rows.map((row) => ({
        participantSubject: row.participant_subject,
        displayName: row.display_name,
        requestedAt: row.requested_at,
      }));
    });
  }

  async decide(input: Parameters<MeetLobbyStore["decide"]>[0]): Promise<boolean> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const rows = await tx`
          update meet_lobby_requests set
            status = ${input.decision},
            decided_at = now(),
            decided_by_actor_id = ${input.actorId}
          where org_id = ${input.orgId} and room_id = ${input.roomId}
            and participant_subject = ${input.participantSubject} and status = 'waiting'
          returning participant_subject
        `;
        if (rows.length === 1 && input.decision === "denied") {
          await appendMeetActivity(
            tx,
            input.orgId,
            input.actorId,
            "meet.lobby.denied",
            input.roomId,
            {
              participantSubject: input.participantSubject,
            },
          );
        }
        return rows.length === 1;
      },
    );
  }

  async setGuestsAllowed(input: Parameters<MeetLobbyStore["setGuestsAllowed"]>[0]) {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      (tx) => updateGuestPolicy(tx, input),
    );
  }
}

/** Shared by both stores: a host or co-host may change the meeting's guest access. */
async function updateGuestPolicy(
  tx: postgres.TransactionSql,
  input: Parameters<MeetLobbyStore["setGuestsAllowed"]>[0],
): Promise<boolean> {
  // Allowing keeps a domain allow-list in place; blocking turns guests off entirely.
  const rows = await tx`
    update meet_rooms set
      guest_policy = case
        when not ${input.allowed} then 'disabled'
        when guest_policy = 'disabled' then 'invite'
        else guest_policy end,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.roomId} and status <> 'ended'
      and (host_actor_id = ${input.actorId} or ${input.actorId} = any(cohost_actor_ids))
    returning id
  `;
  if (rows.length === 1)
    await appendMeetActivity(tx, input.orgId, input.actorId, "meet.guests.set", input.roomId, {
      allowed: input.allowed,
    });
  return rows.length === 1;
}

/** For tests and the in-memory runtime. */
export class InMemoryMeetLobbyStore implements MeetLobbyStore {
  readonly requests = new Map<
    string,
    MeetLobbyRequest & { status: "waiting" | "admitted" | "denied"; lastSeenAt: number }
  >();

  constructor(
    private readonly room: (orgId: string, roomId: string) => RoomLobbyRow | null,
    private readonly now: () => number = Date.now,
  ) {}

  async enter(input: Parameters<MeetLobbyStore["enter"]>[0]): Promise<MeetLobbyEntry | null> {
    const room = this.room(input.orgId, input.roomId);
    if (room === null) return null;
    if (!mustWait(room, input.participantSubject)) return { status: "proceed" };
    const key = `${input.roomId}:${input.participantSubject}`;
    const prior = this.requests.get(key);
    if (prior?.status === "denied") return { status: "denied" };
    this.requests.set(key, {
      participantSubject: input.participantSubject,
      displayName: input.displayName,
      requestedAt: prior?.status === "waiting" ? prior.requestedAt : new Date(this.now()),
      status: "waiting",
      lastSeenAt: this.now(),
    });
    return {
      status: "waiting",
      first: prior?.status !== "waiting",
      moderatorIds: moderatorIds(room),
    };
  }

  async listWaiting(input: { readonly orgId: string; readonly roomId: string }) {
    return [...this.requests.entries()]
      .filter(
        ([key, request]) =>
          key.startsWith(`${input.roomId}:`) &&
          request.status === "waiting" &&
          request.lastSeenAt > this.now() - LOBBY_PRESENCE_MS,
      )
      .map(([, { participantSubject, displayName, requestedAt }]) => ({
        participantSubject,
        displayName,
        requestedAt,
      }));
  }

  async decide(input: Parameters<MeetLobbyStore["decide"]>[0]) {
    const key = `${input.roomId}:${input.participantSubject}`;
    const request = this.requests.get(key);
    if (request?.status !== "waiting") return false;
    this.requests.set(key, { ...request, status: input.decision });
    return true;
  }

  readonly guestsAllowed = new Map<string, boolean>();
  async setGuestsAllowed(input: Parameters<MeetLobbyStore["setGuestsAllowed"]>[0]) {
    const room = this.room(input.orgId, input.roomId);
    if (room === null || !moderatorIds(room).includes(input.actorId)) return false;
    this.guestsAllowed.set(input.roomId, input.allowed);
    return true;
  }
}
