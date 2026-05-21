import type {
  AICapability,
  AIClassification,
  ChatRequest,
  JsonObject,
  JsonValue,
  SuggestionChunk,
  SuggestionContext,
  SuggestionSlotProviderCapability,
} from "@helix/sdk-types";
import { drivePluginId } from "../types.js";

export const driveSuggestionSlotIds = ["drive.describe-image", "drive.summarize-file"] as const;

export type DriveSuggestionSlotId = (typeof driveSuggestionSlotIds)[number];

export interface DriveSuggestionSlotDescriptor {
  readonly id: DriveSuggestionSlotId;
  readonly pluginId: typeof drivePluginId;
  readonly label: string;
  readonly description: string;
  readonly order: number;
}

export const driveSuggestionSlots: readonly DriveSuggestionSlotDescriptor[] = [
  {
    id: "drive.describe-image",
    pluginId: drivePluginId,
    label: "Describe image",
    description: "Describe image content from available file context",
    order: 10,
  },
  {
    id: "drive.summarize-file",
    pluginId: drivePluginId,
    label: "Summarize file",
    description: "Summarize a drive file",
    order: 20,
  },
];

export interface DriveSuggestionProviderOptions {
  readonly ai: AICapability;
  readonly defaultClassification?: AIClassification | undefined;
}

export function createDriveSuggestionSlotProviders(
  options: DriveSuggestionProviderOptions,
): readonly SuggestionSlotProviderCapability[] {
  return driveSuggestionSlotIds.map((slotId) => createProvider(slotId, options));
}

function createProvider(
  slotId: DriveSuggestionSlotId,
  options: DriveSuggestionProviderOptions,
): SuggestionSlotProviderCapability {
  return {
    slotId,
    available: async (ctx) => ctx.feature === slotId || ctx.feature.length === 0,
    generate: async function* generate(ctx): AsyncIterable<SuggestionChunk> {
      const classification = classificationFromInput(ctx.input) ?? options.defaultClassification ?? "standard";
      const response = await options.ai.chat(toChatRequest(slotId, ctx, classification), {
        actor: ctx.actor,
        feature: slotId,
        classification,
      });
      yield {
        text: response.message,
        done: true,
        metadata: {
          providerId: response.providerId,
          model: response.model,
          ...(response.metadata ?? {}),
        },
      };
    },
  };
}

function toChatRequest(
  slotId: DriveSuggestionSlotId,
  ctx: SuggestionContext,
  classification: AIClassification,
): ChatRequest {
  return {
    feature: slotId,
    classification,
    messages: [
      {
        role: "system",
        content: systemPrompt(slotId),
      },
      {
        role: "user",
        content: suggestionInputText(slotId, ctx),
      },
    ],
    metadata: {
      slotId,
      ...(ctx.resource === undefined
        ? {}
        : {
            resource: {
              type: ctx.resource.type,
              ...(ctx.resource.id === undefined ? {} : { id: ctx.resource.id }),
              ...(ctx.resource.orgId === undefined ? {} : { orgId: ctx.resource.orgId }),
              ...(ctx.resource.attributes === undefined ? {} : { attributes: ctx.resource.attributes }),
            },
          }),
    },
  };
}

function systemPrompt(slotId: DriveSuggestionSlotId): string {
  if (slotId === "drive.describe-image") {
    return "Describe the image using only the supplied file context, extracted text, or image reference. Note uncertainty clearly.";
  }
  return "Summarize the drive file with concise key points, decisions, risks, and action items. Do not invent missing facts.";
}

function suggestionInputText(slotId: DriveSuggestionSlotId, ctx: SuggestionContext): string {
  const input = ctx.input ?? {};
  const name = stringInput(input, "name") ?? stringInput(input, "filename");
  const mimeType = stringInput(input, "mimeType") ?? stringInput(input, "contentType");
  const path = arrayInput(input, "path").map(formatJsonValue).filter(hasText).join(" / ");
  const tags = arrayInput(input, "tags").map(formatJsonValue).filter(hasText).join(", ");
  const imageUrl = stringInput(input, "imageUrl") ?? stringInput(input, "url");
  const previewText = stringInput(input, "previewText") ?? stringInput(input, "text") ?? stringInput(input, "content");
  const ocrText = stringInput(input, "ocrText");
  const priorSummary = stringInput(input, "summary");
  const prompt = stringInput(input, "prompt");

  return [
    `Task: ${slotId}`,
    name === undefined ? "" : `Name: ${name}`,
    mimeType === undefined ? "" : `MIME type: ${mimeType}`,
    path.length === 0 ? "" : `Path: ${path}`,
    tags.length === 0 ? "" : `Tags: ${tags}`,
    imageUrl === undefined ? "" : `Image reference: ${imageUrl}`,
    priorSummary === undefined ? "" : `Existing summary: ${priorSummary}`,
    ocrText === undefined ? "" : `OCR text: ${ocrText}`,
    previewText === undefined ? "" : `File text: ${previewText}`,
    prompt === undefined ? "" : `User prompt: ${prompt}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function classificationFromInput(input: JsonObject | undefined): AIClassification | undefined {
  const value = input?.classification;
  return value === "public" || value === "standard" || value === "confidential" || value === "restricted"
    ? value
    : undefined;
}

function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function arrayInput(input: JsonObject, key: string): readonly JsonValue[] {
  const value = input[key];
  return isJsonArray(value) ? value : [];
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isJsonObject(value)) {
    return stringInput(value, "name") ?? stringInput(value, "label") ?? stringInput(value, "id") ?? "";
  }
  return "";
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonArray(value: JsonValue | undefined): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function hasText(value: string): boolean {
  return value.length > 0;
}
