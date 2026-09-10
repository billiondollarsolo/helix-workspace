import type { JsonObject } from "@helix/sdk-types";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sensitivityLabelFor, type DataClassification } from "../ai/classification/index.js";
import { commitStorageUsage } from "../drive/index.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { toSqlJson } from "../util/sql.js";
import { hasControlCharacter } from "../util/strings.js";
import type {
  MeetActorRef,
  MeetAttendanceRecord,
  MeetControlAction,
  MeetControlResult,
  MeetControlState,
  MeetGuestInviteRecord,
  MeetGuestPolicy,
  MeetMeetingRecord,
  MeetRecordingArtifactRecord,
  MeetRecordingAttachmentRecord,
  MeetRoomRecord,
  MeetRoomStatus,
  MeetSummaryRef,
} from "./types.js";

export const MEET_RECORDING_NOTICE_VERSION = "2026-09-02";
const MEET_RECORDING_CONSENT_POLICY = "explicit-all-parties";
const MEET_RECORDING_JURISDICTION = "global";
const RECORDING_AUTHORIZATION_TTL_MS = 30_000;

export interface MeetRecordingAuthorization {
  readonly id: string;
  readonly expiresAt: Date;
  readonly participantSubjects: readonly string[];
}

export interface CreateMeetRoomInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly subject: string;
  readonly roomName?: string | undefined;
  readonly jitsiDomain: string;
  readonly participantActorIds?: readonly string[] | undefined;
  readonly scheduledStartAt?: Date | null | undefined;
  readonly scheduledEndAt?: Date | null | undefined;
  /**
   * Initial lifecycle state. Defaults to `active` (an instant room); pass
   * `scheduled` together with `scheduledStartAt` for an upcoming meeting.
   */
  readonly status?: MeetRoomStatus | undefined;
  readonly guestPolicy?: MeetGuestPolicy | undefined;
  readonly guestDomains?: readonly string[] | undefined;
  readonly lobbyEnabled?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface ListMeetMeetingsInput {
  readonly orgId: string;
  readonly actorId: string;
  /** Restrict to a single lifecycle state; omit for scheduled + active + ended. */
  readonly status?: MeetRoomStatus | undefined;
  readonly limit: number;
}

export interface AttachMeetRecordingInput {
  readonly orgId: string;
  readonly roomId?: string | undefined;
  readonly roomName?: string | undefined;
  readonly actorId?: string | null | undefined;
  readonly storageKey: string;
  readonly mimeType?: string | undefined;
  readonly byteSize: number;
  readonly sha256?: string | null | undefined;
  readonly startedAt?: Date | null | undefined;
  readonly endedAt?: Date | null | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface ListMeetRoomsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly status?: MeetRoomStatus | undefined;
  readonly limit: number;
}

export interface AttachMeetSummaryInput {
  readonly orgId: string;
  readonly roomId?: string | undefined;
  readonly roomName?: string | undefined;
  readonly actorId?: string | null | undefined;
  readonly body: string;
  readonly metadata?: JsonObject | undefined;
}

export interface MeetRecordingUploadRecord {
  readonly id: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly roomName: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
}

export interface MeetMediaWebhookStore {
  claimMediaWebhook(input: { readonly id: string; readonly expiresAt: Date }): Promise<boolean>;
  prepareRecordingUpload(
    input: Omit<MeetRecordingUploadRecord, "roomName" | "completedAt">,
  ): Promise<boolean>;
  getRecordingUpload(id: string): Promise<MeetRecordingUploadRecord | null>;
  markRecordingUploadReady(id: string, validation: JsonObject): Promise<boolean>;
  completeRecordingUpload(id: string): Promise<boolean>;
  applyMediaEvent(input: MeetMediaEventInput): Promise<MeetMediaEventResult | null>;
  expireEmptyRooms(input: { readonly emptyBefore: Date; readonly limit: number }): Promise<number>;
}

export type MeetMediaEventType =
  | "conference.started"
  | "conference.ended"
  | "participant.joined"
  | "participant.left"
  | "recording.started"
  | "recording.ended";

export interface MeetMediaEventInput {
  readonly eventId: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly roomName?: string | undefined;
  readonly event: MeetMediaEventType;
  readonly sessionId?: string | undefined;
  readonly participantId?: string | undefined;
  readonly occurredAt: Date;
}

export interface MeetMediaEventResult {
  readonly roomId: string;
  readonly status: MeetRoomStatus;
  readonly version: number;
  readonly activeParticipantCount: number;
  readonly participantDurationSeconds?: number | undefined;
  readonly reconnected?: boolean | undefined;
  readonly duplicate: boolean;
}

