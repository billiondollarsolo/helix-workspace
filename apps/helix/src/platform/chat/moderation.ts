import type postgres from "postgres";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BadRequestError, ForbiddenError } from "../../api/api-error.js";
import { type AdminConsoleAuditSink, auditAdminAction } from "../admin/console-shared.js";
import { withTenantIoSagaPostgresContext } from "../tenancy/postgres-roles.js";

const categorySchema = z.enum([
  "harassment",
  "spam",
  "compromised_account",
  "malicious_attachment",
  "guest_abuse",
  "other",
]);
const evidenceSchema = z.record(z.string(), z.unknown()).default({});
const caseParamsSchema = z.object({ caseId: z.string().uuid() }).strict();
const actorParamsSchema = z.object({ actorId: z.string().uuid() }).strict();
const reportSchema = z
  .object({
    roomId: z.string().uuid(),
    messageId: z.string().uuid().nullable().default(null),
    subjectActorId: z.string().uuid(),
    category: categorySchema,
    description: z.string().trim().min(1).max(4000),
    evidence: evidenceSchema,
  })
  .strict();
const blockSchema = z.object({ reason: z.string().max(1000).default("") }).strict();
const controlsSchema = z
  .object({
    slowModeSeconds: z.number().int().min(0).max(86_400),
    blockedTerms: z.array(z.string().trim().min(1).max(100)).max(100),
    allowedBodyFormats: z.array(z.enum(["plain", "markdown"])).min(1),
    allowExternalGuests: z.boolean(),
  })
  .strict();
