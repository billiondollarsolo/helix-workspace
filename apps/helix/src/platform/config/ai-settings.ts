import {
  isJsonObject,
  isJsonValue,
  type AiConfig,
  type HelixConfig,
  type JsonObject,
  type JsonValue,
} from "@helix/sdk-types";
import { z } from "zod";
import { BadRequestError } from "../../api/api-error.js";
import { retrievalChunkSettings } from "../search/chunks.js";

export const aiWebSearchUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.enum(["brave", "searxng"]).optional(),
    baseUrl: z.string().trim().min(1).max(2000).optional(),
    apiKey: z.string().max(4000).nullable().optional(),
    maxResults: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const aiRetrievalConfigUpdateSchema = z
  .custom<JsonObject>((value) => isJsonObject(value) && isJsonValue(value))
  .superRefine((config, ctx) => {
    for (const key of ["apiKeyConfigured", "headers", "apiKeyEnv"])
      if (config[key] !== undefined)
        ctx.addIssue({ code: "custom", path: [key], message: "Use the write-only API key field." });
    try {
      // Patches may omit the stored size; validate the relationship after merging.
      retrievalChunkSettings({ ...config, maxInputChars: config.maxInputChars ?? 32768 });
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid chunk settings.",
      });
    }
  });

/** Apply write-only credential semantics before persistence or runtime validation. */
export function mergeAiSettingsPreservingSecrets(
  current: AiConfig | undefined,
  next: AiConfig | undefined,
  update: unknown,
): AiConfig | undefined {
  if (next === undefined) return current;
  const patch = asObject(update) ?? {};
  const result = { ...next };
  if (patch.providers !== undefined) {
    const providers = mergeAiProvidersPreservingSecrets(current, next)?.providers;
    if (providers !== undefined) result.providers = providers;
  }
  for (const key of ["vectorStore", "embeddingProvider"] as const) {
    const ref = next[key];
    if (patch[key] === undefined || ref === undefined) continue;
    const previous = current?.[key];
    const incoming = asObject(asObject(patch[key])?.config) ?? {};
    result[key] = {
      ...ref,
      config: mergeCredentials(
        previous?.config,
        ref.config,
        incoming,
        previous?.plugin === ref.plugin && endpoint(previous.config) === endpoint(ref.config),
      ),
    };
  }
  if (patch.webSearch !== undefined && next.webSearch !== undefined) {
    const incoming = asObject(patch.webSearch) ?? {};
    result.webSearch = {
      maxResults: 5,
      ...mergeCredentials(
        asObject(current?.webSearch),
        asObject(next.webSearch),
        incoming,
        current?.webSearch?.provider === next.webSearch.provider &&
          endpoint(asObject(current?.webSearch)) === endpoint(asObject(next.webSearch)),
      ),
    };
  }
  if (patch.operatorLlm !== undefined && next.operatorLlm !== undefined) {
    result.operatorLlm = mergeCredentials(
      asObject(current?.operatorLlm),
      asObject(next.operatorLlm),
      asObject(patch.operatorLlm) ?? {},
      endpoint(asObject(current?.operatorLlm)) === endpoint(asObject(next.operatorLlm)),
    );
  }
  return result;
}

export function mergeAiProvidersPreservingSecrets(
  current: AiConfig | undefined,
  next: AiConfig | undefined,
): AiConfig | undefined {
  if (next === undefined) return current;
  if (next.providers === undefined) return next;
  const prior = new Map(current?.providers?.map((provider) => [provider.id, provider]));
  return {
    ...next,
    providers: next.providers.map((provider) => {
      const previous = prior.get(provider.id);
      return {
        ...provider,
        config: mergeCredentials(
          previous?.config,
          provider.config,
          provider.config ?? {},
          previous?.plugin === provider.plugin &&
            endpoint(previous.config) === endpoint(provider.config),
        ),
      };
    }),
  };
}

function mergeCredentials(
  previous: JsonObject | undefined,
  next: JsonObject | undefined,
  incoming: JsonObject,
  sameIdentity: boolean,
): JsonObject {
  const config = { ...(next ?? {}) };
  delete config.apiKeyConfigured;
  const supplied = incoming.apiKey;
  if (supplied !== undefined && supplied !== null && typeof supplied !== "string")
    throw new BadRequestError("API key must be text, or null to clear it.");
  if (supplied === null) {
    config.apiKey = "";
    delete config.apiKeyEnv;
  } else if (typeof supplied === "string" && supplied.trim()) {
    config.apiKey = supplied.trim();
    delete config.apiKeyEnv;
  } else if (!sameIdentity && hasSecret(previous)) {
    throw new BadRequestError(
      "Re-enter the API key or explicitly clear it when changing the provider or endpoint.",
    );
  } else {
    delete config.apiKey;
    const key = previous?.apiKey;
    if (typeof key === "string") config.apiKey = key;
  }
  if (
    (supplied === null || (typeof supplied === "string" && supplied.trim())) &&
    previous?.headers !== undefined
  )
    config.headers = null;
  return config;
}

