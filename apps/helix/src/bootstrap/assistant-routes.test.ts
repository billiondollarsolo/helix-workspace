import type { ToolDefinition } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AssistantStreamEvent } from "../platform/assistant/index.js";
import { InMemoryOAuthClientStore, type AccessTokenRecord } from "../platform/auth/oauth.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import {
  formatAssistantSseEvent,
  registerAssistantStreamRoute,
  type AssistantStreamOrchestrator,
} from "./assistant-routes.js";

const now = new Date();
const later = new Date(now.getTime() + 60 * 60 * 1000);

describe("assistant SSE streaming endpoint (PRD §9.5)", () => {
  function fakeStreamOrchestrator(
    events: readonly AssistantStreamEvent[],
    capture?: { input?: unknown },
  ): AssistantStreamOrchestrator {
    return {
      async *sendMessageStream(input) {
        if (capture !== undefined) {
          capture.input = input;
        }
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  const streamEvents: readonly AssistantStreamEvent[] = [
    { type: "delta", text: "Hel", round: 0 },
    { type: "delta", text: "lo", round: 0 },
    {
      type: "final",
      turn: {
        conversation: { id: "conv-1" },
        messages: [],
        response: { id: "msg-1", content: "Hello" },
        ai: { message: "Hello" },
        toolCalls: [],
        sources: [],
        memory: [],
        pendingConfirmations: [],
      } as unknown as Extract<AssistantStreamEvent, { type: "final" }>["turn"],
    },
  ];

  it("emits delta and final SSE frames when the client accepts text/event-stream", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "sse-token",
        actorId: "actor-sse",
        orgId: "org-sse",
        scopes: ["assistant.write"],
      }),
    );
    const capture: { input?: unknown } = {};
    const app = fastify();
    const tools = createToolRegistry();
    tools.register(
      tool({
        id: "assistant.chat",
        permission: "assistant.write",
        handler: async () => {
          throw new Error("JSON handler must not run");
        },
      }),
    );
    registerAssistantStreamRoute(app, {
      orchestrator: fakeStreamOrchestrator(streamEvents, capture),
      tools,
      tokenStore,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/assistant.chat",
      headers: { authorization: "Bearer sse-token", accept: "text/event-stream" },
      payload: { message: "hi" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(
      streamEvents.map((event) => formatAssistantSseEvent(event)).join(""),
    );
    expect(capture.input).toMatchObject({
      actor: { id: "actor-sse", orgId: "org-sse" },
      content: "hi",
    });
    await app.close();
  });

  it("denies streamed calls before invoking the model when the actor lacks assistant.write", async () => {
    const capture: { input?: unknown } = {};
    const tools = createToolRegistry();
    tools.register(
      tool({ id: "assistant.chat", permission: "assistant.write", handler: async () => ({}) }),
    );
    const app = fastify();
    registerAssistantStreamRoute(app, {
      orchestrator: fakeStreamOrchestrator(streamEvents, capture),
      tools,
      tokenStore: new InMemoryOAuthClientStore(),
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/tools/assistant.chat",
        headers: { accept: "text/event-stream" },
        payload: { message: "hi" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("forbidden");
      expect(capture.input).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("returns the canonical HelixError envelope for an invalid streaming body", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "sse-bad-token",
        actorId: "actor-sse-bad",
        orgId: "org-sse-bad",
        scopes: ["assistant.write"],
      }),
    );
    const app = fastify();
    registerAssistantStreamRoute(app, {
      orchestrator: fakeStreamOrchestrator(streamEvents),
      tools: createToolRegistry(),
      tokenStore,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/assistant.chat",
      headers: { authorization: "Bearer sse-bad-token", accept: "text/event-stream" },
      // `message` is required by assistantChatStreamBodySchema.
      payload: { conversationId: "conv-1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    const envelope: {
      error?: { code?: string; message?: string; traceId?: string };
    } = response.json();
    expect(envelope.error?.code).toBe("bad_request");
    expect(typeof envelope.error?.message).toBe("string");
    expect(typeof envelope.error?.traceId).toBe("string");
    expect(envelope.error?.traceId).not.toBe("");
    await app.close();
  });

  it("falls through to the JSON tool path when the client does not accept SSE", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "json-token",
        actorId: "actor-json",
        orgId: "org-json",
        scopes: ["assistant.write"],
      }),
    );
    const tools = createToolRegistry();
    tools.register(
      tool({
        id: "assistant.chat",
        permission: "assistant.write",
        sideEffects: "write",
        handler: async () => ({ response: { content: "plain reply" } }),
      }),
    );
    const app = fastify();
    registerAssistantStreamRoute(app, {
      orchestrator: fakeStreamOrchestrator(streamEvents),
      tools,
      tokenStore,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/assistant.chat",
      headers: { authorization: "Bearer json-token" },
      payload: { message: "hi" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ response: { content: "plain reply" } });
    await app.close();
  });
});

function accessToken(
  input: Pick<AccessTokenRecord, "token" | "actorId" | "orgId" | "scopes"> & {
    readonly actorType?: AccessTokenRecord["actorType"];
  },
): AccessTokenRecord {
  return {
    token: input.token,
    clientId: "client-1",
    actorId: input.actorId,
    orgId: input.orgId,
    actorType: input.actorType ?? "user",
    scopes: input.scopes,
    issuedAt: now,
    expiresAt: later,
  };
}

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object" }),
};

function tool(
  overrides: Partial<ToolDefinition> & Pick<ToolDefinition, "id" | "permission" | "handler">,
): ToolDefinition {
  return {
    description: overrides.id,
    inputSchema: schema,
    outputSchema: schema,
    sideEffects: "read",
    ...overrides,
  };
}
