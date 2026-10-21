import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { NotFoundError } from "../../api/api-error.js";
import type { PlatformMetrics } from "../../api/metrics.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { toJsonObject } from "../util/json.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { meetGuestInviteTokenHash, mintMeetGuestInviteToken } from "./guest-invites.js";
import { liveKitJoin, type LiveKitOptions } from "./livekit.js";
import {
  InMemoryMeetRateLimiter,
  meetRateLimitError,
  type MeetRateLimitBudget,
  type MeetRateLimiter,
} from "./rate-limit.js";
import { openRoomForMemberJoin } from "./scheduled-join.js";
import { MEET_RECORDING_NOTICE_VERSION, type MeetStore } from "./store.js";
import type {
  MeetGuestInviteRecord,
  MeetMeetingRecord,
  MeetRecordingArtifactRecord,
  MeetRoomRecord,
} from "./types.js";
import { applyHostControlToCall } from "./host-control-media.js";
import { createLiveKitRooms, type LiveKitRooms } from "./livekit-rooms.js";
import { meetJwtFeatures } from "./policy.js";
import type { MeetEgressRecordingStore } from "./egress-store.js";
import { createLiveKitEgress, type LiveKitEgress } from "./livekit-egress.js";
import { createMeetRecordingTools } from "./recording-tools.js";
export { meetJwtFeatures } from "./policy.js";

const uuidSchema = z.string().uuid();
const metadataSchema = z.record(z.string(), z.unknown()).default({});

const createRoomSchema = z
  .object({
    subject: z.string().min(1).max(200),
    roomName: z.string().min(1).max(128).optional(),
    participantActorIds: z.array(uuidSchema).default([]),
    /**
     * When set, the room is created in the `scheduled` lifecycle state for the
     * Meet hub's upcoming panel instead of starting an instant `active` room.
     */
    scheduledStartAt: z.string().datetime().optional(),
    scheduledEndAt: z.string().datetime().optional(),
    guestPolicy: z.enum(["disabled", "invite", "domain"]).default("disabled"),
    guestDomains: z.array(z.string().trim().toLowerCase()).max(50).default([]),
    lobbyEnabled: z.boolean().default(true),
    metadata: metadataSchema,
  })
  .strict()
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

const recordingConsentShape = {
  recordingNoticeAccepted: z.literal(true),
  recordingNoticeVersion: z.literal(MEET_RECORDING_NOTICE_VERSION),
  deviceId: uuidSchema,
  joinGrantId: uuidSchema,
} as const;

const mintTokenSchema = z
  .object({
    roomId: uuidSchema,
    expiresInSeconds: z
      .number()
      .int()
      .positive()
      .max(5 * 60)
      .default(5 * 60),
    ...recordingConsentShape,
  })
  .strict();

const endRoomSchema = z.object({
  roomId: uuidSchema,
});

const joinByCodeSchema = z
  .object({
    code: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/u),
    ...recordingConsentShape,
  })
  .strict();

const meetTelemetrySchema = z
  .discriminatedUnion("event", [
    z
      .object({
        roomId: uuidSchema,
        event: z.literal("join_latency"),
        joinLatencyMs: z.number().min(0).max(300_000),
      })
      .strict(),
    z
      .object({
        roomId: uuidSchema,
        event: z.literal("device_failure"),
        device: z.enum(["camera", "microphone", "screen"]),
      })
      .strict(),
    z
      .object({
        roomId: uuidSchema,
        event: z.literal("quality"),
        packetLossPercent: z.number().min(0).max(100).optional(),
        jitterMs: z.number().min(0).max(10_000).optional(),
        rttMs: z.number().min(0).max(60_000).optional(),
        bitrateKbps: z.number().min(0).max(1_000_000).optional(),
        connectionQuality: z.number().min(0).max(100).optional(),
        bridgeLoadPercent: z.number().min(0).max(100).optional(),
      })
      .strict(),
  ])
  .refine(
    (value) => value.event !== "quality" || Object.keys(value).length > 2,
    "At least one quality metric is required.",
  );

const createGuestInviteSchema = z.object({
  roomId: uuidSchema,
  email: z
    .string()
    .email()
    .transform((email) => email.toLowerCase()),
  expiresInSeconds: z
    .number()
    .int()
    .min(300)
    .max(30 * 24 * 60 * 60)
    .default(24 * 60 * 60),
});

