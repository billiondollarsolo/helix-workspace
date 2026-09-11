import assert from "node:assert/strict";
import type { AICallContext, ChatRequest } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider } from "./openai-compatible.js";
import { collectChatChunks, openAIChatChunks, toolCallsFromOpenAIMessage } from "./shared.js";

const context: AICallContext = {
  actor: { id: "person", orgId: "org", type: "user" },
  feature: "assistant.chat",
  classification: "standard",
};
const request: ChatRequest = {
  feature: "assistant.chat",
  messages: [{ role: "user", content: "List files" }],
  tools: ["drive.list"],
  metadata: {
    visibleTools: [{ id: "drive.list", inputSchema: { type: "object", properties: {} } }],
  },
};
const error =
  "The model supplied invalid tool arguments. Return one valid JSON object and try again.";

describe.each(["buffered", "streamed"])("%s malformed native tool arguments", (mode) => {
  it.each([
    undefined,
    "",
    '{"private-provider-arguments":',
    '"private-provider-arguments"',
    "null",
    "[]",
    "42",
    "true",
    { private: "private-provider-arguments" },
  ])("preserves the call identity and returns a safe error for %j", async (argumentsValue) => {
    const response = await respond(argumentsValue, mode);
    expect(response.toolCalls).toEqual([{ id: "drive.list", callId: "call-invalid", error }]);
    expect(JSON.stringify(response.toolCalls)).not.toContain("private-provider-arguments");
    expect(response.toolCalls?.[0]).not.toHaveProperty("input");
  });

  it("accepts an explicit empty argument object without marking a failure", async () => {
    expect((await respond("{}", mode)).toolCalls).toEqual([
      { id: "drive.list", callId: "call-invalid", input: {} },
    ]);
  });
});

it("does not treat a correlation ID as a callable name", async () => {
  const call = { id: "drive.list", arguments: "{}" };
  expect(toolCallsFromOpenAIMessage({ tool_calls: [call] })).toBeUndefined();
  async function* events() {
    yield {
      event: undefined,
      data: JSON.stringify({
        choices: [{ delta: { content: "No valid call", tool_calls: [{ ...call, index: 0 }] } }],
      }),
    };
  }
  const response = await collectChatChunks(openAIChatChunks(events(), "model"), "test", "model");
  expect(response.toolCalls).toBeUndefined();
});

it("does not let a later valid fragment hide malformed streamed arguments", async () => {
  async function* events() {
    for (const argumentsValue of [{ private: "do-not-expose" }, "{}"]) {
      yield {
        event: undefined,
        data: JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    ...(typeof argumentsValue === "object"
                      ? {
                          id: "call-invalid",
                          function: { name: "drive_list", arguments: argumentsValue },
                        }
                      : { function: { arguments: argumentsValue } }),
                  },
                ],
              },
            },
          ],
        }),
      };
    }
  }
  const response = await collectChatChunks(
    openAIChatChunks(events(), "model", new Map([["drive_list", "drive.list"]])),
    "test",
    "model",
  );
  expect(response.toolCalls).toEqual([{ id: "drive.list", callId: "call-invalid", error }]);
});

async function respond(argumentsValue: unknown, mode: string) {
  const provider = createOpenAICompatibleProvider({
    id: "test",
    baseUrl: "https://provider.example/v1",
    models: [{ id: "model" }],
    fetch: async () => {
      const call = {
        id: "call-invalid",
        function: { name: "drive_list", arguments: argumentsValue },
      };
      if (mode === "buffered")
        return Response.json({ choices: [{ message: { content: "", tool_calls: [call] } }] });
      // Fragment even invalid JSON so validation happens only after assembly.
      const parts =
        typeof argumentsValue === "string"
          ? [argumentsValue.slice(0, 2), argumentsValue.slice(2)]
          : [argumentsValue, undefined];
      const frames = parts.map((part, index) => ({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  ...(index === 0 ? { id: call.id } : {}),
                  function: {
                    ...(index === 0 ? { name: call.function.name } : {}),
                    arguments: part,
                  },
                },
              ],
            },
          },
        ],
      }));
      return new Response(
        `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  if (mode === "buffered") {
    const response = await provider.chat(request, context);
    assert("message" in response);
    return response;
  }
  const stream = provider.chatStream?.(request, context);
  assert(stream);
  return collectChatChunks(stream, provider.id, "model");
}
