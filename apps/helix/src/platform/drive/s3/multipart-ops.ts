import type { StorageClient } from "@helix/sdk-types";
import { XMLParser } from "fast-xml-parser";
import { randomUUID } from "node:crypto";
import { toUint8Array } from "../store/storage.js";
import type { DriveS3Context, DriveS3OperationResult } from "./context.js";
import { readDriveS3Payload } from "./context.js";
import { ensureDriveS3Folders, writeDriveS3Object } from "./drive-access.js";
import { deleteStagedParts } from "./multipart-cleanup.js";
import { S3Error } from "./errors.js";
import { multipartEtag, userMetadataFromHeaders } from "./object-metadata.js";
import { objectKeyOf } from "./object-ops.js";
import type { DriveS3MultipartUpload } from "./multipart-store.js";
import {
  completeMultipartUploadXml,
  initiateMultipartUploadXml,
  listMultipartUploadsXml,
  listPartsXml,
} from "./responses.js";
import { headerValue, sha256Hex } from "./sigv4.js";

/**
 * Multipart uploads. Parts are staged in the tenant's object store under a
 * private gateway prefix that Drive never serves. CompleteMultipartUpload
 * assembles the parts and writes the object through the normal Drive upload
 * pipeline, so the whole object is malware-scanned, DLP-checked, counted
 * against quota, versioned, and audited before anyone can download it.
 */
const MAX_PARTS = 10_000;

function stagingKey(orgId: string, uploadId: string, partNumber: number): string {
  return `drive-s3-staging/${orgId}/${uploadId}/${String(partNumber)}-${randomUUID()}`;
}

async function stagingStorage(context: DriveS3Context): Promise<StorageClient> {
  const storage = await context.resolveStorage(context.actor.orgId);
  if (storage === undefined) {
    throw new S3Error("NotImplemented", "Multipart uploads need configured object storage.");
  }
  return storage;
}

async function requireUpload(context: DriveS3Context): Promise<DriveS3MultipartUpload> {
  const upload = await context.multipart.find({
    orgId: context.actor.orgId,
    actorId: context.actor.id,
    uploadId: context.target.queryMap.get("uploadId") ?? "",
  });
  if (
    upload === null ||
    upload.bucket !== context.bucket.name ||
    upload.objectKey !== context.target.key
  ) {
    throw new S3Error(
      "NoSuchUpload",
      "The specified multipart upload does not exist, has expired, or belongs to another key.",
    );
  }
  return upload;
}

export async function createMultipartUpload(
  context: DriveS3Context,
): Promise<DriveS3OperationResult> {
  const key = objectKeyOf(context);
  if (key.directory) {
    throw new S3Error("InvalidArgument", "A key ending in '/' names a folder, not an object.");
  }
  await stagingStorage(context);
  const open = await context.multipart.countOpen({
    orgId: context.actor.orgId,
    actorId: context.actor.id,
  });
  if (open >= context.limits.maxOpenMultipartUploads) {
    throw new S3Error(
      "SlowDown",
      `You have ${String(open)} unfinished multipart uploads. Complete or abort some (aws s3api list-multipart-uploads / abort-multipart-upload) before starting another.`,
    );
  }
  // Create the folder path now so a read-only root or a file-in-the-way fails fast.
  await ensureDriveS3Folders(context, key.segments.slice(0, -1));
  const upload = await context.multipart.create({
    orgId: context.actor.orgId,
    actorId: context.actor.id,
    accessKeyId: context.authentication.authenticated.key.accessKeyId,
    bucket: context.bucket.name,
    objectKey: key.key,
    contentType: headerValue(context.headers, "content-type") ?? "application/octet-stream",
    userMetadata: userMetadataFromHeaders(context.headers),
    expiresAt: new Date(Date.now() + context.limits.multipartTtlMs),
  });
  await context.reply
    .code(200)
    .type("application/xml")
    .send(initiateMultipartUploadXml(context.bucket.name, key.key, upload.id));
  return { detail: { uploadId: upload.id } };
}

function partNumberOf(context: DriveS3Context): number {
  const value = Number(context.target.queryMap.get("partNumber"));
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PARTS) {
    throw new S3Error("InvalidArgument", "Part number must be an integer between 1 and 10000.");
  }
  return value;
}

