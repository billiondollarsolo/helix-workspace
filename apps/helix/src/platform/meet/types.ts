import type { JsonObject } from "@helix/sdk-types";

export const meetPluginId = "com.helix.core.meet-jitsi";

export type MeetRoomStatus = "scheduled" | "active" | "ended";
export type MeetGuestPolicy = "disabled" | "invite" | "domain";
export type MeetAudiencePolicy = "everyone" | "hosts" | "disabled";
export type MeetPresenterPolicy = "everyone" | "hosts" | "selected";
export type MeetMutePolicy = "open" | "moderated";

export interface MeetControlState {
  readonly roomId: string;
  readonly hostActorId: string | null;
  readonly cohostActorIds: readonly string[];
  readonly lobbyEnabled: boolean;
  readonly locked: boolean;
  readonly mutePolicy: MeetMutePolicy;
  readonly presenterPolicy: MeetPresenterPolicy;
  readonly presenterSubject: string | null;
  readonly chatPolicy: MeetAudiencePolicy;
  readonly reactionPolicy: MeetAudiencePolicy;
  readonly version: number;
}

export interface MeetAttendanceRecord {
  readonly sessionId: string;
  readonly participantSubject: string | null;
  readonly joinedAt: Date | null;
  readonly leftAt: Date | null;
  readonly durationSeconds: number | null;
}

export type MeetMediaCommand =
  | { readonly command: "toggleLobby"; readonly enabled: boolean }
  | {
      readonly command: "answerKnockingParticipant";
      readonly participantId: string;
      readonly approved: boolean;
    }
  | { readonly command: "password"; readonly password: string }
  | { readonly command: "kickParticipant"; readonly participantId: string }
  | { readonly command: "grantModerator"; readonly participantId: string }
  | {
      readonly command: "muteRemoteParticipant";
      readonly participantId: string;
      readonly mediaType: "audio" | "video";
    }
  | {
      readonly command: "toggleModeration";
      readonly enabled: boolean;
      readonly mediaType: "audio" | "video" | "desktop";
    }
  | {
      readonly command: "approveParticipant";
      readonly participantId: string;
      readonly mediaType: "audio" | "video" | "desktop";
    }
  | { readonly command: "setChatPolicy"; readonly policy: MeetAudiencePolicy }
  | { readonly command: "setReactionPolicy"; readonly policy: MeetAudiencePolicy };

export interface MeetControlResult {
  readonly state: MeetControlState;
  readonly mediaCommands: readonly MeetMediaCommand[];
}

export type MeetControlAction =
  | { readonly action: "set_lobby"; readonly enabled: boolean }
  | {
      readonly action: "admit";
      readonly participantSubject: string;
      readonly mediaParticipantId: string;
    }
  | { readonly action: "set_lock"; readonly locked: boolean }
  | {
      readonly action: "remove";
      readonly participantSubject: string;
      readonly mediaParticipantId: string;
      readonly ban: boolean;
    }
  | { readonly action: "set_mute_policy"; readonly policy: MeetMutePolicy }
  | {
      readonly action: "mute";
      readonly participantSubject: string;
      readonly mediaParticipantId: string;
      readonly mediaType: "audio" | "video";
    }
  | {
      readonly action: "set_presenter";
      readonly policy: MeetPresenterPolicy;
      readonly participantSubject?: string | undefined;
      readonly mediaParticipantId?: string | undefined;
    }
  | {
      readonly action: "set_cohost";
      readonly actorId: string;
      readonly mediaParticipantId: string;
      readonly enabled: boolean;
    }
  | { readonly action: "set_chat_policy"; readonly policy: MeetAudiencePolicy }
  | { readonly action: "set_reaction_policy"; readonly policy: MeetAudiencePolicy }
  | {
      readonly action: "transfer_host";
      readonly actorId: string;
      readonly mediaParticipantId: string;
    };

export interface MeetRoomRecord {
  readonly id: string;
  readonly orgId: string;
  readonly threadId: string;
  readonly roomName: string;
  readonly joinCode: string;
  readonly subject: string;
  readonly jitsiDomain: string;
  readonly status: MeetRoomStatus;
  readonly guestPolicy: MeetGuestPolicy;
  readonly guestDomains: readonly string[];
  readonly lobbyEnabled: boolean;
  readonly recordingActive?: boolean;
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
  readonly exportAllowed?: boolean;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly metadata: JsonObject;
}

export interface MeetGuestInviteRecord {
  readonly id: string;
  readonly orgId: string;
  readonly roomId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly createdByActorId: string;
  readonly createdAt: Date;
}
