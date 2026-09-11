import type {
  AIMessage,
  AIToolChoice,
  ChatChunk,
  ChatResponse,
  ChatUsage,
  JsonObject,
  ModelInfo,
} from "@helix/sdk-types";
import { isJsonValue, isJsonObject as isRecord } from "@helix/sdk-types";
import { outboundFetch } from "../../outbound-http.js";

const INVALID_TOOL_ARGUMENTS =
  "The model supplied invalid tool arguments. Return one valid JSON object and try again.";

export interface FetchProviderConfig {
  readonly id: string;
  readonly models: readonly ModelInfo[];
  readonly defaultModel?: string;
  readonly fetch?: typeof fetch;
}

export interface ProviderRequestConfig {
  readonly fetch: typeof fetch;
  readonly apiKey?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

class AIProviderRequestError extends Error {
  readonly statusCode: number;
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(
      status === 404
        ? "This model is unavailable for the configured provider account. Choose another model or ask an administrator to check model access."
        : status === 401 || status === 403
          ? "The AI provider rejected its credentials or access. Ask an administrator to check the provider settings."
          : status === 429
            ? "The AI provider is at its request limit (HTTP 429). Wait briefly or choose another provider."
            : status === 400
              ? "The AI provider could not accept this request. Try another model or ask an administrator to check compatibility."
              : message,
    );
    this.name = "AIProviderRequestError";
    this.statusCode = status === 429 ? 429 : status >= 400 && status < 500 ? 422 : 503;
  }
}

export function normalizeFetchConfig(config: FetchProviderConfig): {
  readonly fetch: typeof fetch;
  readonly defaultModel: string;
  readonly models: readonly ModelInfo[];
} {
  const defaultModel = config.defaultModel ?? config.models[0]?.id;
  if (defaultModel === undefined || defaultModel.length === 0) {
    throw new TypeError("AI provider requires at least one model or a default model");
  }

  return {
    fetch: config.fetch ?? outboundFetch,
    defaultModel,
    models: config.models,
  };
}

export function modelForRequest(requestedModel: string | undefined, defaultModel: string): string {
  return requestedModel ?? defaultModel;
}

export function joinUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//u, ""), base);
}

function bearerHeaders(apiKey: string | undefined): Record<string, string> {
  if (apiKey === undefined || apiKey.length === 0) {
    return {};
  }
  return { authorization: `Bearer ${apiKey}` };
}

export async function postJson(
  url: URL,
  body: unknown,
  config: ProviderRequestConfig,
): Promise<unknown> {
  config.signal?.throwIfAborted();
  const response = await config.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearerHeaders(config.apiKey),
      ...(config.headers ?? {}),
    },
    body: JSON.stringify(body),
    ...(config.signal === undefined ? {} : { signal: config.signal }),
  });

  if (!response.ok) {
    await discardResponseBody(response);
    throw new AIProviderRequestError(
      `AI provider request failed with HTTP ${String(response.status)}`,
      response.status,
    );
  }

  try {
    return await response.json();
  } catch {
    config.signal?.throwIfAborted();
    throw new AIProviderRequestError(
      "The AI provider returned invalid JSON. Try again or check provider compatibility.",
      502,
    );
  }
}

export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status is sufficient for callers; never expose an untrusted response body.
  }
}

export function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

export function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function arrayField(record: Record<string, unknown>, field: string): readonly unknown[] {
  const value = record[field];
  return Array.isArray(value) ? value : [];
}

export function firstRecord(values: readonly unknown[]): Record<string, unknown> | undefined {
  const value = values[0];
  return isRecord(value) ? value : undefined;
}

export function usageFromOpenAI(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberField(value, "prompt_tokens");
  const outputTokens = numberField(value, "completion_tokens");
  const totalTokens = numberField(value, "total_tokens");
  return compactUsage({ inputTokens, outputTokens, totalTokens });
}

export function usageFromAnthropic(value: unknown): ChatUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = numberField(value, "input_tokens");
  const outputTokens = numberField(value, "output_tokens");
  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? undefined
      : (inputTokens ?? 0) + (outputTokens ?? 0);
  return compactUsage({ inputTokens, outputTokens, totalTokens });
}

