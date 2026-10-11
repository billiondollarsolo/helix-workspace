import { XMLParser } from "fast-xml-parser";
import { safeDriveContentHeaders } from "../content-security.js";
import { sendStreamWithRangeSupport } from "../range-response.js";
import { toUint8Array } from "../store/storage.js";
import { restrictDriveS3Actor } from "./access-keys.js";
import { parseDriveS3Key, resolveDriveS3Bucket, type DriveS3ObjectKey } from "./buckets.js";
import type { DriveS3Context, DriveS3OperationResult } from "./context.js";
import { readDriveS3Payload } from "./context.js";
import {
  assertDriveS3Download,
  deleteDriveS3Object,
  requireReadableDriveFile,
  writeDriveS3Object,
  type DriveS3Access,
} from "./drive-access.js";
import { S3Error, toS3Error } from "./errors.js";
import {
  driveS3Etag,
  driveS3UserMetadata,
  EMPTY_MD5_ETAG,
  userMetadataFromHeaders,
} from "./object-metadata.js";
import { copyObjectResultXml, deleteResultXml } from "./responses.js";
import { headerValue, sha256Hex } from "./sigv4.js";

const MAX_DELETE_KEYS = 1000;

export function objectKeyOf(context: DriveS3Context): DriveS3ObjectKey {
  return parseDriveS3Key(context.target.key);
}

function contentTypeOf(context: DriveS3Context): string {
  const value = headerValue(context.headers, "content-type")?.trim();
  return value === undefined || value.length === 0 ? "application/octet-stream" : value;
}

function sendXml(context: DriveS3Context, status: number, body: string) {
  return context.reply.code(status).type("application/xml").send(body);
}

/** GetObject and HeadObject, with Range and conditional requests. */
export async function getObject(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const key = objectKeyOf(context);
  const entry = await requireReadableDriveFile(context, key);
  const { reply } = context;
  if (entry.type === "folder") {
    reply
      .header("etag", EMPTY_MD5_ETAG)
      .header("last-modified", entry.updatedAt.toUTCString())
      .header("content-length", "0")
      .type("application/x-directory");
    await reply.code(200).send(context.request.method === "HEAD" ? undefined : "");
    return { objectId: null, detail: { directory: true } };
  }
  await assertDriveS3Download(context, entry, (classification) => {
    reply.header("x-helix-dlp-warning", classification);
  });
  const file = await context.store.openFile({
    orgId: context.actor.orgId,
    actorId: context.actor.id,
    objectId: entry.id,
  });
  if (file === null) throw new S3Error("NoSuchKey", "The specified key does not exist.");
  for (const [name, value] of Object.entries(driveS3UserMetadata(file.entry))) {
    reply.header(`x-amz-meta-${name}`, value);
  }
  const headers = safeDriveContentHeaders(
    file.entry.name,
    file.entry.mimeType ?? "application/octet-stream",
    true,
  );
  await sendStreamWithRangeSupport({
    reply,
    request: context.request,
    byteSize: file.byteSize,
    etag: driveS3Etag(file.entry),
    open: file.open,
    ...headers,
    lastModified: file.entry.updatedAt,
  });
  return { objectId: entry.id, detail: { byteSize: file.byteSize } };
}

export async function putObject(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const key = objectKeyOf(context);
  const payload = await readDriveS3Payload(context);
  const result = await writeDriveS3Object(context, key, {
    body: payload.body,
    sha256: payload.sha256Hex,
    etag: payload.md5Hex,
    mimeType: contentTypeOf(context),
    userMetadata: userMetadataFromHeaders(context.headers),
  });
  await context.reply.header("etag", `"${result.etag}"`).code(200).send();
  return {
    objectId: result.objectId,
    detail: { byteSize: payload.body.byteLength, created: result.created },
  };
}

function parseCopySource(value: string): { readonly bucket: string; readonly key: string } {
  const withoutVersion = value.split("?")[0] ?? value;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutVersion).replace(/^\//u, "");
  } catch {
    throw new S3Error("InvalidArgument", "x-amz-copy-source is not valid URL encoding.");
  }
  const separator = decoded.indexOf("/");
  if (separator <= 0 || separator === decoded.length - 1) {
    throw new S3Error("InvalidArgument", "x-amz-copy-source must be <bucket>/<key>.");
  }
  return { bucket: decoded.slice(0, separator), key: decoded.slice(separator + 1) };
}

