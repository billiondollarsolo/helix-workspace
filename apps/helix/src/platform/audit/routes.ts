import type { Actor, JsonObject } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";

const adminAuditScope = "admin.audit";
const uuidSchema = z.string().uuid();
const nonEmptyFilterSchema = z.string().trim().min(1).max(200);
const auditLogQuerySchema = z.object({
  actorId: uuidSchema.optional(),
  cursor: z.string().trim().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  objectId: uuidSchema.optional(),
  objectType: nonEmptyFilterSchema.optional(),
  outcome: z.enum(["success", "failure", "denied"]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
  until: z.string().datetime({ offset: true }).optional(),
  verb: nonEmptyFilterSchema.optional(),
});

/** How an audited action ended, read from its verb's last segment
 *  (`tool.invocation.denied`, `drive.upload.prepare_failed`). The store's SQL
 *  filter uses the same patterns. */
export type AuditOutcome = "success" | "failure" | "denied";

export const AUDIT_DENIED_VERB_PATTERN = "(^|[._])(denied|rejected|blocked)$";
export const AUDIT_FAILURE_VERB_PATTERN = "(^|[._])(failed|failure|error)$";

const deniedVerb = new RegExp(AUDIT_DENIED_VERB_PATTERN, "u");
const failureVerb = new RegExp(AUDIT_FAILURE_VERB_PATTERN, "u");

export function auditOutcome(verb: string): AuditOutcome {
  if (deniedVerb.test(verb)) return "denied";
  if (failureVerb.test(verb)) return "failure";
  return "success";
}

export interface AuditLogRecord {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string | null;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly traceId: string | null;
  readonly payload: JsonObject;
  readonly prevHash: string | null;
  readonly thisHash: string;
  readonly createdAt: string;
}

export interface AuditLogCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ListAuditLogInput {
  readonly orgId: string;
  readonly actorId?: string | undefined;
  readonly cursor?: AuditLogCursor | undefined;
  readonly limit: number;
  readonly objectId?: string | undefined;
  readonly objectType?: string | undefined;
  readonly outcome?: AuditOutcome | undefined;
  readonly since?: Date | undefined;
  readonly until?: Date | undefined;
  readonly verb?: string | undefined;
}

export interface AuditLogStore {
  listRecords(input: ListAuditLogInput): Promise<readonly AuditLogRecord[]>;
}

export interface RegisterAuditLogAdminRoutesOptions {
  readonly store: AuditLogStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

export async function registerAuditLogAdminRoutes(
  app: FastifyInstance,
  options: RegisterAuditLogAdminRoutesOptions,
): Promise<void> {
  app.get("/api/admin/audit-log", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAuditLog(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = auditLogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid audit log query.", issues: parsed.error.issues });
    }
    const cursor =
      parsed.data.cursor === undefined ? undefined : decodeAuditLogCursor(parsed.data.cursor);
    if (cursor === null) {
      return reply.code(400).send({ error: "Invalid audit log cursor." });
    }

    const limit = parsed.data.limit;
    const records = await options.store.listRecords({
      orgId: actor.orgId,
      limit: limit + 1,
      ...(parsed.data.actorId === undefined ? {} : { actorId: parsed.data.actorId }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(parsed.data.objectId === undefined ? {} : { objectId: parsed.data.objectId }),
      ...(parsed.data.objectType === undefined ? {} : { objectType: parsed.data.objectType }),
      ...(parsed.data.outcome === undefined ? {} : { outcome: parsed.data.outcome }),
      ...(parsed.data.since === undefined ? {} : { since: new Date(parsed.data.since) }),
      ...(parsed.data.until === undefined ? {} : { until: new Date(parsed.data.until) }),
      ...(parsed.data.verb === undefined ? {} : { verb: parsed.data.verb }),
    });
    const pageRecords = records.slice(0, limit);
    const lastRecord = pageRecords.at(-1);
    const nextCursor =
      records.length > limit && lastRecord !== undefined ? encodeAuditLogCursor(lastRecord) : null;

    return {
      records: pageRecords.map((record) => ({ ...record, outcome: auditOutcome(record.verb) })),
      nextCursor,
    };
  });
}

export function canReadAuditLog(actor: Actor): boolean {
  return actorHasScope(actor, adminAuditScope);
}

export function encodeAuditLogCursor(record: Pick<AuditLogRecord, "createdAt" | "id">): string {
  return Buffer.from(
    JSON.stringify({ createdAt: record.createdAt, id: record.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeAuditLogCursor(cursor: string): AuditLogCursor | null {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const parsed = z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        id: uuidSchema,
      })
      .safeParse(decoded);
    if (!parsed.success) {
      return null;
    }
    return {
      createdAt: new Date(parsed.data.createdAt),
      id: parsed.data.id,
    };
  } catch {
    return null;
  }
}

function permissionDeniedResponse(): {
  readonly error: string;
  readonly requiredScope: typeof adminAuditScope;
} {
  return {
    error: "Admin audit log permission denied.",
    requiredScope: adminAuditScope,
  };
}