const queueQuerySchema = z
  .object({
    roomId: z.string().uuid(),
    status: z.enum(["queued", "actioned", "dismissed", "appealed", "resolved"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const actionSchema = z
  .object({
    action: z.enum(["remove_message", "ban_actor", "dismiss", "uphold", "reinstate"]),
    reason: z.string().max(2000).default(""),
    banExpiresAt: z.string().datetime({ offset: true }).nullable().default(null),
    evidence: evidenceSchema,
  })
  .strict();
const appealSchema = z
  .object({
    reason: z.string().trim().min(1).max(4000),
    evidence: evidenceSchema,
  })
  .strict();
const addEvidenceSchema = z.object({ evidence: evidenceSchema }).strict();

export interface ChatModerationCase {
  readonly id: string;
  readonly roomId: string;
  readonly reportedMessageId: string | null;
  readonly reporterActorId: string;
  readonly subjectActorId: string;
  readonly category: z.infer<typeof categorySchema>;
  readonly description: string;
  readonly status: "queued" | "actioned" | "dismissed" | "appealed" | "resolved";
  readonly resolution: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly evidence: readonly unknown[];
}

export interface ChatModerationSignal {
  readonly id: string;
  readonly actorId: string;
  readonly sourceMessageId: string | null;
  readonly signalType: string;
  readonly score: number;
  readonly evidence: unknown;
  readonly createdAt: string;
}

export interface ChatModerationStore {
  report(input: z.infer<typeof reportSchema> & { orgId: string; actorId: string }): Promise<string>;
  setBlock(input: {
    orgId: string;
    actorId: string;
    blockedActorId: string;
    blocked: boolean;
    reason: string;
  }): Promise<void>;
  configure(
    input: z.infer<typeof controlsSchema> & {
      orgId: string;
      actorId: string;
      roomId: string;
    },
  ): Promise<void>;
  listQueue(input: {
    orgId: string;
    actorId: string;
    roomId: string;
    status?: string | undefined;
    limit: number;
  }): Promise<{
    cases: readonly ChatModerationCase[];
    signals: readonly ChatModerationSignal[];
  } | null>;
  moderate(
    input: z.infer<typeof actionSchema> & {
      orgId: string;
      actorId: string;
      caseId: string;
    },
  ): Promise<void>;
  appeal(
    input: z.infer<typeof appealSchema> & {
      orgId: string;
      actorId: string;
      caseId: string;
    },
  ): Promise<void>;
  addEvidence(input: {
    orgId: string;
    actorId: string;
    caseId: string;
    evidence: Record<string, unknown>;
  }): Promise<void>;
}

interface CaseRow {
  readonly id: string;
  readonly room_id: string;
  readonly reported_message_id: string | null;
  readonly reporter_actor_id: string;
  readonly subject_actor_id: string;
  readonly category: ChatModerationCase["category"];
  readonly description: string;
  readonly status: ChatModerationCase["status"];
  readonly resolution: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly evidence: readonly unknown[];
}

interface SignalRow {
  readonly id: string;
  readonly actor_id: string;
  readonly source_message_id: string | null;
  readonly signal_type: string;
  readonly score: number;
  readonly evidence: unknown;
  readonly created_at: Date;
}

export class PostgresChatModerationStore implements ChatModerationStore {
  constructor(private readonly sql: postgres.Sql) {}

  async report(input: z.infer<typeof reportSchema> & { orgId: string; actorId: string }) {
    return this.withActor(input, async (tx) => {
      const rows = await tx<{ case_id: string }[]>`
        select helix_report_chat_abuse(
          ${input.orgId}, ${input.actorId}, ${input.roomId}, ${input.messageId},
          ${input.subjectActorId}, ${input.category}, ${input.description},
          ${tx.json(input.evidence as postgres.JSONValue)}
        ) as case_id
      `;
      return rows[0]?.case_id ?? "";
    });
  }

  async setBlock(input: {
    orgId: string;
    actorId: string;
    blockedActorId: string;
    blocked: boolean;
    reason: string;
  }) {
    await this.withActor(
      input,
      (tx) => tx`
      select helix_set_chat_block(
        ${input.orgId}, ${input.actorId}, ${input.blockedActorId}, ${input.blocked}, ${input.reason}
      )
    `,
    );
  }

  async configure(
    input: z.infer<typeof controlsSchema> & {
      orgId: string;
      actorId: string;
      roomId: string;
    },
  ) {
    await this.withActor(
      input,
      (tx) => tx`
      select helix_configure_chat_moderation(
        ${input.orgId}, ${input.actorId}, ${input.roomId}, ${input.slowModeSeconds},
        ${input.blockedTerms}, ${input.allowedBodyFormats}, ${input.allowExternalGuests}
      )
    `,
    );
  }

  async listQueue(input: {
    orgId: string;
    actorId: string;
    roomId: string;
    status?: string | undefined;
    limit: number;
  }) {
    return this.withActor(input, async (tx) => {
      const moderatorRows = await tx<{ allowed: boolean }[]>`
        select helix_chat_is_room_moderator(${input.orgId}, ${input.actorId}, ${input.roomId}) as allowed
      `;
      if (moderatorRows[0]?.allowed !== true) return null;
      const status = input.status ?? null;
      const cases = await tx<CaseRow[]>`
        select moderation_case.*,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', event.id, 'actorId', event.actor_id, 'type', event.event_type,
                'evidence', event.evidence, 'createdAt', event.created_at
              ) order by event.created_at, event.id
            ) filter (where event.id is not null),
            '[]'::jsonb
          ) as evidence
        from chat_moderation_cases moderation_case
        left join chat_moderation_case_events event
          on event.org_id = moderation_case.org_id and event.case_id = moderation_case.id
        where moderation_case.org_id = ${input.orgId}
          and moderation_case.room_id = ${input.roomId}
          and (${status}::text is null or moderation_case.status = ${status})
        group by moderation_case.id
        order by moderation_case.created_at, moderation_case.id
        limit ${input.limit}
      `;
      const signals = await tx<SignalRow[]>`
        select * from chat_abuse_signals
        where org_id = ${input.orgId} and room_id = ${input.roomId}
        order by created_at desc, id desc limit ${input.limit}
      `;
      return {
        cases: cases.map((row) => ({
          id: row.id,
          roomId: row.room_id,
          reportedMessageId: row.reported_message_id,
          reporterActorId: row.reporter_actor_id,
          subjectActorId: row.subject_actor_id,
          category: row.category,
          description: row.description,
          status: row.status,
          resolution: row.resolution,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
          evidence: row.evidence,
        })),
        signals: signals.map((row) => ({
          id: row.id,
          actorId: row.actor_id,
          sourceMessageId: row.source_message_id,
          signalType: row.signal_type,
          score: row.score,
          evidence: row.evidence,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  }

  async moderate(
    input: z.infer<typeof actionSchema> & {
      orgId: string;
      actorId: string;
      caseId: string;
    },
  ) {
    await this.withActor(
      input,
      (tx) => tx`
      select helix_moderate_chat_case(
        ${input.orgId}, ${input.actorId}, ${input.caseId}, ${input.action}, ${input.reason},
        ${input.banExpiresAt}, ${tx.json(input.evidence as postgres.JSONValue)}
      )
    `,
    );
  }

  async appeal(
    input: z.infer<typeof appealSchema> & {
      orgId: string;
      actorId: string;
      caseId: string;
    },
  ) {
    await this.withActor(
      input,
      (tx) => tx`
      select helix_appeal_chat_case(
        ${input.orgId}, ${input.actorId}, ${input.caseId}, ${input.reason},
        ${tx.json(input.evidence as postgres.JSONValue)}
      )
    `,
    );
  }

  async addEvidence(input: {
    orgId: string;
    actorId: string;
    caseId: string;
    evidence: Record<string, unknown>;
  }) {
    await this.withActor(
      input,
      (tx) => tx`
      select helix_add_chat_case_evidence(
        ${input.orgId}, ${input.actorId}, ${input.caseId},
        ${tx.json(input.evidence as postgres.JSONValue)}
      )
    `,
    );
  }

  private async withActor<T>(
    input: { orgId: string; actorId: string },
    operation: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    try {
      return await withTenantIoSagaPostgresContext(this.sql, input, operation);
    } catch (error) {
      if (isPostgresError(error, "42501")) throw new ForbiddenError("Chat moderation denied.");
      if (isPostgresError(error, "23514"))
        throw new BadRequestError("Chat moderation request rejected.");
      throw error;
    }
  }
}

export interface RegisterChatModerationRoutesOptions {
  readonly store: ChatModerationStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly audit: AdminConsoleAuditSink;
}

export async function registerChatModerationRoutes(
  app: FastifyInstance,
  options: RegisterChatModerationRoutesOptions,
): Promise<void> {
  app.post("/api/chat/moderation/reports", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const body = reportSchema.parse(request.body);
    const caseId = await options.store.report({ orgId: actor.orgId, actorId: actor.id, ...body });
    await audit(options, actor, "chat.moderation.reported", caseId, {
      roomId: body.roomId,
      category: body.category,
      subjectActorId: body.subjectActorId,
    });
    return reply.code(201).send({ caseId });
  });

  app.put("/api/chat/moderation/blocks/:actorId", async (request) => {
    const actor = await options.actorFromRequest(request);
    const { actorId: blockedActorId } = actorParamsSchema.parse(request.params);
    const body = blockSchema.parse(request.body);
    await options.store.setBlock({
      orgId: actor.orgId,
      actorId: actor.id,
      blockedActorId,
      blocked: true,
      reason: body.reason,
    });
    await audit(options, actor, "chat.moderation.blocked", blockedActorId);
    return { ok: true };
  });

  app.delete("/api/chat/moderation/blocks/:actorId", async (request) => {
    const actor = await options.actorFromRequest(request);
    const { actorId: blockedActorId } = actorParamsSchema.parse(request.params);
    await options.store.setBlock({
      orgId: actor.orgId,
      actorId: actor.id,
      blockedActorId,
      blocked: false,
      reason: "",
    });
    await audit(options, actor, "chat.moderation.unblocked", blockedActorId);
    return { ok: true };
  });

  app.put("/api/chat/rooms/:roomId/moderation", async (request) => {
    const actor = await options.actorFromRequest(request);
    const { roomId } = z.object({ roomId: z.string().uuid() }).strict().parse(request.params);
    const body = controlsSchema.parse(request.body);
    await options.store.configure({ orgId: actor.orgId, actorId: actor.id, roomId, ...body });
    await audit(options, actor, "chat.moderation.controls.updated", roomId, body);
    return { ok: true };
  });

  app.get("/api/chat/moderation/queue", async (request) => {
    const actor = await options.actorFromRequest(request);
    const query = queueQuerySchema.parse(request.query);
    const queue = await options.store.listQueue({
      orgId: actor.orgId,
      actorId: actor.id,
      ...query,
    });
    if (queue === null) throw new ForbiddenError("Chat moderator access required.");
    return queue;
  });

  app.post("/api/chat/moderation/cases/:caseId/actions", async (request) => {
    const actor = await options.actorFromRequest(request);
    const { caseId } = caseParamsSchema.parse(request.params);
    const body = actionSchema.parse(request.body);
    if (body.action === "ban_actor" && body.reason.trim() === "") {
      throw new BadRequestError("A ban reason is required.");
    }
    await options.store.moderate({ orgId: actor.orgId, actorId: actor.id, caseId, ...body });
    await audit(options, actor, `chat.moderation.${body.action}`, caseId, {
      banExpiresAt: body.banExpiresAt,
    });
    return { ok: true };
  });

  app.post("/api/chat/moderation/cases/:caseId/appeal", async (request) => {
    const actor = await options.actorFromRequest(request);
    const { caseId } = caseParamsSchema.parse(request.params);
    const body = appealSchema.parse(request.body);
    await options.store.appeal({ orgId: actor.orgId, actorId: actor.id, caseId, ...body });
    await audit(options, actor, "chat.moderation.appealed", caseId);
    return { ok: true };
  });

  app.post("/api/chat/moderation/cases/:caseId/evidence", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    const { caseId } = caseParamsSchema.parse(request.params);
    const { evidence } = addEvidenceSchema.parse(request.body);
    await options.store.addEvidence({ orgId: actor.orgId, actorId: actor.id, caseId, evidence });
    await audit(options, actor, "chat.moderation.evidence.added", caseId);
    return reply.code(201).send({ ok: true });
  });
}

function audit(
  options: RegisterChatModerationRoutesOptions,
  actor: Actor,
  verb: string,
  objectId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  return auditAdminAction(options.audit, {
    orgId: actor.orgId,
    actorId: actor.id,
    verb,
    objectType: "chat_moderation_case",
    objectId,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function isPostgresError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
