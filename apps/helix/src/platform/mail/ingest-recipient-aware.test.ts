import { describe, expect, it } from "vitest";
import { CapturingMailQuarantineStore } from "../../test-support/quarantine-store.js";
import { ingestSmtpEnvelope } from "./ingest.js";
import type { MailStore } from "./store.js";
import type { MailMessageInput, StoredMailMessage } from "./types.js";

const recipients = [
  { orgId: "org-one", actorId: "owner-one", address: "owner@one.example" },
  { orgId: "org-one", actorId: "alias-one", address: "alias@one.example" },
  { orgId: "org-two", actorId: "owner-two", address: "owner@two.example" },
];
const raw = [
  "From: Sender <sender@external.example>",
  "To: owner@one.example, owner@two.example",
  "Cc: alias@one.example",
  "Message-ID: <shared@external.example>",
  "Subject: Tenant partition",
  "",
  "One body.",
].join("\r\n");
class RecordingStore {
  readonly messages: MailMessageInput[] = [];
  readonly stored = new Map<string, StoredMailMessage>();
  failOnceForOrg: string | null = null;
  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    if (this.failOnceForOrg === input.orgId) {
      this.failOnceForOrg = null;
      throw new Error("temporary database failure");
    }
    const key = `${input.orgId}:${input.rawSource?.sha256 ?? ""}`;
    const existing = this.stored.get(key);
    if (existing) return { ...existing, created: false, deliveredActorIds: [] };
    const result = {
      created: true,
      deliveredActorIds: input.mailboxActorIds ?? [],
      threadId: `thread-${String(this.messages.length)}`,
      messageId: `message-${String(this.messages.length)}`,
      attachmentObjectIds: [],
    };
    this.messages.push(input);
    this.stored.set(key, result);
    return result;
  }
  async listFilters() {
    return [];
  }
  async getActiveVacation() {
    return null;
  }
  async updateThreadState() {}
}
function input(store: RecordingStore) {
  return {
    store: store as unknown as MailStore,
    raw,
    envelopeFrom: "bounce@external.example",
    envelopeTo: recipients.map((recipient) => recipient.address),
    resolveRecipient: async (address: string) =>
      recipients.find((recipient) => recipient.address === address) ?? null,
    authenticator: {
      authenticate: async () => ({
        spf: "fail" as const,
        dkim: "fail" as const,
        dmarc: "fail" as const,
        arc: "none" as const,
      }),
    },
  };
}
describe("recipient-aware SMTP ingest", () => {
  it("stores separate tenant copies with only their resolved recipients", async () => {
    const store = new RecordingStore();
    await ingestSmtpEnvelope(input(store));
    expect(store.messages).toHaveLength(2);
    const first = store.messages.find((message) => message.orgId === "org-one");
    const second = store.messages.find((message) => message.orgId === "org-two");
    if (first === undefined || second === undefined)
      throw new Error("Both tenant messages are required.");
    expect(first.mailboxActorIds).toEqual(["owner-one", "alias-one"]);
    expect(second.mailboxActorIds).toEqual(["owner-two"]);
    expect(JSON.stringify({ to: first.to, cc: first.cc, bcc: first.bcc })).not.toContain(
      "two.example",
    );
    expect(JSON.stringify({ to: second.to, cc: second.cc, bcc: second.bcc })).not.toContain(
      "one.example",
    );
  });
  it("does not duplicate successful tenant delivery after a partial failure", async () => {
    const store = new RecordingStore();
    store.failOnceForOrg = "org-two";
    await expect(ingestSmtpEnvelope(input(store))).rejects.toThrow("temporary database failure");
    await ingestSmtpEnvelope(input(store));
    expect(store.messages.map((message) => message.orgId).sort()).toEqual(["org-one", "org-two"]);
  });
  it("preserves idempotent store results for concurrent and repeated deliveries", async () => {
    const store = new RecordingStore();
    await Promise.all([ingestSmtpEnvelope(input(store)), ingestSmtpEnvelope(input(store))]);
    const retry = await ingestSmtpEnvelope(input(store));
    expect(store.messages).toHaveLength(2);
    expect(retry.every((result) => !result.stored.created)).toBe(true);
  });
  it("retains infected raw evidence in quarantine for both tenants before creating messages", async () => {
    const store = new RecordingStore();
    const quarantineStore = new CapturingMailQuarantineStore();
    await ingestSmtpEnvelope({
      ...input(store),
      quarantineStore,
      scanners: {
        antivirus: {
          scan: async () => ({
            infected: true,
            signature: "test-malware",
            scanned: true,
            evidence: { signature: "test-malware" },
          }),
        },
      },
    });
    expect(store.messages).toHaveLength(0);
    expect(quarantineStore.records.map((record) => record.orgId).sort()).toEqual([
      "org-one",
      "org-two",
    ]);
  });
  it("defers required scanner outages without creating messages or attachments", async () => {
    const store = new RecordingStore();
    await expect(
      ingestSmtpEnvelope({
        ...input(store),
        resolveScanFailurePolicy: async () => "defer",
        scanners: {
          antivirus: {
            scan: async () => {
              throw new Error("scanner offline");
            },
          },
        },
      }),
    ).rejects.toMatchObject({ responseCode: 451 });
    expect(store.messages).toHaveLength(0);
  });
});
