import type { JsonObject } from "@helix/sdk-types";

export const meetPluginId = "com.helix.core.meet-jitsi";

export type MeetRoomStatus = "active" | "ended";

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
  readonly metadata: JsonObject;
  readonly recordingArtifacts?: readonly MeetRecordingArtifactRecord[] | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
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
