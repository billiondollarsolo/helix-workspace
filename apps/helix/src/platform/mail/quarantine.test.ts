import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { ingestSmtpEnvelope } from "./ingest.js";
import { parseInboundAuthenticationPolicy } from "./inbound-policy.js";
import { registerMailQuarantineAdminRoutes } from "./quarantine-admin.js";
import type {
  MailQuarantinePayload,
  MailQuarantineStore,
  MailQuarantineSummary,
  QuarantineInboundMailInput,
} from "./quarantine.js";
import type { MailMessageInput, StoredMailMessage } from "./types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const quarantineId = "33333333-3333-4333-8333-333333333333";
const raw = Buffer.from(
  [
    "From: attacker@example.test",
    "To: user@helix.test",
    "Subject: EICAR attachment",
    'Content-Type: multipart/mixed; boundary="eicar"',
    "",
    "--eicar",
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="eicar.com"',
    "",
    "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    "--eicar--",
    "",
  ].join("\r\n"),
);

const auth = {
  async authenticate() {
    return { spf: "fail", dkim: "fail", dmarc: "fail", arc: "none" } as const;
  },
};

const cleanSpam = {
  async scan() {
    return {
      score: 0,
      thresholdReportedBySpamd: 5,
      isSpam: false,
      symbols: [],
      evidence: { scanned: true },
    };
  },
};

describe("inaccessible mail quarantine", () => {
  it("accepts EICAR into raw-only quarantine without creating mailbox-visible content", async () => {
    const quarantine = new MemoryQuarantineStore();
    const mail = new RecordingMailStore();
    const results = await ingestSmtpEnvelope({
      store: mail as never,
      quarantineStore: quarantine,
      resolveRecipient: async (address) => ({ orgId, actorId, address }),
      raw,
      envelopeTo: ["user@helix.test"],
      authenticator: auth,
      scanners: {
        antivirus: infectedScanner(),
      },
    });

    expect(results).toEqual([]);
    expect(quarantine.quarantined).toHaveLength(1);
    expect(quarantine.quarantined[0]?.raw).toEqual(raw);
    expect(mail.inserted).toHaveLength(0);
    expect(mail.updated).toHaveLength(0);
  });

  it("quarantines a tenant-blocked sender before mailbox persistence", async () => {
    const quarantine = new MemoryQuarantineStore();
    const mail = new RecordingMailStore();
    const results = await ingestSmtpEnvelope({
      store: mail as never,
      quarantineStore: quarantine,
      resolveRecipient: async (address) => ({ orgId, actorId, address }),
      resolveAuthenticationPolicy: async () =>
        parseInboundAuthenticationPolicy({
          blockDomains: ["example.test"],
          blocklistAction: "quarantine",
        }),
      raw,
      envelopeTo: ["user@helix.test"],
      authenticator: auth,
    });

    expect(results).toEqual([]);
    expect(quarantine.quarantined).toEqual([
      expect.objectContaining({ signature: "mail-policy:sender-domain-blocklisted" }),
    ]);
    expect(mail.inserted).toHaveLength(0);
  });
});

