import { describe, expect, it } from "vitest";
import type {
  EventBus,
  EventEnvelope,
  JsonObject,
  JsonValue,
  TraceContext,
  Unsubscribe,
} from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { ingestRawMail, summarizeAuthentication, type MailAuthenticator } from "./ingest.js";
import {
  NodemailerMailTransport,
  OutboundMailDispatcher,
  OutboundMailWorker,
  type OutboundMailTransport,
} from "./outbound.js";
import { registerMailTools } from "./tools.js";
import type {
  CreateMailFilterInput,
  CreateOutboundMailInput,
  MailStore,
  SetMailVacationInput,
  UpdateMailFilterInput,
} from "./store.js";
import type {
  MailFilterRecord,
  MailFolderSummary,
  MailLabelRecord,
  MailMessageInput,
  MailOutboundRecord,
  MailOutboundStatus,
  MailSearchHit,
  MailSearchRequest,
  MailThreadDetail,
  MailThreadGetRequest,
  MailThreadListRequest,
  MailThreadListResult,
  MailThreadRowRecord,
  MailThreadStatePatch,
  MailVacationRecord,
  StoredMailMessage,
} from "./types.js";
import { classifyMailCategory } from "./category.js";

const orgId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const threadId = "00000000-0000-4000-8000-000000000003";
const messageId = "00000000-0000-4000-8000-000000000004";

describe("mail ingest", () => {
  it("summarizes SPF, DKIM, and DMARC evidence from mailauth results", () => {
    const auth = summarizeAuthentication({
      headers: "Authentication-Results: mx.helix.test; spf=pass; dkim=pass; dmarc=pass",
      spf: {
        domain: "example.net",
        "client-ip": "203.0.113.24",
        helo: "mail.example.net",
        "envelope-from": "ada@example.net",
        status: { result: "pass", comment: "sender SPF authorized" },
        rr: "v=spf1 include:mail.example.net -all",
        header: "Received-SPF: pass",
        info: "spf=pass smtp.mailfrom=example.net",
        lookups: { limit: 10, count: 2, void: 0, subqueries: {} },
      },
      dkim: {
        headerFrom: ["example.net"],
        envelopeFrom: "example.net",
        results: [
          {
            signingDomain: "example.net",
            selector: "s1",
            status: { result: "pass", aligned: true },
            info: "dkim=pass header.d=example.net",
            algorithm: "rsa-sha256",
            canonicalization: "relaxed/relaxed",
            signingTime: new Date("2026-05-20T11:59:00.000Z"),
            expiration: new Date("2026-05-21T11:59:00.000Z"),
          },
        ],
      },
      dmarc: {
        domain: "example.net",
        policy: "reject",
        p: "reject",
        sp: "quarantine",
        pct: 100,
        rr: "v=DMARC1; p=reject; pct=100",
        status: { result: "pass" },
        alignment: {
          spf: { result: "example.net", strict: true },
          dkim: { result: "example.net", strict: true },
        },
        info: "dmarc=pass header.from=example.net",
      },
      arc: false,
      bimi: false,
    });

    expect(auth).toMatchObject({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      evidence: {
        spf: {
          domain: "example.net",
          clientIp: "203.0.113.24",
          record: "v=spf1 include:mail.example.net -all",
          lookups: { limit: 10, count: 2, void: 0 },
        },
        dkim: {
          headerFrom: ["example.net"],
          signatures: [
            {
              signingDomain: "example.net",
              selector: "s1",
              aligned: true,
              signingTime: "2026-05-20T11:59:00.000Z",
            },
          ],
        },
        dmarc: {
          domain: "example.net",
          policy: "reject",
          alignment: {
            spf: { result: "example.net", strict: true },
            dkim: { result: "example.net", strict: true },
          },
        },
      },
    });
  });

  it("parses an SMTP message, stores shared primitives, applies filters, and queues vacation", async () => {
    const store = new InMemoryMailStore();
    store.actors.set("alice@example.com", actorId);
    await store.createFilter({
      orgId,
      actorId,
      name: "VIP",
      criteria: { fromContains: "ada@" },
      actions: { applyLabels: ["vip"], archive: true },
    });
    store.vacation = {
      id: "vacation-1",
      orgId,
      actorId,
      enabled: true,
      subject: "Away",
      body: "I am away.",
      startsAt: null,
      endsAt: null,
      metadata: {},
      createdAt: now(),
      updatedAt: now(),
    };

    const result = await ingestRawMail({
      store,
      authenticator: new PassingAuthenticator(),
      input: {
        orgId,
        envelopeFrom: "ada@example.net",
        envelopeTo: ["alice@example.com"],
        raw: [
          "From: Ada <ada@example.net>",
          "To: Alice <alice@example.com>",
          "Subject: Quarterly plan",
          "Message-ID: <plan@example.net>",
          "",
          "Please review the plan.",
        ].join("\r\n"),
        receivedAt: now(),
      },
    });

    expect(result.auth).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass" });
    expect(store.messages[0]?.metadata?.auth).toMatchObject({
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      evidence: {
        spf: { domain: "example.net" },
        dkim: { signatures: [{ signingDomain: "example.net", selector: "s1" }] },
        dmarc: { policy: "reject" },
      },
    });
    expect(result.stored.threadId).toBe(threadId);
    expect(store.messages[0]?.subject).toBe("Quarterly plan");
    expect(store.states.get(`${actorId}:${threadId}`)).toMatchObject({
      labels: ["vip"],
      archivedAt: now(),
    });
    expect(result.filterResult).toEqual({ matchedFilterIds: ["filter-1"], vacationQueued: true });
    expect(store.outbounds[0]?.envelope.subject).toBe("Away");
    expect(store.vacationResponses).toEqual(["vacation-1:ada@example.net"]);

    const duplicateResult = await ingestRawMail({
      store,
      authenticator: new PassingAuthenticator(),
      input: {
        orgId,
        envelopeFrom: "Ada@Example.Net",
        envelopeTo: ["alice@example.com"],
        raw: [
          "From: Ada <Ada@Example.Net>",
          "To: Alice <alice@example.com>",
          "Subject: Follow up",
          "Message-ID: <followup@example.net>",
          "",
          "One more note.",
        ].join("\r\n"),
        receivedAt: now(),
      },
    });

    expect(duplicateResult.filterResult).toEqual({
      matchedFilterIds: ["filter-1"],
      vacationQueued: false,
    });
    expect(store.outbounds).toHaveLength(1);
    expect(store.vacationResponses).toEqual(["vacation-1:ada@example.net"]);
  });
});

