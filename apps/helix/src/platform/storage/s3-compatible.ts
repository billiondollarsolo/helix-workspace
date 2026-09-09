import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type CreateMultipartUploadCommandOutput,
  type GetBucketEncryptionCommandOutput,
  type GetBucketVersioningCommandOutput,
  type GetObjectCommandOutput,
  type GetObjectLockConfigurationCommandOutput,
  type HeadObjectCommandOutput,
  type ListObjectsV2CommandOutput,
  type PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageClient, StorageObject, StorageObjectHead } from "@helix/sdk";
import type {
  FinalizeRequestMiddleware,
  HttpHandlerOptions,
  HttpRequest,
  HttpResponse,
  RequestHandler,
} from "@smithy/types";
import { OutboundHttpError, outboundFetch } from "../outbound-http.js";

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
  readonly securityPolicy?: S3StorageSecurityPolicy;
  readonly forcePathStyle?: boolean;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
  readonly maxAttempts?: number;
}
export type S3ServerSideEncryption = "AES256" | "aws:kms";
export interface S3StorageSecurityPolicy {
  readonly requireTls: boolean;
  readonly requireVersioning: boolean;
  readonly objectLock: {
    readonly mode: "COMPLIANCE" | "GOVERNANCE";
    readonly retentionDays: number;
  };
}
export interface S3CompatiblePresignOptions {
  readonly expiresSeconds?: number;
  readonly contentType?: string;
  readonly metadata?: Record<string, string>;
}

export interface S3CompatiblePresignedPutUpload {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface S3CompatibleObjectEvidence {
  readonly byteSize: number | null;
  readonly etag: string | null;
  readonly serverSideEncryption: string | null;
  readonly serverSideEncryptionAwsKmsKeyId: string | null;
  readonly metadata: Record<string, string>;
}

export interface S3MultipartCompletedPart {
  readonly partNumber: number;
  readonly etag: string;
}

export interface S3ObjectLock {
  readonly mode: "COMPLIANCE" | "GOVERNANCE";
  readonly retainUntil: string;
}

export interface S3CompatibleStorageClient extends StorageClient {
  headObject(key: string): Promise<S3CompatibleObjectEvidence | null>;
  copyObject(sourceKey: string, destinationKey: string): Promise<void>;
  checkHealth(): Promise<void>;
  ensureBucket(): Promise<void>;
  head(key: string): Promise<StorageObjectHead | null>;
  getStream(key: string): Promise<StorageObject | null>;
  getRange(key: string, start: number, end: number): Promise<StorageObject | null>;
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  listKeys(prefix: string): AsyncIterable<string>;
  putObjectLocked(object: StorageObject, lock: S3ObjectLock): Promise<void>;
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
    readonly causeName?: string,
  ) {
    super(message);
    this.name = "S3CompatibleStorageError";
  }
}

export function createS3CompatibleStorage(
  config: S3CompatibleStorageConfig,
): S3CompatibleStorageClient {
  return new SdkS3CompatibleStorageClient(config);
}

class SdkS3CompatibleStorageClient implements S3CompatibleStorageClient {
  readonly #client: S3Client;
  readonly #config: NormalizedS3Config;

