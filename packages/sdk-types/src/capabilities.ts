import type {
  Actor,
  EventEnvelope,
  EventBus,
  ResourceRef,
  StorageClient,
  TraceContext,
} from "./core.js";
import type { HelixConfig, PluginConfig, SecurityTier } from "./config.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { PendingToolInvocation, ToolDefinition, ToolSideEffect } from "./tools.js";

export interface AuthCapability {
  getActor(actorId: string): Promise<Actor | null>;
  issueAccessToken(actor: Actor, scopes: readonly string[], ttlSeconds?: number): Promise<string>;
}

export interface PermissionsCapability {
  can(actor: Actor, action: string, resource: ResourceRef): Promise<boolean>;
  require(actor: Actor, action: string, resource: ResourceRef): Promise<void>;
}

export type StorageCapability = StorageClient;

export interface SearchDocument {
  readonly id: string;
  readonly type: string;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly attributes?: JsonObject;
}

export interface SearchCapability {
  index(document: SearchDocument): Promise<void>;
  remove(id: string): Promise<void>;
  query(
    text: string,
    opts?: { readonly types?: readonly string[]; readonly limit?: number },
  ): Promise<SearchDocument[]>;
}

export interface VectorRecord {
  readonly id: string;
  readonly vector: readonly number[];
  readonly metadata?: JsonObject;
}

export interface VectorMatch extends VectorRecord {
  readonly score: number;
}

export interface VectorStoreCapability {
  readonly id?: string;
  createCollection?(name: string, dim: number, metric: VectorMetric): Promise<void>;
  upsert(records: readonly VectorRecord[]): Promise<void>;
  query(
    vector: readonly number[],
    opts?: { readonly collection?: string; readonly limit?: number; readonly filter?: JsonObject },
  ): Promise<VectorMatch[]>;
  delete(ids: readonly string[]): Promise<void>;
}

export type VectorMetric = "cosine" | "dot" | "l2";

export type AIProviderProtocol =
  | "openai-compatible"
  | "anthropic-compatible"
  | "bedrock"
  | "vertex";

export type AIClassification = "public" | "standard" | "confidential" | "restricted";

export interface AIMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly name?: string;
}

export interface AIToolChoice {
  readonly id: string;
  readonly input?: JsonObject;
}

export interface ChatRequest {
  readonly feature: string;
  readonly messages: readonly AIMessage[];
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly classification?: AIClassification;
  readonly metadata?: JsonObject;
}

export interface AICallContext {
  readonly actor: Actor;
  readonly trace?: TraceContext;
  readonly feature: string;
  readonly classification: AIClassification;
  readonly costLimitCents?: number;
}

export interface ChatUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly costCents?: number;
}

export interface ChatResponse {
  readonly message: string;
  readonly model: string;
  readonly providerId: string;
  readonly usage?: ChatUsage;
  readonly toolCalls?: readonly AIToolChoice[];
  readonly metadata?: JsonObject;
}

export interface ChatChunk {
  readonly delta: string;
  readonly done?: boolean;
  readonly usage?: ChatUsage;
  readonly metadata?: JsonObject;
}

export interface ImageGenerationRequest {
  readonly feature: string;
  readonly prompt: string;
  readonly model?: string;
  readonly count?: number;
  readonly size?: string;
  readonly classification?: AIClassification;
  readonly metadata?: JsonObject;
}

export interface GeneratedImage {
  readonly url?: string;
  readonly b64Json?: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly metadata?: JsonObject;
}

export interface ImageGenerationUsage {
  readonly imageCount?: number;
  readonly costCents?: number;
}

export interface ImageGenerationResponse {
  readonly providerId: string;
  readonly model: string;
  readonly images: readonly GeneratedImage[];
  readonly usage?: ImageGenerationUsage;
  readonly metadata?: JsonObject;
}

export interface ImageProviderCapability {
  readonly id: string;
  readonly protocol: AIProviderProtocol;
  readonly tags?: readonly string[];
  generateImage(
    req: ImageGenerationRequest,
    ctx: AICallContext,
  ): Promise<ImageGenerationResponse>;
  models(): Promise<readonly ModelInfo[]>;
}

export interface ModelInfo {
  readonly id: string;
  readonly displayName?: string;
  readonly contextWindow?: number;
  readonly inputCostPer1kTokensCents?: number;
  readonly outputCostPer1kTokensCents?: number;
  readonly imageCostCents?: number;
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
}

export interface LLMProviderCapability {
  readonly id: string;
  readonly protocol: AIProviderProtocol;
  readonly tags?: readonly string[];
  chat(req: ChatRequest, ctx: AICallContext): Promise<ChatResponse> | AsyncIterable<ChatChunk>;
  /**
   * Streams a chat completion as incremental {@link ChatChunk} values. The
   * final chunk carries `done: true` plus assembled usage and tool calls.
   * Optional: providers that cannot stream omit this and the router falls
   * back to {@link LLMProviderCapability.chat}.
   */
  chatStream?(req: ChatRequest, ctx: AICallContext): AsyncIterable<ChatChunk>;
  models(): Promise<readonly ModelInfo[]>;
  countTokens(text: string, model: string): Promise<number>;
}

