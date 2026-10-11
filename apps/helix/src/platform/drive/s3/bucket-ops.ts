import { DRIVE_S3_BUCKETS } from "./buckets.js";
import type { DriveS3Context, DriveS3OperationResult } from "./context.js";
import { S3Error } from "./errors.js";
import { listDriveS3Objects } from "./listing.js";
import {
  listBucketsXml,
  listObjectsV1Xml,
  listObjectsV2Xml,
  locationXml,
  versioningXml,
} from "./responses.js";

const MAX_KEYS = 1000;

function sendXml(context: DriveS3Context, body: string) {
  return context.reply.code(200).type("application/xml").send(body);
}

export async function listBuckets(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const createdAt = context.authentication.authenticated.key.createdAt;
  await sendXml(
    context,
    listBucketsXml({
      ownerId: context.actor.id,
      ownerName: context.actor.displayName ?? context.actor.email ?? context.actor.id,
      buckets: Object.keys(DRIVE_S3_BUCKETS).map((name) => ({ name, createdAt })),
    }),
  );
  return {};
}

export async function headBucket(context: DriveS3Context): Promise<DriveS3OperationResult> {
  await context.reply.code(200).header("x-amz-bucket-region", context.region).send();
  return {};
}

export async function createBucket(context: DriveS3Context): Promise<DriveS3OperationResult> {
  throw new S3Error(
    "BucketAlreadyOwnedByYou",
    `${context.bucket.name} already exists; Helix Drive buckets are fixed views of your Drive.`,
  );
}

export async function getBucketLocation(context: DriveS3Context): Promise<DriveS3OperationResult> {
  await sendXml(context, locationXml(context.region));
  return {};
}

export async function getBucketVersioning(
  context: DriveS3Context,
): Promise<DriveS3OperationResult> {
  // Drive keeps version history internally; S3 version IDs are not exposed.
  await sendXml(context, versioningXml());
  return {};
}

function maxKeysOf(context: DriveS3Context): number {
  const raw = context.target.queryMap.get("max-keys");
  if (raw === undefined) return MAX_KEYS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new S3Error("InvalidArgument", "max-keys must be a non-negative integer.");
  }
  return Math.min(value, MAX_KEYS);
}

function encodingOf(context: DriveS3Context): boolean {
  const value = context.target.queryMap.get("encoding-type");
  if (value === undefined) return false;
  if (value !== "url") throw new S3Error("InvalidArgument", "encoding-type must be url.");
  return true;
}

function delimiterOf(context: DriveS3Context): string | undefined {
  const value = context.target.queryMap.get("delimiter");
  return value === undefined || value.length === 0 ? undefined : value;
}

function decodeContinuationToken(token: string): string {
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  if (decoded.length === 0 || Buffer.from(decoded, "utf8").toString("base64url") !== token) {
    throw new S3Error("InvalidArgument", "The continuation token provided is incorrect.");
  }
  return decoded;
}

function laterOf(left: string | undefined, right: string | undefined): string | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) >= 0 ? left : right;
}

export async function listObjectsV2(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const query = context.target.queryMap;
  const prefix = query.get("prefix") ?? "";
  const delimiter = delimiterOf(context);
  const maxKeys = maxKeysOf(context);
  const continuationToken = query.get("continuation-token");
  const startAfter = query.get("start-after");
  const after = laterOf(
    continuationToken === undefined ? undefined : decodeContinuationToken(continuationToken),
    startAfter === undefined || startAfter.length === 0 ? undefined : startAfter,
  );
  const result = await listDriveS3Objects(context.store, context.actor, context.bucket, {
    prefix,
    ...(delimiter === undefined ? {} : { delimiter }),
    ...(after === undefined ? {} : { after }),
    maxKeys,
  });
  await sendXml(
    context,
    listObjectsV2Xml({
      bucket: context.target.bucket ?? context.bucket.name,
      prefix,
      delimiter,
      maxKeys,
      startAfter,
      continuationToken,
      nextContinuationToken:
        result.isTruncated && result.lastReturned !== undefined
          ? Buffer.from(result.lastReturned, "utf8").toString("base64url")
          : undefined,
      urlEncoding: encodingOf(context),
      result,
    }),
  );
  return { detail: { prefix, keyCount: result.contents.length + result.commonPrefixes.length } };
}

export async function listObjectsV1(context: DriveS3Context): Promise<DriveS3OperationResult> {
  const query = context.target.queryMap;
  const prefix = query.get("prefix") ?? "";
  const delimiter = delimiterOf(context);
  const maxKeys = maxKeysOf(context);
  const marker = query.get("marker") ?? "";
  const result = await listDriveS3Objects(context.store, context.actor, context.bucket, {
    prefix,
    ...(delimiter === undefined ? {} : { delimiter }),
    ...(marker.length === 0 ? {} : { after: marker }),
    maxKeys,
  });
  await sendXml(
    context,
    listObjectsV1Xml({
      bucket: context.target.bucket ?? context.bucket.name,
      prefix,
      delimiter,
      marker,
      maxKeys,
      urlEncoding: encodingOf(context),
      result,
    }),
  );
  return { detail: { prefix, keyCount: result.contents.length + result.commonPrefixes.length } };
}
