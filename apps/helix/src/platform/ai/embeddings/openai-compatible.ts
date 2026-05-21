import type { EmbedOptions, EmbeddingProviderCapability, ModelInfo } from "@helix/sdk-types";
import {
  arrayField,
  assertRecord,
  joinUrl,
  normalizeFetchConfig,
  postJson,
  stringField,
} from "../providers/shared.js";

export interface OpenAICompatibleEmbeddingProviderConfig {
  readonly id: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly models: readonly ModelInfo[];
  readonly defaultModel?: string;
  readonly defaultDimensions: number;
  readonly modelDimensions?: Record<string, number>;
  readonly maxBatchSize?: number;
  readonly fetch?: typeof fetch;
  readonly headers?: Record<string, string>;
}

export function createOpenAICompatibleEmbeddingProvider(
  config: OpenAICompatibleEmbeddingProviderConfig,
): EmbeddingProviderCapability {
  return new OpenAICompatibleEmbeddingProvider(config);
}

class OpenAICompatibleEmbeddingProvider implements EmbeddingProviderCapability {
  readonly id: string;
  readonly maxBatchSize: number;

  readonly #baseUrl: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #defaultModel: string;
  readonly #defaultDimensions: number;
  readonly #modelDimensions: Record<string, number>;
  readonly #headers: Record<string, string> | undefined;

  constructor(config: OpenAICompatibleEmbeddingProviderConfig) {
    if (!Number.isInteger(config.defaultDimensions) || config.defaultDimensions < 1) {
      throw new TypeError("Embedding provider defaultDimensions must be a positive integer");
    }
    if (config.maxBatchSize !== undefined && (!Number.isInteger(config.maxBatchSize) || config.maxBatchSize < 1)) {
      throw new TypeError("Embedding provider maxBatchSize must be a positive integer");
    }

    const normalized = normalizeFetchConfig(config);
    this.id = config.id;
    this.maxBatchSize = config.maxBatchSize ?? 128;
    this.#baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
    this.#apiKey = config.apiKey;
    this.#fetch = normalized.fetch;
    this.#defaultModel = normalized.defaultModel;
    this.#defaultDimensions = config.defaultDimensions;
    this.#modelDimensions = config.modelDimensions ?? {};
    this.#headers = config.headers;
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) {
      return [];
    }

    const model = opts.model ?? this.#defaultModel;
    const vectors: (readonly number[])[] = [];
    for (let offset = 0; offset < texts.length; offset += this.maxBatchSize) {
      const batch = texts.slice(offset, offset + this.maxBatchSize);
      const body = {
        model,
        input: batch,
        ...(opts.dimensions === undefined ? {} : { dimensions: opts.dimensions }),
      };
      const payload = await postJson(joinUrl(this.#baseUrl, "embeddings"), body, {
        fetch: this.#fetch,
        ...(this.#apiKey === undefined ? {} : { apiKey: this.#apiKey }),
        ...(this.#headers === undefined ? {} : { headers: this.#headers }),
      });
      vectors.push(...parseEmbeddingResponse(payload, batch.length));
    }
    return vectors;
  }

  dimensions(model?: string): number {
    const requested = model ?? this.#defaultModel;
    return this.#modelDimensions[requested] ?? this.#defaultDimensions;
  }
}

function parseEmbeddingResponse(payload: unknown, expectedCount: number): readonly (readonly number[])[] {
  const record = assertRecord(payload, "OpenAI-compatible embedding response");
  const rows = arrayField(record, "data").flatMap((row, position) => {
    if (!isEmbeddingRow(row)) {
      return [];
    }
    return [{ index: row.index ?? position, embedding: row.embedding }];
  });

  const sorted = [...rows].sort((left, right) => left.index - right.index);
  if (sorted.length !== expectedCount) {
    throw new TypeError(`Embedding response returned ${String(sorted.length)} vectors for ${String(expectedCount)} inputs`);
  }
  return sorted.map((row) => row.embedding);
}

interface EmbeddingRow {
  readonly index?: number;
  readonly embedding: readonly number[];
}

function isEmbeddingRow(value: unknown): value is EmbeddingRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const index = record.index;
  const embedding = record.embedding;
  return (
    (index === undefined || (typeof index === "number" && Number.isInteger(index))) &&
    Array.isArray(embedding) &&
    embedding.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    (stringField(record, "object") === undefined || stringField(record, "object") === "embedding")
  );
}
