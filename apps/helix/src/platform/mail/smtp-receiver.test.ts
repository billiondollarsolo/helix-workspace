import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import { afterEach, describe, expect, it } from "vitest";
import { SmtpMailReceiver } from "./ingest.js";
import type {
  IdempotentStoredMailMessage,
  InsertInboundMessageIdempotentInput,
  RecipientAwareMailStore,
} from "./store.js";
import type { MailMessageInput } from "./types.js";
import type { SmtpResolvedRecipient } from "./smtp-recipient-resolver.js";

const raw = [
  "From: External Sender <sender@external.example>",
  "To: undisclosed-recipients:;",
  "Message-ID: <smtp-real-test@external.example>",
  "Subject: socket test",
  "",
  "hello",
].join("\r\n");

describe("SmtpMailReceiver over a real SMTP socket", () => {
  const receivers: SmtpMailReceiver[] = [];

  afterEach(async () => {
    await Promise.all(receivers.splice(0).map(async (receiver) => receiver.close()));
  });

  it("returns 250 for known recipients and 550/451 before DATA for permanent/temporary lookup failures", async () => {
    const store = new DurableRecordingStore();
    const receiver = await startReceiver(store, async (address) => {
      if (address === "temporary@example.test") {
        throw new Error("database unavailable");
      }
      return address === "known@example.test" ? resolved("org-1", "actor-1", address) : null;
    });
    receivers.push(receiver);

    await expect(send(receiver, ["known@example.test"], raw)).resolves.toBeDefined();
    await expect(send(receiver, ["unknown@example.test"], raw)).rejects.toMatchObject({
      responseCode: 550,
    });
    await expect(send(receiver, ["temporary@example.test"], raw)).rejects.toMatchObject({
      responseCode: 451,
    });
    expect(store.messages).toHaveLength(1);
  });

  it("partitions organizations, deduplicates across a listener restart, and rejects malformed/oversized DATA", async () => {
    const store = new DurableRecordingStore();
    const resolver = async (address: string) =>
      address.endsWith("@one.test")
        ? resolved("org-1", `actor-${address}`, address)
        : address.endsWith("@two.test")
          ? resolved("org-2", `actor-${address}`, address)
          : null;
    let receiver = await startReceiver(store, resolver, { maxMessageBytes: 512 });
    receivers.push(receiver);

    await send(receiver, ["a@one.test", "b@one.test", "c@two.test"], raw);
    expect(store.messages).toHaveLength(2);
    expect(
      JSON.stringify(store.messages.find((message) => message.orgId === "org-1")),
    ).not.toContain("c@two.test");

    await receiver.close();
    receivers.splice(receivers.indexOf(receiver), 1);
    receiver = await startReceiver(store, resolver, { maxMessageBytes: 512 });
    receivers.push(receiver);
    await send(receiver, ["a@one.test", "b@one.test", "c@two.test"], raw);
    expect(store.messages).toHaveLength(2);

    await expect(
      send(receiver, ["a@one.test"], "this is not an RFC 5322 message"),
    ).rejects.toMatchObject({ responseCode: 550 });
    await expect(
      send(
        receiver,
        ["a@one.test"],
        `From: sender@external.example\r\nSubject: too large\r\n\r\n${"x".repeat(1_000)}`,
      ),
    ).rejects.toMatchObject({ responseCode: 552 });
  });
});

async function startReceiver(
  store: DurableRecordingStore,
  resolveRecipient: (address: string) => Promise<SmtpResolvedRecipient | null>,
  limits: ConstructorParameters<typeof SmtpMailReceiver>[0]["limits"] = {},
): Promise<SmtpMailReceiver> {
  const receiver = new SmtpMailReceiver({
    store: store as unknown as RecipientAwareMailStore,
    recipientResolver: { resolveRecipient },
    authenticator: {
      async authenticate() {
        return { spf: "fail", dkim: "fail", dmarc: "fail", arc: "none" };
      },
    },
    transportSecurity: { mode: "development-plaintext" },
    limits,
  });
  await receiver.listen(0, "127.0.0.1");
  return receiver;
}

async function send(
  receiver: SmtpMailReceiver,
  recipients: readonly string[],
  message: string,
): Promise<unknown> {
  const address = receiver.nodeServer.server.address() as AddressInfo;
  const transport = nodemailer.createTransport({
    host: "127.0.0.1",
    port: address.port,
    secure: false,
    ignoreTLS: true,
  });
  try {
    return await transport.sendMail({
      envelope: { from: "sender@external.example", to: [...recipients] },
      raw: message,
    });
  } finally {
    transport.close();
  }
}

class DurableRecordingStore {
  readonly messages: MailMessageInput[] = [];
  readonly #stored = new Map<string, IdempotentStoredMailMessage>();

  async insertInboundMessageIdempotent(
    input: InsertInboundMessageIdempotentInput,
  ): Promise<IdempotentStoredMailMessage> {
    const key = `${input.message.orgId}:${input.dedup.key}`;
    const existing = this.#stored.get(key);
    if (existing !== undefined) {
      return { ...existing, duplicate: true };
    }
    const suffix = String(this.messages.length + 1);
    const stored = {
      deliveryId: `delivery-${suffix}`,
      duplicate: false,
      threadId: `thread-${suffix}`,
      messageId: `message-${suffix}`,
      attachmentObjectIds: [],
    };
    this.#stored.set(key, stored);
    this.messages.push(input.message);
    return stored;
  }

  async listFilters() {
    return [];
  }

  async getActiveVacation() {
    return null;
  }

  async updateThreadState() {}
}

function resolved(orgId: string, actorId: string, address: string): SmtpResolvedRecipient {
  return {
    orgId,
    receivingDomainId: `domain-${orgId}`,
    domain: address.split("@")[1] ?? "",
    normalizedAddress: address,
    actorId,
    match: "primary",
  };
}
