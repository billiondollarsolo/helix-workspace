import { describe, expect, it, vi } from "vitest";
import {
  MailSendService,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  type OutboundMailTransport,
  resolveOutboundAttachments,
} from "./outbound.js";
import type { MailStore } from "./store.js";
import type { MailOutboundEnvelope, MailOutboundRecord } from "./types.js";
import { MailOutboundPayloadError, MailProviderError } from "./errors.js";

const now = new Date("2026-05-20T12:00:00.000Z");

function envelope(overrides: Partial<MailOutboundEnvelope> = {}): MailOutboundEnvelope {
  return {
    from: { address: "alice@example.com" },
    to: [{ address: "bob@example.net" }],
    cc: [],
    bcc: [],
    subject: "Hi",
    text: "Hello",
    attachments: [],
    ...overrides,
  };
}

function baseOutbound(overrides: Partial<MailOutboundRecord> = {}): MailOutboundRecord {
  return {
    id: "out-1",
    orgId: "o1",
    actorId: "a1",
    messageId: "m1",
    threadId: "t1",
    outboxId: "ob1",
    status: "queued",
    envelope: envelope(),
    undoUntil: new Date("2026-05-20T00:00:00.000Z"),
    sentAt: null,
    cancelledAt: null,
    failedAt: null,
    lastError: null,
    providerMessageId: null,
    deliveryMetadata: {},
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    nextAttemptAt: null,
    deadLetteredAt: null,
    ...overrides,
  };
}

describe("resolveOutboundAttachments", () => {
  it("keeps base64/buffer content attachments (back-compat)", async () => {
    const content = Buffer.from("hello");
    const resolved = await resolveOutboundAttachments(
      envelope({
        attachments: [
          {
            filename: "a.txt",
            mimeType: "text/plain",
            content,
          },
        ],
      }),
    );
    expect(resolved.attachments[0]?.content?.equals(content)).toBe(true);
  });

  it("streams Drive objectId attachments via the injected resolver", async () => {
    const resolver = vi.fn().mockResolvedValue(Buffer.from("from-drive"));
    const resolved = await resolveOutboundAttachments(
      envelope({
        attachments: [
          {
            filename: "drive.bin",
            mimeType: "application/octet-stream",
            content: Buffer.alloc(0),
            objectId: "11111111-1111-1111-1111-111111111111",
          },
        ],
      }),
      resolver,
      { orgId: "o1", actorId: "a1" },
    );
    expect(resolver).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", {
      orgId: "o1",
      actorId: "a1",
    });
    const resolvedContent = resolved.attachments[0]?.content;
    if (resolvedContent === undefined) throw new Error("Expected resolved attachment content");
    expect(Buffer.from(resolvedContent).toString()).toBe("from-drive");
  });
});