export async function uploadPart(context: DriveS3Context): Promise<DriveS3OperationResult> {
  if (headerValue(context.headers, "x-amz-copy-source") !== undefined) {
    throw new S3Error("NotImplemented", "UploadPartCopy is not supported; upload the part bytes.");
  }
  const upload = await requireUpload(context);
  const partNumber = partNumberOf(context);
  const payload = await readDriveS3Payload(context);
  const assertWithinObjectLimit = async () => {
    const staged = await context.multipart.stagedBytes({
      orgId: context.actor.orgId,
      uploadId: upload.id,
      excludingPart: partNumber,
    });
    if (staged + payload.body.byteLength > context.limits.maxObjectBytes) {
      throw new S3Error(
        "EntityTooLarge",
        `This multipart upload would exceed the ${String(context.limits.maxObjectBytes)}-byte object limit.`,
      );
    }
  };
  await assertWithinObjectLimit();
  const storage = await stagingStorage(context);
  const key = stagingKey(context.actor.orgId, upload.id, partNumber);
  await storage.put({ key, body: payload.body, contentType: "application/octet-stream" });
  const replaced = await context.multipart.putPart({
    orgId: context.actor.orgId,
    uploadId: upload.id,
    partNumber,
    storageKey: key,
    byteSize: payload.body.byteLength,
    md5: payload.md5Hex,
  });
  if (replaced !== null) await deleteStagedParts(storage, [replaced]);
  // Re-check after recording: concurrent parts may have raced the first check.
  await assertWithinObjectLimit().catch(async (error: unknown) => {
    await deleteStagedParts(
      storage,
      await context.multipart.removePart({
        orgId: context.actor.orgId,
        uploadId: upload.id,
        partNumber,
      }),
    );
    throw error;
  });
  await context.reply.header("etag", `"${payload.md5Hex}"`).code(200).send();
  return { detail: { uploadId: upload.id, partNumber, byteSize: payload.body.byteLength } };
}

const completeParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  isArray: (name) => name === "Part",
});

function parseCompleteRequest(body: string): readonly {
  readonly partNumber: number;
  readonly etag: string;
}[] {
  if (/<!(?:DOCTYPE|ENTITY)/iu.test(body)) {
    throw new S3Error("MalformedXML", "Document type declarations are not allowed.");
  }
  let parsed: unknown;
  try {
    parsed = completeParser.parse(body);
  } catch {
    throw new S3Error("MalformedXML", "The XML you provided was not well-formed.");
  }
  const root = (parsed as { readonly CompleteMultipartUpload?: { readonly Part?: unknown } })
    .CompleteMultipartUpload;
  const parts = Array.isArray(root?.Part) ? (root.Part as unknown[]) : [];
  if (parts.length === 0) {
    throw new S3Error("MalformedXML", "CompleteMultipartUpload needs at least one <Part>.");
  }
  return parts.map((part) => {
    const record = part as { readonly PartNumber?: unknown; readonly ETag?: unknown };
    const partNumber = Number(record.PartNumber);
    if (!Number.isSafeInteger(partNumber) || typeof record.ETag !== "string") {
      throw new S3Error("MalformedXML", "Every <Part> needs a <PartNumber> and an <ETag>.");
    }
    return { partNumber, etag: record.ETag.trim().replaceAll('"', "").replaceAll("&quot;", "") };
  });
}

