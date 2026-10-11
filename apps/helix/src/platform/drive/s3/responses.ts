import { xmlDocument, xmlEscape } from "./errors.js";
import type { DriveS3ListResult } from "./listing.js";
import { driveS3Etag } from "./object-metadata.js";
import { s3UriEncode } from "./sigv4.js";

const S3_NAMESPACE = "http://s3.amazonaws.com/doc/2006-03-01/";

function element(name: string, value: string | number | boolean | undefined): string {
  return value === undefined ? "" : `<${name}>${xmlEscape(String(value))}</${name}>`;
}

function iso(date: Date): string {
  return date.toISOString();
}

export function listBucketsXml(input: {
  readonly ownerId: string;
  readonly ownerName: string;
  readonly buckets: readonly { readonly name: string; readonly createdAt: Date }[];
}): string {
  const buckets = input.buckets
    .map(
      (bucket) =>
        `<Bucket>${element("Name", bucket.name)}${element("CreationDate", iso(bucket.createdAt))}</Bucket>`,
    )
    .join("");
  return xmlDocument(
    `<ListAllMyBucketsResult xmlns="${S3_NAMESPACE}"><Owner>${element("ID", input.ownerId)}${element("DisplayName", input.ownerName)}</Owner>` +
      `<Buckets>${buckets}</Buckets></ListAllMyBucketsResult>`,
  );
}

export function locationXml(region: string): string {
  return xmlDocument(
    `<LocationConstraint xmlns="${S3_NAMESPACE}">${region === "us-east-1" ? "" : xmlEscape(region)}</LocationConstraint>`,
  );
}

export function versioningXml(): string {
  return xmlDocument(`<VersioningConfiguration xmlns="${S3_NAMESPACE}"/>`);
}

function listEncoder(urlEncoding: boolean): (value: string) => string {
  return urlEncoding ? (value) => s3UriEncode(value, false) : (value) => value;
}

function listEntriesXml(result: DriveS3ListResult, encode: (value: string) => string): string {
  const contents = result.contents
    .map(
      ({ key, entry }) =>
        `<Contents>${element("Key", encode(key))}${element("LastModified", iso(entry.updatedAt))}` +
        `${element("ETag", driveS3Etag(entry))}${element("Size", entry.byteSize ?? 0)}` +
        `<StorageClass>STANDARD</StorageClass></Contents>`,
    )
    .join("");
  const prefixes = result.commonPrefixes
    .map((prefix) => `<CommonPrefixes>${element("Prefix", encode(prefix))}</CommonPrefixes>`)
    .join("");
  return contents + prefixes;
}

export function listObjectsV2Xml(input: {
  readonly bucket: string;
  readonly prefix: string;
  readonly delimiter?: string | undefined;
  readonly maxKeys: number;
  readonly startAfter?: string | undefined;
  readonly continuationToken?: string | undefined;
  readonly nextContinuationToken?: string | undefined;
  readonly urlEncoding: boolean;
  readonly result: DriveS3ListResult;
}): string {
  const encode = listEncoder(input.urlEncoding);
  return xmlDocument(
    `<ListBucketResult xmlns="${S3_NAMESPACE}">${element("Name", input.bucket)}` +
      element("Prefix", encode(input.prefix)) +
      element("KeyCount", input.result.contents.length + input.result.commonPrefixes.length) +
      element("MaxKeys", input.maxKeys) +
      (input.delimiter === undefined ? "" : element("Delimiter", encode(input.delimiter))) +
      element("IsTruncated", input.result.isTruncated) +
      (input.continuationToken === undefined
        ? ""
        : element("ContinuationToken", input.continuationToken)) +
      (input.nextContinuationToken === undefined
        ? ""
        : element("NextContinuationToken", input.nextContinuationToken)) +
      (input.startAfter === undefined ? "" : element("StartAfter", encode(input.startAfter))) +
      (input.urlEncoding ? "<EncodingType>url</EncodingType>" : "") +
      `${listEntriesXml(input.result, encode)}</ListBucketResult>`,
  );
}

export function listObjectsV1Xml(input: {
  readonly bucket: string;
  readonly prefix: string;
  readonly delimiter?: string | undefined;
  readonly marker: string;
  readonly maxKeys: number;
  readonly urlEncoding: boolean;
  readonly result: DriveS3ListResult;
}): string {
  const encode = listEncoder(input.urlEncoding);
  const nextMarker =
    input.result.isTruncated && input.delimiter !== undefined
      ? input.result.lastReturned
      : undefined;
  return xmlDocument(
    `<ListBucketResult xmlns="${S3_NAMESPACE}">${element("Name", input.bucket)}` +
      `${element("Prefix", encode(input.prefix))}${element("Marker", encode(input.marker))}` +
      (nextMarker === undefined ? "" : element("NextMarker", encode(nextMarker))) +
      element("MaxKeys", input.maxKeys) +
      (input.delimiter === undefined ? "" : element("Delimiter", encode(input.delimiter))) +
      element("IsTruncated", input.result.isTruncated) +
      (input.urlEncoding ? "<EncodingType>url</EncodingType>" : "") +
      `${listEntriesXml(input.result, encode)}</ListBucketResult>`,
  );
}