function endpoint(config: JsonObject | undefined): string {
  const value = config?.baseUrl ?? config?.url;
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.href.replace(/\/$/u, "");
  } catch {
    return value;
  }
}
function hasSecret(config: JsonObject | undefined): boolean {
  return (
    (isJsonObject(config?.headers) && Object.keys(config.headers).length > 0) ||
    (typeof config?.apiKey === "string"
      ? config.apiKey.trim().length > 0
      : typeof config?.apiKeyEnv === "string" && config.apiKeyEnv.trim().length > 0)
  );
}
function asObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) && isJsonValue(value) ? value : undefined;
}

/** Syntactic checks run on the fully merged candidate, before any write. */
export function validateAiSettings(ai: AiConfig | undefined): void {
  if (ai === undefined) return;
  for (const key of ["vectorStore", "embeddingProvider"] as const) {
    const config = ai[key]?.config;
    if (config === undefined) continue;
    for (const name of ["baseUrl", "url"] as const)
      if (config[name] !== undefined) validateEndpoint(config[name]);
  }
  try {
    retrievalChunkSettings(ai.embeddingProvider?.config);
  } catch (error) {
    throw new BadRequestError(error instanceof Error ? error.message : "Invalid chunk settings.");
  }
  const dimensions =
    ai.embeddingProvider?.config?.dimensions ?? ai.embeddingProvider?.config?.defaultDimensions;
  const backend = ai.vectorStore?.plugin.toLowerCase() ?? "";
  const maxDimensions =
    backend.includes("vector-pgvector") || backend.endsWith("pgvector") ? 16000 : 65536;
  if (
    dimensions !== undefined &&
    (typeof dimensions !== "number" ||
      !Number.isInteger(dimensions) ||
      dimensions < 1 ||
      dimensions > maxDimensions)
  )
    throw new BadRequestError(
      `Embedding dimensions must be an integer from 1 to ${String(maxDimensions)} for the selected backend.`,
    );
  const web = ai.webSearch;
  if (web?.baseUrl !== undefined) validateEndpoint(web.baseUrl);
  if (
    web?.maxResults !== undefined &&
    (!Number.isInteger(web.maxResults) || web.maxResults < 1 || web.maxResults > 10)
  )
    throw new BadRequestError("Web search result count must be between 1 and 10.");
  if (web?.enabled === true) {
    if (web.provider !== "brave" && web.provider !== "searxng")
      throw new BadRequestError("Choose a web search provider before enabling search.");
    if (web.provider === "brave" && !web.apiKey?.trim())
      throw new BadRequestError("Enter a Brave API key before enabling web search.");
    if (web.provider === "searxng" && !web.baseUrl)
      throw new BadRequestError("Enter a SearXNG endpoint before enabling web search.");
  }
}

function validateEndpoint(value: unknown): void {
  try {
    if (typeof value !== "string" || /[\\\s]/u.test(value)) throw new Error();
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
  } catch {
    throw new BadRequestError(
      "Use an HTTP or HTTPS endpoint without credentials, query parameters, or fragments.",
    );
  }
}

/** GET responses expose presence only; legacy custom secret fields are not returned. */
export function redactAiSecretsForAdmin(config: HelixConfig): HelixConfig {
  if (config.ai === undefined) return config;
  const ai = config.ai;
  return {
    ...config,
    ai: {
      ...ai,
      ...(ai.operatorLlm === undefined
        ? {}
        : { operatorLlm: redactCredentials(asObject(ai.operatorLlm)) }),
      ...(ai.providers === undefined
        ? {}
        : {
            providers: ai.providers.map((provider) => ({
              ...provider,
              config: redactCredentials(provider.config),
            })),
          }),
      ...(ai.vectorStore === undefined
        ? {}
        : { vectorStore: { ...ai.vectorStore, config: redactCredentials(ai.vectorStore.config) } }),
      ...(ai.embeddingProvider === undefined
        ? {}
        : {
            embeddingProvider: {
              ...ai.embeddingProvider,
              config: redactCredentials(ai.embeddingProvider.config),
            },
          }),
      ...(ai.webSearch === undefined
        ? {}
        : { webSearch: redactCredentials(asObject(ai.webSearch)) }),
    },
  };
}

function redactCredentials(config: JsonObject | undefined): JsonObject {
  return {
    ...redactObject(config ?? {}),
    apiKeyConfigured: hasSecret(config) || config?.apiKeyConfigured === true,
  };
}
function redactObject(config: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(config).flatMap(([key, value]): [string, JsonValue][] => {
      if (/api.?key|password|secret|authorization|headers|token$/iu.test(key)) return [];
      if (/^(baseUrl|url|endpoint)$/u.test(key) && typeof value === "string") {
        try {
          const url = new URL(value);
          if (!url.username && !url.password && !url.search && !url.hash) return [[key, value]];
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return [[key, url.href]];
        } catch {
          return [[key, "Invalid endpoint"]];
        }
      }
      return [[key, redactValue(value)]];
    }),
  );
}
function redactValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactValue);
  return isJsonObject(value) ? redactObject(value) : value;
}
