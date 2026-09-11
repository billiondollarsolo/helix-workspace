import type {
  AICapability,
  AICallContext,
  ChatChunk,
  ChatResponse,
  ChatUsage,
  JsonObject,
} from "@helix/sdk-types";
import type { AssistantMessage, AssistantStreamEvent } from "./types.js";
import { toolCallsFromStreamMetadata } from "./orchestrator-prompt.js";

/** A resumed action supersedes its pending result for native call correlation only. */
export function promptHistory(messages: readonly AssistantMessage[]): readonly AssistantMessage[] {
  const latest = new Map(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => [message.toolCallId, message]),
  );
  const emitted = new Set<string>();
  return messages.flatMap((message) => {
    if (message.role !== "tool" || !message.toolCallId) return [message];
    if (emitted.has(message.toolCallId)) return [];
    emitted.add(message.toolCallId);
    return [latest.get(message.toolCallId) ?? message];
  });
}

export async function* streamChatTurn(
  ai: AICapability,
  request: Parameters<AICapability["chat"]>[0],
  context: Partial<AICallContext>,
  round: number,
): AsyncGenerator<AssistantStreamEvent, ChatResponse> {
  if (ai.chatStream === undefined) {
    const response = await ai.chat(request, context);
    if (response.message.length > 0) {
      yield { type: "delta", text: response.message, round };
    }
    return response;
  }

  let message = "";
  let usage: ChatUsage | undefined;
  let model = request.model ?? "";
  let providerId = "";
  let metadata: JsonObject | undefined;
  for await (const chunk of ai.chatStream(request, context)) {
    request.signal?.throwIfAborted();
    const typed: ChatChunk = chunk;
    if (typed.delta.length > 0) {
      message += typed.delta;
      yield { type: "delta", text: typed.delta, round };
    }
    if (typed.usage !== undefined) {
      usage = typed.usage;
    }
    if (typed.metadata !== undefined) {
      metadata = { ...(metadata ?? {}), ...typed.metadata };
      const metadataModel = typed.metadata.model;
      if (typeof metadataModel === "string" && metadataModel.length > 0) {
        model = metadataModel;
      }
      const metadataProvider = typed.metadata.providerId;
      if (typeof metadataProvider === "string" && metadataProvider.length > 0) {
        providerId = metadataProvider;
      }
    }
  }
  const toolCalls = toolCallsFromStreamMetadata(metadata);
  return {
    message,
    model,
    providerId,
    ...(usage === undefined ? {} : { usage }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}
