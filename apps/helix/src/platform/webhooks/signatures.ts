import { getCryptoProvider } from "../crypto/index.js";

export const WEBHOOK_SIGNATURE_VERSION = "v1";

export interface WebhookSignature {
  readonly timestamp: number;
  readonly signature: string;
  readonly header: string;
}

export interface SignWebhookPayloadOptions {
  readonly payload: Buffer | Uint8Array | string;
  readonly secret: string;
  readonly timestamp?: Date | number;
}

export interface VerifyWebhookSignatureOptions {
  readonly payload: Buffer | Uint8Array | string;
  readonly secret: string;
  readonly header: string;
  readonly toleranceSeconds?: number;
  readonly now?: Date | number;
}

export function signWebhookPayload(options: SignWebhookPayloadOptions): WebhookSignature {
  const timestamp = normalizeTimestamp(options.timestamp ?? Date.now());
  const signature = computeSignature(options.secret, timestamp, options.payload);

  return {
    timestamp,
    signature,
    header: ["t=", String(timestamp), ",", WEBHOOK_SIGNATURE_VERSION, "=", signature].join(""),
  };
}

export function verifyWebhookSignature(options: VerifyWebhookSignatureOptions): boolean {
  const parsed = parseWebhookSignatureHeader(options.header);
  if (parsed === undefined) {
    return false;
  }

  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (toleranceSeconds >= 0) {
    const now = normalizeTimestamp(options.now ?? Date.now());
    if (Math.abs(now - parsed.timestamp) > toleranceSeconds) {
      return false;
    }
  }

  const expected = computeSignature(options.secret, parsed.timestamp, options.payload);
  return safeEqualHex(parsed.signature, expected);
}

export function parseWebhookSignatureHeader(
  header: string,
): { readonly timestamp: number; readonly signature: string } | undefined {
  const values = new Map<string, string>();
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === undefined || value === undefined) {
      continue;
    }
    values.set(key.trim(), value.trim());
  }

  const timestampValue = values.get("t");
  const signature = values.get(WEBHOOK_SIGNATURE_VERSION);
  if (timestampValue === undefined || signature === undefined || !/^[a-f0-9]{64}$/u.test(signature)) {
    return undefined;
  }

  const timestamp = Number(timestampValue);
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    return undefined;
  }

  return { timestamp, signature };
}

function computeSignature(secret: string, timestamp: number, payload: Buffer | Uint8Array | string): string {
  // HMAC-SHA-256 via the crypto adapter (PRD §14.4). The signed message is the
  // timestamp, a literal ".", then the payload — concatenated into one buffer
  // so the result is byte-identical to the previous streaming `.update()` form.
  const prefix = Buffer.from(`${String(timestamp)}.`, "utf8");
  const message = Buffer.concat([prefix, toBufferStrict(payload)]);
  return getCryptoProvider().hmac("sha256", secret, message, "hex");
}

function normalizeTimestamp(value: Date | number): number {
  const timestamp = value instanceof Date ? Math.floor(value.getTime() / 1000) : value;
  return timestamp > 1_000_000_000_000 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);
}

function safeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return getCryptoProvider().timingSafeEqual(leftBuffer, rightBuffer);
}

function toBufferStrict(payload: Buffer | Uint8Array | string): Buffer {
  if (typeof payload === "string") {
    return Buffer.from(payload, "utf8");
  }
  return Buffer.from(payload);
}
