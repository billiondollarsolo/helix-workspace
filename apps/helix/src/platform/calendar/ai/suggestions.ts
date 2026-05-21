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
import { calendarPluginId } from "../types.js";

export const calendarSuggestionSlotIds = ["calendar.suggest-meeting-time", "calendar.draft-agenda"] as const;

export type CalendarSuggestionSlotId = (typeof calendarSuggestionSlotIds)[number];

export interface CalendarSuggestionSlotDescriptor {
  readonly id: CalendarSuggestionSlotId;
  readonly pluginId: typeof calendarPluginId;
  readonly label: string;
  readonly description: string;
  readonly order: number;
}

export const calendarSuggestionSlots: readonly CalendarSuggestionSlotDescriptor[] = [
  {
    id: "calendar.suggest-meeting-time",
    pluginId: calendarPluginId,
    label: "Suggest meeting time",
    description: "Suggest meeting times from attendee availability",
    order: 10,
  },
  {
    id: "calendar.draft-agenda",
    pluginId: calendarPluginId,
    label: "Draft agenda",
    description: "Draft an agenda for a calendar event",
    order: 20,
  },
];

export interface CalendarSuggestionProviderOptions {
  readonly ai: AICapability;
  readonly defaultClassification?: AIClassification | undefined;
}

export function createCalendarSuggestionSlotProviders(
  options: CalendarSuggestionProviderOptions,
): readonly SuggestionSlotProviderCapability[] {
  return calendarSuggestionSlotIds.map((slotId) => createProvider(slotId, options));
}

function createProvider(
  slotId: CalendarSuggestionSlotId,
  options: CalendarSuggestionProviderOptions,
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
  slotId: CalendarSuggestionSlotId,
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

function systemPrompt(slotId: CalendarSuggestionSlotId): string {
  if (slotId === "calendar.suggest-meeting-time") {
    return "Suggest concise meeting time options from the supplied availability. Do not invent unavailable slots.";
  }
  return "Draft a practical meeting agenda from the supplied event context, goals, attendees, and prior notes.";
}

function suggestionInputText(slotId: CalendarSuggestionSlotId, ctx: SuggestionContext): string {
  const input = ctx.input ?? {};
  const title = stringInput(input, "title") ?? stringInput(input, "subject");
  const purpose = stringInput(input, "purpose") ?? stringInput(input, "goal");
  const duration = numberInput(input, "durationMinutes");
  const timezone = stringInput(input, "timezone");
  const attendees = arrayInput(input, "attendees").map(formatJsonValue).filter(hasText).join(", ");
  const slots = arrayInput(input, "slots").map(formatSlot).filter(hasText).join("\n");
  const notes = stringInput(input, "notes") ?? stringInput(input, "context");
  const currentAgenda = stringInput(input, "agenda");

  return [
    `Task: ${slotId}`,
    title === undefined ? "" : `Title: ${title}`,
    purpose === undefined ? "" : `Purpose: ${purpose}`,
    duration === undefined ? "" : `Duration minutes: ${String(duration)}`,
    timezone === undefined ? "" : `Timezone: ${timezone}`,
    attendees.length === 0 ? "" : `Attendees: ${attendees}`,
    slots.length === 0 ? "" : `Candidate slots:\n${slots}`,
    notes === undefined ? "" : `Context: ${notes}`,
    currentAgenda === undefined ? "" : `Current agenda: ${currentAgenda}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function formatSlot(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isJsonObject(value)) {
    return "";
  }
  const startsAt = stringInput(value, "startsAt");
  const endsAt = stringInput(value, "endsAt");
  if (startsAt === undefined || endsAt === undefined) {
    return "";
  }
  return `${startsAt} to ${endsAt}`;
}

function formatJsonValue(value: JsonValue): string {
  if (typeof value === "string") {
    return value;
  }
  if (isJsonObject(value)) {
    return stringInput(value, "displayName") ?? stringInput(value, "name") ?? stringInput(value, "email") ?? "";
  }
  return "";
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

function numberInput(input: JsonObject, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayInput(input: JsonObject, key: string): readonly JsonValue[] {
  const value = input[key];
  return Array.isArray(value) ? value.filter(isJsonValue) : [];
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  return value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "object";
}

function hasText(value: string): boolean {
  return value.length > 0;
}
