import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { createTransport } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import {
  ingestSmtpEnvelope,
  SmtpMailReceiver,
  type MailAuthenticator,
  type SMTPServerSession,
} from "./ingest.js";
import { MailInboundQuotaExceededError } from "./errors.js";
import { PostgresMailStore, type MailStore } from "./store.js";
import type {
  MailInboundAddressResolution,
  MailInboundRecipient,
  MailMessageInput,
} from "./types.js";

const orgA = "11111111-1111-4111-8111-111111111111";
const orgB = "22222222-2222-4222-8222-222222222222";
const actorA = "33333333-3333-4333-8333-333333333333";
const actorB = "44444444-4444-4444-8444-444444444444";
const actorC = "55555555-5555-4555-8555-555555555555";

describe("inbound SMTP tenant routing", () => {
  it("resolves only active mailboxes under an active verified domain", async () => {
    const recording = recordingSql([
      [
        {
          org_id: orgA,
          actor_id: actorA,
          address: "alias@alpha.test",
          quota_exceeded: false,
        },
      ],
      [
        {
          org_id: orgA,
          actor_id: actorA,
          address: "same@shared.test",
          quota_exceeded: false,
        },
        {
          org_id: orgB,
          actor_id: actorB,
          address: "same@shared.test",
          quota_exceeded: false,
        },
      ],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await expect(store.resolveInboundRecipient("Alias@Alpha.Test")).resolves.toEqual({
      orgId: orgA,
      actorId: actorA,
      address: "alias@alpha.test",
    });
    await expect(store.resolveInboundRecipient("same@shared.test")).resolves.toBeNull();

    expect(recording.calls[0]).toContain("helix_resolve_inbound_mailbox");
    const migration = readFileSync(
      new URL("../../db/migrations/0077_communication_gateway_capabilities.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("d.verification_status = 'verified'");
    expect(migration).toContain("d.verified_at is not null");
    expect(migration).toContain("o.status = 'active'");
    expect(migration).toContain("a.disabled_at is null");
    expect(migration).toContain("alias.enabled = true");
    expect(migration).toContain("storage_bytes_limit");
    expect(migration).toContain("'mail_attachment'");
  });

  it("defers a valid mailbox whose pooled storage quota is exhausted", async () => {
    const recording = recordingSql([
      [
        {
          org_id: orgA,
          actor_id: actorA,
          address: "ada@alpha.test",
          quota_exceeded: true,
        },
      ],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await expect(store.resolveInboundRecipient("ada@alpha.test")).rejects.toBeInstanceOf(
      MailInboundQuotaExceededError,
    );
  });

  it("loads and groups tenant-owned routing targets for one envelope address", async () => {
    const recording = recordingSql([
      [{ org_id: orgA, actor_id: actorA, address: "ada@alpha.test", quota_exceeded: false }],
      [
        {
          id: "rule-alias",
          org_id: orgA,
          priority: 10,
          match: { recipientPattern: "*@alpha.test" },
          action_kind: "alias",
          action: { aliasActorId: actorB },
          target_actor_id: actorB,
          target_address: "bob@alpha.test",
          target_quota_exceeded: false,
          source_actor_id: null,
          source_address: null,
        },
      ],
    ]);
    const store = new PostgresMailStore(recording.sql);

    await expect(store.resolveInboundAddress("Unknown@Alpha.Test")).resolves.toMatchObject({
      address: "unknown@alpha.test",
      recipients: [{ actorId: actorA }],
      rules: [
        {
          id: "rule-alias",
          actionKind: "alias",
          targetRecipients: [{ actorId: actorB, address: "bob@alpha.test" }],
        },
      ],
    });
    expect(recording.calls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("helix_resolve_inbound_mailboxes"),
        expect.stringContaining("helix_resolve_inbound_routing_rules"),
      ]),
    );
  });

  it("delivers one raw message to each resolved tenant without a default org", async () => {
    const messages: MailMessageInput[] = [];
    const store = mailStore(messages);
    const recipients = new Map<string, MailInboundRecipient>([
      ["ada@alpha.test", { orgId: orgA, actorId: actorA, address: "ada@alpha.test" }],
      ["bob@beta.test", { orgId: orgB, actorId: actorB, address: "bob@beta.test" }],
    ]);

    await ingestSmtpEnvelope({
      store,
      resolveRecipient: async (address) => recipients.get(address.toLowerCase()) ?? null,
      authenticator: passingAuthenticator,
      raw: [
        "From: sender@example.net",
        "To: Ada <ada@alpha.test>, Bob <bob@beta.test>",
        "Subject: Tenant split",
        "",
        "hello",
      ].join("\r\n"),
      envelopeFrom: "sender@example.net",
      envelopeTo: ["ada@alpha.test", "bob@beta.test"],
    });

    expect(messages).toHaveLength(2);
    expect(messages.map(({ orgId, mailboxActorIds }) => ({ orgId, mailboxActorIds }))).toEqual(
      expect.arrayContaining([
        { orgId: orgA, mailboxActorIds: [actorA] },
        { orgId: orgB, mailboxActorIds: [actorB] },
      ]),
    );
    expect(store.findActorByAddress).not.toHaveBeenCalled();
  });

  it("delivers one group recipient to every resolved mailbox", async () => {
    const messages: MailMessageInput[] = [];

    await ingestSmtpEnvelope({
      store: mailStore(messages),
      resolveRecipient: async (address) => [
        { orgId: orgA, actorId: actorA, address },
        { orgId: orgA, actorId: actorC, address },
      ],
      authenticator: passingAuthenticator,
      raw: "From: sender@example.net\r\nTo: team@alpha.test\r\n\r\nhello",
      envelopeFrom: "sender@example.net",
      envelopeTo: ["team@alpha.test"],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.mailboxActorIds).toEqual([actorA, actorC]);
  });

  it("enforces parsed tag and forward rules with one durable forward", async () => {
    const messages: MailMessageInput[] = [];
    const updateThreadState = vi.fn().mockResolvedValue(undefined);
    const createOutbound = vi.fn().mockResolvedValue({});
    const authorizeForward = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const store = { ...mailStore(messages), updateThreadState, createOutbound };
    const source = { orgId: orgA, actorId: actorA, address: "ada@alpha.test" };
    const resolution = {
      address: "ada@alpha.test",
      recipients: [source],
      rules: [
        {
          id: "rule-tag",
          orgId: orgA,
          priority: 1,
          match: { subjectContains: "urgent" },
          actionKind: "tag",
          action: { tag: "priority" },
          targetRecipients: [],
        },
        {
          id: "rule-forward",
          orgId: orgA,
          priority: 2,
          match: { senderPattern: "*@example.net" },
          actionKind: "forward",
          action: { forwardTo: "archive@example.org", stopProcessing: true },
          targetRecipients: [],
          sourceRecipient: source,
        },
      ],
    } satisfies MailInboundAddressResolution;

    const delivery = {
      store,
      resolveRecipient: async () => resolution,
      authorizeForward,
      authenticator: passingAuthenticator,
      raw: "From: Sender <sender@example.net>\r\nTo: ada@alpha.test\r\nSubject: Urgent case\r\n\r\nhello",
      envelopeTo: [resolution.address],
    } satisfies Parameters<typeof ingestSmtpEnvelope>[0];
    await ingestSmtpEnvelope(delivery);

    expect(messages).toHaveLength(1);
    expect(updateThreadState).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actorA, patch: { addLabels: ["priority"] } }),
    );
    expect(createOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: actorA,
        idempotencyKey: "routing:message-1:rule-forward",
        envelope: expect.objectContaining({
          from: { address: "ada@alpha.test" },
          to: [{ address: "archive@example.org" }],
          subject: "Fwd: Urgent case",
        }),
      }),
    );
    expect(authorizeForward).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: orgA, actorId: actorA }),
    );
    await ingestSmtpEnvelope(delivery);
    expect(createOutbound).toHaveBeenCalledTimes(1);
  });

  it("accepts and discards a catch-all drop without creating content", async () => {
    const messages: MailMessageInput[] = [];
    const resolution = {
      address: "unknown@alpha.test",
      recipients: [],
      rules: [
        {
          id: "rule-drop",
          orgId: orgA,
          priority: 1,
          match: { recipientPattern: "*@alpha.test" },
          actionKind: "drop",
          action: { stopProcessing: true },
          targetRecipients: [],
        },
      ],
    } satisfies MailInboundAddressResolution;

    await expect(
      ingestSmtpEnvelope({
        store: mailStore(messages),
        resolveRecipient: async () => resolution,
        authenticator: passingAuthenticator,
        raw: "From: sender@example.net\r\nTo: unknown@alpha.test\r\n\r\nignored",
        envelopeTo: [resolution.address],
      }),
    ).resolves.toEqual([]);
    expect(messages).toEqual([]);
  });

  it("runs each direct SMTP persistence path inside its resolved tenant context", async () => {
    const messages: MailMessageInput[] = [];
    const activeTenants = new Set<string>();
    const entered: string[] = [];
    const store = mailStore(messages);

    await ingestSmtpEnvelope({
      store: {
        ...store,
        async insertInboundMessage(input) {
          expect(activeTenants.has(input.orgId)).toBe(true);
          return store.insertInboundMessage(input);
        },
      },
      resolveRecipient: async (address) =>
        address.endsWith("alpha.test")
          ? { orgId: orgA, actorId: actorA, address }
          : { orgId: orgB, actorId: actorB, address },
      runForTenant: async (orgId, operation) => {
        entered.push(orgId);
        activeTenants.add(orgId);
        try {
          return await operation();
        } finally {
          activeTenants.delete(orgId);
        }
      },
      authenticator: passingAuthenticator,
      raw: "From: sender@example.net\r\nTo: both\r\nSubject: scoped\r\n\r\nbody",
      envelopeTo: ["ada@alpha.test", "bob@beta.test"],
    });

    expect(entered).toEqual(expect.arrayContaining([orgA, orgB]));
    expect(messages).toHaveLength(2);
    expect(activeTenants.size).toBe(0);
  });

  it("stores one canonical message with independent owners for To, Cc, and Bcc", async () => {
    const messages: MailMessageInput[] = [];
    const store = mailStore(messages);
    const recipients = new Map<string, MailInboundRecipient>([
      ["to@alpha.test", { orgId: orgA, actorId: actorA, address: "to@alpha.test" }],
      ["cc@alpha.test", { orgId: orgA, actorId: actorB, address: "cc@alpha.test" }],
      ["hidden@alpha.test", { orgId: orgA, actorId: actorC, address: "hidden@alpha.test" }],
    ]);

    await ingestSmtpEnvelope({
      store,
      resolveRecipient: async (address) => recipients.get(address.toLowerCase()) ?? null,
      authenticator: passingAuthenticator,
      raw: [
        "From: sender@example.net",
        "To: To <to@alpha.test>",
        "Cc: Cc <cc@alpha.test>",
        "Bcc: must-not-leak@alpha.test",
        "Subject: Shared delivery",
        "",
        "one body",
      ].join("\r\n"),
      envelopeFrom: "sender@example.net",
      envelopeTo: ["to@alpha.test", "cc@alpha.test", "hidden@alpha.test"],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      actorId: null,
      mailboxActorIds: [actorA, actorB, actorC],
      to: [{ address: "to@alpha.test", name: "To" }],
      cc: [{ address: "cc@alpha.test", name: "Cc" }],
      bcc: [],
      bodyText: "one body",
    });
    expect(messages[0]?.metadata).not.toHaveProperty("envelopeTo");
    expect(JSON.stringify(messages[0])).not.toContain("hidden@alpha.test");
    expect(JSON.stringify(messages[0])).not.toContain("must-not-leak@alpha.test");
    expect(store.listFilters).toHaveBeenCalledTimes(3);
  });

  it("rejects the entire envelope before persistence when any mailbox is unknown", async () => {
    const messages: MailMessageInput[] = [];
    const store = mailStore(messages);

    await expect(
      ingestSmtpEnvelope({
        store,
        resolveRecipient: async (address) =>
          address === "ada@alpha.test" ? { orgId: orgA, actorId: actorA, address } : null,
        authenticator: passingAuthenticator,
        raw: "From: sender@example.net\r\nTo: Ada <ada@alpha.test>\r\n\r\nhello",
        envelopeTo: ["ada@alpha.test", "missing@beta.test"],
      }),
    ).rejects.toMatchObject({ responseCode: 550 });
    expect(messages).toEqual([]);
  });
});

