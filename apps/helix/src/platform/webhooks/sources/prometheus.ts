import type {
  InboundSourceAdapter,
  JsonObject,
  RawWebhookBody,
  VerifySourceSignatureOptions,
  WebhookHeaders,
} from "./common.js";
import {
  arrayField,
  bearerToken,
  getHeader,
  numberField,
  objectField,
  parseJsonPayload,
  safeEqualText,
  stringField,
} from "./common.js";

export interface ParsedPrometheusWebhook {
  readonly sourceType: "prometheus";
  readonly event: string;
  readonly receiver?: string;
  readonly status?: string;
  readonly groupKey?: string;
  readonly externalUrl?: string;
  readonly truncatedAlerts?: number;
  readonly alertCount?: number;
  readonly groupLabels?: JsonObject;
  readonly commonLabels?: JsonObject;
  readonly payload: JsonObject;
}

export const prometheusWebhookSource: InboundSourceAdapter<ParsedPrometheusWebhook> = {
  sourceType: "prometheus",
  verify: verifyPrometheusWebhookSignature,
  parse: parsePrometheusWebhook,
};

export function verifyPrometheusWebhookSignature(options: VerifySourceSignatureOptions): boolean {
  const bearer = bearerToken(options.headers);
  const token =
    options.header ??
    bearer ??
    getHeader(options.headers, "x-prometheus-alertmanager-token") ??
    getHeader(options.headers, "x-helix-webhook-token");
  return token !== undefined && token.length > 0 && safeEqualText(token, options.secret);
}

export function parsePrometheusWebhook(options: {
  readonly payload: RawWebhookBody;
  readonly headers?: WebhookHeaders;
}): ParsedPrometheusWebhook {
  const payload = parseJsonPayload(options.payload);
  const status = stringField(payload, "status");
  const event = status === undefined || status.length === 0 ? "alerts" : `alerts.${status}`;
  const alerts = arrayField(payload, "alerts");
  const receiver = stringField(payload, "receiver");
  const groupKey = stringField(payload, "groupKey");
  const externalUrl = stringField(payload, "externalURL");
  const truncatedAlerts = numberField(payload, "truncatedAlerts");
  const groupLabels = objectField(payload, "groupLabels");
  const commonLabels = objectField(payload, "commonLabels");
  return {
    sourceType: "prometheus",
    event,
    ...(receiver === undefined ? {} : { receiver }),
    ...(status === undefined ? {} : { status }),
    ...(groupKey === undefined ? {} : { groupKey }),
    ...(externalUrl === undefined ? {} : { externalUrl }),
    ...(truncatedAlerts === undefined ? {} : { truncatedAlerts }),
    ...(alerts === undefined ? {} : { alertCount: alerts.length }),
    ...(groupLabels === undefined ? {} : { groupLabels }),
    ...(commonLabels === undefined ? {} : { commonLabels }),
    payload,
  };
}
