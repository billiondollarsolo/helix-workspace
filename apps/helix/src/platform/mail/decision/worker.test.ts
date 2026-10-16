import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "../../events/in-memory-event-bus.js";
import { resolveDecisionModelConfig } from "./config.js";
import { DecisionModelError, type DecisionResult } from "./protocol.js";
import type { DecisionModelProvider } from "./providers.js";
import type { DecisionVerdictWrite, LoadedDecisionCandidate } from "./store.js";
import { MailDecisionWorker } from "./worker.js";

const orgId = "org-1";
const messageId = "message-1";

function loaded(overrides: Partial<LoadedDecisionCandidate> = {}): LoadedDecisionCandidate {
  return {
    candidate: {
      orgId,
      messageId,
      threadId: "thread-1",
      subject: "Invoice overdue",
      fromAddress: "billing@vendor.example",
      replyTo: [],
      toCount: 1,
      ccCount: 0,
      sentAt: new Date("2026-10-12T08:00:00.000Z"),
      headers: {},
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      spamAssassin: { score: 1.5, isSpam: false, symbols: [] },
      body: "Please pay the attached invoice.",
      bodyFormat: "plain",
      attachments: [],
    },
    external: true,
    alreadyRecorded: false,
    providerCallsToday: 0,
    labels: [],
    heuristicCategory: "primary",
    senderDomain: "vendor.example",
    ...overrides,
  };
}

function answers(
  verdict: string,
  confidence: number,
  category = "primary",
  categoryConfidence = 0.5,
) {
  return {
    model: "clef-flash",
    usage: { inputTokens: 700, outputTokens: 0 },
    answers: {
      verdict: {
        type: "choice",
        answer: verdict,
        probabilities: { [verdict]: confidence },
        confidence,
      },
      category: {
        type: "choice",
        answer: category,
        probabilities: { [category]: categoryConfidence },
        confidence: categoryConfidence,
      },
      needs_reply: {
        type: "noul",
        answer: true,
        probabilities: { true: 0.7, false: 0.3 },
        confidence: 0.7,
      },
      urgency: {
        type: "score",
        answer: "today",
        probabilities: { today: 0.6 },
        confidence: 0.6,
      },
    },
  } satisfies DecisionResult;
}

function harness(input: {
  readonly settings?: Record<string, unknown>;
  readonly candidate?: LoadedDecisionCandidate | null;
  readonly credential?: string | null;
  readonly decide?: DecisionModelProvider["decide"];
  readonly stored?: { readonly classification: "restricted" | "confidential" | "standard" } | null;
  readonly inserted?: boolean;
  readonly claim?: "claimed" | "daily_cap" | "already_recorded";
}) {
  const verdicts: DecisionVerdictWrite[] = [];
  const store = {
    loadCandidate: vi.fn(async () => (input.candidate === undefined ? loaded() : input.candidate)),
    readCredential: vi.fn(async () =>
      input.credential === undefined ? "cf-token-123" : input.credential,
    ),
    claimProviderCall: vi.fn(async () => input.claim ?? ("claimed" as const)),
    recordVerdict: vi.fn(async (write: DecisionVerdictWrite) => {
      verdicts.push(write);
      return input.inserted ?? true;
    }),
    setActionTaken: vi.fn(async () => undefined),
    writeEvidence: vi.fn(async () => undefined),
    markSpam: vi.fn(async () => ["actor-a", "actor-b"]),
    applyCategory: vi.fn(async () => ["actor-a"]),
    publishMailboxUpdates: vi.fn(async () => undefined),
  };
  const decide = vi.fn(input.decide ?? (async () => answers("legitimate", 0.97)));
  const recordMailDecision = vi.fn();
  const events = new InMemoryEventBus();
  const worker = new MailDecisionWorker({
    events,
    store,
    loadConfig: async () =>
      resolveDecisionModelConfig(
        input.settings ?? {
          mode: "enforce",
          provider: "cloudflare",
          cloudflareAccountId: "0123456789abcdef0123456789abcdef",
        },
      ),
    runForTenant: (_orgId, operation) => operation(),
    createProvider: (config) => ({ id: config.provider, model: config.model, decide }),
    classifications: {
      get: async () =>
        input.stored === undefined || input.stored === null
          ? null
          : {
              orgId,
              resourceType: "mail.message",
              resourceId: messageId,
              classification: input.stored.classification,
              source: "explicit",
              reason: "label",
              updatedAt: "2026-10-12T00:00:00.000Z",
            },
    },
    metrics: { recordMailDecision },
    now: () => new Date("2026-10-12T09:00:00.000Z"),
  });
  return { worker, store, decide, verdicts, recordMailDecision, events };
}

