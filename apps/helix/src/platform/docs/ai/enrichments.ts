import type { AICapability, JsonObject } from "@helix/sdk-types";
import type { EnrichmentEvent, EnrichmentHandler, EnrichmentWorker } from "../../ai/enrichment/index.js";
import type {
  DocsActivityPayload,
  DocsOutlineEnrichmentRecord,
  DocsOutlineEnrichmentStore,
  DocsOutlineItem,
} from "../types.js";
import type { AIClassification } from "@helix/sdk-types";
import { enrichDocsOutlineFromText } from "./outline.js";

export interface DocsOutlineEnrichmentOptions {
  readonly store: DocsOutlineEnrichmentStore;
  readonly ai?: AICapability | undefined;
}

export interface DocsEnrichmentRegistrationOptions extends DocsOutlineEnrichmentOptions {
  readonly outline?: boolean | undefined;
}

export function registerDocsEnrichments(
  worker: EnrichmentWorker,
  options: DocsEnrichmentRegistrationOptions,
): void {
  if (options.outline === true) {
    worker.register(createDocsOutlineEnrichmentHandler(options));
  }
}

export function createDocsOutlineEnrichmentHandler(
  options: DocsOutlineEnrichmentOptions,
): EnrichmentHandler<DocsActivityPayload> {
  return {
    id: "docs.outline",
    feature: "docs.outline",
    subjects: [
      "activity.docs.document.created",
      "activity.docs.document.updated",
      "com.helix.core.docs.document.created",
      "com.helix.core.docs.document.updated",
    ],
    async enrich(event) {
      const document = await documentForEnrichment(event, options.store);
      if (document === null) {
        return skipped("docs.outline", event, "document not found");
      }
      if (document.deletedAt !== undefined) {
        return skipped("docs.outline", event, "document deleted");
      }

      const outline = enrichDocsOutlineFromText(document.markdown ?? document.body ?? document.plainText ?? "");
      const summary = await summarizeOutline(document, outline, options.ai);
      await options.store.recordDocsOutlineEnrichment?.({
        docId: document.id,
        outline,
        ...(summary === undefined ? {} : { summary }),
        metadata: { source: options.ai === undefined ? "deterministic" : "ai" },
      });

      return {
        handlerId: "docs.outline",
        feature: "docs.outline",
        status: "applied",
        resourceType: "docs.document",
        resourceId: document.id,
        metadata: compactJsonObject({
          outline,
          summary,
        }),
      };
    },
  };
}

async function documentForEnrichment(
  event: EnrichmentEvent<DocsActivityPayload>,
  store: DocsOutlineEnrichmentStore,
): Promise<DocsOutlineEnrichmentRecord | null> {
  const docId = event.payload.docId ?? event.payload.documentId ?? event.payload.id;
  if (typeof docId !== "string" || docId.length === 0) {
    return null;
  }
  return store.getDocsOutlineEnrichmentRecord(docId);
}

async function summarizeOutline(
  document: DocsOutlineEnrichmentRecord,
  outline: readonly DocsOutlineItem[],
  ai: AICapability | undefined,
): Promise<string | undefined> {
  if (ai === undefined || outline.length === 0) {
    return undefined;
  }
  const classification = normalizeClassification(document.classification);
  const response = await ai.chat(
    {
      feature: "docs.outline",
      classification,
      messages: [
        {
          role: "system",
          content: "Summarize this document outline in one sentence. Do not invent details.",
        },
        {
          role: "user",
          content: [`Title: ${document.title}`, ...outline.map((item) => `${"#".repeat(item.level)} ${item.title}`)].join("\n"),
        },
      ],
    },
    {
      feature: "docs.outline",
      classification,
    },
  );
  return response.message;
}

function normalizeClassification(value: string | undefined): AIClassification {
  return value === "public" || value === "standard" || value === "confidential" || value === "restricted"
    ? value
    : "standard";
}

function skipped(feature: string, event: EnrichmentEvent<DocsActivityPayload>, reason: string) {
  return {
    handlerId: feature,
    feature,
    status: "skipped" as const,
    metadata: {
      subject: event.subject,
      reason,
    },
  };
}

function compactJsonObject(input: Record<string, unknown>): JsonObject {
  const output: Record<string, JsonObject[keyof JsonObject]> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value as JsonObject[keyof JsonObject];
    }
  }
  return output;
}
