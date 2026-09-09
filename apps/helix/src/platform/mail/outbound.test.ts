import { describe, expect, it, vi } from "vitest";
import {
  MailSendService,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  OutboundMailWorker,
  type OutboundMailTransport,
  resolveOutboundAttachments,
} from "./outbound.js";
import type { ClaimedOutboundMail, MailStore, OutboundMailQueueStore } from "./store.js";
import type { MailOutboundEnvelope, MailOutboundRecord } from "./types.js";
import { MailDeliveryError } from "./errors.js";

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
    handoffKey: "handoff-1",
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    ...overrides,
  };
}

class MemoryQueue implements OutboundMailQueueStore {
  record = baseOutbound({ nextAttemptAt: now });
  failNextCommit = false;

  async claimDueOutbound(input: {
    readonly owner: string;
    readonly leaseMs: number;
    readonly now?: Date;
  }): Promise<ClaimedOutboundMail | null> {
    const claimedAt = input.now ?? now;
    const nextAttemptAt = this.record.nextAttemptAt;
    const leaseExpiresAt = this.record.leaseExpiresAt;
    const due =
      (this.record.status === "queued" && nextAttemptAt != null && nextAttemptAt <= claimedAt) ||
      (this.record.status === "sending" && leaseExpiresAt != null && leaseExpiresAt <= claimedAt);
    if (!due) return null;
    const attemptCount = (this.record.attemptCount ?? 0) + 1;
    this.record = {
      ...this.record,
      status: "sending",
      attemptCount,
      nextAttemptAt: null,
      leaseOwner: input.owner,
      leaseToken: `lease-${String(attemptCount)}`,
      leaseExpiresAt: new Date(claimedAt.getTime() + input.leaseMs),
    };
    return this.record as ClaimedOutboundMail;
  }

  async markOutboundSent(input: {
    readonly id: string;
    readonly leaseToken: string;
    readonly providerMessageId?: string | undefined;
    readonly deliveryMetadata?: Record<string, never> | undefined;
  }) {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error("process lost after provider handoff");
    }
    if (this.record.leaseToken !== input.leaseToken) return null;
    this.record = {
      ...this.record,
      status: "accepted",
      sentAt: now,
      providerMessageId: input.providerMessageId ?? null,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    return this.record;
  }

  async markOutboundRetry(input: {
    readonly leaseToken: string;
    readonly nextAttemptAt: Date;
    readonly lastError: string;
  }) {
    if (this.record.leaseToken !== input.leaseToken) return null;
    this.record = {
      ...this.record,
      status: "queued",
      nextAttemptAt: input.nextAttemptAt,
      lastError: input.lastError,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    return this.record;
  }

  async markOutboundDeadLettered(input: {
    readonly leaseToken: string;
    readonly lastError: string;
    readonly deadLetteredAt?: Date;
  }) {
    if (this.record.leaseToken !== input.leaseToken) return null;
    const deadLetteredAt = input.deadLetteredAt ?? now;
    this.record = {
      ...this.record,
      status: "failed",
      failedAt: deadLetteredAt,
      deadLetteredAt,
      lastError: input.lastError,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    return this.record;
  }

  async replayOutbound(input: { readonly orgId: string; readonly id: string }) {
    if (
      this.record.orgId !== input.orgId ||
      this.record.id !== input.id ||
      this.record.deadLetteredAt == null
    ) {
      return null;
    }
    this.record = {
      ...this.record,
      status: "queued",
      attemptCount: 0,
      nextAttemptAt: now,
      failedAt: null,
      deadLetteredAt: null,
      lastError: null,
    };
    return this.record;
  }

  async listDeadLetteredOutbound(orgId: string) {
    return this.record.orgId === orgId && this.record.deadLetteredAt != null ? [this.record] : [];
  }
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

describe("durable outbound dispatch", () => {
  it("recovers a stale lease after a post-handoff crash without a duplicate visible send", async () => {
    const store = new MemoryQueue();
    const visible = new Set<string>();
    const handoffs: string[] = [];
    const transport: OutboundMailTransport = {
      async send(_message, handoff) {
        handoffs.push(handoff.idempotencyKey);
        visible.add(handoff.idempotencyKey);
        return { providerMessageId: "provider-1", deliveryMetadata: {} };
      },
    };
    const dispatcher = new OutboundMailDispatcher(store, async () => transport);
    store.failNextCommit = true;
    const worker1 = new OutboundMailWorker({
      store,
      dispatcher,
      owner: "process-1",
      leaseMs: 1_000,
    });
    await expect(worker1.drainOnce(now)).rejects.toThrow("process lost");

    const worker2 = new OutboundMailWorker({
      store,
      dispatcher,
      owner: "process-2",
      leaseMs: 1_000,
    });
    await expect(worker2.drainOnce(new Date(now.getTime() + 999))).resolves.toBe(0);
    await expect(worker2.drainOnce(new Date(now.getTime() + 1_000))).resolves.toBe(1);
    expect(store.record.status).toBe("accepted");
    expect(store.record.attemptCount).toBe(2);
    expect(handoffs).toEqual(["handoff-1", "handoff-1"]);
    expect(visible).toEqual(new Set(["handoff-1"]));
  });

  it("reclaims a crash after claim but before provider handoff", async () => {
    const store = new MemoryQueue();
    await store.claimDueOutbound({ owner: "dead-process", leaseMs: 1_000, now });
    const send = vi.fn(async () => ({ providerMessageId: "provider-1", deliveryMetadata: {} }));
    const worker = new OutboundMailWorker({
      store,
      leaseMs: 1_000,
      dispatcher: new OutboundMailDispatcher(store, async () => ({ send })),
    });

    await expect(worker.drainOnce(new Date(now.getTime() + 999))).resolves.toBe(0);
    await expect(worker.drainOnce(new Date(now.getTime() + 1_000))).resolves.toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(store.record.status).toBe("accepted");
  });

  it("persists retry timing across restart and never runs early or busy-loops", async () => {
    const store = new MemoryQueue();
    let attempts = 0;
    const transport: OutboundMailTransport = {
      async send() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary");
        return { providerMessageId: "provider-1", deliveryMetadata: {} };
      },
    };
    const options = { baseDelayMs: 1_000, maxDelayMs: 60_000, now: () => now, random: () => 0 };
    await new OutboundMailWorker({
      store,
      owner: "process-1",
      dispatcher: new OutboundMailDispatcher(store, async () => transport, options),
    }).drainOnce(now);
    expect(store.record.nextAttemptAt).toEqual(new Date(now.getTime() + 500));

    const restarted = new OutboundMailWorker({
      store,
      owner: "process-2",
      dispatcher: new OutboundMailDispatcher(store, async () => transport, options),
    });
    await expect(restarted.drainOnce(new Date(now.getTime() + 499))).resolves.toBe(0);
    await expect(restarted.drainOnce(new Date(now.getTime() + 500))).resolves.toBe(1);
    expect(attempts).toBe(2);
    expect(store.record.status).toBe("accepted");
  });

  it("dead-letters terminal failures and supports an operator replay", async () => {
    const store = new MemoryQueue();
    const operationalEvents: { readonly operation: string; readonly status: string }[] = [];
    let fail = true;
    const transport: OutboundMailTransport = {
      async send() {
        if (fail) throw new MailDeliveryError("recipient rejected", false);
        return { providerMessageId: "provider-1", deliveryMetadata: {} };
      },
    };
    const worker = new OutboundMailWorker({
      store,
      dispatcher: new OutboundMailDispatcher(store, async () => transport, {
        metrics: {
          recordOperationalEvent: (event) => operationalEvents.push(event),
        },
      }),
    });
    await worker.drainOnce(now);
    expect(await store.listDeadLetteredOutbound("o1")).toHaveLength(1);
    expect(operationalEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "queue_wait", status: "success" }),
        expect.objectContaining({ operation: "delivery", status: "error" }),
      ]),
    );

    fail = false;
    await store.replayOutbound({ orgId: "o1", id: "out-1" });
    await worker.drainOnce(now);
    expect(store.record.status).toBe("accepted");
    expect(operationalEvents).toContainEqual(
      expect.objectContaining({ operation: "delivery", status: "success" }),
    );
  });

  it("dead-letters transient failures at the persisted attempt cap", async () => {
    const store = new MemoryQueue();
    const transport: OutboundMailTransport = {
      async send() {
        throw new Error("provider unavailable");
      },
    };
    const dispatcher = new OutboundMailDispatcher(store, async () => transport, {
      maxAttempts: 2,
      baseDelayMs: 2,
      random: () => 0,
      now: () => now,
    });
    const worker = new OutboundMailWorker({ store, dispatcher });

    await worker.drainOnce(now);
    await worker.drainOnce(new Date(now.getTime() + 1));
    expect(store.record.attemptCount).toBe(2);
    expect(store.record.deadLetteredAt).toEqual(now);
  });
});

