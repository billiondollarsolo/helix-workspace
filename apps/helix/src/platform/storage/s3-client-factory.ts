import { S3Client } from "@aws-sdk/client-s3";
import type {
  FinalizeRequestMiddleware,
  HttpHandlerOptions,
  HttpRequest,
  HttpResponse,
  RequestHandler,
} from "@smithy/types";

export interface S3ClientFactoryInput {
  readonly endpoint: string;
  readonly region: string;
  readonly credentials: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly forcePathStyle: boolean;
  readonly maxAttempts: number;
  readonly requestHandler: RequestHandler<HttpRequest, HttpResponse, HttpHandlerOptions>;
  readonly clockOffsetMs: number;
  /** Runs before signing so presigned uploads do not sign a Content-Length. */
  readonly signingMiddleware: FinalizeRequestMiddleware<object, object>;
}

/**
 * The S3 client both the server-side calls and URL presigning use. A deployment
 * whose object store is private (the bundled RustFS) builds a second one against
 * the public endpoint, so browsers receive upload and download URLs they can
 * reach while the server keeps talking to the internal address.
 */
export function buildS3Client(input: S3ClientFactoryInput): S3Client {
  const client = new S3Client({
    endpoint: input.endpoint,
    region: input.region,
    credentials: input.credentials,
    forcePathStyle: input.forcePathStyle,
    maxAttempts: input.maxAttempts,
    retryMode: "standard",
    requestChecksumCalculation: "WHEN_REQUIRED", // presigned ones would hash an empty body
    responseChecksumValidation: "WHEN_SUPPORTED",
    requestHandler: input.requestHandler,
    systemClockOffset: input.clockOffsetMs,
  });
  client.middlewareStack.addRelativeTo(input.signingMiddleware as never, {
    name: "omitSignedContentLengthMiddleware",
    relation: "before",
    toMiddleware: "httpSigningMiddleware",
  });
  return client;
}

/** A browser-reachable endpoint for presigned URLs; HTTPS unless the store itself is plain HTTP. */
export function validatedPublicEndpoint(
  publicEndpoint: string | undefined,
  internalEndpoint: string,
): string | undefined {
  if (publicEndpoint === undefined || publicEndpoint.trim().length === 0) return undefined;
  const url = new URL(publicEndpoint);
  if (url.protocol !== "https:" && new URL(internalEndpoint).protocol === "https:") {
    throw new TypeError("S3-compatible storage public endpoint must use HTTPS");
  }
  return url.toString().replace(/\/$/u, "");
}
