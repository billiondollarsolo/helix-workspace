import type {
  InboundSourceAdapter,
  JsonObject,
  RawWebhookBody,
  VerifySourceSignatureOptions,
  WebhookHeaders,
} from "./common.js";
import {
  getHeader,
  hmacSha256Hex,
  objectField,
  parseJsonPayload,
  safeEqualHex,
  stringField,
} from "./common.js";

export interface ParsedLinearWebhook {
  readonly sourceType: "linear";
  readonly event: string;
  readonly action?: string;
  readonly organizationId?: string;
  readonly webhookId?: string;
  readonly data?: JsonObject;
  readonly url?: string;
  readonly payload: JsonObject;
}

export const linearWebhookSource: InboundSourceAdapter<ParsedLinearWebhook> = {
  sourceType: "linear",
  verify: verifyLinearWebhookSignature,
  parse: parseLinearWebhook,
};

export function verifyLinearWebhookSignature(options: VerifySourceSignatureOptions): boolean {
  const header = options.header ?? getHeader(options.headers, "linear-signature");
  if (header === undefined || !/^[a-f0-9]{64}$/iu.test(header)) {
    return false;
  }

  return safeEqualHex(header, hmacSha256Hex(options.secret, options.payload));
}

export function parseLinearWebhook(options: {
  readonly payload: RawWebhookBody;
  readonly headers?: WebhookHeaders;
}): ParsedLinearWebhook {
  const payload = parseJsonPayload(options.payload);
  const event = stringField(payload, "type");
  if (event === undefined || event.length === 0) {
    throw new Error("Linear webhook payload is missing type.");
  }

  const action = stringField(payload, "action");
  const organizationId = stringField(payload, "organizationId");
  const webhookId = stringField(payload, "webhookId");
  const data = objectField(payload, "data");
  const url = stringField(payload, "url");
  return {
    sourceType: "linear",
    event,
    ...(action === undefined ? {} : { action }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(webhookId === undefined ? {} : { webhookId }),
    ...(data === undefined ? {} : { data }),
    ...(url === undefined ? {} : { url }),
    payload,
  };
}
