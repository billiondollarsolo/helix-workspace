import type { EventBus, EventEnvelope, Unsubscribe } from "@helix/sdk-types";
import type { PlatformMetrics } from "../../../api/metrics.js";
import { deriveClassification, maxClassification } from "../../ai/classification/policy.js";
import type { ResourceClassificationService } from "../../ai/classification/service.js";
import { isRecord } from "../../util/json.js";
import { decisionConfigVersion, type ResolvedDecisionModelConfig } from "./config.js";
import { decisionEvidence, type DecisionAction } from "./evidence.js";
import { DecisionModelError } from "./protocol.js";
import { createDecisionModelProvider, type DecisionModelProvider } from "./providers.js";
import type { DecisionVerdictWrite, PostgresMailDecisionStore } from "./store.js";
import { buildTriageRequest, summarizeTriage, triageState } from "./triage.js";

/**
 * Post-storage decision-model pass. Listens for `activity.mail.received`
 * (published by the outbox after the message commits), so SMTP accept never
 * waits on a model. Events are queued and handled with bounded concurrency;
 * every failure fails open: no mailbox change, an `error` verdict row, and a
 * metric.
 */

type DecisionStore = Pick<
  PostgresMailDecisionStore,
  | "loadCandidate"
  | "readCredential"
  | "recordVerdict"
  | "setActionTaken"
  | "writeEvidence"
  | "markSpam"
  | "applyCategory"
  | "publishMailboxUpdates"
>;

export interface MailDecisionWorkerOptions {
  readonly events: Pick<EventBus, "subscribe">;
  readonly store: DecisionStore;
  readonly loadConfig: (orgId: string) => Promise<ResolvedDecisionModelConfig>;
  /** Run one short database phase in the org's RLS context (never across the provider call). */
  readonly runForTenant: <T>(orgId: string, operation: () => Promise<T>) => Promise<T>;
  readonly createProvider?:
    | ((config: ResolvedDecisionModelConfig, credential: string) => DecisionModelProvider)
    | undefined;
  readonly classifications?: Pick<ResourceClassificationService, "get"> | undefined;
  readonly metrics?: Pick<PlatformMetrics, "recordMailDecision"> | undefined;
  readonly concurrency?: number | undefined;
  readonly maxQueue?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown, context: { readonly orgId: string }) => void) | undefined;
}

export type MailDecisionOutcome =
  | { readonly status: "ignored"; readonly reason: string }
  | { readonly status: "skipped"; readonly reason: string }
  | { readonly status: "error"; readonly reason: string }
  | { readonly status: "decided"; readonly action: DecisionAction; readonly shadow: boolean };

const SUBJECT = "activity.mail.received";

export class MailDecisionWorker {
  readonly #options: MailDecisionWorkerOptions;
  readonly #inFlight = new Set<string>();
  readonly #queue: { readonly orgId: string; readonly messageId: string }[] = [];
  readonly #running = new Set<Promise<void>>();
  #unsubscribe: Unsubscribe | undefined;

