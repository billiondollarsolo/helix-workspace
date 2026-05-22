import type { JsonObject } from "@helix/sdk-types";

export const meetPluginId = "com.helix.core.meet-jitsi";

export type MeetRoomStatus = "scheduled" | "active" | "ended";

export interface MeetRoomRecord {
  readonly id: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly roomName: string;
  readonly subject: string;
  readonly jitsiDomain: string;
  readonly status: MeetRoomStatus;
  readonly createdByActorId: string | null;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly scheduledStartAt: Date | null;
  readonly scheduledEndAt: Date | null;
  readonly metadata: JsonObject;
  readonly recordingArtifacts?: readonly MeetRecordingArtifactRecord[] | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A Meet room projected for the Meet hub UI: lifecycle status, the host display
 * identity, the attendee roster, the join code, and recording/summary refs.
 * Returned by {@link MeetStore.listMeetingsForActor}.
 */
export interface MeetMeetingRecord {
  readonly id: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly roomName: string;
  readonly subject: string;
  readonly jitsiDomain: string;
  readonly status: MeetRoomStatus;
  /** Mono join code shown in the UI as `helix.meet/<code>`. */
  readonly code: string;
  readonly host: MeetActorRef | null;
  readonly attendees: readonly MeetActorRef[];
  readonly attendeeCount: number;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly scheduledStartAt: Date | null;
  readonly scheduledEndAt: Date | null;
  /** Wall-clock duration in seconds when both bounds are known, else null. */
  readonly durationSeconds: number | null;
  readonly recordingArtifacts: readonly MeetRecordingArtifactRecord[];
  readonly summaries: readonly MeetSummaryRef[];
  readonly metadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A lightweight actor identity for hosts and attendees. */
export interface MeetActorRef {
  readonly actorId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  /** Permission role on the room: `owner` for the host, `member` otherwise. */
  readonly role: string;
}

/** A reference to a meeting summary message on the call thread. */
export interface MeetSummaryRef {
  readonly messageId: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly metadata: JsonObject;
}

export interface MeetTokenRecord {
  readonly roomId: string;
  readonly roomName: string;
  readonly jitsiDomain: string;
  readonly token: string;
  readonly joinUrl: string;
  readonly expiresAt: Date;
}

export interface MeetRecordingAttachmentRecord {
  readonly roomId: string;
  readonly threadId: string;
  readonly objectId: string;
  readonly messageId: string;
  readonly storageKey: string;
}

export interface MeetRecordingArtifactRecord {
  readonly objectId: string;
  readonly messageId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly metadata: JsonObject;
}
