import type { AICapability, AIClassification, JsonObject } from "@helix/sdk-types";
import { deriveClassification, type ClassificationPolicy } from "../../ai/classification/index.js";
import type {
  EnrichmentEvent,
  EnrichmentHandler,
  EnrichmentWorker,
} from "../../ai/enrichment/index.js";
import type {
  MailActivityPayload,
  MailEnrichmentProjectionStore,
  MailEnrichmentRecord,
} from "../types.js";

export interface MailEntityExtractEnrichmentOptions {
  readonly store: MailEnrichmentProjectionStore;
  readonly ai: AICapability;
}

export interface MailClassificationEnrichmentOptions {
  readonly store: MailEnrichmentProjectionStore;
  readonly policy?: ClassificationPolicy | undefined;
  readonly scanContent?: boolean | undefined;
}

export interface MailEnrichmentRegistrationOptions {
  readonly store: MailEnrichmentProjectionStore;
  readonly ai?: AICapability | undefined;
  readonly entityExtract?: boolean | undefined;
  readonly classification?: boolean | undefined;
  readonly classificationPolicy?: ClassificationPolicy | undefined;
  readonly scanContentForClassification?: boolean | undefined;
}

export function registerMailEnrichments(
  worker: EnrichmentWorker,
  options: MailEnrichmentRegistrationOptions,
): void {
  if (options.entityExtract === true) {
    if (options.ai === undefined) {
      throw new TypeError("mail.entity-extract enrichment requires an AI capability");
    }
    worker.register(
      createMailEntityExtractEnrichmentHandler({ store: options.store, ai: options.ai }),
    );
  }

  if (options.classification === true) {
    worker.register(
      createMailClassificationEnrichmentHandler({
        store: options.store,
        policy: options.classificationPolicy,
        scanContent: options.scanContentForClassification,
      }),
    );
  }
}

export function createMailEntityExtractEnrichmentHandler(
  options: MailEntityExtractEnrichmentOptions,
): EnrichmentHandler<MailActivityPayload> {
  return {
    id: "mail.entity-extract",
    feature: "mail.entity-extract",
    subjects: ["activity.mail.created", "activity.mail.received"],
    async enrich(event) {
      const message = await messageForEnrichment(event, options.store);
      if (message === null) {
        return skipped("mail.entity-extract", event, "message not found");
      }

      const classification = message.classification ?? "standard";
      const response = await options.ai.chat(
        {
          feature: "mail.entity-extract",
          classification,
          messages: [
            {
              role: "system",
              content:
                "Extract people, dates, and action items from this email. Return compact JSON.",
            },
            {
              role: "user",
              content: mailRecordText(message),
            },
          ],
        },
        {
          feature: "mail.entity-extract",
          classification,
        },
      );
      const data = parseJsonObject(response.message) ?? { text: response.message };
      await options.store.recordMailEnrichment?.({
        messageId: message.id,
        feature: "mail.entity-extract",
        data,
      });

      return {
        handlerId: "mail.entity-extract",
        feature: "mail.entity-extract",
        status: "applied",
        resourceType: "mail.message",
        resourceId: message.id,
        metadata: {
          data,
          providerId: response.providerId,
          model: response.model,
        },
      };
    },
  };
}

export function createMailClassificationEnrichmentHandler(
  options: MailClassificationEnrichmentOptions,
): EnrichmentHandler<MailActivityPayload> {
  return {
    id: "mail.classification",
    feature: "mail.classification",
    subjects: ["activity.mail.created", "activity.mail.received", "activity.mail.updated"],
    async enrich(event) {
      const message = await messageForEnrichment(event, options.store);
      if (message === null) {
        return skipped("mail.classification", event, "message not found");
      }

      const derived = deriveClassification(
        {
          explicit: message.classification,
          labels: message.labels,
          path: message.folder,
          content: message.body,
          scanContent: options.scanContent ?? true,
        },
        options.policy,
      );
      await options.store.setMailClassification?.({
        messageId: message.id,
        classification: derived.classification,
        source: derived.source,
        reason: derived.reason,
      });

      return {
        handlerId: "mail.classification",
        feature: "mail.classification",
        status: "applied",
        resourceType: "mail.message",
        resourceId: message.id,
        metadata: {
          classification: derived.classification,
          source: derived.source,
          reason: derived.reason,
        },
      };
    },
  };
}

async function messageForEnrichment(
  event: EnrichmentEvent<MailActivityPayload>,
  store: MailEnrichmentProjectionStore,
): Promise<MailEnrichmentRecord | null> {
  const messageId = event.payload.messageId ?? event.payload.id;
  if (typeof messageId !== "string" || messageId.length === 0) {
    return null;
  }
  return store.getMailEnrichmentRecord(messageId);
}

function skipped(feature: string, event: EnrichmentEvent<MailActivityPayload>, reason: string) {
  return {
    handlerId: feature,
    feature,
    status: "skipped" as const,
    metadata: {
      subject: event.subject,
      reason,
    },
  };
}

function mailRecordText(message: MailEnrichmentRecord): string {
  return [
    `From: ${addressEmail(message.from)}`,
    `To: ${message.to.map(addressEmail).join(", ")}`,
    `Subject: ${message.subject}`,
    message.body,
  ].join("\n");
}

function addressEmail(address: {
  readonly address: string;
  readonly email?: string | undefined;
}): string {
  return address.email ?? address.address;
}

function parseJsonObject(text: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : undefined;
  } catch {
    return undefined;
  }
}

export function mailClassificationFromMetadata(
  metadata: JsonObject | undefined,
): AIClassification | undefined {
  const value = metadata?.classification;
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? value
    : undefined;
}
