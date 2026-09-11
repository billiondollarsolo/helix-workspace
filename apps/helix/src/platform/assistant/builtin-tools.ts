import type { Actor, JsonObject, JsonValue } from "@helix/sdk-types";
import {
  invokeToolServer,
  parsePrefixedToolId,
  type ToolServerConfig,
} from "../ai/tool-servers.js";
import { searchChats, viewChat } from "./chats.js";
import { grepSources, pageSource } from "./context-tools.js";
import { createTasks, tasksFromMetadata, updateTask, type TaskStatus } from "./tasks.js";
import type {
  AssistantConversation,
  AssistantSource,
  AssistantStore,
  AssistantToolActivity,
  AssistantToolCallResult,
} from "./types.js";

export function toolActivity(result: AssistantToolCallResult): AssistantToolActivity {
  return {
    toolCallId: result.toolCallId,
    toolId: result.toolId,
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

export async function invokeBuiltinAssistantTool(input: {
  readonly actor: Actor;
  readonly conversation: AssistantConversation;
  readonly sources: readonly AssistantSource[];
  readonly toolCallId: string;
  readonly toolId: string;
  readonly input: JsonObject;
  readonly sourceIds: readonly string[];
  readonly store: AssistantStore;
  readonly toolServers?: () => readonly ToolServerConfig[];
}): Promise<AssistantToolCallResult | undefined> {
  const failed = (error: string): AssistantToolCallResult => ({
    toolCallId: input.toolCallId,
    toolId: input.toolId,
    input: input.input,
    status: "failed",
    error,
    sourceIds: input.sourceIds,
  });
  const executed = (output: unknown): AssistantToolCallResult => ({
    toolCallId: input.toolCallId,
    toolId: input.toolId,
    input: input.input,
    status: "executed",
    output: JSON.parse(JSON.stringify(output)) as JsonValue,
    sourceIds: input.sourceIds,
  });
  if (
    (input.toolId.startsWith("memory.") || input.toolId.startsWith("chats.")) &&
    !input.conversation.memoryOptIn
  )
    return failed("Memory is off for this conversation. Ask the user to enable Assistant memory.");
  if (input.toolId === "chats.search") {
    if (typeof input.input.query !== "string") return failed("query is required.");
    try {
      return executed(
        await searchChats(input.store, {
          orgId: input.actor.orgId,
          actorId: input.actor.id,
          conversationId: input.conversation.id,
          query: input.input.query,
          ...(typeof input.input.limit === "number" ? { limit: input.input.limit } : {}),
        }),
      );
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Could not search conversations.");
    }
  }
  if (input.toolId === "chats.view") {
    if (typeof input.input.conversationId !== "string")
      return failed("conversationId is required.");
    try {
      return executed(
        await viewChat(input.store, {
          orgId: input.actor.orgId,
          actorId: input.actor.id,
          conversationId: input.input.conversationId,
          currentConversationId: input.conversation.id,
        }),
      );
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Could not read that conversation.");
    }
  }
  if (input.toolId === "context.view") {
    if (typeof input.input.sourceId !== "string") return failed("sourceId is required.");
    try {
      return executed(
        pageSource(
          input.sources,
          input.input.sourceId,
          typeof input.input.offset === "number" ? input.input.offset : 0,
          typeof input.input.limit === "number" ? input.input.limit : 2_000,
        ),
      );
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Could not read that source.");
    }
  }
  if (input.toolId === "context.grep") {
    if (typeof input.input.pattern !== "string") return failed("pattern is required.");
    try {
      return executed({
        matches: grepSources(
          input.sources,
          input.input.pattern,
          typeof input.input.sourceId === "string" ? input.input.sourceId : undefined,
        ),
      });
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Could not search sources.");
    }
  }
  if (input.toolId === "tasks.list")
    return executed({ tasks: tasksFromMetadata(input.conversation.metadata) });
  if (input.toolId === "tasks.create") {
    const titles = Array.isArray(input.input.titles)
      ? input.input.titles.filter((title): title is string => typeof title === "string")
      : [];
    try {
      const next = createTasks(input.conversation.metadata, titles);
      await input.store.patchConversationMetadata({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        conversationId: input.conversation.id,
        metadata: next.metadata,
      });
      return executed({ tasks: next.tasks });
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Could not create tasks.");
    }
  }
  if (input.toolId === "tasks.update") {
    if (typeof input.input.id !== "string" || typeof input.input.status !== "string")
      return failed("id and status are required.");
    try {
      const next = updateTask(
        input.conversation.metadata,
        input.input.id,
        input.input.status as TaskStatus,
      );
      await input.store.patchConversationMetadata({
        orgId: input.actor.orgId,
        actorId: input.actor.id,
        conversationId: input.conversation.id,
        metadata: next.metadata,
      });
      return executed({ tasks: next.tasks });
    } catch (error) {
      return failed(error instanceof Error ? error.message : "Could not update the task.");
    }
  }
  if (parsePrefixedToolId(input.toolId) !== undefined) {
    try {
      return executed(
        await invokeToolServer(input.toolServers?.() ?? [], input.toolId, input.input),
      );
    } catch (error) {
      return failed(error instanceof Error ? error.message : "External tool failed.");
    }
  }
  return undefined;
}

export { askUserResult } from "./ask-user.js";