function compactUsage(usage: {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly totalTokens: number | undefined;
  readonly costCents?: number | undefined;
}): ChatUsage | undefined {
  const compact = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(usage.costCents === undefined ? {} : { costCents: usage.costCents }),
  };
  return Object.keys(compact).length === 0 ? undefined : compact;
}

export function approximateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function anthropicMessages(messages: readonly AIMessage[]): readonly Record<string, string>[] {
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
}

function systemPrompt(messages: readonly AIMessage[]): string | undefined {
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  if (systemMessages.length === 0) {
    return undefined;
  }
  return systemMessages.join("\n\n");
}

export function anthropicRequestBody(
  model: string,
  messages: readonly AIMessage[],
  maxTokens: number,
  anthropicVersion: string,
): Record<string, unknown> {
  const system = systemPrompt(messages);
  return {
    model,
    max_tokens: maxTokens,
    messages: anthropicMessages(messages),
    anthropic_version: anthropicVersion,
    ...(system === undefined ? {} : { system }),
  };
}

export function textFromAnthropicContent(content: readonly unknown[]): string {
  return content
    .flatMap((part) => {
      if (!isRecord(part) || part.type !== "text") {
        return [];
      }
      const text = stringField(part, "text");
      return text === undefined ? [] : [text];
    })
    .join("");
}

export function toolCallsFromAnthropicContent(
  content: readonly unknown[],
): readonly AIToolChoice[] | undefined {
  const toolCalls = content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "tool_use") {
      return [];
    }
    const id = stringField(part, "name") ?? stringField(part, "id");
    if (id === undefined) {
      return [];
    }
    const input = toJsonObject(part.input);
    return [{ id, ...(input === undefined ? {} : { input }) }];
  });
  return toolCalls.length === 0 ? undefined : toolCalls;
}

export function toolCallsFromOpenAIMessage(
  message: Record<string, unknown>,
  toolIds?: ReadonlyMap<string, string>,
): readonly AIToolChoice[] | undefined {
  const toolCalls = arrayField(message, "tool_calls").flatMap((toolCall) => {
    if (!isRecord(toolCall)) {
      return [];
    }
    const functionCall = isRecord(toolCall.function) ? toolCall.function : undefined;
    const id = functionCall === undefined ? undefined : stringField(functionCall, "name");
    if (id === undefined) {
      return [];
    }
    const input = parseJsonObject(stringField(functionCall ?? toolCall, "arguments"));
    const callId = stringField(toolCall, "id");
    return [
      {
        id: toolIds?.get(id) ?? id,
        ...(callId === undefined ? {} : { callId }),
        ...(input === undefined ? { error: INVALID_TOOL_ARGUMENTS } : { input }),
      },
    ];
  });
  return toolCalls.length === 0 ? undefined : toolCalls;
}

export function chatResponse(params: {
  readonly message: string;
  readonly model: string;
  readonly providerId: string;
  readonly usage: ChatUsage | undefined;
  readonly toolCalls: readonly AIToolChoice[] | undefined;
  readonly responseId: string | undefined;
}): ChatResponse {
  return {
    message: params.message,
    model: params.model,
    providerId: params.providerId,
    ...(params.usage === undefined ? {} : { usage: params.usage }),
    ...(params.toolCalls === undefined ? {} : { toolCalls: params.toolCalls }),
    ...(params.responseId === undefined ? {} : { metadata: { responseId: params.responseId } }),
  };
}

function parseJsonObject(text: string | undefined): JsonObject | undefined {
  if (text === undefined || text.length === 0) {
    return undefined;
  }

  try {
    return toJsonObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** A single parsed Server-Sent Event (`event:` + `data:` fields). */
export interface SseEvent {
  readonly event: string | undefined;
  readonly data: string;
}

/** Decodes split UTF-8 SSE frames, coalescing multi-line data fields. */
export async function* parseSseStream(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of toAsyncIterable(body)) {
    buffer += decoder.decode(bytes, { stream: true });
    let separator = nextEventSeparator(buffer);
    while (separator !== null) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const event = parseSseFrame(frame);
      if (event !== undefined) {
        yield event;
      }
      separator = nextEventSeparator(buffer);
    }
  }
  buffer += decoder.decode();
  const trailing = parseSseFrame(buffer);
  if (trailing !== undefined) {
    yield trailing;
  }
}

