import type { AIClassification } from "@helix/sdk-types";
import { maxClassification } from "./policy.js";
import { dataClassifications, type DataClassification } from "./types.js";

/**
 * Unclassified recalled/retrieved/tool context is treated as restricted.
 *
 * This deliberately differs from the standard baseline used for a new,
 * context-free user turn: once server-side context enters a prompt, absence of
 * a classification must not silently lower the routing requirement.
 */
export const missingContextClassification: DataClassification = "restricted";

export type ClassificationContextKind =
  | "conversation"
  | "history"
  | "memory"
  | "retrieved_source"
  | "tool_result";

export interface ClassificationContext {
  readonly id: string;
  readonly kind: ClassificationContextKind;
  readonly orgId?: string;
  readonly classification?: unknown;
}

export interface EffectiveClassificationInput {
  readonly orgId: string;
  /** A client hint may raise the result, but can never lower server context. */
  readonly clientHint?: AIClassification;
  /** Server classification for the current user input, when available. */
  readonly userInputClassification?: DataClassification;
  readonly baseline?: DataClassification;
  readonly contexts?: readonly ClassificationContext[];
}

export interface ClassificationContributor {
  readonly id: string;
  readonly kind: ClassificationContextKind | "baseline" | "client_hint" | "user_input";
  readonly classification: DataClassification;
  readonly defaulted: boolean;
}

export interface EffectiveClassificationResolution {
  readonly classification: DataClassification;
  readonly contributors: readonly ClassificationContributor[];
  readonly rejectedCrossOrgContextIds: readonly string[];
}

export function resolveEffectiveClassification(
  input: EffectiveClassificationInput,
): EffectiveClassificationResolution {
  const baseline = input.baseline ?? "standard";
  let classification = baseline;
  const contributors: ClassificationContributor[] = [
    {
      id: "baseline",
      kind: "baseline",
      classification: baseline,
      defaulted: false,
    },
  ];
  const rejectedCrossOrgContextIds: string[] = [];

  if (input.userInputClassification !== undefined) {
    classification = maxClassification(classification, input.userInputClassification);
    contributors.push({
      id: "user-input",
      kind: "user_input",
      classification: input.userInputClassification,
      defaulted: false,
    });
  }
  if (input.clientHint !== undefined) {
    classification = maxClassification(classification, input.clientHint);
    contributors.push({
      id: "client-hint",
      kind: "client_hint",
      classification: input.clientHint,
      defaulted: false,
    });
  }

  for (const context of input.contexts ?? []) {
    if (context.orgId !== undefined && context.orgId !== input.orgId) {
      rejectedCrossOrgContextIds.push(context.id);
      continue;
    }
    const resolved = isDataClassification(context.classification)
      ? context.classification
      : missingContextClassification;
    classification = maxClassification(classification, resolved);
    contributors.push({
      id: context.id,
      kind: context.kind,
      classification: resolved,
      defaulted: !isDataClassification(context.classification),
    });
  }

  return {
    classification,
    contributors,
    rejectedCrossOrgContextIds,
  };
}

export function isDataClassification(value: unknown): value is DataClassification {
  return dataClassifications.some((classification) => classification === value);
}
