import type { Actor, AICapability, RequestContext } from "@helix/sdk-types";
import { aiCallContext } from "./orchestrator-prompt.js";
import type { AssistantStore, AssistantTurnResponse } from "./types.js";

const titleSystem =
  "Generate a concise 3-5 word title for this chat. No quotes, no emoji required, no prefix like Title:. Reply with the title only.";

export function parseGeneratedTitle(raw: string): string | undefined {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/giu, "").trim();
  let candidate = text;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") candidate = parsed;
    else if (
      typeof parsed === "object" &&
      parsed !== null &&
      "title" in parsed &&
      typeof parsed.title === "string"
    )
      candidate = parsed.title;
  } catch {
    candidate = text.split("\n")[0]?.trim() ?? "";
  }
  candidate = candidate
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/^title:\s*/iu, "")
    .trim();
  if (candidate.length < 2 || candidate.length > 80) return undefined;
  return candidate;
}

export async function titleAfterFirstTurn(
  options: {
    readonly store: AssistantStore;
    readonly ai: AICapability;
    readonly generateTitles?: boolean;
  },
  input: {
    readonly actor: Actor;
    readonly content: string;
    readonly title?: string;
    readonly request?: RequestContext;
  },
  turn: AssistantTurnResponse,
): Promise<AssistantTurnResponse> {
  try {
    const users = turn.messages.filter((message) => message.role === "user").length;
    const model = turn.ai.model;
    return await applyGeneratedTitle({
      store: options.store,
      ai: options.ai,
      actor: input.actor,
      user: input.content,
      enabled: options.generateTitles === true && input.title === undefined && users === 1,
      turn,
      ...(typeof model === "string" && model.length > 0 ? { model } : {}),
      ...(input.request === undefined ? {} : { request: input.request }),
    });
  } catch {
    return turn;
  }
}

export async function applyGeneratedTitle(input: {
  readonly store: AssistantStore;
  readonly ai: AICapability;
  readonly actor: Actor;
  readonly user: string;
  readonly model?: string;
  readonly request?: RequestContext;
  readonly enabled: boolean;
  readonly turn: AssistantTurnResponse;
}): Promise<AssistantTurnResponse> {
  if (!input.enabled || input.turn.pendingConfirmations.length > 0) return input.turn;
  const assistant = input.turn.response.content.trim();
  if (assistant.length === 0) return input.turn;
  try {
    const result = await input.ai.chat(
      {
        feature: "assistant.title",
        tools: [],
        ...(input.model === undefined ? {} : { model: input.model }),
        messages: [
          { role: "system", content: titleSystem },
          {
            role: "user",
            content: `User: ${input.user.slice(0, 500)}\nAssistant: ${assistant.slice(0, 500)}`,
          },
        ],
      },
      aiCallContext(input.actor, input.request, input.turn.effectiveClassification),
    );
    if (!("message" in result)) return input.turn;
    const title = parseGeneratedTitle(result.message);
    if (title === undefined || title === assistant) return input.turn;
    const conversation = await input.store.renameConversation({
      orgId: input.actor.orgId,
      actorId: input.actor.id,
      conversationId: input.turn.conversation.id,
      title,
    });
    return { ...input.turn, conversation };
  } catch {
    return input.turn;
  }
}
