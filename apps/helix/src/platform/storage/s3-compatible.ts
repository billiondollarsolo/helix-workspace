import { createHash, createHmac } from "node:crypto";
import type { StorageClient, StorageObject } from "@helix/sdk";

export interface S3CompatibleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface S3CompatibleStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: S3CompatibleCredentials;
  readonly serverSideEncryption?: S3ServerSideEncryption;
  readonly serverSideEncryptionAwsKmsKeyId?: string;
  readonly forcePathStyle?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export type S3ServerSideEncryption = "AES256" | "aws:kms";

export interface S3CompatiblePresignOptions {
  readonly expiresSeconds?: number;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

export interface S3CompatiblePresignedPutUpload {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface S3MultipartCompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface S3CompatibleStorageClient extends StorageClient {
  ensureBucket(): Promise<void>;
  presignGetUrl(key: string, options?: S3CompatiblePresignOptions): Promise<string>;
  presignPutUrl(key: string, options?: S3CompatiblePresignOptions): Promise<string>;
  presignPutRequest(
    key: string,
    options?: S3CompatiblePresignOptions,
  ): Promise<S3CompatiblePresignedPutUpload>;
  createMultipartUpload(
    key: string,
    options?: S3CompatiblePresignOptions,
  ): Promise<{ readonly uploadId: string }>;
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options?: S3CompatiblePresignOptions,
  ): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly S3MultipartCompletedPart[],
  ): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export class S3CompatibleStorageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
  ) {
    super(message);
    this.name = "S3CompatibleStorageError";
  }
}

export function createS3CompatibleStorage(
  config: S3CompatibleStorageConfig,
): S3CompatibleStorageClient {
  return new FetchS3CompatibleStorageClient(config);
}

class FetchS3CompatibleStorageClient implements S3CompatibleStorageClient {
  readonly #config: NormalizedS3Config;

  constructor(config: S3CompatibleStorageConfig) {
    this.#config = normalizeConfig(config);
  }

  async ensureBucket(): Promise<void> {
    const response = await this.#bucketRequest(
      "PUT",
      { "x-amz-content-sha256": emptyBodyHash },
      undefined,
    );
    if (response.status === 409) {
      const text = await safeResponseText(response);
      if (text.includes("BucketAlreadyOwnedByYou") || text.includes("BucketAlreadyExists")) {
        return;
      }
      throw new S3CompatibleStorageError(
        `S3-compatible storage bucket create failed for ${this.#config.bucket}${text}`,
        response.status,
        response.statusText,
      );
    }
    await expectOk(response, "bucket create", this.#config.bucket);
  }

  async put(object: StorageObject): Promise<void> {
    const body = await toUint8Array(object.body);
    const headers = {
      ...storageObjectHeaders(object, hashHex(body)),
      ...serverSideEncryptionHeaders(this.#config),
    };
    const response = await this.#request("PUT", object.key, headers, body);
    await expectOk(response, "put", object.key);
  }

  async get(key: string): Promise<StorageObject | null> {
    const response = await this.#request(
      "GET",
      key,
      { "x-amz-content-sha256": emptyBodyHash },
      undefined,
    );
    if (response.status === 404) {
      return null;
    }
    await expectOk(response, "get", key);

    const body = responseBodyChunks(response);
    const contentType = response.headers.get("content-type") ?? undefined;
    const metadata = responseMetadata(response.headers);
    return {
      key,
      body,
      ...(contentType === undefined ? {} : { contentType }),
      ...(metadata === undefined ? {} : { metadata }),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.#request(
      "DELETE",
      key,
      { "x-amz-content-sha256": emptyBodyHash },
      undefined,
    );
    await expectOk(response, "delete", key);
  }

  async presignGetUrl(key: string, options: S3CompatiblePresignOptions = {}): Promise<string> {
    return this.#presign("GET", key, options).url;
  }

  async presignPutUrl(key: string, options: S3CompatiblePresignOptions = {}): Promise<string> {
    return (await this.presignPutRequest(key, options)).url;
  }

  async presignPutRequest(
    key: string,
    options: S3CompatiblePresignOptions = {},
  ): Promise<S3CompatiblePresignedPutUpload> {
    const presigned = this.#presign("PUT", key, options);
    return {
      url: presigned.url,
      headers: presignedUploadHeaders(presigned.headers),
    };
  }