describe("outbound mail", () => {
  it("rehydrates JSON-serialized attachment buffers before SMTP dispatch", async () => {
    const sent: unknown[] = [];
    const transport = new NodemailerMailTransport({
      sendMail: async (message: unknown) => {
        sent.push(message);
        return { messageId: "smtp-message-id", response: "250 queued" };
      },
    } as never);

    await transport.send({
      ...envelope(),
      attachments: [
        {
          filename: "invite.ics",
          mimeType: "text/calendar",
          contentType: "text/calendar; method=REQUEST; charset=utf-8",
          content: { type: "Buffer", data: [66, 69, 71, 73, 78] } as never,
        },
      ],
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      attachments: [
        {
          filename: "invite.ics",
          contentType: "text/calendar; method=REQUEST; charset=utf-8",
          content: Buffer.from("BEGIN"),
        },
      ],
    });
  });

  it("does not dispatch before undo-send expires and sends after the delay", async () => {
    const store = new InMemoryMailStore();
    const outbound = await store.createOutbound({
      orgId,
      actorId,
      envelope: envelope(),
      undoUntil: new Date("2026-05-20T12:00:30.000Z"),
      outboxSubject: "mail.send",
    });
    const transport = new RecordingTransport();
    const dispatcher = new OutboundMailDispatcher(store, transport);

    await expect(dispatcher.dispatch(outbound.id)).resolves.toBeNull();
    expect(transport.sent).toEqual([]);

    store.now = new Date("2026-05-20T12:00:31.000Z");
    await expect(dispatcher.dispatch(outbound.id)).resolves.toMatchObject({
      status: "sent",
      providerMessageId: "smtp-message-id",
      deliveryMetadata: { response: "250 queued" },
    });
    expect(transport.sent).toEqual([envelope()]);
  });

  it("subscribes delayed mail.send events to the dispatcher", async () => {
    const store = new InMemoryMailStore();
    const outbound = await store.createOutbound({
      orgId,
      actorId,
      envelope: envelope(),
      undoUntil: now(),
      outboxSubject: "mail.send",
    });
    const transport = new RecordingTransport();
    const events = new FakeEventBus();
    const worker = new OutboundMailWorker({
      events,
      dispatcher: new OutboundMailDispatcher(store, transport),
    });

    await worker.start();
    await events.publish("mail.send", { mailOutboundId: outbound.id });

    expect(transport.sent).toEqual([envelope()]);
    await expect(store.getOutbound(outbound.id)).resolves.toMatchObject({ status: "sent" });

    await worker.stop();
    await events.publish("mail.send", { mailOutboundId: outbound.id });
    expect(transport.sent).toHaveLength(1);
  });

  it("does not dispatch cancelled outbound mail when the delayed event arrives", async () => {
    const store = new InMemoryMailStore();
    const outbound = await store.createOutbound({
      orgId,
      actorId,
      envelope: envelope(),
      undoUntil: new Date("2026-05-20T12:00:30.000Z"),
      outboxSubject: "mail.send",
    });
    await expect(store.cancelOutbound({ orgId, actorId, id: outbound.id })).resolves.toMatchObject({
      status: "cancelled",
    });
    store.now = new Date("2026-05-20T12:00:31.000Z");
    const transport = new RecordingTransport();
    const worker = new OutboundMailWorker({
      events: new FakeEventBus(),
      dispatcher: new OutboundMailDispatcher(store, transport),
    });

    await expect(
      worker.handle({
        subject: "mail.send",
        payload: { mailOutboundId: outbound.id },
        occurredAt: store.now.toISOString(),
      }),
    ).resolves.toBeNull();
    expect(transport.sent).toEqual([]);
  });
});

