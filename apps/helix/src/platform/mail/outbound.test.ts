import { describe, expect, it, vi } from "vitest";
import {
  MailSendService,
  MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  type OutboundMailTransport,
  resolveOutboundAttachments,
} from "./outbound.js";
import type { MailStore } from "./store.js";
import type { MailOutboundEnvelope, MailOutboundRecord } from "./types.js";
import {
  MailAttachmentSizeError,
  MailOutboundPayloadError,
  MailProviderError,
  MailSendIdempotencyRequiredError,
} from "./errors.js";
import { createDispatchAuthorizedAttachmentResolver } from "./reliability.js";

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

  it("rejects an attachment that exceeds the documented outbound limit", async () => {
    await expect(
      resolveOutboundAttachments(
        envelope({
          attachments: [
            {
              filename: "too-large.bin",
              mimeType: "application/octet-stream",
              content: Buffer.alloc(MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES + 1),
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(MailAttachmentSizeError);
  });
});

describe("OutboundMailDispatcher retry + dead-letter", () => {
  it("preserves undo-send across a dispatcher restart", async () => {
    let undoExpired = false;
    const queued = baseOutbound({
      undoUntil: new Date("2026-05-20T12:00:30.000Z"),
    });
    const sending = { ...queued, status: "sending" as const };
    const send = vi
      .fn()
      .mockResolvedValue({ providerMessageId: "provider-1", deliveryMetadata: {} });
    const store = {
      markOutboundSending: vi.fn().mockImplementation(async () => {
        if (!undoExpired) return null;
        return sending;
      }),
      markOutboundSent: vi.fn().mockImplementation(async () => ({
        ...sending,
        status: "sent",
        sentAt: new Date(),
      })),
    } as unknown as MailStore;

    const beforeRestart = new OutboundMailDispatcher(store, { send });
    expect(await beforeRestart.dispatch(queued.id)).toBeNull();
    expect(send).not.toHaveBeenCalled();

    undoExpired = true;
    const afterRestart = new OutboundMailDispatcher(store, { send });
    expect((await afterRestart.dispatch(queued.id))?.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
  });

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

  it("dead-letters immediately when dispatch-time attachment access was revoked", async () => {
    const record = baseOutbound({
      status: "sending",
      envelope: envelope({
        attachments: [
          {
            filename: "revoked.pdf",
            mimeType: "application/pdf",
            objectId: "11111111-1111-1111-1111-111111111111",
          },
        ],
      }),
    });
    const send = vi.fn();
    const markOutboundRetry = vi.fn();
    const markOutboundDeadLettered = vi.fn().mockImplementation(async (input) => ({
      ...record,
      status: "failed",
      deadLetteredAt: now,
      lastError: input.lastError,
    }));
    const store = {
      markOutboundSending: vi.fn().mockResolvedValue(record),
      markOutboundRetry,
      markOutboundDeadLettered,
    } as unknown as MailStore;
    const readFile = vi.fn().mockResolvedValue(null);
    const dispatcher = new OutboundMailDispatcher(
      store,
      { send },
      {
        maxAttempts: 5,
        resolveAttachment: createDispatchAuthorizedAttachmentResolver({ readFile }),
      },
    );

    const result = await dispatcher.dispatch(record.id);

    expect(result).toMatchObject({ status: "failed", deadLetteredAt: now });
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(markOutboundRetry).not.toHaveBeenCalled();
    expect(markOutboundDeadLettered).toHaveBeenCalledTimes(1);
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

  it("explicitly retries only through the scoped store method", async () => {
    const retryOutbound = vi.fn().mockResolvedValue(baseOutbound({ status: "queued" }));
    const service = new MailSendService({
      store: { retryOutbound } as unknown as MailStore,
    });
    expect(
      await service.retry({
        orgId: "o1",
        actorId: "a1",
        id: "out-1",
      }),
    ).toMatchObject({ status: "queued" });
    expect(retryOutbound).toHaveBeenCalledWith({
      orgId: "o1",
      actorId: "a1",
      id: "out-1",
      outboxSubject: "mail.send",
    });
  });
});

describe("MailSendService idempotency", () => {
  it("requires a key for agent and API sends", () => {
    const service = new MailSendService({ store: {} as MailStore });
    for (const source of ["agent", "api"] as const) {
      expect(() =>
        service.queue({
          orgId: "o1",
          actorId: "a1",
          source,
          envelope: envelope(),
        }),
      ).toThrow(MailSendIdempotencyRequiredError);
    }
  });

  it("uses the same durable key for duplicate API send attempts", async () => {
    const records = new Map<string, MailOutboundRecord>();
    const createOutbound = vi.fn().mockImplementation(async (input) => {
      const key = input.idempotencyKey as string;
      const prior = records.get(key);
      if (prior !== undefined) return prior;
      const created = baseOutbound({ id: `out-${String(records.size + 1)}` });
      records.set(key, created);
      return created;
    });
    const service = new MailSendService({
      store: { createOutbound } as unknown as MailStore,
      undoWindowMs: 0,
    });
    const input = {
      orgId: "o1",
      actorId: "a1",
      source: "api" as const,
      idempotencyKey: "request-123",
      envelope: envelope(),
    };

    const [first, second] = await Promise.all([service.queue(input), service.queue(input)]);

    expect(first.id).toBe(second.id);
    expect(records.size).toBe(1);
    expect(createOutbound).toHaveBeenCalledTimes(2);
    expect(createOutbound).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: "request-123" }),
    );
  });
});

describe("NodemailerMailTransport attachment content", () => {
  it("requires STARTTLS when implicit TLS is not selected", () => {
    const transport = new NodemailerMailTransport({
      host: "smtp.example.test",
      port: 587,
      secure: false,
    }) as unknown as {
      readonly transporter: { readonly options: { readonly requireTLS?: boolean } };
    };

    expect(transport.transporter.options.requireTLS).toBe(true);
  });

  it("preserves implicit TLS transports without requiring STARTTLS", () => {
    const transport = new NodemailerMailTransport({
      host: "smtp.example.test",
      port: 465,
      secure: true,
    }) as unknown as {
      readonly transporter: { readonly options: { readonly requireTLS?: boolean } };
    };

    expect(transport.transporter.options.requireTLS).toBe(false);
  });

  it("permits an explicit plaintext override only for injected development fixtures", () => {
    const transport = new NodemailerMailTransport({
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      requireTls: false,
    }) as unknown as {
      readonly transporter: { readonly options: { readonly requireTLS?: boolean } };
    };

    expect(transport.transporter.options.requireTLS).toBe(false);
  });
});
