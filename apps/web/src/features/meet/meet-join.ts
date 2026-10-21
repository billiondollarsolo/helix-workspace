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
import type { MeetInitialMedia } from "./meet-call-controls";
import type { MeetCallSession } from "./meet-shell";
import { randomId } from "@/lib/random-id";

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
  media: MeetInitialMedia,
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

export function sessionFromToken(
  token: MeetTokenRecord,
  room: {
    readonly roomName: string;
    readonly subject: string;
    readonly code: string;
    readonly startedAtMs: number;
    readonly media: MeetInitialMedia;
  },
): MeetCallSession {
  return {
    roomId: token.roomId,
    roomName: room.roomName,
    subject: room.subject,
    code: room.code,
    serverUrl:
      typeof token.serverUrl === "string" && token.serverUrl.length > 0 ? token.serverUrl : null,
    token: token.token,
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
    joinGrantId: randomId(),
  };
}

function meetDeviceId(): string {
  const key = "helix-meet-device-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing !== null) return existing;
    const created = randomId();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return randomId();
  }
}