export interface MeetStore {
  createRoom(input: CreateMeetRoomInput): Promise<MeetRoomRecord>;
  listRoomsForActor(input: ListMeetRoomsInput): Promise<readonly MeetRoomRecord[]>;
  /**
   * List meetings visible to the actor projected for the Meet hub UI: host +
   * attendee roster, join code, lifecycle status, recording and summary refs.
   */
  listMeetingsForActor(input: ListMeetMeetingsInput): Promise<readonly MeetMeetingRecord[]>;
  getRoomForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null>;
  getRoomForActorByCode(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly code: string;
  }): Promise<MeetRoomRecord | null>;
  createGuestInvite(input: {
    readonly id: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly email: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<MeetGuestInviteRecord | null>;
  revokeGuestInvite(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly inviteId: string;
  }): Promise<boolean>;
  resolveGuestInvite(input: {
    readonly inviteId: string;
    readonly orgId: string;
    readonly roomId: string;
    readonly email: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<{ readonly invite: MeetGuestInviteRecord; readonly room: MeetRoomRecord } | null>;
  recordMemberRecordingConsent(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly joinGrantId: string;
    readonly deviceId: string;
    readonly expiresAt: Date;
  }): Promise<boolean>;
  recordGuestRecordingConsent(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly guestInviteId: string;
    readonly joinGrantId: string;
    readonly deviceId: string;
    readonly expiresAt: Date;
  }): Promise<boolean>;
  authorizeRecordingStart(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
  }): Promise<MeetRecordingAuthorization | null>;
  claimRecordingStartAuthorization(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly startedAt: Date;
  }): Promise<boolean>;
  claimRecordingUploadAuthorization(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly startedAt: Date;
  }): Promise<boolean>;
  canModerateRoom?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<boolean>;
  authorizeJoin?(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly participantSubject: string;
  }): Promise<MeetControlState | null>;
  getControlState?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetControlState | null>;
  applyControl?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly control: MeetControlAction;
  }): Promise<MeetControlResult | null>;
  listAttendance?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly MeetAttendanceRecord[] | null>;
  getRoomById(input: {
    readonly orgId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null>;
  getRoomByName(input: {
    readonly orgId: string;
    readonly roomName: string;
  }): Promise<MeetRoomRecord | null>;
  endRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null>;
  attachRecording(input: AttachMeetRecordingInput): Promise<MeetRecordingAttachmentRecord | null>;
  /**
   * Attach an AI-generated meeting summary to a room's call thread as a system
   * message tagged `meet.summary`, so it surfaces in {@link listMeetingsForActor}.
   */
  attachSummary(input: AttachMeetSummaryInput): Promise<MeetSummaryRef | null>;
}

interface MeetRoomRow {
  readonly id: string;
  readonly org_id: string;
  readonly thread_id: string;
  readonly room_name: string;
  readonly join_code: string;
  readonly subject: string;
  readonly jitsi_domain: string;
  readonly created_by_actor_id: string | null;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly scheduled_start_at: Date | null;
  readonly scheduled_end_at: Date | null;
  readonly status: MeetRoomStatus;
  readonly guest_policy: MeetGuestPolicy;
  readonly guest_domains: readonly string[];
  readonly lobby_enabled: boolean;
  readonly host_actor_id?: string | null;
  readonly cohost_actor_ids?: readonly string[];
  readonly locked?: boolean;
  readonly mute_policy?: MeetControlState["mutePolicy"];
  readonly presenter_policy?: MeetControlState["presenterPolicy"];
  readonly presenter_subject?: string | null;
  readonly chat_policy?: MeetControlState["chatPolicy"];
  readonly reaction_policy?: MeetControlState["reactionPolicy"];
  readonly admitted_participant_subjects?: readonly string[];
  readonly banned_participant_subjects?: readonly string[];
  readonly control_version?: string | number;
  readonly recording_active?: boolean;
  readonly metadata: JsonObject;
  readonly recording_artifacts?: readonly MeetRecordingArtifactRow[] | null;
  readonly attendees?: readonly MeetActorRefRow[] | null;
  readonly summaries?: readonly MeetSummaryRow[] | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MeetActorRefRow {
  readonly actorId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string;
}

interface MeetSummaryRow {
  readonly messageId: string;
  readonly body: string;
  readonly createdAt: string | Date;
  readonly metadata: JsonObject;
}

interface MeetRecordingArtifactRow {
  readonly objectId: string;
  readonly messageId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly exportAllowed?: boolean;
  readonly createdAt: string | Date;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly metadata: JsonObject;
}

interface MeetGuestInviteRow {
  readonly id: string;
  readonly org_id: string;
  readonly room_id: string;
  readonly email: string;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly created_by_actor_id: string;
  readonly created_at: Date;
}

interface ExistingRecordingAttachmentRow {
  readonly object_id: string;
  readonly message_id: string;
  readonly storage_key: string;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export class PostgresMeetStore implements MeetStore, MeetMediaWebhookStore {
  constructor(private readonly sql: postgres.Sql) {}

  async claimMediaWebhook(input: {
    readonly id: string;
    readonly expiresAt: Date;
  }): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      with expired as (
        delete from meet_media_webhook_receipts where expires_at <= now()
      )
      insert into meet_media_webhook_receipts (id, expires_at)
      values (${input.id}, ${input.expiresAt})
      on conflict do nothing
      returning id
    `;
    return rows.length === 1;
  }

  async prepareRecordingUpload(
    input: Omit<MeetRecordingUploadRecord, "roomName" | "completedAt">,
  ): Promise<boolean> {
    const rows = await this.sql<{ prepared: boolean }[]>`
      select helix_prepare_meet_recording_upload(
        ${input.id}, ${input.orgId}, ${input.roomId}, ${input.storageKey},
        ${input.mimeType}, ${input.byteSize}, ${input.sha256}, ${input.expiresAt}
      ) as prepared
    `;
    return rows[0]?.prepared === true;
  }

  async getRecordingUpload(id: string): Promise<MeetRecordingUploadRecord | null> {
    const rows = await this.sql<
      {
        id: string;
        org_id: string;
        room_id: string;
        room_name: string;
        storage_key: string;
        mime_type: string;
        byte_size: number;
        sha256: string;
        expires_at: Date;
        completed_at: Date | null;
      }[]
    >`
      select * from helix_get_meet_recording_upload(${id})
    `;
    const row = rows[0];
    return row === undefined
      ? null
      : {
          id: row.id,
          orgId: row.org_id,
          roomId: row.room_id,
          roomName: row.room_name,
          storageKey: row.storage_key,
          mimeType: row.mime_type,
          byteSize: row.byte_size,
          sha256: row.sha256,
          expiresAt: row.expires_at,
          completedAt: row.completed_at,
        };
  }

  async completeRecordingUpload(id: string): Promise<boolean> {
    const rows = await this.sql<{ completed: boolean }[]>`
      select helix_complete_meet_recording_upload(${id}) as completed
    `;
    return rows[0]?.completed === true;
  }

  async markRecordingUploadReady(id: string, validation: JsonObject): Promise<boolean> {
    const rows = await this.sql<{ ready: boolean }[]>`
      select helix_mark_meet_recording_ready(${id}, ${this.sql.json(validation)}) as ready
    `;
    return rows[0]?.ready === true;
  }

  async applyMediaEvent(input: MeetMediaEventInput): Promise<MeetMediaEventResult | null> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const roomRows = await tx<
        {
          readonly id: string;
          readonly room_name: string;
          readonly status: MeetRoomStatus;
          readonly lifecycle_version: string | number;
          readonly active_participant_count: number;
        }[]
      >`
        select id, room_name, status, lifecycle_version, active_participant_count
        from meet_rooms
        where org_id = ${input.orgId} and id = ${input.roomId}
        for update
      `;
      const room = roomRows[0];
      if (
        room === undefined ||
        (input.roomName !== undefined && input.roomName !== room.room_name)
      ) {
        return null;
      }

      const inserted = await tx<{ readonly event_id: string }[]>`
        insert into meet_media_events (
          event_id, org_id, room_id, event_type, session_id, participant_id, occurred_at
        ) values (
          ${input.eventId}, ${input.orgId}, ${input.roomId}, ${input.event},
          ${input.sessionId ?? null}, ${input.participantId ?? null}, ${input.occurredAt}
        )
        on conflict (org_id, event_id) do nothing
        returning event_id
      `;
      if (inserted.length === 0 || room.status === "ended") {
        return {
          roomId: room.id,
          status: room.status,
          version: Number(room.lifecycle_version),
          activeParticipantCount: room.active_participant_count,
          duplicate: inserted.length === 0,
        };
      }

      if (input.event.startsWith("participant.")) {
        const sessionId = requireValue(input.sessionId, "sessionId");
        await tx`
          insert into meet_participant_sessions (
            org_id, room_id, session_id, participant_id, joined_at, left_at
          ) values (
            ${input.orgId}, ${input.roomId}, ${sessionId}, ${input.participantId ?? null},
            ${input.event === "participant.joined" ? input.occurredAt : null},
            ${input.event === "participant.left" ? input.occurredAt : null}
          )
          on conflict (org_id, room_id, session_id) do update set
            participant_id = coalesce(excluded.participant_id, meet_participant_sessions.participant_id),
            joined_at = case when excluded.joined_at is null then meet_participant_sessions.joined_at
              else greatest(excluded.joined_at, meet_participant_sessions.joined_at) end,
            left_at = case when excluded.left_at is null then meet_participant_sessions.left_at
              else greatest(excluded.left_at, meet_participant_sessions.left_at) end,
            updated_at = now()
        `;
      }

      const countRows = await tx<
        {
          readonly active_count: number;
          readonly participant_duration_seconds: number | string | null;
          readonly reconnected: boolean;
        }[]
      >`
        select
          count(*) filter (
            where joined_at is not null and (left_at is null or joined_at > left_at)
          )::integer as active_count,
          max(greatest(0, extract(epoch from left_at - joined_at))) filter (
            where session_id = ${input.sessionId ?? ""}
              and joined_at is not null
              and left_at is not null
          ) as participant_duration_seconds,
          exists (
            select 1
            from meet_participant_sessions prior
            where prior.org_id = ${input.orgId}
              and prior.room_id = ${input.roomId}
              and prior.participant_id = ${input.participantId ?? ""}
              and prior.session_id <> ${input.sessionId ?? ""}
              and prior.left_at is not null
          ) as reconnected
        from meet_participant_sessions
        where org_id = ${input.orgId} and room_id = ${input.roomId}
      `;
      const activeCount = countRows[0]?.active_count ?? 0;
      const participantDuration = countRows[0]?.participant_duration_seconds;
      const ended = input.event === "conference.ended";
      const active = input.event === "conference.started" || input.event === "participant.joined";
      const recordingStarted = input.event === "recording.started";
      const recordingEnded = input.event === "recording.ended";
      const updatedRows = await tx<
        {
          readonly id: string;
          readonly status: MeetRoomStatus;
          readonly lifecycle_version: string | number;
          readonly active_participant_count: number;
        }[]
      >`
        update meet_rooms set
          status = case when ${ended} then 'ended' when ${active} then 'active' else status end,
          started_at = case when ${active} then
            case when status = 'scheduled' then ${input.occurredAt}
              else least(started_at, ${input.occurredAt}) end
            else started_at end,
          ended_at = case when ${ended} then coalesce(ended_at, ${input.occurredAt}) else ended_at end,
          active_participant_count = ${ended ? 0 : activeCount},
          empty_since = case
            when ${ended} or ${activeCount > 0} then null
            when ${input.event === "participant.left"} then coalesce(empty_since, ${input.occurredAt})
            when ${input.event === "conference.started"} then coalesce(empty_since, ${input.occurredAt})
            else empty_since
          end,
          last_media_event_at = greatest(last_media_event_at, ${input.occurredAt}),
          recording_active = case
            when ${recordingStarted} then true
            when ${recordingEnded || ended} then false
            else recording_active end,
          recording_started_at = case
            when ${recordingStarted} then ${input.occurredAt}
            else recording_started_at end,
          lifecycle_version = lifecycle_version + 1,
          updated_at = now()
        where org_id = ${input.orgId} and id = ${input.roomId}
        returning id, status, lifecycle_version, active_participant_count
      `;
      const updated = updatedRows[0];
      if (updated === undefined) return null;
      if (ended) {
        await tx`
          update threads set archived_at = coalesce(archived_at, ${input.occurredAt}), updated_at = now()
          where org_id = ${input.orgId} and id = (
            select thread_id from meet_rooms where org_id = ${input.orgId} and id = ${input.roomId}
          )
        `;
      }
      return {
        roomId: updated.id,
        status: updated.status,
        version: Number(updated.lifecycle_version),
        activeParticipantCount: updated.active_participant_count,
        ...(input.event === "participant.left" &&
        participantDuration !== null &&
        participantDuration !== undefined
          ? { participantDurationSeconds: Number(participantDuration) }
          : {}),
        ...(input.event === "participant.joined" && countRows[0]?.reconnected === true
          ? { reconnected: true }
          : {}),
        duplicate: false,
      };
    });
  }

  async expireEmptyRooms(input: {
    readonly emptyBefore: Date;
    readonly limit: number;
  }): Promise<number> {
    const rows = await this.sql<{ expired: number }[]>`
      select helix_expire_empty_meet_rooms(${input.emptyBefore}, ${input.limit}) as expired
    `;
    return rows[0]?.expired ?? 0;
  }

  async createRoom(input: CreateMeetRoomInput): Promise<MeetRoomRecord> {
    const subject = input.subject.trim();
    if (subject.length === 0) {
      throw new Error("Meet room subject is required.");
    }
    const roomName = normalizeRoomName(input.roomName ?? `${subject}-${randomUUID().slice(0, 8)}`);
    const joinCode = randomJoinCode();
    const guestDomains = normalizeGuestDomains(input.guestDomains ?? []);
    const guestPolicy = input.guestPolicy ?? "disabled";
    if (
      (guestPolicy !== "domain" && guestDomains.length > 0) ||
      guestDomains.length !== new Set(input.guestDomains ?? []).size
    ) {
      throw new TypeError("Meet guest domain policy is invalid.");
    }

    return this.sql.begin(async (tx) => {
      await requireActiveMeetActors(tx, input.orgId, [
        input.actorId,
        ...(input.participantActorIds ?? []),
      ]);
      const threadRows = await tx<{ readonly id: string }[]>`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (
          ${input.orgId},
          'call',
          ${subject},
          ${input.actorId},
          ${tx.json(toSqlJson({ jitsiDomain: input.jitsiDomain, roomName }))}
        )
        returning id
      `;
      const threadId = requireValue(threadRows[0]?.id, "threadId");

      const status = input.status ?? "active";
      const rows = await tx<MeetRoomRow[]>`
        insert into meet_rooms (
          org_id, thread_id, room_name, subject, jitsi_domain, created_by_actor_id,
          join_code, guest_policy, guest_domains, lobby_enabled,
          host_actor_id, admitted_participant_subjects,
          started_at, scheduled_start_at, scheduled_end_at, status, metadata
        )
        values (
          ${input.orgId},
          ${threadId},
          ${roomName},
          ${subject},
          ${input.jitsiDomain},
          ${input.actorId},
          ${joinCode},
          ${guestPolicy},
          ${tx.array([...guestDomains])},
          ${input.lobbyEnabled ?? true},
          ${input.actorId},
          ${tx.array([input.actorId])},
          now(),
          ${input.scheduledStartAt ?? null},
          ${input.scheduledEndAt ?? null},
          ${status},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `;
      const room = mapRoom(rows[0]);

      await grantThreadAccess(tx, input.orgId, threadId, input.actorId, "owner", input.actorId);
      await grantMeetAccess(tx, input.orgId, room.id, input.actorId, "owner", input.actorId);
      for (const participantActorId of new Set(input.participantActorIds ?? [])) {
        await grantThreadAccess(
          tx,
          input.orgId,
          threadId,
          participantActorId,
          "member",
          input.actorId,
        );
        await grantMeetAccess(
          tx,
          input.orgId,
          room.id,
          participantActorId,
          "member",
          input.actorId,
        );
      }
      await appendMeetActivity(tx, input.orgId, input.actorId, "meet.room.created", room.id, {
        threadId,
        roomName,
        subject,
      });
      return room;
    });
  }

  async listRoomsForActor(input: ListMeetRoomsInput): Promise<readonly MeetRoomRecord[]> {
    const rows = await this.sql<MeetRoomRow[]>`
      select r.*, coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'objectId', o.id,
            'messageId', m.id,
            'storageKey', o.storage_key,
            'mimeType', o.mime_type,
            'byteSize', o.byte_size,
            'exportAllowed', coalesce(governance.export_allowed, true),
            'createdAt', o.created_at,
            'startedAt', o.metadata->>'startedAt',
            'endedAt', o.metadata->>'endedAt',
            'metadata', o.metadata
          )
          order by o.created_at desc, o.id desc
        )
        from messages m
        join message_attachments ma on ma.message_id = m.id
        join objects o on o.id = ma.object_id
        left join meet_recording_governance governance
          on governance.org_id = o.org_id and governance.object_id = o.id
        where m.thread_id = r.thread_id
          and m.deleted_at is null
          and o.deleted_at is null
          and o.kind = 'recording'
          and ma.disposition = 'recording'
      ), '[]'::jsonb) as recording_artifacts
      from meet_rooms r
      where r.org_id = ${input.orgId}
        and (${input.status ?? null}::text is null or r.status = ${input.status ?? null})
        and exists (
          select 1 from permissions p
          join actors actor on actor.id = p.actor_id and actor.org_id = p.org_id
          where p.org_id = r.org_id
            and p.resource_type in ('meet_room', 'thread')
            and p.resource_id in (r.id, r.thread_id)
            and p.actor_id = ${input.actorId}
            and actor.disabled_at is null
            and p.status = 'active' and p.revoked_at is null
            and p.valid_from <= now()
            and (p.expires_at is null or p.expires_at > now())
        )
      order by r.created_at desc, r.id desc
      limit ${input.limit}
    `;
    return rows.map(mapRoom);
  }

  async listMeetingsForActor(input: ListMeetMeetingsInput): Promise<readonly MeetMeetingRecord[]> {
    const rows = await this.sql<MeetRoomRow[]>`
      select
        r.*,
        coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'objectId', o.id,
              'messageId', m.id,
              'storageKey', o.storage_key,
              'mimeType', o.mime_type,
              'byteSize', o.byte_size,
              'exportAllowed', coalesce(governance.export_allowed, true),
              'createdAt', o.created_at,
              'startedAt', o.metadata->>'startedAt',
              'endedAt', o.metadata->>'endedAt',
              'metadata', o.metadata
            )
            order by o.created_at desc, o.id desc
          )
          from messages m
          join message_attachments ma on ma.message_id = m.id
          join objects o on o.id = ma.object_id
          left join meet_recording_governance governance
            on governance.org_id = o.org_id and governance.object_id = o.id
          where m.thread_id = r.thread_id
            and m.deleted_at is null
            and o.deleted_at is null
            and o.kind = 'recording'
            and ma.disposition = 'recording'
        ), '[]'::jsonb) as recording_artifacts,
        coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'messageId', m.id,
              'body', m.body,
              'createdAt', m.created_at,
              'metadata', m.metadata
            )
            order by m.created_at desc, m.id desc
          )
          from messages m
          where m.thread_id = r.thread_id
            and m.deleted_at is null
            and m.metadata->>'type' = 'meet.summary'
        ), '[]'::jsonb) as summaries,
        coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'actorId', a.id,
              'displayName', a.display_name,
              'email', a.email,
              'role', p.role
            )
            order by case when p.role = 'owner' then 0 else 1 end, a.display_name nulls last, a.id
          )
          from permissions p
          join actors a on a.id = p.actor_id
          where p.org_id = r.org_id
            and p.resource_type = 'meet_room'
            and p.resource_id = r.id
            and a.disabled_at is null
            and p.status = 'active' and p.revoked_at is null
            and p.valid_from <= now()
            and (p.expires_at is null or p.expires_at > now())
        ), '[]'::jsonb) as attendees
      from meet_rooms r
      where r.org_id = ${input.orgId}
        and (${input.status ?? null}::text is null or r.status = ${input.status ?? null})
        and exists (
          select 1 from permissions p
          join actors actor on actor.id = p.actor_id and actor.org_id = p.org_id
          where p.org_id = r.org_id
            and p.resource_type in ('meet_room', 'thread')
            and p.resource_id in (r.id, r.thread_id)
            and p.actor_id = ${input.actorId}
            and actor.disabled_at is null
            and p.status = 'active' and p.revoked_at is null
            and p.valid_from <= now()
            and (p.expires_at is null or p.expires_at > now())
        )
      order by
        case when r.status = 'scheduled' then 0 else 1 end,
        coalesce(r.scheduled_start_at, r.started_at) desc,
        r.created_at desc,
        r.id desc
      limit ${input.limit}
    `;
    return rows.map(mapMeeting);
  }

  async getRoomForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    return selectRoomForActor(this.sql, input.orgId, input.actorId, input.roomId);
  }

  async getRoomForActorByCode(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly code: string;
  }): Promise<MeetRoomRecord | null> {
    const rows = await this.sql<{ readonly id: string }[]>`
      select id from meet_rooms
      where org_id = ${input.orgId} and join_code = ${input.code}
      limit 1
    `;
    const roomId = rows[0]?.id;
    return roomId === undefined
      ? null
      : selectRoomForActor(this.sql, input.orgId, input.actorId, roomId);
  }

  async createGuestInvite(input: {
    readonly id: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly email: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<MeetGuestInviteRecord | null> {
    const email = input.email.trim().toLowerCase();
    if (input.expiresAt <= new Date()) return null;
    return this.sql.begin(async (tx) => {
      const room = await selectRoomForActor(tx, input.orgId, input.actorId, input.roomId);
      if (
        room === null ||
        room.guestPolicy === "disabled" ||
        !(await canModerateRoom(tx, input.orgId, input.actorId, input.roomId)) ||
        (room.guestPolicy === "domain" && !room.guestDomains.includes(emailDomain(email)))
      ) {
        return null;
      }
      const rows = await tx<MeetGuestInviteRow[]>`
        insert into meet_guest_invites (
          id, org_id, room_id, email, token_hash, expires_at, created_by_actor_id
        ) values (
          ${input.id}, ${input.orgId}, ${input.roomId}, ${email}, ${input.tokenHash},
          ${input.expiresAt}, ${input.actorId}
        )
        returning *
      `;
      const invite = mapGuestInvite(rows[0]);
      await appendMeetActivity(tx, input.orgId, input.actorId, "meet.guest.invited", input.roomId, {
        inviteId: input.id,
        email,
        expiresAt: input.expiresAt.toISOString(),
      });
      return invite;
    });
  }

  async revokeGuestInvite(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly inviteId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const candidates = await tx<{ readonly room_id: string }[]>`
        select room_id from meet_guest_invites
        where org_id = ${input.orgId} and id = ${input.inviteId}
        for update
      `;
      const roomId = candidates[0]?.room_id;
      if (
        roomId === undefined ||
        !(await canModerateRoom(tx, input.orgId, input.actorId, roomId))
      ) {
        return false;
      }
      const rows = await tx`
        update meet_guest_invites set revoked_at = coalesce(revoked_at, now())
        where org_id = ${input.orgId} and id = ${input.inviteId}
        returning id
      `;
      if (rows.length === 0) return false;
      await appendMeetActivity(tx, input.orgId, input.actorId, "meet.guest.revoked", roomId, {
        inviteId: input.inviteId,
      });
      return true;
    });
  }

  resolveGuestInvite(input: {
    readonly inviteId: string;
    readonly orgId: string;
    readonly roomId: string;
    readonly email: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<{ readonly invite: MeetGuestInviteRecord; readonly room: MeetRoomRecord } | null> {
    const email = input.email.trim().toLowerCase();
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx<(MeetGuestInviteRow & { readonly room: MeetRoomRow })[]>`
        select invite.*, row_to_json(room.*) as room
        from meet_guest_invites invite
        join meet_rooms room on room.org_id = invite.org_id and room.id = invite.room_id
        where invite.id = ${input.inviteId}
          and invite.org_id = ${input.orgId}
          and invite.room_id = ${input.roomId}
          and invite.email = ${email}
          and invite.token_hash = ${input.tokenHash}
          and invite.revoked_at is null
          and invite.expires_at > ${input.now}
          and room.status = 'active'
          and room.guest_policy <> 'disabled'
          and (
            room.guest_policy = 'invite'
            or ${emailDomain(email)} = any(room.guest_domains)
          )
        limit 1
      `;
      const row = rows[0];
      return row === undefined ? null : { invite: mapGuestInvite(row), room: mapRoom(row.room) };
    });
  }

  async canModerateRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<boolean> {
    return canModerateRoom(this.sql, input.orgId, input.actorId, input.roomId);
  }

  async authorizeJoin(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly participantSubject: string;
  }): Promise<MeetControlState | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<MeetRoomRow[]>`
        select * from meet_rooms
        where org_id = ${input.orgId} and id = ${input.roomId} and status = 'active'
        for update
      `;
      const row = rows[0];
      if (row === undefined) return null;
      const state = mapControlState(row);
      const subject = requireParticipantSubject(input.participantSubject);
      if (row.banned_participant_subjects?.includes(subject) === true) return null;
      const moderator = state.hostActorId === subject || state.cohostActorIds.includes(subject);
      if (
        state.locked &&
        !moderator &&
        row.admitted_participant_subjects?.includes(subject) !== true
      ) {
        return null;
      }
      if (row.admitted_participant_subjects?.includes(subject) !== true) {
        await tx`
          update meet_rooms set
            admitted_participant_subjects = array_append(admitted_participant_subjects, ${subject}),
            updated_at = now()
          where org_id = ${input.orgId} and id = ${input.roomId}
        `;
      }
      return state;
    });
  }

  async getControlState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetControlState | null> {
    const room = await selectRoomForActor(this.sql, input.orgId, input.actorId, input.roomId);
    if (room === null) return null;
    const rows = await this.sql<MeetRoomRow[]>`
      select * from meet_rooms where org_id = ${input.orgId} and id = ${input.roomId}
    `;
    return rows[0] === undefined ? null : mapControlState(rows[0]);
  }

  async applyControl(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly control: MeetControlAction;
  }): Promise<MeetControlResult | null> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<MeetRoomRow[]>`
        select * from meet_rooms
        where org_id = ${input.orgId} and id = ${input.roomId} and status = 'active'
        for update
      `;
      const row = rows[0];
      if (row === undefined) return null;
      const before = mapControlState(row);
      const isHost = before.hostActorId === input.actorId;
      if (!isHost && !before.cohostActorIds.includes(input.actorId)) return null;

      const control = input.control;
      let auditAction: string;
      let targetSubject: string | null = null;
      let details: JsonObject = {};
      const mediaCommands: MeetControlResult["mediaCommands"][number][] = [];

      if (control.action === "set_lobby") {
        auditAction = "lobby.set";
        details = { enabled: control.enabled };
        await tx`update meet_rooms set lobby_enabled = ${control.enabled} where org_id = ${input.orgId} and id = ${input.roomId}`;
        mediaCommands.push({ command: "toggleLobby", enabled: control.enabled });
      } else if (control.action === "admit") {
        targetSubject = requireParticipantSubject(control.participantSubject);
        if (row.banned_participant_subjects?.includes(targetSubject) === true) return null;
        auditAction = "participant.admit";
        await tx`
          update meet_rooms set admitted_participant_subjects = case
            when ${targetSubject} = any(admitted_participant_subjects) then admitted_participant_subjects
            else array_append(admitted_participant_subjects, ${targetSubject}) end
          where org_id = ${input.orgId} and id = ${input.roomId}
        `;
        mediaCommands.push({
          command: "answerKnockingParticipant",
          participantId: control.mediaParticipantId,
          approved: true,
        });
      } else if (control.action === "set_lock") {
        auditAction = "meeting.lock";
        details = { locked: control.locked };
        await tx`update meet_rooms set locked = ${control.locked} where org_id = ${input.orgId} and id = ${input.roomId}`;
        mediaCommands.push({
          command: "password",
          password: control.locked ? randomBytes(24).toString("base64url") : "",
        });
      } else if (control.action === "remove") {
        targetSubject = requireParticipantSubject(control.participantSubject);
        if (targetSubject === before.hostActorId) return null;
        if (!isHost && before.cohostActorIds.includes(targetSubject)) return null;
        auditAction = control.ban ? "participant.ban" : "participant.remove";
        details = { banned: control.ban };
        await tx`
          update meet_rooms set
            admitted_participant_subjects = array_remove(admitted_participant_subjects, ${targetSubject}),
            banned_participant_subjects = case
              when ${control.ban} and not (${targetSubject} = any(banned_participant_subjects))
                then array_append(banned_participant_subjects, ${targetSubject})
              else banned_participant_subjects end,
            cohost_actor_ids = case
              when ${isHost} and ${isUuid(targetSubject)} then array_remove(cohost_actor_ids, ${isUuid(targetSubject) ? targetSubject : null}::uuid)
              else cohost_actor_ids end
          where org_id = ${input.orgId} and id = ${input.roomId}
        `;
        mediaCommands.push({
          command: "kickParticipant",
          participantId: control.mediaParticipantId,
        });
      } else if (control.action === "set_mute_policy") {
        auditAction = "mute-policy.set";
        details = { policy: control.policy };
        await tx`update meet_rooms set mute_policy = ${control.policy} where org_id = ${input.orgId} and id = ${input.roomId}`;
        for (const mediaType of ["audio", "video"] as const) {
          mediaCommands.push({
            command: "toggleModeration",
            enabled: control.policy === "moderated",
            mediaType,
          });
        }
      } else if (control.action === "mute") {
        targetSubject = requireParticipantSubject(control.participantSubject);
        if (
          targetSubject === before.hostActorId ||
          (!isHost && before.cohostActorIds.includes(targetSubject))
        )
          return null;
        auditAction = "mute-policy.set";
        details = { operation: "mute-participant", mediaType: control.mediaType };
        mediaCommands.push({
          command: "muteRemoteParticipant",
          participantId: control.mediaParticipantId,
          mediaType: control.mediaType,
        });
      } else if (control.action === "set_presenter") {
        targetSubject =
          control.participantSubject === undefined
            ? null
            : requireParticipantSubject(control.participantSubject);
        if (
          control.policy === "selected" &&
          (targetSubject === null || control.mediaParticipantId === undefined)
        )
          return null;
        if (control.policy !== "selected" && targetSubject !== null) return null;
        if (
          targetSubject !== null &&
          (row.banned_participant_subjects?.includes(targetSubject) === true ||
            row.admitted_participant_subjects?.includes(targetSubject) !== true)
        )
          return null;
        auditAction = "presenter-policy.set";
        details = { policy: control.policy };
        await tx`
          update meet_rooms set presenter_policy = ${control.policy}, presenter_subject = ${targetSubject}
          where org_id = ${input.orgId} and id = ${input.roomId}
        `;
        mediaCommands.push({
          command: "toggleModeration",
          enabled: control.policy !== "everyone",
          mediaType: "desktop",
        });
        if (control.policy === "selected") {
          const participantId = control.mediaParticipantId;
          if (participantId === undefined) return null;
          mediaCommands.push({
            command: "approveParticipant",
            participantId,
            mediaType: "desktop",
          });
        }
      } else if (control.action === "set_cohost") {
        if (
          !isHost ||
          control.actorId === before.hostActorId ||
          !(await isRoomMember(tx, input.orgId, input.roomId, control.actorId))
        )
          return null;
        targetSubject = control.actorId;
        auditAction = control.enabled ? "cohost.add" : "cohost.remove";
        details = { enabled: control.enabled };
        await tx`
          update meet_rooms set cohost_actor_ids = case
            when ${control.enabled} and not (${control.actorId}::uuid = any(cohost_actor_ids)) then array_append(cohost_actor_ids, ${control.actorId}::uuid)
            when not ${control.enabled} then array_remove(cohost_actor_ids, ${control.actorId}::uuid)
            else cohost_actor_ids end
          where org_id = ${input.orgId} and id = ${input.roomId}
        `;
        mediaCommands.push(
          control.enabled
            ? { command: "grantModerator", participantId: control.mediaParticipantId }
            : { command: "kickParticipant", participantId: control.mediaParticipantId },
        );
      } else if (control.action === "set_chat_policy") {
        auditAction = "chat-policy.set";
        details = { policy: control.policy };
        await tx`update meet_rooms set chat_policy = ${control.policy} where org_id = ${input.orgId} and id = ${input.roomId}`;
        mediaCommands.push({ command: "setChatPolicy", policy: control.policy });
      } else if (control.action === "set_reaction_policy") {
        auditAction = "reaction-policy.set";
        details = { policy: control.policy };
        await tx`update meet_rooms set reaction_policy = ${control.policy} where org_id = ${input.orgId} and id = ${input.roomId}`;
        mediaCommands.push({ command: "setReactionPolicy", policy: control.policy });
      } else {
        if (
          !isHost ||
          control.actorId === before.hostActorId ||
          row.banned_participant_subjects?.includes(control.actorId) === true ||
          !(await isRoomMember(tx, input.orgId, input.roomId, control.actorId))
        )
          return null;
        targetSubject = control.actorId;
        auditAction = "host.transfer";
        await tx`
          update meet_rooms set
            host_actor_id = ${control.actorId},
            cohost_actor_ids = array_append(
              array_remove(array_remove(cohost_actor_ids, ${control.actorId}::uuid), ${input.actorId}::uuid),
              ${input.actorId}::uuid
            )
          where org_id = ${input.orgId} and id = ${input.roomId}
        `;
        mediaCommands.push({
          command: "grantModerator",
          participantId: control.mediaParticipantId,
        });
      }

      const updatedRows = await tx<MeetRoomRow[]>`
        update meet_rooms set control_version = control_version + 1, updated_at = now()
        where org_id = ${input.orgId} and id = ${input.roomId}
        returning *
      `;
      const state = mapControlState(updatedRows[0]);
      await tx`
        insert into meet_control_events (
          org_id, room_id, actor_id, action, target_subject, control_version, details
        ) values (
          ${input.orgId}, ${input.roomId}, ${input.actorId}, ${auditAction}, ${targetSubject},
          ${state.version}, ${tx.json(toSqlJson(details))}
        )
      `;
      await appendMeetActivity(
        tx,
        input.orgId,
        input.actorId,
        `meet.control.${auditAction}`,
        input.roomId,
        {
          targetSubject,
          controlVersion: state.version,
          ...details,
        },
      );
      return { state, mediaCommands };
    });
  }

  async listAttendance(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly MeetAttendanceRecord[] | null> {
    if (!(await canModerateRoom(this.sql, input.orgId, input.actorId, input.roomId))) return null;
    const rows = await this.sql<
      {
        readonly session_id: string;
        readonly participant_id: string | null;
        readonly joined_at: Date | null;
        readonly left_at: Date | null;
        readonly duration_seconds: string | number | null;
      }[]
    >`
      select session_id, participant_id, joined_at, left_at,
        case when joined_at is null then null else greatest(0, extract(epoch from coalesce(left_at, now()) - joined_at)) end as duration_seconds
      from meet_participant_sessions
      where org_id = ${input.orgId} and room_id = ${input.roomId}
      order by joined_at nulls last, session_id
    `;
    return rows.map((row) => ({
      sessionId: row.session_id,
      participantSubject: row.participant_id,
      joinedAt: row.joined_at,
      leftAt: row.left_at,
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    }));
  }

  async recordMemberRecordingConsent(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly joinGrantId: string;
    readonly deviceId: string;
    readonly expiresAt: Date;
  }): Promise<boolean> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const inserted = await tx<{ readonly id: string }[]>`
          insert into meet_recording_consents (
            id, org_id, room_id, participant_subject, actor_id, device_id,
            notice_version, consent_policy, jurisdiction, evidence, expires_at
          )
          select
            ${input.joinGrantId}, ${input.orgId}, room.id, ${input.actorId}, ${input.actorId},
            ${input.deviceId}, ${MEET_RECORDING_NOTICE_VERSION},
            ${MEET_RECORDING_CONSENT_POLICY}, ${MEET_RECORDING_JURISDICTION},
            ${tx.json({ source: "member-token-mint", noticeAcknowledged: true })},
            ${input.expiresAt}
          from meet_rooms room
          where room.org_id = ${input.orgId}
            and room.id = ${input.roomId}
            and room.status = 'active'
            and ${input.expiresAt} > now()
            and exists (
              select 1 from permissions permission
              join actors actor
                on actor.org_id = permission.org_id
               and actor.id = permission.actor_id
               and actor.disabled_at is null
              where permission.org_id = room.org_id
                and permission.actor_id = ${input.actorId}
                and permission.resource_type in ('meet_room', 'thread')
                and permission.resource_id in (room.id, room.thread_id)
                and permission.status = 'active'
                and permission.revoked_at is null
                and permission.valid_from <= now()
                and (permission.expires_at is null or permission.expires_at > now())
            )
          on conflict do nothing
          returning id
        `;
        if (inserted.length === 0) return false;
        await appendMeetActivity(
          tx,
          input.orgId,
          input.actorId,
          "meet.recording.consent.granted",
          input.roomId,
          {
            joinGrantId: input.joinGrantId,
            deviceId: input.deviceId,
            noticeVersion: MEET_RECORDING_NOTICE_VERSION,
            consentPolicy: MEET_RECORDING_CONSENT_POLICY,
            jurisdiction: MEET_RECORDING_JURISDICTION,
          },
        );
        return true;
      },
    );
  }

  async recordGuestRecordingConsent(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly guestInviteId: string;
    readonly joinGrantId: string;
    readonly deviceId: string;
    readonly expiresAt: Date;
  }): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const participantSubject = `guest:${input.guestInviteId}`;
      const inserted = await tx<{ readonly id: string }[]>`
        insert into meet_recording_consents (
          id, org_id, room_id, participant_subject, guest_invite_id, device_id,
          notice_version, consent_policy, jurisdiction, evidence, expires_at
        )
        select
          ${input.joinGrantId}, invite.org_id, invite.room_id, ${participantSubject}, invite.id,
          ${input.deviceId}, ${MEET_RECORDING_NOTICE_VERSION},
          ${MEET_RECORDING_CONSENT_POLICY}, ${MEET_RECORDING_JURISDICTION},
          ${tx.json({ source: "guest-token-mint", noticeAcknowledged: true })},
          ${input.expiresAt}
        from meet_guest_invites invite
        join meet_rooms room on room.org_id = invite.org_id and room.id = invite.room_id
        where invite.org_id = ${input.orgId}
          and invite.room_id = ${input.roomId}
          and invite.id = ${input.guestInviteId}
          and invite.revoked_at is null
          and invite.expires_at > now()
          and room.status = 'active'
          and ${input.expiresAt} > now()
        on conflict do nothing
        returning id
      `;
      if (inserted.length === 0) return false;
      await appendMeetActivity(
        tx,
        input.orgId,
        null,
        "meet.recording.consent.granted",
        input.roomId,
        {
          joinGrantId: input.joinGrantId,
          deviceId: input.deviceId,
          participantSubject,
          noticeVersion: MEET_RECORDING_NOTICE_VERSION,
          consentPolicy: MEET_RECORDING_CONSENT_POLICY,
          jurisdiction: MEET_RECORDING_JURISDICTION,
        },
      );
      return true;
    });
  }

  async authorizeRecordingStart(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
  }): Promise<MeetRecordingAuthorization | null> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        if (!(await canModerateRoom(tx, input.orgId, input.actorId, input.roomId))) return null;
        const activeRows = await tx<{ readonly participant_id: string | null }[]>`
          select distinct participant_id
          from meet_participant_sessions
          where org_id = ${input.orgId}
            and room_id = ${input.roomId}
            and joined_at is not null
            and (left_at is null or joined_at > left_at)
        `;
        if (activeRows.some((row) => row.participant_id === null)) return null;
        const participantSubjects = [
          ...new Set([
            input.actorId,
            ...activeRows.flatMap((row) =>
              row.participant_id === null ? [] : [row.participant_id],
            ),
          ]),
        ].sort();
        const consentRows = await tx<
          { readonly id: string; readonly participant_subject: string }[]
        >`
          select distinct on (participant_subject) id, participant_subject
          from meet_recording_consents
          where org_id = ${input.orgId}
            and room_id = ${input.roomId}
            and participant_subject = any(${tx.array(participantSubjects)}::text[])
            and notice_version = ${MEET_RECORDING_NOTICE_VERSION}
            and consent_policy = ${MEET_RECORDING_CONSENT_POLICY}
            and jurisdiction = ${MEET_RECORDING_JURISDICTION}
            and expires_at > now()
          order by participant_subject, expires_at desc, consented_at desc
        `;
        const consentByParticipant = new Map(
          consentRows.map((row) => [row.participant_subject, row.id] as const),
        );
        if (participantSubjects.some((subject) => !consentByParticipant.has(subject))) return null;
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + RECORDING_AUTHORIZATION_TTL_MS);
        const consentIds = participantSubjects.map((subject) =>
          requireValue(consentByParticipant.get(subject), "recordingConsentId"),
        );
        const inserted = await tx`
          insert into meet_recording_authorizations (
            id, org_id, room_id, authorized_by_actor_id,
            participant_subjects, consent_ids, expires_at
          )
          select
            ${id}, ${input.orgId}, room.id, ${input.actorId},
            ${tx.array(participantSubjects)}, ${tx.array(consentIds)}::uuid[], ${expiresAt}
          from meet_rooms room
          where room.org_id = ${input.orgId}
            and room.id = ${input.roomId}
            and room.status = 'active'
          returning id
        `;
        if (inserted.length === 0) return null;
        await appendMeetActivity(
          tx,
          input.orgId,
          input.actorId,
          "meet.recording.start.authorized",
          input.roomId,
          {
            authorizationId: id,
            participantSubjects,
            consentIds,
            expiresAt: expiresAt.toISOString(),
          },
        );
        return { id, expiresAt, participantSubjects };
      },
    );
  }

  async claimRecordingStartAuthorization(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly startedAt: Date;
  }): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx`
        with candidate as (
          select id
          from meet_recording_authorizations
          where org_id = ${input.orgId}
            and room_id = ${input.roomId}
            and authorized_at <= ${input.startedAt}
            and expires_at >= ${input.startedAt}
            and claimed_at is null
          order by authorized_at desc
          limit 1
          for update skip locked
        )
        update meet_recording_authorizations as target
        set claimed_at = now()
        from candidate
        where target.id = candidate.id
        returning target.id
      `;
      return rows.length === 1;
    });
  }

  async claimRecordingUploadAuthorization(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly startedAt: Date;
  }): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx`
        with candidate as (
          select auth.id
          from meet_recording_authorizations as auth
          where auth.org_id = ${input.orgId}
            and auth.room_id = ${input.roomId}
            and auth.authorized_at <= ${input.startedAt}
            and auth.expires_at >= ${input.startedAt}
            and auth.claimed_at is not null
            and auth.recording_upload_claimed_at is null
            and exists (
              select 1 from meet_media_events as media_event
              where media_event.org_id = auth.org_id
              and media_event.room_id = auth.room_id
              and media_event.event_type = 'recording.started'
              and media_event.occurred_at between
                ${input.startedAt} - interval '10 seconds'
                and ${input.startedAt} + interval '10 seconds'
            )
          order by auth.authorized_at desc
          limit 1
          for update skip locked
        )
        update meet_recording_authorizations as target
        set recording_upload_claimed_at = now()
        from candidate
        where target.id = candidate.id
        returning target.id
      `;
      return rows.length === 1;
    });
  }

  async getRoomById(input: {
    readonly orgId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
      selectRoomById(tx, input.orgId, input.roomId),
    );
  }

  async getRoomByName(input: {
    readonly orgId: string;
    readonly roomName: string;
  }): Promise<MeetRoomRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx<MeetRoomRow[]>`
        select *
        from meet_rooms
        where org_id = ${input.orgId}
          and room_name = ${input.roomName}
        order by created_at desc
        limit 1
      `;
      return rows[0] === undefined ? null : mapRoom(rows[0]);
    });
  }

  async endRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    if (!(await this.canModerateRoom(input))) {
      return null;
    }
    const rows = await this.sql<MeetRoomRow[]>`
      update meet_rooms
      set status = 'ended', ended_at = coalesce(ended_at, now()),
          active_participant_count = 0, empty_since = null,
          lifecycle_version = lifecycle_version + 1, updated_at = now()
      where id = ${input.roomId}
        and org_id = ${input.orgId}
        and status <> 'ended'
      returning *
    `;
    const room =
      rows[0] === undefined
        ? await selectRoomById(this.sql, input.orgId, input.roomId)
        : mapRoom(rows[0]);
    if (room !== null) {
      if (rows[0] !== undefined) {
        await this.sql`
          update threads
          set archived_at = coalesce(archived_at, now()), updated_at = now()
          where id = ${room.threadId}
        `;
        await appendMeetActivity(this.sql, input.orgId, input.actorId, "meet.room.ended", room.id, {
          threadId: room.threadId,
          roomName: room.roomName,
        });
      }
    }
    return room;
  }

  async attachRecording(
    input: AttachMeetRecordingInput,
  ): Promise<MeetRecordingAttachmentRecord | null> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const room =
        input.roomId === undefined
          ? input.roomName === undefined
            ? null
            : await selectRoomByName(tx, input.orgId, input.roomName)
          : await selectRoomById(tx, input.orgId, input.roomId);
      if (room === null) {
        return null;
      }
      await tx`
        select id
        from meet_rooms
        where id = ${room.id}
          and org_id = ${input.orgId}
        for update
      `;
      const existingRows = await tx<ExistingRecordingAttachmentRow[]>`
        select
          o.id as object_id,
          ma.message_id as message_id,
          o.storage_key as storage_key
        from message_attachments ma
        join messages m on m.id = ma.message_id
        join objects o on o.id = ma.object_id
        where m.org_id = ${input.orgId}
          and m.thread_id = ${room.threadId}
          and ma.disposition = 'recording'
          and o.org_id = ${input.orgId}
          and o.kind = 'recording'
          and o.storage_key = ${input.storageKey}
        order by o.created_at asc
        limit 1
      `;
      const existing = existingRows[0];
      if (existing !== undefined) {
        return {
          roomId: room.id,
          threadId: room.threadId,
          objectId: existing.object_id,
          messageId: existing.message_id,
          storageKey: existing.storage_key,
        };
      }
      const objectId = randomUUID();
      const sha256 = input.sha256 ?? createHash("sha256").update(input.storageKey).digest("hex");
      const byteSize = input.byteSize;
      const mimeType = input.mimeType ?? "video/mp4";
      const governance = recordingGovernance(room.metadata);
      const metadata = {
        ...(input.metadata ?? {}),
        status: "ready",
        immutable: true,
        roomId: room.id,
        threadId: room.threadId,
        roomName: room.roomName,
        startedAt: input.startedAt?.toISOString() ?? null,
        endedAt: input.endedAt?.toISOString() ?? null,
      };

      await tx`
        insert into objects (
          id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256,
          classification, metadata
        )
        values (
          ${objectId},
          ${input.orgId},
          ${input.actorId ?? room.createdByActorId},
          'recording',
          ${input.storageKey},
          ${mimeType},
          ${byteSize},
          ${sha256},
          ${governance.classification},
          ${tx.json(toSqlJson(metadata))}
        )
      `;
      await tx`
        insert into meet_recording_governance (
          org_id, object_id, room_id, thread_id, owner_actor_id, classification,
          region, retention_until, legal_hold, export_allowed
        )
        select
          ${input.orgId}, ${objectId}, ${room.id}, ${room.threadId},
          ${input.actorId ?? room.createdByActorId}, ${governance.classification},
          org.region, ${governance.retentionUntil}, ${governance.legalHold}, ${governance.exportAllowed}
        from orgs org where org.id = ${input.orgId}
      `;
      await commitStorageUsage(tx, input.orgId, objectId, byteSize, "meet_recordings");
      const messageRows = await tx<{ readonly id: string }[]>`
        insert into messages (org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (
          ${input.orgId},
          ${room.threadId},
          ${input.actorId ?? room.createdByActorId},
          'system',
          ${`Recording uploaded for ${room.subject}`},
          'plain',
          ${tx.json(toSqlJson({ type: "meet.recording", objectId, storageKey: input.storageKey }))},
          now()
        )
        returning id
      `;
      const messageId = requireValue(messageRows[0]?.id, "messageId");
      await tx`
        insert into message_attachments (org_id, message_id, object_id, disposition)
        values (${input.orgId}, ${messageId}, ${objectId}, 'recording')
      `;
      await tx`
        update threads
        set updated_at = now()
        where id = ${room.threadId}
      `;
      await appendMeetActivity(
        tx,
        input.orgId,
        input.actorId ?? room.createdByActorId,
        "meet.recording.attached",
        room.id,
        {
          threadId: room.threadId,
          objectId,
          messageId,
          storageKey: input.storageKey,
        },
      );
      // Fan out a notification to every actor with access to the meet_room
      // (host + invited attendees). Same transaction so we don't half-attach.
      const recipientRows = await tx<{ readonly actor_id: string }[]>`
        select distinct p.actor_id
        from permissions p
        where p.org_id = ${input.orgId}
          and p.resource_type in ('meet_room', 'thread')
          and p.resource_id in (${room.id}, ${room.threadId})
      `;
      const recipients = recipientRows.map((row) => row.actor_id);
      if (recipients.length > 0) {
        // Cast the per-row literals to their column types — Postgres infers
        // `text` from a JS string param, but the columns are uuid.
        await tx`
          insert into notifications (
            org_id, actor_id, verb, object_type, object_id, summary, body, payload
          )
          select
            ${input.orgId}::uuid,
            actor_id,
            'meet.recording.attached',
            'meet_room',
            ${room.id}::uuid,
            ${`Recording is ready for "${room.subject}"`},
            null,
            ${tx.json(
              toSqlJson({
                threadId: room.threadId,
                objectId,
                messageId,
                storageKey: input.storageKey,
                roomName: room.roomName,
              }),
            )}
          from unnest(${tx.array([...recipients])}::uuid[]) as actor_id
        `;
      }
      return {
        roomId: room.id,
        threadId: room.threadId,
        objectId,
        messageId,
        storageKey: input.storageKey,
      };
    });
  }

  async attachSummary(input: AttachMeetSummaryInput): Promise<MeetSummaryRef | null> {
    const body = input.body.trim();
    if (body.length === 0) {
      throw new Error("Meet summary body is required.");
    }
    return this.sql.begin(async (tx) => {
      const room = await selectRoomByRef(tx, input.orgId, input);
      if (room === null) {
        return null;
      }
      const metadata: JsonObject = { ...(input.metadata ?? {}), type: "meet.summary" };
      const rows = await tx<
        {
          readonly id: string;
          readonly body: string;
          readonly metadata: JsonObject;
          readonly created_at: Date;
        }[]
      >`
        insert into messages (org_id, thread_id, actor_id, kind, body, body_format, metadata, sent_at)
        values (
          ${input.orgId},
          ${room.threadId},
          ${input.actorId ?? room.createdByActorId},
          'system',
          ${body},
          'markdown',
          ${tx.json(toSqlJson(metadata))},
          now()
        )
        returning id, body, metadata, created_at
      `;
      const summaryRow = rows[0];
      if (summaryRow === undefined) {
        throw new Error("Failed to persist Meet summary.");
      }
      await tx`update threads set updated_at = now() where id = ${room.threadId}`;
      await appendMeetActivity(
        tx,
        input.orgId,
        input.actorId ?? room.createdByActorId,
        "meet.summary.attached",
        room.id,
        { threadId: room.threadId, messageId: summaryRow.id },
      );
      return {
        messageId: summaryRow.id,
        body: summaryRow.body,
        createdAt: summaryRow.created_at,
        metadata: summaryRow.metadata,
      };
    });
  }
}

export class InMemoryMeetStore implements MeetStore {
  readonly #rooms = new Map<string, MeetRoomRecord>();
  readonly #members = new Map<string, Set<string>>();
  readonly #controls = new Map<
    string,
    MeetControlState & {
      readonly admittedParticipantSubjects: readonly string[];
      readonly bannedParticipantSubjects: readonly string[];
    }
  >();
  /** Immutable-by-convention audit projection used by focused unit tests. */
  readonly controlEvents: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly control: MeetControlAction;
    readonly version: number;
  }[] = [];
  readonly #recordingArtifacts = new Map<string, MeetRecordingArtifactRecord[]>();
  readonly #summaries = new Map<string, MeetSummaryRef[]>();
  readonly #guestInvites = new Map<
    string,
    { readonly record: MeetGuestInviteRecord; readonly tokenHash: string }
  >();
  readonly #recordingConsents = new Map<
    string,
    {
      readonly roomId: string;
      readonly participantSubject: string;
      readonly deviceId: string;
      readonly expiresAt: Date;
    }
  >();
  readonly #recordingAuthorizations: {
    readonly roomId: string;
    readonly authorizedAt: Date;
    readonly expiresAt: Date;
    claimed: boolean;
    uploadClaimed: boolean;
  }[] = [];
  /** Optional actor identity directory used to populate host/attendee refs. */
  readonly #actors = new Map<string, { displayName: string | null; email: string | null }>();
  #recordingCounter = 1;

  /** Seed actor identities so the in-memory store can project host/attendee names. */
  registerActor(actorId: string, identity: { displayName?: string; email?: string }): void {
    this.#actors.set(actorId, {
      displayName: identity.displayName ?? null,
      email: identity.email ?? null,
    });
  }

  async createRoom(input: CreateMeetRoomInput): Promise<MeetRoomRecord> {
    const subject = input.subject.trim();
    if (subject.length === 0) {
      throw new Error("Meet room subject is required.");
    }
    const now = new Date();
    const roomName = normalizeRoomName(input.roomName ?? `${subject}-${randomUUID().slice(0, 8)}`);
    const room: MeetRoomRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      threadId: randomUUID(),
      roomName,
      joinCode: randomJoinCode(),
      subject,
      jitsiDomain: input.jitsiDomain,
      createdByActorId: input.actorId,
      startedAt: now,
      endedAt: null,
      scheduledStartAt: input.scheduledStartAt ?? null,
      scheduledEndAt: input.scheduledEndAt ?? null,
      status: input.status ?? "active",
      guestPolicy: input.guestPolicy ?? "disabled",
      guestDomains: normalizeGuestDomains(input.guestDomains ?? []),
      lobbyEnabled: input.lobbyEnabled ?? true,
      recordingActive: false,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.#rooms.set(room.id, room);
    this.#members.set(room.id, new Set([input.actorId, ...(input.participantActorIds ?? [])]));
    this.#controls.set(room.id, {
      roomId: room.id,
      hostActorId: input.actorId,
      cohostActorIds: [],
      lobbyEnabled: room.lobbyEnabled,
      locked: false,
      mutePolicy: "open",
      presenterPolicy: "everyone",
      presenterSubject: null,
      chatPolicy: "everyone",
      reactionPolicy: "everyone",
      version: 1,
      admittedParticipantSubjects: [input.actorId],
      bannedParticipantSubjects: [],
    });
    return room;
  }

  async listMeetingsForActor(input: ListMeetMeetingsInput): Promise<readonly MeetMeetingRecord[]> {
    return [...this.#rooms.values()]
      .filter((room) => room.orgId === input.orgId)
      .filter((room) => input.status === undefined || room.status === input.status)
      .filter((room) => this.#members.get(room.id)?.has(input.actorId) === true)
      .sort((left, right) => {
        const leftScheduled = left.status === "scheduled" ? 0 : 1;
        const rightScheduled = right.status === "scheduled" ? 0 : 1;
        if (leftScheduled !== rightScheduled) {
          return leftScheduled - rightScheduled;
        }
        const leftAt = (left.scheduledStartAt ?? left.startedAt).getTime();
        const rightAt = (right.scheduledStartAt ?? right.startedAt).getTime();
        return rightAt - leftAt || right.id.localeCompare(left.id);
      })
      .slice(0, input.limit)
      .map((room) => this.#toMeeting(room));
  }

  async getRoomForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    const room = this.#rooms.get(input.roomId);
    if (room === undefined || room.orgId !== input.orgId) {
      return null;
    }
    return this.#members.get(input.roomId)?.has(input.actorId) === true
      ? this.#withRecordingArtifacts(room)
      : null;
  }

  async getRoomForActorByCode(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly code: string;
  }): Promise<MeetRoomRecord | null> {
    const room = [...this.#rooms.values()].find(
      ({ orgId, joinCode }) => orgId === input.orgId && joinCode === input.code,
    );
    return room === undefined ? null : this.getRoomForActor({ ...input, roomId: room.id });
  }

  async createGuestInvite(input: {
    readonly id: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly email: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
  }): Promise<MeetGuestInviteRecord | null> {
    const room = this.#rooms.get(input.roomId);
    const email = input.email.trim().toLowerCase();
    if (
      room?.orgId !== input.orgId ||
      room.createdByActorId !== input.actorId ||
      room.guestPolicy === "disabled" ||
      (room.guestPolicy === "domain" && !room.guestDomains.includes(emailDomain(email)))
    ) {
      return null;
    }
    const record: MeetGuestInviteRecord = {
      id: input.id,
      orgId: input.orgId,
      roomId: input.roomId,
      email,
      expiresAt: input.expiresAt,
      revokedAt: null,
      createdByActorId: input.actorId,
      createdAt: new Date(),
    };
    this.#guestInvites.set(record.id, { record, tokenHash: input.tokenHash });
    return record;
  }

  async revokeGuestInvite(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly inviteId: string;
  }): Promise<boolean> {
    const stored = this.#guestInvites.get(input.inviteId);
    const room = stored === undefined ? undefined : this.#rooms.get(stored.record.roomId);
    if (
      stored === undefined ||
      room?.orgId !== input.orgId ||
      room.createdByActorId !== input.actorId
    ) {
      return false;
    }
    this.#guestInvites.set(input.inviteId, {
      ...stored,
      record: { ...stored.record, revokedAt: stored.record.revokedAt ?? new Date() },
    });
    return true;
  }

  resolveGuestInvite(input: {
    readonly inviteId: string;
    readonly orgId: string;
    readonly roomId: string;
    readonly email: string;
    readonly tokenHash: string;
    readonly now: Date;
  }): Promise<{ readonly invite: MeetGuestInviteRecord; readonly room: MeetRoomRecord } | null> {
    const stored = this.#guestInvites.get(input.inviteId);
    const room = this.#rooms.get(input.roomId);
    const email = input.email.trim().toLowerCase();
    const valid =
      stored !== undefined &&
      room !== undefined &&
      stored.record.orgId === input.orgId &&
      stored.record.roomId === input.roomId &&
      stored.record.email === email &&
      stored.tokenHash === input.tokenHash &&
      stored.record.revokedAt === null &&
      stored.record.expiresAt > input.now &&
      room.status === "active" &&
      room.guestPolicy !== "disabled" &&
      (room.guestPolicy === "invite" || room.guestDomains.includes(emailDomain(email)));
    if (!valid) return Promise.resolve(null);
    return Promise.resolve({ invite: stored.record, room });
  }

  async recordMemberRecordingConsent(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
    readonly joinGrantId: string;
    readonly deviceId: string;
    readonly expiresAt: Date;
  }): Promise<boolean> {
    const room = await this.getRoomForActor(input);
    if (
      room?.status !== "active" ||
      input.expiresAt <= new Date() ||
      this.#recordingConsents.has(input.joinGrantId)
    ) {
      return false;
    }
    this.#recordingConsents.set(input.joinGrantId, {
      roomId: input.roomId,
      participantSubject: input.actorId,
      deviceId: input.deviceId,
      expiresAt: input.expiresAt,
    });
    return true;
  }

  async recordGuestRecordingConsent(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly guestInviteId: string;
    readonly joinGrantId: string;
    readonly deviceId: string;
    readonly expiresAt: Date;
  }): Promise<boolean> {
    const invite = this.#guestInvites.get(input.guestInviteId);
    const room = this.#rooms.get(input.roomId);
    if (
      invite?.record.orgId !== input.orgId ||
      invite.record.roomId !== input.roomId ||
      invite.record.revokedAt !== null ||
      invite.record.expiresAt <= new Date() ||
      room?.status !== "active" ||
      input.expiresAt <= new Date() ||
      this.#recordingConsents.has(input.joinGrantId)
    ) {
      return false;
    }
    this.#recordingConsents.set(input.joinGrantId, {
      roomId: input.roomId,
      participantSubject: `guest:${input.guestInviteId}`,
      deviceId: input.deviceId,
      expiresAt: input.expiresAt,
    });
    return true;
  }

  async authorizeRecordingStart(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly actorId: string;
  }): Promise<MeetRecordingAuthorization | null> {
    const room = this.#rooms.get(input.roomId);
    if (room?.status !== "active" || !(await this.canModerateRoom(input))) return null;
    const consented = [...this.#recordingConsents.entries()].find(
      ([, consent]) =>
        consent.roomId === input.roomId &&
        consent.participantSubject === input.actorId &&
        consent.expiresAt > new Date(),
    );
    if (consented === undefined) return null;
    const authorization = {
      id: randomUUID(),
      expiresAt: new Date(Date.now() + RECORDING_AUTHORIZATION_TTL_MS),
      participantSubjects: [input.actorId],
    };
    this.#recordingAuthorizations.push({
      roomId: input.roomId,
      authorizedAt: new Date(),
      expiresAt: authorization.expiresAt,
      claimed: false,
      uploadClaimed: false,
    });
    return authorization;
  }

  async claimRecordingStartAuthorization(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly startedAt: Date;
  }): Promise<boolean> {
    if (this.#rooms.get(input.roomId)?.orgId !== input.orgId) return false;
    const authorization = this.#recordingAuthorizations.find(
      (candidate) =>
        candidate.roomId === input.roomId &&
        !candidate.claimed &&
        candidate.authorizedAt <= input.startedAt &&
        candidate.expiresAt >= input.startedAt,
    );
    if (authorization === undefined) return false;
    authorization.claimed = true;
    return true;
  }

  async claimRecordingUploadAuthorization(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly startedAt: Date;
  }): Promise<boolean> {
    if (this.#rooms.get(input.roomId)?.orgId !== input.orgId) return false;
    const authorization = this.#recordingAuthorizations.find(
      (candidate) =>
        candidate.roomId === input.roomId &&
        candidate.claimed &&
        !candidate.uploadClaimed &&
        candidate.authorizedAt <= input.startedAt &&
        candidate.expiresAt >= input.startedAt,
    );
    if (authorization === undefined) return false;
    authorization.uploadClaimed = true;
    return true;
  }

  async canModerateRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<boolean> {
    const room = this.#rooms.get(input.roomId);
    const control = this.#controls.get(input.roomId);
    return (
      room?.orgId === input.orgId &&
      (control?.hostActorId === input.actorId ||
        control?.cohostActorIds.includes(input.actorId) === true)
    );
  }

  async authorizeJoin(input: {
    readonly orgId: string;
    readonly roomId: string;
    readonly participantSubject: string;
  }): Promise<MeetControlState | null> {
    const room = this.#rooms.get(input.roomId);
    const control = this.#controls.get(input.roomId);
    const subject = requireParticipantSubject(input.participantSubject);
    if (room?.orgId !== input.orgId || room.status !== "active" || control === undefined)
      return null;
    if (control.bannedParticipantSubjects.includes(subject)) return null;
    const moderator = control.hostActorId === subject || control.cohostActorIds.includes(subject);
    if (control.locked && !moderator && !control.admittedParticipantSubjects.includes(subject))
      return null;
    if (!control.admittedParticipantSubjects.includes(subject)) {
      this.#controls.set(input.roomId, {
        ...control,
        admittedParticipantSubjects: [...control.admittedParticipantSubjects, subject],
      });
    }
    return publicControlState(control);
  }

  async getControlState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetControlState | null> {
    if ((await this.getRoomForActor(input)) === null) return null;
    const control = this.#controls.get(input.roomId);
    return control === undefined ? null : publicControlState(control);
  }

  async applyControl(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
    readonly control: MeetControlAction;
  }): Promise<MeetControlResult | null> {
    const room = this.#rooms.get(input.roomId);
    const before = this.#controls.get(input.roomId);
    if (room?.orgId !== input.orgId || room.status !== "active" || before === undefined)
      return null;
    const isHost = before.hostActorId === input.actorId;
    if (!isHost && !before.cohostActorIds.includes(input.actorId)) return null;
    const action = input.control;
    const commands: MeetControlResult["mediaCommands"][number][] = [];
    let next = before;
    if (action.action === "set_lobby") {
      next = { ...next, lobbyEnabled: action.enabled };
      commands.push({ command: "toggleLobby", enabled: action.enabled });
    } else if (action.action === "admit") {
      const subject = requireParticipantSubject(action.participantSubject);
      if (next.bannedParticipantSubjects.includes(subject)) return null;
      next = {
        ...next,
        admittedParticipantSubjects: unique([...next.admittedParticipantSubjects, subject]),
      };
      commands.push({
        command: "answerKnockingParticipant",
        participantId: action.mediaParticipantId,
        approved: true,
      });
    } else if (action.action === "set_lock") {
      next = { ...next, locked: action.locked };
      commands.push({
        command: "password",
        password: action.locked ? randomBytes(24).toString("base64url") : "",
      });
    } else if (action.action === "remove") {
      const subject = requireParticipantSubject(action.participantSubject);
      if (subject === next.hostActorId || (!isHost && next.cohostActorIds.includes(subject)))
        return null;
      next = {
        ...next,
        admittedParticipantSubjects: next.admittedParticipantSubjects.filter(
          (value) => value !== subject,
        ),
        bannedParticipantSubjects: action.ban
          ? unique([...next.bannedParticipantSubjects, subject])
          : next.bannedParticipantSubjects,
        cohostActorIds: isHost
          ? next.cohostActorIds.filter((value) => value !== subject)
          : next.cohostActorIds,
      };
      commands.push({ command: "kickParticipant", participantId: action.mediaParticipantId });
    } else if (action.action === "set_mute_policy") {
      next = { ...next, mutePolicy: action.policy };
      for (const mediaType of ["audio", "video"] as const)
        commands.push({
          command: "toggleModeration",
          enabled: action.policy === "moderated",
          mediaType,
        });
    } else if (action.action === "mute") {
      if (
        action.participantSubject === next.hostActorId ||
        (!isHost && next.cohostActorIds.includes(action.participantSubject))
      )
        return null;
      commands.push({
        command: "muteRemoteParticipant",
        participantId: action.mediaParticipantId,
        mediaType: action.mediaType,
      });
    } else if (action.action === "set_presenter") {
      const subject =
        action.participantSubject === undefined
          ? null
          : requireParticipantSubject(action.participantSubject);
      if (
        (action.policy === "selected") !==
        (subject !== null && action.mediaParticipantId !== undefined)
      )
        return null;
      if (
        subject !== null &&
        (next.bannedParticipantSubjects.includes(subject) ||
          !next.admittedParticipantSubjects.includes(subject))
      )
        return null;
      next = { ...next, presenterPolicy: action.policy, presenterSubject: subject };
      commands.push({
        command: "toggleModeration",
        enabled: action.policy !== "everyone",
        mediaType: "desktop",
      });
      if (action.policy === "selected")
        if (action.mediaParticipantId !== undefined) {
          commands.push({
            command: "approveParticipant",
            participantId: action.mediaParticipantId,
            mediaType: "desktop",
          });
        }
    } else if (action.action === "set_cohost") {
      if (
        !isHost ||
        action.actorId === next.hostActorId ||
        this.#members.get(input.roomId)?.has(action.actorId) !== true
      )
        return null;
      next = {
        ...next,
        cohostActorIds: action.enabled
          ? unique([...next.cohostActorIds, action.actorId])
          : next.cohostActorIds.filter((value) => value !== action.actorId),
      };
      commands.push(
        action.enabled
          ? { command: "grantModerator", participantId: action.mediaParticipantId }
          : { command: "kickParticipant", participantId: action.mediaParticipantId },
      );
    } else if (action.action === "set_chat_policy") {
      next = { ...next, chatPolicy: action.policy };
      commands.push({ command: "setChatPolicy", policy: action.policy });
    } else if (action.action === "set_reaction_policy") {
      next = { ...next, reactionPolicy: action.policy };
      commands.push({ command: "setReactionPolicy", policy: action.policy });
    } else {
      if (
        !isHost ||
        action.actorId === next.hostActorId ||
        next.bannedParticipantSubjects.includes(action.actorId) ||
        this.#members.get(input.roomId)?.has(action.actorId) !== true
      )
        return null;
      next = {
        ...next,
        hostActorId: action.actorId,
        cohostActorIds: unique([
          ...next.cohostActorIds.filter((value) => value !== action.actorId),
          input.actorId,
        ]),
      };
      commands.push({ command: "grantModerator", participantId: action.mediaParticipantId });
    }
    next = { ...next, version: next.version + 1 };
    this.#controls.set(input.roomId, next);
    this.controlEvents.push({
      orgId: input.orgId,
      roomId: input.roomId,
      actorId: input.actorId,
      control: action,
      version: next.version,
    });
    return { state: publicControlState(next), mediaCommands: commands };
  }

  async listAttendance(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<readonly MeetAttendanceRecord[] | null> {
    return (await this.canModerateRoom(input)) ? [] : null;
  }

  async getRoomById(input: {
    readonly orgId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    const room = this.#rooms.get(input.roomId);
    return room === undefined || room.orgId !== input.orgId
      ? null
      : this.#withRecordingArtifacts(room);
  }

  async listRoomsForActor(input: ListMeetRoomsInput): Promise<readonly MeetRoomRecord[]> {
    return [...this.#rooms.values()]
      .filter((room) => room.orgId === input.orgId)
      .filter((room) => input.status === undefined || room.status === input.status)
      .filter((room) => this.#members.get(room.id)?.has(input.actorId) === true)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id),
      )
      .slice(0, input.limit)
      .map((room) => this.#withRecordingArtifacts(room));
  }

  async getRoomByName(input: {
    readonly orgId: string;
    readonly roomName: string;
  }): Promise<MeetRoomRecord | null> {
    for (const room of this.#rooms.values()) {
      if (room.orgId === input.orgId && room.roomName === input.roomName) {
        return this.#withRecordingArtifacts(room);
      }
    }
    return null;
  }

  async endRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    if (!(await this.canModerateRoom(input))) {
      return null;
    }
    const room = this.#rooms.get(input.roomId);
    if (room === undefined) return null;
    if (room.status === "ended") return this.#withRecordingArtifacts(room);
    const now = new Date();
    const ended: MeetRoomRecord = {
      ...room,
      status: "ended",
      endedAt: room.endedAt ?? now,
      updatedAt: now,
    };
    this.#rooms.set(room.id, ended);
    return ended;
  }

  async attachRecording(
    input: AttachMeetRecordingInput,
  ): Promise<MeetRecordingAttachmentRecord | null> {
    const room = await this.#resolveRoomByRef(input.orgId, input);
    if (room === null || room.orgId !== input.orgId) {
      return null;
    }
    const artifacts = this.#recordingArtifacts.get(room.id) ?? [];
    const alreadyAttached = artifacts.find((artifact) => artifact.storageKey === input.storageKey);
    if (alreadyAttached !== undefined) {
      return {
        roomId: room.id,
        threadId: room.threadId,
        objectId: alreadyAttached.objectId,
        messageId: alreadyAttached.messageId,
        storageKey: alreadyAttached.storageKey,
      };
    }
    const suffix = String(this.#recordingCounter);
    this.#recordingCounter += 1;
    const objectId = randomUUID();
    const messageId = randomUUID();
    const storageKey = input.storageKey || `recordings/${room.id}/${suffix}.mp4`;
    const now = new Date();
    const artifact: MeetRecordingArtifactRecord = {
      objectId,
      messageId,
      storageKey,
      mimeType: input.mimeType ?? "video/mp4",
      byteSize: input.byteSize,
      exportAllowed: true,
      createdAt: now,
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      metadata: input.metadata ?? {},
    };
    this.#recordingArtifacts.set(room.id, [artifact, ...artifacts]);
    return {
      roomId: room.id,
      threadId: room.threadId,
      objectId,
      messageId,
      storageKey,
    };
  }

  async attachSummary(input: AttachMeetSummaryInput): Promise<MeetSummaryRef | null> {
    const body = input.body.trim();
    if (body.length === 0) {
      throw new Error("Meet summary body is required.");
    }
    const room = await this.#resolveRoomByRef(input.orgId, input);
    if (room === null || room.orgId !== input.orgId) {
      return null;
    }
    const summary: MeetSummaryRef = {
      messageId: randomUUID(),
      body,
      createdAt: new Date(),
      metadata: { ...(input.metadata ?? {}), type: "meet.summary" },
    };
    const existing = this.#summaries.get(room.id) ?? [];
    this.#summaries.set(room.id, [summary, ...existing]);
    return summary;
  }

  /**
   * Resolve the room a recording/summary attachment targets. Callers may address
   * a room by id or by name; id wins when both are supplied. The id lookup is not
   * org-scoped here — callers re-check `orgId` on the result.
   */
  async #resolveRoomByRef(
    orgId: string,
    ref: { readonly roomId?: string | undefined; readonly roomName?: string | undefined },
  ): Promise<MeetRoomRecord | null> {
    if (ref.roomId !== undefined) {
      return this.#rooms.get(ref.roomId) ?? null;
    }
    if (ref.roomName !== undefined) {
      return this.getRoomByName({ orgId, roomName: ref.roomName });
    }
    return null;
  }

  #withRecordingArtifacts(room: MeetRoomRecord): MeetRoomRecord {
    return {
      ...room,
      recordingArtifacts: this.#recordingArtifacts.get(room.id) ?? [],
    };
  }

  #actorRef(actorId: string, role: string): MeetActorRef {
    const identity = this.#actors.get(actorId);
    return {
      actorId,
      displayName: identity?.displayName ?? null,
      email: identity?.email ?? null,
      role,
    };
  }

  #toMeeting(room: MeetRoomRecord): MeetMeetingRecord {
    const memberIds = [...(this.#members.get(room.id) ?? new Set<string>())];
    const hostId = room.createdByActorId;
    const attendees = memberIds.map((actorId) =>
      this.#actorRef(actorId, actorId === hostId ? "owner" : "member"),
    );
    const host = hostId === null ? null : this.#actorRef(hostId, "owner");
    const recordingArtifacts = this.#recordingArtifacts.get(room.id) ?? [];
    const summaries = this.#summaries.get(room.id) ?? [];
    return {
      id: room.id,
      orgId: room.orgId,
      threadId: room.threadId,
      roomName: room.roomName,
      subject: room.subject,
      jitsiDomain: room.jitsiDomain,
      status: room.status,
      code: room.joinCode,
      host,
      attendees,
      attendeeCount: attendees.length,
      startedAt: room.status === "scheduled" ? null : room.startedAt,
      endedAt: room.endedAt,
      scheduledStartAt: room.scheduledStartAt,
      scheduledEndAt: room.scheduledEndAt,
      durationSeconds: computeDurationSeconds(room),
      recordingArtifacts,
      summaries,
      metadata: room.metadata,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
    };
  }
}

async function selectRoomForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  roomId: string,
): Promise<MeetRoomRecord | null> {
  const rows = await sql<MeetRoomRow[]>`
    select r.*
    from meet_rooms r
    join threads t on t.id = r.thread_id
    where r.id = ${roomId}
      and r.org_id = ${orgId}
      and exists (
        select 1
        from permissions p
        join actors actor
          on actor.id = p.actor_id
         and actor.org_id = p.org_id
         and actor.disabled_at is null
        where p.resource_type in ('meet_room', 'thread')
          and p.resource_id in (r.id, r.thread_id)
          and p.org_id = ${orgId}
          and p.actor_id = ${actorId}
          and p.role in ('owner', 'moderator', 'cohost', 'member')
          and p.status = 'active'
          and p.revoked_at is null
          and p.valid_from <= now()
          and (p.expires_at is null or p.expires_at > now())
      )
    limit 1
  `;
  return rows[0] === undefined ? null : mapRoom(rows[0]);
}

async function canModerateRoom(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  roomId: string,
): Promise<boolean> {
  const rows = await sql`
    select r.id
    from meet_rooms r
    join actors actor
      on actor.id = ${actorId}
     and actor.org_id = r.org_id
     and actor.disabled_at is null
    where r.id = ${roomId}
      and r.org_id = ${orgId}
      and (${actorId}::uuid = r.host_actor_id or ${actorId}::uuid = any(r.cohost_actor_ids))
    limit 1
  `;
  return rows.length > 0;
}

function mapControlState(row: MeetRoomRow | undefined): MeetControlState {
  if (row === undefined) throw new Error("Meet control state was not returned.");
  return {
    roomId: row.id,
    hostActorId: row.host_actor_id ?? row.created_by_actor_id,
    cohostActorIds: row.cohost_actor_ids ?? [],
    lobbyEnabled: row.lobby_enabled,
    locked: row.locked ?? false,
    mutePolicy: row.mute_policy ?? "open",
    presenterPolicy: row.presenter_policy ?? "everyone",
    presenterSubject: row.presenter_subject ?? null,
    chatPolicy: row.chat_policy ?? "everyone",
    reactionPolicy: row.reaction_policy ?? "everyone",
    version: Number(row.control_version ?? 1),
  };
}

function publicControlState(
  state: MeetControlState & {
    readonly admittedParticipantSubjects?: readonly string[];
    readonly bannedParticipantSubjects?: readonly string[];
  },
): MeetControlState {
  return {
    roomId: state.roomId,
    hostActorId: state.hostActorId,
    cohostActorIds: state.cohostActorIds,
    lobbyEnabled: state.lobbyEnabled,
    locked: state.locked,
    mutePolicy: state.mutePolicy,
    presenterPolicy: state.presenterPolicy,
    presenterSubject: state.presenterSubject,
    chatPolicy: state.chatPolicy,
    reactionPolicy: state.reactionPolicy,
    version: state.version,
  };
}

function requireParticipantSubject(value: string): string {
  const subject = value.trim();
  if (subject.length === 0 || subject.length > 200 || hasControlCharacter(subject)) {
    throw new TypeError("Invalid meeting participant subject.");
  }
  return subject;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

async function isRoomMember(
  sql: SqlLike,
  orgId: string,
  roomId: string,
  actorId: string,
): Promise<boolean> {
  const rows = await sql`
    select 1 from permissions permission
    join actors actor on actor.org_id = permission.org_id and actor.id = permission.actor_id
    where permission.org_id = ${orgId} and permission.actor_id = ${actorId}
      and permission.resource_type = 'meet_room' and permission.resource_id = ${roomId}
      and permission.status = 'active' and permission.revoked_at is null
      and permission.valid_from <= now() and (permission.expires_at is null or permission.expires_at > now())
      and actor.disabled_at is null
    limit 1
  `;
  return rows.length > 0;
}

async function selectRoomById(
  sql: SqlLike,
  orgId: string,
  roomId: string,
): Promise<MeetRoomRecord | null> {
  const rows = await sql<MeetRoomRow[]>`
    select *
    from meet_rooms
    where id = ${roomId}
      and org_id = ${orgId}
    limit 1
  `;
  return rows[0] === undefined ? null : mapRoom(rows[0]);
}

async function selectRoomByName(
  sql: SqlLike,
  orgId: string,
  roomName: string,
): Promise<MeetRoomRecord | null> {
  const rows = await sql<MeetRoomRow[]>`
    select *
    from meet_rooms
    where org_id = ${orgId}
      and room_name = ${roomName}
    order by created_at desc
    limit 1
  `;
  return rows[0] === undefined ? null : mapRoom(rows[0]);
}

/**
 * Resolve the room a recording/summary attachment targets. Callers may address a
 * room by id or by name; id wins when both are supplied.
 */
async function selectRoomByRef(
  sql: SqlLike,
  orgId: string,
  ref: { readonly roomId?: string | undefined; readonly roomName?: string | undefined },
): Promise<MeetRoomRecord | null> {
  if (ref.roomId !== undefined) {
    return selectRoomById(sql, orgId, ref.roomId);
  }
  if (ref.roomName !== undefined) {
    return selectRoomByName(sql, orgId, ref.roomName);
  }
  return null;
}

async function grantThreadAccess(
  sql: SqlLike,
  orgId: string,
  threadId: string,
  actorId: string,
  role: string,
  grantedByActorId: string,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, 'thread', ${threadId}, ${role}, ${grantedByActorId})
    on conflict do nothing
  `;
}

