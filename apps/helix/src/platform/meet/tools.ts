import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod3";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { mintJitsiJwt } from "./jwt.js";
import type { MeetStore } from "./store.js";
import type {
  MeetMeetingRecord,
  MeetRecordingArtifactRecord,
  MeetRoomRecord,
} from "./types.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.unknown()).default({});

const createRoomSchema = z
  .object({
    subject: z.string().min(1).max(200),
    roomName: z.string().min(1).max(128).optional(),
    jitsiDomain: z.string().min(1).default("meet.localhost"),
    participantActorIds: z.array(uuidSchema).default([]),
    /**
     * When set, the room is created in the `scheduled` lifecycle state for the
     * Meet hub's upcoming panel instead of starting an instant `active` room.
     */
    scheduledStartAt: z.string().datetime().optional(),
    scheduledEndAt: z.string().datetime().optional(),
    metadata: metadataSchema,
  })
  .refine(
    (value) =>
      value.scheduledStartAt === undefined ||
      value.scheduledEndAt === undefined ||
      Date.parse(value.scheduledEndAt) >= Date.parse(value.scheduledStartAt),
    { message: "scheduledEndAt must be at or after scheduledStartAt." },
  );

const listRoomsSchema = z.object({
  status: z.enum(["scheduled", "active", "ended"]).optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const listMeetingsSchema = z.object({
  status: z.enum(["scheduled", "active", "ended"]).optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const mintTokenSchema = z.object({
  roomId: uuidSchema,
  expiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(24 * 60 * 60)
    .default(60 * 60),
  moderator: z.boolean().default(false),
});

const endRoomSchema = z.object({
  roomId: uuidSchema,
});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

export interface CreateMeetToolDefinitionsOptions {
  readonly store: MeetStore;
  readonly jwtSecret: string;
  readonly jwtAppId?: string | undefined;
  readonly jwtIssuer?: string | undefined;
  readonly jwtAudience?: string | undefined;
  readonly jwtSubject?: string | undefined;
  readonly publicBaseUrl?: string | undefined;
  /** Full public origin (including port) where the Jitsi instance serves
   *  the participant UI — e.g. `https://meet.localhost:28452` in dev,
   *  `https://meet.acme.com` in prod. Used to build the joinUrl. When
   *  unset, falls back to constructing `https://<jitsiDomain>/<room>`
   *  without a port. */
  readonly jitsiPublicUrl?: string | undefined;
}

export function createMeetToolDefinitions(
  options: CreateMeetToolDefinitionsOptions,
): readonly ToolDefinition[] {
  return [
    defineTool<z.output<typeof createRoomSchema>, unknown>({
      id: "meet.create-room",
      description: "Create a Jitsi-backed Meet room and call thread.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createRoomSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeRoom(
          await options.store.createRoom({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            subject: input.subject,
            ...(input.roomName === undefined ? {} : { roomName: input.roomName }),
            jitsiDomain: input.jitsiDomain,
            participantActorIds: input.participantActorIds,
            ...(input.scheduledStartAt === undefined
              ? {}
              : { scheduledStartAt: new Date(input.scheduledStartAt), status: "scheduled" }),
            ...(input.scheduledEndAt === undefined
              ? {}
              : { scheduledEndAt: new Date(input.scheduledEndAt) }),
            metadata: toJsonObject(input.metadata),
          }),
        ),
    }),
    defineTool<z.output<typeof listRoomsSchema>, unknown>({
      id: "meet.room.list",
      description: "List Meet rooms visible to the current actor.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listRoomsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        rooms: (
          await options.store.listRoomsForActor({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.status === undefined ? {} : { status: input.status }),
            limit: input.limit,
          })
        ).map(serializeRoom),
      }),
    }),
    defineTool<z.output<typeof listMeetingsSchema>, unknown>({
      id: "meet.meetings.list",
      description:
        "List Meet meetings for the Meet hub: scheduled/upcoming and recent meetings with " +
        "status, host, attendees, join code, recording and summary references.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listMeetingsSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const meetings = (
          await options.store.listMeetingsForActor({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            ...(input.status === undefined ? {} : { status: input.status }),
            limit: input.limit,
          })
        ).map(serializeMeeting);
        return {
          meetings,
          scheduled: meetings.filter((meeting) => meeting.status === "scheduled"),
          recent: meetings.filter((meeting) => meeting.status === "ended"),
          active: meetings.filter((meeting) => meeting.status === "active"),
        };
      },
    }),
    defineTool<z.output<typeof mintTokenSchema>, unknown>({
      id: "meet.mint-token",
      description: "Mint a signed Jitsi JWT for the current actor to join a Meet room.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(mintTokenSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const room = await options.store.getRoomForActor({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
        });
        if (room === null) {
          throw new Error(`Unknown Meet room: ${input.roomId}`);
        }
        if (room.status !== "active") {
          throw new Error(`Meet room has ended: ${input.roomId}`);
        }
        const minted = mintJitsiJwt({
          secret: options.jwtSecret,
          issuer: options.jwtIssuer ?? options.jwtAppId ?? "helix",
          audience: options.jwtAudience,
          subject: options.jwtSubject ?? room.jitsiDomain,
          room: room.roomName,
          ttlSeconds: input.expiresInSeconds,
          user: {
            id: ctx.actor.id,
            name: ctx.actor.displayName ?? ctx.actor.id,
            email: ctx.actor.email ?? "",
            moderator: input.moderator || room.createdByActorId === ctx.actor.id,
          },
        });
        return {
          roomId: room.id,
          roomName: room.roomName,
          jitsiDomain: room.jitsiDomain,
          token: minted.token,
          joinUrl: buildJoinUrl(room.jitsiDomain, room.roomName, minted.token, options.jitsiPublicUrl),
          expiresAt: minted.expiresAt.toISOString(),
        };
      },
    }),
    defineTool<z.output<typeof endRoomSchema>, unknown>({
      id: "meet.end-room",
      description: "End a Meet room and archive the call thread.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(endRoomSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const room = await options.store.endRoom({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
        });
        if (room === null) {
          throw new Error(`Unknown Meet room: ${input.roomId}`);
        }
        return serializeRoom(room);
      },
    }),
  ];
}

