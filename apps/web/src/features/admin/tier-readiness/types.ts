/* Security tier readiness — shared type vocabulary. */
import type { LucideIcon } from "lucide-react";

export type TierId = "personal" | "business" | "enterprise" | "sovereign";
export type CheckStatus = "ready" | "warning" | "blocked" | "not-required";
export type ServiceStatus = "online" | "configured" | "pending" | "missing";
export type BackendReadinessStatus = "ready" | "missing" | "not_required" | "unknown" | "degraded";

export interface PlatformConfigPatch {
  readonly security?: {
    readonly tier: TierId;
  };
  readonly ai?: {
    readonly operatorLlm?: {
      readonly baseUrl?: string;
      readonly model?: string;
      /** Write-only; omit to keep the stored key. */
      readonly apiKey?: string;
    };
    readonly mailSpamAi?: {
      readonly betaEnabled?: boolean;
    };
    readonly providers?: readonly AIProviderConfig[];
    readonly routing?: {
      readonly rules?: readonly AIRoutingRule[];
    };
  };
}

export interface AIProviderConfig {
  readonly id: string;
  readonly plugin: string;
  readonly enabled?: boolean;
  readonly tags?: readonly string[];
  readonly config?: {
    readonly baseUrl?: string;
    readonly defaultModel?: string;
    readonly model?: string;
    readonly models?: readonly string[];
    readonly apiKey?: string;
    readonly apiKeyConfigured?: boolean;
    readonly displayName?: string;
  };
}

export interface AIRoutingRule {
  readonly feature: string;
  readonly primary: { readonly providerId: string; readonly model?: string };
  readonly fallback?: { readonly providerId: string; readonly model?: string };
}

export interface TierDefinition {
  readonly id: TierId;
  readonly shortName: string;
  readonly title: string;
  readonly target: string;
  readonly serviceSummary: string;
  readonly requiredServiceIds: readonly string[];
}

export interface ReadinessCheck {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly statusByTier: Readonly<Record<TierId, CheckStatus>>;
}

export interface RequiredService {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly status: ServiceStatus;
}

export interface RenderedService extends RequiredService {
  readonly backendStatus?: BackendReadinessStatus;
}

export interface PlatformConfigStatus {
  readonly config: {
    readonly security: {
      readonly tier: TierId;
    };
    readonly ai?: AIConfigStatus;
  };
  readonly readiness: {
    readonly ready: boolean;
    readonly requirements: readonly BackendRequirement[];
  };
}

interface AIOperatorLlmStatus {
  readonly baseUrl?: string;
  readonly model?: string;
  /** True when a key is stored; the key itself is never returned. */
  readonly apiKeyConfigured?: boolean;
}

interface AIMailSpamStatus {
  readonly betaEnabled?: boolean;
}

export interface AIConfigStatus {
  readonly costLimits?: {
    readonly perUserPerDayUSD?: number;
    readonly perOrgPerDayUSD?: number;
    readonly perAgentPerDayUSD?: number;
  };
  readonly audit?: {
    readonly logRequests?: "off" | "metadata-only" | "full";
    readonly retainDays?: number;
  };
  readonly privacy?: {
    readonly redactPIIBeforeSend?: boolean;
    readonly classificationGating?: boolean;
    readonly blockExternalForClassifications?: readonly string[];
  };
  readonly operatorLlm?: AIOperatorLlmStatus;
  readonly mailSpamAi?: AIMailSpamStatus;
  readonly providers?: readonly AIProviderConfig[];
  readonly routing?: {
    readonly rules?: readonly AIRoutingRule[];
  };
}

export interface BackendRequirement {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly status: BackendReadinessStatus;
  readonly expected: Record<string, unknown>;
  readonly observed: Record<string, unknown>;
  readonly missing?: readonly string[];
}

export interface RequirementField {
  readonly label: string;
  readonly value: string;
}

export interface RenderedReadinessCheck extends ReadinessCheck {
  readonly status: CheckStatus;
  readonly expectedFields?: readonly RequirementField[];
  readonly observedFields?: readonly RequirementField[];
  readonly missing?: readonly string[];
}

export interface AICostAuditRow {
  readonly id: string;
  readonly label: string;
  readonly tierDefault: string;
  readonly configured: string;
  readonly evidence: string;
}
