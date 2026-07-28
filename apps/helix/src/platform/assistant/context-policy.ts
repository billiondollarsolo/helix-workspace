import type { JsonObject, JsonValue } from "@helix/sdk-types";
import { isJsonObject } from "@helix/sdk-types";
import {
  isDataClassification,
  missingContextClassification,
  type DataClassification,
} from "../ai/classification/index.js";
import type { MemoryItem } from "../ai/memory/index.js";
import type { SearchHit } from "../search/index.js";
import type { AssistantSource } from "./types.js";

export const assistantContextLimits = {
  sourceCharacters: 4_000,
  totalSourceCharacters: 12_000,
  memoryCharacters: 2_000,
  totalMemoryCharacters: 4_000,
  titleCharacters: 200,
  toolResultCharacters: 4_000,
} as const;

export interface PreparedSearchContext {
  readonly sources: readonly AssistantSource[];
  readonly rejectedSourceIds: readonly string[];
}

export function prepareSearchContext(
  hits: readonly SearchHit[],
  orgId: string,
): PreparedSearchContext {
  const sources: AssistantSource[] = [];
  const rejectedSourceIds: string[] = [];
  let remaining: number = assistantContextLimits.totalSourceCharacters;

  for (const hit of hits) {
    const sourceOrgId = stringAttribute(hit.attributes, "orgId");
    if (sourceOrgId !== orgId) {
      rejectedSourceIds.push(hit.id);
      continue;
    }
    if (remaining <= 0) {
      break;
    }
    const body = sanitizeUntrustedText(
      hit.body ?? "",
      Math.min(assistantContextLimits.sourceCharacters, remaining),
    );
    remaining -= body.length;
    const title =
      hit.title === undefined
        ? undefined
        : sanitizeUntrustedText(hit.title, assistantContextLimits.titleCharacters);
    const classification = classificationAttribute(hit.attributes);
    sources.push({
      id: sanitizeIdentifier(hit.id),
      type: sanitizeIdentifier(hit.type),
      trust: "untrusted_retrieved",
      classification,
      provenance: {
        sourceId: hit.id,
        sourceType: hit.type,
        orgId,
      },
      ...(title === undefined || title.length === 0 ? {} : { title }),
      ...(body.length === 0 ? {} : { body }),
      ...(hit.score === undefined ? {} : { score: hit.score }),
    });
  }

  return { sources, rejectedSourceIds };
}

export function prepareMemoryContext(
  items: readonly MemoryItem[],
  orgId: string,
): readonly MemoryItem[] {
  const prepared: MemoryItem[] = [];
  let remaining: number = assistantContextLimits.totalMemoryCharacters;
  for (const item of items) {
    if (item.orgId !== orgId || remaining <= 0) {
      continue;
    }
    const content = sanitizeUntrustedText(
      item.content,
      Math.min(assistantContextLimits.memoryCharacters, remaining),
    );
    remaining -= content.length;
    prepared.push({
      ...item,
      content,
      metadata: {
        classification: classificationAttribute(item.metadata),
      },
    });
  }
  return prepared;
}

export function formatUntrustedSources(sources: readonly AssistantSource[]): string {
  return sources
    .map((source) =>
      JSON.stringify({
        id: source.id,
        type: source.type,
        title: source.title ?? "",
        content: source.body ?? "",
        classification: source.classification,
      }),
    )
    .join("\n");
}

export function formatUntrustedMemory(items: readonly MemoryItem[]): string {
  return items
    .map((item) =>
      JSON.stringify({
        id: sanitizeIdentifier(item.id),
        source: sanitizeIdentifier(item.source),
        content: item.content,
        classification: classificationAttribute(item.metadata),
      }),
    )
    .join("\n");
}

export function formatUntrustedToolResult(input: {
  readonly toolId: string;
  readonly output: JsonValue | undefined;
}): string {
  const serialized = JSON.stringify({
    toolId: sanitizeIdentifier(input.toolId),
    output: input.output ?? null,
  });
  return [
    "BEGIN_UNTRUSTED_TOOL_RESULT",
    sanitizeUntrustedText(serialized, assistantContextLimits.toolResultCharacters),
    "END_UNTRUSTED_TOOL_RESULT",
  ].join("\n");
}

export function classificationFromToolResult(output: JsonValue | undefined): DataClassification {
  if (!isJsonObject(output)) {
    return missingContextClassification;
  }
  const direct = output.classification;
  if (isDataClassification(direct)) {
    return direct;
  }
  const metadata = output.metadata;
  if (isJsonObject(metadata) && isDataClassification(metadata.classification)) {
    return metadata.classification;
  }
  return missingContextClassification;
}

export function classificationAttribute(attributes: JsonObject | undefined): DataClassification {
  return isDataClassification(attributes?.classification)
    ? attributes.classification
    : missingContextClassification;
}

export function sanitizeUntrustedText(value: string, maxCharacters: number): string {
  const decoded = decodeHtmlEntities(value.normalize("NFKC"));
  const withoutMarkup = decoded.replace(/<[^>]*>/gu, " ");
  const withoutControls = withoutMarkup
    // eslint-disable-next-line no-control-regex -- C0/C1 removal is the security boundary.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, "");
  const redacted = withoutControls
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|helix_ak)_[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED_TOKEN]")
    .replace(
      /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^/\s]+(?:\.internal|\.local))(?::\d+)?[^\s]*/giu,
      "[REDACTED_INTERNAL_URL]",
    )
    .replace(/\s+/gu, " ")
    .trim();
  return redacted.slice(0, Math.max(0, maxCharacters));
}

function stringAttribute(attributes: JsonObject | undefined, key: string): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sanitizeIdentifier(value: string): string {
  return sanitizeUntrustedText(value, assistantContextLimits.titleCharacters).replace(
    /[^A-Za-z0-9._:@/-]/gu,
    "_",
  );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/giu, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&#([0-9]+);?/gu, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&(?:colon);/giu, ":")
    .replace(/&(?:lt);/giu, "<")
    .replace(/&(?:gt);/giu, ">")
    .replace(/&(?:amp);/giu, "&")
    .replace(/&(?:quot);/giu, '"')
    .replace(/&(?:apos|#39);/giu, "'");
}
