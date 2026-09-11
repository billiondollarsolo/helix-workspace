import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { AICallContext, ChatRequest } from "@helix/sdk-types";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { openAIRequest } from "./openai-tools.js";
import { collectChatChunks } from "./shared.js";

const context: AICallContext = {
  actor: { id: "person", orgId: "org", type: "user" },
  feature: "assistant.chat",
  classification: "standard",
};
const request: ChatRequest = {
  feature: "assistant.chat",
  messages: [{ role: "user", content: "List my files" }],
  tools: ["drive.list"],
  metadata: {
    visibleTools: [
      {
        id: "drive.list",
        description: "List visible files",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
      { id: "mail.send", description: "Send mail", inputSchema: { type: "object" } },
    ],
  },
};
const provider = (fetchImpl: typeof fetch) =>
  createOpenAICompatibleProvider({
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [{ id: "test-model" }],
    fetch: fetchImpl,
  });

describe("native OpenAI-compatible tools", () => {
  it.each([400, 401, 403, 404, 429])(
    "returns actionable HTTP %s errors without exposing upstream response contents",
    async (status) => {
      const llm = provider(
        async () => new Response("provider private response secret", { status }),
      );
      await expect(llm.chat(request, context)).rejects.toMatchObject({
        statusCode: status === 429 ? 429 : 422,
      });
      try {
        await llm.chat(request, context);
      } catch (error) {
        expect((error as Error).message).not.toContain("provider private response secret");
        expect((error as Error).message).toMatch(/provider|model/iu);
      }
    },
  );

  it.each(["chat", "stream"])("cancels an in-flight %s HTTP response", async (mode) => {
    const server = createServer((_req, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const llm = createOpenAICompatibleProvider({
      id: "local-test",
      baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      models: [{ id: "test-model" }],
      fetch,
    });
    const controller = new AbortController();
    try {
      const arrived = once(server, "request");
      const pending =
        mode === "chat"
          ? llm.chat({ ...request, signal: controller.signal }, context)
          : collectChatChunks(requiredStream(llm, controller.signal), "local-test", "test-model");
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await arrived;
      controller.abort();
      await rejected;
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
  it("exposes only requested visible schemas with reversible valid names", () => {
    const built = openAIRequest(request);
    expect(built.body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "drive_list",
          description: "List visible files",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
    ]);
    expect(built.toolIds.get("drive_list")).toBe("drive.list");
    expect(built.body.messages[0]).toMatchObject({
      role: "system",
      content: "Invoke only the exact function names in the supplied native tools.",
    });
    expect(built.body.messages[1]).toEqual({ role: "user", content: "List my files" });
    expect(
      openAIRequest({
        ...request,
        tools: [],
        messages: [
          {
            role: "user",
            content: "What is in this photo?",
            images: [{ mimeType: "image/png", data: "abc" }],
          },
        ],
      }).body.messages[0],
    ).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is in this photo?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
    expect(openAIRequest({ ...request, tools: ["missing.tool"] }).body).not.toHaveProperty("tools");
    const ids = Array.from({ length: 129 }, (_, index) => `tool.${String(index)}`);
    expect(() =>
      openAIRequest({
        ...request,
        tools: ids,
        metadata: { visibleTools: ids.map((id) => ({ id, inputSchema: { type: "object" } })) },
      }),
    ).toThrow("at most 128 tools");
  });

  it("replays matched native IDs and treats retrieval, orphan, and resumed results as untrusted context", () => {
    const result = openAIRequest({
      ...request,
      messages: [
        { role: "tool", name: "workspace_search", content: "retrieval" },
        { role: "tool", toolCallId: "orphan", name: "mail.send", content: "orphan result" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "drive.list", callId: "call-native", input: {} }],
        },
        { role: "tool", name: "drive.list", toolCallId: "call-native", content: "files" },
        {
          role: "tool",
          name: "drive.list",
          toolCallId: "call-native",
          content: "already answered",
        },
        {
          role: "tool",
          name: "mail.send",
          toolCallId: "pending-action-uuid",
          content: "approved later",
        },
        {
          role: "assistant",
          content: "Pending",
          toolCalls: [{ id: "mail.send", callId: "unanswered" }],
        },
        { role: "user", content: "Continue" },
      ],
    });
    const history = result.body.messages.filter((message) => message.role !== "system");
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
      "tool",
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(history[2]).toMatchObject({
      tool_calls: [{ id: "call-native", function: { name: "drive_list", arguments: "{}" } }],
    });
    expect(history[3]).toEqual({
      role: "tool",
      content: "files",
      tool_call_id: "call-native",
    });
    expect(history[6]).not.toHaveProperty("tool_calls");
    expect(result.body.messages.every((message) => !("name" in message))).toBe(true);
  });

  it("preserves completed native history while explicitly disabling new calls for the final answer", () => {
    const built = openAIRequest({
      ...request,
      tools: [],
      messages: [
        { role: "system", content: "Give the final answer from the results already obtained." },
        { role: "user", content: "List my files" },
        {
          role: "assistant",
          content: "Checking the file list.",
          toolCalls: [{ id: "drive.list", callId: "call-native", input: {} }],
        },
        {
          role: "tool",
          name: "drive.list",
          toolCallId: "call-native",
          content: "Visible file: report.txt",
        },
      ],
    });
    expect(built.body).not.toHaveProperty("tools");
    expect(built.body.tool_choice).toBe("none");
    expect(built.toolIds.get("drive_list")).toBe("drive.list");
    expect(built.body.messages).toEqual([
      { role: "system", content: "Give the final answer from the results already obtained." },
      { role: "user", content: "List my files" },
      {
        role: "assistant",
        content: "Checking the file list.",
        tool_calls: [
          {
            id: "call-native",
            type: "function",
            function: { name: "drive_list", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-native", content: "Visible file: report.txt" },
    ]);
  });

  it("replays completed historical calls even when a different current tool category is selected", () => {
    const built = openAIRequest({
      ...request,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "chat.room.list", callId: "prior-chat", input: {} }],
        },
        { role: "tool", toolCallId: "prior-chat", content: "Previous room list" },
        { role: "user", content: "Now list Drive files" },
      ],
    });
    expect(built.body.tools?.map((tool) => tool.function.name)).toEqual(["drive_list"]);
    expect(built.body.messages).toContainEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "prior-chat",
          type: "function",
          function: { name: "chat_room_list", arguments: "{}" },
        },
      ],
    });
    expect(built.body.messages).toContainEqual({
      role: "tool",
      tool_call_id: "prior-chat",
      content: "Previous room list",
    });
    expect(built.body).not.toHaveProperty("tool_choice");
  });

  it("merges extra system messages into the leading system prompt", () => {
    const built = openAIRequest({
      ...request,
      tools: [],
      messages: [
        { role: "system", content: "You are Helix Assistant." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "system", content: "The tool-call budget is exhausted. Give your final answer." },
      ],
    });
    expect(built.body.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(built.body.messages[0]).toEqual({
      role: "system",
      content:
        "You are Helix Assistant.\n\nThe tool-call budget is exhausted. Give your final answer.",
    });
    expect(built.body.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("adds alias guidance to the existing system prompt without changing canonical user content", () => {
    const messages = [
      { role: "system" as const, content: "Use drive.list to inspect files." },
      { role: "user" as const, content: "Call drive.list" },
    ];
    const built = openAIRequest({ ...request, messages });
    expect(built.body.messages[0]).toEqual({
      role: "system",
      content: expect.stringContaining(
        "Use drive_list to inspect files.\n\nInvoke only the exact function names",
      ),
    });
    expect(built.body.messages[0]?.content).not.toContain("=>");
    expect(built.body.messages[1]).toEqual(messages[1]);
    expect(messages[0]?.content).toBe("Use drive.list to inspect files.");
  });

  it("keeps colliding and long display IDs uniquely reversible", () => {
    const ids = ["web.search", "web_search_1", "web_search", "x".repeat(90)];
    const built = openAIRequest({
      ...request,
      tools: ids,
      metadata: { visibleTools: ids.map((id) => ({ id, inputSchema: { type: "object" } })) },
    });
    const names = built.body.tools?.map((tool) => tool.function.name) ?? [];
    expect(new Set(names).size).toBe(ids.length);
    expect(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/u.test(name))).toBe(true);
    expect(names.map((name) => built.toolIds.get(name))).toEqual(ids);
  });

  it("sends schemas to the correct Groq endpoint and preserves nonstreamed provider call IDs", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call-groq",
                  function: { name: "drive_list", arguments: '{"query":"launch"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const response = await provider(fetchImpl).chat(request, context);
    expect(response).toMatchObject({
      toolCalls: [{ id: "drive.list", callId: "call-groq", input: { query: "launch" } }],
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    assert(url instanceof URL && typeof init?.body === "string");
    expect(url.href).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({
      tools: [{ function: { name: "drive_list" } }],
    });
  });

  it("assembles interleaved streamed native IDs and fragmented names/arguments", async () => {
    const frames = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-stream",
                  function: { name: "drive_", arguments: '{"query":' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: "list", arguments: '"launch"}' } }],
            },
          },
        ],
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const stream = provider(fetchImpl).chatStream?.(request, context);
    assert(stream);
    expect((await collectChatChunks(stream, "groq", "test-model")).toolCalls).toEqual([
      { id: "drive.list", callId: "call-stream", input: { query: "launch" } },
    ]);
  });

  it("passes cancellation to both fetch paths and avoids starting already-aborted requests", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const llm = provider(fetchImpl);
    const stream = llm.chatStream?.({ ...request, signal: controller.signal }, context);
    assert(stream);
    await collectChatChunks(stream, "groq", "test-model");
    controller.abort();
    await expect(
      llm.chat({ ...request, signal: controller.signal }, context),
    ).rejects.toMatchObject({ name: "AbortError" });
    const aborted = llm.chatStream?.({ ...request, signal: controller.signal }, context);
    assert(aborted);
    await expect(collectChatChunks(aborted, "groq", "test-model")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("provider response failures", () => {
  it.each([
    [
      'data: {"error":{"code":"tool_use_failed","failed_generation":"private-provider-content"}}\n\n',
      422,
    ],
    [
      'event: error\ndata: {"error":{"type":"rate_limit_error","message":"private-provider-content"}}\n\n',
      429,
    ],
    ['data: {"error":{"message":"private-provider-content"}}\n\n', 503],
    [
      'data: {"choices":[{"delta":{"reasoning":"private-provider-content"}}]}\n\ndata: [DONE]\n\n',
      503,
    ],
    ["data: {invalid-private-provider-content\n\n", 503],
    ["data: [DONE]\n\n", 503],
  ])(
    "does not turn rejected, malformed, or empty SSE into a saved empty success",
    async (body, statusCode) => {
      const llm = provider(
        async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
      const failure: unknown = await collectChatChunks(
        requiredStream(llm, new AbortController().signal),
        "groq",
        "test-model",
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ statusCode });
      expect(String(failure)).not.toContain("private-provider-content");
    },
  );

  it("rejects JSON success bodies on the SSE route without leaking their content", async () => {
    const llm = provider(async () => Response.json({ error: "private-provider-content" }));
    await expect(
      collectChatChunks(requiredStream(llm, new AbortController().signal), "groq", "test-model"),
    ).rejects.toThrow("did not return an event stream");
  });

  it("redacts malformed successful JSON parse errors", async () => {
    const llm = provider(
      async () =>
        new Response("private-provider-content", {
          headers: { "content-type": "application/json" },
        }),
    );
    const failure: unknown = await Promise.resolve(llm.chat(request, context)).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ statusCode: 503 });
    expect(String(failure)).toContain("invalid JSON");
    expect(String(failure)).not.toContain("private-provider-content");
  });
});

function requiredStream(llm: ReturnType<typeof provider>, signal: AbortSignal) {
  const stream = llm.chatStream?.({ ...request, signal }, context);
  assert(stream);
  return stream;
}
