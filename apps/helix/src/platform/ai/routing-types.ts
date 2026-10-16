import type {
  Actor,
  AIClassification,
  AiProviderModelRef,
  ImageProviderCapability,
  LLMProviderCapability,
  MeteringClient,
  SecurityTier,
} from "@helix/sdk-types";

interface AIRoutingFeatureRoute {
  readonly primary: AiProviderModelRef;
  readonly fallback?: AiProviderModelRef;
}

export interface AIRoutingPolicy {
  readonly defaultProviderId?: string;
  readonly featureProviders?: Readonly<Record<string, string>>;
  readonly featureRoutes?: Readonly<Record<string, AIRoutingFeatureRoute>>;
  readonly classificationEnabled?: boolean;
  readonly tier?: SecurityTier;
  readonly localAiOnly?: boolean;
}

export interface AICostReservation {
  readonly reservationId: string;
  readonly at: Date;
  readonly estimatedCostCents: number;
}

export interface AICostGuard {
  reserve(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly estimatedCostCents: number;
  }): Promise<AICostReservation> | Promise<void>;
  record(input: {
    readonly reservation?: AICostReservation | undefined;
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly costCents: number;
  }): Promise<void>;
}

export type LLMMetricStatus = "success" | "error";

export interface LLMChatMetrics {
  recordLLMChat(input: {
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly classification: AIClassification;
    readonly status: LLMMetricStatus;
    readonly durationSeconds: number;
    readonly fallback: boolean;
    readonly costCents?: number | undefined;
    readonly errorType?: string | undefined;
  }): void;
}

export interface AIProvenanceRecorder {
  record(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly inputHash: string;
    readonly outputHash: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ readonly id: string }>;
}

export interface AIRouterOptions {
  readonly providers: readonly LLMProviderCapability[];
  readonly imageProviders?: readonly ImageProviderCapability[];
  readonly policy?: AIRoutingPolicy;
  readonly costGuard?: AICostGuard;
  readonly metrics?: LLMChatMetrics;
  readonly provenance?: AIProvenanceRecorder;
  readonly metering?: MeteringClient;
  readonly onMeteringError?: (error: unknown) => void;
  readonly systemActor?: Actor;
}
