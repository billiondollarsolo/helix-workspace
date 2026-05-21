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
  hmacSha256Hex,
  nestedStringField,
  objectField,
  parseJsonPayload,
  safeEqualHex,
  stringField,
} from "./common.js";

export interface ParsedGitHubWebhook {
  readonly sourceType: "github";
  readonly event: string;
  readonly deliveryId?: string;
  readonly action?: string;
  readonly repositoryFullName?: string;
  readonly ref?: string;
  readonly commitCount?: number;
  readonly payload: JsonObject;
}

export const githubWebhookSource: InboundSourceAdapter<ParsedGitHubWebhook> = {
  sourceType: "github",
  verify: verifyGitHubWebhookSignature,
  parse: parseGitHubWebhook,
};

export function verifyGitHubWebhookSignature(options: VerifySourceSignatureOptions): boolean {
  const header = options.header ?? getHeader(options.headers, "x-hub-signature-256");
  if (header === undefined || !header.startsWith("sha256=")) {
    return false;
  }

  const signature = header.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/iu.test(signature)) {
    return false;
  }

  return safeEqualHex(signature, hmacSha256Hex(options.secret, options.payload));
}

export function parseGitHubWebhook(options: {
  readonly payload: RawWebhookBody;
  readonly headers?: WebhookHeaders;
}): ParsedGitHubWebhook {
  const payload = parseJsonPayload(options.payload);
  const event = getHeader(options.headers, "x-github-event");
  if (event === undefined || event.length === 0) {
    throw new Error("GitHub webhook is missing X-GitHub-Event.");
  }

  const commits = arrayField(payload, "commits");
  const deliveryId = getHeader(options.headers, "x-github-delivery");
  const action = stringField(payload, "action");
  const repositoryFullName = nestedStringField(payload, ["repository", "full_name"]);
  const ref = stringField(payload, "ref");
  return {
    sourceType: "github",
    event,
    ...(deliveryId === undefined ? {} : { deliveryId }),
    ...(action === undefined ? {} : { action }),
    ...(repositoryFullName === undefined ? {} : { repositoryFullName }),
    ...(ref === undefined ? {} : { ref }),
    ...(commits === undefined ? {} : { commitCount: commits.length }),
    payload,
  };
}

export function summarizeGitHubWebhook(parsed: ParsedGitHubWebhook): string {
  const repository = parsed.repositoryFullName ?? "repository";
  if (parsed.event === "push") {
    return `GitHub push to ${repository}${parsed.ref === undefined ? "" : ` ${parsed.ref}`}: ${String(parsed.commitCount ?? 0)} commits`;
  }
  if (parsed.action !== undefined) {
    return `GitHub ${parsed.event}.${parsed.action} on ${repository}`;
  }
  return `GitHub ${parsed.event} on ${repository}`;
}

export function githubRepository(payload: JsonObject): JsonObject | undefined {
  return objectField(payload, "repository");
}