const revokeGuestInviteSchema = z.object({ inviteId: uuidSchema });
const participantSubjectSchema = z.string().trim().min(1).max(200);
const mediaParticipantIdSchema = z.string().trim().min(1).max(200);
const audiencePolicySchema = z.enum(["everyone", "hosts", "disabled"]);
const roomIdShape = { roomId: uuidSchema } as const;
const hostControlSchema = z.discriminatedUnion("action", [
  z.object({ ...roomIdShape, action: z.literal("set_lobby"), enabled: z.boolean() }).strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("admit"),
      participantSubject: participantSubjectSchema,
      mediaParticipantId: mediaParticipantIdSchema,
    })
    .strict(),
  z.object({ ...roomIdShape, action: z.literal("set_lock"), locked: z.boolean() }).strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("remove"),
      participantSubject: participantSubjectSchema,
      mediaParticipantId: mediaParticipantIdSchema,
      ban: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("set_mute_policy"),
      policy: z.enum(["open", "moderated"]),
    })
    .strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("mute"),
      participantSubject: participantSubjectSchema,
      mediaParticipantId: mediaParticipantIdSchema,
      mediaType: z.enum(["audio", "video"]),
    })
    .strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("set_presenter"),
      policy: z.enum(["everyone", "hosts", "selected"]),
      participantSubject: participantSubjectSchema.optional(),
      mediaParticipantId: mediaParticipantIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("set_cohost"),
      actorId: uuidSchema,
      mediaParticipantId: mediaParticipantIdSchema,
      enabled: z.boolean(),
    })
    .strict(),
  z
    .object({ ...roomIdShape, action: z.literal("set_chat_policy"), policy: audiencePolicySchema })
    .strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("set_reaction_policy"),
      policy: audiencePolicySchema,
    })
    .strict(),
  z
    .object({
      ...roomIdShape,
      action: z.literal("transfer_host"),
      actorId: uuidSchema,
      mediaParticipantId: mediaParticipantIdSchema,
    })
    .strict(),
]);
const roomControlSchema = z.object({ roomId: uuidSchema }).strict();

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

/** Every Meet tool declares the same open output shape; the adapter is stateless. */
const unknownOutputSchema = zodToolSchema(z.unknown(), genericObjectJsonSchema);

export interface CreateMeetToolDefinitionsOptions {
  readonly store: MeetStore;
  readonly liveKit: LiveKitOptions;
  /** LiveKit's room service; defaults to the configured server. */
  readonly rooms?: LiveKitRooms | undefined;
  /** Recording through LiveKit Egress; recording is unavailable without these. */
  readonly recordings?: MeetEgressRecordingStore | undefined;
  readonly egress?: LiveKitEgress | undefined;
  readonly recordingDir?: string | undefined;
  readonly publicBaseUrl?: string | undefined;
  /** Live recorder readiness. Recording is unavailable when omitted or false. */
  readonly recordingAvailable?: (() => Promise<boolean>) | undefined;
  readonly metrics?: PlatformMetrics | undefined;
  readonly guestInviteSecret: string;
  /** Abuse rate limiter for create/join (MT.6). Defaults to in-memory. */
  readonly rateLimiter?: MeetRateLimiter | undefined;
  readonly rateLimitBudget?: Partial<MeetRateLimitBudget> | undefined;
}

