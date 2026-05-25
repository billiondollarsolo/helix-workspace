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
import { docsPluginId } from "../types.js";

export const docsSuggestionSlotIds = [
  "docs.smart-write",
  "docs.summarize",
  "docs.translate",
  "docs.ask-document",
] as const;

export type DocsSuggestionSlotId = (typeof docsSuggestionSlotIds)[number];

export interface DocsSuggestionSlotDescriptor {
  readonly id: DocsSuggestionSlotId;
  readonly pluginId: typeof docsPluginId;
  readonly label: string;
  readonly description: string;
  readonly order: number;
}

export const docsSuggestionSlots: readonly DocsSuggestionSlotDescriptor[] = [
  {
    id: "docs.smart-write",
    pluginId: docsPluginId,
    label: "Smart write",
    description: "Draft or rewrite selected document content",
    order: 10,
  },
  {
    id: "docs.summarize",
    pluginId: docsPluginId,
    label: "Summarize",
    description: "Summarize a document or selected section",
    order: 20,
  },
  {
    id: "docs.translate",
    pluginId: docsPluginId,
    label: "Translate",
    description: "Translate selected document content",
    order: 30,
  },
  {
    id: "docs.ask-document",
    pluginId: docsPluginId,
    label: "Ask this document",
    description: "Answer questions from document context",
    order: 40,
  },
];

export interface DocsSuggestionProviderOptions {
  readonly ai: AICapability;
  readonly defaultClassification?: AIClassification | undefined;
}

export function createDocsSuggestionSlotProviders(
  options: DocsSuggestionProviderOptions,
): readonly SuggestionSlotProviderCapability[] {
  return docsSuggestionSlotIds.map((slotId) => createProvider(slotId, options));
}

function createProvider(
  slotId: DocsSuggestionSlotId,
  options: DocsSuggestionProviderOptions,
): SuggestionSlotProviderCapability {
  return {
    slotId,
    available: async (ctx) => ctx.feature === slotId || ctx.feature.length === 0,
    generate: async function* generate(ctx): AsyncIterable<SuggestionChunk> {
      const classification =
        classificationFromInput(ctx.input) ?? options.defaultClassification ?? "standard";
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
  slotId: DocsSuggestionSlotId,
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
              ...(ctx.resource.attributes === undefined
                ? {}
                : { attributes: ctx.resource.attributes }),
            },
          }),
    },
  };
}

function systemPrompt(slotId: DocsSuggestionSlotId): string {
  if (slotId === "docs.smart-write") {
    return "Write or rewrite document content using the supplied context. Preserve facts, voice, and formatting intent.";
  }
  if (slotId === "docs.translate") {
    return "Translate the selected document content into the requested target language. Preserve structure and do not add facts.";
  }
  if (slotId === "docs.ask-document") {
    return "Answer the user's question using only the supplied document context. If the context does not support an answer, say so directly.";
  }
  return "Summarize the document with concise key points, decisions, open questions, and action items. Do not invent facts.";
}

function suggestionInputText(slotId: DocsSuggestionSlotId, ctx: SuggestionContext): string {
  const input = ctx.input ?? {};
  const title = stringInput(input, "title");
  const selection = stringInput(input, "selection");
  const body =
    stringInput(input, "body") ?? stringInput(input, "markdown") ?? stringInput(input, "text");
  const prompt = stringInput(input, "prompt");
  const targetLanguage = stringInput(input, "targetLanguage") ?? stringInput(input, "language");
  const outline = arrayInput(input, "outline").map(formatOutlineItem).filter(hasText).join("\n");

  return [
    `Task: ${slotId}`,
    title === undefined ? "" : `Title: ${title}`,
    outline.length === 0 ? "" : `Outline:\n${outline}`,
    selection === undefined ? "" : `Selection:\n${selection}`,
    body === undefined ? "" : `Document:\n${body}`,
    targetLanguage === undefined ? "" : `Target language: ${targetLanguage}`,
    prompt === undefined ? "" : `User prompt: ${prompt}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function formatOutlineItem(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isJsonObject(value)) {
    return "";
  }
  const title = stringInput(value, "title") ?? stringInput(value, "label");
  const levelValue = value.level;
  const level = typeof levelValue === "number" ? Math.max(levelValue, 1) : 1;
  return title === undefined ? "" : `${"  ".repeat(level - 1)}- ${title}`;
}

function classificationFromInput(input: JsonObject | undefined): AIClassification | undefined {
  const value = input?.classification;
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? value
    : undefined;
}

function stringInput(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function arrayInput(input: JsonObject, key: string): readonly JsonValue[] {
  const value = input[key];
  return Array.isArray(value) ? (value as readonly JsonValue[]) : [];
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasText(value: string): boolean {
  return value.length > 0;
}
