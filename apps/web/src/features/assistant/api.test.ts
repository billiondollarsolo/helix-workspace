import { describe, expect, it, vi } from "vitest";
import {
  assistantToolDecisionUrl,
  assistantToolPendingId,
  decideAssistantToolCall,
  deleteAssistantConversation,
  forgetAssistantMemory,
  isAssistantBackendConversationId,
  listAssistantConversations,
  renameAssistantConversation,
  sendAssistantChat,
  setAssistantConversationPinned,
  streamAssistantChat,
} from "./api";

const decisionTurn = {
  conversation: { id: "planning" },
  response: { content: "Action outcome" },
  messages: [{ id: "answer", role: "assistant", content: "Action outcome" }],
};

describe("assistant tool decision API", () => {
  it("builds the assistant confirmation approve tool endpoint", () => {
    expect(
      assistantToolDecisionUrl({
        conversationId: "planning",
        pendingId: "tool/calendar pending",
        decision: "confirm",
      }),
    ).toBe("/api/tools/assistant.confirmation.approve");
  });

  it("builds the assistant confirmation cancel tool endpoint", () => {
    expect(
      assistantToolDecisionUrl({
        conversationId: "planning",
        pendingId: "tool/calendar pending",
        decision: "cancel",
      }),
    ).toBe("/api/tools/assistant.confirmation.cancel");
  });

  it("posts a confirmation request and returns the backend status", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(decisionTurn)));

    await expect(
      decideAssistantToolCall(
        {
          conversationId: "planning",
          pendingId: "pending-calendar",
          decision: "confirm",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({ status: "confirmed", turn: decisionTurn });

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.confirmation.approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "planning",
        pendingId: "pending-calendar",
      }),
    });
  });

  it("preserves the resumed turn and reports failed execution instead of confirmation", async () => {
    const turn = {
      ...decisionTurn,
      toolCalls: [
        {
          toolCallId: "pending-calendar",
          toolId: "calendar.create",
          status: "failed",
          error: "Calendar access was revoked.",
        },
      ],
    };
    await expect(
      decideAssistantToolCall(
        { conversationId: "planning", pendingId: "pending-calendar", decision: "confirm" },
        vi.fn(() => Promise.resolve(Response.json(turn))),
      ),
    ).resolves.toEqual({ status: "failed", error: "Calendar access was revoked.", turn });
  });

  it("does not invent a successful outcome from malformed HTTP200", async () => {
    await expect(
      decideAssistantToolCall(
        { conversationId: "planning", pendingId: "pending-calendar", decision: "confirm" },
        vi.fn(() => Promise.resolve(Response.json({}))),
      ),
    ).rejects.toThrow("Could not read the action result");
  });

  it("posts a cancellation request to the assistant confirmation cancel tool", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(decisionTurn)));

    await expect(
      decideAssistantToolCall(
        {
          conversationId: "planning",
          pendingId: "pending-calendar",
          decision: "cancel",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({ status: "cancelled", turn: decisionTurn });

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.confirmation.cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "planning",
        pendingId: "pending-calendar",
      }),
    });
  });

  it("preserves pending ids embedded on assistant tool calls", () => {
    const toolCall = {
      toolCallId: "tool-call-calendar",
      toolId: "calendar.read",
      pending: {
        id: "pending-embedded",
        toolId: "calendar.read",
      },
    };

    expect(
      assistantToolPendingId(
        {
          toolCalls: [toolCall],
          pendingConfirmations: [{ id: "pending-from-turn", toolId: "calendar.read" }],
        },
        toolCall,
      ),
    ).toBe("pending-embedded");
  });

  it("uses pendingConfirmations ids when a pending tool call does not embed one", () => {
    const toolCall = {
      toolCallId: "tool-call-calendar",
      toolId: "calendar.read",
    };

    expect(
      assistantToolPendingId(
        {
          toolCalls: [toolCall],
          pendingConfirmations: [{ id: "pending-from-turn", toolId: "calendar.read" }],
        },
        toolCall,
      ),
    ).toBe("pending-from-turn");
  });
});

