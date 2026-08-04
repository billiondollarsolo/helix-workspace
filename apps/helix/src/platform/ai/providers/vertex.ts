import { createSign } from "node:crypto";
import type { ChatRequest, ChatResponse, LLMProviderCapability, ModelInfo } from "@helix/sdk-types";
import { anthropicChatResponse } from "./anthropic-compatible.js";
import { joinPaths } from "./url-path.js";
import {
  anthropicRequestBody,
  approximateTokenCount,
  modelForRequest,
  normalizeFetchConfig,
  safeResponseText,
} from "./shared.js";

/**
 * Vertex AI service-account credentials.
 *
 * - `accessToken`: a pre-minted OAuth2 access token (used as-is).
 * - service account: `clientEmail` + `privateKey`. The provider signs a JWT
 *   assertion and exchanges it at `tokenUri` for a short-lived access token.
 *   This is the proper GCP OAuth2 "JWT bearer" flow — the signed JWT is *not*
 *   a valid bearer token on its own and real Vertex rejects it.
 */
export type VertexCredentials =
  | {
      readonly accessToken: string;
    }
  | {
      readonly clientEmail: string;
      readonly privateKey: string;
      readonly tokenUri?: string;
      readonly scope?: string;
    };

export interface VertexProviderConfig {
  readonly id: string;
  readonly project: string;
  readonly location: string;
  readonly credentials: VertexCredentials;
  readonly models: readonly ModelInfo[];
  readonly defaultModel?: string;
  readonly endpoint?: string;
  readonly anthropicVersion?: string;
  readonly maxTokens?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_LIFETIME_SECONDS = 3600;
/** Refresh the cached token this many seconds before its real expiry. */
const TOKEN_EXPIRY_SKEW_SECONDS = 120;

export function createVertexProvider(config: VertexProviderConfig): LLMProviderCapability {
  return new VertexProvider(config);
}

interface CachedAccessToken {
  readonly token: string;
  /** Epoch millis after which the token must be refreshed. */
  readonly refreshAfterMs: number;
}

class VertexProvider implements LLMProviderCapability {
  readonly id: string;
  readonly protocol = "vertex" as const;

  readonly #project: string;
  readonly #location: string;
  readonly #credentials: VertexCredentials;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #models: readonly ModelInfo[];
  readonly #defaultModel: string;
  readonly #anthropicVersion: string;
  readonly #maxTokens: number;
  readonly #now: () => Date;

  #cachedToken: CachedAccessToken | undefined;
  /** In-flight token exchange, deduplicates concurrent refreshes. */
  #pendingToken: Promise<string> | undefined;

