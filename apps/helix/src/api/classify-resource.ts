import type { Actor } from "@helix/sdk-types";
import type {
  ClassificationDerivationInput,
  ResourceClassificationService,
} from "../platform/ai/index.js";

/**
 * Auto-classification hook shared by the feature tool factories (PRD §8.4).
 *
 * The platform wires a {@link ResourceClassificationService} into each feature
 * tool factory (`registerMailTools`, `registerChatTools`, `registerDocsTools`,
 * `registerDriveTools`). After a create / send / upload tool handler produces a
 * new resource it calls {@link classifyNewResource} so the resource is
 * classified and the result persisted, keyed by `(orgId, resourceType,
 * resourceId)`.
 *
 * The hook is best-effort: a classification failure must never fail the
 * underlying tool call, so errors are swallowed (and optionally reported).
 */
export type ResourceClassifier = (input: {
  readonly actor: Actor;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly derivation: ClassificationDerivationInput;
}) => Promise<void>;

/**
 * Builds a {@link ResourceClassifier} backed by a
 * {@link ResourceClassificationService}. Returns `undefined` when no service is
 * configured so feature tools can skip classification entirely.
 */
export function createResourceClassifier(
  service: ResourceClassificationService | undefined,
  onError?: (error: unknown) => void,
): ResourceClassifier | undefined {
  if (service === undefined) {
    return undefined;
  }
  return async ({ actor, resourceType, resourceId, derivation }) => {
    try {
      await service.classify({
        orgId: actor.orgId,
        resourceType,
        resourceId,
        actorId: actor.id,
        derivation,
      });
    } catch (error) {
      onError?.(error);
    }
  };
}
