import { getCryptoProvider } from "../../crypto/index.js";
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
  nestedStringField,
  parseJsonPayload,
  payloadToString,
  safeEqualText,
  stringField,
} from "./common.js";

export interface ParsedGitLabWebhook {
  readonly sourceType: "gitlab";
  readonly event: string;
  readonly deliveryId?: string;
  readonly objectKind?: string;
  readonly projectPath?: string;
  readonly ref?: string;
  readonly commitCount?: number;
  readonly payload: JsonObject;
}

export const gitlabWebhookSource: InboundSourceAdapter<ParsedGitLabWebhook> = {
  sourceType: "gitlab",
  verify: verifyGitLabWebhookSignature,
  parse: parseGitLabWebhook,
};

export function verifyGitLabWebhookSignature(options: VerifySourceSignatureOptions): boolean {
  if (verifyGitLabStandardWebhookSignature(options)) {
    return true;
  }

  const token = options.header ?? getHeader(options.headers, "x-gitlab-token");
  return token !== undefined && token.length > 0 && safeEqualText(token, options.secret);
}

export function parseGitLabWebhook(options: {
  readonly payload: RawWebhookBody;
  readonly headers?: WebhookHeaders;
}): ParsedGitLabWebhook {
  const payload = parseJsonPayload(options.payload);
  const event = getHeader(options.headers, "x-gitlab-event") ?? stringField(payload, "event_name");
  if (event === undefined || event.length === 0) {
    throw new Error("GitLab webhook is missing X-Gitlab-Event.");
  }

  const commits = arrayField(payload, "commits");
  const deliveryId = getHeader(options.headers, "x-gitlab-event-uuid");
  const objectKind = stringField(payload, "object_kind");
  const projectPath =
    nestedStringField(payload, ["project", "path_with_namespace"]) ??
    nestedStringField(payload, ["repository", "name"]);
  const ref = stringField(payload, "ref");
  return {
    sourceType: "gitlab",
    event,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(objectKind === undefined ? {} : { objectKind }),
    ...(projectPath === undefined ? {} : { projectPath }),
    ...(ref === undefined ? {} : { ref }),
    ...(commits === undefined ? {} : { commitCount: commits.length }),
    payload,
  };
}

function verifyGitLabStandardWebhookSignature(options: VerifySourceSignatureOptions): boolean {
  const messageId = getHeader(options.headers, "webhook-id");
  const timestamp = getHeader(options.headers, "webhook-timestamp");
  const header = getHeader(options.headers, "webhook-signature");
  if (
    messageId === undefined ||
    timestamp === undefined ||
    header === undefined ||
    !header.startsWith("v1,")
  ) {
    return false;
  }

  const signature = header.slice("v1,".length);
  if (signature.length === 0) {
    return false;
  }

  const signingSecret = gitLabSigningSecret(options.secret);
  const signedPayload = `${messageId}.${timestamp}.${payloadToString(options.payload)}`;
  const expected = getCryptoProvider().hmac("sha256", signingSecret, signedPayload, "base64");
  return safeEqualText(signature, expected);
}

function gitLabSigningSecret(secret: string): Buffer | string {
  if (!secret.startsWith("whsec_")) {
    return secret;
  }

  const encoded = secret.slice("whsec_".length);
  try {
    return Buffer.from(encoded, "base64url");
  } catch {
    return secret;
  }
}