export async function completeMultipartUpload(
  context: DriveS3Context,
): Promise<DriveS3OperationResult> {
  const upload = await requireUpload(context);
  const payload = await readDriveS3Payload(context);
  const requested = parseCompleteRequest(payload.body.toString("utf8"));
  const stored = new Map(
    (await context.multipart.listParts({ orgId: context.actor.orgId, uploadId: upload.id })).map(
      (part) => [part.partNumber, part],
    ),
  );
  let previous = 0;
  let total = 0;
  const parts = requested.map((part, index) => {
    if (part.partNumber <= previous) {
      throw new S3Error("InvalidPartOrder", "Parts must be listed in ascending order.");
    }
    previous = part.partNumber;
    const staged = stored.get(part.partNumber);
    if (staged?.md5 !== part.etag) {
      throw new S3Error(
        "InvalidPart",
        `Part ${String(part.partNumber)} was not uploaded or its ETag does not match.`,
      );
    }
    if (index < requested.length - 1 && staged.byteSize < context.limits.minPartBytes) {
      throw new S3Error(
        "EntityTooSmall",
        `Every part but the last must be at least ${String(context.limits.minPartBytes)} bytes.`,
      );
    }
    total += staged.byteSize;
    return staged;
  });
  if (total > context.limits.maxObjectBytes) {
    throw new S3Error(
      "EntityTooLarge",
      `Objects written through the S3 API are limited to ${String(context.limits.maxObjectBytes)} bytes.`,
    );
  }
  const storage = await stagingStorage(context);
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const object = await storage.get(part.storageKey);
    if (object === null) {
      throw new S3Error("InvalidPart", `Part ${String(part.partNumber)} is no longer staged.`);
    }
    buffers.push(Buffer.from(await toUint8Array(object.body)));
  }
  const body = Buffer.concat(buffers);
  const etag = multipartEtag(parts.map((part) => part.md5));
  const key = objectKeyOf(context);
  const result = await writeDriveS3Object(context, key, {
    body,
    sha256: sha256Hex(body),
    etag,
    mimeType: upload.contentType,
    userMetadata: upload.userMetadata,
  });
  await deleteStagedParts(
    storage,
    await context.multipart.remove({ orgId: context.actor.orgId, uploadId: upload.id }),
  );
  await context.reply
    .code(200)
    .type("application/xml")
    .send(
      completeMultipartUploadXml({
        location: `/${context.bucket.name}/${key.key}`,
        bucket: context.bucket.name,
        key: key.key,
        etag: `"${etag}"`,
      }),
    );
  return { objectId: result.objectId, detail: { uploadId: upload.id, parts: parts.length } };
}

export async function abortMultipartUpload(
  context: DriveS3Context,
): Promise<DriveS3OperationResult> {
  const upload = await requireUpload(context);
  const storage = await stagingStorage(context);
  await deleteStagedParts(
    storage,
    await context.multipart.remove({ orgId: context.actor.orgId, uploadId: upload.id }),
  );
  await context.reply.code(204).send();
  return { detail: { uploadId: upload.id } };
}

export async function listParts(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const upload = await requireUpload(context);
  const marker = Number(context.target.queryMap.get("part-number-marker") ?? "0") || 0;
  const maxParts = Math.min(
    Math.max(Number(context.target.queryMap.get("max-parts") ?? "1000") || 1000, 1),
    1000,
  );
  const all = (
    await context.multipart.listParts({ orgId: context.actor.orgId, uploadId: upload.id })
  ).filter((part) => part.partNumber > marker);
  const page = all.slice(0, maxParts);
  await context.reply
    .code(200)
    .type("application/xml")
    .send(
      listPartsXml({
        bucket: context.bucket.name,
        key: upload.objectKey,
        uploadId: upload.id,
        ownerId: context.actor.id,
        partNumberMarker: marker,
        maxParts,
        isTruncated: all.length > page.length,
        parts: page.map((part) => ({
          partNumber: part.partNumber,
          etag: `"${part.md5}"`,
          size: part.byteSize,
          lastModified: part.createdAt,
        })),
      }),
    );
  return { detail: { uploadId: upload.id, parts: page.length } };
}

export async function listMultipartUploads(
  context: DriveS3Context,
): Promise<DriveS3OperationResult> {
  const prefix = context.target.queryMap.get("prefix") ?? "";
  const uploads = await context.multipart.listUploads({
    orgId: context.actor.orgId,
    actorId: context.actor.id,
    bucket: context.bucket.name,
    prefix,
  });
  await context.reply
    .code(200)
    .type("application/xml")
    .send(
      listMultipartUploadsXml({
        bucket: context.bucket.name,
        prefix,
        ownerId: context.actor.id,
        uploads: uploads.map((upload) => ({
          key: upload.objectKey,
          uploadId: upload.id,
          initiated: upload.createdAt,
        })),
      }),
    );
  return { detail: { uploads: uploads.length } };
}
