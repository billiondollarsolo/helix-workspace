import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import { classifyMailCategory } from "./category.js";
import { shouldSkipVacationResponse } from "./core/thread-projection.js";
import { evaluateInboundMail } from "./filters.js";
import { inboundHeaderMap, parsedMailToMessage } from "./inbound-message.js";
import { ingestRawMail, type MailAuthenticationSummary } from "./ingest.js";
import { localHeaderMap } from "./local-delivery.js";
import type { CreateOutboundMailInput } from "./store-contracts.js";
import { headerHasListUnsubscribe } from "./store-message-write.js";
import type { MailStore } from "./store.js";
import type { MailMessageInput, StoredMailMessage } from "./types.js";

const recipient = { orgId: "org-1", actorId: "actor-1", address: "me@helix.test" };
const pass: MailAuthenticationSummary = { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" };

function raw(extraHeaders: readonly string[] = [], to = "me@helix.test"): string {
  return [
    "From: Friend <friend@example.com>",
    `To: ${to}`,
    "Cc: other@example.com",
    "Subject: Lunch?",
    "Message-ID: <parent@example.com>",
    "References: <root@example.com>",
    ...extraHeaders,
    "",
    "Are you free?",
  ].join("\r\n");
}

class VacationStore {
  readonly outbound: CreateOutboundMailInput[] = [];
  readonly inserted: MailMessageInput[] = [];
  readonly patches: unknown[] = [];
  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    this.inserted.push(input);
    return {
      threadId: "thread-1",
      messageId: "message-1",
      attachmentObjectIds: [],
      created: true,
      deliveredActorIds: input.mailboxActorIds ?? [],
    };
  }
  async listFilters() {
    return [];
  }
  async listAliases() {
    return [];
  }
  async updateThreadState(input: unknown) {
    this.patches.push(input);
  }
  async getActiveVacation() {
    return {
      id: "vacation-1",
      orgId: "org-1",
      actorId: "actor-1",
      enabled: true,
      subject: "Out of office",
      body: "Back Monday.",
      startsAt: null,
      endsAt: null,
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }
  async recordVacationResponse() {
    return true;
  }
  async createOutbound(input: CreateOutboundMailInput) {
    this.outbound.push(input);
    return {} as never;
  }
}

async function ingest(
  store: VacationStore,
  options: {
    readonly headers?: readonly string[];
    readonly auth?: MailAuthenticationSummary;
    readonly spam?: boolean;
    readonly to?: string;
  } = {},
) {
  return ingestRawMail({
    store: store as unknown as MailStore,
    authenticationPolicy: false,
    authenticator: { authenticate: async () => options.auth ?? pass },
    ...(options.spam === true
      ? {
          scanners: {
            spam: {
              async scan() {
                return {
                  score: 12,
                  thresholdReportedBySpamd: 5,
                  isSpam: true,
                  symbols: ["BAYES_99"],
                  evidence: { scanned: true },
                };
              },
            },
          },
        }
      : {}),
    input: { orgId: "org-1", recipients: [recipient], raw: raw(options.headers, options.to) },
  });
}

describe("inbound header map (ML3a/ML11)", () => {
  it("keeps only allowlisted, sanitized, length-capped headers", async () => {
    const parsed = await simpleParser(
      raw([
        "Auto-Submitted: auto-replied",
        "Precedence: bulk",
        "List-Id: Team <team.lists.example.com>",
        "List-Unsubscribe: <mailto:leave@lists.example.com>",
        "Reply-To: Desk <desk@example.com>",
        "X-Auto-Response-Suppress: OOF",
        "Return-Path: <bounce@example.com>",
        "X-Secret: do-not-store",
        `X-Long: ${"a".repeat(2_000)}`,
        `List-Id: second ${"b".repeat(2_000)}`,
      ]),
    );
    const headers = inboundHeaderMap(parsed.headerLines);
    expect(Object.keys(headers).sort()).toEqual([
      "auto-submitted",
      "list-id",
      "list-unsubscribe",
      "precedence",
      "reply-to",
      "return-path",
      "x-auto-response-suppress",
    ]);
    expect(headers["list-id"]).toBe("Team <team.lists.example.com>");
    expect(Object.values(headers).every((value) => value.length <= 512)).toBe(true);

    const message = parsedMailToMessage({ orgId: "org-1", recipients: [recipient] }, parsed, pass);
    expect(message.metadata?.headers).toEqual(headers);
    expect(message.metadata?.replyTo).toEqual([{ address: "desk@example.com", name: "Desk" }]);
    // The promotions category reads the same `metadata.headers` key.
    expect(headerHasListUnsubscribe(message.metadata)).toBe(true);
    expect(
      classifyMailCategory({
        fromAddress: "friend@example.com",
        subject: "Lunch?",
        hasListUnsubscribe: headerHasListUnsubscribe(message.metadata),
      }),
    ).toBe("promotions");
  });
});

describe("vacation replies (ML3)", () => {
  it("replies once with Auto-Submitted: auto-replied and threading headers", async () => {
    const store = new VacationStore();
    const result = await ingest(store);
    expect(result.filterResult.vacationQueued).toBe(true);
    const envelope = store.outbound[0]?.envelope;
    expect(envelope?.headers).toEqual({ "Auto-Submitted": "auto-replied" });
    expect(envelope?.to).toEqual([{ address: "friend@example.com", name: "Friend" }]);
    expect(envelope?.inReplyTo).toBe("<parent@example.com>");
    expect(envelope?.references).toEqual(["<root@example.com>", "<parent@example.com>"]);
  });

  it("stores headers at ingest so auto-submitted and list mail get no reply", async () => {
    for (const headers of [
      ["Auto-Submitted: auto-generated"],
      ["Precedence: list"],
      ["List-Id: <team.lists.example.com>"],
      ["List-Unsubscribe: <https://lists.example.com/leave>"],
      ["X-Auto-Response-Suppress: All"],
    ]) {
      const store = new VacationStore();
      const result = await ingest(store, { headers });
      expect(result.filterResult.vacationQueued, headers.join()).toBe(false);
      expect(store.outbound).toHaveLength(0);
    }
  });

  it("does not reply when the user is not in To/Cc", async () => {
    const store = new VacationStore();
    const result = await ingest(store, { to: "all-staff@lists.example.com" });
    expect(result.filterResult.vacationQueued).toBe(false);
  });

  it("does not reply to spam-routed or DMARC-failing mail", async () => {
    const spam = new VacationStore();
    expect((await ingest(spam, { spam: true })).filterResult.vacationQueued).toBe(false);
    expect(spam.outbound).toHaveLength(0);

    const spoofed = new VacationStore();
    const result = await ingest(spoofed, {
      auth: { spf: "pass", dkim: "fail", dmarc: "fail", arc: "none" },
    });
    expect(result.filterResult.vacationQueued).toBe(false);
    expect(spoofed.outbound).toHaveLength(0);
  });

  it("gives locally delivered mail the same header map, so Helix auto-replies never loop", () => {
    const headers = localHeaderMap({
      from: { address: "away@helix.test" },
      to: [{ address: "me@helix.test" }],
      cc: [],
      bcc: [],
      subject: "Out of office",
      text: "Back Monday.",
      attachments: [],
      headers: { "Auto-Submitted": "auto-replied" },
      replyTo: { address: "desk@helix.test" },
    });
    expect(headers).toEqual({ "auto-submitted": "auto-replied", "reply-to": "desk@helix.test" });
    expect(shouldSkipVacationResponse({ senderEmail: "away@helix.test", headers })).toBe(true);
  });

  it("suppresses the vacation reply when the caller marks the message unsafe", async () => {
    const store = new VacationStore();
    const parsed = await simpleParser(raw());
    const message = parsedMailToMessage({ orgId: "org-1", recipients: [recipient] }, parsed, pass);
    const result = await evaluateInboundMail(store as unknown as MailStore, {
      message,
      stored: { threadId: "thread-1", messageId: "message-1" },
      recipientActorId: "actor-1",
      recipientAddress: "me@helix.test",
      suppressAutoReply: true,
    });
    expect(result.vacationQueued).toBe(false);
    expect(store.outbound).toHaveLength(0);
  });
});