describe("assistant chat API", () => {
  it.each(["json", "stream"])(
    "sends the browser time zone without caller authority or clock metadata (%s)",
    async (mode) => {
      const options = Intl.DateTimeFormat().resolvedOptions();
      const resolvedOptions = vi
        .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
        .mockReturnValue({
          ...options,
          timeZone: "America/New_York",
        });
      const fetchImpl = vi.fn(() =>
        Promise.resolve(Response.json({ response: { content: "Done" } })),
      );
      const input = {
        message: "Weather tomorrow?",
        metadata: {
          timeZone: "Pacific/Auckland",
          actorId: "another-actor",
          scopes: ["*"],
          now: "2030-01-01",
        },
      };
      try {
        if (mode === "stream")
          await streamAssistantChat(input, { onDelta: () => undefined }, fetchImpl);
        else await sendAssistantChat(input, fetchImpl);
        expect(resolvedOptions).toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledWith(
          "/api/tools/assistant.chat",
          expect.objectContaining({
            body: JSON.stringify({
              message: "Weather tomorrow?",
              metadata: { timeZone: "America/New_York" },
            }),
          }),
        );
      } finally {
        resolvedOptions.mockRestore();
      }
    },
  );

  it("serializes a chat request with a backend conversation id and memory opt-in", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          conversation: {
            id: "00000000-0000-4000-8000-000000000123",
          },
          response: {
            content: "Done.",
          },
        }),
      ),
    );

    await expect(
      sendAssistantChat(
        {
          conversationId: "00000000-0000-4000-8000-000000000123",
          memoryOptIn: true,
          message: "Remember that I prefer concise answers.",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({
      conversation: {
        id: "00000000-0000-4000-8000-000000000123",
      },
      response: {
        content: "Done.",
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Remember that I prefer concise answers.",
        metadata: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        conversationId: "00000000-0000-4000-8000-000000000123",
        memoryOptIn: true,
      }),
    });
  });

  it("omits non-UUID mock conversation ids from chat requests", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({})));

    await sendAssistantChat(
      {
        conversationId: "planning",
        memoryOptIn: false,
        message: "Summarize planning.",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Summarize planning.",
        metadata: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        memoryOptIn: false,
      }),
    });
  });

  it("surfaces assistant chat error messages", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({ error: "Chat backend rejected the request." }, { status: 400 }),
      ),
    );

    await expect(
      sendAssistantChat(
        {
          message: "Summarize planning.",
        },
        fetchImpl,
      ),
    ).rejects.toThrow("Chat backend rejected the request.");
  });
});

