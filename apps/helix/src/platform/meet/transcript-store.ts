import { createHash } from "node:crypto";
import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { appendMeetActivity } from "./room-writes.js";

export interface MeetTranscript {
  readonly id: string;
  readonly org_id: string;
  readonly room_id: string;
  readonly owner_actor_id: string;
  readonly status: "capturing" | "processing" | "ready" | "failed";
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly attempts: number;
  readonly error: string | null;
  readonly transcript_object_id: string | null;
  readonly summary_object_id: string | null;
  readonly summary_requested: boolean;
}
export interface TranscriptSegment {
  readonly speaker: string;
  readonly spokenAt: Date;
  readonly text: string;
}

export class MeetTranscriptStore {
  constructor(readonly sql: postgres.Sql) {}

  async owner(capture: MeetTranscript): Promise<Actor | null> {
    return withTenantPostgresContext(this.sql, { orgId: capture.org_id }, async (tx) => {
      const rows = await tx<
        { id: string; type: Actor["type"]; display_name: string; email: string | null }[]
      >`select id,type,display_name,email from actors where org_id=${capture.org_id} and id=${capture.owner_actor_id}`;
      const row = rows[0];
      return row
        ? {
            id: row.id,
            type: row.type,
            orgId: capture.org_id,
            displayName: row.display_name,
            ...(row.email ? { email: row.email } : {}),
          }
        : null;
    });
  }

  async retry(orgId: string, roomId: string): Promise<void> {
    await withTenantPostgresContext(
      this.sql,
      { orgId },
      (tx) => tx`update meet_transcripts set status='processing',attempts=0,lease_until=null
      where org_id=${orgId} and room_id=${roomId} and status='failed'`,
    );
  }

  async renew(capture: MeetTranscript): Promise<void> {
    await withTenantPostgresContext(
      this.sql,
      { orgId: capture.org_id },
      (tx) => tx`update meet_transcripts set lease_until=now()+interval '5 minutes'
      where org_id=${capture.org_id} and id=${capture.id} and status='processing'`,
    );
  }