  constructor(config: S3CompatibleStorageConfig) {
    this.#config = normalizeConfig(config);
    this.#client = new S3Client({
      endpoint: this.#config.endpoint,
      region: this.#config.region,
      credentials: this.#config.credentials,
      forcePathStyle: this.#config.forcePathStyle,
      maxAttempts: this.#config.maxAttempts,
      retryMode: "standard",
      requestChecksumCalculation: "WHEN_SUPPORTED",
      responseChecksumValidation: "WHEN_SUPPORTED",
      requestHandler: new GuardedFetchHandler(this.#config.fetch),
      systemClockOffset: this.#config.now().getTime() - Date.now(),
    });
    this.#client.middlewareStack.addRelativeTo(omitSignedContentLengthMiddleware as never, {
      name: "omitSignedContentLengthMiddleware",
      relation: "before",
      toMiddleware: "httpSigningMiddleware",
    });
  }

  async checkHealth(): Promise<void> {
    await this.#send(new HeadBucketCommand({ Bucket: this.#config.bucket }), "health check");
    const policy = this.#config.securityPolicy;
    if (policy === undefined) return;
    const encryption = await this.#send<GetBucketEncryptionCommandOutput>(
      new GetBucketEncryptionCommand({ Bucket: this.#config.bucket }),
      "encryption policy check",
    );
    const rule =
      encryption.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault;
    if (
      rule?.SSEAlgorithm !== "aws:kms" ||
      rule.KMSMasterKeyID !== this.#config.serverSideEncryptionAwsKmsKeyId
    ) {
      throw new S3CompatibleStorageError(
        "S3 bucket does not enforce the configured SSE-KMS key",
        503,
      );
    }
    if (policy.requireVersioning) {
      const versioning = await this.#send<GetBucketVersioningCommandOutput>(
        new GetBucketVersioningCommand({ Bucket: this.#config.bucket }),
        "versioning policy check",
      );
      if (versioning.Status !== "Enabled") {
        throw new S3CompatibleStorageError("S3 bucket versioning is not enabled", 503);
      }
    }
    const objectLock = await this.#send<GetObjectLockConfigurationCommandOutput>(
      new GetObjectLockConfigurationCommand({ Bucket: this.#config.bucket }),
      "object lock policy check",
    );
    const retention = objectLock.ObjectLockConfiguration?.Rule?.DefaultRetention;
    if (
      objectLock.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled" ||
      retention?.Mode !== policy.objectLock.mode ||
      retention.Days === undefined ||
      retention.Days < policy.objectLock.retentionDays
    ) {
      throw new S3CompatibleStorageError(
        "S3 bucket object-lock retention does not meet the configured policy",
        503,
      );
    }
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.#send(new CreateBucketCommand({ Bucket: this.#config.bucket }), "bucket create");
    } catch (error) {
      if (
        error instanceof S3CompatibleStorageError &&
        (error.causeName === "BucketAlreadyOwnedByYou" || error.causeName === "BucketAlreadyExists")
      ) {
        return;
      }
      throw error;
    }
  }

  async put(object: StorageObject): Promise<void> {
    await this.#put(object);
  }

  async putObjectLocked(object: StorageObject, lock: S3ObjectLock): Promise<void> {
    const retainUntil = new Date(lock.retainUntil);
    if (Number.isNaN(retainUntil.getTime())) throw new TypeError("S3 object lock date is invalid");
    await this.#put(object, {
      ObjectLockMode: lock.mode,
      ObjectLockRetainUntilDate: retainUntil,
    });
  }

  async #put(
    object: StorageObject,
    lock: Pick<PutObjectCommandInput, "ObjectLockMode" | "ObjectLockRetainUntilDate"> = {},
  ): Promise<void> {
    assertKey(object.key);
    const body = await toUint8Array(object.body);
    await this.#send(
      new PutObjectCommand({
        Bucket: this.#config.bucket,
        Key: object.key,
        Body: body,
        ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
        ...(object.contentType === undefined ? {} : { ContentType: object.contentType }),
        ...(object.metadata === undefined ? {} : { Metadata: object.metadata }),
        ...sseInput(this.#config),
        ...lock,
      }),
      "put",
    );
  }

  async get(key: string): Promise<StorageObject | null> {
    const result = await this.#get(key);
    if (result === null) return null;
    return { ...objectProperties(key, result), body: await result.Body.transformToByteArray() };
  }

  async head(key: string): Promise<StorageObjectHead | null> {
    assertKey(key);
    try {
      const result = await this.#send<HeadObjectCommandOutput>(
        new HeadObjectCommand({ Bucket: this.#config.bucket, Key: key }),
        "head",
      );
      const byteSize = result.ContentLength;
      if (byteSize === undefined || !Number.isSafeInteger(byteSize) || byteSize < 0) {
        throw new S3CompatibleStorageError("S3-compatible storage returned an invalid size", 502);
      }
      return {
        key,
        byteSize,
        ...(result.ETag === undefined ? {} : { etag: result.ETag }),
        ...(result.LastModified === undefined ? {} : { lastModified: result.LastModified }),
        ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
        ...(result.Metadata === undefined ? {} : { metadata: result.Metadata }),
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async headObject(key: string): Promise<S3CompatibleObjectEvidence | null> {
    assertKey(key);
    try {
      const result = await this.#send<HeadObjectCommandOutput>(
        new HeadObjectCommand({ Bucket: this.#config.bucket, Key: key }),
        "head",
      );
      return {
        byteSize: result.ContentLength ?? null,
        etag: result.ETag ?? null,
        serverSideEncryption: result.ServerSideEncryption ?? null,
        serverSideEncryptionAwsKmsKeyId: result.SSEKMSKeyId ?? null,
        metadata: result.Metadata ?? {},
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    return this.copy(sourceKey, destinationKey);
  }

  async getStream(key: string): Promise<StorageObject | null> {
    const result = await this.#get(key);
    return result === null
      ? null
      : { ...objectProperties(key, result), body: streamBody(result.Body) };
  }

  async getRange(key: string, start: number, end: number): Promise<StorageObject | null> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new TypeError("S3 byte range must be safe non-negative integers in ascending order");
    }
    const result = await this.#get(key, `bytes=${String(start)}-${String(end)}`);
    return result === null
      ? null
      : { ...objectProperties(key, result), body: streamBody(result.Body) };
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    assertKey(sourceKey);
    assertKey(destinationKey);
    await this.#send(
      new CopyObjectCommand({
        Bucket: this.#config.bucket,
        Key: destinationKey,
        CopySource: `/${encodePath(this.#config.bucket)}/${encodePath(sourceKey)}`,
        ...sseInput(this.#config),
      }),
      "copy",
    );
  }

  async *listKeys(prefix: string): AsyncIterable<string> {
    let continuationToken: string | undefined;
    for (;;) {
      const result = await this.#send<ListObjectsV2CommandOutput>(
        new ListObjectsV2Command({
          Bucket: this.#config.bucket,
          Prefix: prefix,
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }),
        "list objects",
      );
      for (const object of result.Contents ?? []) {
        if (object.Key !== undefined && object.Key.length > 0) yield object.Key;
      }
      if (result.IsTruncated !== true) return;
      if (result.NextContinuationToken === undefined || result.NextContinuationToken.length === 0) {
        throw new S3CompatibleStorageError(
          "S3-compatible storage returned a truncated list without a continuation token",
          502,
        );
      }
      continuationToken = result.NextContinuationToken;
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.#send(new DeleteObjectCommand({ Bucket: this.#config.bucket, Key: key }), "delete");
  }

  async presignGetUrl(key: string, options: S3CompatiblePresignOptions = {}): Promise<string> {
    assertKey(key);
    return this.#presign(
      new GetObjectCommand({ Bucket: this.#config.bucket, Key: key }),
      options.expiresSeconds,
    );
  }

  async presignPutUrl(key: string, options: S3CompatiblePresignOptions = {}): Promise<string> {
    return (await this.presignPutRequest(key, options)).url;
  }

  async presignPutRequest(
    key: string,
    options: S3CompatiblePresignOptions = {},
  ): Promise<S3CompatiblePresignedPutUpload> {
    assertKey(key);
    const headers = uploadHeaders(options, this.#config);
    const command = new PutObjectCommand({
      Bucket: this.#config.bucket,
      Key: key,
      ...(options.contentType === undefined ? {} : { ContentType: options.contentType }),
      ...(options.metadata === undefined ? {} : { Metadata: options.metadata }),
      ...sseInput(this.#config),
    });
    return {
      url: await this.#presign(command, options.expiresSeconds, new Set(Object.keys(headers))),
      headers,
    };
  }

  async createMultipartUpload(
    key: string,
    options: S3CompatiblePresignOptions = {},
  ): Promise<{ readonly uploadId: string }> {
    assertKey(key);
    const result = await this.#send<CreateMultipartUploadCommandOutput>(
      new CreateMultipartUploadCommand({
        Bucket: this.#config.bucket,
        Key: key,
        ...(options.contentType === undefined ? {} : { ContentType: options.contentType }),
        ...(options.metadata === undefined ? {} : { Metadata: options.metadata }),
        ...sseInput(this.#config),
      }),
      "create multipart upload",
    );
    if (result.UploadId === undefined || result.UploadId.length === 0) {
      throw new S3CompatibleStorageError(
        "S3-compatible storage create multipart upload response is invalid",
        502,
      );
    }
    return { uploadId: result.UploadId };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: S3CompatiblePresignOptions = {},
  ): Promise<string> {
    assertKey(key);
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      throw new TypeError("S3 multipart partNumber must be a positive integer");
    }
    return this.#presign(
      new UploadPartCommand({
        Bucket: this.#config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      options.expiresSeconds,
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly S3MultipartCompletedPart[],
  ): Promise<void> {
    assertKey(key);
    await this.#send(
      new CompleteMultipartUploadCommand({
        Bucket: this.#config.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts]
            .sort((left, right) => left.partNumber - right.partNumber)
            .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      }),
      "complete multipart upload",
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    assertKey(key);
    await this.#send(
      new AbortMultipartUploadCommand({
        Bucket: this.#config.bucket,
        Key: key,
        UploadId: uploadId,
      }),
      "abort multipart upload",
    );
  }

  async #get(key: string, range?: string): Promise<GetObjectResult | null> {
    assertKey(key);
    try {
      const result = await this.#send<GetObjectCommandOutput>(
        new GetObjectCommand({
          Bucket: this.#config.bucket,
          Key: key,
          ...(range === undefined ? {} : { Range: range }),
        }),
        range === undefined ? "get" : "range get",
      );
      if (result.Body === undefined) {
        throw new S3CompatibleStorageError("S3-compatible storage returned no object body", 502);
      }
      return result as GetObjectResult;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async #send<Output>(command: unknown, operation: string): Promise<Output> {
    try {
      return (await this.#client.send(command as never, {
        abortSignal: AbortSignal.timeout(this.#config.requestTimeoutMs),
      })) as Output;
    } catch (error) {
      if (error instanceof S3CompatibleStorageError) throw error;
      const causeName = error instanceof Error ? error.name : "UnknownError";
      const rawStatus = metadataStatus(error);
      throw new S3CompatibleStorageError(
        `S3-compatible storage ${operation} failed with HTTP ${String(rawStatus ?? 502)}`,
        rawStatus !== undefined && rawStatus >= 400 ? rawStatus : 502,
        causeName,
      );
    }
  }

  async #presign(
    command: unknown,
    expiresSeconds: number | undefined,
    unhoistableHeaders?: Set<string>,
  ): Promise<string> {
    return getSignedUrl(this.#client, command as never, {
      expiresIn: validateExpiresSeconds(expiresSeconds ?? 900),
      signingDate: this.#config.now(),
      ...(unhoistableHeaders === undefined
        ? {}
        : { signableHeaders: unhoistableHeaders, unhoistableHeaders }),
    });
  }
}

interface NormalizedS3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly credentials: S3CompatibleCredentials;
  readonly serverSideEncryption: S3ServerSideEncryption | undefined;
  readonly serverSideEncryptionAwsKmsKeyId: string | undefined;
  readonly securityPolicy: S3StorageSecurityPolicy | undefined;
  readonly forcePathStyle: boolean;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
}

class GuardedFetchHandler implements RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions> {
  readonly metadata = { handlerProtocol: "http/1.1" };

  constructor(private readonly fetchImpl: typeof fetch) {}

  async handle(
    request: HttpRequest,
    options: HttpHandlerOptions = {},
  ): Promise<{ response: HttpResponse }> {
    const url = requestUrl(request);
    const callerSignal = options.abortSignal as AbortSignal | undefined;
    const signal = callerSignal ?? new AbortController().signal;
    try {
      const body = await requestBody(request.body);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        headers.set(name, value);
      }
      const response = await this.fetchImpl(url, {
        method: request.method,
        headers,
        signal,
        ...(body === undefined ? {} : { body }),
      });
      return {
        response: {
          statusCode: response.status,
          reason: response.statusText,
          headers: headersRecord(response.headers),
          ...(response.body === null
            ? {}
            : { body: Readable.from(webResponseBody(response.body)) }),
        },
      };
    } catch (error) {
      if (signal.aborted) {
        const aborted = new Error("S3-compatible storage request aborted");
        aborted.name = "AbortError";
        throw aborted;
      }
      if (isRetryableTransportError(error) && error instanceof Error) {
        Object.assign(error, { $retryable: {} });
      }
      throw error;
    }
  }
}

const omitSignedContentLengthMiddleware: FinalizeRequestMiddleware<object, object> =
  (next) => async (args) => {
    const request = args.request as HttpRequest;
    delete request.headers["content-length"];
    return next(args);
  };

function normalizeConfig(config: S3CompatibleStorageConfig): NormalizedS3Config {
  if (config.bucket.length === 0) throw new TypeError("S3-compatible storage bucket is required");
  if (config.region.length === 0) throw new TypeError("S3-compatible storage region is required");
  if (
    config.credentials.accessKeyId.length === 0 ||
    config.credentials.secretAccessKey.length === 0
  ) {
    throw new TypeError("S3-compatible storage credentials are required");
  }
  const endpointUrl = new URL(config.endpoint);
  if (
    (endpointUrl.protocol !== "https:" && endpointUrl.protocol !== "http:") ||
    endpointUrl.username !== "" ||
    endpointUrl.password !== "" ||
    endpointUrl.search !== "" ||
    endpointUrl.hash !== ""
  ) {
    throw new TypeError("S3-compatible storage endpoint must be an HTTP(S) origin");
  }
  if (config.securityPolicy?.requireTls === true && endpointUrl.protocol !== "https:") {
    throw new TypeError("S3-compatible storage endpoint must use HTTPS");
  }
  if (
    config.serverSideEncryptionAwsKmsKeyId !== undefined &&
    config.serverSideEncryption !== "aws:kms"
  ) {
    throw new TypeError("S3 KMS key requires aws:kms server-side encryption");
  }
  if (
    config.securityPolicy !== undefined &&
    (config.serverSideEncryption !== "aws:kms" ||
      config.serverSideEncryptionAwsKmsKeyId?.trim().length === 0 ||
      config.serverSideEncryptionAwsKmsKeyId === undefined)
  ) {
    throw new TypeError("Secure S3 storage requires an SSE-KMS key");
  }
  if (
    config.securityPolicy !== undefined &&
    (!Number.isSafeInteger(config.securityPolicy.objectLock.retentionDays) ||
      config.securityPolicy.objectLock.retentionDays < 1)
  ) {
    throw new TypeError("S3 object-lock retentionDays must be a positive safe integer");
  }
  const endpoint = endpointUrl.toString().replace(/\/$/u, "");
  const requestTimeoutMs = config.requestTimeoutMs ?? 30_000;
  const maxAttempts = config.maxAttempts ?? 3;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new TypeError("S3 requestTimeoutMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError("S3 maxAttempts must be a positive safe integer");
  }
  return {
    endpoint,
    region: config.region,
    bucket: config.bucket,
    credentials: config.credentials,
    serverSideEncryption: config.serverSideEncryption,
    serverSideEncryptionAwsKmsKeyId: config.serverSideEncryptionAwsKmsKeyId,
    securityPolicy: config.securityPolicy,
    forcePathStyle: config.forcePathStyle ?? true,
    fetch: config.fetch ?? outboundFetch,
    now: config.now ?? (() => new Date()),
    requestTimeoutMs,
    maxAttempts,
  };
}

function sseInput(config: NormalizedS3Config) {
  return {
    ServerSideEncryption: config.serverSideEncryption,
    SSEKMSKeyId: config.serverSideEncryptionAwsKmsKeyId,
  };
}

function uploadHeaders(
  options: S3CompatiblePresignOptions,
  config: NormalizedS3Config,
): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(options.metadata ?? {}).map(([key, value]) => [
      `x-amz-meta-${key.toLowerCase()}`,
      value,
    ]),
  );
  if (options.contentType !== undefined) headers["content-type"] = options.contentType;
  if (config.serverSideEncryption !== undefined) {
    headers["x-amz-server-side-encryption"] = config.serverSideEncryption;
  }
  if (config.serverSideEncryptionAwsKmsKeyId !== undefined) {
    headers["x-amz-server-side-encryption-aws-kms-key-id"] = config.serverSideEncryptionAwsKmsKeyId;
  }
  return headers;
}

