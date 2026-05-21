import { describe, expect, it } from "vitest";
import { AIRouter, type LLMChatMetrics, type LLMMetricStatus } from "./routing.js";
import {
  AICostLimitExceededError,
  InMemoryAICostLimiter,
  aiCentsToUsdMicros,
  createAICostGuard,
} from "./costs/index.js";
import type { Actor, ChatRequest, ChatResponse, LLMProviderCapability } from "@helix/sdk-types";

const actor: Actor = {
  id: "actor-1",
  orgId: "org-1",
  type: "user",
};

describe("AIRouter", () => {
  it("routes feature chat to configured provider and records provenance", async () => {
    const provenanceIds: string[] = [];
    const router = new AIRouter({
      providers: [provider("local", ["local-only"]), provider("cloud", [])],
      policy: {
        defaultProviderId: "cloud",
        featureProviders: { "assistant.chat": "local" },
      },
      provenance: {
        async record(input) {
          expect(input.providerId).toBe("local");
          provenanceIds.push(input.inputHash);
          return { id: "prov-1" };
        },
      },
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({
      providerId: "local",
      model: "local-model",
      metadata: { provenanceId: "prov-1" },
    });
    expect(provenanceIds).toHaveLength(1);
  });

  it("reports unavailable provider when restricted requests have no local route", async () => {
    const router = new AIRouter({
      providers: [provider("cloud", [])],
      policy: { defaultProviderId: "cloud" },
    });

    await expect(
      router.chat({ ...request(), classification: "restricted" }, { actor }),
    ).rejects.toThrow("No AI provider is configured");
  });

  it("routes sovereign standard requests to a local provider", async () => {
    const router = new AIRouter({
      providers: [provider("cloud", ["admin-allowlisted"]), provider("local", ["local-only"])],
      policy: {
        defaultProviderId: "cloud",
        tier: "sovereign",
      },
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({
      providerId: "local",
    });
  });

  it("rejects explicit cloud provider requests in sovereign mode", async () => {
    const router = new AIRouter({
      providers: [provider("cloud", ["admin-allowlisted"]), provider("local", ["local-only"])],
      policy: { tier: "sovereign" },
    });

    await expect(
      router.chat({ ...request(), metadata: { providerId: "cloud" } }, { actor }),
    ).rejects.toThrow("cannot process standard");
  });

  it("falls back to a local provider under local-only policy", async () => {
    const router = new AIRouter({
      providers: [provider("cloud", []), provider("local", ["air-gapped"])],
      policy: {
        defaultProviderId: "missing",
        localAiOnly: true,
      },
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({
      providerId: "local",
    });
  });

  it("applies cost reserve and record hooks", async () => {
    const calls: string[] = [];
    const router = new AIRouter({
      providers: [provider("cloud", [])],
      costGuard: {
        async reserve(input) {
          calls.push(`reserve:${input.providerId}:${String(input.estimatedCostCents)}`);
        },
        async record(input) {
          calls.push(`record:${input.providerId}:${String(input.costCents)}`);
        },
      },
    });

    await router.chat(request(), { actor });

    expect(calls).toEqual(["reserve:cloud:0.01", "record:cloud:2"]);
  });

  it("uses configured primary model refs and falls back after provider failure", async () => {
    const calls: string[] = [];
    const metrics = new MemoryLLMMetrics();
    const router = new AIRouter({
      providers: [
        provider("cloud", [], {
          model: "cloud-configured",
          async chat() {
            calls.push("cloud");
            throw new Error("primary unavailable");
          },
        }),
        provider("local", ["local-only"], {
          model: "local-configured",
          async chat(req): Promise<ChatResponse> {
            calls.push(`local:${req.model ?? ""}`);
            return {
              providerId: "local",
              model: req.model ?? "local-configured",
              message: "fallback hello",
              usage: { costCents: 1.5 },
            };
          },
        }),
      ],
      metrics,
      policy: {
        featureRoutes: {
          "assistant.chat": {
            primary: { providerId: "cloud", model: "cloud-configured" },
            fallback: { providerId: "local", model: "local-configured" },
          },
        },
      },
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({
      providerId: "local",
      model: "local-configured",
      message: "fallback hello",
    });

    expect(calls).toEqual(["cloud", "local:local-configured"]);
    expect(metrics.records).toEqual([
      expect.objectContaining({
        providerId: "cloud",
        model: "cloud-configured",
        status: "error",
        fallback: false,
        errorType: "Error",
      }),
      expect.objectContaining({
        providerId: "local",
        model: "local-configured",
        status: "success",
        fallback: true,
        costCents: 1.5,
      }),
    ]);
  });

  it("uses the configured AI cost limiter to record calls and block over-budget calls", async () => {
    const limiter = new InMemoryAICostLimiter();
    let providerCalls = 0;
    const meteredProvider: LLMProviderCapability = {
      id: "cloud",
      protocol: "openai-compatible",
      tags: [],
      async chat(req): Promise<ChatResponse> {
        providerCalls += 1;
        return {
          providerId: "cloud",
          model: req.model ?? "cloud-model",
          message: "hello",
          usage: { costCents: 2 },
        };
      },
      async models() {
        return [{ id: "cloud-model", inputCostPer1kTokensCents: 5 }];
      },
      async countTokens() {
        return 2;
      },
    };
    const router = new AIRouter({
      providers: [meteredProvider],
      costGuard: createAICostGuard({
        limiter,
        tier: "business",
        budget: { actorDailyUsdMicros: aiCentsToUsdMicros(2) },
        now: () => new Date("2026-05-20T12:00:00.000Z"),
      }),
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({
      providerId: "cloud",
    });
    expect(limiter.listRecords({ orgId: actor.orgId, actorId: actor.id })).toHaveLength(1);
    expect(providerCalls).toBe(1);

    await expect(router.chat(request(), { actor })).rejects.toBeInstanceOf(
      AICostLimitExceededError,
    );
    expect(limiter.listRecords({ orgId: actor.orgId, actorId: actor.id })).toHaveLength(1);
    expect(providerCalls).toBe(1);
  });
});

describe("AIRouter streaming", () => {
  it("streams provider chunks and finalizes cost, metrics, and provenance", async () => {
    const provenanceInputs: { providerId: string; streamed: unknown }[] = [];
    const metricCalls: LLMMetricStatus[] = [];
    const costRecords: number[] = [];
    const router = new AIRouter({
      providers: [streamingProvider("local", ["local-only"], ["Hel", "lo"])],
      policy: { defaultProviderId: "local" },
      provenance: {
        async record(input) {
          provenanceInputs.push({
            providerId: input.providerId,
            streamed: input.metadata?.streamed,
          });
          return { id: "prov-stream" };
        },
      },
      metrics: {
        recordLLMChat(input) {
          metricCalls.push(input.status);
        },
      },
      costGuard: {
        async reserve() {
          // no-op
        },
        async record(input) {
          costRecords.push(input.costCents);
        },
      },
    });

    const deltas: string[] = [];
    let final: ChatChunkLike | undefined;
    for await (const chunk of router.chatStream(request(), { actor })) {
      if (chunk.delta.length > 0) {
        deltas.push(chunk.delta);
      }
      if (chunk.done === true) {
        final = chunk;
      }
    }

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(final?.done).toBe(true);
    expect(metricCalls).toEqual(["success"]);
    expect(costRecords).toHaveLength(1);
    expect(provenanceInputs).toEqual([{ providerId: "local", streamed: true }]);
  });

  it("enforces classification gating before streaming begins", async () => {
    const router = new AIRouter({
      providers: [streamingProvider("cloud", [], ["nope"])],
      policy: { defaultProviderId: "cloud" },
    });

    await expect(async () => {
      for await (const _chunk of router.chatStream(
        { ...request(), classification: "restricted" },
        { actor },
      )) {
        void _chunk;
      }
    }).rejects.toThrow("No AI provider is configured");
  });

  it("falls back to chat() for providers without native streaming", async () => {
    const router = new AIRouter({
      providers: [provider("local", ["local-only"], { model: "local-model" })],
      policy: { defaultProviderId: "local" },
    });

    const deltas: string[] = [];
    for await (const chunk of router.chatStream(request(), { actor })) {
      if (chunk.delta.length > 0) {
        deltas.push(chunk.delta);
      }
    }
    expect(deltas).toEqual(["hello"]);
  });
});

interface ChatChunkLike {
  readonly delta: string;
  readonly done?: boolean;
}

function request(): ChatRequest {
  return {
    feature: "assistant.chat",
    messages: [{ role: "user", content: "hello world" }],
  };
}

function provider(
  id: string,
  tags: readonly string[],
  options: {
    readonly model?: string;
    readonly chat?: LLMProviderCapability["chat"];
  } = {},
): LLMProviderCapability {
  const model = options.model ?? `${id}-model`;
  return {
    id,
    protocol: "openai-compatible",
    tags,
    chat(req, ctx) {
      if (options.chat !== undefined) {
        return options.chat(req, ctx);
      }
      return Promise.resolve({
        providerId: id,
        model: req.model ?? model,
        message: "hello",
        usage: { costCents: 2 },
      });
    },
    async models() {
      return [{ id: model, inputCostPer1kTokensCents: 5 }];
    },
    async countTokens() {
      return 2;
    },
  };
}

/** Provider whose `chatStream` replays the given text deltas plus a usage-bearing terminal chunk. */
function streamingProvider(
  id: string,
  tags: readonly string[],
  deltas: readonly string[],
): LLMProviderCapability {
  const model = `${id}-model`;
  const base = provider(id, tags, { model });
  return {
    ...base,
    async *chatStream(req) {
      for (const delta of deltas) {
        yield { delta };
      }
      yield {
        delta: "",
        done: true,
        usage: { costCents: 3 },
        metadata: { model: req.model ?? model },
      };
    },
  };
}

class MemoryLLMMetrics implements LLMChatMetrics {
  readonly records: Parameters<LLMChatMetrics["recordLLMChat"]>[0][] = [];

  recordLLMChat(input: Parameters<LLMChatMetrics["recordLLMChat"]>[0]): void {
    this.records.push(input);
  }
}