async function grantMeetAccess(
  sql: SqlLike,
  orgId: string,
  roomId: string,
  actorId: string,
  role: string,
  grantedByActorId: string,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${orgId}, ${actorId}, 'meet_room', ${roomId}, ${role}, ${grantedByActorId})
    on conflict do nothing
  `;
}

async function appendMeetActivity(
  sql: SqlLike,
  orgId: string,
  actorId: string | null,
  verb: string,
  roomId: string,
  payload: JsonObject,
): Promise<void> {
  const hash = createHash("sha256")
    .update(`${orgId}:${actorId ?? "system"}:${verb}:${roomId}:${String(Date.now())}`)
    .digest("hex");
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (${orgId}, ${actorId}, ${verb}, 'meet_room', ${roomId}, ${sql.json(toSqlJson(payload))}, null, ${hash})
  `;
}

function normalizeRoomName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return normalized.length === 0 ? `helix-${randomUUID().slice(0, 8)}` : normalized;
}

function recordingGovernance(metadata: JsonObject): {
  readonly classification: "public" | "standard" | "confidential" | "restricted";
  readonly retentionUntil: Date | null;
  readonly legalHold: boolean;
  readonly exportAllowed: boolean;
} {
  const rawClassification = metadata.classification;
  const classification: DataClassification =
    rawClassification === "public" ||
    rawClassification === "confidential" ||
    rawClassification === "restricted"
      ? rawClassification
      : "standard";
  const label = sensitivityLabelFor(classification);
  const configuredRetention = metadata.retentionUntil;
  const configuredRetentionAt =
    typeof configuredRetention === "string" && Number.isFinite(Date.parse(configuredRetention))
      ? Date.parse(configuredRetention)
      : 0;
  const labelRetentionAt =
    label.retentionDays === 0 ? 0 : Date.now() + label.retentionDays * 24 * 60 * 60 * 1_000;
  return {
    classification,
    retentionUntil:
      Math.max(configuredRetentionAt, labelRetentionAt) === 0
        ? null
        : new Date(Math.max(configuredRetentionAt, labelRetentionAt)),
    legalHold: metadata.legalHold === true,
    exportAllowed: metadata.exportAllowed !== false && label.recordingExport,
  };
}

