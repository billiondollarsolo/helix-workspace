import type postgres from "postgres";
import { env } from "../../config/env.js";
import { createNoopVirusScanner, isNoopVirusScanner } from "./scanning.js";
import * as collaboration from "./store/collaboration.js";
import * as comments from "./store/comments.js";
import type { DriveStoreContext } from "./store/context.js";
import type {
  DriveStorageClient,
  DriveStore,
  PostgresDriveStoreOptions,
} from "./store/contracts.js";
import * as entries from "./store/entries.js";
import * as folders from "./store/folders.js";
import * as lifecycle from "./store/lifecycle.js";
import * as multipart from "./store/multipart.js";
import * as projections from "./store/projections.js";
import * as quotas from "./store/quotas.js";
import * as scanJobs from "./store/scan-jobs.js";
import * as shareLinks from "./store/share-links.js";
import * as shares from "./store/shares.js";
import * as storage from "./store/storage.js";
import * as uploads from "./store/uploads.js";
import * as versions from "./store/versions.js";
import * as webdav from "./store/webdav.js";
import type { DriveEnrichmentProjectionStore, DriveSearchProjectionStore } from "./types.js";
export { DriveStorageQuotaExceededError } from "./errors.js";
export type * from "./store/contracts.js";
export { commitStorageUsage } from "./store/quotas.js";

