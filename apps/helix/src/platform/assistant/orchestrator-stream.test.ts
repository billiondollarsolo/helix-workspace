import { describe, expect, it } from "vitest";
import type {
  Actor,
  ChatRequest,
  LLMProviderCapability,
} from "@helix/sdk-types";
import { AIRouter } from "../ai/routing.js";
import { createToolRegistry } from "../tool-registry.js";
import { AllowAllToolAccessPolicy } from "../permissions/tool-access.js";
import { AssistantOrchestrator } from "./orchestrator.js";
import { InMemoryAssistantStore } from "./store.js";
import type { AssistantStreamEvent } from "./types.js";

const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000010",
  type: "user",
  displayName: "Ada",
  scopes: ["assistant.read", "assistant.write"],
};

/** Provider whose `chatStream` replays text deltas plus a usage-bearing terminal chunk. */
function streamingProvider(deltas: readonly string[]): LLMProviderCapability {
  return {
    id: "local-stream",
    protocol: "openai-compatible",
    tags: ["local-only"],
    chat(request: ChatRequest) {
      return Promise.resolve({
        providerId: "local-stream",
        model: request.model ?? "local-model",
        message: deltas.join(""),
        usage: { costCents: 1 },
      });
    },
    async *chatStream(request: ChatRequest) {
      for (const delta of deltas) {
        yield { delta };
      }
      yield {
        delta: "",
        done: true,
        usage: { costCents: 2 },
        metadata: { model: request.model ?? "local-model" },
      };
    },
    async models() {
      return [{ id: "local-model", inputCostPer1kTokensCents: 1 }];
    },
    async countTokens() {
      return 4;
    },
  };
}

describe("AssistantOrchestrator.sendMessageStream", () => {
  it("emits incremental delta events then a final turn from a streaming router", async () => {
    const router = new AIRouter({
      providers: [streamingProvider(["Hello", " ", "world"])],
      policy: { defaultProviderId: "local-stream" },
    });
    const orchestrator = new AssistantOrchestrator({
      store: new InMemoryAssistantStore(),
      ai: router,
      tools: createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() }),
    });

    const events: AssistantStreamEvent[] = [];
    for await (const event of orchestrator.sendMessageStream({
      actor,
      content: "Say hello.",
    })) {
      events.push(event);
    }

    const deltas = events.filter((event) => event.type === "delta");
    expect(deltas.map((event) => event.text)).toEqual(["Hello", " ", "world"]);

    const final = events.at(-1);
    if (final?.type !== "final") {
      throw new Error("Expected a terminal final event");
    }
    expect(final.turn.response.content).toBe("Hello world");
    expect(final.turn.response.role).toBe("assistant");
    expect(final.turn.response.metadata).toMatchObject({ streamed: true });
    expect(final.turn.ai.message).toBe("Hello world");
  });

  it("falls back to a single delta when the AI capability cannot stream", async () => {
    const orchestrator = new AssistantOrchestrator({
      store: new InMemoryAssistantStore(),
      ai: {
        async chat(request: ChatRequest) {
          return {
            providerId: "non-streaming",
            model: request.model ?? "fixed-model",
            message: "Complete answer.",
          };
        },
      },
      tools: createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() }),
    });

    const events: AssistantStreamEvent[] = [];
    for await (const event of orchestrator.sendMessageStream({
      actor,
      content: "Answer once.",
    })) {
      events.push(event);
    }

    const deltas = events.filter((event) => event.type === "delta");
    expect(deltas.map((event) => event.text)).toEqual(["Complete answer."]);
    const final = events.at(-1);
    if (final?.type !== "final") {
      throw new Error("Expected a terminal final event");
    }
    expect(final.turn.response.content).toBe("Complete answer.");
  });
});
