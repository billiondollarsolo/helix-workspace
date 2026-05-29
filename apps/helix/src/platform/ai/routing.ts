import { createHash } from "node:crypto";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { confidentialProviderTags, localOnlyProviderTags } from "./classification/provider-tags.js";
import type {
  Actor,
  AICallContext,
  AIClassification,
  AICapability,
  AiProviderModelRef,
  ChatChunk,
  ChatRequest,
  ChatResponse,
  ImageGenerationRequest,
  ImageGenerationResponse,
  ImageProviderCapability,
  LLMProviderCapability,
  JsonObject,
  MeteringClient,
  SecurityTier,
  TraceContext,
} from "@helix/sdk-types";

export interface AIRoutingFeatureRoute {
  readonly primary: AiProviderModelRef;
  readonly fallback?: AiProviderModelRef;
}

export interface AIRoutingPolicy {
  readonly defaultProviderId?: string;
  readonly featureProviders?: Readonly<Record<string, string>>;
  readonly featureRoutes?: Readonly<Record<string, AIRoutingFeatureRoute>>;
  readonly classificationEnabled?: boolean;
  readonly tier?: SecurityTier;
  readonly localAiOnly?: boolean;
}

export interface AICostGuard {
  reserve(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly estimatedCostCents: number;
  }): Promise<void>;
  record(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly costCents: number;
  }): Promise<void>;
}

export type LLMMetricStatus = "success" | "error";

export interface LLMChatMetrics {
  recordLLMChat(input: {
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly status: LLMMetricStatus;
    readonly durationSeconds: number;
    readonly fallback: boolean;
    readonly costCents?: number | undefined;
    readonly errorType?: string | undefined;
  }): void;
}

export interface AIProvenanceRecorder {
  record(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly inputHash: string;
    readonly outputHash: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ readonly id: string }>;
}

export interface AIRouterOptions {
  readonly providers: readonly LLMProviderCapability[];
  readonly imageProviders?: readonly ImageProviderCapability[];
  readonly policy?: AIRoutingPolicy;
  readonly costGuard?: AICostGuard;
  readonly metrics?: LLMChatMetrics;
  readonly provenance?: AIProvenanceRecorder;
  readonly metering?: MeteringClient;
  readonly onMeteringError?: (error: unknown) => void;
  readonly systemActor?: Actor;
}

export class AIProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderUnavailableError";
  }
}

export class AIClassificationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIClassificationBlockedError";
  }
}

export class AIRouter implements AICapability {
  readonly #providers = new Map<string, LLMProviderCapability>();
  readonly #imageProviders = new Map<string, ImageProviderCapability>();
  readonly #policy: AIRoutingPolicy;
  readonly #costGuard: AICostGuard | undefined;
  readonly #metrics: LLMChatMetrics | undefined;
  readonly #provenance: AIProvenanceRecorder | undefined;
  readonly #metering: MeteringClient | undefined;
  readonly #onMeteringError: ((error: unknown) => void) | undefined;
  readonly #systemActor: Actor;

