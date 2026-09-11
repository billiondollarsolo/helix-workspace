import { isJsonObject, type AIMessage, type ChatRequest } from "@helix/sdk-types";

/** Per-request aliases keep arbitrary Helix IDs reversible within OpenAI's 64-character name limit. */
export function openAIRequest(request: ChatRequest) {
  const names = new Map<string, string>();
  const nameFor = (id: string) => {
    let name = names.get(id);
    if (name === undefined) {
      const base = id.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 48) || "tool";
      name = base;
      for (let suffix = 1; [...names.values()].includes(name); suffix += 1)
        name = `${base}_${String(suffix)}`;
      names.set(id, name);
    }
    return name;
  };
  const allowed = new Set(request.tools ?? []);
  const visible = request.metadata?.visibleTools;
  const definitions = new Map<string, Record<string, unknown>>();
  if (Array.isArray(visible))
    for (const tool of visible) {
      if (
        !isJsonObject(tool) ||
        typeof tool.id !== "string" ||
        !allowed.has(tool.id) ||
        !isJsonObject(tool.inputSchema)
      )
        continue;
      definitions.set(tool.id, tool);
    }
  if (definitions.size > 128)
    throw new Error(
      "OpenAI-compatible providers accept at most 128 tools; select a smaller tool catalog for this request.",
    );
  const pending = new Set<string>();
  const messages = mergeLeadingSystem(
    request.messages.map((message, index): Record<string, unknown> => {
      if (message.role === "tool") {
        if (message.toolCallId && pending.delete(message.toolCallId))
          return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
        return {
          role: "user",
          content: `Untrusted tool context (${message.name ?? "workspace"}):\n${message.content}`,
        };
      }
      pending.clear();
      const responses = followingToolResponses(
        request.messages,
        index,
        new Set(message.toolCalls?.map((call) => call.callId)),
      );
      const calls =
        message.role === "assistant"
          ? message.toolCalls?.flatMap((call) => {
              if (!call.callId || !responses.has(call.callId)) return [];
              pending.add(call.callId);
              return [
                {
                  id: call.callId,
                  type: "function",
                  function: { name: nameFor(call.id), arguments: JSON.stringify(call.input ?? {}) },
                },
              ];
            })
          : undefined;
      return {
        role: message.role,
        content: openAIMessageContent(message, Boolean(calls?.length)),
        ...(calls?.length ? { tool_calls: calls } : {}),
      };
    }),
  );
  const tools = [...definitions].map(([id, tool]) => ({
    type: "function",
    function: {
      name: nameFor(id),
      description: typeof tool.description === "string" ? tool.description : nameFor(id),
      parameters: tool.inputSchema,
    },
  }));
  if (tools.length) {
    const ids = [...definitions.keys()].sort((a, b) => b.length - a.length);
    const displayIds = new RegExp(
      ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"),
      "gu",
    );
    // Trusted slash instructions and native definitions must use the same callable names.
    for (const message of messages)
      if (message.role === "system")
        message.content = String(message.content).replace(displayIds, (id) => nameFor(id));
    const instructions = "Invoke only the exact function names in the supplied native tools.";
    const system = messages.find((message) => message.role === "system");
    if (system === undefined) messages.unshift({ role: "system", content: instructions });
    else system.content = `${String(system.content)}\n\n${instructions}`;
  }
  return {
    body: {
      messages,
      ...(tools.length ? { tools } : {}),
      ...(request.tools?.length === 0 ? { tool_choice: "none" as const } : {}),
    },
    toolIds: new Map([...names].map(([id, name]) => [name, id])),
  };
}

function openAIMessageContent(message: AIMessage, hasCalls: boolean): unknown {
  if (message.role === "user" && message.images !== undefined && message.images.length > 0)
    return [
      ...(message.content.length === 0 ? [] : [{ type: "text", text: message.content }]),
      ...message.images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      })),
    ];
  if (message.role === "assistant" && hasCalls && message.content.trim().length === 0) return null;
  return message.content;
}

function mergeLeadingSystem(
  messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const extras: string[] = [];
  const kept: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "system" && kept.some((entry) => entry.role === "system")) {
      extras.push(String(message.content));
      continue;
    }
    kept.push(message);
  }
  if (extras.length === 0) return kept;
  const system = kept.find((message) => message.role === "system");
  if (system !== undefined) system.content = `${String(system.content)}\n\n${extras.join("\n\n")}`;
  else kept.unshift({ role: "system", content: extras.join("\n\n") });
  return kept;
}

function followingToolResponses(
  messages: readonly AIMessage[],
  index: number,
  expectedIds: ReadonlySet<string | undefined>,
) {
  const ids = new Set<string>();
  for (let next = index + 1; next < messages.length; next += 1) {
    const message = messages[next];
    if (
      message?.role !== "tool" ||
      !message.toolCallId ||
      !expectedIds.has(message.toolCallId) ||
      ids.has(message.toolCallId)
    )
      break;
    if (message.toolCallId) ids.add(message.toolCallId);
  }
  return ids;
}
