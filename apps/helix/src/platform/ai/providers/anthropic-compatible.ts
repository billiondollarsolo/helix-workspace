import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LLMProviderCapability,
  ModelInfo,
} from "@helix/sdk-types";
import {
  anthropicChatChunks,
  anthropicRequestBody,
  approximateTokenCount,
  arrayField,
  assertRecord,
  chatResponse,
  joinUrl,
  modelForRequest,
  normalizeFetchConfig,
  postJson,
  postSse,
  stringField,
  textFromAnthropicContent,
  toolCallsFromAnthropicContent,
  usageFromAnthropic,
  type ProviderRequestConfig,
} from "./shared.js";

export interface AnthropicCompatibleProviderConfig {
  readonly id: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly models: readonly ModelInfo[];
  readonly defaultModel?: string;
  readonly anthropicVersion?: string;
  readonly betaHeaders?: readonly string[];
  readonly maxTokens?: number;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export function createAnthropicCompatibleProvider(
  config: AnthropicCompatibleProviderConfig,
): LLMProviderCapability {
  return new AnthropicCompatibleProvider(config);
}

class AnthropicCompatibleProvider implements LLMProviderCapability {
  readonly id: string;
  readonly protocol = "anthropic-compatible" as const;

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #models: readonly ModelInfo[];
  readonly #defaultModel: string;
  readonly #anthropicVersion: string;
  readonly #betaHeaders: readonly string[];
  readonly #maxTokens: number;
  readonly #headers: Record<string, string> | undefined;

  constructor(config: AnthropicCompatibleProviderConfig) {
    const normalized = normalizeFetchConfig(config);
    this.id = config.id;
    this.#baseUrl = config.baseUrl ?? "https://api.anthropic.com/v1";
    this.#apiKey = config.apiKey;
    this.#fetch = normalized.fetch;
    this.#models = normalized.models;
    this.#defaultModel = normalized.defaultModel;
    this.#anthropicVersion = config.anthropicVersion ?? "2023-06-01";
    this.#betaHeaders = config.betaHeaders ?? [];
    this.#maxTokens = config.maxTokens ?? 1024;
    this.#headers = config.headers;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = modelForRequest(req.model, this.#defaultModel);
    const payload = await postJson(
      joinUrl(this.#baseUrl, "messages"),
      anthropicRequestBody(model, req.messages, this.#maxTokens, this.#anthropicVersion),
      this.#requestConfig(),
    );

    return anthropicChatResponse(payload, this.id, model);
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = modelForRequest(req.model, this.#defaultModel);
    const events = await postSse(
      joinUrl(this.#baseUrl, "messages"),
      {
        ...anthropicRequestBody(model, req.messages, this.#maxTokens, this.#anthropicVersion),
        stream: true,
      },
      this.#requestConfig(),
    );
    yield* anthropicChatChunks(events, model);
  }

  #requestConfig(): ProviderRequestConfig {
    return {
      fetch: this.#fetch,
      headers: {
        "anthropic-version": this.#anthropicVersion,
        ...(this.#apiKey === undefined || this.#apiKey.length === 0
          ? {}
          : { "x-api-key": this.#apiKey }),
        ...(this.#betaHeaders.length === 0
          ? {}
          : { "anthropic-beta": this.#betaHeaders.join(",") }),
        ...(this.#headers ?? {}),
      },
    };
  }

  async models(): Promise<readonly ModelInfo[]> {
    return this.#models;
  }

  async countTokens(text: string): Promise<number> {
    return approximateTokenCount(text);
  }
}

export function anthropicChatResponse(
  payload: unknown,
  providerId: string,
  fallbackModel: string,
): ChatResponse {
  const record = assertRecord(payload, "Anthropic-compatible chat response");
  const content = arrayField(record, "content");
  const model = stringField(record, "model") ?? fallbackModel;
  return chatResponse({
    message: textFromAnthropicContent(content),
    model,
    providerId,
    usage: usageFromAnthropic(record.usage),
    toolCalls: toolCallsFromAnthropicContent(content),
    responseId: stringField(record, "id"),
  });
}
