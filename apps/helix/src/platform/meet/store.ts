import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject, MeteringClient } from "@helix/sdk-types";
import type {
  MeetActorRef,
  MeetMeetingRecord,
  MeetRecordingArtifactRecord,
  MeetRecordingAttachmentRecord,
  MeetRoomRecord,
  MeetRoomStatus,
  MeetSummaryRef,
} from "./types.js";

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
  readonly byteSize?: number | undefined;
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

export interface PostgresMeetStoreOptions {
  readonly metering?: MeteringClient | undefined;
  readonly onMeteringError?: ((error: unknown) => void) | undefined;
}

interface MeetRoomRow {
  readonly id: string;
  readonly org_id: string;
  readonly thread_id: string;
  readonly room_name: string;
  readonly subject: string;
  readonly jitsi_domain: string;
  readonly created_by_actor_id: string | null;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly scheduled_start_at: Date | null;
  readonly scheduled_end_at: Date | null;
  readonly status: MeetRoomStatus;
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
  readonly createdAt: string | Date;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly metadata: JsonObject;
}

interface ExistingRecordingAttachmentRow {
  readonly object_id: string;
  readonly message_id: string;
  readonly storage_key: string;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export class PostgresMeetStore implements MeetStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: PostgresMeetStoreOptions = {},
  ) {}

  async createRoom(input: CreateMeetRoomInput): Promise<MeetRoomRecord> {
    const subject = input.subject.trim();
    if (subject.length === 0) {
      throw new Error("Meet room subject is required.");
    }
    const roomName = normalizeRoomName(input.roomName ?? `${subject}-${randomUUID().slice(0, 8)}`);

    return this.sql.begin(async (tx) => {
      const threadRows = (await tx`
        insert into threads (org_id, kind, subject, created_by_actor_id, metadata)
        values (
          ${input.orgId},
          'call',
          ${subject},
          ${input.actorId},
          ${tx.json(toSqlJson({ jitsiDomain: input.jitsiDomain, roomName }))}
        )
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const threadId = requireValue(threadRows[0]?.id, "threadId");

      const status = input.status ?? "active";
      const rows = (await tx`
        insert into meet_rooms (
          org_id, thread_id, room_name, subject, jitsi_domain, created_by_actor_id,
          started_at, scheduled_start_at, scheduled_end_at, status, metadata
        )
        values (
          ${input.orgId},
          ${threadId},
          ${roomName},
          ${subject},
          ${input.jitsiDomain},
          ${input.actorId},
          now(),
          ${input.scheduledStartAt ?? null},
          ${input.scheduledEndAt ?? null},
          ${status},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly MeetRoomRow[];
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
    const rows = (await this.sql`
      select r.*, coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'objectId', o.id,
            'messageId', m.id,
            'storageKey', o.storage_key,
            'mimeType', o.mime_type,
            'byteSize', o.byte_size,
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
        where m.thread_id = r.thread_id
          and m.deleted_at is null
          and o.deleted_at is null
          and o.kind = 'recording'
          and ma.disposition = 'recording'
      ), '[]'::jsonb) as recording_artifacts
      from meet_rooms r
      where r.org_id = ${input.orgId}
        and (${input.status ?? null}::text is null or r.status = ${input.status ?? null})
        and (
          r.created_by_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type in ('meet_room', 'thread')
              and p.resource_id in (r.id, r.thread_id)
              and p.actor_id = ${input.actorId}
          )
        )
      order by r.created_at desc, r.id desc
      limit ${input.limit}
    `) as unknown as readonly MeetRoomRow[];
    return rows.map(mapRoom);
  }

  async listMeetingsForActor(input: ListMeetMeetingsInput): Promise<readonly MeetMeetingRecord[]> {
    const rows = (await this.sql`
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
        ), '[]'::jsonb) as attendees
      from meet_rooms r
      where r.org_id = ${input.orgId}
        and (${input.status ?? null}::text is null or r.status = ${input.status ?? null})
        and (
          r.created_by_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type in ('meet_room', 'thread')
              and p.resource_id in (r.id, r.thread_id)
              and p.actor_id = ${input.actorId}
          )
        )
      order by
        case when r.status = 'scheduled' then 0 else 1 end,
        coalesce(r.scheduled_start_at, r.started_at) desc,
        r.created_at desc,
        r.id desc
      limit ${input.limit}
    `) as unknown as readonly MeetRoomRow[];
    return rows.map(mapMeeting);
  }

  async getRoomForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    return selectRoomForActor(this.sql, input.orgId, input.actorId, input.roomId);
  }

  async getRoomById(input: {
    readonly orgId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    return selectRoomById(this.sql, input.orgId, input.roomId);
  }

  async getRoomByName(input: {
    readonly orgId: string;
    readonly roomName: string;
  }): Promise<MeetRoomRecord | null> {
    return selectRoomByName(this.sql, input.orgId, input.roomName);
  }

  async endRoom(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly roomId: string;
  }): Promise<MeetRoomRecord | null> {
    const current = await selectRoomForActor(this.sql, input.orgId, input.actorId, input.roomId);
    if (current === null) {
      return null;
    }
    const rows = (await this.sql`
      update meet_rooms
      set status = 'ended', ended_at = coalesce(ended_at, now()), updated_at = now()
      where id = ${input.roomId}
        and org_id = ${input.orgId}
      returning *
    `) as unknown as readonly MeetRoomRow[];
    const room = rows[0] === undefined ? null : mapRoom(rows[0]);
    if (room !== null) {
      await this
        .sql`update threads set archived_at = now(), updated_at = now() where id = ${room.threadId}`;
      await appendMeetActivity(this.sql, input.orgId, input.actorId, "meet.room.ended", room.id, {
        threadId: room.threadId,
        roomName: room.roomName,
      });
    }
    return room;
  }

  async attachRecording(
    input: AttachMeetRecordingInput,
  ): Promise<MeetRecordingAttachmentRecord | null> {
    return this.sql.begin(async (tx) => {
      const room = await selectRoomByRef(tx, input.orgId, input);
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
      const existingRows = (await tx`
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
      `) as unknown as readonly ExistingRecordingAttachmentRow[];
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
      const byteSize = input.byteSize ?? 0;
      const mimeType = input.mimeType ?? "video/mp4";
      const metadata = {
        ...(input.metadata ?? {}),
        roomId: room.id,
        threadId: room.threadId,
        roomName: room.roomName,
        startedAt: input.startedAt?.toISOString() ?? null,
        endedAt: input.endedAt?.toISOString() ?? null,
      };

      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${objectId},
          ${input.orgId},
          ${input.actorId ?? room.createdByActorId},
          'recording',
          ${input.storageKey},
          ${mimeType},
          ${byteSize},
          ${sha256},
          ${tx.json(toSqlJson(metadata))}
        )
      `;
      const messageRows = (await tx`
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
      `) as unknown as readonly { readonly id: string }[];
      const messageId = requireValue(messageRows[0]?.id, "messageId");
      await tx`
        insert into message_attachments (message_id, object_id, disposition)
        values (${messageId}, ${objectId}, 'recording')
      `;
      await grantRecordingObjectAccess(
        tx,
        input.orgId,
        room.id,
        room.threadId,
        objectId,
        input.actorId ?? room.createdByActorId,
      );
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
      const recipientRows = (await tx`
        select distinct p.actor_id
        from permissions p
        where p.org_id = ${input.orgId}
          and p.resource_type in ('meet_room', 'thread')
          and p.resource_id in (${room.id}, ${room.threadId})
      `) as unknown as readonly { readonly actor_id: string }[];
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
      this.emitRecordingStorageDelta(input.orgId, byteSize);
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
      const rows = (await tx`
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
      `) as unknown as readonly {
        readonly id: string;
        readonly body: string;
        readonly metadata: JsonObject;
        readonly created_at: Date;
      }[];
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

  private emitRecordingStorageDelta(orgId: string, byteDelta: number): void {
    if (byteDelta === 0) {
      return;
    }

    void this.options.metering
      ?.emit(orgId, {
        type: "storage.delta",
        quantity: byteDelta,
        metadata: {
          bucket: "meet_recordings",
          byte_delta: byteDelta,
        },
      })
      .catch((error: unknown) => {
        this.options.onMeteringError?.(error);
      });
  }
}

export class InMemoryMeetStore implements MeetStore {
  readonly #rooms = new Map<string, MeetRoomRecord>();
  readonly #members = new Map<string, Set<string>>();
  readonly #recordingArtifacts = new Map<string, MeetRecordingArtifactRecord[]>();
  readonly #summaries = new Map<string, MeetSummaryRef[]>();
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
      subject,
      jitsiDomain: input.jitsiDomain,
      createdByActorId: input.actorId,
      startedAt: now,
      endedAt: null,
      scheduledStartAt: input.scheduledStartAt ?? null,
      scheduledEndAt: input.scheduledEndAt ?? null,
      status: input.status ?? "active",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.#rooms.set(room.id, room);
    this.#members.set(room.id, new Set([input.actorId, ...(input.participantActorIds ?? [])]));
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
    const room = await this.getRoomForActor(input);
    if (room === null) {
      return null;
    }
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
      byteSize: input.byteSize ?? 0,
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
      code: formatMeetCode(room.roomName),
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
  const rows = (await sql`
    select r.*
    from meet_rooms r
    join threads t on t.id = r.thread_id
    where r.id = ${roomId}
      and r.org_id = ${orgId}
      and (
        r.created_by_actor_id = ${actorId}
        or exists (
          select 1 from permissions p
          where p.resource_type in ('meet_room', 'thread')
            and p.resource_id in (r.id, r.thread_id)
            and p.actor_id = ${actorId}
        )
      )
    limit 1
  `) as unknown as readonly MeetRoomRow[];
  return rows[0] === undefined ? null : mapRoom(rows[0]);
}

async function selectRoomById(
  sql: SqlLike,
  orgId: string,
  roomId: string,
): Promise<MeetRoomRecord | null> {
  const rows = (await sql`
    select *
    from meet_rooms
    where id = ${roomId}
      and org_id = ${orgId}
    limit 1
  `) as unknown as readonly MeetRoomRow[];
  return rows[0] === undefined ? null : mapRoom(rows[0]);
}

async function selectRoomByName(
  sql: SqlLike,
  orgId: string,
  roomName: string,
): Promise<MeetRoomRecord | null> {
  const rows = (await sql`
    select *
    from meet_rooms
    where org_id = ${orgId}
      and room_name = ${roomName}
    order by created_at desc
    limit 1
  `) as unknown as readonly MeetRoomRow[];
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

async function grantRecordingObjectAccess(
  sql: SqlLike,
  orgId: string,
  roomId: string,
  threadId: string,
  objectId: string,
  grantedByActorId: string | null,
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    select distinct ${orgId}::uuid, actor_id, 'object', ${objectId}::uuid, 'reader', ${grantedByActorId}::uuid
    from permissions
    where org_id = ${orgId}
      and resource_type in ('meet_room', 'thread')
      and resource_id in (${roomId}, ${threadId})
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

function mapRoom(row: MeetRoomRow | undefined): MeetRoomRecord {
  if (row === undefined) {
    throw new Error("Expected Meet room row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    threadId: row.thread_id,
    roomName: row.room_name,
    subject: row.subject,
    jitsiDomain: row.jitsi_domain,
    createdByActorId: row.created_by_actor_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    scheduledStartAt: row.scheduled_start_at ?? null,
    scheduledEndAt: row.scheduled_end_at ?? null,
    status: row.status,
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
    code: formatMeetCode(row.room_name),
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
 * Derives the `helix.meet/<code>` join code from the slugged room name as a
 * dash-grouped, lowercase string (e.g. `qfk-uvtn-pxs`).
 */
function formatMeetCode(roomName: string): string {
  const alphanumeric = roomName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (alphanumeric.length === 0) {
    return roomName;
  }
  const groups: string[] = [];
  for (let index = 0; index < alphanumeric.length; index += 4) {
    groups.push(alphanumeric.slice(index, index + 4));
  }
  return groups.join("-");
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
    createdAt: toDate(row.createdAt),
    startedAt: row.startedAt === null ? null : toDate(row.startedAt),
    endedAt: row.endedAt === null ? null : toDate(row.endedAt),
    metadata: row.metadata,
  };
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

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