const enforceCloudflare = {
  mode: "enforce",
  provider: "cloudflare",
  cloudflareAccountId: "0123456789abcdef0123456789abcdef",
};

describe("MailDecisionWorker skips", () => {
  it("does nothing at all when the org has the model off", async () => {
    const h = harness({ settings: {} });
    await expect(h.worker.process({ orgId, messageId })).resolves.toEqual({
      status: "ignored",
      reason: "mode_off",
    });
    expect(h.store.loadCandidate).not.toHaveBeenCalled();
    expect(h.verdicts).toEqual([]);
  });

  it("ignores internal mail and messages already recorded", async () => {
    const internal = harness({ candidate: loaded({ external: false }) });
    await expect(internal.worker.process({ orgId, messageId })).resolves.toMatchObject({
      reason: "not_external",
    });
    const repeat = harness({ candidate: loaded({ alreadyRecorded: true }) });
    await expect(repeat.worker.process({ orgId, messageId })).resolves.toMatchObject({
      reason: "already_recorded",
    });
    expect([...internal.verdicts, ...repeat.verdicts]).toEqual([]);
    expect(internal.decide).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a restricted marking in the body",
      {
        candidate: loaded({
          candidate: { ...loaded().candidate, body: "Classification: Restricted\nPlan." },
        }),
      },
      "classified_restricted",
    ],
    [
      "a stored confidential label",
      { stored: { classification: "confidential" as const } },
      "classified_confidential",
    ],
    [
      "an explicit restricted message classification",
      { candidate: loaded({ explicitClassification: "restricted" }) },
      "classified_restricted",
    ],
    ["the daily cap", { candidate: loaded({ providerCallsToday: 5000 }) }, "daily_cap"],
    ["a missing credential", { credential: null }, "credential_missing"],
  ])("records a skip for %s without calling the provider", async (_label, setup, reason) => {
    const h = harness(setup);
    await expect(h.worker.process({ orgId, messageId })).resolves.toEqual({
      status: "skipped",
      reason,
    });
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.verdicts).toEqual([
      expect.objectContaining({ outcome: "skipped", reason, mode: "enforce" }),
    ]);
    expect(h.recordMailDecision).toHaveBeenCalledWith({
      provider: "cloudflare",
      outcome: "skipped",
    });
  });
});

