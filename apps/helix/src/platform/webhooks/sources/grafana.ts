import type {
  InboundSourceAdapter,
  JsonObject,
  RawWebhookBody,
  VerifySourceSignatureOptions,
  WebhookHeaders,
} from "./common.js";
import {
  arrayField,
  getHeader,
  hmacSha256Base64,
  hmacSha256Hex,
  numberField,
  objectField,
  parseJsonPayload,
  safeEqualText,
  stringField,
} from "./common.js";

export interface ParsedGrafanaWebhook {
  readonly sourceType: "grafana";
  readonly event: string;
  readonly receiver?: string;
  readonly status?: string;
  readonly orgId?: number;
  readonly alertCount?: number;
  readonly groupLabels?: JsonObject;
  readonly commonLabels?: JsonObject;
  readonly title?: string;
  readonly message?: string;
  readonly payload: JsonObject;
}

export const grafanaWebhookSource: InboundSourceAdapter<ParsedGrafanaWebhook> = {
  sourceType: "grafana",
  verify: verifyGrafanaWebhookSignature,
  parse: parseGrafanaWebhook,
};

export function verifyGrafanaWebhookSignature(options: VerifySourceSignatureOptions): boolean {
  if (verifyGrafanaHmacSignature(options)) {
    return true;
  }

  const bearer = bearerToken(options.headers);
  const token =
    options.header ??
    bearer ??
    getHeader(options.headers, "x-grafana-webhook-secret") ??
    getHeader(options.headers, "x-helix-webhook-token");
  return token !== undefined && token.length > 0 && safeEqualText(token, options.secret);
}

export function parseGrafanaWebhook(options: {
  readonly payload: RawWebhookBody;
  readonly headers?: WebhookHeaders;
}): ParsedGrafanaWebhook {
  const payload = parseJsonPayload(options.payload);
  const status = stringField(payload, "status") ?? stringField(payload, "state");
  const event = status === undefined || status.length === 0 ? "alert" : `alert.${status}`;
  const alerts = arrayField(payload, "alerts");
  const receiver = stringField(payload, "receiver");
  const orgId = numberField(payload, "orgId");
  const groupLabels = objectField(payload, "groupLabels");
  const commonLabels = objectField(payload, "commonLabels");
  const title = stringField(payload, "title");
  const message = stringField(payload, "message");
  return {
    sourceType: "grafana",
    event,
    ...(receiver === undefined ? {} : { receiver }),
    ...(status === undefined ? {} : { status }),
    ...(orgId === undefined ? {} : { orgId }),
    ...(alerts === undefined ? {} : { alertCount: alerts.length }),
    ...(groupLabels === undefined ? {} : { groupLabels }),
    ...(commonLabels === undefined ? {} : { commonLabels }),
    ...(title === undefined ? {} : { title }),
    ...(message === undefined ? {} : { message }),
    payload,
  };
}

function bearerToken(headers: WebhookHeaders | undefined): string | undefined {
  const authorization = getHeader(headers, "authorization");
  if (authorization === undefined) {
    return undefined;
  }
  const match = /^bearer\s+(.+)$/iu.exec(authorization);
  return match?.[1]?.trim();
}

function verifyGrafanaHmacSignature(options: VerifySourceSignatureOptions): boolean {
  const header = options.header ?? getHeader(options.headers, "x-grafana-alerting-signature");
  if (header === undefined || header.length === 0) {
    return false;
  }

  const timestamp = getHeader(options.headers, "x-grafana-alerting-timestamp");
  const body = Buffer.isBuffer(options.payload)
    ? options.payload.toString("utf8")
    : Buffer.from(options.payload).toString("utf8");
  const signedPayload = timestamp === undefined ? body : `${timestamp}:${body}`;
  const expectedHex = hmacSha256Hex(options.secret, signedPayload);
  const expectedBase64 = hmacSha256Base64(options.secret, signedPayload);
  const signature = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  return safeEqualText(signature, expectedHex) || safeEqualText(signature, expectedBase64);
}
