import type { JsonObject, JsonValue } from "./json.js";

export type SecurityTier = "personal" | "business" | "enterprise" | "sovereign";
export type HelixMode = "single-tenant" | "multi-tenant-saas";

export type ToolConfirmationPolicy =
  "destructive" | "destructive_and_external" | "all_write" | "all";

export interface TierSecurityDefaults {
  readonly tier: SecurityTier;
  readonly internalTransit: "plaintext" | "caddy-mtls" | "spire-mtls";
  readonly secrets: "env" | "sops" | "vault";
  readonly auditHashChain: boolean;
  readonly auditDestinations: readonly ("postgres" | "immutable-s3" | "siem" | "worm")[];
  readonly networkEgress: "open" | "recommended-allowlist" | "required-allowlist" | "default-deny";
  readonly toolConfirmation: ToolConfirmationPolicy;
  readonly pluginSignatureRequired: boolean;
  readonly localAiOnly: boolean;
}

export interface TierOverrides {
  readonly internalTransit?: TierSecurityDefaults["internalTransit"];
  readonly secrets?: TierSecurityDefaults["secrets"];
  readonly auditHashChain?: boolean;
  readonly auditDestinations?: readonly TierSecurityDefaults["auditDestinations"][number][];
  readonly networkEgress?: TierSecurityDefaults["networkEgress"];
  readonly toolConfirmation?: ToolConfirmationPolicy;
  readonly pluginSignatureRequired?: boolean;
  readonly localAiOnly?: boolean;
}

export interface SecurityConfig {
  readonly tier: SecurityTier;
  readonly overrides?: TierOverrides;
}

export type DataClassification = "public" | "standard" | "confidential" | "restricted";
export type AiDefaultPosture = "disabled" | "admin-controlled" | "user-controlled";
export type AiAuditRequestLogging = "off" | "metadata-only" | "full";

export interface ModuleConfig {
  readonly enabled?: boolean;
  readonly plugin?: string;
  readonly config?: JsonObject;
}

export interface AiProviderConfig {
  readonly id: string;
  readonly plugin: string;
  readonly enabled?: boolean;
  readonly config?: JsonObject;
  readonly tags?: readonly string[];
}

export interface AiProviderModelRef {
  readonly providerId: string;
  readonly model?: string;
}

export interface AiRoutingRule {
  readonly feature: string;
  readonly primary: AiProviderModelRef;
  readonly fallback?: AiProviderModelRef;
  readonly classifications?: Partial<Record<DataClassification, AiProviderModelRef>>;
}

export interface AiRoutingConfig {
  readonly rules?: readonly AiRoutingRule[];
}

export interface AiCostLimitsConfig {
  readonly perUserPerDayUSD?: number;
  readonly perOrgPerDayUSD?: number;
  readonly perAgentPerDayUSD?: number;
}

export interface AiPrivacyConfig {
  readonly redactPIIBeforeSend?: boolean;
  readonly classificationGating?: boolean;
  readonly blockExternalForClassifications?: readonly DataClassification[];
}

export interface AiAuditConfig {
  readonly logRequests?: AiAuditRequestLogging;
  readonly retainDays?: number;
}

export interface AiPluginRefConfig {
  readonly plugin: string;
  readonly config?: JsonObject;
}

/** Shared default LLM credentials for assistant chat, mail assist, and spam AI. */
export interface AiOperatorLlmConfig {
  readonly baseUrl?: string;
  readonly model?: string;
  /** Present only on write; never returned after save. */
  readonly apiKey?: string;
  /** Read-only: whether a key is stored (admin UI masking). */
  readonly apiKeyConfigured?: boolean;
}

/** Beta mail spam second-pass controls (rules + optional LLM after spamd). */
export interface AiMailSpamConfig {
  readonly betaEnabled?: boolean;
}

/** Admin-managed public web search; keys are write-only in API responses. */
export interface AiWebSearchConfig {
  readonly enabled?: boolean;
  readonly provider?: "brave" | "searxng";
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly apiKeyConfigured?: boolean;
  /** Maximum results, 1–10; defaults to 5. */
  readonly maxResults?: number;
}

export interface AiConfig {
  readonly enabled?: boolean;
  readonly defaultPosture?: AiDefaultPosture;
  readonly providers?: readonly AiProviderConfig[];
  readonly vectorStore?: AiPluginRefConfig;
  readonly embeddingProvider?: AiPluginRefConfig;
  readonly webSearch?: AiWebSearchConfig;
  /** Native Assistant execution rounds (1–256, default 128), followed by a final answer. */
  readonly assistant?: { readonly maxToolRounds?: number };
  readonly routing?: AiRoutingConfig;
  readonly costLimits?: AiCostLimitsConfig;
  readonly audit?: AiAuditConfig;
  readonly privacy?: AiPrivacyConfig;
  /** Operator-facing LLM defaults (Admin → AI providers). */
  readonly operatorLlm?: AiOperatorLlmConfig;
  /** Mail spam AI beta toggle. */
  readonly mailSpamAi?: AiMailSpamConfig;
  /** Operator-configured MCP/OpenAPI servers injected into Assistant as `ext.*` tools. */
  readonly toolServers?: readonly {
    readonly id: string;
    readonly type: "openapi" | "mcp";
    readonly baseUrl: string;
    readonly specUrl?: string;
    readonly apiKey?: string;
  }[];
}

export interface ObservabilitySamplingConfig {
  readonly traces?: number;
  readonly llmCalls?: number;
  readonly toolCalls?: number;
  readonly permissionChecks?: number;
}

export interface ObservabilityEndpointsConfig {
  readonly otlpEndpoint?: string;
  readonly tracesEndpoint?: string;
  readonly metricsEndpoint?: string;
  readonly logsEndpoint?: string;
}

export interface ObservabilityConfig {
  readonly enabled?: boolean;
  readonly config?: ObservabilityEndpointsConfig & {
    readonly sampling?: ObservabilitySamplingConfig;
  };
}

export interface HelixConfig {
  readonly mode?: HelixMode;
  readonly security: SecurityConfig;
  readonly modules?: Record<string, ModuleConfig>;
  readonly ai?: AiConfig;
  readonly observability?: ObservabilityConfig;
  readonly plugins?: Record<string, JsonObject>;
  readonly platform?: JsonObject;
}

export interface PluginConfig {
  get(key: string): JsonValue | undefined;
  require(key: string): JsonValue;
  all(): JsonObject;
  tier: SecurityTier;
}
