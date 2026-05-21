import type { AICapability, AIClassification, JsonObject } from "@helix/sdk-types";
import type { EnrichmentEvent, EnrichmentHandler, EnrichmentWorker } from "../../ai/enrichment/index.js";
import type {
  DriveActivityPayload,
  DriveEnrichmentProjectionStore,
  DriveEnrichmentRecord,
} from "../types.js";

export interface DriveAutoTagEnrichmentOptions {
  readonly store: DriveEnrichmentProjectionStore;
  readonly ai?: AICapability | undefined;
  readonly maxTags?: number | undefined;
}

export interface DriveEnrichmentRegistrationOptions extends DriveAutoTagEnrichmentOptions {
  readonly autoTag?: boolean | undefined;
}

const defaultMaxTags = 8;

/**
 * Registers Drive enrichment handlers on the shared {@link EnrichmentWorker}.
 *
 * NOTE: The platform startup wiring in `apps/helix/src/server.ts` registers mail/chat/docs
 * enrichments but does not yet call `registerDriveEnrichments`. Add the following next to the
 * `registerDocsEnrichments(...)` call to activate the `drive.auto-tag` handler:
 *
 *   registerDriveEnrichments(enrichmentWorker, {
 *     store: driveStore,
 *     ai: assistantAi,
 *     autoTag: envFlag("DRIVE_AUTO_TAG_ENRICHMENT", true),
 *   });
 */
export function registerDriveEnrichments(
  worker: EnrichmentWorker,
  options: DriveEnrichmentRegistrationOptions,
): void {
  if (options.autoTag === true) {
    worker.register(createDriveAutoTagEnrichmentHandler(options));
  }
}

export function createDriveAutoTagEnrichmentHandler(
  options: DriveAutoTagEnrichmentOptions,
): EnrichmentHandler<DriveActivityPayload> {
  const maxTags = options.maxTags ?? defaultMaxTags;
  return {
    id: "drive.auto-tag",
    feature: "drive.auto-tag",
    subjects: [
      "activity.drive.upload.finalized",
      "activity.drive.object.moved",
      "activity.drive.object.restored",
      "com.helix.core.drive.upload.finalized",
      "com.helix.core.drive.object.moved",
    ],
    async enrich(event) {
      const file = await fileForEnrichment(event, options.store);
      if (file === null) {
        return skipped("drive.auto-tag", event, "file not found");
      }
      if (file.deletedAt !== undefined) {
        return skipped("drive.auto-tag", event, "file deleted");
      }

      const heuristicTags = heuristicTagsForFile(file);
      const aiTags = await aiTagsForFile(file, options.ai, maxTags);
      const tags = mergeTags([...(file.tags ?? []), ...heuristicTags, ...aiTags], maxTags);
      const source = options.ai === undefined ? "heuristic" : "ai";

      await options.store.setDriveAutoTags?.({
        fileId: file.id,
        tags,
        source,
      });
      await options.store.recordDriveEnrichment?.({
        fileId: file.id,
        feature: "drive.auto-tag",
        data: { tags, source },
      });

      return {
        handlerId: "drive.auto-tag",
        feature: "drive.auto-tag",
        status: "applied",
        resourceType: "drive.file",
        resourceId: file.id,
        metadata: { tags, source },
      };
    },
  };
}

async function fileForEnrichment(
  event: EnrichmentEvent<DriveActivityPayload>,
  store: DriveEnrichmentProjectionStore,
): Promise<DriveEnrichmentRecord | null> {
  const fileId = event.payload.objectId ?? event.payload.fileId ?? event.payload.id;
  if (typeof fileId !== "string" || fileId.length === 0) {
    return null;
  }
  return store.getDriveEnrichmentRecord(fileId);
}

function heuristicTagsForFile(file: DriveEnrichmentRecord): readonly string[] {
  const tags: string[] = [];
  const kind = mimeTypeKind(file.mimeType);
  if (kind !== undefined) {
    tags.push(kind);
  }
  const extension = fileExtension(file.name);
  if (extension !== undefined) {
    tags.push(extension);
  }
  if (file.path !== undefined && file.path.length > 1) {
    const folder = file.path.at(-2);
    if (folder !== undefined && folder.length > 0) {
      tags.push(folder.toLowerCase());
    }
  }
  return tags;
}

async function aiTagsForFile(
  file: DriveEnrichmentRecord,
  ai: AICapability | undefined,
  maxTags: number,
): Promise<readonly string[]> {
  if (ai === undefined) {
    return [];
  }
  const classification = normalizeClassification(file.classification);
  const response = await ai.chat(
    {
      feature: "drive.auto-tag",
      classification,
      messages: [
        {
          role: "system",
          content:
            "Suggest concise lowercase topical tags for this file. " +
            `Return a JSON object {"tags": ["tag", ...]} with at most ${String(maxTags)} tags and no invented details.`,
        },
        {
          role: "user",
          content: fileDescriptionText(file),
        },
      ],
    },
    {
      feature: "drive.auto-tag",
      classification,
    },
  );
  return tagsFromAiResponse(response.message);
}

function fileDescriptionText(file: DriveEnrichmentRecord): string {
  return [
    `Name: ${file.name}`,
    `Type: ${file.mimeType}`,
    file.path === undefined ? "" : `Path: ${file.path.join("/")}`,
    file.description === undefined ? "" : `Description: ${file.description}`,
    file.summary === undefined ? "" : `Summary: ${file.summary}`,
    file.textContent === undefined ? "" : `Content: ${file.textContent.slice(0, 2_000)}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function tagsFromAiResponse(text: string): readonly string[] {
  const parsed = parseJsonObject(text);
  const value = parsed?.tags;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return text
    .split(/[\n,]/u)
    .map((entry) => entry.replace(/^[\s"'-]+|[\s"'-]+$/gu, ""))
    .filter((entry) => entry.length > 0 && entry.length <= 40);
}

function mergeTags(tags: readonly string[], maxTags: number): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized.length === 0 || normalized.length > 40 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= maxTags) {
      break;
    }
  }
  return output;
}

function mimeTypeKind(mimeType: string): string | undefined {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("video/")) {
    return "video";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  if (mimeType === "application/pdf") {
    return "pdf";
  }
  if (mimeType.startsWith("text/")) {
    return "text";
  }
  if (
    mimeType.includes("spreadsheet") ||
    mimeType.includes("excel") ||
    mimeType === "text/csv"
  ) {
    return "spreadsheet";
  }
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) {
    return "presentation";
  }
  if (mimeType.includes("word") || mimeType.includes("document")) {
    return "document";
  }
  return undefined;
}

function fileExtension(name: string): string | undefined {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return undefined;
  }
  const extension = name.slice(lastDot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/u.test(extension) ? extension : undefined;
}

function normalizeClassification(value: string | undefined): AIClassification {
  return value === "public" || value === "standard" || value === "confidential" || value === "restricted"
    ? value
    : "standard";
}

function skipped(feature: string, event: EnrichmentEvent<DriveActivityPayload>, reason: string) {
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

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}
