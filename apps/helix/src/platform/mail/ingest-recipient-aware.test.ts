import { describe, expect, it } from "vitest";
import type {
  IdempotentStoredMailMessage,
  InsertInboundMessageIdempotentInput,
  RecipientAwareMailStore,
} from "./store.js";
import { ingestResolvedRawMail } from "./ingest.js";
import type { MailMessageInput, MailThreadStatePatch } from "./types.js";
import type { SmtpResolvedRecipient } from "./smtp-recipient-resolver.js";
import { InMemoryMailQuarantineStore } from "./quarantine.js";

const orgOne = "10000000-0000-4000-8000-000000000001";
const orgTwo = "20000000-0000-4000-8000-000000000002";
const actorOne = "10000000-0000-4000-8000-000000000011";
const actorAlias = "10000000-0000-4000-8000-000000000012";
const actorTwo = "20000000-0000-4000-8000-000000000022";

const recipients: readonly SmtpResolvedRecipient[] = [
  resolved(orgOne, actorOne, "owner@one.example", "primary"),
  resolved(orgOne, actorAlias, "alias@one.example", "alias"),
  resolved(orgTwo, actorTwo, "owner@two.example", "primary"),
];

const raw = [
  "From: Spoofed CEO <spoofed@external.example>",
  "To: owner@one.example, owner@two.example",
  "Cc: alias@one.example",
  "Message-ID: <shared@external.example>",
  "Subject: Tenant partition",
  "",
  "One parsed and scanned body.",
].join("\r\n");

describe("recipient-aware inbound ingest", () => {
  it("authenticates, parses, and scans once, then stores one tenant-safe copy per org", async () => {
    const store = new RecordingRecipientAwareStore();
    let authenticationCalls = 0;
    let spamCalls = 0;
    let antivirusCalls = 0;
    const result = await ingestResolvedRawMail({
      store: store.asStore(),
      authenticator: {
        async authenticate() {
          authenticationCalls += 1;
          return { spf: "fail", dkim: "fail", dmarc: "fail", arc: "none" };
        },
      },
      scanners: {
        spam: {
          async scan() {
            spamCalls += 1;
            return {
              score: 0,
              thresholdReportedBySpamd: 5,
              isSpam: false,
              symbols: [],
              evidence: { scanner: "fake-spam" },
            };
          },
        },
        antivirus: {
          async scan() {
            antivirusCalls += 1;
            return {
              infected: false,
              signature: null,
              scanned: true,
              disposition: "allow",
              evidence: { scanner: "fake-av" },
            };
          },
        },
      },
      input: {
        raw,
        recipients,
        envelopeFrom: "bounce@external.example",
        receivedAt: new Date("2026-07-28T12:00:00.000Z"),
      },
    });

    expect(authenticationCalls).toBe(1);
    expect(spamCalls).toBe(1);
    expect(antivirusCalls).toBe(1);
    expect(result.deliveries).toHaveLength(2);
    expect(store.messages).toHaveLength(2);

    const first = store.messages.find((message) => message.orgId === orgOne);
    const second = store.messages.find((message) => message.orgId === orgTwo);
    expect(first?.to.map((address) => address.address)).toEqual([
      "owner@one.example",
      "alias@one.example",
    ]);
    expect(second?.to.map((address) => address.address)).toEqual(["owner@two.example"]);
    expect(first?.cc).toEqual([]);
    expect(first?.bcc).toEqual([]);
    expect(JSON.stringify(first)).not.toContain("owner@two.example");
    expect(JSON.stringify(second)).not.toContain("owner@one.example");
    expect(first?.metadata).toMatchObject({
      auth: { spf: "fail", dkim: "fail", dmarc: "fail" },
      envelopeFrom: "bounce@external.example",
      envelopeTo: ["owner@one.example", "alias@one.example"],
    });
  });

  it("uses durable per-org dedup for duplicate and concurrent delivery", async () => {
    const store = new RecordingRecipientAwareStore();
    const input = {
      store: store.asStore(),
      authenticator: noneAuthenticator,
      input: {
        raw,
        recipients: recipients.slice(0, 2),
        envelopeFrom: "bounce@external.example",
        receivedAt: new Date("2026-07-28T12:00:00.000Z"),
      },
    };
    const [first, concurrent] = await Promise.all([
      ingestResolvedRawMail(input),
      ingestResolvedRawMail(input),
    ]);
    const retry = await ingestResolvedRawMail(input);

    expect(store.messages).toHaveLength(1);
    expect(store.filterReads).toBe(2);
    expect(
      [first, concurrent, retry].map((result) => result.deliveries[0]?.stored.duplicate),
    ).toEqual(expect.arrayContaining([false, true, true]));
  });

  it("makes a partial multi-org 451 retry safe", async () => {
    const store = new RecordingRecipientAwareStore();
    store.failOnceForOrg = orgTwo;
    const input = {
      store: store.asStore(),
      authenticator: noneAuthenticator,
      input: {
        raw,
        recipients,
        envelopeFrom: "bounce@external.example",
        receivedAt: new Date("2026-07-28T12:00:00.000Z"),
      },
    };
    await expect(ingestResolvedRawMail(input)).rejects.toThrow("temporary store failure");
    expect(store.messages.map((message) => message.orgId)).toEqual([orgOne]);

    const retry = await ingestResolvedRawMail(input);
    expect(store.messages.map((message) => message.orgId)).toEqual([orgOne, orgTwo]);
    expect(retry.deliveries[0]?.stored.duplicate).toBe(true);
    expect(retry.deliveries[1]?.stored.duplicate).toBe(false);
  });

  it("retains infected and scanner-policy quarantine evidence for every tenant copy", async () => {
    const store = new RecordingRecipientAwareStore();
    const quarantineStore = new InMemoryMailQuarantineStore();
    const result = await ingestResolvedRawMail({
      store: store.asStore(),
      quarantineStore,
      authenticator: noneAuthenticator,
      scanners: {
        antivirus: {
          async scan() {
            return {
              infected: true,
              signature: "Eicar-Test-Signature",
              scanned: true,
              disposition: "quarantine",
              evidence: { scanner: "fake-av" },
            };
          },
        },
      },
      input: { raw, recipients },
    });
    expect(result.scan).toMatchObject({
      routedToSpam: true,
      quarantined: true,
      spamReason: "virus",
    });
    expect(store.messages).toHaveLength(0);
    expect(result.quarantines).toHaveLength(2);
    expect(await quarantineStore.list(orgOne)).toHaveLength(1);
    expect(await quarantineStore.list(orgTwo)).toHaveLength(1);
    expect(store.patches).toHaveLength(0);
  });

  it("fails closed on Business scanner outage and never delivers attachment objects", async () => {
    const store = new RecordingRecipientAwareStore();
    const quarantineStore = new InMemoryMailQuarantineStore();
    const result = await ingestResolvedRawMail({
      store: store.asStore(),
      quarantineStore,
      authenticator: noneAuthenticator,
      scanners: {
        tier: "business",
        antivirus: {
          async scan() {
            throw new Error("clamd unavailable");
          },
        },
      },
      input: { raw, recipients: recipients.slice(0, 2) },
    });
    expect(result.scan).toMatchObject({
      quarantined: true,
      scannerUnavailable: true,
      quarantineReasons: ["scanner_unavailable"],
    });
    expect(store.messages).toHaveLength(0);
    expect(result.quarantines).toHaveLength(1);
  });

  it("quarantines active attachments before any mailbox or Drive object is created", async () => {
    const store = new RecordingRecipientAwareStore();
    const quarantineStore = new InMemoryMailQuarantineStore();
    const activeAttachmentRaw = [
      "From: Sender <sender@external.example>",
      "To: owner@one.example",
      "Message-ID: <active-attachment@external.example>",
      "Subject: Active attachment",
      'Content-Type: multipart/mixed; boundary="helix-boundary"',
      "",
      "--helix-boundary",
      "Content-Type: text/plain",
      "",
      "See attachment.",
      "--helix-boundary",
      "Content-Type: application/javascript",
      'Content-Disposition: attachment; filename="payload.js"',
      "Content-Transfer-Encoding: base64",
      "",
      "YWxlcnQoMSk=",
      "--helix-boundary--",
      "",
    ].join("\r\n");

    const result = await ingestResolvedRawMail({
      store: store.asStore(),
      quarantineStore,
      authenticator: noneAuthenticator,
      input: {
        raw: activeAttachmentRaw,
        recipients: recipients.slice(0, 1),
      },
    });

    expect(result.scan).toMatchObject({
      quarantined: true,
      quarantineReasons: expect.arrayContaining([
        "active_attachment_extension",
        "active_attachment_mime",
      ]),
    });
    expect(store.messages).toHaveLength(0);
    expect(result.deliveries).toHaveLength(0);
    expect(await quarantineStore.list(orgOne)).toHaveLength(1);
  });
});