describe("mail quarantine admin flow", () => {
  let app: FastifyInstance;
  let actor: Actor;
  let infected: boolean;
  let scannerUnavailable: boolean;
  let quarantine: MemoryQuarantineStore;
  let mail: RecordingMailStore;
  let audits: { readonly verb: string; readonly metadata?: unknown }[];

  beforeEach(async () => {
    actor = {
      id: actorId,
      orgId,
      type: "user",
      displayName: "Mail admin",
      scopes: ["admin.console.write"],
    };
    infected = true;
    scannerUnavailable = false;
    quarantine = new MemoryQuarantineStore();
    quarantine.seed(raw);
    mail = new RecordingMailStore();
    audits = [];
    app = fastify();
    registerMailQuarantineAdminRoutes(app, {
      store: quarantine,
      mailStore: mail as never,
      scanners: {
        spam: cleanSpam,
        antivirus: {
          async scan() {
            if (scannerUnavailable) throw new Error("clamd offline");
            return infected
              ? infectedScannerResult()
              : {
                  infected: false,
                  signature: null,
                  scanned: true,
                  evidence: { scanned: true },
                };
          },
        },
      },
      resolveRecipient: async (address) => ({ orgId, actorId, address }),
      authenticator: auth,
      actorFromRequest: () => actor,
      auditSink: {
        async append(record) {
          audits.push({ verb: record.verb, metadata: record.metadata });
          return { id: "audit-1", thisHash: "hash" };
        },
      },
    });
    await app.ready();
  });

  afterEach(async () => app.close());

  it("denies recipients and never returns raw, body, subject, attachment, or storage data", async () => {
    actor = { ...actor, scopes: ["mail.read"] };
    const denied = await app.inject({ method: "GET", url: "/api/admin/mail/quarantine" });
    expect(denied.statusCode).toBe(403);

    actor = { ...actor, scopes: ["admin.console.read"] };
    const listed = await app.inject({ method: "GET", url: "/api/admin/mail/quarantine" });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
    expect(listed.body).not.toMatch(/storage|raw|body|subject|attachment/iu);
  });

  it("fails release closed while infected, then rechecks clean bytes and audits release", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: `/api/admin/mail/quarantine/${quarantineId}/release`,
      payload: { reason: "False positive review" },
    });
    expect(rejected.statusCode).toBe(409);
    expect(mail.inserted).toHaveLength(0);
    expect(quarantine.releases).toHaveLength(0);
    expect(audits).toHaveLength(0);

    infected = false;
    const released = await app.inject({
      method: "POST",
      url: `/api/admin/mail/quarantine/${quarantineId}/release`,
      payload: { reason: "False positive review" },
    });
    expect(released.statusCode).toBe(200);
    expect(mail.inserted).toHaveLength(1);
    expect(quarantine.releases).toHaveLength(1);
    expect(audits).toEqual([expect.objectContaining({ verb: "mail.quarantine.released" })]);
    expect(released.body).not.toContain("EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
  });

  it("fails release closed when the policy scanner is unavailable", async () => {
    scannerUnavailable = true;
    const unavailable = await app.inject({
      method: "POST",
      url: `/api/admin/mail/quarantine/${quarantineId}/release`,
      payload: { reason: "False positive review" },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(mail.inserted).toHaveLength(0);
    expect(quarantine.releases).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("requires write scope and a reason, then audits deletion", async () => {
    actor = { ...actor, scopes: ["admin.console.read"] };
    const denied = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/quarantine/${quarantineId}`,
      payload: { reason: "Confirmed malware" },
    });
    expect(denied.statusCode).toBe(403);

    actor = { ...actor, scopes: ["admin.console.write"] };
    const missingReason = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/quarantine/${quarantineId}`,
      payload: {},
    });
    expect(missingReason.statusCode).toBe(400);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/admin/mail/quarantine/${quarantineId}`,
      payload: { reason: "Confirmed malware" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(quarantine.deletions).toHaveLength(1);
    expect(audits).toEqual([expect.objectContaining({ verb: "mail.quarantine.deleted" })]);
  });
});

function infectedScanner() {
  return {
    async scan() {
      return infectedScannerResult();
    },
  };
}

function infectedScannerResult() {
  return {
    infected: true,
    signature: "Eicar-Test-Signature",
    scanned: true,
    evidence: { scanned: true },
  } as const;
}

class RecordingMailStore {
  readonly inserted: MailMessageInput[] = [];
  readonly updated: unknown[] = [];

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    this.inserted.push(input);
    return {
      threadId: "44444444-4444-4444-8444-444444444444",
      messageId: "55555555-5555-4555-8555-555555555555",
      attachmentObjectIds: [],
      created: true,
      deliveredActorIds: [actorId],
    };
  }

  async updateThreadState(input: unknown): Promise<void> {
    this.updated.push(input);
  }

  async listFilters() {
    return [];
  }
  async getActiveVacation() {
    return null;
  }
}

class MemoryQuarantineStore implements MailQuarantineStore {
  readonly quarantined: QuarantineInboundMailInput[] = [];
  readonly releases: unknown[] = [];
  readonly deletions: unknown[] = [];
  private payload: MailQuarantinePayload | null = null;

  seed(bytes: Buffer): void {
    this.payload = {
      id: quarantineId,
      releaseToken: "66666666-6666-4666-8666-666666666666",
      orgId,
      recipientAddresses: ["user@helix.test"],
      raw: bytes,
      signature: "Eicar-Test-Signature",
      authentication: {},
      scanEvidence: { scanned: true },
      envelopeFrom: "attacker@example.test",
    };
  }

  async quarantine(input: QuarantineInboundMailInput) {
    this.quarantined.push(input);
    this.seed(input.raw);
    return { id: quarantineId };
  }

  async listPending(): Promise<readonly MailQuarantineSummary[]> {
    return [
      {
        id: quarantineId,
        recipientAddresses: ["user@helix.test"],
        envelopeFrom: "attacker@example.test",
        signature: "Eicar-Test-Signature",
        status: "pending",
        bytesDeleted: false,
        createdAt: new Date("2026-09-02T12:00:00.000Z"),
        resolvedAt: null,
      },
    ];
  }

  async claimRelease(): Promise<MailQuarantinePayload | null> {
    return this.payload;
  }

  async abortRelease(): Promise<void> {}

  async release(input: unknown) {
    this.releases.push(input);
    this.payload = null;
    return { resolved: true, bytesDeleted: true };
  }

  async delete(input: unknown) {
    this.deletions.push(input);
    this.payload = null;
    return { found: true, bytesDeleted: true };
  }
}