export function registerMeetTools(
  registry: RuntimeToolRegistry,
  options: CreateMeetToolDefinitionsOptions,
): void {
  for (const tool of createMeetToolDefinitions(options)) {
    registry.register(tool);
  }
}

export function buildJoinUrl(
  jitsiDomain: string,
  roomName: string,
  token: string,
  publicUrl?: string,
): string {
  // `publicUrl` (env: MEET_JITSI_PUBLIC_URL) is preferred — it carries
  // the protocol + non-default port (e.g. `https://meet.localhost:28452`),
  // which `jitsiDomain` alone doesn't. We append the room name to that
  // origin. Without publicUrl, we fall back to `https://<domain>/<room>`,
  // which drops the port and breaks dev where Jitsi runs on :28452.
  const base = publicUrl !== undefined && publicUrl.length > 0 ? publicUrl : `https://${jitsiDomain}`;
  const url = new URL(`${base.replace(/\/$/, "")}/${encodeURIComponent(roomName)}`);
  url.searchParams.set("jwt", token);
  return url.toString();
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function serializeRoom(room: MeetRoomRecord) {
  return {
    ...room,
    recordingArtifacts: (room.recordingArtifacts ?? []).map(serializeRecordingArtifact),
    startedAt: room.startedAt.toISOString(),
    endedAt: room.endedAt?.toISOString() ?? null,
    scheduledStartAt: room.scheduledStartAt?.toISOString() ?? null,
    scheduledEndAt: room.scheduledEndAt?.toISOString() ?? null,
    createdAt: room.createdAt.toISOString(),
    updatedAt: room.updatedAt.toISOString(),
  };
}

function serializeMeeting(meeting: MeetMeetingRecord) {
  return {
    id: meeting.id,
    orgId: meeting.orgId,
    threadId: meeting.threadId,
    roomName: meeting.roomName,
    subject: meeting.subject,
    title: meeting.subject,
    jitsiDomain: meeting.jitsiDomain,
    status: meeting.status,
    code: meeting.code,
    host: meeting.host,
    attendees: meeting.attendees,
    attendeeCount: meeting.attendeeCount,
    startedAt: meeting.startedAt?.toISOString() ?? null,
    endedAt: meeting.endedAt?.toISOString() ?? null,
    scheduledStartAt: meeting.scheduledStartAt?.toISOString() ?? null,
    scheduledEndAt: meeting.scheduledEndAt?.toISOString() ?? null,
    durationSeconds: meeting.durationSeconds,
    recorded: meeting.recordingArtifacts.length > 0,
    recordingArtifacts: meeting.recordingArtifacts.map(serializeRecordingArtifact),
    summaries: meeting.summaries.map((summary) => ({
      ...summary,
      createdAt: summary.createdAt.toISOString(),
    })),
    metadata: meeting.metadata,
    createdAt: meeting.createdAt.toISOString(),
    updatedAt: meeting.updatedAt.toISOString(),
  };
}

function serializeRecordingArtifact(artifact: MeetRecordingArtifactRecord) {
  return {
    ...artifact,
    createdAt: artifact.createdAt.toISOString(),
    startedAt: artifact.startedAt?.toISOString() ?? null,
    endedAt: artifact.endedAt?.toISOString() ?? null,
  };
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}
