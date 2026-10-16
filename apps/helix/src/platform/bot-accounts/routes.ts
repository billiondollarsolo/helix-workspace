import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ForbiddenError } from "../../api/api-error.js";
import type { DlpGuard } from "../dlp.js";
import { dlpDecisionError } from "../dlp.js";
import { actorHasPermission } from "../permissions/roles.js";
import { safeDriveContentHeaders } from "../drive/content-security.js";
import { sendStreamWithRangeSupport } from "../drive/range-response.js";
import { auditAdminAction, type AdminConsoleAuditSink } from "../admin/console-shared.js";
import type { BotWorkspaceReader } from "./workspace.js";
export function registerBotWorkspaceRoutes(
  app: FastifyInstance,
  options: {
    reader: BotWorkspaceReader;
    actorFromRequest: (request: FastifyRequest) => Promise<Actor>;
    audit: AdminConsoleAuditSink;
    dlp: DlpGuard;
  },
) {
  app.get("/api/bots/:botId/files/:objectId", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!actorHasPermission(actor, "platform.read", { type: "org", orgId: actor.orgId }))
      throw new ForbiddenError("Workspace read access is required.");
    const params = z
      .object({ botId: z.string().uuid(), objectId: z.string().uuid() })
      .parse(request.params);
    const file = await options.reader.openFile(actor, params.botId, params.objectId);
    const decision = await options.dlp.evaluate({
      orgId: actor.orgId,
      actorId: actor.id,
      boundary: "drive_download",
      resources: [{ resourceType: "drive.file", resourceId: params.objectId }],
      traceId: request.id,
    });
    if (decision.action === "block" || decision.action === "quarantine")
      throw dlpDecisionError(decision);
    if (decision.action === "warn") reply.header("x-helix-dlp-warning", decision.classification);
    await auditAdminAction(options.audit, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "bot.file.downloaded",
      objectType: "drive.file",
      objectId: params.objectId,
      metadata: { botActorId: params.botId },
    });
    reply.header("cache-control", "private, no-store");
    return sendStreamWithRangeSupport({
      reply,
      request,
      byteSize: file.byteSize,
      etag: file.etag,
      open: file.open,
      lastModified: file.entry.updatedAt,
      ...safeDriveContentHeaders(
        file.entry.name,
        file.entry.mimeType ?? "application/octet-stream",
        false,
      ),
    });
  });
}
