import type { SecurityTier } from "@helix/sdk-types";
import { localOnlyProviderTags, type AIProviderClassificationTag } from "./provider-tags.js";
import type {
  AIProviderClassificationProfile,
  ClassificationGateDecision,
  ClassificationGateInput,
  ClassificationGateReason,
  DataClassification,
} from "./types.js";

export class ClassificationGateError extends Error {
  constructor(readonly decision: Extract<ClassificationGateDecision, { readonly allowed: false }>) {
    super(decision.message);
    this.name = "ClassificationGateError";
  }
}

export function classificationGatingEnabled(tier: SecurityTier, override?: boolean): boolean {
  if (override !== undefined) {
    return override;
  }
  return tier !== "personal";
}

export function evaluateClassificationGate(input: ClassificationGateInput): ClassificationGateDecision {
  if (!classificationGatingEnabled(input.tier, input.classificationGating)) {
    return allowed(input, "classification_gating_disabled");
  }

  switch (input.classification) {
    case "public":
      return allowed(input, "provider_allowed_for_public");
    case "standard":
      return hasTag(input.provider, "admin-allowlisted")
        ? allowed(input, "provider_allowlisted_for_standard")
        : denied(input, "provider_missing_standard_allowlist");
    case "confidential":
      return hasTag(input.provider, "internal-allowed-for-confidential")
        ? allowed(input, "provider_allowed_for_confidential")
        : denied(input, "provider_missing_confidential_tag");
    case "restricted":
      return hasAnyTag(input.provider, localOnlyProviderTags)
        ? allowed(input, "provider_allowed_for_restricted")
        : denied(input, "provider_missing_restricted_tag");
  }
}

export function enforceClassificationGate(input: ClassificationGateInput): ClassificationGateDecision {
  const decision = evaluateClassificationGate(input);
  if (!decision.allowed) {
    throw new ClassificationGateError(decision);
  }
  return decision;
}

function hasTag(provider: AIProviderClassificationProfile, tag: AIProviderClassificationTag): boolean {
  return provider.tags.includes(tag);
}

function hasAnyTag(
  provider: AIProviderClassificationProfile,
  tags: readonly AIProviderClassificationTag[],
): boolean {
  return tags.some((tag) => hasTag(provider, tag));
}

function allowed(input: ClassificationGateInput, reason: ClassificationGateReason): ClassificationGateDecision {
  return {
    allowed: true,
    classification: input.classification,
    providerId: input.provider.providerId,
    reason,
  };
}

function denied(input: ClassificationGateInput, reason: ClassificationGateReason): ClassificationGateDecision {
  return {
    allowed: false,
    classification: input.classification,
    providerId: input.provider.providerId,
    reason,
    message: denialMessage(input.classification, input.provider.providerId, reason),
  };
}

function denialMessage(
  classification: DataClassification,
  providerId: string,
  reason: ClassificationGateReason,
): string {
  return `Provider ${providerId} cannot process ${classification} AI content: ${reason}`;
}