  constructor(options: AIRouterOptions) {
    for (const provider of options.providers) {
      this.#providers.set(provider.id, provider);
    }
    for (const provider of options.imageProviders ?? []) {
      this.#imageProviders.set(provider.id, provider);
    }
    this.#policy = options.policy ?? {};
    this.#costGuard = options.costGuard;
    this.#metrics = options.metrics;
    this.#provenance = options.provenance;
    this.#metering = options.metering;
    this.#onMeteringError = options.onMeteringError;
    this.#systemActor = options.systemActor ?? {
      id: "system",
      orgId: "00000000-0000-0000-0000-000000000000",
      type: "system",
      displayName: "System",
    };
  }

  listProviders(): readonly LLMProviderCapability[] {
    return [...this.#providers.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async chat(request: ChatRequest, ctx: Partial<AICallContext> = {}): Promise<ChatResponse> {
    return trace.getTracer("helix.ai").startActiveSpan("llm.chat", async (span) => {
      try {
        const result = await this.#chat(request, ctx, span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async generateImage(
    request: ImageGenerationRequest,
    ctx: Partial<AICallContext> = {},
  ): Promise<ImageGenerationResponse> {
    return trace.getTracer("helix.ai").startActiveSpan("ai.image.generate", async (span) => {
      try {
        const result = await this.#generateImage(request, ctx, span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  /**
   * Streams a chat completion. Provider selection, classification gating,
   * cost reservation, metrics, and provenance recording mirror {@link chat};
   * fallback applies only before the first byte is produced. The final chunk
   * carries `done: true`, assembled usage, and any tool calls.
   */
  async *chatStream(
    request: ChatRequest,
    ctx: Partial<AICallContext> = {},
  ): AsyncGenerator<ChatChunk> {
    const span = trace.getTracer("helix.ai").startSpan("llm.chat.stream");
    try {
      yield* this.#chatStream(request, ctx, span);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  }

  async *#chatStream(
    request: ChatRequest,
    ctx: Partial<AICallContext>,
    span: Span,
  ): AsyncGenerator<ChatChunk> {
    // SECURITY: classification must be server-derived. The client-supplied
    // request.classification is now ignored (was a trust-boundary leak — A1
    // in the AI review). Default to the most restrictive band ("internal").
    const classification: AIClassification = ctx.classification ?? "standard";
    const actor = ctx.actor ?? this.#systemActor;
    const attempts = await this.#selectProviderAttempts(request, classification);
    const context: AICallContext = {
      actor,
      feature: request.feature,
      classification,
      ...(ctx.trace === undefined ? {} : { trace: ctx.trace }),
      ...(ctx.costLimitCents === undefined ? {} : { costLimitCents: ctx.costLimitCents }),
    };
    span.setAttribute("helix.ai.feature", request.feature);
    span.setAttribute("helix.ai.classification", classification);
    span.setAttribute("helix.actor.id", actor.id);

    let lastError: unknown;
    for (const attempt of attempts) {
      const started = process.hrtime.bigint();
      const modelForMetrics = request.model ?? attempt.model ?? "unknown";
      // Tracks reservation lifecycle so the cost guard always sees a paired
      // `record(...)` even if the client disconnects mid-stream or the provider
      // throws after `reserve(...)` succeeds. Without this, abandoned streams
      // permanently consume the actor's daily budget.
      let reservationFinalized = false;
      let reservationProviderId = attempt.provider.id;
      let resolvedModel = request.model ?? attempt.model ?? "unknown";
      let estimatedCostCents = 0;
      let partialUsage: ChatResponse["usage"];
      try {
        const model = request.model ?? attempt.model ?? (await firstModel(attempt.provider));
        resolvedModel = model;
        assertClassificationAllowed(attempt.provider, classification, this.#policy);
        estimatedCostCents = await estimateRequestCost(attempt.provider, request, model);
        await this.#costGuard?.reserve({
          actor,
          feature: request.feature,
          providerId: attempt.provider.id,
          model,
          estimatedCostCents,
        });

        const streamRequest: ChatRequest = { ...request, model, classification };
        const provider = attempt.provider;
        reservationProviderId = provider.id;
        if (provider.chatStream === undefined) {
          // Provider cannot stream natively: emit the non-streaming response
          // as a single terminal chunk so callers still get a uniform stream.
          const responseOrStream = await provider.chat(streamRequest, context);
          const response = isChatChunkStream(responseOrStream)
            ? await collectChatStream(responseOrStream, provider.id, model)
            : responseOrStream;
          yield* this.#emitNonStreamingFallback(response, model);
          await this.#finalizeStream({
            request,
            context,
            classification,
            actor,
            attempt,
            providerId: response.providerId || provider.id,
            model: response.model || model,
            message: response.message,
            usage: response.usage,
            estimatedCostCents,
            started,
            span,
          });
          reservationFinalized = true;
          return;
        }

        let message = "";
        for await (const chunk of provider.chatStream(streamRequest, context)) {
          message += chunk.delta;
          if (chunk.usage !== undefined) {
            partialUsage = chunk.usage;
          }
          if (chunk.metadata !== undefined) {
            const metadataModel = chunk.metadata.model;
            if (typeof metadataModel === "string" && metadataModel.length > 0) {
              resolvedModel = metadataModel;
            }
          }
          yield chunk;
        }
        await this.#finalizeStream({
          request,
          context,
          classification,
          actor,
          attempt,
          providerId: provider.id,
          model: resolvedModel,
          message,
          usage: partialUsage,
          estimatedCostCents,
          started,
          span,
        });
        reservationFinalized = true;
        return;
      } catch (error) {
        this.#metrics?.recordLLMChat({
          feature: request.feature,
          providerId: attempt.provider.id,
          model: modelForMetrics,
          status: "error",
          durationSeconds: durationSecondsSince(started),
          fallback: attempt.fallback,
          errorType: errorName(error),
        });
        lastError = error;
        if (!shouldTryFallback(error) || attempt === attempts[attempts.length - 1]) {
          throw error;
        }
        span.addEvent("llm.chat.stream.fallback", {
          "llm.provider": attempt.provider.id,
          "llm.model": modelForMetrics,
          "exception.type": errorName(error),
          "exception.message": error instanceof Error ? error.message : String(error),
        });
      } finally {
        // Release the reservation if the stream was abandoned (client
        // disconnect, generator `return()`, or thrown error after reserve).
        // Recording the partial usage we observed prevents the actor's daily
        // cost budget from drifting upward over time when streams are aborted.
        if (!reservationFinalized) {
          await this.#releaseReservation({
            actor,
            feature: request.feature,
            providerId: reservationProviderId,
            model: resolvedModel,
            partialUsage,
            estimatedCostCents,
          });
        }
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AIProviderUnavailableError(
          `No AI provider is configured for feature ${request.feature}.`,
        );
  }

  async #releaseReservation(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly partialUsage: ChatResponse["usage"];
    readonly estimatedCostCents: number;
  }): Promise<void> {
    if (this.#costGuard === undefined) {
      return;
    }
    // Bill the actual partial usage if the provider reported any, otherwise
    // bill zero so the reservation is closed without double-charging.
    const costCents = input.partialUsage?.costCents ?? 0;
    try {
      await this.#costGuard.record({
        actor: input.actor,
        feature: input.feature,
        providerId: input.providerId,
        model: input.model,
        costCents,
      });
    } catch {
      // Swallow release errors so they cannot mask the original abort/throw.
    }
  }

  async *#emitNonStreamingFallback(
    response: ChatResponse,
    model: string,
  ): AsyncGenerator<ChatChunk> {
    if (response.message.length > 0) {
      yield { delta: response.message };
    }
    const metadata: JsonObject = {
      model: response.model || model,
      ...(response.toolCalls === undefined || response.toolCalls.length === 0
        ? {}
        : {
            toolCalls: response.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              ...(toolCall.input === undefined ? {} : { input: toolCall.input }),
            })),
          }),
    };
    yield {
      delta: "",
      done: true,
      metadata,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    };
  }

  async #finalizeStream(input: {
    readonly request: ChatRequest;
    readonly context: AICallContext;
    readonly classification: AIClassification;
    readonly actor: Actor;
    readonly attempt: AIProviderAttempt;
    readonly providerId: string;
    readonly model: string;
    readonly message: string;
    readonly usage: ChatResponse["usage"];
    readonly estimatedCostCents: number;
    readonly started: bigint;
    readonly span: Span;
  }): Promise<void> {
    const costCents = input.usage?.costCents ?? input.estimatedCostCents;
    await this.#costGuard?.record({
      actor: input.actor,
      feature: input.request.feature,
      providerId: input.providerId,
      model: input.model,
      costCents,
    });
    this.#metrics?.recordLLMChat({
      feature: input.request.feature,
      providerId: input.providerId,
      model: input.model,
      status: "success",
      durationSeconds: durationSecondsSince(input.started),
      fallback: input.attempt.fallback,
      costCents,
    });
    input.span.setAttribute("llm.provider", input.providerId);
    input.span.setAttribute("llm.model", input.model);
    input.span.setAttribute("llm.usage.cost_cents", costCents);
    input.span.setAttribute("helix.ai.fallback.used", input.attempt.fallback);
    if (input.usage?.inputTokens !== undefined) {
      input.span.setAttribute("llm.usage.input_tokens", input.usage.inputTokens);
    }
    if (input.usage?.outputTokens !== undefined) {
      input.span.setAttribute("llm.usage.output_tokens", input.usage.outputTokens);
    }
    if (input.usage?.totalTokens !== undefined) {
      input.span.setAttribute("llm.usage.total_tokens", input.usage.totalTokens);
    }
    this.#recordTokenMetering({
      actor: input.actor,
      feature: input.request.feature,
      providerId: input.providerId,
      model: input.model,
      usage: input.usage,
      costCents,
    });
    await this.#provenance?.record({
      actor: input.actor,
      feature: input.request.feature,
      providerId: input.providerId,
      model: input.model,
      inputHash: hashJson(input.request),
      outputHash: hashJson(input.message),
      metadata: {
        classification: input.classification,
        usage: input.usage ?? {},
        streamed: true,
        routing: {
          fallbackUsed: input.attempt.fallback,
          attemptedProviderId: input.attempt.provider.id,
        },
        ...(input.context.trace === undefined ? {} : { trace: traceMetadata(input.context.trace) }),
      },
    });
  }

  async #chat(
    request: ChatRequest,
    ctx: Partial<AICallContext>,
    span: Span,
  ): Promise<ChatResponse> {
    const classification: AIClassification = ctx.classification ?? "standard"; // SECURITY: server-derived only (A1)
    const actor = ctx.actor ?? this.#systemActor;
    const attempts = await this.#selectProviderAttempts(request, classification);
    const context: AICallContext = {
      actor,
      feature: request.feature,
      classification,
      ...(ctx.trace === undefined ? {} : { trace: ctx.trace }),
      ...(ctx.costLimitCents === undefined ? {} : { costLimitCents: ctx.costLimitCents }),
    };
    span.setAttribute("helix.ai.feature", request.feature);
    span.setAttribute("helix.ai.classification", classification);
    span.setAttribute("helix.actor.id", actor.id);

    let lastError: unknown;
    for (const attempt of attempts) {
      const started = process.hrtime.bigint();
      const modelForMetrics = request.model ?? attempt.model ?? "unknown";
      try {
        const model = request.model ?? attempt.model ?? (await firstModel(attempt.provider));
        assertClassificationAllowed(attempt.provider, classification, this.#policy);
        const estimatedCostCents = await estimateRequestCost(attempt.provider, request, model);
        await this.#costGuard?.reserve({
          actor,
          feature: request.feature,
          providerId: attempt.provider.id,
          model,
          estimatedCostCents,
        });

        const responseOrStream = await attempt.provider.chat(
          { ...request, model, classification },
          context,
        );
        const response = isChatChunkStream(responseOrStream)
          ? await collectChatStream(responseOrStream, attempt.provider.id, model)
          : responseOrStream;
        const output = {
          ...response,
          providerId: response.providerId || attempt.provider.id,
          model: response.model || model,
        };
        const costCents = output.usage?.costCents ?? estimatedCostCents;
        await this.#costGuard?.record({
          actor,
          feature: request.feature,
          providerId: output.providerId,
          model: output.model,
          costCents,
        });
        this.#metrics?.recordLLMChat({
          feature: request.feature,
          providerId: output.providerId,
          model: output.model,
          status: "success",
          durationSeconds: durationSecondsSince(started),
          fallback: attempt.fallback,
          costCents,
        });
        span.setAttribute("llm.provider", output.providerId);
        span.setAttribute("llm.model", output.model);
        span.setAttribute("llm.usage.cost_cents", costCents);
        span.setAttribute("helix.ai.fallback.used", attempt.fallback);
        if (output.usage?.inputTokens !== undefined) {
          span.setAttribute("llm.usage.input_tokens", output.usage.inputTokens);
        }
        if (output.usage?.outputTokens !== undefined) {
          span.setAttribute("llm.usage.output_tokens", output.usage.outputTokens);
        }
        if (output.usage?.totalTokens !== undefined) {
          span.setAttribute("llm.usage.total_tokens", output.usage.totalTokens);
        }
        this.#recordTokenMetering({
          actor,
          feature: request.feature,
          providerId: output.providerId,
          model: output.model,
          usage: output.usage,
          costCents,
        });
        const provenance = await this.#provenance?.record({
          actor,
          feature: request.feature,
          providerId: output.providerId,
          model: output.model,
          inputHash: hashJson(request),
          outputHash: hashJson(output.message),
          metadata: {
            classification,
            usage: output.usage ?? {},
            routing: {
              fallbackUsed: attempt.fallback,
              attemptedProviderId: attempt.provider.id,
            },
            ...(context.trace === undefined ? {} : { trace: traceMetadata(context.trace) }),
          },
        });
        return provenance === undefined
          ? output
          : {
              ...output,
              metadata: {
                ...(output.metadata ?? {}),
                provenanceId: provenance.id,
              },
            };
      } catch (error) {
        this.#metrics?.recordLLMChat({
          feature: request.feature,
          providerId: attempt.provider.id,
          model: modelForMetrics,
          status: "error",
          durationSeconds: durationSecondsSince(started),
          fallback: attempt.fallback,
          errorType: errorName(error),
        });
        lastError = error;
        if (!shouldTryFallback(error) || attempt === attempts[attempts.length - 1]) {
          throw error;
        }
        span.addEvent("llm.chat.fallback", {
          "llm.provider": attempt.provider.id,
          "llm.model": modelForMetrics,
          "exception.type": errorName(error),
          "exception.message": error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AIProviderUnavailableError(
          `No AI provider is configured for feature ${request.feature}.`,
        );
  }

  async #generateImage(
    request: ImageGenerationRequest,
    ctx: Partial<AICallContext>,
    span: Span,
  ): Promise<ImageGenerationResponse> {
    const classification: AIClassification = ctx.classification ?? "standard"; // SECURITY: server-derived only (A1)
    const actor = ctx.actor ?? this.#systemActor;
    const attempts = await this.#selectImageProviderAttempts(request, classification);
    const context: AICallContext = {
      actor,
      feature: request.feature,
      classification,
      ...(ctx.trace === undefined ? {} : { trace: ctx.trace }),
      ...(ctx.costLimitCents === undefined ? {} : { costLimitCents: ctx.costLimitCents }),
    };
    span.setAttribute("helix.ai.feature", request.feature);
    span.setAttribute("helix.ai.classification", classification);
    span.setAttribute("helix.actor.id", actor.id);

    let lastError: unknown;
    for (const attempt of attempts) {
      const modelForMetrics = request.model ?? attempt.model ?? "unknown";
      try {
        const model = request.model ?? attempt.model ?? (await firstModel(attempt.provider));
        const estimatedCostCents = await estimateImageGenerationCost(
          attempt.provider,
          request,
          model,
        );
        assertClassificationAllowed(attempt.provider, classification, this.#policy);
        await this.#costGuard?.reserve({
          actor,
          feature: request.feature,
          providerId: attempt.provider.id,
          model,
          estimatedCostCents,
        });

        const response = await attempt.provider.generateImage(
          { ...request, model, classification },
          context,
        );
        const output = {
          ...response,
          providerId: response.providerId || attempt.provider.id,
          model: response.model || model,
        };
        const costCents = output.usage?.costCents ?? estimatedCostCents;
        await this.#costGuard?.record({
          actor,
          feature: request.feature,
          providerId: output.providerId,
          model: output.model,
          costCents,
        });
        span.setAttribute("llm.provider", output.providerId);
        span.setAttribute("llm.model", output.model);
        span.setAttribute("llm.usage.cost_cents", costCents);
        span.setAttribute("helix.ai.fallback.used", attempt.fallback);
        span.setAttribute("helix.ai.image.count", imageGenerationQuantity(output));
        this.#recordImageMetering({
          actor,
          feature: request.feature,
          providerId: output.providerId,
          model: output.model,
          request,
          response: output,
          costCents,
        });
        return output;
      } catch (error) {
        lastError = error;
        if (!shouldTryFallback(error) || attempt === attempts[attempts.length - 1]) {
          throw error;
        }
        span.addEvent("ai.image.generate.fallback", {
          "llm.provider": attempt.provider.id,
          "llm.model": modelForMetrics,
          "exception.type": errorName(error),
          "exception.message": error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new AIProviderUnavailableError(
          `No AI provider is configured for feature ${request.feature}.`,
        );
  }

  #recordTokenMetering(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly usage: ChatResponse["usage"];
    readonly costCents: number;
  }): void {
    const quantity = tokenQuantity(input.usage);
    if (quantity === undefined || quantity <= 0) {
      return;
    }

    const metadata: JsonObject = {
      provider: input.providerId,
      model: input.model,
      slot: input.feature,
      cost_cents_estimate: input.costCents,
      ...(input.usage?.inputTokens === undefined ? {} : { tokens_in: input.usage.inputTokens }),
      ...(input.usage?.outputTokens === undefined ? {} : { tokens_out: input.usage.outputTokens }),
    };

    void this.#metering
      ?.emit(input.actor.orgId, {
        type: "ai.tokens",
        quantity,
        metadata,
      })
      .catch((error: unknown) => {
        this.#onMeteringError?.(error);
      });
  }

  #recordImageMetering(input: {
    readonly actor: Actor;
    readonly feature: string;
    readonly providerId: string;
    readonly model: string;
    readonly request: ImageGenerationRequest;
    readonly response: ImageGenerationResponse;
    readonly costCents: number;
  }): void {
    const quantity = imageGenerationQuantity(input.response);
    if (quantity <= 0) {
      return;
    }

    const metadata: JsonObject = {
      provider: input.providerId,
      model: input.model,
      slot: input.feature,
      count: quantity,
      ...imageResolutionMetadata(input.request, input.response),
      ...(input.costCents <= 0 ? {} : { cost_cents_estimate: input.costCents }),
    };

    void this.#metering
      ?.emit(input.actor.orgId, {
        type: "ai.image.generated",
        quantity,
        metadata,
      })
      .catch((error: unknown) => {
        this.#onMeteringError?.(error);
      });
  }

  async #selectProviderAttempts(
    request: ChatRequest,
    classification: AIClassification,
  ): Promise<readonly AIProviderAttempt[]> {
    const explicitId =
      request.metadata !== undefined && typeof request.metadata.providerId === "string"
        ? request.metadata.providerId
        : undefined;
    if (explicitId !== undefined) {
      const provider = this.#providers.get(explicitId);
      if (provider !== undefined) {
        return [{ provider, fallback: false }];
      }
      throw new AIProviderUnavailableError(
        `No AI provider is configured for feature ${request.feature}.`,
      );
    }

    const route = this.#policy.featureRoutes?.[request.feature];
    if (route !== undefined) {
      const attempts = [
        this.#attemptFromRef(route.primary, false),
        route.fallback === undefined ? undefined : this.#attemptFromRef(route.fallback, true),
      ].filter((attempt): attempt is AIProviderAttempt => attempt !== undefined);
      const allowedAttempts = attempts.filter((attempt) =>
        providerAllowedForClassification(attempt.provider, classification, this.#policy),
      );
      if (allowedAttempts.length > 0) {
        return dedupeAttempts(allowedAttempts);
      }
    }

    const preferredId =
      this.#policy.featureProviders?.[request.feature] ?? this.#policy.defaultProviderId;
    const provider =
      preferredId === undefined ? this.listProviders()[0] : this.#providers.get(preferredId);
    if (provider !== undefined) {
      if (providerAllowedForClassification(provider, classification, this.#policy)) {
        return [{ provider, fallback: false }];
      }
    }
    const allowed = this.listProviders().find((candidate) =>
      providerAllowedForClassification(candidate, classification, this.#policy),
    );
    if (allowed !== undefined) {
      return [
        { provider: allowed, fallback: preferredId !== undefined && allowed.id !== preferredId },
      ];
    }
    throw new AIProviderUnavailableError(
      `No AI provider is configured for feature ${request.feature}.`,
    );
  }

  #attemptFromRef(ref: AiProviderModelRef, fallback: boolean): AIProviderAttempt | undefined {
    const provider = this.#providers.get(ref.providerId);
    if (provider === undefined) {
      return undefined;
    }
    return {
      provider,
      fallback,
      ...(ref.model === undefined ? {} : { model: ref.model }),
    };
  }

  async #selectImageProviderAttempts(
    request: ImageGenerationRequest,
    classification: AIClassification,
  ): Promise<readonly ImageProviderAttempt[]> {
    const explicitId =
      request.metadata !== undefined && typeof request.metadata.providerId === "string"
        ? request.metadata.providerId
        : undefined;
    if (explicitId !== undefined) {
      const provider = this.#imageProviders.get(explicitId);
      if (provider !== undefined) {
        return [{ provider, fallback: false }];
      }
      throw new AIProviderUnavailableError(
        `No image provider is configured for feature ${request.feature}.`,
      );
    }

    const route = this.#policy.featureRoutes?.[request.feature];
    if (route !== undefined) {
      const attempts = [
        this.#imageAttemptFromRef(route.primary, false),
        route.fallback === undefined ? undefined : this.#imageAttemptFromRef(route.fallback, true),
      ].filter((attempt): attempt is ImageProviderAttempt => attempt !== undefined);
      if (attempts.length === 0) {
        throw new AIProviderUnavailableError(
          `No image provider is configured for feature ${request.feature}.`,
        );
      }
      const allowedAttempts = attempts.filter((attempt) =>
        providerAllowedForClassification(attempt.provider, classification, this.#policy),
      );
      if (allowedAttempts.length > 0) {
        return dedupeImageAttempts(allowedAttempts);
      }
      throw new AIClassificationBlockedError(
        `No image provider configured for ${request.feature} can process ${classification} AI requests.`,
      );
    }

    const preferredId =
      this.#policy.featureProviders?.[request.feature] ?? this.#policy.defaultProviderId;
    const provider =
      preferredId === undefined
        ? this.listImageProviders()[0]
        : this.#imageProviders.get(preferredId);
    if (provider !== undefined) {
      if (providerAllowedForClassification(provider, classification, this.#policy)) {
        return [{ provider, fallback: false }];
      }
    }
    const allowed = this.listImageProviders().find((candidate) =>
      providerAllowedForClassification(candidate, classification, this.#policy),
    );
    if (allowed !== undefined) {
      return [
        { provider: allowed, fallback: preferredId !== undefined && allowed.id !== preferredId },
      ];
    }
    throw new AIProviderUnavailableError(
      `No image provider is configured for feature ${request.feature}.`,
    );
  }

  listImageProviders(): readonly ImageProviderCapability[] {
    return [...this.#imageProviders.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  #imageAttemptFromRef(
    ref: AiProviderModelRef,
    fallback: boolean,
  ): ImageProviderAttempt | undefined {
    const provider = this.#imageProviders.get(ref.providerId);
    if (provider === undefined) {
      return undefined;
    }
    return {
      provider,
      fallback,
      ...(ref.model === undefined ? {} : { model: ref.model }),
    };
  }
}

interface AIProviderAttempt {
  readonly provider: LLMProviderCapability;
  readonly model?: string;
  readonly fallback: boolean;
}

interface ImageProviderAttempt {
  readonly provider: ImageProviderCapability;
  readonly model?: string;
  readonly fallback: boolean;
}

interface ProviderForPolicy {
  readonly id: string;
  readonly tags?: readonly string[];
}

export function providerAllowedForClassification(
  provider: ProviderForPolicy,
  classification: AIClassification,
  policy: AIRoutingPolicy = {},
): boolean {
  if (policy.localAiOnly === true || policy.tier === "sovereign") {
    return providerIsLocalOnly(provider);
  }
  if (policy.classificationEnabled === false || classification === "public") {
    return true;
  }
  if (classification === "standard") {
    return true;
  }
  if (classification === "confidential") {
    return providerHasAnyTag(provider, confidentialProviderTags);
  }
  return providerIsLocalOnly(provider);
}

export function assertClassificationAllowed(
  provider: ProviderForPolicy,
  classification: AIClassification,
  policy: AIRoutingPolicy = {},
): void {
  if (!providerAllowedForClassification(provider, classification, policy)) {
    throw new AIClassificationBlockedError(
      `Provider ${provider.id} cannot process ${classification} AI requests.`,
    );
  }
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function firstModel(
  provider: Pick<LLMProviderCapability | ImageProviderCapability, "id" | "models">,
): Promise<string> {
  const model = (await provider.models())[0];
  if (model === undefined) {
    throw new AIProviderUnavailableError(`Provider ${provider.id} has no models.`);
  }
  return model.id;
}

async function estimateRequestCost(
  provider: LLMProviderCapability,
  request: ChatRequest,
  model: string,
): Promise<number> {
  const models = await provider.models();
  const modelInfo = models.find((candidate) => candidate.id === model);
  const inputText = request.messages.map((message) => message.content).join("\n");
  const inputTokens = await provider.countTokens(inputText, model);
  return ((modelInfo?.inputCostPer1kTokensCents ?? 0) * inputTokens) / 1000;
}

async function estimateImageGenerationCost(
  provider: ImageProviderCapability,
  request: ImageGenerationRequest,
  model: string,
): Promise<number> {
  const models = await provider.models();
  const modelInfo = models.find((candidate) => candidate.id === model);
  return (modelInfo?.imageCostCents ?? 0) * requestedImageCount(request);
}

async function collectChatStream(
  stream: AsyncIterable<{
    readonly delta: string;
    readonly usage?: ChatResponse["usage"];
    readonly metadata?: JsonObject;
  }>,
  providerId: string,
  model: string,
): Promise<ChatResponse> {
  let message = "";
  let usage: ChatResponse["usage"] | undefined;
  let metadata: JsonObject | undefined;
  for await (const chunk of stream) {
    message += chunk.delta;
    usage = chunk.usage ?? usage;
    metadata = chunk.metadata ?? metadata;
  }
  return {
    message,
    providerId,
    model,
    ...(usage === undefined ? {} : { usage }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function isChatChunkStream(value: unknown): value is AsyncIterable<{ readonly delta: string }> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function providerIsLocalOnly(provider: ProviderForPolicy): boolean {
  return providerHasAnyTag(provider, localOnlyProviderTags);
}

function providerHasAnyTag(provider: ProviderForPolicy, tags: readonly string[]): boolean {
  const providerTags = new Set(provider.tags ?? []);
  return tags.some((tag) => providerTags.has(tag));
}

function traceMetadata(trace: TraceContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(trace).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function tokenQuantity(usage: ChatResponse["usage"]): number | undefined {
  if (usage === undefined) {
    return undefined;
  }
  if (usage.totalTokens !== undefined) {
    return usage.totalTokens;
  }
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    return usage.inputTokens + usage.outputTokens;
  }
  return undefined;
}

function imageGenerationQuantity(response: ImageGenerationResponse): number {
  const usageCount = response.usage?.imageCount;
  if (usageCount !== undefined && Number.isFinite(usageCount) && usageCount > 0) {
    return Math.trunc(usageCount);
  }
  return response.images.length;
}

function requestedImageCount(request: ImageGenerationRequest): number {
  if (request.count !== undefined && Number.isFinite(request.count) && request.count > 0) {
    return Math.trunc(request.count);
  }
  return 1;
}

function imageResolutionMetadata(
  request: ImageGenerationRequest,
  response: ImageGenerationResponse,
): JsonObject {
  const requested = normalizeImageResolution(request.size);
  if (requested !== undefined) {
    return { resolution: requested };
  }

  for (const image of response.images) {
    if (
      image.width !== undefined &&
      image.height !== undefined &&
      Number.isFinite(image.width) &&
      Number.isFinite(image.height) &&
      image.width > 0 &&
      image.height > 0
    ) {
      const width = Math.trunc(image.width);
      const height = Math.trunc(image.height);
      return { resolution: `${String(width)}x${String(height)}` };
    }
  }
  return {};
}

function normalizeImageResolution(size: string | undefined): string | undefined {
  if (size === undefined) {
    return undefined;
  }
  const match = /^([1-9]\d{0,4})[xX]([1-9]\d{0,4})$/.exec(size.trim());
  if (match === null) {
    return undefined;
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return undefined;
  }
  if (width > 16_384 || height > 16_384) {
    return undefined;
  }
  return `${String(width)}x${String(height)}`;
}

function durationSecondsSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000_000;
}

function dedupeAttempts(attempts: readonly AIProviderAttempt[]): readonly AIProviderAttempt[] {
  const seen = new Set<string>();
  const deduped: AIProviderAttempt[] = [];
  for (const attempt of attempts) {
    const key = `${attempt.provider.id}:${attempt.model ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(attempt);
  }
  return deduped;
}

function dedupeImageAttempts(
  attempts: readonly ImageProviderAttempt[],
): readonly ImageProviderAttempt[] {
  const seen = new Set<string>();
  const deduped: ImageProviderAttempt[] = [];
  for (const attempt of attempts) {
    const key = `${attempt.provider.id}:${attempt.model ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(attempt);
  }
  return deduped;
}

function shouldTryFallback(error: unknown): boolean {
  return errorName(error) !== "AICostLimitExceededError";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