describe("mail tools", () => {
  it("registers mail tools and invokes filter, label, send, and search operations", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    // mail.inbound.accept is service-only (CRITICAL-4): tests inject a real
    // authenticator implementation that returns deterministic verification
    // *results*, but the auth step itself is never skipped.
    registerMailTools(registry, {
      store,
      defaultFromDomain: "example.com",
      undoWindowMs: 30_000,
      inboundAuthenticator: new NoneAuthenticator(),
    });

    expect(
      registry
        .list()
        .filter((tool) => tool.id.startsWith("mail."))
        .map((tool) => tool.id),
    ).toEqual([
      "mail.alias.create",
      "mail.alias.delete",
      "mail.alias.list",
      "mail.archive",
      "mail.delete",
      "mail.draft.discard",
      "mail.draft.get",
      "mail.draft.list",
      "mail.draft.save",
      "mail.filter.create",
      "mail.filter.delete",
      "mail.filter.list",
      "mail.filter.update",
      "mail.folders.list",
      "mail.inbound.accept",
      "mail.label.apply",
      "mail.labels.list",
      "mail.outbound.cancel",
      "mail.outbound.get",
      "mail.outbound.retry",
      "mail.read.set",
      "mail.reply",
      "mail.search",
      "mail.send",
      "mail.snooze",
      "mail.spam",
      "mail.star.set",
      "mail.thread.get",
      "mail.threads.list",
      "mail.vacation.get",
      "mail.vacation.set",
    ]);

    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Alice",
      email: "alice@example.com",
      // Includes mail.external because this flow sends to bob@example.net,
      // a recipient outside the internal example.com domain (PRD §9.4).
      scopes: ["mail.read", "mail.write", "mail.send", "mail.external"],
    };

    // CRITICAL-4: mail.inbound.accept is gated by the service-only `mail.system`
    // scope AND requires actor.type === "service_account" | "system". The SMTP
    // receiver / bridge presents this token, not a user actor.
    const smtpReceiverActor = {
      id: "00000000-0000-4000-8000-0000000000aa",
      orgId,
      type: "service_account" as const,
      displayName: "SMTP receiver",
      scopes: ["mail.system"],
    };

    store.actors.set("alice@example.com", actorId);

    const inboundResult = await registry.invoke(
      "mail.inbound.accept",
      {
        messageId: "<inbound-tool@example.test>",
        from: { address: "sender@example.test", name: "Sender" },
        to: ["alice@example.com"],
        subject: "Inbound tool probe",
        bodyText: "Inbound tool marker",
        receivedAt: "2026-05-20T12:00:00.000Z",
      },
      { actor: smtpReceiverActor },
    );
    expect(inboundResult).toMatchObject({
      ok: true,
      output: {
        ok: true,
        threadId,
        messageId,
        subject: "Inbound tool probe",
        auth: { spf: "none", dkim: "none", dmarc: "none", arc: "none" },
      },
    });
    expect(store.messages[0]).toMatchObject({
      actorId,
      subject: "Inbound tool probe",
      bodyText: expect.stringContaining("Inbound tool marker") as string,
      messageId: "<inbound-tool@example.test>",
      metadata: {
        direction: "inbound",
        envelopeFrom: "sender@example.test",
        envelopeTo: ["alice@example.com"],
      },
    });

    await expect(
      registry.invoke(
        "mail.filter.create",
        {
          name: "Plans",
          criteria: { subjectContains: "plan" },
          actions: { applyLabels: ["plan"] },
        },
        { actor },
      ),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      registry.invoke(
        "mail.label.apply",
        {
          threadId,
          add: ["plan"],
        },
        { actor },
      ),
    ).resolves.toEqual({ ok: true, output: { ok: true, threadId } });

    const sendResult = await registry.invoke(
      "mail.send",
      {
        to: ["bob@example.net"],
        subject: "Hi",
        bodyText: "Hello",
      },
      { actor },
    );
    expect(sendResult.ok).toBe(true);
    expect(store.outbounds[0]?.envelope.from).toEqual({
      address: "alice@example.com",
      name: "Alice",
    });
    await expect(
      registry.invoke("mail.outbound.get", { id: store.outbounds[0]?.id }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { outbound: { status: "queued", providerMessageId: null } },
    });

    store.searchHits = [
      {
        threadId,
        messageId,
        subject: "Quarterly plan",
        preview: "Please review",
        sentAt: now(),
        labels: ["plan"],
        unread: true,
        starred: true,
      },
    ];
    await expect(
      registry.invoke("mail.search", { query: "plan" }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { hits: [{ threadId, subject: "Quarterly plan" }] },
    });

    store.thread = {
      id: threadId,
      subject: "Quarterly plan",
      preview: "Please review",
      participants: [{ address: "alice@example.com", name: "Alice" }],
      messages: [
        {
          id: messageId,
          from: { address: "alice@example.com", name: "Alice" },
          to: [{ address: "bob@example.net" }],
          cc: [],
          bcc: [],
          sentAt: now(),
          body: "Please review",
          bodyFormat: "plain",
          hasAttachment: false,
          attachments: [],
        },
      ],
      labels: ["plan"],
      archivedAt: null,
      deletedAt: null,
      snoozedUntil: null,
      lastActivity: now(),
      unread: false,
      starred: false,
      direction: "inbound",
    };
    await expect(
      registry.invoke("mail.thread.get", { threadId }, { actor }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        thread: {
          id: threadId,
          messages: [{ id: messageId, sentAt: "2026-05-20T12:00:00.000Z" }],
        },
      },
    });

    await expect(
      registry.invoke("mail.read.set", { threadId, unread: false }, { actor }),
    ).resolves.toEqual({ ok: true, output: { ok: true, threadId, unread: false } });
    await expect(
      registry.invoke("mail.star.set", { threadId, starred: true }, { actor }),
    ).resolves.toEqual({ ok: true, output: { ok: true, threadId, starred: true } });
    await expect(
      registry.invoke("mail.snooze", { threadId, until: "2026-05-21T12:00:00.000Z" }, { actor }),
    ).resolves.toEqual({
      ok: true,
      output: { ok: true, threadId, snoozedUntil: "2026-05-21T12:00:00.000Z" },
    });
    expect(store.states.get(`${actorId}:${threadId}`)).toMatchObject({
      readAt: expect.any(Date) as Date,
      starred: true,
      snoozedUntil: new Date("2026-05-21T12:00:00.000Z"),
    });

    await expect(registry.invoke("mail.vacation.get", {}, { actor })).resolves.toEqual({
      ok: true,
      output: { vacation: null },
    });
    await expect(
      registry.invoke(
        "mail.vacation.set",
        {
          enabled: true,
          subject: "Away",
          body: "I am away until Monday.",
          startsAt: "2026-05-21T00:00:00.000Z",
          endsAt: "2026-05-25T00:00:00.000Z",
          metadata: { reason: "pto" },
        },
        { actor },
      ),
    ).resolves.toEqual({
      ok: true,
      output: {
        vacation: {
          id: "vacation-1",
          enabled: true,
          subject: "Away",
          body: "I am away until Monday.",
          startsAt: "2026-05-21T00:00:00.000Z",
          endsAt: "2026-05-25T00:00:00.000Z",
          metadata: { reason: "pto" },
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        },
      },
    });
    await expect(registry.invoke("mail.vacation.get", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { vacation: { id: "vacation-1", enabled: true, subject: "Away" } },
    });
  });

  it("enforces the mail.external composite scope for external recipients (PRD §9.4)", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    registerMailTools(registry, {
      store,
      defaultFromDomain: "example.com",
      internalDomains: ["example.com", "internal.example.com"],
      undoWindowMs: 30_000,
    });

    const internalActor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Alice",
      email: "alice@example.com",
      scopes: ["mail.send"],
    };
    const externalActor = { ...internalActor, scopes: ["mail.send", "mail.external"] };

    // Internal-only send succeeds with just mail.send.
    await expect(
      registry.invoke(
        "mail.send",
        { to: ["bob@internal.example.com"], subject: "Hi", bodyText: "Hello" },
        { actor: internalActor },
      ),
    ).resolves.toMatchObject({ ok: true });

    // Sending to an external domain without mail.external is denied.
    const denied = await registry.invoke(
      "mail.send",
      { to: ["partner@outside.test"], subject: "Hi", bodyText: "Hello" },
      { actor: internalActor },
    );
    expect(denied).toMatchObject({ ok: false, statusCode: 403 });
    expect(denied.ok ? "" : denied.error).toContain("mail.external");

    // A cc recipient outside the org also trips enforcement.
    const deniedViaCc = await registry.invoke(
      "mail.send",
      {
        to: ["bob@example.com"],
        cc: ["partner@outside.test"],
        subject: "Hi",
        bodyText: "Hello",
      },
      { actor: internalActor },
    );
    expect(deniedViaCc).toMatchObject({ ok: false, statusCode: 403 });

    // With mail.external held, the external send is allowed.
    await expect(
      registry.invoke(
        "mail.send",
        { to: ["partner@outside.test"], subject: "Hi", bodyText: "Hello" },
        { actor: externalActor },
      ),
    ).resolves.toMatchObject({ ok: true });

    // mail.reply enforces the same composition.
    const repliedDenied = await registry.invoke(
      "mail.reply",
      {
        threadId: "00000000-0000-4000-8000-0000000000aa",
        to: ["partner@outside.test"],
        bodyText: "Re",
      },
      { actor: internalActor },
    );
    expect(repliedDenied).toMatchObject({ ok: false, statusCode: 403 });
  });

  // REVIEW.md CRITICAL-4: mail.inbound.accept used to be `mail.write` + a
  // hard-coded `trustedBridge` authentication summary that faked SPF/DKIM/
  // DMARC as `none`. Any user with `mail.write` could inject "trusted" mail
  // from any sender into any actor's inbox. The three tests below pin the
  // hardened contract:
  //   1. user-space scopes (mail.write/send/external) cannot invoke the tool;
  //   2. a service-account actor with `mail.system` is accepted;
  //   3. a DKIM/DMARC fail verdict is persisted on the stored message so
  //      downstream spam routing / UI can refuse to trust the From header.
  it("rejects mail.inbound.accept callers without the service-only mail.system scope (CRITICAL-4)", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    registerMailTools(registry, {
      store,
      defaultFromDomain: "example.com",
      inboundAuthenticator: new NoneAuthenticator(),
    });

    const userActor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Alice",
      email: "alice@example.com",
      // Every user-space mail scope — none of which should be sufficient.
      scopes: ["mail.read", "mail.write", "mail.send", "mail.external", "mail.delete"],
    };

    const denied = await registry.invoke(
      "mail.inbound.accept",
      {
        from: { address: "attacker@example.test" },
        to: ["alice@example.com"],
        subject: "Spoofed",
        bodyText: "I am not from where the From header says.",
      },
      { actor: userActor },
    );
    expect(denied).toMatchObject({ ok: false, statusCode: 403 });
    // The registry rejects any actor that lacks the `mail.system` scope — the
    // error message is the generic "Actor cannot invoke tool" envelope, which
    // is what we care about: the call is blocked, nothing got written.
    expect(denied.ok).toBe(false);
    expect(store.messages).toEqual([]);
  });

  it("accepts mail.inbound.accept from a service-account actor holding mail.system (CRITICAL-4)", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    registerMailTools(registry, {
      store,
      defaultFromDomain: "example.com",
      inboundAuthenticator: new PassingAuthenticator(),
    });
    store.actors.set("alice@example.com", actorId);

    const serviceActor = {
      id: "00000000-0000-4000-8000-0000000000aa",
      orgId,
      type: "service_account" as const,
      displayName: "SMTP receiver",
      scopes: ["mail.system"],
    };

    const result = await registry.invoke(
      "mail.inbound.accept",
      {
        from: { address: "sender@example.net" },
        to: ["alice@example.com"],
        subject: "Hello",
        bodyText: "Body",
        receivedAt: "2026-05-20T12:00:00.000Z",
      },
      { actor: serviceActor },
    );
    expect(result).toMatchObject({
      ok: true,
      output: {
        ok: true,
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      },
    });
    expect(store.messages[0]).toMatchObject({
      actorId,
      subject: "Hello",
      metadata: {
        auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      },
    });
  });

  it("rejects mail.inbound.accept from a non-service actor even with mail.system scope", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    registerMailTools(registry, {
      store,
      defaultFromDomain: "example.com",
      inboundAuthenticator: new NoneAuthenticator(),
    });

    // A user actor that has *somehow* been granted mail.system (e.g. a
    // misconfigured app-password issuance bypassing the surface allowlist)
    // must still be rejected — defence-in-depth on actor.type.
    const userActorWithSystem = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Mallory",
      scopes: ["mail.system"],
    };

    await expect(
      registry.invoke(
        "mail.inbound.accept",
        {
          from: { address: "anyone@example.test" },
          to: ["alice@example.com"],
          subject: "Spoofed",
          bodyText: "Body",
        },
        { actor: userActorWithSystem },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("service-account") as string,
    });
    expect(store.messages).toEqual([]);
  });

  it("persists DKIM/DMARC-fail verification verdicts on stored inbound mail (CRITICAL-4)", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    registerMailTools(registry, {
      store,
      defaultFromDomain: "example.com",
      inboundAuthenticator: new DkimFailAuthenticator(),
    });
    store.actors.set("alice@example.com", actorId);

    const serviceActor = {
      id: "00000000-0000-4000-8000-0000000000aa",
      orgId,
      type: "service_account" as const,
      displayName: "SMTP receiver",
      scopes: ["mail.system"],
    };

    const result = await registry.invoke(
      "mail.inbound.accept",
      {
        from: { address: "spoof@example.test", name: "Spoof" },
        to: ["alice@example.com"],
        subject: "Forged",
        bodyText: "DKIM signature did not verify.",
      },
      { actor: serviceActor },
    );
    // The message is still accepted — but the failure verdict is recorded so
    // downstream spam/quarantine and the UI can refuse to display the message
    // as authenticated.
    expect(result).toMatchObject({
      ok: true,
      output: {
        ok: true,
        auth: { spf: "pass", dkim: "fail", dmarc: "fail" },
      },
    });
    expect(store.messages[0]).toMatchObject({
      subject: "Forged",
      metadata: {
        direction: "inbound",
        auth: {
          spf: "pass",
          dkim: "fail",
          dmarc: "fail",
          evidence: {
            dmarc: { result: "fail", policy: "reject" },
          },
        },
      },
    });
  });

  it("registers mail.threads.list / mail.folders.list / mail.labels.list as read-safe tools", () => {
    const registry = createToolRegistry();
    registerMailTools(registry, { store: new InMemoryMailStore() });

    for (const id of ["mail.threads.list", "mail.folders.list", "mail.labels.list"]) {
      expect(registry.get(id)).toMatchObject({
        id,
        permission: "mail.read",
        sideEffects: "read",
      });
      expect(registry.get(id)?.confirmationRequired).toBeUndefined();
    }
  });

  it("lists threads for a folder, applying tab/label/query filters and pagination", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    registerMailTools(registry, { store });

    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Alice",
      email: "alice@example.com",
      scopes: ["mail.read"],
    };

    const baseRow: MailThreadRowRecord = {
      threadId,
      messageId,
      subject: "Q3 roadmap",
      from: "Mira Okafor",
      fromEmail: "mira@helix.io",
      preview: "Roadmap sign-off",
      time: "2026-05-20T10:42:00.000Z",
      unread: true,
      starred: true,
      hasAttachment: true,
      messageCount: 3,
      labels: ["team"],
      category: "primary",
      folder: "inbox",
      snoozedUntil: null,
    };
    store.threadRows = [
      baseRow,
      {
        ...baseRow,
        threadId: "00000000-0000-4000-8000-0000000000b1",
        subject: "GitHub PR merged",
        preview: "daniel-cho merged a pull request",
        labels: [],
        category: "updates",
      },
      {
        ...baseRow,
        threadId: "00000000-0000-4000-8000-0000000000b2",
        subject: "Archived note",
        folder: "archive",
      },
    ];

    type ThreadsOutput = {
      readonly threads: readonly { readonly subject: string; readonly category: string }[];
      readonly total: number;
      readonly limit: number;
      readonly offset: number;
    };

    const inbox = await registry.invoke<ThreadsOutput>(
      "mail.threads.list",
      { folder: "inbox" },
      { actor },
    );
    expect(inbox).toMatchObject({ ok: true, output: { total: 2, limit: 50, offset: 0 } });
    expect(inbox.ok && inbox.output.threads).toHaveLength(2);

    const updatesTab = await registry.invoke<ThreadsOutput>(
      "mail.threads.list",
      { folder: "inbox", tab: "updates" },
      { actor },
    );
    expect(updatesTab.ok && updatesTab.output.threads).toEqual([
      expect.objectContaining({ subject: "GitHub PR merged", category: "updates" }),
    ]);

    const teamLabel = await registry.invoke<ThreadsOutput>(
      "mail.threads.list",
      { folder: "inbox", label: "team" },
      { actor },
    );
    expect(teamLabel.ok && teamLabel.output.total).toBe(1);

    const queried = await registry.invoke<ThreadsOutput>(
      "mail.threads.list",
      { folder: "inbox", query: "roadmap" },
      { actor },
    );
    expect(queried.ok && queried.output.total).toBe(1);

    const archive = await registry.invoke<ThreadsOutput>(
      "mail.threads.list",
      { folder: "archive" },
      { actor },
    );
    expect(archive.ok && archive.output.total).toBe(1);
  });

  it("lists folders with counts and labels with colours", async () => {
    const store = new InMemoryMailStore();
    const registry = createToolRegistry();
    registerMailTools(registry, { store });

    const actor = {
      id: actorId,
      orgId,
      type: "user" as const,
      displayName: "Alice",
      email: "alice@example.com",
      scopes: ["mail.read"],
    };

    store.folders = [
      { id: "inbox", label: "Inbox", total: 24, unread: 6 },
      { id: "starred", label: "Starred", total: 7, unread: 0 },
    ];
    store.labels = [
      {
        id: "00000000-0000-4000-8000-0000000000c1",
        orgId,
        ownerActorId: null,
        slug: "team",
        name: "Team",
        color: "#7c3aed",
        sortOrder: 10,
        threadCount: 4,
        createdAt: now(),
        updatedAt: now(),
      },
    ];

    const folders = await registry.invoke("mail.folders.list", {}, { actor });
    expect(folders).toMatchObject({
      ok: true,
      output: {
        folders: [
          { id: "inbox", total: 24, unread: 6 },
          { id: "starred", total: 7 },
        ],
      },
    });

    const labels = await registry.invoke("mail.labels.list", {}, { actor });
    expect(labels).toMatchObject({
      ok: true,
      output: {
        labels: [{ slug: "team", name: "Team", color: "#7c3aed", threadCount: 4, shared: true }],
      },
    });
  });
});

