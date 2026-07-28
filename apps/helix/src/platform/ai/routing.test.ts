import { describe, expect, it } from "vitest";
import {
  AIClassificationBlockedError,
  AIProviderUnavailableError,
  AIRouter,
  providerAllowedForClassification,
  type LLMChatMetrics,
  type LLMMetricStatus,
} from "./routing.js";
import {
  AICostLimitExceededError,
  InMemoryAICostLimiter,
  aiCentsToUsdMicros,
  createAICostGuard,
} from "./costs/index.js";
import type {
  Actor,
  ChatRequest,
  ChatResponse,
  ImageGenerationResponse,
  ImageProviderCapability,
  LLMProviderCapability,
  MeteringClient,
  MeteringEmitInput,
  MeteringEvent,
  TraceContext,
} from "@helix/sdk-types";

const actor: Actor = {
  id: "actor-1",
  orgId: "org-1",
  type: "user",
};

describe("AIRouter", () => {
  it("never lets a disabled standard gate route confidential/restricted data to untagged cloud", () => {
    const cloud = { id: "cloud", tags: ["external"] };

    expect(
      providerAllowedForClassification(cloud, "public", { classificationEnabled: false }),
    ).toBe(true);
    expect(
      providerAllowedForClassification(cloud, "confidential", {
        classificationEnabled: false,
      }),
    ).toBe(false);
    expect(
      providerAllowedForClassification(cloud, "restricted", {
        classificationEnabled: false,
      }),
    ).toBe(false);
  });

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
      // Post-A1 security fix: classification must come through ctx, not the
      // client-supplied request payload.
      router.chat(request(), { actor, classification: "restricted" }),
    ).rejects.toThrow("No AI provider is configured");
  });

  it("routes restricted context to a tagged local fallback instead of the configured cloud primary", async () => {
    const router = new AIRouter({
      providers: [provider("cloud", ["admin-allowlisted"]), provider("local", ["local-only"])],
      policy: {
        featureRoutes: {
          "assistant.chat": {
            primary: { providerId: "cloud" },
            fallback: { providerId: "local" },
          },
        },
      },
    });

    await expect(
      router.chat(request(), { actor, classification: "restricted" }),
    ).resolves.toMatchObject({
      providerId: "local",
    });
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

  it("emits safe AI token metering after successful chat responses", async () => {
    const metering = new RecordingMeteringClient();
    const router = new AIRouter({
      providers: [
        provider("cloud", [], {
          async chat(req): Promise<ChatResponse> {
            return {
              providerId: "cloud",
              model: req.model ?? "cloud-model",
              message: "secret output text",
              usage: {
                inputTokens: 4,
                outputTokens: 5,
                totalTokens: 9,
                costCents: 1.5,
              },
            };
          },
        }),
      ],
      metering,
    });

    await router.chat(
      {
        feature: "assistant.chat",
        messages: [{ role: "user", content: "secret prompt text" }],
      },
      {
        actor,
      },
    );

    expect(metering.records).toEqual([
      {
        orgId: actor.orgId,
        event: {
          type: "ai.tokens",
          quantity: 9,
          metadata: {
            provider: "cloud",
            model: "cloud-model",
            slot: "assistant.chat",
            cost_cents_estimate: 1.5,
            tokens_in: 4,
            tokens_out: 5,
          },
        },
      },
    ]);
    expect(JSON.stringify(metering.records[0]?.event.metadata)).not.toContain("secret");
  });

  it("does not fail successful chat responses when metering emission fails", async () => {
    const errors: unknown[] = [];
    const router = new AIRouter({
      providers: [
        provider("cloud", [], {
          async chat(req): Promise<ChatResponse> {
            return {
              providerId: "cloud",
              model: req.model ?? "cloud-model",
              message: "hello",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, costCents: 0.5 },
            };
          },
        }),
      ],
      metering: new RecordingMeteringClient({ reject: true }),
      onMeteringError(error) {
        errors.push(error);
      },
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({ message: "hello" });
    await Promise.resolve();

    expect(errors).toHaveLength(1);
  });

  it("does not emit AI token metering when providers return only cost usage", async () => {
    const metering = new RecordingMeteringClient();
    const router = new AIRouter({
      providers: [provider("cloud", [])],
      metering,
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({
      providerId: "cloud",
    });

    expect(metering.records).toHaveLength(0);
  });

  it("uses configured primary model refs and falls back after provider failure", async () => {
    const calls: string[] = [];
    const metrics = new MemoryLLMMetrics();
    const metering = new RecordingMeteringClient();
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
              usage: { inputTokens: 2, outputTokens: 4, totalTokens: 6, costCents: 1.5 },
            };
          },
        }),
      ],
      metrics,
      metering,
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
    expect(metering.records).toEqual([
      {
        orgId: actor.orgId,
        event: {
          type: "ai.tokens",
          quantity: 6,
          metadata: {
            provider: "local",
            model: "local-configured",
            slot: "assistant.chat",
            cost_cents_estimate: 1.5,
            tokens_in: 2,
            tokens_out: 4,
          },
        },
      },
    ]);
  });

  it("uses the configured AI cost limiter to record calls and block over-budget calls", async () => {
    const limiter = new InMemoryAICostLimiter();
    let providerCalls = 0;
    const metering = new RecordingMeteringClient();
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
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7, costCents: 2 },
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
      metering,
    });

    await expect(router.chat(request(), { actor })).resolves.toMatchObject({
      providerId: "cloud",
    });
    expect(limiter.listRecords({ orgId: actor.orgId, actorId: actor.id })).toHaveLength(1);
    expect(metering.records).toHaveLength(1);
    expect(providerCalls).toBe(1);

    await expect(router.chat(request(), { actor })).rejects.toBeInstanceOf(
      AICostLimitExceededError,
    );
    expect(limiter.listRecords({ orgId: actor.orgId, actorId: actor.id })).toHaveLength(1);
    expect(metering.records).toHaveLength(1);
    expect(providerCalls).toBe(1);
  });

  it("emits safe AI image metering after successful image generation", async () => {
    const metering = new RecordingMeteringClient();
    const router = new AIRouter({
      providers: [],
      imageProviders: [
        imageProvider("cloud", [], {
          async generateImage(req): Promise<ImageGenerationResponse> {
            return {
              providerId: "cloud",
              model: req.model ?? "image-model",
              images: [
                {
                  url: "https://images.example/secret-project.png",
                  mimeType: "image/png",
                  width: 1024,
                  height: 1024,
                },
                {
                  b64Json: "secret-image-bytes",
                  mimeType: "image/png",
                  width: 1024,
                  height: 1024,
                },
              ],
              usage: { imageCount: 2, costCents: 4.5 },
            };
          },
        }),
      ],
      metering,
    });

    const generated = await router.generateImage(
      {
        feature: "slides.generate-image",
        prompt: "secret launch image prompt",
        size: "1024x1024",
      },
      { actor },
    );

    expect(generated.providerId).toBe("cloud");
    expect(generated.images).toEqual(
      expect.arrayContaining([expect.objectContaining({ mimeType: "image/png" })]),
    );

    expect(metering.records).toEqual([
      {
        orgId: actor.orgId,
        event: {
          type: "ai.image.generated",
          quantity: 2,
          metadata: {
            provider: "cloud",
            model: "cloud-model",
            slot: "slides.generate-image",
            count: 2,
            resolution: "1024x1024",
            cost_cents_estimate: 4.5,
          },
        },
      },
    ]);
    const serializedMetering = JSON.stringify(metering.records);
    expect(serializedMetering).not.toContain("secret launch image prompt");
    expect(serializedMetering).not.toContain("secret-project");
    expect(serializedMetering).not.toContain("secret-image-bytes");
  });

  it("falls back to an image-capable provider when the preferred AI provider cannot generate images", async () => {
    const metering = new RecordingMeteringClient();
    const calls: string[] = [];
    const router = new AIRouter({
      providers: [],
      imageProviders: [
        imageProvider("primary-image", [], {
          async generateImage() {
            calls.push("primary");
            throw new Error("primary image provider unavailable");
          },
        }),
        imageProvider("image", [], {
          async generateImage(req): Promise<ImageGenerationResponse> {
            calls.push(`image:${req.model ?? ""}`);
            return {
              providerId: "image",
              model: req.model ?? "image-model",
              images: [{ url: "https://images.example/result.png" }],
            };
          },
        }),
      ],
      metering,
      policy: {
        featureRoutes: {
          "slides.generate-image": {
            primary: { providerId: "primary-image", model: "primary-model" },
            fallback: { providerId: "image", model: "image-model" },
          },
        },
      },
    });

    await expect(
      router.generateImage({ feature: "slides.generate-image", prompt: "draw a chart" }, { actor }),
    ).resolves.toMatchObject({ providerId: "image", model: "image-model" });

    expect(calls).toEqual(["primary", "image:image-model"]);
    expect(metering.records).toEqual([
      {
        orgId: actor.orgId,
        event: {
          type: "ai.image.generated",
          quantity: 1,
          metadata: {
            provider: "image",
            model: "image-model",
            slot: "slides.generate-image",
            count: 1,
          },
        },
      },
    ]);
  });

  it("reserves estimated image cost before calling the image provider", async () => {
    const reserveCosts: number[] = [];
    let providerCalls = 0;
    const router = new AIRouter({
      providers: [],
      imageProviders: [
        imageProvider("image", [], {
          model: "image-model",
          imageCostCents: 6,
          async generateImage() {
            providerCalls += 1;
            return {
              providerId: "image",
              model: "image-model",
              images: [{ url: "https://images.example/result.png" }],
            };
          },
        }),
      ],
      costGuard: {
        async reserve(input) {
          reserveCosts.push(input.estimatedCostCents);
          throw new AICostLimitExceededError("blocked", "actor_daily_cost", 60);
        },
        async record() {
          throw new Error("record should not be called");
        },
      },
    });

    await expect(
      router.generateImage(
        { feature: "slides.generate-image", prompt: "draw", count: 2 },
        { actor },
      ),
    ).rejects.toBeInstanceOf(AICostLimitExceededError);

    expect(reserveCosts).toEqual([12]);
    expect(providerCalls).toBe(0);
  });

  it("does not fall through to another image provider when an explicit route has no image provider", async () => {
    const router = new AIRouter({
      providers: [provider("text-only", [])],
      imageProviders: [imageProvider("default-image", [])],
      policy: {
        featureRoutes: {
          "slides.generate-image": {
            primary: { providerId: "text-only", model: "text-model" },
          },
        },
      },
    });

    await expect(
      router.generateImage({ feature: "slides.generate-image", prompt: "draw" }, { actor }),
    ).rejects.toBeInstanceOf(AIProviderUnavailableError);
  });

  it("blocks restricted image requests when a configured route has no local provider", async () => {
    const router = new AIRouter({
      providers: [],
      imageProviders: [imageProvider("cloud", [])],
      policy: {
        featureRoutes: {
          "slides.generate-image": {
            primary: { providerId: "cloud", model: "cloud-model" },
          },
        },
      },
    });

    await expect(
      router.generateImage(
        {
          feature: "slides.generate-image",
          prompt: "draw",
        },
        { actor, classification: "restricted" },
      ),
    ).rejects.toBeInstanceOf(AIClassificationBlockedError);
  });

  it("does not copy unsafe image size strings into metering metadata", async () => {
    const metering = new RecordingMeteringClient();
    const router = new AIRouter({
      providers: [],
      imageProviders: [
        imageProvider("image", [], {
          async generateImage(): Promise<ImageGenerationResponse> {
            return {
              providerId: "image",
              model: "image-model",
              images: [{ url: "https://images.example/result.png", width: 512, height: 768 }],
            };
          },
        }),
      ],
      metering,
    });

    await router.generateImage(
      {
        feature: "slides.generate-image",
        prompt: "draw",
        size: "secret-customer-resolution",
      },
      { actor },
    );

    expect(metering.records[0]?.event.metadata).toMatchObject({ resolution: "512x768" });
    expect(JSON.stringify(metering.records)).not.toContain("secret-customer-resolution");
  });

  it("does not fail successful image generation when metering emission fails", async () => {
    const errors: unknown[] = [];
    const router = new AIRouter({
      providers: [],
      imageProviders: [
        imageProvider("image", [], {
          async generateImage(): Promise<ImageGenerationResponse> {
            return {
              providerId: "image",
              model: "image-model",
              images: [{ url: "https://images.example/result.png" }],
            };
          },
        }),
      ],
      metering: new RecordingMeteringClient({ reject: true }),
      onMeteringError(error) {
        errors.push(error);
      },
    });

    await expect(
      router.generateImage({ feature: "slides.generate-image", prompt: "draw" }, { actor }),
    ).resolves.toMatchObject({ providerId: "image" });
    await Promise.resolve();

    expect(errors).toHaveLength(1);
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

  it("emits safe AI token metering after successful streamed responses", async () => {
    const metering = new RecordingMeteringClient();
    const router = new AIRouter({
      providers: [
        streamingProvider("local", ["local-only"], ["Hel", "lo"], {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          costCents: 3,
        }),
      ],
      policy: { defaultProviderId: "local" },
      metering,
    });

    for await (const _chunk of router.chatStream(request(), { actor })) {
      void _chunk;
    }

    expect(metering.records).toEqual([
      {
        orgId: actor.orgId,
        event: {
          type: "ai.tokens",
          quantity: 5,
          metadata: {
            provider: "local",
            model: "local-model",
            slot: "assistant.chat",
            cost_cents_estimate: 3,
            tokens_in: 2,
            tokens_out: 3,
          },
        },
      },
    ]);
  });

  it("enforces classification gating before streaming begins", async () => {
    const router = new AIRouter({
      providers: [streamingProvider("cloud", [], ["nope"])],
      policy: { defaultProviderId: "cloud" },
    });

    await expect(async () => {
      for await (const _chunk of router.chatStream(request(), {
        actor,
        classification: "restricted",
      })) {
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

function imageProvider(
  id: string,
  tags: readonly string[],
  options: {
    readonly model?: string;
    readonly imageCostCents?: number;
    readonly generateImage?: ImageProviderCapability["generateImage"];
  } = {},
): ImageProviderCapability {
  const model = options.model ?? `${id}-model`;
  return {
    id,
    protocol: "openai-compatible",
    tags,
    async generateImage(req, ctx) {
      if (options.generateImage !== undefined) {
        return options.generateImage(req, ctx);
      }
      return {
        providerId: id,
        model: req.model ?? model,
        images: [{ url: "https://images.example/default.png" }],
      };
    },
    async models() {
      return [
        {
          id: model,
          ...(options.imageCostCents === undefined
            ? {}
            : { imageCostCents: options.imageCostCents }),
        },
      ];
    },
  };
}

/** Provider whose `chatStream` replays the given text deltas plus a usage-bearing terminal chunk. */
function streamingProvider(
  id: string,
  tags: readonly string[],
  deltas: readonly string[],
  usage: ChatResponse["usage"] = { costCents: 3 },
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
        usage,
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

class RecordingMeteringClient implements MeteringClient {
  readonly records: {
    readonly orgId: string;
    readonly event: MeteringEvent;
    readonly trace?: TraceContext;
  }[] = [];

  constructor(private readonly options: { readonly reject?: boolean } = {}) {}

  async emit(orgId: string, event: MeteringEvent, trace?: TraceContext): Promise<void> {
    this.records.push({ orgId, event, ...(trace === undefined ? {} : { trace }) });
    if (this.options.reject === true) {
      throw new Error("metering unavailable");
    }
  }

  async emitBatch(events: readonly MeteringEmitInput[]): Promise<void> {
    for (const input of events) {
      await this.emit(input.orgId, input.event, input.trace);
    }
  }
}