function nextEventSeparator(
  buffer: string,
): { readonly index: number; readonly length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) {
    return null;
  }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function parseSseFrame(frame: string): SseEvent | undefined {
  const dataLines: string[] = [];
  let eventName: string | undefined;
  for (const rawLine of frame.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const valueRaw = colon === -1 ? "" : line.slice(colon + 1);
    const value = valueRaw.startsWith(" ") ? valueRaw.slice(1) : valueRaw;
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventName = value;
    }
  }
  if (dataLines.length === 0 && eventName === undefined) {
    return undefined;
  }
  return { event: eventName, data: dataLines.join("\n") };
}

function toAsyncIterable(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    return body;
  }
  return readableStreamToAsyncIterable(body);
}

async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function postSse(
  url: URL,
  body: unknown,
  config: ProviderRequestConfig,
): Promise<AsyncGenerator<SseEvent>> {
  config.signal?.throwIfAborted();
  const response = await config.fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      ...bearerHeaders(config.apiKey),
      ...(config.headers ?? {}),
    },
    body: JSON.stringify(body),
    ...(config.signal === undefined ? {} : { signal: config.signal }),
  });

  if (!response.ok) {
    await discardResponseBody(response);
    throw new AIProviderRequestError(
      `AI provider stream request failed with HTTP ${String(response.status)}`,
      response.status,
    );
  }

  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
    await discardResponseBody(response);
    throw new AIProviderRequestError(
      "The AI provider did not return an event stream. Check model streaming support.",
      502,
    );
  }

  const responseBody = response.body;
  if (responseBody === null) {
    throw new AIProviderRequestError("AI provider stream response has no body", response.status);
  }
  return parseSseStream(responseBody);
}

interface StreamToolCallAccumulator {
  id: string | undefined;
  name: string | undefined;
  arguments: string;
  invalidArguments?: boolean;
}

export async function* openAIChatChunks(
  events: AsyncIterable<SseEvent>,
  fallbackModel: string,
  toolIds: ReadonlyMap<string, string> = new Map(),
): AsyncGenerator<ChatChunk> {
  const toolCalls = new Map<number, StreamToolCallAccumulator>();
  let usage: ChatUsage | undefined;
  let model: string | undefined;
  let hasText = false;
  for await (const event of events) {
    if (event.data === "[DONE]") {
      break;
    }
    const record = parseSseData(event.data, event.event);
    if (record === undefined) {
      continue;
    }
    model = stringField(record, "model") ?? model;
    const usageFromEvent = usageFromOpenAI(record.usage);
    if (usageFromEvent !== undefined) {
      usage = usageFromEvent;
    }
    const choice = firstRecord(arrayField(record, "choices"));
    if (choice === undefined) {
      continue;
    }
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    accumulateOpenAIToolCallDeltas(toolCalls, delta);
    const text = delta === undefined ? undefined : stringField(delta, "content");
    if (text !== undefined && text.length > 0) {
      hasText = true;
      yield { delta: text };
    }
  }
  const final = finalStreamChunk(toolCalls, usage, model ?? fallbackModel, toolIds);
  if (!hasText && !Array.isArray(final.metadata?.toolCalls))
    throw new AIProviderRequestError(
      "The AI provider returned no answer or tool call. Try again or choose another model.",
      502,
    );
  yield final;
}