describe("mail category classification", () => {
  it("buckets senders into Primary / Updates / Promotions / Social", () => {
    expect(classifyMailCategory({ fromAddress: "mira@helix.io", subject: "Q3 roadmap" })).toBe(
      "primary",
    );
    expect(
      classifyMailCategory({ fromAddress: "notifications@github.com", subject: "PR merged" }),
    ).toBe("updates");
    expect(classifyMailCategory({ fromAddress: "no-reply@helix.io", subject: "Receipt" })).toBe(
      "updates",
    );
    expect(
      classifyMailCategory({ fromAddress: "hello@figma.com", subject: "Config 2026 — early bird" }),
    ).toBe("primary");
    expect(
      classifyMailCategory({
        fromAddress: "hello@figma.com",
        subject: "Config 2026 — early bird",
        hasListUnsubscribe: true,
      }),
    ).toBe("promotions");
    expect(
      classifyMailCategory({ fromAddress: "notify@linkedin.com", subject: "5 profile views" }),
    ).toBe("social");
  });
});

class PassingAuthenticator implements MailAuthenticator {
  async authenticate() {
    return {
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      arc: "none",
      evidence: {
        spf: { domain: "example.net" },
        dkim: { signatures: [{ signingDomain: "example.net", selector: "s1" }] },
        dmarc: { policy: "reject" },
      },
    };
  }
}

