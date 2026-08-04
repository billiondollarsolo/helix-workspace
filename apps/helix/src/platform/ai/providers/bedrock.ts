import { createHash, createHmac } from "node:crypto";
import type { ChatRequest, ChatResponse, LLMProviderCapability, ModelInfo } from "@helix/sdk-types";
import { anthropicChatResponse } from "./anthropic-compatible.js";
import { joinPaths } from "./url-path.js";
import {
  resolveAwsCredentials,
  type AwsCredentialResolverOptions,
  type AwsCredentials,
} from "./aws-credentials.js";
import {
  anthropicRequestBody,
  approximateTokenCount,
  modelForRequest,
  normalizeFetchConfig,
  safeResponseText,
} from "./shared.js";

/** Resolved SigV4 credentials used to sign a single Bedrock request. */
export interface BedrockCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

/**
 * Bedrock credentials may be supplied as a fixed credential object or as an
 * async provider. The async form supports IAM role / instance profile /
 * `AWS_PROFILE` / environment-variable resolution; temporary credentials are
 * re-resolved before they expire.
 */
export type BedrockCredentialSource = BedrockCredentials | (() => Promise<BedrockCredentials>);

export interface BedrockProviderConfig {
  readonly id: string;
  readonly region: string;
  readonly credentials: BedrockCredentialSource;
  readonly models: readonly ModelInfo[];
  readonly defaultModel?: string;
  readonly endpoint?: string;
  readonly anthropicVersion?: string;
  readonly maxTokens?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

/**
 * Builds a Bedrock credential provider that resolves AWS credentials through
 * the standard precedence chain (static → env → profile → instance profile).
 * Credentials are cached and refreshed periodically so temporary credentials
 * from an instance profile do not go stale.
 */
export function createBedrockCredentialProvider(
  options: AwsCredentialResolverOptions = {},
  refreshIntervalMs = 5 * 60_000,
): () => Promise<BedrockCredentials> {
  let cached: { readonly credentials: AwsCredentials; readonly resolvedAtMs: number } | undefined;
  let pending: Promise<AwsCredentials> | undefined;
  return async () => {
    const nowMs = Date.now();
    if (cached !== undefined && nowMs - cached.resolvedAtMs < refreshIntervalMs) {
      return cached.credentials;
    }
    if (pending === undefined) {
      pending = resolveAwsCredentials(options)
        .then((credentials) => {
          cached = { credentials, resolvedAtMs: Date.now() };
          return credentials;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
}

export function createBedrockProvider(config: BedrockProviderConfig): LLMProviderCapability {
  return new BedrockProvider(config);
}

class BedrockProvider implements LLMProviderCapability {
  readonly id: string;
  readonly protocol = "bedrock" as const;

  readonly #region: string;
  readonly #credentials: () => Promise<BedrockCredentials>;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #models: readonly ModelInfo[];
  readonly #defaultModel: string;
  readonly #anthropicVersion: string;
  readonly #maxTokens: number;
  readonly #now: () => Date;

  constructor(config: BedrockProviderConfig) {
    if (config.region.length === 0) {
      throw new TypeError("Bedrock provider region is required");
    }

    const credentialSource = config.credentials;
    if (typeof credentialSource === "function") {
      this.#credentials = credentialSource;
    } else {
      if (
        credentialSource.accessKeyId.length === 0 ||
        credentialSource.secretAccessKey.length === 0
      ) {
        throw new TypeError("Bedrock provider credentials are required");
      }
      this.#credentials = () => Promise.resolve(credentialSource);
    }

    const normalized = normalizeFetchConfig(config);
    this.id = config.id;
    this.#region = config.region;
    this.#endpoint = config.endpoint ?? `https://bedrock-runtime.${config.region}.amazonaws.com`;
    this.#fetch = normalized.fetch;
    this.#models = normalized.models;
    this.#defaultModel = normalized.defaultModel;
    this.#anthropicVersion = config.anthropicVersion ?? "bedrock-2023-05-31";
    this.#maxTokens = config.maxTokens ?? 1024;
    this.#now = config.now ?? (() => new Date());
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = modelForRequest(req.model, this.#defaultModel);
    const body = JSON.stringify(
      anthropicRequestBody(model, req.messages, this.#maxTokens, this.#anthropicVersion),
    );
    const url = bedrockInvokeUrl(this.#endpoint, model);
    const date = this.#now();
    const credentials = await this.#credentials();
    if (credentials.accessKeyId.length === 0 || credentials.secretAccessKey.length === 0) {
      throw new TypeError("Bedrock provider resolved empty AWS credentials");
    }
    const headers = signedBedrockHeaders({
      url,
      body,
      date,
      region: this.#region,
      credentials,
    });

    const response = await this.#fetch(url, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      const responseText = await safeResponseText(response);
      throw new Error(
        `Bedrock provider request failed: ${String(response.status)} ${response.statusText}${responseText.length === 0 ? "" : `: ${responseText}`}`,
      );
    }

    const payload: unknown = await response.json();
    return anthropicChatResponse(payload, this.id, model);
  }

  async models(): Promise<readonly ModelInfo[]> {
    return this.#models;
  }

  async countTokens(text: string): Promise<number> {
    return approximateTokenCount(text);
  }
}

interface BedrockSigningInput {
  readonly url: URL;
  readonly body: string;
  readonly date: Date;
  readonly region: string;
  readonly credentials: BedrockCredentials;
}

export function bedrockInvokeUrl(endpoint: string, model: string): URL {
  const url = new URL(endpoint);
  url.pathname = joinPaths(url.pathname, "model", encodeRfc3986(model), "invoke");
  url.search = "";
  return url;
}

export function signedBedrockHeaders(input: BedrockSigningInput): Record<string, string> {
  const payloadHash = hashHex(input.body);
  const headers = normalizeHeaders({
    accept: "application/json",
    "content-type": "application/json",
    host: input.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate(input.date),
    ...(input.credentials.sessionToken === undefined
      ? {}
      : { "x-amz-security-token": input.credentials.sessionToken }),
  });
  const canonicalRequest = createCanonicalRequest(
    "POST",
    input.url.pathname,
    "",
    headers,
    payloadHash,
  );
  headers.authorization = authorizationHeader(input, headers, canonicalRequest);
  return headers;
}

function createCanonicalRequest(
  method: string,
  canonicalUri: string,
  canonicalQuery: string,
  headers: Record<string, string>,
  payloadHash: string,
): string {
  return [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders(headers),
    signedHeaderNames(headers),
    payloadHash,
  ].join("\n");
}

function authorizationHeader(
  input: BedrockSigningInput,
  headers: Record<string, string>,
  canonicalRequest: string,
): string {
  return [
    `${signingAlgorithm} Credential=${input.credentials.accessKeyId}/${credentialScope(input.region, input.date)}`,
    `SignedHeaders=${signedHeaderNames(headers)}`,
    `Signature=${requestSignature(input, canonicalRequest)}`,
  ].join(", ");
}

function requestSignature(input: BedrockSigningInput, canonicalRequest: string): string {
  return hmacHex(
    signingKey(input.credentials.secretAccessKey, input.region, input.date),
    stringToSign(input, canonicalRequest),
  );
}

function stringToSign(input: BedrockSigningInput, canonicalRequest: string): string {
  return [
    signingAlgorithm,
    amzDate(input.date),
    credentialScope(input.region, input.date),
    hashHex(canonicalRequest),
  ].join("\n");
}

function signingKey(secretAccessKey: string, region: string, date: Date): Uint8Array {
  const dateKey = hmac(`AWS4${secretAccessKey}`, shortDate(date));
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, bedrockService);
  return hmac(serviceKey, "aws4_request");
}

function credentialScope(region: string, date: Date): string {
  return `${shortDate(date)}/${region}/${bedrockService}/aws4_request`;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value.trim().replace(/\s+/gu, " ");
  }
  return normalized;
}

function canonicalHeaders(headers: Record<string, string>): string {
  return Object.keys(headers)
    .sort()
    .map((name) => `${name}:${headers[name] ?? ""}\n`)
    .join("");
}

function signedHeaderNames(headers: Record<string, string>): string {
  return Object.keys(headers).sort().join(";");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/gu, "");
}

function shortDate(date: Date): string {
  return amzDate(date).slice(0, 8);
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Uint8Array, value: string): Uint8Array {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Uint8Array, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

const signingAlgorithm = "AWS4-HMAC-SHA256";
const bedrockService = "bedrock";