function objectProperties(key: string, result: GetObjectCommandOutput) {
  return {
    key,
    ...(result.ContentType === undefined ? {} : { contentType: result.ContentType }),
    ...(result.Metadata === undefined ? {} : { metadata: result.Metadata }),
  };
}

type GetObjectResult = GetObjectCommandOutput & {
  readonly Body: NonNullable<GetObjectCommandOutput["Body"]>;
};

function streamBody(body: NonNullable<GetObjectCommandOutput["Body"]>): AsyncIterable<Uint8Array> {
  return (async function* () {
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      }
    } finally {
      if ("destroy" in body && typeof body.destroy === "function") body.destroy();
    }
  })();
}

function requestUrl(request: HttpRequest): URL {
  const url = new URL(
    `${request.protocol}//${request.hostname}${request.port === undefined ? "" : `:${String(request.port)}`}${request.path}`,
  );
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value === null) url.searchParams.append(name, "");
    else if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, item);
    else url.searchParams.append(name, value);
  }
  return url;
}

async function requestBody(body: unknown): Promise<BodyInit | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (ArrayBuffer.isView(body)) {
    return bodyBlob(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  if (Symbol.asyncIterator in Object(body)) {
    return bodyBlob(await toUint8Array(body as AsyncIterable<Uint8Array>));
  }
  throw new TypeError("S3 SDK produced an unsupported request body");
}

function bodyBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]);
}

function headersRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

async function* webResponseBody(body: ReadableStream<unknown>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      if (!(result.value instanceof Uint8Array)) throw new TypeError("S3 returned invalid bytes");
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function toUint8Array(body: AsyncIterable<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function metadataStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof S3CompatibleStorageError &&
    (error.status === 404 || error.causeName === "NoSuchKey" || error.causeName === "NotFound")
  );
}

function isRetryableTransportError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof OutboundHttpError &&
      (error.code === "dns_failed" || error.code === "transport_failed"))
  );
}

function assertKey(key: string): void {
  if (key.length === 0) throw new TypeError("S3 object key is required");
}

function validateExpiresSeconds(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 604_800) {
    throw new TypeError("S3 presign expiry must be an integer between 1 and 604800 seconds");
  }
  return value;
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}