// All-`none` authenticator for tests that don't care about the SPF/DKIM/DMARC
// verdict but DO require the verification step to run. Distinct from the
// removed `trustedInboundAuthenticator` (which carried a `trustedBridge: true`
// flag implying the caller had already done auth — never true).
class NoneAuthenticator implements MailAuthenticator {
  async authenticate() {
    return {
      spf: "none",
      dkim: "none",
      dmarc: "none",
      arc: "none",
      evidence: { source: "test:NoneAuthenticator" },
    };
  }
}

class DkimFailAuthenticator implements MailAuthenticator {
  async authenticate() {
    return {
      spf: "pass",
      dkim: "fail",
      dmarc: "fail",
      arc: "none",
      evidence: {
        spf: { result: "pass", domain: "example.test" },
        dkim: {
          result: "fail",
          signatures: [
            {
              result: "fail",
              signingDomain: "example.test",
              selector: "s1",
              comment: "signature did not verify",
            },
          ],
        },
        dmarc: { result: "fail", policy: "reject", domain: "example.test" },
      },
    };
  }
}

class RecordingTransport implements OutboundMailTransport {
  readonly sent: ReturnType<typeof envelope>[] = [];

  async send(message: ReturnType<typeof envelope>) {
    this.sent.push(message);
    return {
      providerMessageId: "smtp-message-id",
      deliveryMetadata: {
        accepted: ["bob@example.net"],
        rejected: [],
        response: "250 queued",
      },
    };
  }
}