class RecordingRecipientAwareStore {
  readonly messages: MailMessageInput[] = [];
  readonly patches: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }[] = [];
  readonly #stored = new Map<string, IdempotentStoredMailMessage>();
  filterReads = 0;
  failOnceForOrg: string | null = null;

  asStore(): RecipientAwareMailStore {
    return this as unknown as RecipientAwareMailStore;
  }

  async insertInboundMessageIdempotent(
    input: InsertInboundMessageIdempotentInput,
  ): Promise<IdempotentStoredMailMessage> {
    if (this.failOnceForOrg === input.message.orgId) {
      this.failOnceForOrg = null;
      throw new Error("temporary store failure");
    }
    const key = `${input.message.orgId}:${input.dedup.key}`;
    const existing = this.#stored.get(key);
    if (existing !== undefined) {
      return { ...existing, duplicate: true };
    }
    const index = this.messages.length + 1;
    const stored = {
      deliveryId: `delivery-${String(index)}`,
      duplicate: false,
      threadId: `thread-${String(index)}`,
      messageId: `message-${String(index)}`,
      attachmentObjectIds: [],
    };
    this.#stored.set(key, stored);
    this.messages.push(input.message);
    return stored;
  }

  async listFilters() {
    this.filterReads += 1;
    return [];
  }

  async getActiveVacation() {
    return null;
  }

  async updateThreadState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }) {
    this.patches.push(input);
  }
}

const noneAuthenticator = {
  async authenticate() {
    return { spf: "none", dkim: "none", dmarc: "none", arc: "none" };
  },
};

function resolved(
  orgId: string,
  actorId: string,
  normalizedAddress: string,
  match: SmtpResolvedRecipient["match"],
): SmtpResolvedRecipient {
  return {
    orgId,
    actorId,
    receivingDomainId: `domain-${orgId}`,
    domain: normalizedAddress.split("@")[1] ?? "",
    normalizedAddress,
    match,
  };
}
