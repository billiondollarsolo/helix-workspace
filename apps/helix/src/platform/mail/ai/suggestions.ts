import type {
  AICapability,
  AIClassification,
  ChatRequest,
  JsonObject,
  SuggestionChunk,
  SuggestionContext,
  SuggestionSlotProviderCapability,
} from "@helix/sdk-types";
import { mailPluginId } from "../types.js";

export const mailSuggestionSlotIds = [
  "mail.compose-help",
  "mail.summarize-thread",
  "mail.suggest-reply",
] as const;

export type MailSuggestionSlotId = (typeof mailSuggestionSlotIds)[number];

export interface MailSuggestionSlotDescriptor {
  readonly id: MailSuggestionSlotId;
  readonly pluginId: typeof mailPluginId;
  readonly label: string;
  readonly description: string;
  readonly order: number;
}

export const mailSuggestionSlots: readonly MailSuggestionSlotDescriptor[] = [
  {
    id: "mail.compose-help",
    pluginId: mailPluginId,
    label: "Compose help",
    description: "Suggest body content while composing",
    order: 10,
  },
  {
    id: "mail.summarize-thread",
    pluginId: mailPluginId,
    label: "Summarize thread",
    description: "Summarize a long mail thread",
    order: 20,
  },
  {
    id: "mail.suggest-reply",
    pluginId: mailPluginId,
    label: "Suggest reply",
    description: "Suggest a short reply to a thread",
    order: 30,
  },
];

export interface MailSuggestionProviderOptions {
  readonly ai: AICapability;
  readonly defaultClassification?: AIClassification | undefined;
}

export function createMailSuggestionSlotProviders(
  options: MailSuggestionProviderOptions,
): readonly SuggestionSlotProviderCapability[] {
  return mailSuggestionSlotIds.map((slotId) => createProvider(slotId, options));
}

function createProvider(
  slotId: MailSuggestionSlotId,
  options: MailSuggestionProviderOptions,
): SuggestionSlotProviderCapability {
  return {
    slotId,
    available: async (ctx) => ctx.feature === slotId || ctx.feature.length === 0,
    generate: async function* generate(ctx): AsyncIterable<SuggestionChunk> {
      const response = await options.ai.chat(toChatRequest(slotId, ctx, options.defaultClassification), {
        actor: ctx.actor,
        feature: slotId,
        classification: classificationFromInput(ctx.input) ?? options.defaultClassification ?? "standard",
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
  slotId: MailSuggestionSlotId,
  ctx: SuggestionContext,
  defaultClassification: AIClassification | undefined,
): ChatRequest {
  const classification = classificationFromInput(ctx.input) ?? defaultClassification ?? "standard";
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
        content: suggestionInputText(ctx),
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

function systemPrompt(slotId: MailSuggestionSlotId): string {
  if (slotId === "mail.compose-help") {
    return "Draft concise, useful email body suggestions. Preserve the sender's intent and do not invent commitments.";
  }
  if (slotId === "mail.summarize-thread") {
    return "Summarize the mail thread with key decisions, open questions, and action items.";
  }
  return "Suggest a brief, natural reply that matches the thread context and avoids unsupported claims.";
}

function suggestionInputText(ctx: SuggestionContext): string {
  const input = ctx.input ?? {};
  const subject = stringInput(input, "subject");
  const body = stringInput(input, "body");
  const thread = stringInput(input, "thread");
  const recipients = arrayInput(input, "recipients").join(", ");
  return [
    subject === undefined ? "" : `Subject: ${subject}`,
    recipients.length === 0 ? "" : `Recipients: ${recipients}`,
    body === undefined ? "" : `Draft/body: ${body}`,
    thread === undefined ? "" : `Thread: ${thread}`,
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

function arrayInput(input: JsonObject, key: string): readonly string[] {
  const value = input[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
