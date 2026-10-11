import { ForbiddenError, NotFoundError } from "../api/api-error.js";
import { requireActorScope } from "../api/scopes.js";
import { dlpDecisionError } from "../platform/dlp.js";
import { HELIX_API_VERSION_PREFIX } from "../api/version.js";
import {
  DriveS3MultipartCleanupWorker,
  PostgresDriveS3MultipartStore,
  registerDriveRoutes,
  registerDriveS3Gateway,
  registerDriveShareLinkRoute,
  safeDriveContentHeaders,
  sendStreamWithRangeSupport,
} from "../platform/drive/index.js";
import { loadEffectiveTenantConfig } from "../platform/tenancy/effective-config.js";
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
    sql,
    orgStore,
    auditStore,
    driveS3AccessKeyStore,
    driveStorage,
    driveStorageResolver,
    leaderGatedWorkers,
  } = context;
  if (coreApps.shouldRegister("drive")) {
    await registerDriveRoutes(app, {
      store: driveStore,
      appPasswords: appPasswordStore,
      requireTls: driveConfig.isProduction,
      bodyLimitBytes: driveConfig.antivirus.maxFileBytes,
      dlp,
    });
    // S3-compatible gateway at /v1/s3: SigV4 access keys, translated onto the
    // same Drive store operations (scan, DLP, quota, retention, audit).
    const s3Multipart = new PostgresDriveS3MultipartStore(sql);
    const resolveS3Storage = async (orgId: string) =>
      (await driveStorageResolver({ orgId }))?.client ?? driveStorage;
    leaderGatedWorkers.push({
      name: "drive-s3-multipart-cleanup-worker",
      worker: new DriveS3MultipartCleanupWorker({
        sql,
        multipart: s3Multipart,
        resolveStorage: resolveS3Storage,
        intervalMs: 15 * 60 * 1000,
        batchSize: 100,
        onError: (error) => {
          app.log.error({ error }, "Drive S3 multipart cleanup failed");
        },
      }),
    });
    await registerDriveS3Gateway(app, {
      store: driveStore,
      accessKeys: driveS3AccessKeyStore,
      multipart: s3Multipart,
      resolveStorage: resolveS3Storage,
      audit: auditStore,
      dlp,
      publicPrefix: HELIX_API_VERSION_PREFIX,
      requireTls: driveConfig.isProduction,
      limits: { maxObjectBytes: driveConfig.antivirus.maxFileBytes },
      isEnabled: async (request, orgId) => {
        const config =
          request.tenant?.orgId === orgId
            ? request.tenant.effectiveConfig
            : await loadEffectiveTenantConfig({ orgs: orgStore }, orgId);
        return config?.features.drive_s3_api !== false;
      },
      resolveOrgSlug: async (orgId) => (await orgStore.findById(orgId))?.slug,
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
