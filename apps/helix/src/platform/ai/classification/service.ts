import { deriveClassification, defaultClassificationPolicy } from "./policy.js";
import type {
  ClassificationDerivation,
  ClassificationDerivationInput,
  ClassificationPolicy,
  ResourceClassificationRecord,
  ResourceClassificationStore,
} from "./types.js";

/**
 * Identifies a classifiable resource within an org.
 */
export interface ResourceRef {
  readonly orgId: string;
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface ClassifyResourceInput extends ResourceRef {
  /** Signals used to derive the classification (PRD §8.4). */
  readonly derivation: ClassificationDerivationInput;
  /** Actor responsible for the classification, when known. */
  readonly actorId?: string | undefined;
  /** Timestamp override (defaults to now). */
  readonly at?: Date | undefined;
}

/**
 * Ties the PRD §8.4 derivation rules to a durable classification store.
 *
 * Derivation mechanisms (all in {@link deriveClassification}):
 *  - mail-label-derived: labels mapped to classifications
 *  - folder-derived: drive folder path prefixes mapped to classifications
 *  - heuristic PII detection: content scanned for SSN / payment-card / markers
 *
 * `classify` derives the most restrictive classification, persists it, and
 * returns the derivation. Persisting is best-effort upsert keyed by
 * (orgId, resourceType, resourceId).
 */
export class ResourceClassificationService {
  readonly #store: ResourceClassificationStore;
  readonly #policy: ClassificationPolicy;
  readonly #now: () => Date;

  constructor(
    store: ResourceClassificationStore,
    options: {
      readonly policy?: ClassificationPolicy;
      readonly now?: () => Date;
    } = {},
  ) {
    this.#store = store;
    this.#policy = options.policy ?? defaultClassificationPolicy;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Derives a classification from the supplied signals, persists it, and
   * returns both the derivation and the stored record.
   */
  async classify(input: ClassifyResourceInput): Promise<{
    readonly derivation: ClassificationDerivation;
    readonly record: ResourceClassificationRecord;
  }> {
    const derivation = deriveClassification(input.derivation, this.#policy);
    const record: ResourceClassificationRecord = {
      orgId: input.orgId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      classification: derivation.classification,
      source: derivation.source,
      reason: derivation.reason,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      updatedAt: (input.at ?? this.#now()).toISOString(),
    };
    await this.#store.set(record);
    return { derivation, record };
  }

  /**
   * Returns the stored classification for a resource, or `null` when the
   * resource has not been classified yet.
   */
  async get(ref: ResourceRef): Promise<ResourceClassificationRecord | null> {
    return this.#store.get(ref);
  }

  /**
   * Returns the stored classification when present, otherwise derives one
   * from the supplied signals without persisting it. Useful at AI call time
   * to resolve a classification for gating.
   */
  async resolve(input: ClassifyResourceInput): Promise<ResourceClassificationRecord> {
    const existing = await this.#store.get(input);
    if (existing !== null) {
      return existing;
    }
    const { record } = await this.classify(input);
    return record;
  }
}