describe("assistant chat streaming API", () => {
  function sseResponse(frames: readonly string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(frame));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("parses an SSE response, forwarding delta text and resolving the final turn", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          'data: {"type":"delta","text":"Hel"}\n\n',
          'data: {"type":"delta","text":"lo"}\n\n',
          'data: {"type":"final","turn":{"response":{"content":"Hello"}}}\n\n',
        ]),
      ),
    );
    const deltas: string[] = [];

    const turn = await streamAssistantChat(
      { message: "Say hello." },
      { onDelta: (text) => deltas.push(text) },
      fetchImpl,
    );

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(turn.response?.content).toBe("Hello");
  });

  it("forwards only validated thin tool activity, including errors, before a failed stream", async () => {
    const onTool = vi.fn();
    const statuses = ["running", "executed", "failed", "skipped", "pending_confirmation"];
    await expect(
      streamAssistantChat(
        { message: "Find a source", toolGroups: ["mail"] },
        { onDelta: vi.fn(), onTool },
        () =>
          Promise.resolve(
            sseResponse([
              ...statuses.map(
                (status) =>
                  `data: ${JSON.stringify({ type: "tool", toolCallId: "search-1", toolId: "web.search", status, error: "Safe status", input: { query: "private" }, output: { body: "private" } })}\n\n`,
              ),
              'data: {"type":"tool","toolId":"web.search","status":"invented"}\n\n',
              'data: {"type":"error","error":{"message":"Search unavailable. Try again."}}\n\n',
            ]),
          ),
      ),
    ).rejects.toThrow("Search unavailable. Try again.");
    expect(onTool.mock.calls.map(([entry]) => entry)).toEqual(
      statuses.map((status) => ({
        toolCallId: "search-1",
        toolId: "web.search",
        status,
        error: "Safe status",
      })),
    );
  });

  it.each(["json", "stream"])("preserves an explicit empty tool selection (%s)", async (mode) => {
    const fetchImpl = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json({ response: { content: "Done" } })),
    );
    const input = { message: "No workspace tools", toolGroups: [] };
    if (mode === "stream") await streamAssistantChat(input, { onDelta: vi.fn() }, fetchImpl);
    else await sendAssistantChat(input, fetchImpl);
    const body = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(typeof body === "string" ? JSON.parse(body) : null).toMatchObject({ toolGroups: [] });
  });

  it("reassembles SSE frames split across byte-chunk boundaries", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          'data: {"type":"del',
          'ta","text":"split"}\n\n',
          'data: {"type":"final","turn":{"response":{"content":"split"}}}\n\n',
        ]),
      ),
    );
    const deltas: string[] = [];

    const turn = await streamAssistantChat(
      { message: "Split frames." },
      { onDelta: (text) => deltas.push(text) },
      fetchImpl,
    );

    expect(deltas).toEqual(["split"]);
    expect(turn.response?.content).toBe("split");
  });

  it("returns a plain-JSON response once without inventing streaming deltas", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ response: { content: "alpha beta" } })),
    );
    const deltas: string[] = [];

    const turn = await streamAssistantChat(
      { message: "No streaming." },
      { onDelta: (text) => deltas.push(text) },
      fetchImpl,
    );

    expect(deltas).toEqual([]);
    expect(turn.response?.content).toBe("alpha beta");
  });

  it("forwards opaque model ids, file references and cancellation without serializing the signal", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ response: { content: "done" } })),
    );
    await streamAssistantChat(
      {
        message: "Read this",
        modelId: "groq/openai/gpt-oss-20b",
        webSearch: true,
        attachmentObjectIds: ["object-1"],
      },
      { onDelta: () => undefined, signal: controller.signal },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/tools/assistant.chat",
      expect.objectContaining({
        signal: controller.signal,
        body: JSON.stringify({
          message: "Read this",
          metadata: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          modelId: "groq/openai/gpt-oss-20b",
          webSearch: true,
          attachmentObjectIds: ["object-1"],
        }),
      }),
    );
  });

  it("accepts CRLF boundaries and surfaces an SSE error after partial text", async () => {
    const onDelta = vi.fn();
    await expect(
      streamAssistantChat({ message: "test" }, { onDelta }, () =>
        Promise.resolve(
          sseResponse([
            'data: {"type":"delta","text":"partial"}\r\n',
            "\r\n",
            'data: {"type":"error","error":{"message":"Model unavailable. Try again."}}\r\n\r\n',
          ]),
        ),
      ),
    ).rejects.toThrow("Model unavailable. Try again.");
    expect(onDelta).toHaveBeenCalledWith("partial");
  });

  it("rejects incomplete streams and cancels an in-progress reader on Stop", async () => {
    await expect(
      streamAssistantChat({ message: "test" }, { onDelta: () => undefined }, () =>
        Promise.resolve(sseResponse(['data: {"type":"delta","text":"partial"}\n\n'])),
      ),
    ).rejects.toThrow("interrupted");
    const controller = new AbortController();
    const cancel = vi.fn();
    const pending = streamAssistantChat(
      { message: "test" },
      { onDelta: () => undefined, signal: controller.signal },
      () =>
        Promise.resolve(
          new Response(new ReadableStream({ cancel }), {
            headers: { "content-type": "text/event-stream" },
          }),
        ),
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("surfaces streaming chat error messages", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "Streaming backend rejected." }, { status: 502 })),
    );

    await expect(
      streamAssistantChat({ message: "Fail." }, { onDelta: () => undefined }, fetchImpl),
    ).rejects.toThrow("Streaming backend rejected.");
  });
});

