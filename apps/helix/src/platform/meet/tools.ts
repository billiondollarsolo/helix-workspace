import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PlatformMetrics } from "../../api/metrics.js";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { toJsonObject } from "../util/json.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { meetGuestInviteTokenHash, mintMeetGuestInviteToken } from "./guest-invites.js";
import { mintJitsiJwt } from "./jwt.js";
import {
  InMemoryMeetRateLimiter,
  meetRateLimitError,
  type MeetRateLimitBudget,
  type MeetRateLimiter,
} from "./rate-limit.js";
import { MEET_RECORDING_NOTICE_VERSION, type MeetStore } from "./store.js";
import type {
  MeetAudiencePolicy,
  MeetControlState,
  MeetGuestInviteRecord,
  MeetMeetingRecord,
  MeetRecordingArtifactRecord,
  MeetRoomRecord,
} from "./types.js";

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

const authorizeRecordingSchema = z.object({ roomId: uuidSchema }).strict();

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
  /** Live recorder readiness. Recording is unavailable when omitted or false. */
  readonly recordingAvailable?: (() => Promise<boolean>) | undefined;
  readonly metrics?: PlatformMetrics | undefined;
  readonly guestInviteSecret?: string | undefined;
  /** Abuse rate limiter for create/join (MT.6). Defaults to in-memory. */
  readonly rateLimiter?: MeetRateLimiter | undefined;
  readonly rateLimitBudget?: Partial<MeetRateLimitBudget> | undefined;
}

function createMeetToolDefinitions(
  options: CreateMeetToolDefinitionsOptions,
): readonly ToolDefinition[] {
  const jitsiOrigin = deploymentJitsiOrigin(options);
  const jitsiDomain = new URL(jitsiOrigin).hostname;
  // Spread rather than pass `budget: undefined` so exactOptionalPropertyTypes holds.
  const budgetOption =
    options.rateLimitBudget === undefined ? {} : { budget: options.rateLimitBudget };
  const rateLimiter = options.rateLimiter ?? new InMemoryMeetRateLimiter({ ...budgetOption });
  return [
    defineTool<z.output<typeof createRoomSchema>, unknown>({
      id: "meet.create-room",
      description: "Create a Jitsi-backed Meet room and call thread.",
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
            jitsiDomain,
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
      description: "Join an authorized active meeting by its indexed code.",
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
        if (room === null || room.status !== "active") throw new Error("Unknown active meeting.");
        return mintMemberJoin(options, room, ctx.actor, input, jitsiOrigin);
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
        const token = mintMeetGuestInviteToken(options.guestInviteSecret ?? options.jwtSecret, {
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
      description: "Mint a signed Jitsi JWT for the current actor to join a Meet room.",
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
          throw new Error(`Unknown Meet room: ${input.roomId}`);
        }
        if (room.status !== "active") {
          throw new Error(`Meet room has ended: ${input.roomId}`);
        }
        const decision = await rateLimiter.consume({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          action: "join_room",
          ...budgetOption,
        });
        if (!decision.allowed) {
          throw meetRateLimitError(decision);
        }
        return mintMemberJoin(options, room, ctx.actor, input, jitsiOrigin, input.expiresInSeconds);
      },
    }),
    defineTool<z.output<typeof authorizeRecordingSchema>, unknown>({
      id: "meet.recording.authorize-start",
      description:
        "Authorize a recording start only after every participant currently in the meeting consented.",
      permission: "meet.write",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(authorizeRecordingSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.unknown(), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if ((await options.recordingAvailable?.()) !== true) {
          throw new Error("Meeting recording is unavailable.");
        }
        const authorization = await options.store.authorizeRecordingStart({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          roomId: input.roomId,
        });
        if (authorization === null) {
          throw new Error(
            "Recording requires an active moderator and current consent from every participant.",
          );
        }
        return {
          authorizationId: authorization.id,
          expiresAt: authorization.expiresAt.toISOString(),
          participantSubjects: authorization.participantSubjects,
        };
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
          throw new Error(`Unknown Meet room: ${input.roomId}`);
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
        return result;
      },
    }),
    defineTool<z.output<typeof meetTelemetrySchema>, unknown>({
      id: "meet.telemetry.record",
      description: "Record a bounded privacy-safe Jitsi quality or device event.",
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
          throw new Error(`Unknown Meet room: ${input.roomId}`);
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
          throw new Error(`Unknown Meet room: ${input.roomId}`);
        }
        return serializeRoom(room);
      },
    }),
  ];
}

function deploymentJitsiOrigin(options: CreateMeetToolDefinitionsOptions): string {
  const configured = options.jitsiPublicUrl ?? `https://${options.jwtSubject ?? "meet.localhost"}`;
  const url = new URL(configured);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    !url.hostname.endsWith(".localhost")
  ) {
    throw new TypeError("Jitsi public URL must use HTTPS outside localhost.");
  }
  return url.origin;
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
  const base =
    publicUrl !== undefined && publicUrl.length > 0 ? publicUrl : `https://${jitsiDomain}`;
  const url = new URL(`${base.replace(/\/$/, "")}/${encodeURIComponent(roomName)}`);
  url.searchParams.set("jwt", token);
  return url.toString();
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
  jitsiOrigin: string,
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
  const minted = mintJitsiJwt({
    secret: options.jwtSecret,
    issuer: options.jwtIssuer ?? options.jwtAppId ?? "helix",
    audience: options.jwtAudience,
    subject: options.jwtSubject ?? new URL(jitsiOrigin).hostname,
    room: room.roomName,
    ttlSeconds,
    user: {
      id: actor.id,
      name: actor.displayName ?? actor.id,
      email: actor.email ?? "",
      moderator,
    },
    features: meetJwtFeatures(controls, actor.id, moderator),
  });
  return {
    roomId: room.id,
    roomName: room.roomName,
    subject: room.subject,
    code: room.joinCode,
    jitsiDomain: room.jitsiDomain,
    token: minted.token,
    joinUrl: buildJoinUrl(room.jitsiDomain, room.roomName, minted.token, jitsiOrigin),
    expiresAt: minted.expiresAt.toISOString(),
    recordingAvailable: (await options.recordingAvailable?.()) === true,
    canStartRecording: moderator,
    recordingNoticeVersion: MEET_RECORDING_NOTICE_VERSION,
    recordingActive: room.recordingActive ?? false,
    controls,
    canModerate: moderator,
  };
}

export function meetJwtFeatures(
  controls: MeetControlState,
  participantSubject: string,
  moderator: boolean,
) {
  const audienceAllows = (policy: MeetAudiencePolicy) =>
    policy === "everyone" || (policy === "hosts" && moderator);
  const canPresent =
    controls.presenterPolicy === "everyone" ||
    (controls.presenterPolicy === "hosts" && moderator) ||
    (controls.presenterPolicy === "selected" && controls.presenterSubject === participantSubject);
  return {
    "send-groupchat": audienceAllows(controls.chatPolicy),
    "send-reactions": audienceAllows(controls.reactionPolicy),
    "screen-sharing": canPresent,
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

function serializeGuestInvite(invite: MeetGuestInviteRecord) {
  return {
    ...invite,
    expiresAt: invite.expiresAt.toISOString(),
    revokedAt: invite.revokedAt?.toISOString() ?? null,
    createdAt: invite.createdAt.toISOString(),
  };
}
