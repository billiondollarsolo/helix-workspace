import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  conflict,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import { MailMalwareRejectedError } from "./errors.js";
import {
  ingestRawMail,
  resolvedMailRecipients,
  type InboundMailScanners,
  type MailAuthenticator,
  type MailInboundRecipientResolution,
} from "./ingest.js";
import type { MailQuarantineStore, MailQuarantineSummary } from "./quarantine.js";
import type { MailStore } from "./store.js";

const idParams = z.object({ id: z.string().uuid() });
const resolutionBody = z
  .object({ reason: z.string().trim().min(1).max(500), confirmed: z.literal(true) })
  .strict();

export function registerMailQuarantineAdminRoutes(
  app: FastifyInstance,
  options: {
    readonly store: MailQuarantineStore;
    readonly mailStore: MailStore;
    readonly scanners: InboundMailScanners;
    readonly resolveRecipient: (address: string) => Promise<MailInboundRecipientResolution>;
    readonly authenticator?: MailAuthenticator | undefined;
    readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
    readonly auditSink: AdminConsoleAuditSink;
  },
): void {
  app.get("/api/admin/mail/quarantine", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRead(actor)) return sendForbidden(reply, adminConsoleReadScope);
    return {
      quarantines: (await options.store.listPending(actor.orgId)).map(serializeSummary),
    };
  });

  app.post("/api/admin/mail/quarantine/:id/release", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWrite(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const params = idParams.safeParse(request.params);
    const body = resolutionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(invalidRequest("A valid quarantine id and reason are required."));
    }
    const quarantined = await options.store.claimRelease(actor.orgId, params.data.id);
    if (quarantined === null) {
      return reply.code(404).send(notFound("Quarantined mail not found."));
    }
    let recipients;
    try {
      recipients = await Promise.all(quarantined.recipientAddresses.map(options.resolveRecipient));
    } catch (error) {
      await options.store.abortRelease(actor.orgId, quarantined.id, quarantined.releaseToken);
      throw error;
    }
    const resolvedRecipients = recipients.flatMap(resolvedMailRecipients);
    if (
      resolvedRecipients.length === 0 ||
      recipients.some((recipient) => resolvedMailRecipients(recipient).length === 0) ||
      resolvedRecipients.some((recipient) => recipient.orgId !== actor.orgId)
    ) {
      await options.store.abortRelease(actor.orgId, quarantined.id, quarantined.releaseToken);
      return reply.code(409).send(conflict("A quarantine recipient is no longer deliverable."));
    }
    let delivered;
    try {
      delivered = await ingestRawMail({
        store: options.mailStore,
        input: {
          orgId: actor.orgId,
          recipients: resolvedRecipients,
          raw: quarantined.raw,
          ...(quarantined.envelopeFrom === undefined
            ? {}
            : { envelopeFrom: quarantined.envelopeFrom }),
          ...(quarantined.remoteAddress === undefined
            ? {}
            : { remoteAddress: quarantined.remoteAddress }),
          ...(quarantined.helo === undefined ? {} : { helo: quarantined.helo }),
          ...(quarantined.providerDeliveryId === undefined
            ? {}
            : { providerDeliveryId: quarantined.providerDeliveryId }),
        },
        scanners: { ...options.scanners, failurePolicy: "defer" },
        malwareDisposition: "reject",
        authenticationPolicy: false,
        ...(options.authenticator === undefined ? {} : { authenticator: options.authenticator }),
      });
    } catch (error) {
      await options.store.abortRelease(actor.orgId, quarantined.id, quarantined.releaseToken);
      if (error instanceof MailMalwareRejectedError) {
        return reply.code(409).send(conflict("Mail still violates malware policy."));
      }
      if (responseCode(error) === 451) {
        return reply.code(503).send({ error: "Mail policy recheck is unavailable." });
      }
      throw error;
    }
    const resolution = await options.store.release({
      orgId: actor.orgId,
      id: quarantined.id,
      actorId: actor.id,
      messageId: delivered.stored.messageId,
      reason: body.data.reason,
      releaseToken: quarantined.releaseToken,
    });
    if (!resolution.resolved) {
      return reply.code(409).send(conflict("Quarantined mail was already resolved."));
    }
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.quarantine.released",
      objectType: "mail_quarantine",
      objectId: quarantined.id,
      metadata: {
        reason: body.data.reason,
        signature: quarantined.signature,
        messageId: delivered.stored.messageId,
        bytesDeleted: resolution.bytesDeleted,
      },
    });
    return {
      status: "released",
      threadId: delivered.stored.threadId,
      messageId: delivered.stored.messageId,
      bytesDeleted: resolution.bytesDeleted,
    };
  });

  app.delete("/api/admin/mail/quarantine/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWrite(actor)) return sendForbidden(reply, adminConsoleWriteScope);
    const params = idParams.safeParse(request.params);
    const body = resolutionBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(invalidRequest("A valid quarantine id and reason are required."));
    }
    const result = await options.store.delete({
      orgId: actor.orgId,
      id: params.data.id,
      actorId: actor.id,
      reason: body.data.reason,
    });
    if (!result.found) return reply.code(404).send(notFound("Quarantined mail not found."));
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "mail.quarantine.deleted",
      objectType: "mail_quarantine",
      objectId: params.data.id,
      metadata: { reason: body.data.reason, bytesDeleted: result.bytesDeleted },
    });
    return { status: "deleted", bytesDeleted: result.bytesDeleted };
  });
}

function canRead(actor: Actor): boolean {
  return canReadAdminConsole(actor, "mail.admin", {
    type: "product",
    id: "mail",
    orgId: actor.orgId,
  });
}

function canWrite(actor: Actor): boolean {
  return canWriteAdminConsole(actor, "mail.admin", {
    type: "product",
    id: "mail",
    orgId: actor.orgId,
  });
}

function serializeSummary(summary: MailQuarantineSummary) {
  return {
    ...summary,
    createdAt: summary.createdAt.toISOString(),
    resolvedAt: summary.resolvedAt?.toISOString() ?? null,
  };
}

function responseCode(error: unknown): number | undefined {
  return error instanceof Error && "responseCode" in error
    ? (error as Error & { readonly responseCode?: number }).responseCode
    : undefined;
}
