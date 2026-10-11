import type { DriveS3KeyScope } from "./access-keys.js";
import {
  createBucket,
  getBucketLocation,
  getBucketVersioning,
  headBucket,
  listBuckets,
  listObjectsV1,
  listObjectsV2,
} from "./bucket-ops.js";
import type { DriveS3Context, DriveS3OperationResult } from "./context.js";
import { S3Error } from "./errors.js";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  listMultipartUploads,
  listParts,
  uploadPart,
} from "./multipart-ops.js";
import { copyObject, deleteObject, deleteObjects, getObject, putObject } from "./object-ops.js";
import type { DriveS3Target } from "./request.js";

export interface DriveS3Operation {
  /** S3 API operation name, e.g. `PutObject`. */
  readonly name: string;
  /** Audit verb suffix: `drive.s3.<verb>`. */
  readonly verb: string;
  readonly scope: DriveS3KeyScope;
  run(context: DriveS3Context, orgSlug: string | undefined): Promise<DriveS3OperationResult>;
}

function operation(
  name: string,
  verb: string,
  scope: DriveS3KeyScope,
  run: DriveS3Operation["run"],
): DriveS3Operation {
  return { name, verb, scope, run };
}

/** Query parameters the gateway understands; anything else is an unsupported subresource. */
const UNDERSTOOD_PARAMETERS = new Set([
  "continuation-token",
  "delete",
  "delimiter",
  "encoding-type",
  "fetch-owner",
  "key-marker",
  "list-type",
  "location",
  "marker",
  "max-keys",
  "max-parts",
  "max-uploads",
  "part-number-marker",
  "partNumber",
  "prefix",
  "start-after",
  "upload-id-marker",
  "uploadId",
  "uploads",
  "versionId",
  "versioning",
  "x-id",
]);

function assertUnderstoodQuery(target: DriveS3Target): void {
  for (const [name, value] of target.queryMap) {
    // Presigned URLs carry SigV4 fields and hoisted x-amz-* headers in the query.
    if (name.toLowerCase().startsWith("x-amz-") || name.startsWith("response-")) continue;
    if (name === "versionId" && value !== "null") {
      throw new S3Error(
        "NotImplemented",
        "Object version IDs are not exposed; Drive keeps version history in the web app.",
      );
    }
    if (!UNDERSTOOD_PARAMETERS.has(name)) {
      throw new S3Error(
        "NotImplemented",
        `The "${name}" subresource is not implemented by the Helix Drive S3 API.`,
      );
    }
  }
}

const LIST_BUCKETS = operation("ListBuckets", "list_buckets", "drive.read", listBuckets);

/** Maps an HTTP request onto the S3 operation it names. */
export function classifyDriveS3Operation(
  method: string,
  target: DriveS3Target,
  headers: Readonly<Record<string, unknown>>,
): DriveS3Operation {
  assertUnderstoodQuery(target);
  const has = (name: string) => target.queryMap.has(name);
  if (target.bucket === undefined) {
    if (method === "GET") return LIST_BUCKETS;
    throw new S3Error("MethodNotAllowed", "Only ListBuckets is allowed on the service endpoint.");
  }
  if (target.key.length === 0) {
    switch (method) {
      case "HEAD":
        return operation("HeadBucket", "head_bucket", "drive.read", headBucket);
      case "GET":
        if (has("location")) {
          return operation(
            "GetBucketLocation",
            "get_bucket_location",
            "drive.read",
            getBucketLocation,
          );
        }
        if (has("versioning")) {
          return operation(
            "GetBucketVersioning",
            "get_bucket_versioning",
            "drive.read",
            getBucketVersioning,
          );
        }
        if (has("uploads")) {
          return operation(
            "ListMultipartUploads",
            "list_multipart_uploads",
            "drive.read",
            listMultipartUploads,
          );
        }
        return target.queryMap.get("list-type") === "2"
          ? operation("ListObjectsV2", "list_objects", "drive.read", listObjectsV2)
          : operation("ListObjects", "list_objects", "drive.read", listObjectsV1);
      case "PUT":
        if (target.queryMap.size > 0 && !has("x-id")) break;
        return operation("CreateBucket", "create_bucket", "drive.write", createBucket);
      case "POST":
        if (has("delete")) {
          return operation("DeleteObjects", "delete_objects", "drive.delete", deleteObjects);
        }
        break;
      default:
        break;
    }
    throw new S3Error(
      "NotImplemented",
      `${method} on a bucket is not implemented; Helix Drive buckets are fixed views of your Drive.`,
    );
  }
  switch (method) {
    case "GET":
      if (has("uploadId")) return operation("ListParts", "list_parts", "drive.read", listParts);
      return operation("GetObject", "get_object", "drive.read", getObject);
    case "HEAD":
      return operation("HeadObject", "head_object", "drive.read", getObject);
    case "PUT":
      if (has("uploadId") || has("partNumber")) {
        return operation("UploadPart", "upload_part", "drive.write", uploadPart);
      }
      if (headers["x-amz-copy-source"] !== undefined) {
        return operation("CopyObject", "copy_object", "drive.write", copyObject);
      }
      return operation("PutObject", "put_object", "drive.write", putObject);
    case "POST":
      if (has("uploads")) {
        return operation(
          "CreateMultipartUpload",
          "create_multipart_upload",
          "drive.write",
          createMultipartUpload,
        );
      }
      if (has("uploadId")) {
        return operation(
          "CompleteMultipartUpload",
          "complete_multipart_upload",
          "drive.write",
          completeMultipartUpload,
        );
      }
      break;
    case "DELETE":
      if (has("uploadId")) {
        return operation(
          "AbortMultipartUpload",
          "abort_multipart_upload",
          "drive.write",
          abortMultipartUpload,
        );
      }
      return operation("DeleteObject", "delete_object", "drive.delete", deleteObject);
    default:
      break;
  }
  throw new S3Error("NotImplemented", `${method} on an object is not implemented.`);
}
