import type { Actor } from "@helix/sdk-types";
import type { DlpGuard } from "../../dlp.js";
import { findDriveChild, resolveDrivePath } from "../path-resolution.js";
import type { DriveStore } from "../store.js";
import type { DriveEntryRecord } from "../types.js";
import type { DriveS3Bucket, DriveS3ObjectKey } from "./buckets.js";
import { S3Error, toS3Error } from "./errors.js";
import type { LockFolderChildren } from "./folder-transaction.js";
import { driveS3UploadMetadata } from "./object-metadata.js";

/**
 * The Drive operations behind S3 object reads and writes. Every call goes
 * through the Drive store as the authenticated actor, so folder and object
 * ACLs, upload staging, malware scanning, DLP, quotas, versions, retention,
 * and Drive's activity trail apply exactly as they do for REST and WebDAV.
 */
export type DriveS3Store = Pick<
  DriveStore,
  "list" | "createFolder" | "prepareUpload" | "finalizeUpload" | "trash" | "delete"
> &
  Required<Pick<DriveStore, "openFile" | "trashFolder">> & {
    canExportFile?(input: {
      readonly orgId: string;
      readonly actorId: string;
      readonly objectId: string;
    }): Promise<boolean>;
  };

export interface DriveS3Access {
  readonly store: DriveS3Store;
  readonly actor: Actor;
  readonly bucket: DriveS3Bucket;
  readonly dlp?: DlpGuard | undefined;
  readonly traceId: string;
  /**
   * Runs folder writes in their own committed tenant transaction. Uploads are
   * staged and finalized in separate I/O-saga transactions that cannot see
   * uncommitted rows of the request transaction, so a folder created for a
   * key's prefix must be committed before the object is written into it. The
   * work locks each parent's children before looking them up (see
   * folder-transaction.ts), so concurrent uploads reuse one new folder.
   */
  readonly inOwnTransaction?:
    (<T>(work: (lockFolderChildren: LockFolderChildren) => Promise<T>) => Promise<T>) | undefined;
}

function rootView(access: DriveS3Access, folderId: string | null) {
  return folderId === null ? access.bucket.view : undefined;
}

/** Resolves a key to its Drive entry, or null when nothing visible is there. */
async function findDriveS3Entry(
  access: DriveS3Access,
  key: DriveS3ObjectKey,
): Promise<DriveEntryRecord | null> {
  const resolved = await resolveDrivePath(
    access.store,
    access.actor,
    key.segments,
    access.bucket.view,
  );
  if (resolved?.entry === undefined) return null;
  if (key.directory !== (resolved.entry.type === "folder")) return null;
  return resolved.entry;
}

/** A downloadable file for GET/HEAD/Copy, with actionable scan-state errors. */
export async function requireReadableDriveFile(
  access: DriveS3Access,
  key: DriveS3ObjectKey,
): Promise<DriveEntryRecord> {
  const entry = await findDriveS3Entry(access, key);
  if (entry === null) throw new S3Error("NoSuchKey", "The specified key does not exist.");
  if (entry.type === "folder") return entry;
  if (entry.available === false) {
    const state = entry.uploadState ?? "";
    if (/infected|quarantine/u.test(state)) {
      throw new S3Error(
        "ObjectQuarantined",
        "This file failed the malware scan and is quarantined. An admin can review it in the Drive scan queue.",
      );
    }
    throw new S3Error(
      "ObjectScanPending",
      `This file is not downloadable yet (${entry.uploadStatusLabel ?? state}). Retry after the malware scan completes.`,
    );
  }
  return entry;
}

/** Applies the same download gates as the REST content route: DLP and export policy. */
export async function assertDriveS3Download(
  access: DriveS3Access,
  entry: DriveEntryRecord,
  warn: (classification: string) => void,
): Promise<void> {
  const { actor } = access;
  if (access.dlp !== undefined) {
    const decision = await access.dlp.evaluate({
      orgId: actor.orgId,
      actorId: actor.id,
      boundary: "drive_download",
      resources: [{ resourceType: "drive.file", resourceId: entry.id }],
      traceId: access.traceId,
    });
    if (decision.action === "block" || decision.action === "quarantine") {
      throw new S3Error(
        "AccessDenied",
        "Your organization's data-loss policy blocks downloading this file.",
      );
    }
    if (decision.action === "warn") warn(decision.classification);
  }
  if (
    access.store.canExportFile !== undefined &&
    !(await access.store.canExportFile({
      orgId: actor.orgId,
      actorId: actor.id,
      objectId: entry.id,
    }))
  ) {
    throw new S3Error("AccessDenied", "Export is disabled for this recording.");
  }
}

/** mkdir -p for the folder segments of a key; returns the innermost folder id. */
export async function ensureDriveS3Folders(
  access: DriveS3Access,
  segments: readonly string[],
): Promise<string | null> {
  if (segments.length === 0) return null;
  return access.inOwnTransaction === undefined
    ? ensureFolderPath(access, segments)
    : access.inOwnTransaction((lockFolderChildren) =>
        ensureFolderPath(access, segments, lockFolderChildren),
      );
}

