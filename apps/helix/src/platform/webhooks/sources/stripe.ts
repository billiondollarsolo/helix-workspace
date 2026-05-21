import type {
  InboundSourceAdapter,
  JsonObject,
  RawWebhookBody,
  VerifySourceSignatureOptions,
  WebhookHeaders,
} from "./common.js";
import {
  booleanField,
  getHeader,
  hmacSha256Hex,
  normalizeTimestamp,
  numberField,
  objectField,
  parseJsonPayload,
  safeEqualHex,
  stringField,
} from "./common.js";

export interface ParsedStripeSignatureHeader {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

export interface ParsedStripeWebhook {
  readonly sourceType: "stripe";
  readonly id?: string;
  readonly event: string;
  readonly created?: number;
  readonly livemode?: boolean;
  readonly object?: JsonObject;
  readonly payload: JsonObject;
}

export const stripeWebhookSource: InboundSourceAdapter<ParsedStripeWebhook> = {
  sourceType: "stripe",
  verify: verifyStripeWebhookSignature,
  parse: parseStripeWebhook,
};

export function verifyStripeWebhookSignature(options: VerifySourceSignatureOptions): boolean {
  const header = options.header ?? getHeader(options.headers, "stripe-signature");
  const parsed = header === undefined ? undefined : parseStripeSignatureHeader(header);
  if (parsed === undefined || parsed.signatures.length === 0) {
    return false;
  }

  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (toleranceSeconds >= 0) {
    const now = normalizeTimestamp(options.now ?? Date.now());
    if (Math.abs(now - parsed.timestamp) > toleranceSeconds) {
      return false;
    }
  }

  const expected = hmacSha256Hex(
    options.secret,
    `${String(parsed.timestamp)}.${payloadToString(options.payload)}`,
  );
  return parsed.signatures.some((signature) => safeEqualHex(signature, expected));
}

export function parseStripeSignatureHeader(
  header: string,
): ParsedStripeSignatureHeader | undefined {
  const values = header.split(",").map((part) => {
    const [key, value] = part.split("=", 2);
    return key === undefined || value === undefined
      ? undefined
      : ([key.trim(), value.trim()] as const);
  });
  const timestampValue = values.find((value) => value?.[0] === "t")?.[1];
  if (timestampValue === undefined) {
    return undefined;
  }

  const timestamp = Number(timestampValue);
  if (!Number.isInteger(timestamp) || timestamp < 0) {
    return undefined;
  }

  const signatures = values
    .filter(
      (value): value is readonly ["v1", string] =>
        value?.[0] === "v1" && /^[a-f0-9]{64}$/iu.test(value[1]),
    )
    .map(([, signature]) => signature);

  return { timestamp, signatures };
}

export function parseStripeWebhook(options: {
  readonly payload: RawWebhookBody;
  readonly headers?: WebhookHeaders;
}): ParsedStripeWebhook {
  const payload = parseJsonPayload(options.payload);
  const event = stringField(payload, "type");
  if (event === undefined || event.length === 0) {
    throw new Error("Stripe webhook payload is missing type.");
  }

  const id = stringField(payload, "id");
  const created = numberField(payload, "created");
  const livemode = booleanField(payload, "livemode");
  const stripeObject = objectField(objectField(payload, "data") ?? {}, "object");
  return {
    sourceType: "stripe",
    event,
    ...(id === undefined ? {} : { id }),
    ...(created === undefined ? {} : { created }),
    ...(livemode === undefined ? {} : { livemode }),
    ...(stripeObject === undefined ? {} : { object: stripeObject }),
    payload,
  };
}

function payloadToString(payload: RawWebhookBody): string {
  return Buffer.isBuffer(payload)
    ? payload.toString("utf8")
    : Buffer.from(payload).toString("utf8");
}