/** CopyObject within the actor's Drive access; the copy is re-scanned like any upload. */
export async function copyObject(
  context: DriveS3Context,
  orgSlug: string | undefined,
): Promise<DriveS3OperationResult> {
  if (restrictDriveS3Actor(context.authentication.authenticated, "drive.read") === null) {
    throw new S3Error(
      "AccessDenied",
      'CopyObject reads the source object, so the access key also needs the "drive.read" scope.',
    );
  }
  const key = objectKeyOf(context);
  const source = parseCopySource(headerValue(context.headers, "x-amz-copy-source") ?? "");
  const sourceAccess: DriveS3Access = {
    ...context,
    bucket: resolveDriveS3Bucket(source.bucket, orgSlug),
  };
  const sourceKey = parseDriveS3Key(source.key);
  const entry = await requireReadableDriveFile(sourceAccess, sourceKey);
  if (entry.type === "folder") {
    throw new S3Error("InvalidRequest", "The copy source is a folder, not an object.");
  }
  if ((entry.byteSize ?? 0) > context.limits.maxObjectBytes) {
    throw new S3Error(
      "EntityTooLarge",
      `Copies through the S3 API are limited to ${String(context.limits.maxObjectBytes)} bytes; download and re-upload larger files with multipart.`,
    );
  }
  await assertDriveS3Download(sourceAccess, entry, () => undefined);
  const etag = driveS3Etag(entry);
  const ifMatch = headerValue(context.headers, "x-amz-copy-source-if-match");
  const ifNoneMatch = headerValue(context.headers, "x-amz-copy-source-if-none-match");
  if (
    (ifMatch !== undefined && ifMatch !== etag && ifMatch !== "*") ||
    (ifNoneMatch !== undefined && (ifNoneMatch === etag || ifNoneMatch === "*"))
  ) {
    throw new S3Error("PreconditionFailed", "At least one of the copy preconditions failed.");
  }
  const file = await context.store.openFile({
    orgId: context.actor.orgId,
    actorId: context.actor.id,
    objectId: entry.id,
  });
  const opened = file === null ? null : await file.open();
  if (opened === null) throw new S3Error("NoSuchKey", "The copy source does not exist.");
  const body = Buffer.from(await toUint8Array(opened));
  const replace =
    headerValue(context.headers, "x-amz-metadata-directive")?.toUpperCase() === "REPLACE";
  const result = await writeDriveS3Object(context, key, {
    body,
    sha256: sha256Hex(body),
    etag: etag.slice(1, -1),
    mimeType: replace ? contentTypeOf(context) : (entry.mimeType ?? "application/octet-stream"),
    userMetadata: replace ? userMetadataFromHeaders(context.headers) : driveS3UserMetadata(entry),
  });
  await sendXml(context, 200, copyObjectResultXml(`"${result.etag}"`, new Date()));
  return {
    objectId: result.objectId,
    detail: { sourceBucket: sourceAccess.bucket.name, sourceKey: source.key, sourceId: entry.id },
  };
}

export async function deleteObject(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const objectId = await deleteDriveS3Object(context, objectKeyOf(context));
  await context.reply.code(204).send();
  return { objectId, detail: { trashed: objectId !== null } };
}

const deleteParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === "Object",
});

/** DeleteObjects: each key is trashed independently and reported per key. */
export async function deleteObjects(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const payload = await readDriveS3Payload(context);
  if (
    headerValue(context.headers, "content-md5") === undefined &&
    !Object.keys(context.headers).some((name) => name.startsWith("x-amz-checksum-"))
  ) {
    throw new S3Error(
      "InvalidRequest",
      "Missing required header for this request: Content-MD5 or x-amz-checksum-*.",
    );
  }
  const keys = parseDeleteRequest(payload.body.toString("utf8"));
  const deleted: string[] = [];
  const errors: { key: string; code: string; message: string }[] = [];
  const trashedIds: string[] = [];
  for (const entry of keys.objects) {
    try {
      const id = await deleteDriveS3Object(context, parseDriveS3Key(entry));
      if (id !== null) trashedIds.push(id);
      deleted.push(entry);
    } catch (error) {
      const mapped = toS3Error(error);
      errors.push({ key: entry, code: mapped.code, message: mapped.message });
    }
  }
  await sendXml(context, 200, deleteResultXml({ quiet: keys.quiet, deleted, errors }));
  return {
    detail: { requested: keys.objects.length, deleted: deleted.length, trashedIds },
  };
}

function parseDeleteRequest(body: string): {
  readonly quiet: boolean;
  readonly objects: readonly string[];
} {
  if (/<!(?:DOCTYPE|ENTITY)/iu.test(body)) {
    throw new S3Error("MalformedXML", "Document type declarations are not allowed.");
  }
  let parsed: unknown;
  try {
    parsed = deleteParser.parse(body);
  } catch {
    throw new S3Error("MalformedXML", "The XML you provided was not well-formed.");
  }
  const root = (parsed as { readonly Delete?: unknown }).Delete;
  if (typeof root !== "object" || root === null) {
    throw new S3Error("MalformedXML", "The request body must be a <Delete> document.");
  }
  const record = root as { readonly Quiet?: unknown; readonly Object?: unknown };
  const objects = Array.isArray(record.Object) ? record.Object : [];
  const keys = objects.map((object: unknown) => {
    const keyValue = (object as { readonly Key?: unknown } | null)?.Key;
    if (typeof keyValue !== "string" || keyValue.length === 0) {
      throw new S3Error("MalformedXML", "Every <Object> needs a <Key>.");
    }
    return keyValue;
  });
  if (keys.length === 0 || keys.length > MAX_DELETE_KEYS) {
    throw new S3Error("MalformedXML", "DeleteObjects takes between 1 and 1000 keys.");
  }
  return { quiet: String(record.Quiet).trim().toLowerCase() === "true", objects: keys };
}
