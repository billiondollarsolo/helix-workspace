import type { JsonObject, SecurityTier } from "@helix/sdk-types";
import type { AIProviderClassificationTag } from "./provider-tags.js";

export type { AIProviderClassificationTag } from "./provider-tags.js";

export const dataClassifications = ["public", "standard", "confidential", "restricted"] as const;

export type DataClassification = (typeof dataClassifications)[number];

export type ClassificationSource = "default" | "explicit" | "label" | "folder" | "heuristic";

export interface ClassificationDerivation {
  readonly classification: DataClassification;
  readonly source: ClassificationSource;
  readonly reason: string;
}

export interface ClassificationDerivationInput {
  readonly explicit?: DataClassification | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly path?: string | undefined;
  readonly content?: string | undefined;
  readonly attributes?: JsonObject | undefined;
  readonly scanContent?: boolean | undefined;
}

export interface ClassificationPolicy {
  readonly defaultClassification: DataClassification;
  readonly labelMappings: ReadonlyMap<string, DataClassification>;
  readonly folderMappings: ReadonlyMap<string, DataClassification>;
  readonly heuristicRules: readonly ClassificationHeuristicRule[];
}

export interface ClassificationHeuristicRule {
  readonly id: string;
  readonly classification: DataClassification;
  readonly pattern: RegExp;
}

export interface AIProviderClassificationProfile {
  readonly providerId: string;
  readonly tags: readonly AIProviderClassificationTag[];
}

export interface ClassificationGateInput {
  readonly classification: DataClassification;
  readonly provider: AIProviderClassificationProfile;
  readonly tier: SecurityTier;
  readonly feature?: string | undefined;
  readonly classificationGating?: boolean | undefined;
}

export type ClassificationGateReason =
  | "classification_gating_disabled"
  | "provider_allowed_for_public"
  | "provider_allowlisted_for_standard"
  | "provider_allowed_for_confidential"
  | "provider_allowed_for_restricted"
  | "provider_missing_standard_allowlist"
  | "provider_missing_confidential_tag"
  | "provider_missing_restricted_tag";

export interface ClassificationGateAllowed {
  readonly allowed: true;
  readonly classification: DataClassification;
  readonly providerId: string;
  readonly reason: ClassificationGateReason;
}

export interface ClassificationGateDenied {
  readonly allowed: false;
  readonly classification: DataClassification;
  readonly providerId: string;
  readonly reason: ClassificationGateReason;
  readonly message: string;
}

export type ClassificationGateDecision = ClassificationGateAllowed | ClassificationGateDenied;

export interface ResourceClassificationRecord {
  readonly orgId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly classification: DataClassification;
  readonly source: ClassificationSource;
  readonly reason: string;
  readonly actorId?: string | undefined;
  readonly updatedAt: string;
}

export interface ResourceClassificationStore {
  get(input: {
    readonly orgId: string;
    readonly resourceType: string;
    readonly resourceId: string;
  }): Promise<ResourceClassificationRecord | null>;
  set(record: ResourceClassificationRecord): Promise<void>;
}
