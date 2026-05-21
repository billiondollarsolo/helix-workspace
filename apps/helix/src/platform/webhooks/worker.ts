import type { EventBus, EventEnvelope, Unsubscribe } from "@helix/sdk-types";
import {
  defaultWebhookRetryPolicy,
  deliverOutboundWebhook,
  dispatchClaimedOutboundDelivery,
  type WebhookDeliveryStore,
  type WebhookHttpClient,
  type WebhookRetryPolicy,
} from "./delivery.js";
import type {
  OutboundWebhookRecord,
  WebhookDeliveryRecord,
  WebhookSecretResolver,
} from "./store.js";

export interface OutboundWebhookWorkerStore extends WebhookDeliveryStore {
  listEnabledOutbound(): Promise<readonly OutboundWebhookRecord[]>;
  getOutbound(orgId: string, id: string): Promise<OutboundWebhookRecord | null>;
  claimDueOutboundDeliveries(input?: {
    readonly limit?: number | undefined;
    readonly now?: Date | undefined;
  }): Promise<readonly WebhookDeliveryRecord[]>;
}

export interface OutboundWebhookWorkerOptions {
  readonly store: OutboundWebhookWorkerStore;
  readonly events: EventBus;
  readonly httpClient?: WebhookHttpClient;
  readonly subject?: string;
  readonly retryBatchSize?: number;
  readonly retryIntervalMs?: number;
  readonly retryPolicy?: WebhookRetryPolicy;
  readonly secretResolver?: WebhookSecretResolver;
  readonly onError?: (error: unknown) => void;
}

export interface OutboundWebhookDrainResult {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
}

export class OutboundWebhookWorker {
  private readonly subject: string;
  private readonly retryBatchSize: number;
  private readonly retryIntervalMs: number;
  private readonly retryPolicy: WebhookRetryPolicy;
  private readonly onError: ((error: unknown) => void) | undefined;
  private unsubscribe: Unsubscribe | undefined;
  private timer: NodeJS.Timeout | undefined;
  private activeDrain: Promise<OutboundWebhookDrainResult> | undefined;

  constructor(private readonly options: OutboundWebhookWorkerOptions) {
    this.subject = options.subject ?? ">";
    this.retryBatchSize = options.retryBatchSize ?? 100;
    this.retryIntervalMs = options.retryIntervalMs ?? 1_000;
    this.retryPolicy = options.retryPolicy ?? defaultWebhookRetryPolicy;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      return;
    }

    this.unsubscribe = await this.options.events.subscribe(this.subject, async (event) => {
      await this.handle(event);
    });
    this.timer = setInterval(() => {
      void this.runScheduledDrain();
    }, this.retryIntervalMs);
    void this.runScheduledDrain();
  }

  async stop(): Promise<void> {
    if (this.unsubscribe !== undefined) {
      const unsubscribe = this.unsubscribe;
      this.unsubscribe = undefined;
      await unsubscribe();
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.activeDrain !== undefined) {
      await this.activeDrain;
    }
  }

  async handle(event: EventEnvelope): Promise<OutboundWebhookDrainResult> {
    const webhooks = await this.options.store.listEnabledOutbound();
    const matching = webhooks.filter(
      (webhook) =>
        webhook.enabled &&
        webhook.eventSubjects.some((pattern) => webhookSubjectMatches(pattern, event.subject)),
    );
    const results = await Promise.all(
      matching.map(async (webhook) => {
        try {
          const delivery = await deliverOutboundWebhook({
            store: this.options.store,
            webhook,
            event: {
              subject: event.subject,
              payload: event.payload,
              occurredAt: new Date(event.occurredAt),
            },
            ...(event.trace === undefined ? {} : { trace: event.trace }),
            ...(this.options.secretResolver === undefined
              ? {}
              : { secretResolver: this.options.secretResolver }),
            ...(this.options.httpClient === undefined
              ? {}
              : { httpClient: this.options.httpClient }),
            retryPolicy: this.retryPolicy,
          });
          return delivery?.status === "delivered";
        } catch (error) {
          this.onError?.(error);
          return false;
        }
      }),
    );

    return summarizeResults(results);
  }

  async drainRetries(now = new Date()): Promise<OutboundWebhookDrainResult> {
    const deliveries = await this.options.store.claimDueOutboundDeliveries({
      limit: this.retryBatchSize,
      now,
    });
    const results = await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          if (delivery.outboundWebhookId === null) {
            await this.abandonDelivery(delivery, "Outbound delivery is missing a webhook id");
            return false;
          }

          const webhook = await this.options.store.getOutbound(
            delivery.orgId,
            delivery.outboundWebhookId,
          );
          if (webhook === null || !webhook.enabled) {
            await this.abandonDelivery(delivery, "Outbound webhook is unavailable or disabled");
            return false;
          }

          const updated = await dispatchClaimedOutboundDelivery({
            store: this.options.store,
            webhook,
            delivery,
            ...(this.options.secretResolver === undefined
              ? {}
              : { secretResolver: this.options.secretResolver }),
            ...(this.options.httpClient === undefined
              ? {}
              : { httpClient: this.options.httpClient }),
            now,
            retryPolicy: this.retryPolicy,
          });
          return updated?.status === "delivered";
        } catch (error) {
          this.onError?.(error);
          return false;
        }
      }),
    );

    return summarizeResults(results);
  }

  private runScheduledDrain(): Promise<OutboundWebhookDrainResult> {
    if (this.activeDrain !== undefined) {
      return this.activeDrain;
    }

    this.activeDrain = this.drainRetries()
      .catch((error: unknown) => {
        this.onError?.(error);
        return { attempted: 0, delivered: 0, failed: 0 };
      })
      .finally(() => {
        this.activeDrain = undefined;
      });

    return this.activeDrain;
  }

  private async abandonDelivery(delivery: WebhookDeliveryRecord, error: string): Promise<void> {
    await this.options.store.updateDeliveryStatus({
      id: delivery.id,
      status: "abandoned",
      attempt: delivery.attempt,
      error,
      nextAttemptAt: null,
      deliveredAt: null,
    });
  }
}

export function webhookSubjectMatches(pattern: string, subject: string): boolean {
  const patternParts = pattern.split(".");
  const subjectParts = subject.split(".");

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart === ">") {
      return index === patternParts.length - 1;
    }
    if (subjectParts[index] === undefined) {
      return false;
    }
    if (patternPart !== "*" && patternPart !== subjectParts[index]) {
      return false;
    }
  }

  return patternParts.length === subjectParts.length;
}

function summarizeResults(results: readonly boolean[]): OutboundWebhookDrainResult {
  const delivered = results.filter(Boolean).length;
  return {
    attempted: results.length,
    delivered,
    failed: results.length - delivered,
  };
}
