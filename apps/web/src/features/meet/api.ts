import { authenticatedFetch } from "@/lib/auth";

export interface MeetRoomRecord {
  readonly id: string;
  readonly orgId?: string;
  readonly threadId: string;
  readonly roomName: string;
  readonly subject: string;
  readonly jitsiDomain: string;
  readonly status: "active" | "ended";
  readonly createdByActorId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
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

export interface MeetTokenRecord {
  readonly roomId: string;
  readonly roomName: string;
  readonly jitsiDomain: string;
  readonly token: string;
  readonly joinUrl: string;
  readonly expiresAt: string;
}

export type MeetApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function createMeetRoom(
  input: {
    readonly subject: string;
    readonly roomName?: string;
    readonly jitsiDomain?: string;
    readonly participantActorIds?: readonly string[];
    readonly metadata?: Record<string, unknown>;
  },
  fetchImpl: MeetApiFetch = authenticatedFetch,
): Promise<MeetRoomRecord> {
  return callMeetTool<MeetRoomRecord>(
    "meet.create-room",
    {
      subject: input.subject,
      roomName: input.roomName,
      jitsiDomain: input.jitsiDomain ?? "meet.jit.si",
      participantActorIds: input.participantActorIds ?? [],
      metadata: input.metadata ?? {},
    },
    fetchImpl,
  );
}

export async function listMeetRooms(
  input: {
    readonly status?: MeetRoomRecord["status"];
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