/** Stable public adapter; each aggregate owns its SQL and authorization flow. */
export class PostgresDriveStore
  implements DriveStore, DriveSearchProjectionStore, DriveEnrichmentProjectionStore
{
  private readonly context: DriveStoreContext;
  constructor(
    sql: postgres.Sql,
    storage?: DriveStorageClient,
    options: PostgresDriveStoreOptions = {},
  ) {
    const virusScanner = options.virusScanner ?? createNoopVirusScanner();
    const scannerRequired = options.requireVirusScanner ?? env().NODE_ENV === "production";
    if (scannerRequired && isNoopVirusScanner(virusScanner))
      throw new Error("Drive antivirus scanner is required in production and secure tiers.");
    this.context = {
      sql,
      storage,
      options,
      virusScanner,
      virusScanOrgCursor: undefined,
      nextBlobReconciliation: new Map(),
    };
  }
  getStorageQuotaUsage(input: Parameters<typeof quotas.getStorageQuotaUsage>[1]) {
    return quotas.getStorageQuotaUsage(this.context, input);
  }
  getLifecyclePolicy(input: Parameters<typeof quotas.getLifecyclePolicy>[1]) {
    return quotas.getLifecyclePolicy(this.context, input);
  }
  setLifecyclePolicy(input: Parameters<typeof quotas.setLifecyclePolicy>[1]) {
    return quotas.setLifecyclePolicy(this.context, input);
  }
  getUploadStatus(input: Parameters<typeof uploads.getUploadStatus>[1]) {
    return uploads.getUploadStatus(this.context, input);
  }
  acquireWebDavLock(input: Parameters<typeof webdav.acquireWebDavLock>[1]) {
    return webdav.acquireWebDavLock(this.context, input);
  }
  listWebDavLocks(input: Parameters<typeof webdav.listWebDavLocks>[1]) {
    return webdav.listWebDavLocks(this.context, input);
  }
  releaseWebDavLock(input: Parameters<typeof webdav.releaseWebDavLock>[1]) {
    return webdav.releaseWebDavLock(this.context, input);
  }
  listWebDavChanges(input: Parameters<typeof webdav.listWebDavChanges>[1]) {
    return webdav.listWebDavChanges(this.context, input);
  }
  prepareUpload(input: Parameters<typeof uploads.prepareUpload>[1]) {
    return uploads.prepareUpload(this.context, input);
  }
  completeMultipartUpload(input: Parameters<typeof multipart.completeMultipartUpload>[1]) {
    return multipart.completeMultipartUpload(this.context, input);
  }
  finalizeUpload(input: Parameters<typeof uploads.finalizeUpload>[1]) {
    return uploads.finalizeUpload(this.context, input);
  }
  runVirusScanRetryBatch(input: Parameters<typeof scanJobs.runVirusScanRetryBatch>[1]) {
    return scanJobs.runVirusScanRetryBatch(this.context, input);
  }
  retryDeadLetteredVirusScan(input: Parameters<typeof scanJobs.retryDeadLetteredVirusScan>[1]) {
    return scanJobs.retryDeadLetteredVirusScan(this.context, input);
  }
  list(input: Parameters<typeof entries.list>[1]) {
    return entries.list(this.context, input);
  }
  createFolder(input: Parameters<typeof folders.createFolder>[1]) {
    return folders.createFolder(this.context, input);
  }
  trashFolder(input: Parameters<typeof folders.trashFolder>[1]) {
    return folders.trashFolder(this.context, input);
  }
  restoreFolder(input: Parameters<typeof folders.restoreFolder>[1]) {
    return folders.restoreFolder(this.context, input);
  }
  deleteFolder(input: Parameters<typeof folders.deleteFolder>[1]) {
    return folders.deleteFolder(this.context, input);
  }
  readFile(input: Parameters<typeof storage.readFile>[1]) {
    return storage.readFile(this.context, input);
  }
  canExportFile(input: Parameters<typeof storage.canExportFile>[1]) {
    return storage.canExportFile(this.context, input);
  }
  openFile(input: Parameters<typeof storage.openFile>[1]) {
    return storage.openFile(this.context, input);
  }
  share(input: Parameters<typeof shares.share>[1]) {
    return shares.share(this.context, input);
  }
  setHiddenShare(input: Parameters<typeof collaboration.setHiddenShare>[1]) {
    return collaboration.setHiddenShare(this.context, input);
  }
  requestAccess(input: Parameters<typeof collaboration.requestAccess>[1]) {
    return collaboration.requestAccess(this.context, input);
  }
  decideAccessRequest(input: Parameters<typeof collaboration.decideAccessRequest>[1]) {
    return collaboration.decideAccessRequest(this.context, input);
  }
  listAccessRequests(input: Parameters<typeof collaboration.listAccessRequests>[1]) {
    return collaboration.listAccessRequests(this.context, input);
  }
  copyObject(input: Parameters<typeof collaboration.copyObject>[1]) {
    return collaboration.copyObject(this.context, input);
  }
  listAccess(input: Parameters<typeof shares.listAccess>[1]) {
    return shares.listAccess(this.context, input);
  }
  removeAccess(input: Parameters<typeof shares.removeAccess>[1]) {
    return shares.removeAccess(this.context, input);
  }
  updateAccess(input: Parameters<typeof shares.updateAccess>[1]) {
    return shares.updateAccess(this.context, input);
  }
  move(input: Parameters<typeof entries.move>[1]) {
    return entries.move(this.context, input);
  }
  moveFolder(input: Parameters<typeof folders.moveFolder>[1]) {
    return folders.moveFolder(this.context, input);
  }
  setStarred(input: Parameters<typeof entries.setStarred>[1]) {
    return entries.setStarred(this.context, input);
  }
  getDocumentSurfaceView(input: Parameters<typeof entries.getDocumentSurfaceView>[1]) {
    return entries.getDocumentSurfaceView(this.context, input);
  }
  setDocumentSurfaceView(input: Parameters<typeof entries.setDocumentSurfaceView>[1]) {
    return entries.setDocumentSurfaceView(this.context, input);
  }
  rename(input: Parameters<typeof entries.rename>[1]) {
    return entries.rename(this.context, input);
  }
  listVersions(input: Parameters<typeof versions.listVersions>[1]) {
    return versions.listVersions(this.context, input);
  }
  revertToVersion(input: Parameters<typeof versions.revertToVersion>[1]) {
    return versions.revertToVersion(this.context, input);
  }
  createShareLink(input: Parameters<typeof shareLinks.createShareLink>[1]) {
    return shareLinks.createShareLink(this.context, input);
  }
  listShareLinks(input: Parameters<typeof shareLinks.listShareLinks>[1]) {
    return shareLinks.listShareLinks(this.context, input);
  }
  revokeShareLink(input: Parameters<typeof shareLinks.revokeShareLink>[1]) {
    return shareLinks.revokeShareLink(this.context, input);
  }
  resolveShareLink(input: Parameters<typeof shareLinks.resolveShareLink>[1]) {
    return shareLinks.resolveShareLink(this.context, input);
  }
  openFileByShareToken(input: Parameters<typeof shareLinks.openFileByShareToken>[1]) {
    return shareLinks.openFileByShareToken(this.context, input);
  }
  trash(input: Parameters<typeof lifecycle.trash>[1]) {
    return lifecycle.trash(this.context, input);
  }
  restore(input: Parameters<typeof lifecycle.restore>[1]) {
    return lifecycle.restore(this.context, input);
  }
  delete(input: Parameters<typeof lifecycle.deleteEntry>[1]) {
    return lifecycle.deleteEntry(this.context, input);
  }
  search(input: Parameters<typeof entries.search>[1]) {
    return entries.search(this.context, input);
  }
  createComment(input: Parameters<typeof comments.createComment>[1]) {
    return comments.createComment(this.context, input);
  }
  listComments(input: Parameters<typeof comments.listComments>[1]) {
    return comments.listComments(this.context, input);
  }
  listCommentRevisions(input: Parameters<typeof comments.listCommentRevisions>[1]) {
    return comments.listCommentRevisions(this.context, input);
  }
  resolveComment(input: Parameters<typeof comments.resolveComment>[1]) {
    return comments.resolveComment(this.context, input);
  }
  reopenComment(input: Parameters<typeof comments.reopenComment>[1]) {
    return comments.reopenComment(this.context, input);
  }
  updateComment(input: Parameters<typeof comments.updateComment>[1]) {
    return comments.updateComment(this.context, input);
  }
  deleteComment(input: Parameters<typeof comments.deleteComment>[1]) {
    return comments.deleteComment(this.context, input);
  }
  getDriveSearchRecord(
    fileId: Parameters<typeof projections.getDriveSearchRecord>[1],
    includeContent = false,
  ) {
    return projections.getDriveSearchRecord(this.context, fileId, includeContent);
  }
  getDriveEnrichmentRecord(fileId: Parameters<typeof projections.getDriveEnrichmentRecord>[1]) {
    return projections.getDriveEnrichmentRecord(this.context, fileId);
  }
  recordDriveEnrichment(input: Parameters<typeof projections.recordDriveEnrichment>[1]) {
    return projections.recordDriveEnrichment(this.context, input);
  }
  setDriveAutoTags(input: Parameters<typeof projections.setDriveAutoTags>[1]) {
    return projections.setDriveAutoTags(this.context, input);
  }
}
