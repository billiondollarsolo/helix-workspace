import type { StorageObject } from "@helix/sdk-types";
import type { TenantPresignedPutUpload } from "../../storage/index.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { bytesFromDatabase } from "../core/mappers.js";
import { isDriveObjectReady, requireObjectAccess } from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import {
  type DriveFileReadInput,
  type DriveFileReadResult,
  type DriveFileStreamResult,
  type DriveStorageClient,
} from "./contracts.js";
import { mapObjectEntry } from "./mappers.js";
import { type ObjectRow } from "./rows.js";
export async function toUint8Array(
  body: AsyncIterable<Uint8Array> | Uint8Array,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function readStoredUpload(
  storage: DriveStorageClient | undefined,
  key: string,
): Promise<StorageObject | null | undefined> {
  if (storage === undefined) return undefined;
  return storage.getStream === undefined ? storage.get(key) : storage.getStream(key);
}

export function driveContentEtag(
  sha256: string | null,
  objectId: string,
  versionNumber: number | null,
): string {
  return sha256 === null
    ? `"drive-${objectId}-${String(versionNumber ?? 0)}"`
    : `"sha256-${sha256}"`;
}

function sliceStorageBody(
  body: StorageObject["body"],
  range: {
    readonly start: number;
    readonly end: number;
  },
): StorageObject["body"] {
  if (body instanceof Uint8Array) return body.subarray(range.start, range.end + 1);
  return (async function* () {
    let offset = 0;
    for await (const chunk of body) {
      const chunkEnd = offset + chunk.byteLength;
      if (chunkEnd > range.start && offset <= range.end) {
        const start = Math.max(0, range.start - offset);
        const end = Math.min(chunk.byteLength, range.end - offset + 1);
        if (end > start) yield chunk.subarray(start, end);
      }
      offset = chunkEnd;
      if (offset > range.end) return;
    }
  })();
}

export async function readFile(
  context: DriveStoreContext,
  input: DriveFileReadInput,
): Promise<DriveFileReadResult | null> {
  const opened = await openFile(context, input);
  if (opened === null) return null;
  const content = await opened
    .open()
    .then(async (body) => (body === null ? null : toUint8Array(body)));
  return {
    entry: opened.entry,
    content,
  };
}

export async function canExportFile(
  context: DriveStoreContext,
  input: DriveFileReadInput,
): Promise<boolean> {
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const rows = await tx<
        {
          readonly export_allowed: boolean;
        }[]
      >`
          select coalesce((
            select export_allowed from meet_recording_governance
            where org_id = ${input.orgId} and object_id = ${input.objectId}
          ), true) as export_allowed
        `;
      return rows[0]?.export_allowed === true;
    },
  );
}

export async function openFile(
  context: DriveStoreContext,
  input: DriveFileReadInput,
): Promise<DriveFileStreamResult | null> {
  const startedAt = Date.now();
  try {
    const object = await withTenantPostgresContext(
      context.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const accessible = await requireObjectAccess(
          tx,
          input.orgId,
          input.actorId,
          input.objectId,
        );
        if (accessible.deleted_at !== null || !isDriveObjectReady(accessible)) return null;
        const versions = await tx<
          {
            readonly version_number: number;
          }[]
        >`
          select version_number
          from drive_versions
          where org_id = ${input.orgId} and object_id = ${input.objectId}
          order by version_number desc
          limit 1
        `;
        return { ...accessible, version_number: versions[0]?.version_number ?? null };
      },
    );
    const opened = object === null ? null : await openStoredObject(context, input.orgId, object);
    context.options.metrics?.recordOperationalEvent({
      capability: "drive",
      operation: "download",
      status: opened === null ? "blocked" : "success",
      durationSeconds: (Date.now() - startedAt) / 1000,
    });
    if (opened !== null) {
      context.options.metrics?.addOperationalUnits({
        capability: "drive",
        measure: "downloaded_bytes",
        value: opened.byteSize,
      });
    }
    return opened;
  } catch (error) {
    context.options.metrics?.recordOperationalEvent({
      capability: "drive",
      operation: "download",
      status: "error",
      durationSeconds: (Date.now() - startedAt) / 1000,
    });
    throw error;
  }
}

export async function storageForOrg(
  context: DriveStoreContext,
  orgId: string,
): Promise<DriveStorageClient | undefined> {
  if (context.options.storageResolver === undefined) return context.storage;
  return (await context.options.storageResolver({ orgId }))?.client;
}

export async function openStoredObject(
  context: DriveStoreContext,
  orgId: string,
  object: ObjectRow & {
    readonly version_number: number | null;
  },
): Promise<DriveFileStreamResult> {
  const storage = await storageForOrg(context, orgId);
  const entry = mapObjectEntry(object);
  const readStorage =
    (key: string) => async (range?: { readonly start: number; readonly end: number }) => {
      if (storage === undefined) return null;
      if (range !== undefined && storage.getRange !== undefined) {
        return (await storage.getRange(key, range.start, range.end))?.body ?? null;
      }
      const stored =
        storage.getStream === undefined ? await storage.get(key) : await storage.getStream(key);
      if (stored === null) return null;
      return range === undefined ? stored.body : sliceStorageBody(stored.body, range);
    };
  return {
    orgId,
    entry,
    byteSize: bytesFromDatabase(object.byte_size),
    etag: driveContentEtag(object.sha256, object.id, object.version_number),
    open: readStorage(object.storage_key),
  };
}

export async function presignPutRequest(
  context: DriveStoreContext,
  storage: DriveStorageClient | undefined,
  storageKey: string,
  mimeType: string,
): Promise<TenantPresignedPutUpload | null> {
  const options = {
    contentType: mimeType,
    expiresSeconds: 900,
  };
  if (storage?.presignPutRequest !== undefined) {
    return storage.presignPutRequest(storageKey, options);
  }
  if (storage?.presignPutUrl === undefined) {
    return null;
  }
  return {
    url: await storage.presignPutUrl(storageKey, options),
    headers: { "content-type": mimeType },
  };
}
