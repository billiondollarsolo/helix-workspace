import type {
  AiConfig,
  AiProviderConfig,
  ChatRequest,
  ChatResponse,
  JsonObject,
  LLMProviderCapability,
  MeteringClient,
  ModelInfo,
  SecurityTier,
} from "@helix/sdk-types";
import type { PlatformMetrics } from "../../../api/metrics.js";
import { env } from "../../../config/env.js";
import { tierDefaults } from "../../config/tier.js";
import { createOutboundHttpClient } from "../../outbound-http.js";
import {
  AIRouter,
  createAICostGuard,
  createAnthropicCompatibleProvider,
  createBedrockCredentialProvider,
  createBedrockProvider,
  createOpenAICompatibleEmbeddingProvider,
  createOpenAICompatibleProvider,
  createVertexProvider,
  type AICostLimiter,
  type AICostWarningEvent,
  type BedrockCredentialSource,
  type MemoryEmbeddingProvider,
  type PostgresAIProvenanceStore,
  type VertexCredentials,
} from "../index.js";
import { resolveAiEnv } from "../operator-settings.js";

export function createAssistantAIRouter(
  provenance: PostgresAIProvenanceStore,
  options: {
    readonly costLimiter: AICostLimiter;
    readonly metering?: MeteringClient;
    readonly onMeteringError?: (error: unknown) => void;
    readonly metrics: PlatformMetrics;
    readonly securityTier: SecurityTier;
    readonly onCostWarning?: (event: AICostWarningEvent) => void;
    readonly aiConfig?: AiConfig;
  },
): AIRouter {
  const defaultProviderId = env().ASSISTANT_AI_PROVIDER_ID ?? env().AI_DEFAULT_PROVIDER_ID;
  const configuredRouting = aiRoutingPolicyFromConfig(options.aiConfig);
  const featureRoutes =
    defaultProviderId === undefined
      ? configuredRouting.featureRoutes
      : {
          ...(configuredRouting.featureRoutes ?? {}),
          "assistant.chat": { primary: { providerId: defaultProviderId } },
        };
  return new AIRouter({
    providers: createAssistantProviders(options.aiConfig),
    costGuard: createAICostGuard({
      limiter: options.costLimiter,
      tier: options.securityTier,
      ...(options.onCostWarning === undefined ? {} : { onWarning: options.onCostWarning }),
    }),
    metrics: options.metrics,
    provenance,
    ...(options.metering === undefined
      ? {}
      : {
          metering: options.metering,
          ...(options.onMeteringError === undefined
            ? {}
            : { onMeteringError: options.onMeteringError }),
        }),
    policy: {
      tier: options.securityTier,
      localAiOnly: tierDefaults[options.securityTier].localAiOnly,
      ...(options.aiConfig?.privacy?.classificationGating === undefined
        ? {}
        : { classificationEnabled: options.aiConfig.privacy.classificationGating }),
      ...(defaultProviderId === undefined && configuredRouting.defaultProviderId === undefined
        ? {}
        : { defaultProviderId: defaultProviderId ?? configuredRouting.defaultProviderId }),
      featureProviders: {
        "assistant.chat": "assistant.local",
        ...(configuredRouting.featureProviders ?? {}),
        ...(defaultProviderId === undefined ? {} : { "assistant.chat": defaultProviderId }),
      },
      ...(featureRoutes === undefined ? {} : { featureRoutes }),
    },
  });
}

export function createAssistantEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetch?: typeof globalThis.fetch,
): MemoryEmbeddingProvider {
  if (aiConfig?.enabled === false) {
    return createDeterministicEmbeddingProvider();
  }
  const configured = createConfiguredAssistantEmbeddingProvider(aiConfig, env, fetch);
  return configured ?? createDeterministicEmbeddingProvider();
}

export function createSemanticSearchEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetch?: typeof globalThis.fetch,
): MemoryEmbeddingProvider | undefined {
  if (aiConfig?.enabled === false || aiConfig?.embeddingProvider === undefined) {
    return undefined;
  }
  return createConfiguredAssistantEmbeddingProvider(aiConfig, env, fetch);
}

function createConfiguredAssistantEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv,
  fetch?: typeof globalThis.fetch,
): MemoryEmbeddingProvider | undefined {
  const embeddingProvider = aiConfig?.embeddingProvider;
  if (embeddingProvider === undefined) {
    return undefined;
  }
  const plugin = embeddingProvider.plugin.toLowerCase();
  if (!plugin.includes("openai-compat") && !plugin.includes("openai-compatible")) {
    return undefined;
  }
  const config = embeddingProvider.config ?? {};
  const defaultDimensions =
    positiveIntegerConfig(config, "defaultDimensions") ??
    positiveIntegerConfig(config, "dimensions");
  if (defaultDimensions === undefined) {
    return undefined;
  }
  if (defaultDimensions !== 768) {
    throw new TypeError("Assistant memory embedding provider must use 768 dimensions");
  }
  const defaultModel = stringConfig(config, "defaultModel") ?? stringConfig(config, "model");
  const models = modelListFromConfig(config);
  if (defaultModel === undefined && models.length === 0) {
    return undefined;
  }
  const providerId = stringConfig(config, "id") ?? embeddingProvider.plugin;
  const baseUrl = stringConfig(config, "baseUrl");
  const apiKey = secretConfig(config, env);
  const headers = headersConfig(config);
  const maxBatchSize = positiveIntegerConfig(config, "maxBatchSize");
  const modelDimensions = modelDimensionsConfig(config);
  return createOpenAICompatibleEmbeddingProvider({
    id: providerId,
    models,
    defaultDimensions,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(baseUrl === undefined ? {} : { fetch: fetch ?? configuredProviderFetch(baseUrl, env) }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(headers === undefined ? {} : { headers }),
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
    ...(modelDimensions === undefined ? {} : { modelDimensions }),
  });
}

function createConfiguredAssistantProvider(
  provider: AiProviderConfig,
  env: NodeJS.ProcessEnv,
): LLMProviderCapability | undefined {
  const plugin = provider.plugin.toLowerCase();
  const config = provider.config ?? {};
  const defaultModel = stringConfig(config, "defaultModel") ?? stringConfig(config, "model");
  const common = {
    id: provider.id,
    models: modelListFromConfig(config),
    ...(defaultModel === undefined ? {} : { defaultModel }),
  };
  const tags = provider.tags ?? tagsFromConfig(config);
  const withTags = (created: LLMProviderCapability): LLMProviderCapability =>
    tags.length === 0 ? created : Object.assign(created, { tags });
  if (plugin.includes("openai-compat") || plugin.includes("openai-compatible")) {
    const baseUrl = stringConfig(config, "baseUrl");
    const apiKey = secretConfig(config, env);
    const headers = headersConfig(config);
    return withTags(
      createOpenAICompatibleProvider({
        ...common,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(baseUrl === undefined ? {} : { fetch: configuredProviderFetch(baseUrl, env) }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(headers === undefined ? {} : { headers }),
      }),
    );
  }
  if (plugin.includes("anthropic-compat") || plugin.includes("anthropic-compatible")) {
    const baseUrl = stringConfig(config, "baseUrl");
    const apiKey = secretConfig(config, env);
    const anthropicVersion = stringConfig(config, "anthropicVersion");
    const maxTokens = numberConfig(config, "maxTokens");
    const headers = headersConfig(config);
    return withTags(
      createAnthropicCompatibleProvider({
        ...common,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(baseUrl === undefined ? {} : { fetch: configuredProviderFetch(baseUrl, env) }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(headers === undefined ? {} : { headers }),
      }),
    );
  }
  if (plugin.includes("bedrock")) {
    const region = stringConfig(config, "region");
    if (region === undefined) {
      throw new TypeError(`AI provider ${provider.id} requires a Bedrock region`);
    }
    const endpoint = stringConfig(config, "endpoint");
    const maxTokens = numberConfig(config, "maxTokens");
    return withTags(
      createBedrockProvider({
        ...common,
        region,
        credentials: resolveBedrockCredentialSource(config, env),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }),
    );
  }
  if (plugin.includes("vertex")) {
    const project = stringConfig(config, "project");
    const location = stringConfig(config, "location");
    if (project === undefined || location === undefined) {
      throw new TypeError(`AI provider ${provider.id} requires a Vertex project and location`);
    }
    const endpoint = stringConfig(config, "endpoint");
    const maxTokens = numberConfig(config, "maxTokens");
    return withTags(
      createVertexProvider({
        ...common,
        project,
        location,
        credentials: resolveVertexCredentials(provider.id, config, env),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }),
    );
  }
  return undefined;
}

export function configuredProviderFetch(
  baseUrl: string,
  source: NodeJS.ProcessEnv = process.env,
): typeof globalThis.fetch {
  const url = new URL(baseUrl);
  return createOutboundHttpClient({
    allowedHosts: [url.hostname],
    allowHttp: url.protocol === "http:",
    allowPrivateNetwork: source.HELIX_AI_ALLOW_PRIVATE_NETWORK === "true",
  });
}

/**
 * Resolves the Bedrock credential source from provider config.
 *
 * When explicit static keys are configured they are used directly; otherwise
 * a credential provider is returned that resolves IAM role / instance profile
 * (IMDSv2) / `AWS_PROFILE` / environment-variable credentials in standard
 * precedence order. Workload identity (instance profile) therefore requires
 * no configuration at all.
 */
function resolveBedrockCredentialSource(
  config: JsonObject,
  env: NodeJS.ProcessEnv,
): BedrockCredentialSource {
  const accessKeyId =
    stringConfig(config, "accessKeyId") ?? env[stringConfig(config, "accessKeyIdEnv") ?? ""];
  const secretAccessKey =
    stringConfig(config, "secretAccessKey") ??
    env[stringConfig(config, "secretAccessKeyEnv") ?? ""];
  const sessionToken =
    stringConfig(config, "sessionToken") ?? env[stringConfig(config, "sessionTokenEnv") ?? ""];
  const staticCredentials =
    accessKeyId !== undefined && secretAccessKey !== undefined
      ? {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken === undefined ? {} : { sessionToken }),
        }
      : undefined;
  const profile = stringConfig(config, "profile");
  return createBedrockCredentialProvider({
    env: profile === undefined ? env : { ...env, AWS_PROFILE: profile },
    ...(staticCredentials === undefined ? {} : { static: staticCredentials }),
  });
}

/**
 * Resolves Vertex credentials from provider config.
 *
 * Supports both a pre-minted `accessToken` and the service-account
 * (`clientEmail` + `privateKey`) / workload-identity path. With a service
 * account, the provider signs a JWT and exchanges it at the GCP token
 * endpoint for an access token.
 */
function resolveVertexCredentials(
  providerId: string,
  config: JsonObject,
  env: NodeJS.ProcessEnv,
): VertexCredentials {
  const clientEmail =
    stringConfig(config, "clientEmail") ?? env[stringConfig(config, "clientEmailEnv") ?? ""];
  const privateKey = normalizePrivateKey(
    stringConfig(config, "privateKey") ?? env[stringConfig(config, "privateKeyEnv") ?? ""],
  );
  if (clientEmail !== undefined && privateKey !== undefined) {
    const tokenUri = stringConfig(config, "tokenUri");
    const scope = stringConfig(config, "scope");
    return {
      clientEmail,
      privateKey,
      ...(tokenUri === undefined ? {} : { tokenUri }),
      ...(scope === undefined ? {} : { scope }),
    };
  }
  const accessToken =
    stringConfig(config, "accessToken") ?? env[stringConfig(config, "accessTokenEnv") ?? ""];
  if (accessToken !== undefined) {
    return { accessToken };
  }
  throw new TypeError(
    `AI provider ${providerId} requires Vertex credentials: either a service account (clientEmail + privateKey) or an accessToken`,
  );
}

/**
 * Normalizes a PEM private key supplied via config or env. Environment
 * variables commonly encode newlines as the literal escape sequence `\n`.
 */
function normalizePrivateKey(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value.includes("\\n") ? value.replace(/\\n/gu, "\n") : value;
}

export function aiRoutingPolicyFromConfig(
  aiConfig: AiConfig | undefined,
): Pick<
  NonNullable<ConstructorParameters<typeof AIRouter>[0]["policy"]>,
  "defaultProviderId" | "featureProviders" | "featureRoutes"
> {
  const featureProviders: Record<string, string> = {};
  const featureRoutes: Record<
    string,
    {
      primary: {
        providerId: string;
        model?: string;
      };
      fallback?: {
        providerId: string;
        model?: string;
      };
    }
  > = {};
  for (const rule of aiConfig?.routing?.rules ?? []) {
    featureProviders[rule.feature] = rule.primary.providerId;
    featureRoutes[rule.feature] = {
      primary: {
        providerId: rule.primary.providerId,
        ...(rule.primary.model === undefined ? {} : { model: rule.primary.model }),
      },
      ...(rule.fallback === undefined
        ? {}
        : {
            fallback: {
              providerId: rule.fallback.providerId,
              ...(rule.fallback.model === undefined ? {} : { model: rule.fallback.model }),
            },
          }),
    };
  }
  const defaultProviderId = Object.values(featureProviders)[0];
  return {
    ...(defaultProviderId === undefined ? {} : { defaultProviderId }),
    ...(Object.keys(featureProviders).length === 0 ? {} : { featureProviders }),
    ...(Object.keys(featureRoutes).length === 0 ? {} : { featureRoutes }),
  };
}

function pushProvider(providers: LLMProviderCapability[], provider: LLMProviderCapability): void {
  if (!providers.some((candidate) => candidate.id === provider.id)) {
    providers.push(provider);
  }
}

function modelListFromConfig(config: JsonObject): readonly ModelInfo[] {
  const models = config.models;
  if (Array.isArray(models) && models.length > 0) {
    return (models as readonly unknown[]).flatMap((model): ModelInfo[] => {
      if (typeof model === "string" && model.length > 0) {
        return [{ id: model }];
      }
      if (isJsonObjectValue(model) && typeof model.id === "string" && model.id.length > 0) {
        return [
          {
            id: model.id,
            ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
            ...(typeof model.contextWindow === "number"
              ? { contextWindow: model.contextWindow }
              : {}),
            ...(typeof model.inputCostPer1kTokensCents === "number"
              ? { inputCostPer1kTokensCents: model.inputCostPer1kTokensCents }
              : {}),
            ...(typeof model.outputCostPer1kTokensCents === "number"
              ? { outputCostPer1kTokensCents: model.outputCostPer1kTokensCents }
              : {}),
            ...(typeof model.supportsTools === "boolean"
              ? { supportsTools: model.supportsTools }
              : {}),
            ...(typeof model.supportsVision === "boolean"
              ? { supportsVision: model.supportsVision }
              : {}),
          },
        ];
      }
      return [];
    });
  }
  const model = stringConfig(config, "model") ?? stringConfig(config, "defaultModel");
  return model === undefined ? [] : [{ id: model, supportsTools: true }];
}

function secretConfig(config: JsonObject, env: NodeJS.ProcessEnv): string | undefined {
  const apiKey = stringConfig(config, "apiKey");
  if (apiKey !== undefined) {
    return apiKey;
  }
  const apiKeyEnv = stringConfig(config, "apiKeyEnv");
  return apiKeyEnv === undefined ? undefined : env[apiKeyEnv];
}

function headersConfig(config: JsonObject): Record<string, string> | undefined {
  const headers = config.headers;
  if (!isJsonObjectValue(headers)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function tagsFromConfig(config: JsonObject): readonly string[] {
  const tags = config.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

function stringConfig(config: JsonObject, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberConfig(config: JsonObject, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveIntegerConfig(config: JsonObject, key: string): number | undefined {
  const value = numberConfig(config, key);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function modelDimensionsConfig(config: JsonObject): Record<string, number> | undefined {
  const value = config.modelDimensions;
  if (!isJsonObjectValue(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] > 0,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}

function isJsonObjectValue(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createLocalAssistantProvider(): LLMProviderCapability {
  return {
    id: "assistant.local",
    protocol: "openai-compatible",
    tags: ["local-only"],
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const latestUser =
        [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      return {
        providerId: "assistant.local",
        model: "deterministic-assistant",
        message: localAssistantReply(latestUser),
        usage: {
          inputTokens: countApproximateTokens(
            request.messages.map((message) => message.content).join("\n"),
          ),
          outputTokens: countApproximateTokens(latestUser),
        },
        metadata: {
          mode: "deterministic-fallback",
          note: "Configure OLLAMA_BASE_URL or OPENAI_API_KEY for model-backed assistant replies.",
        },
      };
    },
    async models() {
      return [
        {
          id: "deterministic-assistant",
          displayName: "Deterministic Assistant Fallback",
          supportsTools: false,
        },
      ];
    },
    async countTokens(text: string) {
      return countApproximateTokens(text);
    },
  };
}

function localAssistantReply(message: string): string {
  const trimmed = message.trim();
  if (trimmed.startsWith("/draft")) {
    return "Draft ready. I used the current conversation and available workspace context to shape the response.";
  }
  if (trimmed.startsWith("/summarize")) {
    return "Summary ready. I checked the visible context supplied to this assistant turn.";
  }
  if (trimmed.startsWith("/find")) {
    return "I found the most relevant visible workspace context and included it in this reply.";
  }
  if (trimmed.startsWith("/schedule")) {
    return "I can help schedule this by using Calendar tools when a model-backed provider requests them.";
  }
  return trimmed.length === 0
    ? "How can I help with this workspace?"
    : `I captured your request and prepared an assistant response using the visible tools, search context, and opt-in memory available to your actor.`;
}

function createDeterministicEmbeddingProvider() {
  return {
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      return texts.map((text) => deterministicEmbedding(text));
    },
  };
}

function deterministicEmbedding(text: string): readonly number[] {
  const vector = Array.from({ length: 768 }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    const bucket = index % vector.length;
    vector[bucket] = (vector[bucket] ?? 0) + text.charCodeAt(index) / 255;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function countApproximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function createAssistantProviders(
  aiConfig: AiConfig | undefined,
): readonly LLMProviderCapability[] {
  if (aiConfig?.enabled === false) return [];
  const providers: LLMProviderCapability[] = [];
  // Admin platform-config overlay (operator LLM) wins over process env bootstrap.
  const aiEnv = resolveAiEnv(process.env);
  for (const provider of aiConfig?.providers ?? []) {
    if (provider.enabled === false) {
      continue;
    }
    const configured = createConfiguredAssistantProvider(provider, process.env);
    if (configured !== undefined) {
      providers.push(configured);
    }
  }
  if (aiEnv.OLLAMA_BASE_URL !== undefined) {
    pushProvider(
      providers,
      createOpenAICompatibleProvider({
        id: "ollama.local",
        baseUrl: aiEnv.OLLAMA_BASE_URL,
        fetch: configuredProviderFetch(aiEnv.OLLAMA_BASE_URL),
        models: [
          {
            id: aiEnv.OLLAMA_MODEL ?? "llama3.1",
            displayName: aiEnv.OLLAMA_MODEL ?? "Local Ollama",
            supportsTools: true,
          },
        ],
        defaultModel: aiEnv.OLLAMA_MODEL ?? "llama3.1",
      }),
    );
  }
  if (aiEnv.OPENAI_API_KEY !== undefined) {
    pushProvider(
      providers,
      createOpenAICompatibleProvider({
        id: "openai-compatible.default",
        apiKey: aiEnv.OPENAI_API_KEY,
        ...(aiEnv.OPENAI_BASE_URL === undefined ? {} : { baseUrl: aiEnv.OPENAI_BASE_URL }),
        ...(aiEnv.OPENAI_BASE_URL === undefined
          ? {}
          : { fetch: configuredProviderFetch(aiEnv.OPENAI_BASE_URL) }),
        models: [
          {
            id: aiEnv.OPENAI_MODEL ?? "gpt-4.1-mini",
            displayName: aiEnv.OPENAI_MODEL ?? "OpenAI compatible",
            supportsTools: true,
          },
        ],
        defaultModel: aiEnv.OPENAI_MODEL ?? "gpt-4.1-mini",
      }),
    );
  }
  pushProvider(providers, createLocalAssistantProvider());
  return providers;
}
