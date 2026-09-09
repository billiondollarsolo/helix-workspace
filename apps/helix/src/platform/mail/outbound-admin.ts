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
import type { MailJournalStore, OutboundMailQueueStore } from "./store.js";
import type { MailDeliveryEventStore } from "./delivery-events.js";

const idParams = z.object({ id: z.string().uuid() });
const replayBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const journalSettingsBody = z
  .object({ enabled: z.boolean(), retentionDays: z.number().int().min(1).max(36_500) })
  .strict();
const permission = "mail.admin";

export function registerOutboundMailAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly store: Pick<OutboundMailQueueStore, "listDeadLetteredOutbound" | "replayOutbound"> &
      MailJournalStore;
    readonly deliveryStore: Pick<
      MailDeliveryEventStore,
      "listEvents" | "listSuppressions" | "removeSuppression"
    >;
    readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
    readonly auditSink: AdminConsoleAuditSink;
  },
): void {
  app.get("/api/admin/mail/journal", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission, resource(actor))) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { journal: serializeJournal(await options.store.getJournalSettings(actor.orgId)) };
  });

  app.put("/api/admin/mail/journal", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, permission, resource(actor))) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = journalSettingsBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid mail journal settings."));
    }
    const journal = await options.store.setJournalSettings({
      orgId: actor.orgId,
      actorId: actor.id,
      ...body.data,
    });
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.journal.updated",
      objectType: "mail_journal_settings",
      objectId: actor.orgId,
      metadata: { enabled: journal.enabled, retentionDays: journal.retentionDays },
    });
    return { journal: serializeJournal(journal) };
  });

  app.get("/api/admin/mail/outbound/dead-letters", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission, resource(actor))) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return {
      messages: (await options.store.listDeadLetteredOutbound(actor.orgId)).map((message) => ({
        id: message.id,
        actorId: message.actorId,
        messageId: message.messageId,
        attemptCount: message.attemptCount ?? 0,
        lastError: message.lastError,
        deadLetteredAt: message.deadLetteredAt?.toISOString() ?? null,
      })),
    };
  });

  app.post("/api/admin/mail/outbound/:id/replay", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, permission, resource(actor))) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    const body = replayBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(invalidRequest("A valid outbound id and reason are required."));
    }
    const replayed = await options.store.replayOutbound({ orgId: actor.orgId, id: params.data.id });
    if (replayed === null) return reply.code(404).send(notFound("Dead-lettered mail not found."));
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.outbound.replayed",
      objectType: "mail_outbound_message",
      objectId: replayed.id,
      metadata: { reason: body.data.reason },
    });
    return { status: "queued", id: replayed.id };
  });

  app.get("/api/admin/mail/outbound/delivery-events", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission, resource(actor))) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return {
      events: (await options.deliveryStore.listEvents(actor.orgId)).map((event) => ({
        ...event,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  });

  app.get("/api/admin/mail/outbound/suppressions", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission, resource(actor))) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return {
      suppressions: (await options.deliveryStore.listSuppressions(actor.orgId)).map(
        (suppression) => ({ ...suppression, createdAt: suppression.createdAt.toISOString() }),
      ),
    };
  });

  app.delete("/api/admin/mail/outbound/suppressions/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor, permission, resource(actor))) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    const body = replayBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(invalidRequest("A valid suppression id and reason are required."));
    }
    if (
      !(await options.deliveryStore.removeSuppression({
        orgId: actor.orgId,
        id: params.data.id,
        actorId: actor.id,
        reason: body.data.reason,
      }))
    ) {
      return reply.code(404).send(notFound("Active suppression not found."));
    }
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.suppression.removed",
      objectType: "mail_suppression",
      objectId: params.data.id,
      metadata: { reason: body.data.reason },
    });
    return { status: "removed" };
  });
}

function serializeJournal(journal: Awaited<ReturnType<MailJournalStore["getJournalSettings"]>>) {
  return {
    ...journal,
    lastJournaledAt: journal.lastJournaledAt?.toISOString() ?? null,
    updatedAt: journal.updatedAt?.toISOString() ?? null,
  };
}

function resource(actor: Actor) {
  return { type: "product" as const, id: "mail", orgId: actor.orgId };
}