describe("assistant memory API", () => {
  it("posts a forget request with a backend conversation id", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          forgottenCount: 2,
          preference: {
            enabled: false,
          },
        }),
      ),
    );

    await expect(
      forgetAssistantMemory(
        {
          conversationId: "00000000-0000-4000-8000-000000000123",
        },
        fetchImpl,
      ),
    ).resolves.toEqual({
      forgottenCount: 2,
      preference: {
        enabled: false,
      },
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.memory.forget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "00000000-0000-4000-8000-000000000123",
      }),
    });
  });

  it("omits non-UUID mock conversation ids from forget requests", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({})));

    await forgetAssistantMemory({ conversationId: "planning" }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.memory.forget", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
  });

  it("surfaces assistant memory forget error messages", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({ error: "Memory backend rejected the request." }, { status: 500 }),
      ),
    );

    await expect(forgetAssistantMemory({}, fetchImpl)).rejects.toThrow(
      "Memory backend rejected the request.",
    );
  });
});

describe("assistant conversation list API", () => {
  it("lists conversations, forwarding the trimmed search query", async () => {
    const page = {
      items: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          title: "Atlas renewal",
          pinned: true,
          pinnedAt: "2026-05-21T09:00:00.000Z",
          memoryOptIn: false,
          updatedAt: "2026-05-21T09:30:00.000Z",
          createdAt: "2026-05-20T09:00:00.000Z",
          messageCount: 4,
          preview: "Atlas is a $420K ARR account.",
        },
      ],
      nextCursor: null,
    };
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json(page)));

    await expect(
      listAssistantConversations({ query: "  atlas  ", limit: 25 }, fetchImpl),
    ).resolves.toEqual(page);

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.conversations.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "atlas", limit: 25 }),
    });
  });

  it("omits an empty search query and defaults the limit", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ items: [], nextCursor: null })));

    await listAssistantConversations({ query: "   " }, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.conversations.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 50 }),
    });
  });

  it("pins and unpins conversations through the matching tool endpoints", async () => {
    const record = {
      id: "00000000-0000-4000-8000-000000000001",
      title: "Atlas renewal",
      pinnedAt: "2026-05-21T09:00:00.000Z",
      memoryOptIn: false,
      updatedAt: "2026-05-21T09:30:00.000Z",
      createdAt: "2026-05-20T09:00:00.000Z",
    };
    const pinFetch = vi.fn(() => Promise.resolve(Response.json(record)));
    await setAssistantConversationPinned({ conversationId: record.id, pinned: true }, pinFetch);
    expect(pinFetch).toHaveBeenCalledWith(
      "/api/tools/assistant.conversation.pin",
      expect.objectContaining({ body: JSON.stringify({ conversationId: record.id }) }),
    );

    const unpinFetch = vi.fn(() => Promise.resolve(Response.json({ ...record, pinnedAt: null })));
    await setAssistantConversationPinned({ conversationId: record.id, pinned: false }, unpinFetch);
    expect(unpinFetch).toHaveBeenCalledWith(
      "/api/tools/assistant.conversation.unpin",
      expect.anything(),
    );
  });

  it("renames a conversation with a trimmed title", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: "00000000-0000-4000-8000-000000000001",
          title: "New title",
          pinnedAt: null,
          memoryOptIn: false,
          updatedAt: "2026-05-21T09:30:00.000Z",
          createdAt: "2026-05-20T09:00:00.000Z",
        }),
      ),
    );

    await renameAssistantConversation(
      { conversationId: "00000000-0000-4000-8000-000000000001", title: "  New title  " },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.conversation.rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        conversationId: "00000000-0000-4000-8000-000000000001",
        title: "New title",
      }),
    });
  });

  it("deletes a conversation through assistant.conversation.delete", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ conversationId: "x", deleted: true })),
    );

    await deleteAssistantConversation(
      { conversationId: "00000000-0000-4000-8000-000000000001" },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/assistant.conversation.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000001" }),
    });
  });

  it("surfaces a HelixError envelope message from a failed conversation tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json(
          { error: { code: "not_found", message: "Unknown assistant conversation." } },
          { status: 404 },
        ),
      ),
    );

    await expect(
      deleteAssistantConversation({ conversationId: "missing" }, fetchImpl),
    ).rejects.toThrow("Unknown assistant conversation.");
  });
});

describe("assistant conversation id serialization", () => {
  it("accepts backend UUID conversation ids and rejects local mock ids", () => {
    expect(isAssistantBackendConversationId("00000000-0000-4000-8000-000000000123")).toBe(true);
    expect(isAssistantBackendConversationId("planning")).toBe(false);
    expect(isAssistantBackendConversationId(undefined)).toBe(false);
  });
});