  constructor(config: VertexProviderConfig) {
    if (config.project.length === 0 || config.location.length === 0) {
      throw new TypeError("Vertex provider project and location are required");
    }
    const normalized = normalizeFetchConfig(config);
    this.id = config.id;
    this.#project = config.project;
    this.#location = config.location;
    this.#credentials = config.credentials;
    this.#endpoint = config.endpoint ?? `https://${config.location}-aiplatform.googleapis.com`;
    this.#fetch = normalized.fetch;
    this.#models = normalized.models;
    this.#defaultModel = normalized.defaultModel;
    this.#anthropicVersion = config.anthropicVersion ?? "vertex-2023-10-16";
    this.#maxTokens = config.maxTokens ?? 1024;
    this.#now = config.now ?? (() => new Date());
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = modelForRequest(req.model, this.#defaultModel);
    const body = JSON.stringify(
      anthropicRequestBody(model, req.messages, this.#maxTokens, this.#anthropicVersion),
    );
    const url = vertexRawPredictUrl({
      endpoint: this.#endpoint,
      project: this.#project,
      location: this.#location,
      model,
    });

    const accessToken = await this.#accessToken();
    const response = await this.#fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "x-goog-user-project": this.#project,
      },
      body,
    });
    if (!response.ok) {
      const responseText = await safeResponseText(response);
      throw new Error(
        `Vertex provider request failed: ${String(response.status)} ${response.statusText}${responseText.length === 0 ? "" : `: ${responseText}`}`,
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

  /**
   * Returns a valid OAuth2 access token. For static `accessToken`
   * credentials this is returned directly. For service-account credentials a
   * signed JWT assertion is exchanged at the token endpoint and the result is
   * cached until shortly before it expires.
   */
  async #accessToken(): Promise<string> {
    if ("accessToken" in this.#credentials) {
      return this.#credentials.accessToken;
    }

    const nowMs = this.#now().getTime();
    if (this.#cachedToken !== undefined && nowMs < this.#cachedToken.refreshAfterMs) {
      return this.#cachedToken.token;
    }
    if (this.#pendingToken !== undefined) {
      return this.#pendingToken;
    }

    const credentials = this.#credentials;
    this.#pendingToken = this.#exchangeToken(credentials)
      .then((cached) => {
        this.#cachedToken = cached;
        return cached.token;
      })
      .finally(() => {
        this.#pendingToken = undefined;
      });
    return this.#pendingToken;
  }

  async #exchangeToken(
    credentials: Extract<VertexCredentials, { readonly clientEmail: string }>,
  ): Promise<CachedAccessToken> {
    const tokenUri = credentials.tokenUri ?? DEFAULT_TOKEN_URI;
    const assertion = signServiceAccountJwt({
      clientEmail: credentials.clientEmail,
      privateKey: credentials.privateKey,
      scope: credentials.scope ?? DEFAULT_SCOPE,
      tokenUri,
      issuedAt: this.#now(),
    });

    const response = await this.#fetch(new URL(tokenUri), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    if (!response.ok) {
      const responseText = await safeResponseText(response);
      throw new Error(
        `Vertex token exchange failed: ${String(response.status)} ${response.statusText}${responseText.length === 0 ? "" : `: ${responseText}`}`,
      );
    }

    const payload: unknown = await response.json();
    const token = parseTokenResponse(payload);
    const refreshAfterMs =
      this.#now().getTime() +
      Math.max(token.expiresInSeconds - TOKEN_EXPIRY_SKEW_SECONDS, 1) * 1000;
    return { token: token.accessToken, refreshAfterMs };
  }
}

export interface VertexRawPredictUrlInput {
  readonly endpoint: string;
  readonly project: string;
  readonly location: string;
  readonly model: string;
}

export function vertexRawPredictUrl(input: VertexRawPredictUrlInput): URL {
  const url = new URL(input.endpoint);
  url.pathname = joinPaths(
    url.pathname,
    "v1",
    "projects",
    encodeURIComponent(input.project),
    "locations",
    encodeURIComponent(input.location),
    "publishers",
    "anthropic",
    "models",
    `${encodeURIComponent(input.model)}:rawPredict`,
  );
  url.search = "";
  return url;
}

export interface VertexJwtAssertionInput {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly scope: string;
  readonly tokenUri: string;
  readonly issuedAt: Date;
}

/**
 * Signs the RS256 JWT assertion used in the GCP service-account OAuth2 flow.
 * The returned value is the JWT *assertion* — it must still be exchanged at
 * the token endpoint for an access token before it can authorize API calls.
 */
export function signServiceAccountJwt(input: VertexJwtAssertionInput): string {
  const issuedAt = Math.floor(input.issuedAt.getTime() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: input.clientEmail,
    sub: input.clientEmail,
    aud: input.tokenUri,
    scope: input.scope,
    iat: issuedAt,
    exp: issuedAt + TOKEN_LIFETIME_SECONDS,
  });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(input.privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

export interface VertexTokenResponse {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

export function parseTokenResponse(payload: unknown): VertexTokenResponse {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Vertex token exchange returned a malformed response");
  }
  const record = payload as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Vertex token exchange response is missing access_token");
  }
  const expiresIn = record.expires_in;
  const expiresInSeconds =
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? expiresIn
      : TOKEN_LIFETIME_SECONDS;
  return { accessToken, expiresInSeconds };
}

function base64UrlJson(value: Record<string, string | number>): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}