export interface EmbedOptions {
  readonly model?: string;
  readonly dimensions?: number;
}

export interface EmbeddingProviderCapability {
  readonly id: string;
  readonly maxBatchSize: number;
  embed(texts: readonly string[], opts?: EmbedOptions): Promise<readonly (readonly number[])[]>;
  dimensions(model?: string): number;
}

export interface SuggestionContext {
  readonly actor: Actor;
  readonly feature: string;
  readonly resource?: ResourceRef;
  readonly input?: JsonObject;
}

export interface SuggestionChunk {
  readonly text: string;
  readonly done?: boolean;
  readonly metadata?: JsonObject;
}

export interface SuggestionSlotProviderCapability {
  readonly slotId: string;
  available(ctx: SuggestionContext): Promise<boolean>;
  generate(ctx: SuggestionContext): AsyncIterable<SuggestionChunk>;
}

export interface Enrichment {
  readonly id: string;
  readonly type: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly data: JsonObject;
  readonly provenanceId?: string;
}

export interface EnrichmentHandlerCapability {
  readonly id: string;
  readonly triggers: readonly string[];
  produce(event: EventEnvelope, host: unknown): Promise<Enrichment | null>;
}

export interface MemoryItem {
  readonly id: string;
  readonly actorId: string;
  readonly content: string;
  readonly score?: number;
  readonly metadata?: JsonObject;
  readonly createdAt?: string;
}

export interface MemoryInput {
  readonly content: string;
  readonly metadata?: JsonObject;
}

export interface ForgetCriteria {
  readonly ids?: readonly string[];
  readonly olderThan?: string;
  readonly all?: boolean;
}

export interface MemoryStoreCapability {
  readonly id: string;
  recall(actor: Actor, query: string, k: number): Promise<readonly MemoryItem[]>;
  store(actor: Actor, item: MemoryInput): Promise<MemoryItem>;
  forget(actor: Actor, criteria: ForgetCriteria): Promise<number>;
}

export interface Notification {
  readonly source: string;
  readonly actorId?: string;
  readonly subject: string;
  readonly body: string;
  readonly metadata?: JsonObject;
}

export interface NotifierCapability {
  emit(notification: Notification): Promise<void>;
}

export interface AuditRecord {
  readonly actorId: string;
  readonly onBehalfOfActorId?: string;
  readonly verb: string;
  readonly objectType: string;
  readonly objectId?: string;
  readonly toolId?: string;
  readonly trace?: TraceContext;
  readonly metadata?: JsonObject;
  readonly previousHash?: string;
  readonly createdAt?: string;
}

export interface AuditCapability {
  append(record: AuditRecord): Promise<{ readonly id: string; readonly thisHash: string }>;
}

export interface OutboxMessage<Payload extends JsonValue = JsonValue> {
  readonly subject: string;
  readonly payload: Payload;
  readonly trace?: TraceContext;
  readonly delayUntil?: string;
}

export interface OutboxCapability {
  enqueue(message: OutboxMessage): Promise<string>;
}

export type WebhookDirection = "inbound" | "outbound";
export type WebhookDeliveryStatus = "pending" | "delivering" | "delivered" | "failed" | "abandoned";

export interface OutboundWebhookEndpoint {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly url: string;
  readonly eventSubjects: readonly string[];
  readonly format: string;
  readonly secretRef?: string;
  readonly metadata?: JsonObject;
  readonly enabled: boolean;
}

export interface OutboundWebhookEvent {
  readonly subject: string;
  readonly payload: JsonValue;
  readonly occurredAt?: string;
  readonly trace?: TraceContext;
}

