import { getCryptoProvider } from "../../crypto/index.js";

export type RawWebhookBody = Buffer | Uint8Array | string;
export type WebhookHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface InboundSourceAdapter<TParsed> {
  readonly sourceType: string;
  readonly verify: (options: VerifySourceSignatureOptions) => boolean;
  readonly parse: (options: ParseSourceWebhookOptions) => TParsed;
}

export interface VerifySourceSignatureOptions {
  readonly payload: RawWebhookBody;
  readonly secret: string;
  readonly headers?: WebhookHeaders;
  readonly header?: string;
  readonly now?: Date | number;
  readonly toleranceSeconds?: number;
}

export interface ParseSourceWebhookOptions {
  readonly payload: RawWebhookBody;
  readonly headers?: WebhookHeaders;
}

export function getHeader(headers: WebhookHeaders | undefined, name: string): string | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const target = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() !== target || value === undefined) {
      continue;
    }
    return typeof value === "string" ? value : value[0];
  }

  return undefined;
}

/** `Authorization: Bearer <token>`, for sources that authenticate with a shared token. */
export function bearerToken(headers: WebhookHeaders | undefined): string | undefined {
  const authorization = getHeader(headers, "authorization");
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^bearer\s+(.+)$/iu.exec(authorization);
  return match?.[1]?.trim();
}

/** Decodes a raw body for sources whose signed message is a UTF-8 string. */
export function payloadToString(payload: RawWebhookBody): string {
  return toBuffer(payload).toString("utf8");
}

export function hmacSha256Hex(secret: string, payload: RawWebhookBody): string {
  return getCryptoProvider().hmac("sha256", secret, toBuffer(payload), "hex");
}

export function hmacSha256Base64(secret: string, payload: RawWebhookBody): string {
  return getCryptoProvider().hmac("sha256", secret, toBuffer(payload), "base64");
}

export function safeEqualHex(left: string, right: string): boolean {
  if (
    !/^[a-f0-9]+$/iu.test(left) ||
    !/^[a-f0-9]+$/iu.test(right) ||
    left.length % 2 !== 0 ||
    right.length % 2 !== 0
  ) {
    return false;
  }

  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return getCryptoProvider().timingSafeEqual(leftBuffer, rightBuffer);
}

export function safeEqualText(left: string, right: string): boolean {
  return getCryptoProvider().timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

export function parseJsonPayload(payload: RawWebhookBody): JsonObject {
  const parsed: unknown = JSON.parse(toBuffer(payload).toString("utf8"));
  if (!isJsonObject(parsed)) {
    throw new Error("Webhook payload must be a JSON object.");
  }

  return parsed;
}

export function normalizeTimestamp(value: Date | number): number {
  const timestamp = value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  return timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);
}

export function stringField(object: JsonObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(object: JsonObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === "number" ? value : undefined;
}

export function booleanField(object: JsonObject, key: string): boolean | undefined {
  const value = object[key];
  return typeof value === "boolean" ? value : undefined;
}

export function objectField(object: JsonObject, key: string): JsonObject | undefined {
  const value = object[key];
  return isJsonObject(value) ? value : undefined;
}

export function arrayField(object: JsonObject, key: string): readonly JsonValue[] | undefined {
  const value = object[key];
  return Array.isArray(value) ? value : undefined;
}

export function nestedStringField(object: JsonObject, path: readonly string[]): string | undefined {
  let current: JsonObject | undefined = object;
  for (const [index, segment] of path.entries()) {
    if (current === undefined) {
      return undefined;
    }
    if (index === path.length - 1) {
      return stringField(current, segment);
    }
    current = objectField(current, segment);
  }

  return undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}

function toBuffer(payload: RawWebhookBody): Buffer {
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}