class FakeEventBus implements EventBus {
  readonly handlers = new Map<string, (event: EventEnvelope) => Promise<void>>();

  async publish(subject: string, payload: JsonValue, trace?: TraceContext): Promise<void> {
    const handler = this.handlers.get(subject);
    if (handler === undefined) {
      return;
    }
    await handler({
      subject,
      payload,
      ...(trace === undefined ? {} : { trace }),
      occurredAt: now().toISOString(),
    });
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    this.handlers.set(subject, handler as (event: EventEnvelope) => Promise<void>);
    return async () => {
      this.handlers.delete(subject);
    };
  }
}

class InMemoryMailStore implements MailStore {
  readonly actors = new Map<string, string>();
  readonly messages: MailMessageInput[] = [];
  readonly filters: MailFilterRecord[] = [];
  readonly states = new Map<
    string,
    {
      labels: string[];
      archivedAt?: Date;
      deletedAt?: Date;
      snoozedUntil?: Date;
      readAt?: Date | null;
      starred?: boolean;
    }
  >();
  readonly outbounds: MailOutboundRecord[] = [];
  readonly vacationResponses: string[] = [];
  vacation: MailVacationRecord | null = null;
  searchHits: MailSearchHit[] = [];
  thread: MailThreadDetail | null = null;
  now = now();