describe("MailDecisionWorker decisions", () => {
  it("records shadow verdicts without touching mailboxes or message evidence", async () => {
    const h = harness({
      settings: { ...enforceCloudflare, mode: "shadow" },
      decide: async () => answers("spam", 0.99),
    });
    await expect(h.worker.process({ orgId, messageId })).resolves.toEqual({
      status: "decided",
      action: "none",
      shadow: true,
    });
    expect(h.verdicts[0]).toMatchObject({
      outcome: "decided",
      mode: "shadow",
      model: "clef-flash",
      summary: expect.objectContaining({ verdict: "spam", proposedAction: "spam" }),
      spamAssassin: { score: 1.5, isSpam: false, symbols: [] },
      senderDomain: "vendor.example",
      inputTokens: 700,
    });
    expect(h.store.markSpam).not.toHaveBeenCalled();
    expect(h.store.writeEvidence).not.toHaveBeenCalled();
    expect(h.store.publishMailboxUpdates).not.toHaveBeenCalled();
  });

  it("files spam above the threshold for every recipient and publishes updates", async () => {
    const h = harness({ settings: enforceCloudflare, decide: async () => answers("scam", 0.93) });
    await expect(h.worker.process({ orgId, messageId })).resolves.toMatchObject({
      status: "decided",
      action: "spam",
    });
    expect(h.store.markSpam).toHaveBeenCalledWith({
      orgId,
      messageId,
      threadId: "thread-1",
      evidence: expect.objectContaining({ catcher: "decision-model", verdict: "scam" }),
    });
    expect(h.store.setActionTaken).toHaveBeenCalledWith({ orgId, messageId, action: "spam" });
    expect(h.store.publishMailboxUpdates).toHaveBeenCalledWith(
      expect.objectContaining({ actorIds: ["actor-a", "actor-b"], action: "spam" }),
    );
    expect(h.store.writeEvidence).toHaveBeenCalledWith(
      orgId,
      messageId,
      expect.objectContaining({
        verdict: "scam",
        action: "spam",
        phishing: false,
        needsReply: true,
      }),
    );
    expect(h.recordMailDecision).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cloudflare", outcome: "decided", action: "spam" }),
    );
  });

  it("leaves spam below the threshold in the inbox but still shows evidence", async () => {
    const h = harness({ settings: enforceCloudflare, decide: async () => answers("spam", 0.85) });
    await expect(h.worker.process({ orgId, messageId })).resolves.toMatchObject({ action: "none" });
    expect(h.store.markSpam).not.toHaveBeenCalled();
    expect(h.store.writeEvidence).toHaveBeenCalledWith(
      orgId,
      messageId,
      expect.objectContaining({ verdict: "spam", action: "none" }),
    );
  });

  it("flags phishing with a strong-warning marker", async () => {
    const h = harness({
      settings: enforceCloudflare,
      decide: async () => answers("phishing", 0.81),
    });
    await h.worker.process({ orgId, messageId });
    expect(h.store.markSpam).toHaveBeenCalled();
    expect(h.store.writeEvidence).toHaveBeenCalledWith(
      orgId,
      messageId,
      expect.objectContaining({ phishing: true, action: "phishing" }),
    );
  });

  it("re-tabs confident categories only when enabled", async () => {
    const h = harness({
      settings: { ...enforceCloudflare, applyCategories: true },
      decide: async () => answers("legitimate", 0.99, "promotions", 0.9),
    });
    await expect(h.worker.process({ orgId, messageId })).resolves.toMatchObject({
      action: "category",
    });
    expect(h.store.applyCategory).toHaveBeenCalledWith({
      orgId,
      messageId,
      threadId: "thread-1",
      category: "promotions",
      heuristicCategory: "primary",
    });
  });

  it("reports no action when nothing changed (already in Spam)", async () => {
    const h = harness({ settings: enforceCloudflare, decide: async () => answers("spam", 0.99) });
    h.store.markSpam.mockResolvedValueOnce([]);
    await expect(h.worker.process({ orgId, messageId })).resolves.toMatchObject({ action: "none" });
    expect(h.store.setActionTaken).not.toHaveBeenCalled();
    expect(h.store.publishMailboxUpdates).not.toHaveBeenCalled();
  });

  it("acts only once when a concurrent worker recorded the message first", async () => {
    const h = harness({
      settings: enforceCloudflare,
      decide: async () => answers("spam", 0.99),
      inserted: false,
    });
    await expect(h.worker.process({ orgId, messageId })).resolves.toEqual({
      status: "ignored",
      reason: "already_recorded",
    });
    expect(h.store.markSpam).not.toHaveBeenCalled();
  });

  it("fails open on provider errors", async () => {
    const h = harness({
      settings: enforceCloudflare,
      decide: async () => {
        throw new DecisionModelError("rate_limited", "slow down", { retryable: true });
      },
    });
    await expect(h.worker.process({ orgId, messageId })).resolves.toEqual({
      status: "error",
      reason: "rate_limited",
    });
    expect(h.verdicts).toEqual([
      expect.objectContaining({ outcome: "error", reason: "rate_limited" }),
    ]);
    expect(h.store.markSpam).not.toHaveBeenCalled();
    expect(h.recordMailDecision).toHaveBeenCalledWith({ provider: "cloudflare", outcome: "error" });
  });
});

describe("MailDecisionWorker events", () => {
  it("collapses per-recipient events for one message and never blocks the publisher", async () => {
    let release: (() => void) | undefined;
    const h = harness({
      settings: enforceCloudflare,
      decide: () =>
        new Promise<DecisionResult>((resolve) => {
          release = () => {
            resolve(answers("legitimate", 0.99));
          };
        }),
    });
    await h.worker.start();
    const payload = { orgId, messageId, threadId: "thread-1" };
    await h.events.publish("activity.mail.received", { ...payload, actorId: "actor-a" });
    await h.events.publish("activity.mail.received", { ...payload, actorId: "actor-b" });
    await h.events.publish("activity.mail.received", { orgId });
    await vi.waitFor(() => {
      expect(h.decide).toHaveBeenCalledTimes(1);
    });
    release?.();
    await h.worker.idle();
    expect(h.verdicts).toHaveLength(1);
    await h.worker.stop();
    await h.events.publish("activity.mail.received", { ...payload, messageId: "message-2" });
    expect(h.store.loadCandidate).toHaveBeenCalledTimes(1);
  });
});

it.each(["daily_cap", "already_recorded"] as const)(
  "does not call the decision provider when an atomic reservation returns %s",
  async (claim) => {
    const h = harness({ claim });
    await expect(h.worker.process({ orgId, messageId })).resolves.toMatchObject({ reason: claim });
    expect(h.decide).not.toHaveBeenCalled();
  },
);