async function ensureFolderPath(
  access: DriveS3Access,
  segments: readonly string[],
  lockFolderChildren?: LockFolderChildren,
): Promise<string | null> {
  let folderId: string | null = null;
  for (const segment of segments) {
    await lockFolderChildren?.(folderId);
    const existing = await findDriveChild(
      access.store,
      access.actor,
      folderId,
      segment,
      rootView(access, folderId),
    );
    if (existing?.type === "folder") {
      folderId = existing.id;
      continue;
    }
    if (existing !== null) {
      throw new S3Error(
        "InvalidObjectName",
        `A file named "${segment}" exists where this key needs a folder.`,
      );
    }
    assertRootWritable(access, folderId);
    const created = await access.store.createFolder({
      orgId: access.actor.orgId,
      actorId: access.actor.id,
      name: segment,
      parentFolderId: folderId,
      metadata: { source: "s3" },
    });
    folderId = created.id;
  }
  return folderId;
}

function assertRootWritable(access: DriveS3Access, folderId: string | null): void {
  if (folderId === null && !access.bucket.rootWritable) {
    throw new S3Error(
      "AccessDenied",
      `The root of ${access.bucket.name} is read-only. Write inside a folder that was shared with you with edit access, or use my-drive.`,
    );
  }
}

export interface DriveS3WriteInput {
  readonly body: Buffer;
  readonly sha256: string;
  /** Unquoted S3 ETag to record for this content. */
  readonly etag: string;
  readonly mimeType: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}

export interface DriveS3WriteResult {
  readonly objectId: string | null;
  readonly etag: string;
  readonly created: boolean;
}

/**
 * Creates or replaces the file at `key` through Drive's upload pipeline.
 * Replacing an existing file adds a Drive version; a directory-marker key
 * (`folder/`) creates the folder path.
 */
export async function writeDriveS3Object(
  access: DriveS3Access,
  key: DriveS3ObjectKey,
  input: DriveS3WriteInput,
): Promise<DriveS3WriteResult> {
  if (key.directory) {
    if (input.body.byteLength > 0) {
      throw new S3Error("InvalidArgument", "A key ending in '/' names a folder and must be empty.");
    }
    await ensureDriveS3Folders(access, key.segments);
    return { objectId: null, etag: input.etag, created: true };
  }
  const folderId = await ensureDriveS3Folders(access, key.segments.slice(0, -1));
  const name = key.segments.at(-1) ?? "";
  const existing = await findDriveChild(
    access.store,
    access.actor,
    folderId,
    name,
    rootView(access, folderId),
  );
  if (existing?.type === "folder") {
    throw new S3Error(
      "InvalidObjectName",
      `A Drive folder named "${name}" already exists at this key; delete it or choose another key.`,
    );
  }
  if (existing === null) assertRootWritable(access, folderId);
  const { actor } = access;
  const metadata = driveS3UploadMetadata({
    sha256: input.sha256,
    etag: input.etag,
    userMetadata: input.userMetadata,
  });
  const objectId =
    existing?.id ??
    (
      await access.store.prepareUpload({
        orgId: actor.orgId,
        actorId: actor.id,
        name,
        folderId,
        mimeType: input.mimeType,
        byteSize: input.body.byteLength,
        sha256: input.sha256,
        metadata,
      })
    ).objectId;
  try {
    await access.store.finalizeUpload({
      orgId: actor.orgId,
      actorId: actor.id,
      objectId,
      byteSize: input.body.byteLength,
      sha256: input.sha256,
      mimeType: input.mimeType,
      content: input.body,
      metadata,
    });
  } catch (error) {
    const mapped = toS3Error(error);
    if (mapped.code !== "ObjectScanPending") throw mapped;
    // Nothing was committed: either the scanner is down (inline bytes are never
    // stored without a verdict) or an earlier version still awaits its scan.
    // Drop the object this request prepared (trash, then purge) so the key is
    // free for the retry, and ask the client to retry.
    if (existing === null) {
      const target = { orgId: actor.orgId, actorId: actor.id, objectId };
      await access.store.trash(target).catch(() => undefined);
      await access.store.delete(target).catch(() => undefined);
    }
    throw new S3Error(
      "ServiceUnavailable",
      "Drive cannot malware-scan this upload right now (the scanner is unavailable or an earlier version of this file is still waiting for its scan), so nothing was stored. Retry the request later.",
      { retryAfterSeconds: retryAfterOf(error) },
    );
  }
  return { objectId, etag: input.etag, created: existing === null };
}

function retryAfterOf(error: unknown): number {
  const value =
    typeof error === "object" && error !== null && "retryAfterSeconds" in error
      ? Number((error as { readonly retryAfterSeconds: unknown }).retryAfterSeconds)
      : Number.NaN;
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 30;
}

/** Deletes one key with Drive trash semantics; missing keys succeed like S3. */
export async function deleteDriveS3Object(
  access: DriveS3Access,
  key: DriveS3ObjectKey,
): Promise<string | null> {
  const entry = await findDriveS3Entry(access, key);
  if (entry === null) return null;
  const { actor } = access;
  if (entry.type === "folder") {
    // Deleting a directory marker never removes the folder's contents.
    const page = await access.store.list({
      orgId: actor.orgId,
      actorId: actor.id,
      folderId: entry.id,
      limit: 1,
    });
    if (page.entries.length > 0) return null;
    await access.store.trashFolder({ orgId: actor.orgId, actorId: actor.id, folderId: entry.id });
    return entry.id;
  }
  const trashed = await access.store.trash({
    orgId: actor.orgId,
    actorId: actor.id,
    objectId: entry.id,
  });
  return trashed?.id ?? null;
}