  async findActorByAddress(_orgId: string, address: string) {
    const normalized = address.toLowerCase();
    const id = this.actors.get(normalized);
    return id === undefined ? null : { actorId: id, email: normalized };
  }

  async insertInboundMessage(input: MailMessageInput): Promise<StoredMailMessage> {
    this.messages.push(input);
    return { threadId, messageId, attachmentObjectIds: [] };
  }

  async createOutbound(input: CreateOutboundMailInput): Promise<MailOutboundRecord> {
    const outbound: MailOutboundRecord = {
      id: `outbound-${String(this.outbounds.length + 1)}`,
      orgId: input.orgId,
      actorId: input.actorId,
      messageId,
      threadId: input.threadId ?? threadId,
      outboxId: `outbox-${String(this.outbounds.length + 1)}`,
      status: "queued",
      envelope: input.envelope,
      undoUntil: input.undoUntil,
      sentAt: null,
      cancelledAt: null,
      failedAt: null,
      lastError: null,
      providerMessageId: null,
      deliveryMetadata: {},
      createdAt: this.now,
      updatedAt: this.now,
    };
    this.outbounds.push(outbound);
    return outbound;
  }

  async getOutbound(id: string) {
    return this.outbounds.find((outbound) => outbound.id === id) ?? null;
  }

  async markOutboundSending(id: string) {
    return this.updateOutbound(id, (outbound) =>
      outbound.status === "queued" && outbound.undoUntil <= this.now
        ? { ...outbound, status: "sending" }
        : null,
    );
  }

  async markOutboundSent(input: {
    readonly id: string;
    readonly sentAt?: Date;
    readonly providerMessageId?: string;
    readonly deliveryMetadata?: JsonObject;
  }) {
    return this.updateOutbound(input.id, (outbound) => ({
      ...outbound,
      status: "sent",
      sentAt: input.sentAt ?? this.now,
      lastError: null,
      providerMessageId: input.providerMessageId ?? null,
      deliveryMetadata: input.deliveryMetadata ?? {},
    }));
  }

  async markOutboundFailed(id: string, error: string, failedAt: Date = this.now) {
    return this.updateOutbound(id, (outbound) => ({
      ...outbound,
      status: "failed",
      failedAt,
      lastError: error,
    }));
  }

