/* Upload records for recordings made by LiveKit Egress (source 'egress'). The
   record exists from the moment Helix starts the recording; its size and digest
   are set when the file arrives, after which the shared upload path validates,
   scans and promotes it (getRecordingUpload, markRecordingUploadReady, ...). */

import type postgres from "postgres";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

export interface MeetEgressRecording {
  readonly id: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly egressId: string | null;
  readonly startedAt: Date;
}

export interface MeetEgressRecordingStore {
  /** False when the room already has a recording running. */
  prepare(input: {
    readonly id: string;
    readonly orgId: string;
    readonly roomId: string;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly expiresAt: Date;
  }): Promise<boolean>;
  setEgressId(input: {
    readonly orgId: string;
    readonly id: string;
    readonly egressId: string;
  }): Promise<boolean>;
  active(input: {
    readonly orgId: string;
    readonly roomId: string;
  }): Promise<MeetEgressRecording | null>;
  byEgressId(input: {
    readonly orgId: string;
    readonly egressId: string;
  }): Promise<MeetEgressRecording | null>;
  setDigest(input: {
    readonly orgId: string;
    readonly id: string;
    readonly byteSize: number;
    readonly sha256: string;
  }): Promise<boolean>;
  /** Drops a recording that failed or produced nothing; nothing was promoted. */
  abandon(input: { readonly orgId: string; readonly id: string }): Promise<void>;
}

interface Row {
  readonly id: string;
  readonly org_id: string;
  readonly room_id: string;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly egress_id: string | null;
  readonly created_at: Date;
}

const toRecording = (row: Row | undefined): MeetEgressRecording | null =>
  row === undefined
    ? null
    : {
        id: row.id,
        orgId: row.org_id,
        roomId: row.room_id,
        storageKey: row.storage_key,
        mimeType: row.mime_type,
        egressId: row.egress_id,
        startedAt: row.created_at,
      };

export class PostgresMeetEgressRecordingStore implements MeetEgressRecordingStore {
  constructor(private readonly sql: postgres.Sql) {}

  async prepare(input: Parameters<MeetEgressRecordingStore["prepare"]>[0]): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx`
        insert into meet_recording_uploads (
          id, org_id, room_id, storage_key, mime_type, expires_at, source
        )
        select ${input.id}, room.org_id, room.id, ${input.storageKey}, ${input.mimeType},
          ${input.expiresAt}, 'egress'
        from meet_rooms room
        where room.org_id = ${input.orgId} and room.id = ${input.roomId} and room.status = 'active'
        on conflict do nothing
        returning id
      `;
      return rows.length === 1;
    });
  }

  async setEgressId(input: Parameters<MeetEgressRecordingStore["setEgressId"]>[0]) {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx`
        update meet_recording_uploads set egress_id = ${input.egressId}
        where org_id = ${input.orgId} and id = ${input.id} and source = 'egress'
          and egress_id is null
        returning id
      `;
      return rows.length === 1;
    });
  }

  async active(input: { readonly orgId: string; readonly roomId: string }) {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx<Row[]>`
        select id, org_id, room_id, storage_key, mime_type, egress_id, created_at
        from meet_recording_uploads
        where org_id = ${input.orgId} and room_id = ${input.roomId} and source = 'egress'
          and status = 'prepared' and completed_at is null
        limit 1
      `;
      return toRecording(rows[0]);
    });
  }

  async byEgressId(input: { readonly orgId: string; readonly egressId: string }) {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx<Row[]>`
        select id, org_id, room_id, storage_key, mime_type, egress_id, created_at
        from meet_recording_uploads
        where org_id = ${input.orgId} and egress_id = ${input.egressId} and source = 'egress'
          and completed_at is null
        limit 1
      `;
      return toRecording(rows[0]);
    });
  }

  async setDigest(input: Parameters<MeetEgressRecordingStore["setDigest"]>[0]) {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx`
        update meet_recording_uploads
        set byte_size = ${input.byteSize}, sha256 = ${input.sha256}
        where org_id = ${input.orgId} and id = ${input.id} and source = 'egress'
          and status = 'prepared' and completed_at is null
        returning id
      `;
      return rows.length === 1;
    });
  }

  async abandon(input: { readonly orgId: string; readonly id: string }) {
    await withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      await tx`
        delete from meet_recording_uploads
        where org_id = ${input.orgId} and id = ${input.id} and source = 'egress'
          and completed_at is null
      `;
    });
  }
}

/** For tests and the in-memory runtime. */
export class InMemoryMeetEgressRecordingStore implements MeetEgressRecordingStore {
  readonly recordings = new Map<
    string,
    MeetEgressRecording & { byteSize?: number; sha256?: string; expiresAt: Date }
  >();
  constructor(
    private readonly roomIsActive: (orgId: string, roomId: string) => boolean = () => true,
  ) {}

  async prepare(input: Parameters<MeetEgressRecordingStore["prepare"]>[0]) {
    if (!this.roomIsActive(input.orgId, input.roomId)) return false;
    if (
      [...this.recordings.values()].some(
        (r) => r.orgId === input.orgId && r.roomId === input.roomId,
      )
    )
      return false;
    this.recordings.set(input.id, { ...input, egressId: null, startedAt: new Date() });
    return true;
  }
  async setEgressId(input: Parameters<MeetEgressRecordingStore["setEgressId"]>[0]) {
    const recording = this.recordings.get(input.id);
    if (recording === undefined || recording.egressId !== null) return false;
    this.recordings.set(input.id, { ...recording, egressId: input.egressId });
    return true;
  }
  async active(input: { readonly orgId: string; readonly roomId: string }) {
    return (
      [...this.recordings.values()].find(
        (r) => r.orgId === input.orgId && r.roomId === input.roomId,
      ) ?? null
    );
  }
  async byEgressId(input: { readonly orgId: string; readonly egressId: string }) {
    return (
      [...this.recordings.values()].find(
        (r) => r.orgId === input.orgId && r.egressId === input.egressId,
      ) ?? null
    );
  }
  async setDigest(input: Parameters<MeetEgressRecordingStore["setDigest"]>[0]) {
    const recording = this.recordings.get(input.id);
    if (recording === undefined) return false;
    this.recordings.set(input.id, { ...recording, byteSize: input.byteSize, sha256: input.sha256 });
    return true;
  }
  async abandon(input: { readonly orgId: string; readonly id: string }) {
    this.recordings.delete(input.id);
  }
}
