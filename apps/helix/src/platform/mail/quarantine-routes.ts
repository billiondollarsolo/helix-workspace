import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod3";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  canReadAdminConsole,
  canWriteAdminConsole,
  notFound,
  sendForbidden,
} from "../admin/console-shared.js";
import { serializeMailQuarantine } from "./quarantine.js";
import type { MailQuarantineService } from "./quarantine.js";

const paramsSchema = z.object({ id: z.string().uuid() });
const mutationSchema = z
  .object({
    confirmed: z.literal(true),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export async function registerMailQuarantineAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly service: MailQuarantineService;
    readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  },
): Promise<void> {
  app.get("/api/admin/mail/quarantine", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRead(actor)) return sendForbidden(reply, adminConsoleReadScope);
    return {
      quarantines: (await options.service.list(actor.orgId)).map(serializeMailQuarantine),
    };
  });

  app.post("/api/admin/mail/quarantine/:id/release", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWrite(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const params = paramsSchema.safeParse(request.params);
    const body = mutationSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Release requires explicit confirmation and reason." });
    }
    const record = await options.service.release({
      orgId: actor.orgId,
      actorId: actor.id,
      id: params.data.id,
      confirmed: true,
      reason: body.data.reason,
    });
    if (record === null) {
      return reply.code(409).send({
        error: "Quarantine not found, already handled, or release re-scan was not clean.",
      });
    }
    return { quarantine: serializeMailQuarantine(record) };
  });

  app.delete("/api/admin/mail/quarantine/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWrite(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const params = paramsSchema.safeParse(request.params);
    const body = mutationSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: "Delete requires explicit confirmation and reason." });
    }
    const record = await options.service.delete({
      orgId: actor.orgId,
      actorId: actor.id,
      id: params.data.id,
      confirmed: true,
      reason: body.data.reason,
    });
    if (record === null) return reply.code(404).send(notFound("Quarantine not found."));
    return { quarantine: serializeMailQuarantine(record) };
  });
}

function canRead(actor: Actor): boolean {
  return canReadAdminConsole(actor) || (actor.scopes ?? []).includes("mail.admin");
}

function canWrite(actor: Actor): boolean {
  return canWriteAdminConsole(actor) || (actor.scopes ?? []).includes("mail.admin");
}