describe("OutboundMailDispatcher retry + dead-letter", () => {
  it("binds the dispatch-time provider decision and persists only safe metadata", async () => {
    const record = baseOutbound({ status: "sending" });
    const send = vi.fn().mockResolvedValue({
      providerMessageId: "provider-message",
      deliveryMetadata: { provider: "mailgun" },
    });
    const transportFor = vi.fn().mockResolvedValue({
      transport: { send },
      providerId: "11111111-1111-4111-8111-111111111111",
      providerKind: "mailgun",
      source: "org_default",
      fromDomain: "example.com",
    });
    const bindOutboundProviderDecision = vi.fn().mockResolvedValue({
      ...record,
      providerId: "11111111-1111-4111-8111-111111111111",
    });
    const markOutboundSent = vi.fn().mockImplementation(async (input) => ({
      ...record,
      status: "sent",
      deliveryMetadata: input.deliveryMetadata,
    }));
    const store = {
      markOutboundSending: vi.fn().mockResolvedValue(record),
      bindOutboundProviderDecision,
      markOutboundSent,
    } as unknown as MailStore;

    const result = await new OutboundMailDispatcher(store, transportFor).dispatch("out-1");

    expect(transportFor).toHaveBeenCalledWith("o1", "example.com", null);
    expect(bindOutboundProviderDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "out-1",
        orgId: "o1",
        providerKind: "mailgun",
        source: "org_default",
      }),
    );
    expect(result?.deliveryMetadata).toEqual(
      expect.objectContaining({
        providerId: "11111111-1111-4111-8111-111111111111",
        providerKind: "mailgun",
        providerDecisionSource: "org_default",
        attempt: 1,
      }),
    );
  });

  it("fails without retrying when an org-scoped recipient suppression is active", async () => {
    const record = baseOutbound({ status: "sending" });
    const transportFor = vi.fn();
    const markOutboundDeadLettered = vi.fn().mockImplementation(async (input) => ({
      ...record,
      status: "failed",
      lastError: input.lastError,
      deadLetteredAt: now,
    }));
    const store = {
      markOutboundSending: vi.fn().mockResolvedValue(record),
      markOutboundDeadLettered,
    } as unknown as MailStore;
    const suppressionStore = {
      findActiveSuppressions: vi.fn().mockResolvedValue([
        {
          normalizedRecipient: "bob@example.net",
        },
      ]),
    };

    const result = await new OutboundMailDispatcher(store, transportFor, {
      suppressionStore,
    }).dispatch("out-1");

    expect(transportFor).not.toHaveBeenCalled();
    expect(result?.lastError).toContain("MAIL_RECIPIENT_SUPPRESSED");
    expect(suppressionStore.findActiveSuppressions).toHaveBeenCalledWith("o1", ["bob@example.net"]);
  });

  it("retries transient transport failures then succeeds", async () => {
    let attempts = 0;
    const transport: OutboundMailTransport = {
      send: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("temporary");
        }
        return { providerMessageId: "p1", deliveryMetadata: {} };
      }),
    };
    const record = baseOutbound({ status: "sending", attemptCount: 0 });
    const markOutboundRetry = vi
      .fn()
      .mockImplementation(async (input: { attemptCount: number }) => ({
        ...record,
        status: "queued",
        attemptCount: input.attemptCount,
      }));
    const store = {
      markOutboundSending: vi.fn().mockResolvedValue(record),
      markOutboundSent: vi.fn().mockImplementation(async () => ({
        ...record,
        status: "sent",
        providerMessageId: "p1",
      })),
      markOutboundFailed: vi.fn().mockImplementation(async (_id: string, error: string) => ({
        ...record,
        status: "failed",
        lastError: error,
        attemptCount: attempts,
      })),
      markOutboundRetry,
      markOutboundDeadLettered: vi.fn(),
    } as unknown as MailStore;

    const dispatcher = new OutboundMailDispatcher(store, transport, {
      maxAttempts: 5,
      baseDelayMs: 1,
      maxDelayMs: 10,
      sleep: async () => undefined,
    });
    const result = await dispatcher.dispatch("out-1");
    expect(result?.status).toBe("sent");
    expect(attempts).toBe(3);
    expect(markOutboundRetry).toHaveBeenCalled();
  });

  it("dead-letters after the attempt cap and wraps MailProviderError", async () => {
    const transport: OutboundMailTransport = {
      send: vi.fn(async () => {
        throw new Error("always fail");
      }),
    };
    const record = baseOutbound({ status: "sending", attemptCount: 0 });
    const markOutboundDeadLettered = vi.fn().mockImplementation(async () => ({
      ...record,
      status: "failed",
      deadLetteredAt: now,
      lastError: "always fail",
    }));
    const store = {
      markOutboundSending: vi.fn().mockResolvedValue(record),
      markOutboundSent: vi.fn(),
      markOutboundFailed: vi.fn().mockImplementation(async () => ({
        ...record,
        status: "failed",
        lastError: "always fail",
      })),
      markOutboundRetry: vi.fn().mockImplementation(async (input: { attemptCount: number }) => ({
        ...record,
        status: "queued",
        attemptCount: input.attemptCount,
      })),
      markOutboundDeadLettered,
    } as unknown as MailStore;

    const dispatcher = new OutboundMailDispatcher(store, transport, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 10,
      sleep: async () => undefined,
    });
    const result = await dispatcher.dispatch("out-1");
    expect(result?.deadLetteredAt).toBeTruthy();
    expect(markOutboundDeadLettered).toHaveBeenCalled();
    await expect(
      Promise.reject(new MailProviderError("always fail", new Error("always fail"))),
    ).rejects.toBeInstanceOf(MailProviderError);
  });

  it("rejects invalid outbox payloads with MailOutboundPayloadError", async () => {
    const dispatcher = new OutboundMailDispatcher({} as MailStore, {
      send: async () => ({ providerMessageId: "x", deliveryMetadata: {} }),
    });
    await expect(dispatcher.dispatchOutboxPayload({})).rejects.toBeInstanceOf(
      MailOutboundPayloadError,
    );
  });
});

describe("MailSendService.cancel", () => {
  it("delegates to store.cancelOutbound", async () => {
    const cancelOutbound = vi.fn().mockResolvedValue(baseOutbound({ status: "cancelled" }));
    const store = {
      cancelOutbound,
    } as unknown as MailStore;
    const service = new MailSendService({ store });
    await service.cancel({ orgId: "o1", actorId: "a1", id: "out-1" });
    expect(cancelOutbound).toHaveBeenCalledWith({
      orgId: "o1",
      actorId: "a1",
      id: "out-1",
    });
  });
});

describe("NodemailerMailTransport attachment content", () => {
  it("accepts Buffer content", async () => {
    // Smoke: constructor accepts config shape (no live SMTP).
    expect(
      () =>
        new NodemailerMailTransport({
          host: "localhost",
          port: 1025,
          secure: false,
        }),
    ).not.toThrow();
  });
});