function mapRoom(row: MeetRoomRow | undefined): MeetRoomRecord {
  if (row === undefined) {
    throw new Error("Expected Meet room row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    threadId: row.thread_id,
    roomName: row.room_name,
    joinCode: row.join_code,
    subject: row.subject,
    jitsiDomain: row.jitsi_domain,
    createdByActorId: row.created_by_actor_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    scheduledStartAt: row.scheduled_start_at ?? null,
    scheduledEndAt: row.scheduled_end_at ?? null,
    status: row.status,
    guestPolicy: row.guest_policy,
    guestDomains: row.guest_domains,
    lobbyEnabled: row.lobby_enabled,
    recordingActive: row.recording_active ?? false,
    metadata: row.metadata,
    recordingArtifacts: (row.recording_artifacts ?? []).map(mapRecordingArtifact),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMeeting(row: MeetRoomRow | undefined): MeetMeetingRecord {
  if (row === undefined) {
    throw new Error("Expected Meet room row.");
  }
  const attendees = (row.attendees ?? []).map(mapActorRef);
  const host = attendees.find((attendee) => attendee.role === "owner") ?? null;
  const startedAt = row.status === "scheduled" ? null : row.started_at;
  return {
    id: row.id,
    orgId: row.org_id,
    threadId: row.thread_id,
    roomName: row.room_name,
    subject: row.subject,
    jitsiDomain: row.jitsi_domain,
    status: row.status,
    code: row.join_code,
    host,
    attendees,
    attendeeCount: attendees.length,
    startedAt,
    endedAt: row.ended_at,
    scheduledStartAt: row.scheduled_start_at ?? null,
    scheduledEndAt: row.scheduled_end_at ?? null,
    durationSeconds: computeDurationSeconds({
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      scheduledStartAt: row.scheduled_start_at ?? null,
      scheduledEndAt: row.scheduled_end_at ?? null,
    }),
    recordingArtifacts: (row.recording_artifacts ?? []).map(mapRecordingArtifact),
    summaries: (row.summaries ?? []).map(mapSummary),
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActorRef(row: MeetActorRefRow): MeetActorRef {
  return {
    actorId: row.actorId,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
  };
}

function mapSummary(row: MeetSummaryRow): MeetSummaryRef {
  return {
    messageId: row.messageId,
    body: row.body,
    createdAt: toDate(row.createdAt),
    metadata: row.metadata,
  };
}

/**
 * Wall-clock duration in seconds: for ended/active rooms it is `ended - started`;
 * for scheduled rooms it is the planned `scheduledEnd - scheduledStart`. Returns
 * null when the relevant bounds are not both known.
 */
function computeDurationSeconds(room: {
  readonly status: MeetRoomStatus;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly scheduledStartAt: Date | null;
  readonly scheduledEndAt: Date | null;
}): number | null {
  if (room.status === "scheduled") {
    if (room.scheduledStartAt === null || room.scheduledEndAt === null) {
      return null;
    }
    return Math.max(
      0,
      Math.round((room.scheduledEndAt.getTime() - room.scheduledStartAt.getTime()) / 1000),
    );
  }
  if (room.startedAt === null || room.endedAt === null) {
    return null;
  }
  return Math.max(0, Math.round((room.endedAt.getTime() - room.startedAt.getTime()) / 1000));
}

function mapRecordingArtifact(row: MeetRecordingArtifactRow): MeetRecordingArtifactRecord {
  return {
    objectId: row.objectId,
    messageId: row.messageId,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    exportAllowed: row.exportAllowed !== false,
    createdAt: toDate(row.createdAt),
    startedAt: row.startedAt === null ? null : toDate(row.startedAt),
    endedAt: row.endedAt === null ? null : toDate(row.endedAt),
    metadata: row.metadata,
  };
}

function mapGuestInvite(row: MeetGuestInviteRow | undefined): MeetGuestInviteRecord {
  if (row === undefined) throw new Error("Expected Meet guest invite row.");
  return {
    id: row.id,
    orgId: row.org_id,
    roomId: row.room_id,
    email: row.email,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
  };
}

async function requireActiveMeetActors(
  sql: SqlLike,
  orgId: string,
  actorIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(actorIds)];
  const rows = await sql<{ readonly id: string }[]>`
    select id from actors
    where org_id = ${orgId}
      and id = any(${sql.array(unique)}::uuid[])
      and disabled_at is null
  `;
  if (rows.length !== unique.length)
    throw new Error("One or more Meet participants are unavailable.");
}

function randomJoinCode(): string {
  const value = randomBytes(6).toString("hex");
  return `${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

function normalizeGuestDomains(domains: readonly string[]): readonly string[] {
  return [...new Set(domains.map((domain) => domain.trim().toLowerCase()))].filter(
    (domain) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(domain) && domain.includes("."),
  );
}

function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function requireValue(value: string | undefined, label: string): string {
  if (value === undefined) {
    throw new Error(`Expected ${label}.`);
  }
  return value;
}
