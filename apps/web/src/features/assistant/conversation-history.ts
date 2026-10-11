/* Turning a saved assistant turn into the messages the conversation shows. */

import type { AssistantSource, AssistantTurnResponseWithPendingConfirmations } from "./api";
import { assistantNowTime, type AssistantChatMessage } from "./assistant-data";

/** Workspace citations are only on the live turn; keep them on its answer. */
export function withTurnSources(
  conversation: readonly AssistantChatMessage[],
  sources: readonly AssistantSource[] | undefined,
): readonly AssistantChatMessage[] {
  const cited = (sources ?? []).filter((source) => !source.type.startsWith("web."));
  const last = conversation.at(-1);
  if (cited.length === 0 || last?.role !== "assistant") return conversation;
  return [...conversation.slice(0, -1), { ...last, sources: [...cited, ...(last.sources ?? [])] }];
}
/** Builds a UI conversation from a turn's persisted `messages`, or null. */
export function hydrateConversation(
  turn: AssistantTurnResponseWithPendingConfirmations,
): readonly AssistantChatMessage[] | null {
  const messages = turn.messages;
  if (messages === undefined || messages.length === 0) {
    return null;
  }
  // Each tool round persists cumulative details; show them once, on the last
  // assistant message before the next user turn, including pending-only replies.
  const finalAssistantIds = new Set<string>();
  let hasLaterAssistant = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") hasLaterAssistant = false;
    if (message?.role === "assistant" && !hasLaterAssistant) {
      finalAssistantIds.add(message.id);
      hasLaterAssistant = true;
    }
  }
  const visible = messages.filter(
    (message) =>
      message.role === "user" ||
      (message.role === "assistant" &&
        (message.content.trim().length > 0 ||
          (finalAssistantIds.has(message.id) &&
            (message.toolActivity?.length || message.sources?.length)))),
  );
  if (visible.length === 0) {
    return null;
  }
  return visible.map((message) => ({
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    text: message.content,
    ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
    ...(message.sources === undefined || !finalAssistantIds.has(message.id)
      ? {}
      : { sources: message.sources }),
    ...(message.toolActivity === undefined || !finalAssistantIds.has(message.id)
      ? {}
      : { toolActivity: message.toolActivity }),
    ...(message.toolGroups === undefined ? {} : { toolGroups: message.toolGroups }),
    ...(message.webSearch === undefined ? {} : { webSearch: message.webSearch }),
    time:
      message.createdAt === undefined
        ? assistantNowTime()
        : assistantNowTime(new Date(message.createdAt)),
  }));
}
