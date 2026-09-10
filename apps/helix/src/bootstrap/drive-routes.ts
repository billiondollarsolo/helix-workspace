import { ForbiddenError, NotFoundError } from "../api/api-error.js";
import { requireActorScope } from "../api/scopes.js";
import { dlpDecisionError } from "../platform/dlp.js";
import {
  registerDriveRoutes,
  registerDriveShareLinkRoute,
  safeDriveContentHeaders,
  sendStreamWithRangeSupport,
} from "../platform/drive/index.js";
import type { installTools } from "./tools.js";

export async function installDriveRoutes(context: Awaited<ReturnType<typeof installTools>>) {
  const {
    app,
    coreApps,
    driveStore,
    appPasswordStore,
    driveConfig,
    dlp,
    actorFromAuthenticatedRequest,
  } = context;
  if (coreApps.shouldRegister("drive")) {
    await registerDriveRoutes(app, {
      store: driveStore,
      appPasswords: appPasswordStore,
      requireTls: driveConfig.isProduction,
      bodyLimitBytes: driveConfig.antivirus.maxFileBytes,
      dlp,
    });
    await registerDriveShareLinkRoute(app, {
      store: driveStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      dlp,
    });
    // Session-cookie-authenticated content stream for the Web UI. The /dav/*
    // routes registered above require app-password Basic Auth (the WebDAV
    // contract). The browser-driven "Open file" action in the Drive UI
    // needs a path it can hit with the existing helix_session cookie and
    // have the bytes streamed back. This route fills that gap.
    app.get<{
      Params: {
        objectId: string;
      };
    }>("/api/drive/objects/:objectId/content", async (request, reply) => {
      const actor = await actorFromAuthenticatedRequest(request);
      // G6: defense-in-depth scope gate on top of per-object ACL.
      requireActorScope(actor, "drive.read");
      const file = await driveStore.openFile({
        orgId: actor.orgId,
        actorId: actor.id,
        objectId: request.params.objectId,
      });
      if (file === null) {
        throw new NotFoundError("File not found.");
      }
      const dlpDecision = await dlp.evaluate({
        orgId: actor.orgId,
        actorId: actor.id,
        boundary: "drive_download",
        resources: [{ resourceType: "drive.file", resourceId: request.params.objectId }],
        traceId: request.id,
      });
      if (dlpDecision.action === "block" || dlpDecision.action === "quarantine") {
        throw dlpDecisionError(dlpDecision);
      }
      if (dlpDecision.action === "warn") {
        reply.header("x-helix-dlp-warning", dlpDecision.classification);
      }
      if (
        !(await driveStore.canExportFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: request.params.objectId,
        }))
      ) {
        throw new ForbiddenError("Export is disabled for this recording.");
      }
      const responseHeaders = safeDriveContentHeaders(
        file.entry.name,
        file.entry.mimeType ?? "application/octet-stream",
        false,
      );
      return sendStreamWithRangeSupport({
        reply,
        request,
        byteSize: file.byteSize,
        etag: file.etag,
        open: file.open,
        ...responseHeaders,
        lastModified: file.entry.updatedAt,
      });
    });
  }
}
