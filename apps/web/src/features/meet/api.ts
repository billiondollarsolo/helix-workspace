import { authenticatedFetch } from "@/lib/auth";

export type MeetRoomStatus = "scheduled" | "active" | "ended";

export interface MeetRoomRecord {
  readonly id: string;
  readonly orgId?: string;
  readonly threadId: string;
  readonly roomName: string;
  readonly subject: string;
  readonly jitsiDomain: string;
  readonly status: MeetRoomStatus;
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
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly metadata?: Record<string, unknown>;
}

/** A lightweight actor identity for hosts and attendees. */
export interface MeetActorRef {
  readonly actorId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly role: string;
}

/** A reference to a meeting summary message on the call thread. */
export interface MeetSummaryRef {
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
}

export type MeetApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_JITSI_DOMAIN = "meet.localhost";

export interface CreateMeetRoomInput {
  readonly subject: string;
  readonly roomName?: string;
  readonly jitsiDomain?: string;
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
      jitsiDomain: input.jitsiDomain ?? DEFAULT_JITSI_DOMAIN,
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
    readonly moderator?: boolean;
  },
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetTokenRecord> {
  return callMeetTool<MeetTokenRecord>(
    "meet.mint-token",
    {
      roomId: input.roomId,
      expiresInSeconds: input.expiresInSeconds ?? 3600,
      moderator: input.moderator ?? false,
    },
    fetchImpl,
  );
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
  const response = await fetchImpl(`/api/tools/${toolId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const output: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `${toolId} failed with ${String(response.status)}`,
    );
  }

  return output as Output;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
