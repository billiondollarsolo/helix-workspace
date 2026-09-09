import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleWriteScope,
  auditAdminAction,
  canWriteAdminConsole,
  conflict,
  invalidRequest,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import type { RetryDeadLetteredVirusScanInput } from "./store.js";

export interface DriveScanAdminStore {
  retryDeadLetteredVirusScan(input: RetryDeadLetteredVirusScanInput): Promise<boolean>;
}

export interface RegisterDriveScanAdminRoutesOptions {
  readonly store: DriveScanAdminStore;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly auditSink: AdminConsoleAuditSink;
}

const paramsSchema = z.object({ objectId: z.string().uuid() });
const bodySchema = z.object({ reason: z.string().trim().min(10).max(1_000) }).strict();

/** Manual DLQ retry only: the operator cannot bypass the real scanner. */
export async function registerDriveScanAdminRoutes(
  app: FastifyInstance,
  options: RegisterDriveScanAdminRoutesOptions,
): Promise<void> {
  app.post("/api/admin/drive/scans/:objectId/retry", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWriteAdminConsole(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send(invalidRequest("A valid object id and override reason are required."));
    }
    const retried = await options.store.retryDeadLetteredVirusScan({
      orgId: actor.orgId,
      objectId: params.data.objectId,
      actorId: actor.id,
      reason: body.data.reason,
    });
    if (!retried) {
      return reply
        .code(409)
        .send(conflict("The Drive object is not in the antivirus dead-letter queue."));
    }
    await auditAdminAction(options.auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "admin.drive.scan_retry_overridden",
      objectType: "drive.object",
      objectId: params.data.objectId,
      metadata: { reason: body.data.reason },
    });
    return reply.code(202).send({ objectId: params.data.objectId, status: "scan_pending" });
  });
}