export function copyObjectResultXml(etag: string, lastModified: Date): string {
  return xmlDocument(
    `<CopyObjectResult xmlns="${S3_NAMESPACE}">${element("LastModified", iso(lastModified))}${element("ETag", etag)}</CopyObjectResult>`,
  );
}

export function initiateMultipartUploadXml(bucket: string, key: string, uploadId: string): string {
  return xmlDocument(
    `<InitiateMultipartUploadResult xmlns="${S3_NAMESPACE}">${element("Bucket", bucket)}${element("Key", key)}${element("UploadId", uploadId)}</InitiateMultipartUploadResult>`,
  );
}

export function completeMultipartUploadXml(input: {
  readonly location: string;
  readonly bucket: string;
  readonly key: string;
  readonly etag: string;
}): string {
  return xmlDocument(
    `<CompleteMultipartUploadResult xmlns="${S3_NAMESPACE}">${element("Location", input.location)}${element("Bucket", input.bucket)}` +
      `${element("Key", input.key)}${element("ETag", input.etag)}</CompleteMultipartUploadResult>`,
  );
}

export function listPartsXml(input: {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly ownerId: string;
  readonly partNumberMarker: number;
  readonly maxParts: number;
  readonly isTruncated: boolean;
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
    readonly size: number;
    readonly lastModified: Date;
  }[];
}): string {
  const parts = input.parts
    .map(
      (part) =>
        `<Part>${element("PartNumber", part.partNumber)}${element("LastModified", iso(part.lastModified))}` +
        `${element("ETag", part.etag)}${element("Size", part.size)}</Part>`,
    )
    .join("");
  const next = input.parts.at(-1)?.partNumber;
  return xmlDocument(
    `<ListPartsResult xmlns="${S3_NAMESPACE}">${element("Bucket", input.bucket)}${element("Key", input.key)}` +
      `${element("UploadId", input.uploadId)}<Initiator>${element("ID", input.ownerId)}</Initiator>` +
      `<Owner>${element("ID", input.ownerId)}</Owner><StorageClass>STANDARD</StorageClass>` +
      element("PartNumberMarker", input.partNumberMarker) +
      (input.isTruncated && next !== undefined ? element("NextPartNumberMarker", next) : "") +
      `${element("MaxParts", input.maxParts)}${element("IsTruncated", input.isTruncated)}${parts}</ListPartsResult>`,
  );
}

export function listMultipartUploadsXml(input: {
  readonly bucket: string;
  readonly prefix: string;
  readonly ownerId: string;
  readonly uploads: readonly {
    readonly key: string;
    readonly uploadId: string;
    readonly initiated: Date;
  }[];
}): string {
  const uploads = input.uploads
    .map(
      (upload) =>
        `<Upload>${element("Key", upload.key)}${element("UploadId", upload.uploadId)}` +
        `<Initiator>${element("ID", input.ownerId)}</Initiator><Owner>${element("ID", input.ownerId)}</Owner>` +
        `<StorageClass>STANDARD</StorageClass>${element("Initiated", iso(upload.initiated))}</Upload>`,
    )
    .join("");
  return xmlDocument(
    `<ListMultipartUploadsResult xmlns="${S3_NAMESPACE}">${element("Bucket", input.bucket)}` +
      `${element("Prefix", input.prefix)}<MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>${uploads}</ListMultipartUploadsResult>`,
  );
}

export function deleteResultXml(input: {
  readonly quiet: boolean;
  readonly deleted: readonly string[];
  readonly errors: readonly {
    readonly key: string;
    readonly code: string;
    readonly message: string;
  }[];
}): string {
  const deleted = input.quiet
    ? ""
    : input.deleted.map((key) => `<Deleted>${element("Key", key)}</Deleted>`).join("");
  const errors = input.errors
    .map(
      (error) =>
        `<Error>${element("Key", error.key)}${element("Code", error.code)}${element("Message", error.message)}</Error>`,
    )
    .join("");
  return xmlDocument(`<DeleteResult xmlns="${S3_NAMESPACE}">${deleted}${errors}</DeleteResult>`);
}
