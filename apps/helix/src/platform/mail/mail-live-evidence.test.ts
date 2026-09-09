import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodemailerMailTransport, OutboundMailDispatcher } from "./outbound.js";
import type { ClaimedOutboundMail, OutboundMailQueueStore } from "./store.js";

describe("M7 deterministic retry over a real local SMTP service", () => {
  const servers: SMTPServer[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  it("persists a transient failure, retries once, and delivers without duplicating the outbound", async () => {
    let dataAttempts = 0;
    const server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      onData(stream, _session, callback) {
        stream.on("data", () => undefined);
        stream.on("end", () => {
          dataAttempts += 1;
          if (dataAttempts === 1) {
            const transient = new Error("deterministic temporary failure") as Error & {
              responseCode: number;
            };
            transient.responseCode = 451;
            callback(transient);
            return;
          }
          callback(null, "accepted on deterministic retry");
        });
      },
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.once("error", reject);
    });
    const address = server.server.address() as AddressInfo;

    const outbound = record();
    const markOutboundRetry = vi.fn().mockResolvedValue({
      ...outbound,
      status: "queued",
      attemptCount: 1,
    });
    const markOutboundSent = vi.fn().mockImplementation(async (input) => ({
      ...outbound,
      status: "accepted",
      providerMessageId: input.providerMessageId,
      deliveryMetadata: input.deliveryMetadata,
    }));
    const store = {
      markOutboundRetry,
      markOutboundSent,
      markOutboundFailed: vi.fn(),
      markOutboundDeadLettered: vi.fn(),
    } as unknown as OutboundMailQueueStore;
    const dispatcher = new OutboundMailDispatcher(
      store,
      async () =>
        new NodemailerMailTransport({
          host: "127.0.0.1",
          port: address.port,
          secure: false,
          requireTls: false,
        }),
      {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
    );

    expect(await dispatcher.dispatch(outbound)).toMatchObject({ status: "queued" });
    const retry = { ...outbound, attemptCount: 2, leaseToken: "retry-lease" };
    const result = await dispatcher.dispatch(retry);

    expect(result).toMatchObject({
      id: outbound.id,
      status: "accepted",
      providerMessageId: expect.any(String),
    });
    expect(dataAttempts).toBe(2);
    expect(markOutboundRetry).toHaveBeenCalledTimes(1);
    expect(markOutboundSent).toHaveBeenCalledTimes(1);
    expect(markOutboundRetry).toHaveBeenCalledWith(
      expect.objectContaining({ id: outbound.id, leaseToken: outbound.leaseToken }),
    );
    expect(markOutboundSent).toHaveBeenCalledWith(
      expect.objectContaining({ id: outbound.id, leaseToken: retry.leaseToken }),
    );
  });
});

function record(): ClaimedOutboundMail {
  const now = new Date("2026-07-28T12:00:00.000Z");
  return {
    id: "outbound-m7",
    orgId: "org-m7",
    actorId: "actor-m7",
    messageId: "message-m7",
    threadId: "thread-m7",
    outboxId: "outbox-m7",
    status: "sending",
    envelope: {
      from: { address: "sender@helix.local" },
      to: [{ address: "recipient@example.net" }],
      cc: [],
      bcc: [],
      subject: "M7 deterministic retry",
      text: "M7 deterministic retry",
      attachments: [],
    },
    undoUntil: now,
    sentAt: null,
    cancelledAt: null,
    failedAt: null,
    lastError: null,
    providerMessageId: null,
    deliveryMetadata: {},
    createdAt: now,
    updatedAt: now,
    handoffKey: "stable-delivery-key",
    leaseOwner: "test-worker",
    leaseToken: "first-lease",
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    attemptCount: 1,
    nextAttemptAt: null,
    deadLetteredAt: null,
  };
}