  async cancelOutbound(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }) {
    return this.updateOutbound(input.id, (outbound) =>
      outbound.orgId === input.orgId &&
      outbound.actorId === input.actorId &&
      outbound.status === "queued" &&
      outbound.undoUntil > this.now
        ? { ...outbound, status: "cancelled", cancelledAt: this.now }
        : null,
    );
  }

  async updateThreadState(input: {
    readonly actorId: string;
    readonly threadId: string;
    readonly patch: MailThreadStatePatch;
  }): Promise<void> {
    const key = `${input.actorId}:${input.threadId}`;
    const current = this.states.get(key) ?? { labels: [] };
    const labels = new Set(current.labels);
    for (const label of input.patch.addLabels ?? []) {
      labels.add(label);
    }
    for (const label of input.patch.removeLabels ?? []) {
      labels.delete(label);
    }
    this.states.set(key, {
      labels: [...labels].sort(),
      ...(input.patch.archivedAt === undefined
        ? current.archivedAt === undefined
          ? {}
          : { archivedAt: current.archivedAt }
        : { archivedAt: input.patch.archivedAt ?? undefined }),
      ...(input.patch.deletedAt === undefined
        ? current.deletedAt === undefined
          ? {}
          : { deletedAt: current.deletedAt }
        : { deletedAt: input.patch.deletedAt ?? undefined }),
      ...(input.patch.snoozedUntil === undefined
        ? current.snoozedUntil === undefined
          ? {}
          : { snoozedUntil: current.snoozedUntil }
        : { snoozedUntil: input.patch.snoozedUntil ?? undefined }),
      ...(input.patch.readAt === undefined
        ? current.readAt === undefined
          ? {}
          : { readAt: current.readAt }
        : { readAt: input.patch.readAt }),
      ...(input.patch.starred === undefined
        ? current.starred === undefined
          ? {}
          : { starred: current.starred }
        : { starred: input.patch.starred }),
    });
  }

  async createFilter(input: CreateMailFilterInput): Promise<MailFilterRecord> {
    const filter = {
      id: `filter-${String(this.filters.length + 1)}`,
      orgId: input.orgId,
      actorId: input.actorId,
      name: input.name,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      criteria: input.criteria,
      actions: input.actions,
      createdAt: now(),
      updatedAt: now(),
    };
    this.filters.push(filter);
    return filter;
  }

  async updateFilter(input: UpdateMailFilterInput) {
    const index = this.filters.findIndex((filter) => filter.id === input.id);
    if (index < 0) {
      return null;
    }
    const current = this.filters[index];
    if (current === undefined) {
      return null;
    }
    const updated: MailFilterRecord = {
      ...current,
      ...(input.patch.name === undefined ? {} : { name: input.patch.name }),
      ...(input.patch.enabled === undefined ? {} : { enabled: input.patch.enabled }),
      ...(input.patch.priority === undefined ? {} : { priority: input.patch.priority }),
      ...(input.patch.criteria === undefined ? {} : { criteria: input.patch.criteria }),
      ...(input.patch.actions === undefined ? {} : { actions: input.patch.actions }),
      updatedAt: now(),
    };
    this.filters[index] = updated;
    return updated;
  }

  async deleteFilter(input: { readonly id: string }) {
    const index = this.filters.findIndex((filter) => filter.id === input.id);
    if (index < 0) {
      return false;
    }
    this.filters.splice(index, 1);
    return true;
  }

  async listFilters(_orgId: string, actorIdValue: string) {
    return this.filters
      .filter((filter) => filter.actorId === actorIdValue)
      .sort((left, right) => left.priority - right.priority);
  }

  async getVacation(_orgId: string, actorIdValue: string) {
    return this.vacation?.actorId === actorIdValue ? this.vacation : null;
  }

  async setVacation(input: SetMailVacationInput) {
    const vacation: MailVacationRecord = {
      id: this.vacation?.id ?? "vacation-1",
      orgId: input.orgId,
      actorId: input.actorId,
      enabled: input.enabled,
      subject: input.subject,
      body: input.body,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      metadata: input.metadata,
      createdAt: this.vacation?.createdAt ?? now(),
      updatedAt: now(),
    };
    this.vacation = vacation;
    return vacation;
  }

  async getActiveVacation() {
    return this.vacation;
  }

  async hasVacationResponse(input: { readonly vacationId: string; readonly senderEmail: string }) {
    return this.vacationResponses.includes(
      `${input.vacationId}:${input.senderEmail.toLowerCase()}`,
    );
  }

  async recordVacationResponse(input: {
    readonly vacationId: string;
    readonly senderEmail: string;
  }) {
    const key = `${input.vacationId}:${input.senderEmail.toLowerCase()}`;
    if (this.vacationResponses.includes(key)) {
      return false;
    }
    this.vacationResponses.push(key);
    return true;
  }

  async search(input: MailSearchRequest) {
    return this.searchHits.filter(
      (hit) =>
        input.query === undefined || hit.subject.toLowerCase().includes(input.query.toLowerCase()),
    );
  }

  async getThread(input: MailThreadGetRequest) {
    return this.thread?.id === input.threadId ? this.thread : null;
  }

  threadRows: MailThreadRowRecord[] = [];
  folders: MailFolderSummary[] = [];
  labels: MailLabelRecord[] = [];

  async listThreads(input: MailThreadListRequest): Promise<MailThreadListResult> {
    const folder = input.folder ?? "inbox";
    const matched = this.threadRows.filter(
      (row) =>
        row.folder === folder &&
        (input.tab === undefined || row.category === input.tab) &&
        (input.label === undefined || row.labels.includes(input.label)) &&
        (input.query === undefined ||
          row.subject.toLowerCase().includes(input.query.toLowerCase()) ||
          row.preview.toLowerCase().includes(input.query.toLowerCase())),
    );
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;
    return {
      threads: matched.slice(offset, offset + limit),
      total: matched.length,
      limit,
      offset,
    };
  }

  async listFolders(): Promise<readonly MailFolderSummary[]> {
    return this.folders;
  }

  async listLabels(): Promise<readonly MailLabelRecord[]> {
    return this.labels;
  }

  private updateOutbound(
    id: string,
    updater: (
      outbound: MailOutboundRecord,
    ) => (MailOutboundRecord & { readonly status: MailOutboundStatus }) | null,
  ): MailOutboundRecord | null {
    const index = this.outbounds.findIndex((outbound) => outbound.id === id);
    if (index < 0) {
      return null;
    }
    const current = this.outbounds[index];
    if (current === undefined) {
      return null;
    }
    const updated = updater(current);
    if (updated === null) {
      return null;
    }
    this.outbounds[index] = updated;
    return updated;
  }
}

function envelope() {
  return {
    from: { address: "alice@example.com" },
    to: [{ address: "bob@example.net" }],
    cc: [],
    bcc: [],
    subject: "Hi",
    text: "Hello",
    attachments: [],
  };
}

function now(): Date {
  return new Date("2026-05-20T12:00:00.000Z");
}

describe("SMTP span coverage (P2-6)", () => {
  it("emits an smtp.receive span for inbound mail ingestion", async () => {
    const { installSpanCapture } = await import("../observability/span-testing.js");
    const harness = installSpanCapture();
    try {
      const store = new InMemoryMailStore();
      store.actors.set("alice@example.com", actorId);
      await ingestRawMail({
        store,
        authenticator: new PassingAuthenticator(),
        input: {
          orgId,
          envelopeFrom: "ada@example.net",
          envelopeTo: ["alice@example.com"],
          raw: [
            "From: Ada <ada@example.net>",
            "To: Alice <alice@example.com>",
            "Subject: Span test",
            "Message-ID: <span@example.net>",
            "",
            "Body.",
          ].join("\r\n"),
          receivedAt: now(),
        },
      });
      const span = harness.spans().find((candidate) => candidate.name === "smtp.receive");
      expect(span).toBeDefined();
      expect(span?.attributes["helix.mail.org_id"]).toBe(orgId);
      expect(span?.attributes["helix.mail.auth_spf"]).toBe("pass");
    } finally {
      await harness.dispose();
    }
  });

  it("emits an smtp.send span for outbound dispatch", async () => {
    const { installSpanCapture } = await import("../observability/span-testing.js");
    const harness = installSpanCapture();
    try {
      const store = new InMemoryMailStore();
      const outbound = await store.createOutbound({
        orgId,
        actorId,
        envelope: envelope(),
        undoUntil: new Date("2026-05-20T00:00:00.000Z"),
        outboxSubject: "mail.send",
      });
      await new OutboundMailDispatcher(store, new RecordingTransport()).dispatch(outbound.id);
      const span = harness.spans().find((candidate) => candidate.name === "smtp.send");
      expect(span).toBeDefined();
      expect(span?.attributes["helix.mail.delivery_status"]).toBe("sent");
    } finally {
      await harness.dispose();
    }
  });
});
