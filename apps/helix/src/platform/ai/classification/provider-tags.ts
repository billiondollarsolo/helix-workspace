/**
 * Single shared vocabulary of AI provider classification tags.
 *
 * Before P0-6 two divergent tag vocabularies coexisted: the classification
 * gate (`gating.ts`) declared a typed `AIProviderClassificationTag` union,
 * while the router (`routing.ts`) matched bare string literals against
 * `provider.tags`. This module is the one canonical source so the gate and
 * the router agree on what each tag means.
 */
export const aiProviderClassificationTags = [
  /** Provider sends data to an external/third-party service. */
  "external",
  /** Admin has explicitly allowlisted the provider for standard data. */
  "admin-allowlisted",
  /** Provider is internal/self-hosted and approved for confidential data. */
  "internal-allowed-for-confidential",
  /** Provider runs fully air-gapped (no outbound network). */
  "air-gapped",
  /** Provider runs locally on the host (e.g. Ollama). */
  "local-only",
  /** Provider is covered by a signed BAA/DPA. */
  "baa-dpa",
] as const;

export type AIProviderClassificationTag = (typeof aiProviderClassificationTags)[number];

/** Tags that mark a provider as safe for the most-restrictive data. */
export const localOnlyProviderTags: readonly AIProviderClassificationTag[] = [
  "local-only",
  "air-gapped",
];

/** Tags that mark a provider as approved for confidential data. */
export const confidentialProviderTags: readonly AIProviderClassificationTag[] = [
  "internal-allowed-for-confidential",
  "local-only",
  "air-gapped",
];

export function isAIProviderClassificationTag(
  value: string,
): value is AIProviderClassificationTag {
  return (aiProviderClassificationTags as readonly string[]).includes(value);
}

/** Filters an arbitrary tag list down to recognized classification tags. */
export function normalizeProviderTags(
  tags: readonly string[] | undefined,
): readonly AIProviderClassificationTag[] {
  return (tags ?? []).filter(isAIProviderClassificationTag);
}