export interface OutboundWebhookDelivery {
  readonly id: string;
  readonly orgId: string;
  readonly outboundWebhookId: string;
  readonly status: WebhookDeliveryStatus;
  readonly attempt: number;
  readonly requestUrl: string;
  readonly requestHeaders?: JsonObject;
  readonly requestBody?: string;
  readonly responseStatus?: number;
  readonly responseBody?: string;
  readonly error?: string;
  readonly nextAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WebhookOutboundCapability {
  registerFormat(formatId: string, formatter: WebhookOutboundFormatter): void;
  enqueue(input: {
    readonly endpoint: OutboundWebhookEndpoint;
    readonly event: OutboundWebhookEvent;
  }): Promise<OutboundWebhookDelivery | null>;
  deliverDue?(limit?: number): Promise<readonly OutboundWebhookDelivery[]>;
}

export interface WebhookOutboundFormatter {
  format(input: {
    readonly endpoint: OutboundWebhookEndpoint;
    readonly event: OutboundWebhookEvent;
  }): Promise<{
    readonly headers: JsonObject;
    readonly body: string;
  }>;
}

export interface InboundWebhookSource {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly sourceType: string;
  readonly secretRef?: string;
  readonly routing?: JsonObject;
  readonly metadata?: JsonObject;
  readonly enabled: boolean;
}

export interface InboundWebhookRequest {
  readonly source: InboundWebhookSource;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly rawBody: string;
  readonly receivedAt?: string;
  readonly remoteAddress?: string;
  readonly trace?: TraceContext;
}

export interface InboundWebhookEvent {
  readonly subject: string;
  readonly payload: JsonObject;
  readonly externalId?: string;
  readonly occurredAt?: string;
  readonly metadata?: JsonObject;
}

export interface WebhookInboundCapability {
  registerSourceVerifier(sourceType: string, verifier: WebhookInboundVerifier): void;
  verify(input: InboundWebhookRequest): Promise<InboundWebhookEvent>;
}

export interface WebhookInboundVerifier {
  verify(input: InboundWebhookRequest): Promise<InboundWebhookEvent>;
}

/**
 * A single outbound mail message handed to an {@link OutboundMailProvider}.
 * Provider-neutral: adapters translate this into their wire format (SES
 * SendRawEmail, the Mailgun HTTP API, an SMTP envelope, the Postmark API, ...).
 */
export interface OutboundMailMessage {
  readonly from: { readonly address: string; readonly name?: string };
  readonly to: readonly { readonly address: string; readonly name?: string }[];
  readonly cc: readonly { readonly address: string; readonly name?: string }[];
  readonly bcc: readonly { readonly address: string; readonly name?: string }[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly {
    readonly filename?: string;
    readonly contentType?: string;
    readonly content: Uint8Array;
  }[];
}

/** Result of an {@link OutboundMailProvider} delivery attempt. */
export interface OutboundMailDelivery {
  /** Provider-assigned message id, when the provider returns one. */
  readonly providerMessageId?: string;
  /** Structured, non-secret provider response metadata. */
  readonly metadata?: JsonObject;
}

/**
 * Pluggable outbound mail delivery provider. Each adapter (SES, Mailgun, an
 * SMTP relay, Postmark) implements this so outbound dispatch is provider-
 * agnostic and org-admin-selectable.
 */
export interface OutboundMailProvider {
  /** Stable provider kind (`ses` | `mailgun` | `smtp` | `postmark`). */
  readonly kind: string;
  /** Human-readable provider instance name (for diagnostics / audit). */
  readonly name: string;
  /** Deliver one message, returning the provider message id when available. */
  send(message: OutboundMailMessage): Promise<OutboundMailDelivery>;
}

export interface AICapability {
  chat(request: ChatRequest, ctx?: Partial<AICallContext>): Promise<ChatResponse>;
  generateImage?(
    request: ImageGenerationRequest,
    ctx?: Partial<AICallContext>,
  ): Promise<ImageGenerationResponse>;
  /**
   * Streams a chat completion as incremental {@link ChatChunk} values.
   * Optional: routers that cannot stream omit this and callers fall back to
   * {@link AICapability.chat}.
   */
  chatStream?(request: ChatRequest, ctx?: Partial<AICallContext>): AsyncIterable<ChatChunk>;
}

export interface ConfigCapability {
  readonly tier: SecurityTier;
  getPluginConfig(pluginId: string): PluginConfig;
  getEffectiveConfig(): HelixConfig;
}

export interface ToolsCapability {
  register(tool: ToolDefinition): void;
  unregister(toolId: string): void;
  list(): readonly ToolDefinition[];
  requiresConfirmation(sideEffect: ToolSideEffect, explicit?: boolean): boolean;
  createPendingInvocation(
    invocation: Omit<PendingToolInvocation, "id" | "status" | "createdAt">,
  ): Promise<PendingToolInvocation>;
}

export interface PlatformCapabilities {
  readonly auth: AuthCapability;
  readonly permissions: PermissionsCapability;
  readonly storage: StorageCapability;
  readonly search: SearchCapability;
  readonly notifier: NotifierCapability;
  readonly events: EventBus;
  readonly audit: AuditCapability;
  readonly outbox: OutboxCapability;
  readonly config: ConfigCapability;
  readonly tools: ToolsCapability;
  readonly webhooks?: {
    readonly inbound?: WebhookInboundCapability | null;
    readonly outbound?: WebhookOutboundCapability | null;
  };
  readonly ai?: AICapability | null;
  readonly vectorStore?: VectorStoreCapability | null;
  readonly embedding?: EmbeddingProviderCapability | null;
  readonly memory?: MemoryStoreCapability | null;
}
