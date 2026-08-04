import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  LLMProviderCapability,
  ModelInfo,
} from "@helix/sdk-types";
import {
  approximateTokenCount,
  arrayField,
  assertRecord,
  chatResponse,
  firstRecord,
  joinUrl,
  modelForRequest,
  normalizeFetchConfig,
  openAIChatChunks,
  openAIMessage,
  postJson,
  postSse,
  stringField,
  toolCallsFromOpenAIMessage,
  usageFromOpenAI,
  type ProviderRequestConfig,
} from "./shared.js";

export interface OpenAICompatibleProviderConfig {
  readonly id: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly models: readonly ModelInfo[];
  readonly defaultModel?: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleProviderConfig,
): LLMProviderCapability {
  return new OpenAICompatibleProvider(config);
}

class OpenAICompatibleProvider implements LLMProviderCapability {
  readonly id: string;
  readonly protocol = "openai-compatible" as const;

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #models: readonly ModelInfo[];
  readonly #defaultModel: string;
  readonly #headers: Record<string, string> | undefined;

  constructor(config: OpenAICompatibleProviderConfig) {
    const normalized = normalizeFetchConfig(config);
    this.id = config.id;
    this.#baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.#apiKey = config.apiKey;
    this.#fetch = normalized.fetch;
    this.#models = normalized.models;
    this.#defaultModel = normalized.defaultModel;
    this.#headers = config.headers;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const model = modelForRequest(req.model, this.#defaultModel);
    const payload = await postJson(
      joinUrl(this.#baseUrl, "chat/completions"),
      {
        model,
        messages: req.messages.map((message) => openAIMessage(message)),
        stream: false,
      },
      this.#requestConfig(),
    );

    return openAIChatResponse(payload, this.id, model);
  }

  async *chatStream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const model = modelForRequest(req.model, this.#defaultModel);
    const events = await postSse(
      joinUrl(this.#baseUrl, "chat/completions"),
      {
        model,
        messages: req.messages.map((message) => openAIMessage(message)),
        stream: true,
        stream_options: { include_usage: true },
      },
      this.#requestConfig(),
    );
    yield* openAIChatChunks(events, model);
  }

  #requestConfig(): ProviderRequestConfig {
    return {
      fetch: this.#fetch,
      ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
      ...(this.#headers === undefined ? {} : { headers: this.#headers }),
    };
  }

  async models(): Promise<readonly ModelInfo[]> {
    return this.#models;
  }

  async countTokens(text: string): Promise<number> {
    return approximateTokenCount(text);
  }
}

function openAIChatResponse(
  payload: unknown,
  providerId: string,
  fallbackModel: string,
): ChatResponse {
  const record = assertRecord(payload, "OpenAI-compatible chat response");
  const choice = firstRecord(arrayField(record, "choices"));
  const message = choice === undefined ? undefined : firstRecord([choice.message]);
  const content = message === undefined ? "" : (stringField(message, "content") ?? "");
  const model = stringField(record, "model") ?? fallbackModel;
  return chatResponse({
    message: content,
    model,
    providerId,
    usage: usageFromOpenAI(record.usage),
    toolCalls: message === undefined ? undefined : toolCallsFromOpenAIMessage(message),
    responseId: stringField(record, "id"),
  });
}
