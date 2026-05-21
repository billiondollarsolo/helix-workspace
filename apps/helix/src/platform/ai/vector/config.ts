import type postgres from "postgres";
import type { AiConfig, JsonObject } from "@helix/sdk-types";
import { ChromaVectorStore } from "./chroma.js";
import { MilvusVectorStore } from "./milvus.js";
import { PgVectorStore } from "./pgvector.js";
import { QdrantVectorStore } from "./qdrant.js";
import { WeaviateVectorStore } from "./weaviate.js";
import type { VectorStore } from "./types.js";

export interface VectorStoreRuntimeOptions {
  readonly sql: postgres.Sql;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
}

export function createConfiguredVectorStore(
  aiConfig: AiConfig | undefined,
  options: VectorStoreRuntimeOptions,
): VectorStore | undefined {
  if (aiConfig?.enabled === false || aiConfig?.vectorStore === undefined) {
    return undefined;
  }

  const plugin = aiConfig.vectorStore.plugin.toLowerCase();
  if (plugin.includes("vector-pgvector") || plugin.endsWith("pgvector")) {
    return new PgVectorStore(options.sql);
  }

  const config = aiConfig.vectorStore.config ?? {};
  if (plugin.includes("qdrant")) {
    return new QdrantVectorStore(httpVectorConfig(config, options, "Qdrant"));
  }
  if (plugin.includes("milvus")) {
    return new MilvusVectorStore(httpVectorConfig(config, options, "Milvus"));
  }
  if (plugin.includes("chroma")) {
    return new ChromaVectorStore(httpVectorConfig(config, options, "Chroma"));
  }
  if (plugin.includes("weaviate")) {
    return new WeaviateVectorStore(httpVectorConfig(config, options, "Weaviate"));
  }

  throw new TypeError(`Unsupported vector store plugin: ${aiConfig.vectorStore.plugin}`);
}

function httpVectorConfig(
  config: JsonObject,
  options: VectorStoreRuntimeOptions,
  label: string,
): { readonly baseUrl: string; readonly apiKey?: string; readonly fetch?: typeof fetch } {
  const baseUrl = stringConfig(config, "baseUrl") ?? stringConfig(config, "url");
  if (baseUrl === undefined) {
    throw new TypeError(`${label} vector store requires config.baseUrl`);
  }
  const apiKey = secretConfig(config, options.env ?? process.env);
  return {
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
}

function secretConfig(config: JsonObject, env: NodeJS.ProcessEnv): string | undefined {
  const apiKey = stringConfig(config, "apiKey");
  if (apiKey !== undefined) {
    return apiKey;
  }
  const apiKeyEnv = stringConfig(config, "apiKeyEnv");
  return apiKeyEnv === undefined ? undefined : env[apiKeyEnv];
}

function stringConfig(config: JsonObject, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
