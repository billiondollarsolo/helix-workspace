/* Joining a meeting: what the pre-join screen is joining, the recording
   consent every join token requires, and the call session built from the
   minted token. */

import { notify } from "@/components/ui/toast";
import {
  createMeetRoom,
  joinMeetByCode,
  MEET_RECORDING_NOTICE_VERSION,
  mintMeetToken,
  type MeetRecordingConsent,
  type MeetTokenRecord,
} from "./api";
import type { JitsiInitialMedia } from "./jitsi-external-api";
import type { MeetCallSession } from "./meet-shell";

/** What "Join now" on the pre-join screen enters. */
export type MeetJoinTarget =
  | { readonly kind: "start"; readonly subject: string }
  | { readonly kind: "code"; readonly code: string; readonly title: string | null };

/** The heading the pre-join screen shows for a target. */
export function meetJoinTargetTitle(target: MeetJoinTarget): string {
  return target.kind === "start" ? target.subject : (target.title ?? "Meeting");
}

/** The code shown under the heading, when the meeting already has one. */
export function meetJoinTargetCode(target: MeetJoinTarget): string | null {
  return target.kind === "start" ? null : target.code;
}

/** Meeting codes look like `abcd-efgh-ijkl`. */
const CODE_PATTERN = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u;

/**
 * Reads a meeting code from what someone typed or pasted: a bare code, or a
 * Helix link carrying `?code=`. Returns null when neither is present.
 */
export function parseMeetCode(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  let candidate = trimmed;
  if (/^https?:\/\//iu.test(trimmed) || trimmed.startsWith("/")) {
    try {
      const url = new URL(trimmed, "https://helix.invalid");
      candidate = url.searchParams.get("code") ?? "";
    } catch {
      return null;
    }
  }
  const code = candidate.trim().toLowerCase();
  return CODE_PATTERN.test(code) ? code : null;
}

/** The shareable in-app link for a meeting code. */
export function meetJoinLink(code: string, origin = window.location.origin): string {
  const url = new URL("/meet", origin);
  url.searchParams.set("code", code);
  return url.toString();
}

/** Copies a meeting link and confirms with a snackbar. */
export async function copyMeetingLink(link: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(link);
    notify({ message: "Link copied" });
  } catch {
    notify({ message: "Couldn't copy. Select the link and copy it.", tone: "error" });
  }
}

/** Mints the join token for a target (creating the room for an instant meeting). */
export async function joinMeetTarget(
  target: MeetJoinTarget,
  media: JitsiInitialMedia,
): Promise<MeetCallSession> {
  const consent = createRecordingConsent();
  if (target.kind === "start") {
    const room = await createMeetRoom({ subject: target.subject });
    const token = await mintMeetToken({ roomId: room.id, ...consent });
    return sessionFromToken(token, {
      roomName: room.roomName,
      subject: room.subject,
      code: room.joinCode,
      startedAtMs: Date.parse(room.startedAt) || Date.now(),
      media,
    });
  }
  let token: MeetTokenRecord;
  try {
    token = await joinMeetByCode({ code: target.code, ...consent });
  } catch {
    throw new Error(
      "No meeting is open with that code. Check the code, or ask the organizer to start the meeting.",
    );
  }
  return sessionFromToken(token, {
    roomName: token.roomName,
    subject: token.subject ?? target.title ?? "Meeting",
    code: token.code ?? target.code,
    startedAtMs: Date.now(),
    media,
  });
}

function sessionFromToken(
  token: MeetTokenRecord,
  room: {
    readonly roomName: string;
    readonly subject: string;
    readonly code: string;
    readonly startedAtMs: number;
    readonly media: JitsiInitialMedia;
  },
): MeetCallSession {
  return {
    roomId: token.roomId,
    roomName: room.roomName,
    subject: room.subject,
    code: room.code,
    jitsiDomain: token.jitsiDomain,
    token: token.token,
    joinUrl: token.joinUrl,
    recordingAvailable: token.recordingAvailable,
    canStartRecording: token.canStartRecording,
    recordingNoticeVersion: token.recordingNoticeVersion,
    recordingActive: token.recordingActive,
    controls: token.controls,
    canModerate: token.canModerate,
    startedAtMs: room.startedAtMs,
    media: room.media,
  };
}

function createRecordingConsent(): MeetRecordingConsent {
  return {
    recordingNoticeAccepted: true,
    recordingNoticeVersion: MEET_RECORDING_NOTICE_VERSION,
    deviceId: meetDeviceId(),
    joinGrantId: crypto.randomUUID(),
  };
}

function meetDeviceId(): string {
  const key = "helix-meet-device-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing !== null) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}