function createMeetToolDefinitions(
  options: CreateMeetToolDefinitionsOptions,
): readonly ToolDefinition[] {
  let liveKitRooms = options.rooms;
  const rooms = () => (liveKitRooms ??= createLiveKitRooms(options.liveKit));
  let liveKitEgress: LiveKitEgress | undefined;
  // Spread rather than pass `budget: undefined` so exactOptionalPropertyTypes holds.
  const budgetOption =
    options.rateLimitBudget === undefined ? {} : { budget: options.rateLimitBudget };
  const rateLimiter = options.rateLimiter ?? new InMemoryMeetRateLimiter({ ...budgetOption });
  return [
    defineTool<z.output<typeof createRoomSchema>, unknown>({
      id: "meet.create-room",
      description: "Create a Meet room and call thread.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(createRoomSchema, genericObjectJsonSchema),
      outputSchema: unknownOutputSchema,
      handler: async (input, ctx) => {
        const decision = await rateLimiter.consume({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          action: "create_room",
          ...budgetOption,
        });
        if (!decision.allowed) {
          throw meetRateLimitError(decision);
        }
        return serializeRoom(
          await options.store.createRoom({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            subject: input.subject,
            ...(input.roomName === undefined ? {} : { roomName: input.roomName }),
            mediaDomain: new URL(options.liveKit.publicUrl).hostname,
            participantActorIds: input.participantActorIds,
            ...(input.scheduledStartAt === undefined
              ? {}
              : { scheduledStartAt: new Date(input.scheduledStartAt), status: "scheduled" }),
            ...(input.scheduledEndAt === undefined
              ? {}
              : { scheduledEndAt: new Date(input.scheduledEndAt) }),
            guestPolicy: input.guestPolicy,
            guestDomains: input.guestDomains,
            lobbyEnabled: input.lobbyEnabled,
            metadata: toJsonObject(input.metadata),
          }),
        );
      },
    }),
    defineTool<z.output<typeof listRoomsSchema>, unknown>({
      id: "meet.room.list",
      description: "List Meet rooms visible to the current actor.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(listRoomsSchema, genericObjectJsonSchema),
      outputSchema: unknownOutputSchema,
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
      outputSchema: unknownOutputSchema,
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
    defineTool<z.output<typeof joinByCodeSchema>, unknown>({
      id: "meet.join-by-code",
      description: "Join an authorized meeting by its code, opening it if it is scheduled.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(joinByCodeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const room = await options.store.getRoomForActorByCode({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          code: input.code,
        });
        if (room === null || room.status === "ended")
          throw new NotFoundError("Unknown active meeting.");
        const open = await openRoomForMemberJoin(options.store, room, ctx.actor.id);
        return mintMemberJoin(options, open, ctx.actor, input);
      },
    }),
    defineTool<z.output<typeof createGuestInviteSchema>, unknown>({
      id: "meet.guest-invite.create",
      description: "Create a signed, expiring guest invitation for a meeting.",
      permission: "meet.write",
      sideEffects: "external_communication",
      confirmationRequired: true,
      inputSchema: zodToolSchema(createGuestInviteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const id = randomUUID();
        const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
        const token = mintMeetGuestInviteToken(options.guestInviteSecret, {
          inviteId: id,
          orgId: ctx.actor.orgId,
          roomId: input.roomId,
          expiresAt,
        });
        const invite = await options.store.createGuestInvite({
          id,
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
          email: input.email,
          tokenHash: meetGuestInviteTokenHash(token),
          expiresAt,
        });
        if (invite === null) throw new Error("Guest invitations are not allowed for this meeting.");
        return { invite: serializeGuestInvite(invite), token };
      },
    }),
    defineTool<z.output<typeof revokeGuestInviteSchema>, unknown>({
      id: "meet.guest-invite.revoke",
      description: "Revoke a guest meeting invitation immediately.",
      permission: "meet.write",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(revokeGuestInviteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        revoked: await options.store.revokeGuestInvite({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          inviteId: input.inviteId,
        }),
      }),
    }),
    defineTool<z.output<typeof mintTokenSchema>, unknown>({
      id: "meet.mint-token",
      description: "Mint a short-lived media token for the current actor to join a Meet room.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(mintTokenSchema, genericObjectJsonSchema),
      outputSchema: unknownOutputSchema,
      handler: async (input, ctx) => {
        const room = await options.store.getRoomForActor({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
        });
        if (room === null) {
          throw new NotFoundError(`Unknown Meet room: ${input.roomId}`);
        }
        if (room.status === "ended") throw new Error(`Meet room has ended: ${input.roomId}`);
        const decision = await rateLimiter.consume({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          action: "join_room",
          ...budgetOption,
        });
        if (!decision.allowed) {
          throw meetRateLimitError(decision);
        }
        const open = await openRoomForMemberJoin(options.store, room, ctx.actor.id);
        return mintMemberJoin(options, open, ctx.actor, input, input.expiresInSeconds);
      },
    }),
    defineTool<z.output<typeof roomControlSchema>, unknown>({
      id: "meet.host-controls.get",
      description: "Read authoritative meeting controls and attendance.",
      permission: "meet.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(roomControlSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const state = await options.store.getControlState?.({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
        });
        if (state === null || state === undefined)
          throw new NotFoundError(`Unknown Meet room: ${input.roomId}`);
        const canModerate =
          (await options.store.canModerateRoom?.({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
          })) === true;
        const attendance = canModerate
          ? ((await options.store.listAttendance?.({
              orgId: ctx.actor.orgId,
              actorId: ctx.actor.id,
              roomId: input.roomId,
            })) ?? [])
          : [];
        return {
          state,
          canModerate,
          isHost: state.hostActorId === ctx.actor.id,
          attendance: attendance.map((entry) => ({
            ...entry,
            joinedAt: entry.joinedAt?.toISOString() ?? null,
            leftAt: entry.leftAt?.toISOString() ?? null,
          })),
        };
      },
    }),
    defineTool<z.output<typeof hostControlSchema>, unknown>({
      id: "meet.host-controls.apply",
      description: "Apply and audit a server-authorized meeting host control.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(hostControlSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const { roomId, ...control } = input;
        const result = await options.store.applyControl?.({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId,
          control,
        });
        if (result === null || result === undefined) throw new Error("Host control was rejected.");
        // The change is recorded either way; say whether the live call took it too.
        const callUpdated = await applyHostControlToCall(rooms(), {
          orgId: ctx.actor.orgId,
          roomId,
          control,
          state: result.state,
        }).then(
          () => true,
          () => false,
        );
        return { state: result.state, callUpdated };
      },
    }),
    defineTool<z.output<typeof meetTelemetrySchema>, unknown>({
      id: "meet.telemetry.record",
      description: "Record a bounded privacy-safe call quality or device event.",
      permission: "meet.read",
      sideEffects: "write",
      confirmationRequired: false,
      inputSchema: zodToolSchema(meetTelemetrySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.metrics === undefined) throw new Error("Meet telemetry is unavailable.");
        if (
          (await options.store.getRoomForActor({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            roomId: input.roomId,
          })) === null
        ) {
          throw new NotFoundError(`Unknown Meet room: ${input.roomId}`);
        }
        if (input.event === "join_latency") {
          options.metrics.recordMeetQuality({ joinLatencySeconds: input.joinLatencyMs / 1_000 });
        } else if (input.event === "device_failure") {
          options.metrics.recordMeetParticipantEvent({
            event: "device_failure",
            device: input.device,
          });
        } else {
          options.metrics.recordMeetQuality({
            packetLossPercent: input.packetLossPercent,
            jitterSeconds: millisecondsToSeconds(input.jitterMs),
            rttSeconds: millisecondsToSeconds(input.rttMs),
            bitrateKbps: input.bitrateKbps,
            connectionQuality: input.connectionQuality,
            bridgeLoadPercent: input.bridgeLoadPercent,
          });
        }
        return { accepted: true };
      },
    }),
    defineTool<z.output<typeof endRoomSchema>, unknown>({
      id: "meet.end-room",
      description: "End a Meet room and archive the call thread.",
      permission: "meet.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(endRoomSchema, genericObjectJsonSchema),
      outputSchema: unknownOutputSchema,
      handler: async (input, ctx) => {
        const room = await options.store.endRoom({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
        });
        if (room === null) {
          throw new NotFoundError(`Unknown Meet room: ${input.roomId}`);
        }
        // Disconnect everyone still in the call; the room is already ended in Helix.
        const callEnded = await rooms()
          .deleteRoom(ctx.actor.orgId, input.roomId)
          .then(
            () => true,
            () => false,
          );
        return { ...serializeRoom(room), callEnded };
      },
    }),
    ...createMeetRecordingTools({
      store: options.store,
      recordings: options.recordings,
      egress: () => (liveKitEgress ??= options.egress ?? createLiveKitEgress(options.liveKit)),
      recordingDir: options.recordingDir,
      recordingAvailable: options.recordingAvailable,
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

async function mintMemberJoin(
  options: CreateMeetToolDefinitionsOptions,
  room: MeetRoomRecord,
  actor: Actor,
  consent: {
    readonly recordingNoticeAccepted: true;
    readonly recordingNoticeVersion: typeof MEET_RECORDING_NOTICE_VERSION;
    readonly deviceId: string;
    readonly joinGrantId: string;
  },
  ttlSeconds = 5 * 60,
) {
  const controls = await options.store.authorizeJoin?.({
    orgId: actor.orgId,
    roomId: room.id,
    participantSubject: actor.id,
  });
  if (controls === null || controls === undefined) {
    throw new Error("Meeting entry is locked or this participant is banned.");
  }
  const moderator =
    (await options.store.canModerateRoom?.({
      orgId: actor.orgId,
      actorId: actor.id,
      roomId: room.id,
    })) === true;
  const consentExpiresAt = new Date(Date.now() + ttlSeconds * 1_000);
  if (
    !(await options.store.recordMemberRecordingConsent({
      orgId: actor.orgId,
      roomId: room.id,
      actorId: actor.id,
      joinGrantId: consent.joinGrantId,
      deviceId: consent.deviceId,
      expiresAt: consentExpiresAt,
    }))
  ) {
    throw new Error("Recording notice consent could not be recorded.");
  }
  const join = liveKitJoin(options.liveKit, {
    orgId: actor.orgId,
    roomId: room.id,
    identity: actor.id,
    name: actor.displayName ?? actor.id,
    moderator,
    features: meetJwtFeatures(controls, actor.id, moderator),
    consentVersion: MEET_RECORDING_NOTICE_VERSION,
    ttlSeconds,
  });
  return {
    roomId: room.id,
    roomName: room.roomName,
    subject: room.subject,
    code: room.joinCode,
    mediaDomain: room.mediaDomain,
    ...join,
    recordingAvailable: (await options.recordingAvailable?.()) === true,
    canStartRecording: moderator,
    recordingNoticeVersion: MEET_RECORDING_NOTICE_VERSION,
    recordingActive: room.recordingActive ?? false,
    controls,
    canModerate: moderator,
  };
}

function millisecondsToSeconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value / 1_000;
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
    mediaDomain: meeting.mediaDomain,
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

function serializeGuestInvite(invite: MeetGuestInviteRecord) {
  return {
    ...invite,
    expiresAt: invite.expiresAt.toISOString(),
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  };
}
