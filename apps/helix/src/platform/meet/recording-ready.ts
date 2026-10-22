/* After a meeting recording is saved: name it after the meeting and when it
   started, so Drive → Recordings lists it legibly, and email the hosts and
   co-hosts a link to it. Naming is the once-only gate, so a recording saved
   twice (a retried webhook, the recovery worker) is announced once. */

import type postgres from "postgres";
import type { OutboundMailTransport } from "../mail/outbound.js";
import type { MailAddress, MailOutboundEnvelope } from "../mail/types.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { escapeHtml } from "../util/strings.js";

export interface SavedMeetRecording {
  readonly orgId: string;
  readonly roomId: string;
  readonly objectId: string;
  readonly startedAt: Date;
  readonly endedAt: Date;
}

export interface MeetRecordingReadyOptions {
  readonly sql: postgres.Sql;
  /** Without a transport recordings are still named; nobody is emailed. */
  readonly transport?: OutboundMailTransport | undefined;
  readonly from: MailAddress;
  readonly publicBaseUrl: string;
  readonly onError?: ((error: unknown) => void) | undefined;
}

/** "Weekly sync (2026-10-22 17:50 UTC).mp4" */
export function meetRecordingName(subject: string, startedAt: Date): string {
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", " ");
  return `${subject.trim() || "Meeting"} (${stamp} UTC).mp4`;
}

export function meetRecordingUrl(publicBaseUrl: string, objectId: string): string {
  const base = publicBaseUrl.replace(/\/$/u, "");
  return `${base}/drive?scope=recordings&file=${encodeURIComponent(objectId)}`;
}

export function createMeetRecordingReadyHandler(
  options: MeetRecordingReadyOptions,
): (saved: SavedMeetRecording) => Promise<void> {
  return async (saved) => {
    try {
      const notice = await nameRecording(options.sql, saved);
      if (notice === null || options.transport === undefined) return;
      const url = meetRecordingUrl(options.publicBaseUrl, saved.objectId);
      for (const recipient of notice.recipients) {
        await options.transport
          .send(
            renderMeetRecordingReadyEmail({
              from: options.from,
              to: recipient,
              subject: notice.subject,
              saved,
              url,
            }),
            { idempotencyKey: `meet-recording-ready:${saved.objectId}:${recipient.address}` },
          )
          .catch((error: unknown) => options.onError?.(error));
      }
    } catch (error) {
      options.onError?.(error);
    }
  };
}

/** Names the recording; null when it was already named or the meeting is gone. */
async function nameRecording(
  sql: postgres.Sql,
  saved: SavedMeetRecording,
): Promise<{ readonly subject: string; readonly recipients: MailAddress[] } | null> {
  return withTenantPostgresContext(sql, { orgId: saved.orgId }, async (tx) => {
    const rooms = await tx<
      { subject: string; host_actor_id: string | null; cohost_actor_ids: string[] | null }[]
    >`
      select subject, host_actor_id, cohost_actor_ids
      from meet_rooms
      where org_id = ${saved.orgId} and id = ${saved.roomId}
    `;
    const room = rooms[0];
    if (room === undefined) return null;
    const named = await tx`
      update objects
      set metadata = metadata || ${tx.json({ name: meetRecordingName(room.subject, saved.startedAt) })},
        updated_at = now()
      where org_id = ${saved.orgId} and id = ${saved.objectId} and kind = 'recording'
        and metadata->>'name' is null
      returning id
    `;
    if (named.length === 0) return null;
    const hosts = [room.host_actor_id, ...(room.cohost_actor_ids ?? [])].filter(
      (id): id is string => id !== null,
    );
    const actors = await tx<{ email: string; display_name: string | null }[]>`
      select email, display_name
      from actors
      where org_id = ${saved.orgId} and id::text = any(${hosts}) and email is not null
    `;
    return {
      subject: room.subject,
      recipients: actors.map((actor) => ({
        address: actor.email,
        ...(actor.display_name === null ? {} : { name: actor.display_name }),
      })),
    };
  });
}

export function renderMeetRecordingReadyEmail(input: {
  readonly from: MailAddress;
  readonly to: MailAddress;
  readonly subject: string;
  readonly saved: SavedMeetRecording;
  readonly url: string;
}): MailOutboundEnvelope {
  const title = input.subject.trim() || "your meeting";
  const when = input.saved.startedAt.toISOString().slice(0, 16).replace("T", " ");
  const minutes = Math.max(
    1,
    Math.round((input.saved.endedAt.getTime() - input.saved.startedAt.getTime()) / 60_000),
  );
  const length = minutes === 1 ? "1 minute" : `${String(minutes)} minutes`;
  const line = `The recording of "${title}" from ${when} UTC (${length}) is ready.`;
  const access = "Only people with access to the meeting can open it.";
  return {
    from: input.from,
    to: [input.to],
    cc: [],
    bcc: [],
    subject: `Your recording of "${title}" is ready`,
    text: `${line}\n\nWatch it in Drive: ${input.url}\n\n${access}\n`,
    html:
      `<p>${escapeHtml(line)}</p>` +
      `<p><a href="${escapeHtml(input.url)}">Watch it in Drive</a></p>` +
      `<p style="color:#666">${escapeHtml(access)}</p>`,
    attachments: [],
  };
}