describe("SMTP RCPT validation", () => {
  it("accepts an active resolved mailbox", async () => {
    const result = await validateRecipient(async (address) => ({
      orgId: orgA,
      actorId: actorA,
      address,
    }));

    expect(result).toBeUndefined();
  });

  it("permanently rejects unknown and disabled mailboxes", async () => {
    const result = await validateRecipient(async () => null);

    expect(result).toMatchObject({ responseCode: 550 });
  });

  it.each([
    ["quota", new MailInboundQuotaExceededError()],
    ["transient policy lookup", new Error("policy backend unavailable")],
  ])("temporarily defers %s failures", async (_label, failure) => {
    const logger = { error: vi.fn() };
    const result = await validateRecipient(async () => Promise.reject(failure), logger);

    expect(result).toMatchObject({ responseCode: 450 });
    expect(result?.message).not.toContain(failure.message);
    expect(logger.error).toHaveBeenCalledWith(failure, "SMTP recipient validation deferred");
  });

  it("refuses DATA and creates no content for an invalid recipient", async () => {
    const messages: MailMessageInput[] = [];
    const receiver = new SmtpMailReceiver({
      store: mailStore(messages),
      resolveRecipient: async () => null,
      authenticator: passingAuthenticator,
      disabledCommands: ["AUTH", "STARTTLS"],
    });
    await receiver.listen(0, "127.0.0.1");
    const bound = receiver.nodeServer.server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("Expected SMTP receiver to bind a TCP port.");
    }
    const transport = createTransport({
      host: "127.0.0.1",
      port: bound.port,
      secure: false,
      ignoreTLS: true,
    });

    try {
      await expect(
        transport.sendMail({
          from: "sender@example.net",
          to: "missing@alpha.test",
          subject: "Must not enter DATA",
          text: "body must not be transferred or stored",
        }),
      ).rejects.toMatchObject({ responseCode: 550 });
      expect(messages).toEqual([]);
    } finally {
      transport.close();
      await receiver.close();
    }
  });

  it("advertises and enforces the maximum DATA size before persistence", async () => {
    const messages: MailMessageInput[] = [];
    const receiver = new SmtpMailReceiver({
      store: mailStore(messages),
      resolveRecipient: async (address) => ({ orgId: orgA, actorId: actorA, address }),
      authenticator: passingAuthenticator,
      disabledCommands: ["AUTH", "STARTTLS"],
      maxMessageBytes: 512,
    });
    await receiver.listen(0, "127.0.0.1");
    const bound = receiver.nodeServer.server.address();
    if (bound === null || typeof bound === "string") {
      throw new Error("Expected SMTP receiver to bind a TCP port.");
    }
    const transport = createTransport({
      host: "127.0.0.1",
      port: bound.port,
      secure: false,
      ignoreTLS: true,
    });

    try {
      await expect(
        transport.sendMail({
          from: "sender@example.net",
          to: "ada@alpha.test",
          subject: "oversized",
          text: "x".repeat(1_024),
        }),
      ).rejects.toMatchObject({ responseCode: 552 });
      expect(messages).toEqual([]);
    } finally {
      transport.close();
      await receiver.close();
    }
  });

  it("rejects recipients above the per-envelope cap", async () => {
    const receiver = new SmtpMailReceiver({
      store: mailStore([]),
      resolveRecipient: async (address) => ({ orgId: orgA, actorId: actorA, address }),
      maxRecipients: 1,
    });
    const result = await new Promise<Error | undefined>((resolve) => {
      receiver.nodeServer.onRcptTo(
        { address: "second@alpha.test", args: {} },
        { envelope: { rcptTo: [{ address: "first@alpha.test", args: {} }] } } as SMTPServerSession,
        (error) => {
          resolve(error ?? undefined);
        },
      );
    });

    expect(result).toMatchObject({ responseCode: 452 });
  });
});

