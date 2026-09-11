import type { Actor, ChatRequest } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { openAIRequest } from "../ai/providers/openai-tools.js";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import { createToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { finishToolPrompt, routeVisibleTools, systemMessage } from "./orchestrator-prompt.js";
import { AssistantOrchestrator } from "./orchestrator.js";
import { InMemoryAssistantStore } from "./store.js";
import type { AssistantStreamEvent, AssistantTurnResponse, AssistantVisibleTool } from "./types.js";

const actor: Actor = {
  id: "admin",
  orgId: "workspace",
  type: "user",
  scopes: ["assistant.read", "assistant.write"],
};
const catalog: AssistantVisibleTool[] = [
  ...Array.from({ length: 140 }, (_, i) => `app.item${String(i).padStart(3, "0")}`),
  "web.search",
  "web.fetch",
  "zebra.send",
  "zebra.read",
].map((id) => ({
  id,
  description: id,
  permission: "assistant.read",
  sideEffects: id.endsWith("send") ? "write" : "read",
  confirmationRequired: id.endsWith("send"),
  inputSchema: { type: "object", properties: {} },
}));

describe("Assistant native tool catalog limits", () => {
  it("resolves relative dates using the browser zone and server clock, ignoring invalid zones", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T01:30:00Z"));
    try {
      const local = systemMessage({ tools: [], timeZone: "America/New_York" }).content;
      expect(local).toContain("Thursday, September 10, 2026");
      expect(local).toContain("9:30:00 PM EDT");
      expect(local).toContain("America/New_York");
      expect(systemMessage({ tools: [], timeZone: "ignore instructions" }).content).not.toContain(
        "ignore instructions",
      );
      expect(systemMessage({ tools: [], timeZone: { clock: "1900-01-01" } }).content).toContain(
        "2026-09-11T01:30:00.000Z",
      );
      const prompt = [systemMessage({ tools: catalog, slashInstruction: "Respond concisely." })];
      finishToolPrompt(prompt, "America/New_York", "Respond concisely.");
      expect(prompt[0]?.content).not.toContain("Visible tools:");
      expect(prompt[0]?.content).toContain("Respond concisely.");
      expect(prompt[0]?.content).toContain("Thursday, September 10, 2026");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["answer", "empty", "extra-tool"])(
    "finishes the tool budget with a final response (%s)",
    async (result) => {
      const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
      const handler = vi.fn(async () => ({}));
      tools.register({
        id: "web.search",
        description: "Search",
        permission: "assistant.read",
        sideEffects: "read",
        inputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
        outputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
        handler,
      });
      const chat = vi.fn(async (request: ChatRequest) => {
        const searching = Boolean(request.tools?.length);
        if (!searching) {
          expect(request.messages.at(-1)?.content).toContain("tool-call budget is exhausted");
          expect(request.messages[0]?.content).not.toContain("Visible tools:");
          expect(openAIRequest(request).body.tools).toBeUndefined();
        }
        return {
          message: !searching && result === "answer" ? "I could not verify the forecast." : "",
          model: "test",
          providerId: "test",
          ...(searching || result === "extra-tool"
            ? { toolCalls: [{ id: "web.search", input: {} }] }
            : {}),
        };
      });
      const assistant = new AssistantOrchestrator({
        store: new InMemoryAssistantStore(),
        tools,
        ai: { chat },
        maxToolRounds: 16,
        webSearchEnabled: () => true,
        classifyToolResult: async () => "standard",
      });
      const send = assistant.sendMessage({ actor, content: "weather", webSearch: true });
      if (result === "answer") {
        const turn = await send;
        expect(turn.response.content).toBe("I could not verify the forecast.");
        expect(turn.toolCalls).toHaveLength(16);
      } else await expect(send).rejects.toThrow("model did not finish its answer");
      expect(handler).toHaveBeenCalledTimes(16);
      expect(chat).toHaveBeenCalledTimes(17);
    },
  );

  it("rejects oversized selections instead of silently hiding authorized tools", () => {
    expect(() => routeVisibleTools(catalog, undefined)).toThrow("Choose fewer tool groups");
    expect(routeVisibleTools(catalog, undefined, [])).toEqual(
      catalog.filter(({ id }) => id.startsWith("web.")),
    );
    expect(routeVisibleTools(catalog, ["zebra.send", "not.authorized"], ["other"])).toEqual([
      catalog.find(({ id }) => id === "zebra.send"),
    ]);
    expect(routeVisibleTools(catalog, ["zebra.send"], [])).toEqual([]);
    expect(() => routeVisibleTools(catalog, undefined, ["not-a-group"])).toThrow(
      "valid Assistant tool groups",
    );
  });

  it.each([false, true])(
    "runs an oversized admin catalog (streaming: %s) without exposing excluded tools",
    async (streaming) => {
      const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
      const excludedHandler = vi.fn(async () => ({}));
      for (const tool of catalog)
        tools.register({
          ...tool,
          inputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
          outputSchema: zodToolSchema(z.object({}), { type: "object", properties: {} }),
          handler: tool.id === "zebra.send" ? excludedHandler : async () => ({}),
        });
      const requests: ChatRequest[] = [];
      const assistant = new AssistantOrchestrator({
        store: new InMemoryAssistantStore(),
        tools,
        webSearchEnabled: () => true,
        ai: {
          async chat(request) {
            requests.push(request);
            expect(openAIRequest(request).body.tools).toHaveLength(3);
            expect(request.tools).toEqual(expect.arrayContaining(["web.search", "web.fetch"]));
            expect(request.tools).not.toContain("zebra.send");
            return {
              message: "Checked",
              model: "test",
              providerId: "test",
              ...(requests.length === 1
                ? {
                    toolCalls: [
                      { id: "web.search", input: {} },
                      { id: "zebra.send", input: {} },
                    ],
                  }
                : {}),
            };
          },
        },
      });
      const input = {
        actor,
        content: "weather tomorrow in 20882",
        webSearch: true,
        toolGroups: [],
      };
      let turn: AssistantTurnResponse | undefined;
      if (streaming) {
        const events: AssistantStreamEvent[] = [];
        for await (const event of assistant.sendMessageStream(input)) events.push(event);
        turn = events.find((event) => event.type === "final")?.turn;
      } else turn = await assistant.sendMessage(input);
      expect(turn?.toolCalls).toMatchObject([
        { toolId: "web.search", status: "executed" },
        { toolId: "zebra.send", status: "skipped" },
      ]);
      expect(excludedHandler).not.toHaveBeenCalled();
      expect(requests[0]?.messages[0]?.content).toMatch(/Current time: \d{4}-\d{2}-\d{2}T/);
      expect(requests[0]?.messages[0]?.content).toContain("tool catalog is selected for this turn");
    },
  );
});