function accumulateOpenAIToolCallDeltas(
  toolCalls: Map<number, StreamToolCallAccumulator>,
  delta: Record<string, unknown> | undefined,
): void {
  if (delta === undefined) {
    return;
  }
  for (const entry of arrayField(delta, "tool_calls")) {
    if (!isRecord(entry)) {
      continue;
    }
    const index = numberField(entry, "index") ?? 0;
    const accumulator: StreamToolCallAccumulator = toolCalls.get(index) ?? {
      id: undefined,
      name: undefined,
      arguments: "",
    };
    const functionCall = isRecord(entry.function) ? entry.function : undefined;
    const id = stringField(entry, "id");
    if (id !== undefined) {
      accumulator.id = id;
    }
    const name = functionCall === undefined ? undefined : stringField(functionCall, "name");
    if (name !== undefined) {
      accumulator.name = (accumulator.name ?? "") + name;
    }
    if (functionCall?.arguments !== undefined && typeof functionCall.arguments !== "string")
      accumulator.invalidArguments = true;
    const args = functionCall === undefined ? undefined : stringField(functionCall, "arguments");
    if (args !== undefined) {
      accumulator.arguments += args;
    }
    toolCalls.set(index, accumulator);
  }
}

function finalStreamChunk(
  accumulators: ReadonlyMap<number, StreamToolCallAccumulator>,
  usage: ChatUsage | undefined,
  model: string,
  toolIds?: ReadonlyMap<string, string>,
): ChatChunk {
  const assembled = [...accumulators.entries()]
    .sort((left, right) => left[0] - right[0])
    .flatMap(([, accumulator]) => {
      const id = accumulator.name ?? (toolIds === undefined ? accumulator.id : undefined);
      if (id === undefined) {
        return [];
      }
      const input = accumulator.invalidArguments
        ? undefined
        : parseJsonObject(accumulator.arguments);
      return [
        {
          id: toolIds?.get(id) ?? id,
          ...(toolIds !== undefined && accumulator.id !== undefined
            ? { callId: accumulator.id }
            : {}),
          ...(input === undefined
            ? toolIds === undefined
              ? {}
              : { error: INVALID_TOOL_ARGUMENTS }
            : { input }),
        },
      ];
    });
  const metadata = streamMetadata(model, assembled);
  return {
    delta: "",
    done: true,
    ...(usage === undefined ? {} : { usage }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/** Translates Anthropic text/tool deltas and usage into chat chunks. */
export async function* anthropicChatChunks(
  events: AsyncIterable<SseEvent>,
  fallbackModel: string,
): AsyncGenerator<ChatChunk> {
  const toolUses = new Map<number, StreamToolCallAccumulator>();
  let usage: ChatUsage | undefined;
  let model = fallbackModel;
  for await (const event of events) {
    const record = parseSseData(event.data, event.event);
    if (record === undefined) {
      continue;
    }
    const type = stringField(record, "type") ?? event.event;
    if (type === "message_start") {
      const message = isRecord(record.message) ? record.message : undefined;
      if (message !== undefined) {
        model = stringField(message, "model") ?? model;
        const startUsage = usageFromAnthropic(message.usage);
        if (startUsage !== undefined) {
          usage = startUsage;
        }
      }
    } else if (type === "content_block_start") {
      const block = isRecord(record.content_block) ? record.content_block : undefined;
      const index = numberField(record, "index") ?? 0;
      if (block !== undefined && block.type === "tool_use") {
        toolUses.set(index, {
          id: stringField(block, "id"),
          name: stringField(block, "name"),
          arguments: "",
        });
      }
    } else if (type === "content_block_delta") {
      const blockDelta = isRecord(record.delta) ? record.delta : undefined;
      const index = numberField(record, "index") ?? 0;
      if (blockDelta?.type === "text_delta") {
        const text = stringField(blockDelta, "text");
        if (text !== undefined && text.length > 0) {
          yield { delta: text };
        }
      } else if (blockDelta?.type === "input_json_delta") {
        const partial = stringField(blockDelta, "partial_json") ?? "";
        const accumulator = toolUses.get(index);
        if (accumulator !== undefined) {
          accumulator.arguments += partial;
        }
      }
    } else if (type === "message_delta") {
      const deltaUsage = usageFromAnthropic(record.usage);
      if (deltaUsage !== undefined) {
        usage = mergeUsage(usage, deltaUsage);
      }
    }
  }
  yield finalStreamChunk(toolUses, usage, model);
}

function mergeUsage(base: ChatUsage | undefined, next: ChatUsage): ChatUsage {
  const inputTokens = next.inputTokens ?? base?.inputTokens;
  const outputTokens = next.outputTokens ?? base?.outputTokens;
  const totalTokens =
    inputTokens === undefined && outputTokens === undefined
      ? (next.totalTokens ?? base?.totalTokens)
      : (inputTokens ?? 0) + (outputTokens ?? 0);
  return compactUsage({ inputTokens, outputTokens, totalTokens }) ?? next;
}

function streamMetadata(model: string, toolCalls: readonly AIToolChoice[]): JsonObject | undefined {
  return {
    model,
    ...(toolCalls.length === 0
      ? {}
      : {
          toolCalls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            ...(toolCall.callId === undefined ? {} : { callId: toolCall.callId }),
            ...(toolCall.input === undefined ? {} : { input: toolCall.input }),
            ...(toolCall.error === undefined ? {} : { error: toolCall.error }),
          })),
        }),
  };
}