  constructor(options: MailDecisionWorkerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#unsubscribe !== undefined) return;
    this.#unsubscribe = await this.#options.events.subscribe(SUBJECT, async (event) => {
      this.enqueue(event);
    });
  }

  async stop(): Promise<void> {
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = undefined;
    this.#queue.length = 0;
    await unsubscribe?.();
    await Promise.allSettled([...this.#running]);
  }

  /** Accept an event without waiting for the model. Duplicate recipient events collapse. */
  enqueue(event: Pick<EventEnvelope, "payload">): void {
    const target = eventTarget(event.payload);
    if (target === null) return;
    const key = `${target.orgId}:${target.messageId}`;
    if (this.#inFlight.has(key)) return;
    if (this.#queue.length >= (this.#options.maxQueue ?? 1000)) {
      this.#options.metrics?.recordMailDecision?.({ provider: "none", outcome: "skipped" });
      return;
    }
    this.#inFlight.add(key);
    this.#queue.push(target);
    this.#pump();
  }

  /** Resolves once every queued message has been handled (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
  }

  #pump(): void {
    while (this.#running.size < (this.#options.concurrency ?? 4) && this.#queue.length > 0) {
      const target = this.#queue.shift();
      if (target === undefined) return;
      const task = this.process(target)
        .then(() => undefined)
        .catch((error: unknown) => {
          this.#options.onError?.(error, { orgId: target.orgId });
        })
        .finally(() => {
          this.#inFlight.delete(`${target.orgId}:${target.messageId}`);
          this.#running.delete(task);
          this.#pump();
        });
      this.#running.add(task);
    }
  }

  async process(target: {
    readonly orgId: string;
    readonly messageId: string;
  }): Promise<MailDecisionOutcome> {
    const { orgId, messageId } = target;
    const options = this.#options;
    const config = await options.loadConfig(orgId);
    if (config.mode === "off") return { status: "ignored", reason: "mode_off" };
    const loaded = await options.runForTenant(orgId, () =>
      options.store.loadCandidate({ orgId, messageId }),
    );
    if (loaded === null) return { status: "ignored", reason: "message_not_found" };
    if (!loaded.external) return { status: "ignored", reason: "not_external" };
    if (loaded.alreadyRecorded) return { status: "ignored", reason: "already_recorded" };

    const { candidate } = loaded;
    const base: Omit<DecisionVerdictWrite, "outcome"> = {
      orgId,
      messageId,
      threadId: candidate.threadId,
      provider: config.provider,
      model: config.model,
      mode: config.mode,
      configVersion: decisionConfigVersion(config),
      spamAssassin: candidate.spamAssassin,
      senderDomain: loaded.senderDomain,
    };
    const skip = async (reason: string): Promise<MailDecisionOutcome> => {
      await options.runForTenant(orgId, () =>
        options.store.recordVerdict({ ...base, outcome: "skipped", reason }),
      );
      options.metrics?.recordMailDecision?.({ provider: config.provider, outcome: "skipped" });
      return { status: "skipped", reason };
    };

    const request = buildTriageRequest(candidate);
    const classification = await this.#classification(orgId, messageId, {
      explicit: loaded.explicitClassification,
      labels: loaded.labels,
      content: triageState(candidate),
    });
    if (classification === "restricted" || classification === "confidential") {
      return skip(`classified_${classification}`);
    }
    if (loaded.providerCallsToday >= config.dailyMessageCap) return skip("daily_cap");
    let credential: string | null;
    try {
      credential = await options.runForTenant(orgId, () =>
        options.store.readCredential(orgId, config.provider),
      );
    } catch {
      return skip("credential_unreadable");
    }
    if (credential === null) return skip("credential_missing");

    const provider = (options.createProvider ?? createDecisionModelProvider)(config, credential);
    const started = performance.now();
    let result;
    try {
      result = await provider.decide(request);
    } catch (error) {
      const reason = error instanceof DecisionModelError ? error.code : "provider_unavailable";
      await options.runForTenant(orgId, () =>
        options.store.recordVerdict({
          ...base,
          outcome: "error",
          reason,
          latencyMs: Math.round(performance.now() - started),
        }),
      );
      options.metrics?.recordMailDecision?.({ provider: config.provider, outcome: "error" });
      return { status: "error", reason };
    }
    const latencySeconds = (performance.now() - started) / 1000;
    const summary = summarizeTriage(result, config);
    if (summary.verdict === null) {
      await options.runForTenant(orgId, () =>
        options.store.recordVerdict({ ...base, outcome: "error", reason: "invalid_response" }),
      );
      options.metrics?.recordMailDecision?.({ provider: config.provider, outcome: "error" });
      return { status: "error", reason: "invalid_response" };
    }

    const persisted = await options.runForTenant(orgId, async () => {
      const inserted = await options.store.recordVerdict({
        ...base,
        model: result.model,
        outcome: "decided",
        summary,
        latencyMs: Math.round(latencySeconds * 1000),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
      if (!inserted || config.mode !== "enforce") return { inserted, action: "none" as const };
      const action = await this.#enforce(loaded, summary.proposedAction, summary.category, {
        provider: config.provider,
        model: result.model,
        verdict: summary.verdict,
        confidence: summary.verdictConfidence,
      });
      const evidence = decisionEvidence({
        provider: config.provider,
        model: result.model,
        summary,
        action,
        decidedAt: options.now?.() ?? new Date(),
      });
      if (evidence !== null) await options.store.writeEvidence(orgId, messageId, evidence);
      return { inserted, action };
    });
    if (!persisted.inserted) return { status: "ignored", reason: "already_recorded" };
    options.metrics?.recordMailDecision?.({
      provider: config.provider,
      outcome: "decided",
      latencySeconds,
      ...(persisted.action === "none" ? {} : { action: persisted.action }),
    });
    return { status: "decided", action: persisted.action, shadow: config.mode === "shadow" };
  }

  async #enforce(
    loaded: NonNullable<Awaited<ReturnType<DecisionStore["loadCandidate"]>>>,
    proposed: DecisionAction,
    category: Parameters<DecisionStore["applyCategory"]>[0]["category"] | null,
    feedbackEvidence: Record<string, string | number | null>,
  ): Promise<DecisionAction> {
    const { store } = this.#options;
    const { orgId, messageId, threadId } = loaded.candidate;
    let actorIds: readonly string[] = [];
    if (proposed === "spam" || proposed === "phishing") {
      actorIds = await store.markSpam({
        orgId,
        messageId,
        threadId,
        evidence: { ...feedbackEvidence, catcher: "decision-model", action: proposed },
      });
    } else if (proposed === "category" && category !== null) {
      actorIds = await store.applyCategory({
        orgId,
        messageId,
        threadId,
        category,
        heuristicCategory: loaded.heuristicCategory,
      });
    }
    if (actorIds.length === 0) return "none";
    await store.setActionTaken({ orgId, messageId, action: proposed });
    await store.publishMailboxUpdates({ orgId, messageId, threadId, actorIds, action: proposed });
    return proposed;
  }

  async #classification(
    orgId: string,
    messageId: string,
    input: {
      readonly explicit: Parameters<typeof deriveClassification>[0]["explicit"];
      readonly labels: readonly string[];
      readonly content: string;
    },
  ) {
    const stored = await this.#options.runForTenant(orgId, async () =>
      this.#options.classifications?.get({
        orgId,
        resourceType: "mail.message",
        resourceId: messageId,
      }),
    );
    const explicit =
      stored?.classification === undefined
        ? input.explicit
        : input.explicit === undefined
          ? stored.classification
          : maxClassification(stored.classification, input.explicit);
    return deriveClassification({
      explicit,
      labels: input.labels,
      content: input.content,
      scanContent: true,
    }).classification;
  }
}

function eventTarget(
  payload: unknown,
): { readonly orgId: string; readonly messageId: string } | null {
  if (!isRecord(payload)) return null;
  const { orgId, messageId } = payload;
  return typeof orgId === "string" &&
    orgId.length > 0 &&
    typeof messageId === "string" &&
    messageId.length > 0
    ? { orgId, messageId }
    : null;
}
