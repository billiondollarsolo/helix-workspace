import { expect, it, vi } from "vitest";
import { EnrichmentWorker } from "../../ai/enrichment/worker.js";
import { InMemoryEventBus } from "../../events/in-memory-event-bus.js";
import { registerMailEnrichments } from "./enrichments.js";

it.each([true, false])(
  "classifies before AI and uses the mailbox owner when enabled=%s",
  async (enabled) => {
    const chat = vi.fn(async () => ({ message: "{}", providerId: "test", model: "test" }));
    const worker = new EnrichmentWorker({ events: new InMemoryEventBus() });
    registerMailEnrichments(worker, {
      entityExtract: true,
      classification: true,
      enabled: async () => enabled,
      ai: { chat },
      store: {
        getMailEnrichmentRecord: async () => ({
          id: "message",
          orgId: "tenant",
          ownerActorId: "owner",
          threadId: "thread",
          subject: "Private record",
          body: "Classification: restricted\nInternal document.",
          from: { address: "sender@example.com" },
          to: [{ address: "owner@example.com" }],
          labels: [],
          direction: "inbound",
          sentAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          metadata: {},
        }),
        setMailClassification: async () => {},
        recordMailEnrichment: async () => {},
      },
    });
    const result = await worker.handle({
      subject: "activity.mail.received",
      payload: { orgId: "tenant", actorId: "owner", messageId: "message" },
      occurredAt: new Date().toISOString(),
    });
    expect(result.failed).toBe(0);
    if (enabled)
      expect(chat).toHaveBeenCalledWith(
        expect.objectContaining({ classification: "restricted" }),
        expect.objectContaining({
          classification: "restricted",
          actor: { id: "owner", orgId: "tenant", type: "user" },
        }),
      );
    else expect(chat).not.toHaveBeenCalled();
  },
);