function parseSseData(data: string, event?: string): Record<string, unknown> | undefined {
  if ((data.length === 0 && event !== "error") || data === "[DONE]") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new AIProviderRequestError(
      "The AI provider returned an unreadable stream. Try again or check provider compatibility.",
      502,
    );
  }
  if (!isRecord(parsed))
    throw new AIProviderRequestError("The AI provider returned an invalid stream event.", 502);
  if (event === "error" || parsed.type === "error" || parsed.error !== undefined) {
    const error = isRecord(parsed.error) ? parsed.error : parsed;
    const code = stringField(error, "code") ?? stringField(error, "type");
    const status =
      code === "rate_limit_exceeded" || code === "rate_limit_error"
        ? 429
        : code === "tool_use_failed" || code === "invalid_request_error"
          ? 400
          : 502;
    throw new AIProviderRequestError(
      "The AI provider reported a stream error. Try again or choose another model.",
      status,
    );
  }
  return parsed;
}

export async function collectChatChunks(
  chunks: AsyncIterable<ChatChunk>,
  providerId: string,
  fallbackModel: string,
): Promise<ChatResponse> {
  let message = "";
  let usage: ChatUsage | undefined;
  let model = fallbackModel;
  let toolCalls: readonly AIToolChoice[] | undefined;
  let responseId: string | undefined;
  for await (const chunk of chunks) {
    message += chunk.delta;
    if (chunk.usage !== undefined) {
      usage = chunk.usage;
    }
    if (chunk.metadata !== undefined) {
      const metadataModel = stringField(chunk.metadata, "model");
      if (metadataModel !== undefined) {
        model = metadataModel;
      }
      const responseIdValue = stringField(chunk.metadata, "responseId");
      if (responseIdValue !== undefined) {
        responseId = responseIdValue;
      }
      const metadataToolCalls = toolCallsFromMetadata(chunk.metadata);
      if (metadataToolCalls !== undefined) {
        toolCalls = metadataToolCalls;
      }
    }
  }
  return chatResponse({ message, model, providerId, usage, toolCalls, responseId });
}

function toolCallsFromMetadata(metadata: JsonObject): readonly AIToolChoice[] | undefined {
  const value = metadata.toolCalls;
  if (!Array.isArray(value)) {
    return undefined;
  }
  const toolCalls = value.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const id = stringField(entry, "id");
    if (id === undefined) {
      return [];
    }
    const input = toJsonObject(entry.input);
    const callId = stringField(entry, "callId");
    const error = stringField(entry, "error");
    return [
      {
        id,
        ...(callId === undefined ? {} : { callId }),
        ...(input === undefined ? {} : { input }),
        ...(error === undefined ? {} : { error }),
      },
    ];
  });
  return toolCalls.length === 0 ? undefined : toolCalls;
}

function toJsonObject(value: unknown): JsonObject | undefined {
  if (!isJsonValue(value) || !isRecord(value)) {
    return undefined;
  }
  return value;
}