  async requested(orgId: string, roomId: string): Promise<boolean> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx`
        select id from meet_rooms where org_id=${orgId} and id=${roomId}
        and status='active' and metadata->>'transcriptionRequested'='true'
      `;
      return rows.length === 1;
    });
  }

  async setRequested(
    orgId: string,
    roomId: string,
    actorId: string,
    enabled: boolean,
  ): Promise<void> {
    await withTenantPostgresContext(this.sql, { orgId, actorId }, async (tx) => {
      await tx`update meet_rooms set metadata=metadata || ${tx.json({ transcriptionRequested: enabled })}, updated_at=now()
        where org_id=${orgId} and id=${roomId} and status='active'`;
      await appendMeetActivity(tx, orgId, actorId, "meet.transcription.requested", roomId, {
        enabled,
      });
    });
  }

  async begin(
    orgId: string,
    roomId: string,
    summaryRequested: boolean,
  ): Promise<MeetTranscript | null> {
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<MeetTranscript[]>`
        insert into meet_transcripts(org_id,room_id,owner_actor_id,summary_requested)
        select org_id,id,created_by_actor_id,${summaryRequested} from meet_rooms
        where org_id=${orgId} and id=${roomId} and status='active'
          and created_by_actor_id is not null and metadata->>'transcriptionRequested'='true'
        on conflict (org_id,room_id) where status='capturing' do nothing returning *
      `;
      return rows[0] ?? null;
    });
  }

  async append(capture: MeetTranscript, segment: TranscriptSegment): Promise<void> {
    const id = createHash("sha256")
      .update(JSON.stringify([segment.speaker, segment.spokenAt.toISOString(), segment.text]))
      .digest("hex");
    await withTenantPostgresContext(this.sql, { orgId: capture.org_id }, async (tx) => {
      const active =
        await tx`select id from meet_transcripts where org_id=${capture.org_id} and id=${capture.id} and status='capturing' for update`;
      if (active.length === 0) throw new Error("Transcription is no longer active.");
      const [size] = await tx<
        { bytes: number }[]
      >`select coalesce(sum(octet_length(body)),0)::integer as bytes from meet_transcript_segments where org_id=${capture.org_id} and transcript_id=${capture.id}`;
      if ((size?.bytes ?? 0) + Buffer.byteLength(segment.text) > 2_000_000)
        throw new Error("Transcript reached its 2 MB limit. Start a new transcription.");
      await tx`insert into meet_transcript_segments(org_id,transcript_id,segment_id,speaker,spoken_at,body)
        values(${capture.org_id},${capture.id},${id},${segment.speaker},${segment.spokenAt},${segment.text}) on conflict do nothing`;
    });
  }

  async heartbeat(capture: MeetTranscript): Promise<void> {
    await withTenantPostgresContext(
      this.sql,
      { orgId: capture.org_id },
      (tx) =>
        tx`update meet_transcripts set heartbeat_at=now() where org_id=${capture.org_id} and id=${capture.id} and status='capturing'`,
    );
  }

  async finish(capture: MeetTranscript, error?: string): Promise<void> {
    await withTenantPostgresContext(
      this.sql,
      { orgId: capture.org_id },
      (
        tx,
      ) => tx`update meet_transcripts set status='processing', ended_at=now(), error=${error ?? null}
      where org_id=${capture.org_id} and id=${capture.id} and status='capturing'`,
    );
  }

  async list(orgId: string, roomId: string): Promise<readonly MeetTranscript[]> {
    return withTenantPostgresContext(
      this.sql,
      { orgId },
      (tx) =>
        tx<
          MeetTranscript[]
        >`select * from meet_transcripts where org_id=${orgId} and room_id=${roomId} order by started_at desc limit 50`,
    );
  }

  async segments(capture: MeetTranscript): Promise<readonly TranscriptSegment[]> {
    return withTenantPostgresContext(this.sql, { orgId: capture.org_id }, async (tx) => {
      const rows = await tx<
        { speaker: string; spoken_at: Date; body: string }[]
      >`select speaker,spoken_at,body from meet_transcript_segments where org_id=${capture.org_id} and transcript_id=${capture.id} order by spoken_at,segment_id`;
      return rows.map((row) => ({ speaker: row.speaker, spokenAt: row.spoken_at, text: row.body }));
    });
  }

  async claim(): Promise<readonly MeetTranscript[]> {
    const orgs = await this.sql<
      { org_id: string }[]
    >`select org_id from helix_meet_transcript_work_orgs(25)`;
    for (const org of orgs) {
      const claimed = await withTenantPostgresContext(
        this.sql,
        { orgId: org.org_id },
        async (tx) => {
          await tx`update meet_transcripts set status='processing',ended_at=heartbeat_at,error='Capture connection was interrupted; transcript may be incomplete.'
          where org_id=${org.org_id} and status='capturing' and heartbeat_at < now()-interval '1 minute'`;
          return tx<
            MeetTranscript[]
          >`update meet_transcripts set lease_until=now()+interval '5 minutes',attempts=attempts+1
          where id in (select id from meet_transcripts where org_id=${org.org_id} and status='processing'
            and (lease_until is null or lease_until<now()) order by ended_at limit 1 for update skip locked) returning *`;
        },
      );
      if (claimed.length) return claimed;
    }
    return [];
  }

  async artifact(
    capture: MeetTranscript,
    kind: "transcript" | "summary",
    objectId: string,
  ): Promise<void> {
    await withTenantPostgresContext(this.sql, { orgId: capture.org_id }, async (tx) => {
      if (kind === "transcript")
        await tx`update meet_transcripts set transcript_object_id=${objectId} where org_id=${capture.org_id} and id=${capture.id}`;
      else
        await tx`update meet_transcripts set summary_object_id=${objectId} where org_id=${capture.org_id} and id=${capture.id}`;
    });
  }

  async complete(capture: MeetTranscript): Promise<void> {
    await withTenantPostgresContext(this.sql, { orgId: capture.org_id }, async (tx) => {
      await tx`update meet_transcripts set status='ready',lease_until=null,delivery_completed_at=now() where org_id=${capture.org_id} and id=${capture.id}`;
      await tx`delete from meet_transcript_segments where org_id=${capture.org_id} and transcript_id=${capture.id}`;
      await appendMeetActivity(
        tx,
        capture.org_id,
        capture.owner_actor_id,
        "meet.transcript.ready",
        capture.room_id,
        { transcriptId: capture.id },
      );
    });
  }

  async failed(capture: MeetTranscript, error: string): Promise<void> {
    await withTenantPostgresContext(
      this.sql,
      { orgId: capture.org_id },
      (tx) => tx`update meet_transcripts
      set status=${capture.attempts >= 3 ? "failed" : "processing"},error=${error.slice(0, 500)},lease_until=now()+interval '1 minute'
      where org_id=${capture.org_id} and id=${capture.id}`,
    );
  }

  async attendees(
    capture: MeetTranscript,
  ): Promise<readonly { id: string; email: string | null }[]> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: capture.org_id },
      (tx) => tx<{ id: string; email: string | null }[]>`
      select distinct a.id,a.email from actors a join meet_participant_sessions p on p.org_id=a.org_id and p.participant_id=a.id::text
      where p.org_id=${capture.org_id} and p.room_id=${capture.room_id} and p.joined_at is not null
        and a.type='user' and exists(select 1 from permissions permission where permission.org_id=a.org_id and permission.actor_id=a.id
          and permission.resource_type='meet_room' and permission.resource_id=${capture.room_id}
          and (permission.expires_at is null or permission.expires_at>now()))`,
    );
  }
}