const passingAuthenticator: MailAuthenticator = {
  async authenticate() {
    return { spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" };
  },
};

function validateRecipient(
  resolveRecipient: (address: string) => Promise<MailInboundRecipient | null>,
  logger?: { error(error: unknown, message?: string): void },
): Promise<(Error & { readonly responseCode?: number }) | undefined> {
  const receiver = new SmtpMailReceiver({
    store: mailStore([]),
    resolveRecipient,
    ...(logger === undefined ? {} : { logger }),
  });
  return new Promise((resolve) => {
    receiver.nodeServer.onRcptTo(
      { address: "ada@alpha.test", args: {} },
      { envelope: { rcptTo: [] } } as unknown as SMTPServerSession,
      (error) => {
        resolve(error as (Error & { readonly responseCode?: number }) | undefined);
      },
    );
  });
}

function mailStore(messages: MailMessageInput[]): MailStore {
  return {
    findActorByAddress: vi.fn(),
    async insertInboundMessage(input: MailMessageInput) {
      messages.push(input);
      return {
        threadId: `thread-${String(messages.length)}`,
        messageId: `message-${String(messages.length)}`,
        attachmentObjectIds: [],
        created: true,
        deliveredActorIds: input.mailboxActorIds ?? [],
      };
    },
    listFilters: vi.fn().mockResolvedValue([]),
    getActiveVacation: vi.fn().mockResolvedValue(null),
  } as unknown as MailStore;
}

function recordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray) => {
    calls.push(strings.join("$"));
    return Promise.resolve(queue.shift() ?? []);
  };
  return { sql: tag as unknown as postgres.Sql, calls };
}