  async createMultipartUpload(
    key: string,
    options: S3CompatiblePresignOptions = {},
  ): Promise<{ readonly uploadId: string }> {
    const response = await this.#request(
      "POST",
      key,
      {
        "x-amz-content-sha256": emptyBodyHash,
        ...requestContentHeaders(options),
        ...serverSideEncryptionHeaders(this.#config),
      },
      undefined,
      { uploads: "" },
    );
    await expectOk(response, "create multipart upload", key);
    const text = await response.text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/u.exec(text)?.[1];
    if (uploadId === undefined || uploadId.length === 0) {
      throw new S3CompatibleStorageError(
        `S3-compatible storage create multipart upload missing UploadId for ${key}`,
        response.status,
        response.statusText,
      );
    }
    return { uploadId };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: S3CompatiblePresignOptions = {},
  ): Promise<string> {
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      throw new TypeError("S3 multipart partNumber must be a positive integer");
    }
    return this.#presign("PUT", key, options, {
      partNumber: String(partNumber),
      uploadId,
    }).url;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly S3MultipartCompletedPart[],
  ): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const bodyXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<CompleteMultipartUpload>",
      ...sorted.map(
        (part) =>
          `<Part><PartNumber>${String(part.partNumber)}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`,
      ),
      "</CompleteMultipartUpload>",
    ].join("");
    const body = new TextEncoder().encode(bodyXml);
    const response = await this.#request(
      "POST",
      key,
      {
        "content-type": "application/xml",
        "x-amz-content-sha256": hashHex(body),
      },
      body,
      { uploadId },
    );
    await expectOk(response, "complete multipart upload", key);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const response = await this.#request(
      "DELETE",
      key,
      { "x-amz-content-sha256": emptyBodyHash },
      undefined,
      { uploadId },
    );
    await expectOk(response, "abort multipart upload", key);
  }

  async #request(
    method: S3Method,
    key: string,
    inputHeaders: Record<string, string>,
    body: Uint8Array | undefined,
    query: Record<string, string> = {},
  ): Promise<Response> {
    const url = objectUrl(this.#config, key);
    if (Object.keys(query).length > 0) {
      url.search = canonicalQueryString(query);
    }
    const date = this.#config.now();
    const headers = normalizeHeaders({
      ...inputHeaders,
      host: url.host,
      "x-amz-date": amzDate(date),
      ...(this.#config.credentials.sessionToken === undefined
        ? {}
        : { "x-amz-security-token": this.#config.credentials.sessionToken }),
    });
    const canonicalRequest = createCanonicalRequest(
      method,
      url.pathname,
      url.search.startsWith("?") ? url.search.slice(1) : url.search,
      headers,
      headers["x-amz-content-sha256"] ?? emptyBodyHash,
    );
    headers.authorization = authorizationHeader(this.#config, date, headers, canonicalRequest);

    return this.#config.fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  async #bucketRequest(
    method: S3Method,
    inputHeaders: Record<string, string>,
    body: Uint8Array | undefined,
  ): Promise<Response> {
    const url = bucketUrl(this.#config);
    const date = this.#config.now();
    const headers = normalizeHeaders({
      ...inputHeaders,
      host: url.host,
      "x-amz-date": amzDate(date),
      ...(this.#config.credentials.sessionToken === undefined
        ? {}
        : { "x-amz-security-token": this.#config.credentials.sessionToken }),
    });
    const canonicalRequest = createCanonicalRequest(
      method,
      url.pathname,
      "",
      headers,
      headers["x-amz-content-sha256"] ?? emptyBodyHash,
    );
    headers.authorization = authorizationHeader(this.#config, date, headers, canonicalRequest);

    return this.#config.fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
  }

  #presign(
    method: S3Method,
    key: string,
    options: S3CompatiblePresignOptions,
    extraQuery: Record<string, string> = {},
  ): { readonly url: string; readonly headers: Record<string, string> } {
    const url = objectUrl(this.#config, key);
    const date = this.#config.now();
    const expiresSeconds = validateExpiresSeconds(options.expiresSeconds ?? 900);
    const headers = normalizeHeaders({
      host: url.host,
      ...requestContentHeaders(options),
      ...(method === "PUT" ? serverSideEncryptionHeaders(this.#config) : {}),
    });
    const signedHeaders = signedHeaderNames(headers);
    const credential = credentialScope(this.#config, date);
    const queryParams: Record<string, string> = {
      ...extraQuery,
      "X-Amz-Algorithm": signingAlgorithm,
      "X-Amz-Credential": `${this.#config.credentials.accessKeyId}/${credential}`,
      "X-Amz-Date": amzDate(date),
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": signedHeaders,
      ...(this.#config.credentials.sessionToken === undefined
        ? {}
        : { "X-Amz-Security-Token": this.#config.credentials.sessionToken }),
    };
    const canonicalQuery = canonicalQueryString(queryParams);
    const canonicalRequest = createCanonicalRequest(
      method,
      url.pathname,
      canonicalQuery,
      headers,
      "UNSIGNED-PAYLOAD",
    );
    const signature = requestSignature(this.#config, date, canonicalRequest);
    url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return { url: url.toString(), headers };
  }
}

async function* responseBodyChunks(response: Response): AsyncIterable<Uint8Array> {
  const stream = response.body;
  if (stream === null) {
    return;
  }
  const reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  try {
    let result = await reader.read();
    while (!result.done) {
      const chunk = result.value;
      if (chunk.byteLength > 0) yield chunk;
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}

type S3Method = "DELETE" | "GET" | "POST" | "PUT";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

interface NormalizedS3Config {
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: S3CompatibleCredentials;
  readonly serverSideEncryption?: S3ServerSideEncryption;
  readonly serverSideEncryptionAwsKmsKeyId?: string;
  readonly forcePathStyle: boolean;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

const signingAlgorithm = "AWS4-HMAC-SHA256";
const emptyBodyHash = hashHex(new Uint8Array());
const metadataHeaderPrefix = "x-amz-meta-";

function normalizeConfig(config: S3CompatibleStorageConfig): NormalizedS3Config {
  if (config.bucket.length === 0) {
    throw new TypeError("S3-compatible storage bucket is required");
  }
  if (config.region.length === 0) {
    throw new TypeError("S3-compatible storage region is required");
  }
  if (
    config.credentials.accessKeyId.length === 0 ||
    config.credentials.secretAccessKey.length === 0
  ) {
    throw new TypeError("S3-compatible storage credentials are required");
  }
  return {
    endpoint: new URL(config.endpoint),
    region: config.region,
    bucket: config.bucket,
    credentials: config.credentials,
    ...(config.serverSideEncryption === undefined
      ? {}
      : { serverSideEncryption: config.serverSideEncryption }),
    ...(config.serverSideEncryptionAwsKmsKeyId === undefined
      ? {}
      : { serverSideEncryptionAwsKmsKeyId: config.serverSideEncryptionAwsKmsKeyId }),
    forcePathStyle: config.forcePathStyle ?? true,
    fetch: config.fetch ?? fetch,
    now: config.now ?? (() => new Date()),
  };
}

function objectUrl(config: NormalizedS3Config, key: string): URL {
  if (key.length === 0) {
    throw new TypeError("S3 object key is required");
  }

  const url = new URL(config.endpoint);
  const encodedKey = encodePath(key);
  if (config.forcePathStyle) {
    url.pathname = joinPaths(url.pathname, encodePath(config.bucket), encodedKey);
  } else {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = joinPaths(url.pathname, encodedKey);
  }
  url.search = "";
  return url;
}

function bucketUrl(config: NormalizedS3Config): URL {
  const url = new URL(config.endpoint);
  if (config.forcePathStyle) {
    url.pathname = joinPaths(url.pathname, encodePath(config.bucket));
  } else {
    url.hostname = `${config.bucket}.${url.hostname}`;
    url.pathname = joinPaths(url.pathname);
  }
  url.search = "";
  return url;
}

function storageObjectHeaders(object: StorageObject, payloadHash: string): Record<string, string> {
  return {
    "x-amz-content-sha256": payloadHash,
    ...(object.contentType === undefined ? {} : { "content-type": object.contentType }),
    ...metadataHeaders(object.metadata),
  };
}

function requestContentHeaders(options: S3CompatiblePresignOptions): Record<string, string> {
  return {
    ...(options.contentType === undefined ? {} : { "content-type": options.contentType }),
    ...metadataHeaders(options.metadata),
  };
}

function serverSideEncryptionHeaders(config: NormalizedS3Config): Record<string, string> {
  return config.serverSideEncryption === undefined
    ? {}
    : {
        "x-amz-server-side-encryption": config.serverSideEncryption,
        ...(config.serverSideEncryptionAwsKmsKeyId === undefined
          ? {}
          : {
              "x-amz-server-side-encryption-aws-kms-key-id": config.serverSideEncryptionAwsKmsKeyId,
            }),
      };
}

function presignedUploadHeaders(headers: Record<string, string>): Record<string, string> {
  const uploadHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name !== "host") {
      uploadHeaders[name] = value;
    }
  }
  return uploadHeaders;
}

function metadataHeaders(metadata: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata ?? {})) {
    headers[`${metadataHeaderPrefix}${name.toLowerCase()}`] = value;
  }
  return headers;
}

function responseMetadata(headers: Headers): Record<string, string> | undefined {
  const metadata: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (name.startsWith(metadataHeaderPrefix)) {
      metadata[name.slice(metadataHeaderPrefix.length)] = value;
    }
  }
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

async function expectOk(response: Response, operation: string, key: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const detail = await safeResponseText(response);
  throw new S3CompatibleStorageError(
    [
      "S3-compatible storage ",
      operation,
      " failed for ",
      key,
      ": ",
      String(response.status),
      " ",
      response.statusText,
      detail,
    ].join(""),
    response.status,
    response.statusText,
  );
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length === 0 ? "" : `: ${text}`;
  } catch {
    return "";
  }
}

async function toUint8Array(body: StorageObject["body"]): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }

  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer;
}

function createCanonicalRequest(
  method: S3Method,
  canonicalUri: string,
  canonicalQuery: string,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  return [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders(headers),
    signedHeaderNames(headers),
    payloadHash,
  ].join("\n");
}

function authorizationHeader(
  config: NormalizedS3Config,
  date: Date,
  headers: Record<string, string>,
  canonicalRequest: string,
): string {
  return [
    `${signingAlgorithm} Credential=${config.credentials.accessKeyId}/${credentialScope(config, date)}`,
    `SignedHeaders=${signedHeaderNames(headers)}`,
    `Signature=${requestSignature(config, date, canonicalRequest)}`,
  ].join(", ");
}

function requestSignature(
  config: NormalizedS3Config,
  date: Date,
  canonicalRequest: string,
): string {
  return hmacHex(signingKey(config, date), stringToSign(config, date, canonicalRequest));
}

function stringToSign(config: NormalizedS3Config, date: Date, canonicalRequest: string): string {
  return [
    signingAlgorithm,
    amzDate(date),
    credentialScope(config, date),
    hashHex(canonicalRequest),
  ].join("\n");
}

function signingKey(config: NormalizedS3Config, date: Date): Uint8Array {
  const dateKey = hmac(`AWS4${config.credentials.secretAccessKey}`, shortDate(date));
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

function credentialScope(config: NormalizedS3Config, date: Date): string {
  return `${shortDate(date)}/${config.region}/s3/aws4_request`;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value.trim().replace(/\s+/g, " ");
  }
  return normalized;
}

function canonicalHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name] ?? ""}\n`)
    .join("");
}

function signedHeaderNames(headers: Record<string, string>): string {
  return Object.keys(headers).sort().join(";");
}

function canonicalQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

function validateExpiresSeconds(expiresSeconds: number): number {
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 604_800) {
    throw new TypeError(
      "S3-compatible presigned URL expiry must be an integer from 1 to 604800 seconds",
    );
  }
  return expiresSeconds;
}

function joinPaths(...parts: readonly string[]): string {
  return `/${parts
    .flatMap((part) => part.split("/"))
    .filter((part) => part.length > 0)
    .join("/")}`;
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((part) => encodeRfc3986(part))
    .join("/");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function shortDate(date: Date): string {
  return amzDate(date).slice(0, 8);
}

function hashHex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Uint8Array {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