describe("MailSendService.cancel", () => {
  it("uses the durable queue's not-before time for a bounded scheduled send", async () => {
    const createOutbound = vi.fn(async (input: { undoUntil: Date }) =>
      baseOutbound({ undoUntil: input.undoUntil, nextAttemptAt: input.undoUntil }),
    );
    const service = new MailSendService({
      store: { createOutbound } as unknown as MailStore,
      undoWindowMs: 30_000,
    });
    const sendAt = new Date(now.getTime() + 60 * 60_000);

    await service.queue({ orgId: "o1", actorId: "a1", envelope: envelope(), now, sendAt });

    expect(createOutbound).toHaveBeenCalledWith(expect.objectContaining({ undoUntil: sendAt }));
    expect(() =>
      service.queue({
        orgId: "o1",
        actorId: "a1",
        envelope: envelope(),
        now,
        sendAt: new Date(now.getTime() + 367 * 24 * 60 * 60_000),
      }),
    ).toThrow("within the next 366 days");
  });

  it("pins canonical RFC headers before the message enters the durable queue", async () => {
    const createOutbound = vi.fn(async (input: { envelope: MailOutboundEnvelope }) =>
      baseOutbound({ envelope: input.envelope }),
    );
    const service = new MailSendService({
      store: { createOutbound } as unknown as MailStore,
      undoWindowMs: 0,
    });

    const queued = await service.queue({
      orgId: "o1",
      actorId: "a1",
      envelope: envelope(),
      inReplyTo: "parent@EXAMPLE.NET",
      references: ["<root@EXAMPLE.NET>", "<parent@example.net>"],
      now,
    });

    expect(queued.envelope).toMatchObject({
      messageId: expect.stringMatching(/^<[0-9a-f-]+@example\.com>$/u),
      inReplyTo: "<parent@example.net>",
      references: ["<root@example.net>", "<parent@example.net>"],
    });
    expect(createOutbound).toHaveBeenCalledOnce();
  });

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

  it("passes the active tenant DKIM key to Nodemailer", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "provider-1" }));
    const transport = new NodemailerMailTransport(
      { sendMail } as never,
      async () => ({
        domainName: "example.com",
        keySelector: "s1",
        privateKey: "kms-unwrapped-private-key",
      }),
    );
    await transport.send(envelope(), { idempotencyKey: "handoff-1" });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        dkim: {
          domainName: "example.com",
          keySelector: "s1",
          privateKey: "kms-unwrapped-private-key",
        },
      }),
    );
  });
});
