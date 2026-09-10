import { authenticatedFetch } from "@/lib/auth";
import { callTool } from "@/lib/tool-call";

export type MeetRoomStatus = "scheduled" | "active" | "ended";

export interface MeetRoomRecord {
  readonly id: string;
  readonly orgId?: string;
  readonly threadId: string;
  readonly roomName: string;
  readonly joinCode: string;
  readonly subject: string;
  readonly jitsiDomain: string;
  readonly status: MeetRoomStatus;
  readonly guestPolicy: "disabled" | "invite" | "domain";
  readonly guestDomains: readonly string[];
  readonly lobbyEnabled: boolean;
  readonly createdByActorId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly scheduledStartAt?: string | null;
  readonly scheduledEndAt?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly recordingArtifacts?: readonly MeetRecordingArtifactRecord[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MeetRecordingArtifactRecord {
  readonly objectId: string;
  readonly messageId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly exportAllowed?: boolean;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly metadata?: Record<string, unknown>;
}

/** A lightweight actor identity for hosts and attendees. */
interface MeetActorRef {
  readonly actorId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string;
}

/** A reference to a meeting summary message on the call thread. */
interface MeetSummaryRef {
  readonly messageId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * A Meet room projected for the Meet hub UI, as returned by the
 * `meet.meetings.list` tool: lifecycle status, host identity, attendee roster,
 * join code, recording and summary references.
 */
export interface MeetMeetingRecord {
  readonly id: string;
  readonly orgId?: string;
  readonly threadId: string;
  readonly roomName: string;
  readonly subject: string;
  readonly title: string;
  readonly jitsiDomain: string;
  readonly status: MeetRoomStatus;
  /** Mono join code shown in the UI as `helix.meet/<code>`. */
  readonly code: string;
  readonly host: MeetActorRef | null;
  readonly attendees: readonly MeetActorRef[];
  readonly attendeeCount: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly durationSeconds: number | null;
  readonly recorded: boolean;
  readonly recordingArtifacts: readonly MeetRecordingArtifactRecord[];
  readonly summaries: readonly MeetSummaryRef[];
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The `meet.meetings.list` tool output: meetings split by lifecycle. */
export interface MeetMeetingsResult {
  readonly meetings: readonly MeetMeetingRecord[];
  readonly scheduled: readonly MeetMeetingRecord[];
  readonly active: readonly MeetMeetingRecord[];
  readonly recent: readonly MeetMeetingRecord[];
}

export interface MeetTokenRecord {
  readonly roomId: string;
  readonly roomName: string;
  readonly jitsiDomain: string;
  readonly token: string;
  readonly joinUrl: string;
  readonly expiresAt: string;
  readonly recordingAvailable: boolean;
  readonly canStartRecording: boolean;
  readonly recordingNoticeVersion: string;
  readonly recordingActive: boolean;
  readonly controls: MeetControlState;
  readonly canModerate: boolean;
  readonly subject?: string;
  readonly code?: string;
}

type MeetAudiencePolicy = "everyone" | "hosts" | "disabled";
export interface MeetControlState {
  readonly roomId: string;
  readonly hostActorId: string | null;
  readonly cohostActorIds: readonly string[];
  readonly lobbyEnabled: boolean;
  readonly locked: boolean;
  readonly mutePolicy: "open" | "moderated";
  readonly presenterPolicy: "everyone" | "hosts" | "selected";
  readonly presenterSubject: string | null;
  readonly chatPolicy: MeetAudiencePolicy;
  readonly reactionPolicy: MeetAudiencePolicy;
  readonly version: number;
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

export type MeetHostControl =
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
  | { readonly action: "set_mute_policy"; readonly policy: "open" | "moderated" }
  | {
      readonly action: "mute";
      readonly participantSubject: string;
      readonly mediaParticipantId: string;
      readonly mediaType: "audio" | "video";
    }
  | {
      readonly action: "set_presenter";
      readonly policy: "everyone" | "hosts" | "selected";
      readonly participantSubject?: string;
      readonly mediaParticipantId?: string;
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

export const MEET_RECORDING_NOTICE_VERSION = "2026-09-02";

export interface MeetRecordingConsent {
  readonly recordingNoticeAccepted: true;
  readonly recordingNoticeVersion: typeof MEET_RECORDING_NOTICE_VERSION;
  readonly deviceId: string;
  readonly joinGrantId: string;
}

export interface MeetRecordingAuthorization {
  readonly authorizationId: string;
  readonly expiresAt: string;
  readonly participantSubjects: readonly string[];
}

export type MeetTelemetryEvent =
  | { readonly event: "join_latency"; readonly joinLatencyMs: number }
  | {
      readonly event: "device_failure";
      readonly device: "camera" | "microphone" | "screen";
    }
  | {
      readonly event: "quality";
      readonly packetLossPercent?: number;
      readonly jitterMs?: number;
      readonly rttMs?: number;
      readonly bitrateKbps?: number;
      readonly connectionQuality?: number;
      readonly bridgeLoadPercent?: number;
    };

export type MeetApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CreateMeetRoomInput {
  readonly subject: string;
  readonly roomName?: string;
  readonly participantActorIds?: readonly string[];
  /** When set, the room is created in the `scheduled` lifecycle state. */
  readonly scheduledStartAt?: string;
  readonly scheduledEndAt?: string;
  readonly metadata?: Record<string, unknown>;
}

export async function createMeetRoom(
  input: CreateMeetRoomInput,
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetRoomRecord> {
  return callMeetTool<MeetRoomRecord>(
    "meet.create-room",
    {
      subject: input.subject,
      ...(input.roomName === undefined ? {} : { roomName: input.roomName }),
      participantActorIds: input.participantActorIds ?? [],
      ...(input.scheduledStartAt === undefined ? {} : { scheduledStartAt: input.scheduledStartAt }),
      ...(input.scheduledEndAt === undefined ? {} : { scheduledEndAt: input.scheduledEndAt }),
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

export async function listMeetRooms(
  input: {
    readonly status?: MeetRoomStatus;
    readonly limit?: number;
  } = {},
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<readonly MeetRoomRecord[]> {
  const output = await callMeetTool<{ readonly rooms: readonly MeetRoomRecord[] }>(
    "meet.room.list",
    {
      ...(input.status === undefined ? {} : { status: input.status }),
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );
  return output.rooms;
}

/**
 * List Meet meetings for the hub via the `meet.meetings.list` tool. Returns the
 * full list plus pre-split `scheduled` / `active` / `recent` projections that
 * drive the hub's Today and Recent panels.
 */
export async function listMeetMeetings(
  input: {
    readonly status?: MeetRoomStatus;
    readonly limit?: number;
  } = {},
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetMeetingsResult> {
  const output = await callMeetTool<Partial<MeetMeetingsResult>>(
    "meet.meetings.list",
    {
      ...(input.status === undefined ? {} : { status: input.status }),
      limit: input.limit ?? 50,
    },
    fetchImpl,
  );
  return {
    meetings: output.meetings ?? [],
    scheduled: output.scheduled ?? [],
    active: output.active ?? [],
    recent: output.recent ?? [],
  };
}

export async function mintMeetToken(
  input: {
    readonly roomId: string;
    readonly expiresInSeconds?: number;
  } & MeetRecordingConsent,
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetTokenRecord> {
  return callMeetTool<MeetTokenRecord>(
    "meet.mint-token",
    {
      roomId: input.roomId,
      expiresInSeconds: input.expiresInSeconds ?? 300,
      recordingNoticeAccepted: input.recordingNoticeAccepted,
      recordingNoticeVersion: input.recordingNoticeVersion,
      deviceId: input.deviceId,
      joinGrantId: input.joinGrantId,
    },
    fetchImpl,
  );
}

export async function joinMeetByCode(
  input: { readonly code: string } & MeetRecordingConsent,
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetTokenRecord> {
  return callMeetTool<MeetTokenRecord>("meet.join-by-code", input, fetchImpl);
}

export async function authorizeMeetRecordingStart(
  roomId: string,
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetRecordingAuthorization> {
  return callMeetTool<MeetRecordingAuthorization>(
    "meet.recording.authorize-start",
    { roomId },
    fetchImpl,
  );
}

export async function applyMeetHostControl(
  roomId: string,
  control: MeetHostControl,
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetControlResult> {
  return callMeetTool<MeetControlResult>(
    "meet.host-controls.apply",
    { roomId, ...control },
    fetchImpl,
  );
}

export async function recordMeetTelemetry(
  roomId: string,
  event: MeetTelemetryEvent,
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<void> {
  await callMeetTool("meet.telemetry.record", { roomId, ...event }, fetchImpl);
}

export async function endMeetRoom(
  roomId: string,
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetRoomRecord> {
  return callMeetTool<MeetRoomRecord>("meet.end-room", { roomId }, fetchImpl);
}

async function callMeetTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: MeetApiFetch,
): Promise<Output> {
  // Auto-approves pending_confirmation (e.g. meet.end-room) via the shared
  // callTool helper so destructive meet actions execute on first click.
  return callTool<Output>(toolId, input, { fetchImpl });
}
