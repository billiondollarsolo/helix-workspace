import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type { PersonLimitValues, PostgresPersonLimitStore } from "./person-limits.js";

/**
 * Admin → Limits: what one person, agent or service account may store and
 * send, where it differs from the organization's default. The defaults
 * themselves are organization settings (`/api/admin/tenant-config`, quotas).
 */

export interface PersonLimitRoutesOptions {
  readonly store: Pick<PostgresPersonLimitStore, "get" | "listOverrides" | "setOverrides">;
  readonly defaultsFor: (orgId: string) => Promise<PersonLimitValues>;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly auditSink: AdminConsoleAuditSink;
}

const permission = "admin.users";
const idParams = z.object({ actorId: z.string().uuid() });
// `null` hands that limit back to the organization's default.
const limit = (max: number) => z.number().int().min(0).max(max).nullable();
const overridesBody = z
  .object({
    storageBytes: limit(Number.MAX_SAFE_INTEGER),
    mailSendPerHour: limit(1_000_000),
    mailSendPerDay: limit(1_000_000),
  })
  .strict();

export function registerPersonLimitRoutes(
  app: FastifyInstance,
  options: PersonLimitRoutesOptions,
): void {
  const { store, actorFromRequest, auditSink } = options;

  app.get("/api/admin/person-limits", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return {
      defaults: await options.defaultsFor(actor.orgId),
      people: await store.listOverrides(actor.orgId),
    };
  });

  app.get("/api/admin/person-limits/:actorId", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const params = idParams.safeParse(request.params);
    const person = params.success
      ? await store.get({ orgId: actor.orgId, actorId: params.data.actorId })
      : null;
    if (person === null) return reply.code(404).send(notFound("That person no longer exists."));
    return { person };
  });

  app.put("/api/admin/person-limits/:actorId", async (request, reply) => {
    const actor = await actorFromRequest(request);
    // Only a signed-in person changes limits, so no agent can raise its own.
    if (actor.type !== "user" || !canWriteAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound("That person no longer exists."));
    const body = overridesBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(
          invalidRequest("A limit is a whole number of zero or more, or empty for the default."),
        );
    }
    const person = await store.setOverrides({
      orgId: actor.orgId,
      actorId: params.data.actorId,
      updatedByActorId: actor.id,
      overrides: body.data,
    });
    if (person === null) return reply.code(404).send(notFound("That person no longer exists."));
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "person_limits.updated",
      objectType: "actor",
      objectId: person.actorId,
      metadata: { ...person.overrides },
    });
    return { person };
  });
}
