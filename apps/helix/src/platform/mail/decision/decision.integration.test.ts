import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../../test-support/live-suite.js";
import { InMemoryEventBus } from "../../events/in-memory-event-bus.js";
import { createOutboundHttpClient } from "../../outbound-http.js";
import { OutboxWorker, type OutboxStore } from "../../outbox/outbox.js";
import { TenantEnvelopeCipher } from "../../secrets/envelope.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { PostgresMailStore } from "../store.js";
import type { MailMessageInput } from "../types.js";
import { DECISION_MODEL_FLAG, resolveDecisionModelConfig } from "./config.js";
import { createDecisionModelProvider } from "./providers.js";
import { buildDecisionModelReport } from "./report.js";
import { PostgresMailDecisionStore } from "./store.js";
import { MailDecisionWorker } from "./worker.js";

/**
 * End to end against a migrated database and the runtime role: an inbound
 * message is stored through the mail store, its outbox event drives the
 * decision worker, a local mock System One server answers, and enforce mode
 * files the thread into Spam for every recipient under RLS.
 */

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip =
  skipUnlessLiveDatabase("Mail decision model through the runtime database role") ||
  adminUrl === undefined ||
  appUrl === undefined;

interface MockCall {
  readonly authorization: string | undefined;
  readonly body: {
    readonly model: string;
    readonly state: string;
    readonly questions: Record<string, { readonly type: string; readonly instructions: string }>;
  };
}

function startMockSystemOne(calls: MockCall[]): Promise<Server> {
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as MockCall["body"];
      calls.push({ authorization: request.headers.authorization, body });
      if (
        request.url !== "/v1/systemone" ||
        request.headers.authorization !== "Bearer jev-test-key"
      ) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ detail: { error_type: "authentication_error", message: "bad" } }),
        );
        return;
      }
      const spammy = body.state.includes("WIN A FREE");
      response.writeHead(200, {
        "content-type": "application/json",
        "x-typesafe-request-id": "r1",
      });
      response.end(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            verdict: {
              type: "choice",
              choice: spammy ? "spam" : "legitimate",
              confidence: 0.5,
              probabilities: spammy
                ? { legitimate: 0.02, spam: 0.96, phishing: 0.01, scam: 0.01 }
                : { legitimate: 0.95, spam: 0.03, phishing: 0.01, scam: 0.01 },
            },
            category: {
              type: "choice",
              choice: "promotions",
              confidence: 0.5,
              probabilities: { primary: 0.1, updates: 0.1, promotions: 0.7, social: 0.1 },
            },
            needs_reply: { type: "noul", noul: 0.1 },
            urgency: {
              type: "score",
              score: 0.2,
              confidence: 0.5,
              legend: { "0": "can wait", "1": "this week", "2": "today" },
              probabilities: { "0": 0.8, "1": 0.15, "2": 0.05 },
            },
          },
          usage: { input_tokens: 512, output_tokens: 3 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}

describe.skipIf(skip)("mail decision model (live database)", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 3 }));
  const mailStore = new PostgresMailStore(app);
  const cipher = new TenantEnvelopeCipher("decision-model-integration-test-master-secret");
  const decisionStore = new PostgresMailDecisionStore(app, cipher);
  const events = new InMemoryEventBus();
  const calls: MockCall[] = [];
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const carol = randomUUID();
  let server: Server;
  let worker: MailDecisionWorker;
  let outbox: OutboxWorker;

  const inTenant = <T>(tenant: string, operation: () => Promise<T>, actorId?: string) =>
    withTenantPostgresContext(
      app,
      { orgId: tenant, ...(actorId === undefined ? {} : { actorId }) },
      () => operation(),
    );

  async function setFlags(settings: Record<string, string | number | boolean>): Promise<void> {
    await admin`
      update orgs set feature_flags = feature_flags || ${admin.json({ [DECISION_MODEL_FLAG]: settings })}
      where id = ${orgId}
    `;
  }

  async function receive(subject: string, body: string, messageId: string) {
    const input: MailMessageInput = {
      orgId,
      actorId: null,
      mailboxActorIds: [alice, bob],
      providerDeliveryId: messageId,
      messageId,
      from: { address: "promo@sender.example", name: "Sender" },
      to: [{ address: "alice@acme.test" }, { address: "bob@acme.test" }],
      subject,
      bodyText: body,
      metadata: {
        direction: "inbound",
        auth: { spf: "pass", dkim: "none", dmarc: "none", arc: "none" },
        spam: { routedToSpam: false, catcher: null, score: 3.1, isSpam: false, symbols: ["FREE"] },
      },
    };
    const stored = await inTenant(orgId, () => mailStore.insertInboundMessage(input));
    // Drain this tenant's outbox through the real OutboxWorker into the event bus.
    await outbox.drainOnce();
    await worker.idle();
    return stored;
  }

  beforeAll(async () => {
    server = await startMockSystemOne(calls);
    const port = (server.address() as AddressInfo).port;
    await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, ${orgId}, 'Decision model'), (${otherOrgId}, ${otherOrgId}, 'Other tenant')`;
    for (const [actorId, tenant] of [
      [alice, orgId],
      [bob, orgId],
      [carol, otherOrgId],
    ] as const) {
      await admin`insert into actors (id, org_id, type, email, display_name)
        values (${actorId}, ${tenant}, 'user', ${`${actorId}@example.test`}, 'Mailbox owner')`;
    }
    await setFlags({ mode: "enforce", provider: "typesafe", spamThreshold: 0.9 });
    await inTenant(orgId, () =>
      decisionStore.saveCredential({
        orgId,
        provider: "typesafe",
        credential: "jev-test-key",
        actorId: alice,
      }),
    );
    const scopedOutbox: OutboxStore = {
      insert: async () => "",
      claimUndelivered: async (limit) => {
        const rows = await admin<{ id: string; subject: string; payload: never }[]>`
          update outbox set attempts = attempts + 1
          where id in (
            select id from outbox where delivered_at is null and payload->>'orgId' = ${orgId}
            order by created_at limit ${limit}
          )
          returning id, subject, payload
        `;
        return rows.map((row) => ({
          id: row.id,
          subject: row.subject,
          payload: row.payload,
          attempts: 1,
          createdAt: new Date().toISOString(),
        }));
      },
      markDelivered: async (id) => {
        await admin`update outbox set delivered_at = now() where id = ${id}`;
      },
      markFailed: async () => undefined,
    };
    outbox = new OutboxWorker({ store: scopedOutbox, events });
    worker = new MailDecisionWorker({
      events,
      store: decisionStore,
      loadConfig: async (tenant) => {
        const rows = await admin<{ feature_flags: Record<string, unknown> }[]>`
          select feature_flags from orgs where id = ${tenant}
        `;
        return resolveDecisionModelConfig(rows[0]?.feature_flags[DECISION_MODEL_FLAG]);
      },
      runForTenant: (tenant, operation) => inTenant(tenant, operation),
      createProvider: (config, credential) =>
        createDecisionModelProvider(
          { ...config, baseUrl: `http://127.0.0.1:${String(port)}` },
          credential,
          {
            fetch: createOutboundHttpClient({
              allowedHosts: ["127.0.0.1"],
              allowHttp: true,
              allowPrivateNetwork: true,
            }),
            maxRetries: 0,
          },
        ),
    });
    await worker.start();
  });

  afterAll(async () => {
    await worker.stop();
    await new Promise((resolve) => server.close(resolve));
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("files confident spam into Spam for every recipient and records evidence", async () => {
    const stored = await receive(
      "WIN A FREE CRUISE",
      "WIN A FREE cruise, click now",
      "<spam-1@sender.example>",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer jev-test-key");
    expect(calls[0]?.body.model).toBe("jev-latest");
    expect(Object.keys(calls[0]?.body.questions ?? {})).toEqual([
      "verdict",
      "category",
      "needs_reply",
      "urgency",
    ]);
    expect(calls[0]?.body.state).toContain("Authentication: SPF=pass DKIM=none DMARC=none");
    expect(calls[0]?.body.state).toContain("SpamAssassin: score 3.1 (FREE)");

    const verdicts = await inTenant(
      orgId,
      () => app`select * from mail_decision_verdicts where message_id = ${stored.messageId}`,
    );
    expect(verdicts).toEqual([
      expect.objectContaining({
        outcome: "decided",
        mode: "enforce",
        model: "jev-1.13.0",
        verdict: "spam",
        verdict_confidence: 0.96,
        proposed_action: "spam",
        action_taken: "spam",
        category: "promotions",
        urgency: "can wait",
        needs_reply_probability: 0.1,
        spamassassin_score: 3.1,
        spamassassin_is_spam: false,
        sender_domain: "sender.example",
        input_tokens: 512,
      }),
    ]);
    const states = await admin<{ actor_id: string; spam_at: Date | null }[]>`
      select actor_id, spam_at from mail_thread_state where thread_id = ${stored.threadId}
      order by actor_id
    `;
    expect(states).toHaveLength(2);
    expect(states.every((state) => state.spam_at !== null)).toBe(true);
    const feedback = await admin<{ actor_id: string; source: string; message_id: string }[]>`
      select actor_id, source, message_id from mail_spam_feedback where thread_id = ${stored.threadId}
    `;
    expect(feedback).toHaveLength(2);
    expect(feedback.every((row) => row.source === "auto_decision_model")).toBe(true);
    expect(feedback.every((row) => row.message_id === stored.messageId)).toBe(true);
    const updates = await admin<{ payload: { actorId: string; reason: string } }[]>`
      select payload from outbox
      where subject = 'activity.mail.updated' and payload->>'messageId' = ${stored.messageId}
    `;
    expect(updates.map((row) => row.payload.actorId).sort()).toEqual([alice, bob].sort());

    const spamFolder = await inTenant(
      orgId,
      () => mailStore.listThreads({ orgId, actorId: alice, folder: "spam" }),
      alice,
    );
    expect(spamFolder.threads).toEqual([
      expect.objectContaining({
        threadId: stored.threadId,
        spamCatcher: "decision-model",
        decision: expect.objectContaining({ verdict: "spam", action: "spam", phishing: false }),
      }),
    ]);
    const thread = await inTenant(
      orgId,
      () => mailStore.getThread({ orgId, actorId: alice, threadId: stored.threadId }),
      alice,
    );
    expect(thread?.messages[0]?.decision).toMatchObject({
      provider: "typesafe",
      verdict: "spam",
      confidence: 0.96,
      urgency: "can wait",
    });

    // Re-delivering the event never calls the provider again.
    await events.publish("activity.mail.received", {
      orgId,
      actorId: alice,
      threadId: stored.threadId,
      messageId: stored.messageId,
    });
    await worker.idle();
    expect(calls).toHaveLength(1);
  });

  it("leaves legitimate mail alone and records shadow verdicts without acting", async () => {
    const legit = await receive("Lunch on Friday", "See you at noon.", "<legit-1@sender.example>");
    await setFlags({ mode: "shadow", provider: "typesafe" });
    const shadow = await receive(
      "WIN A FREE phone",
      "WIN A FREE phone today",
      "<spam-2@sender.example>",
    );
    const states = await admin<{ thread_id: string; spam_at: Date | null }[]>`
      select thread_id, spam_at from mail_thread_state
      where thread_id in (${legit.threadId}, ${shadow.threadId})
    `;
    expect(states.length).toBe(4);
    expect(states.every((state) => state.spam_at === null)).toBe(true);
    const rows = await inTenant(
      orgId,
      () =>
        app<
          {
            message_id: string;
            verdict: string;
            mode: string;
            action_taken: string;
            proposed_action: string;
          }[]
        >`
        select message_id, verdict, mode, action_taken, proposed_action from mail_decision_verdicts
        where message_id in (${legit.messageId}, ${shadow.messageId})
      `,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          message_id: legit.messageId,
          verdict: "legitimate",
          mode: "enforce",
          action_taken: "none",
          proposed_action: "none",
        },
        {
          message_id: shadow.messageId,
          verdict: "spam",
          mode: "shadow",
          action_taken: "none",
          proposed_action: "spam",
        },
      ]),
    );
    const metadata = await admin<{ decision: unknown }[]>`
      select metadata->'decision' as decision from messages where id = ${shadow.messageId}
    `;
    expect(metadata[0]?.decision).toBeNull();
  });

  it("isolates verdicts and credentials between tenants", async () => {
    const foreign = await inTenant(otherOrgId, async () => ({
      verdicts: await app`select id from mail_decision_verdicts`,
      credentials: await app`select org_id from mail_decision_model_credentials`,
      status: await decisionStore.credentialStatus(orgId),
    }));
    expect(foreign).toEqual({ verdicts: [], credentials: [], status: null });
    const anyMessage = await admin<{ id: string; thread_id: string }[]>`
      select id, thread_id from messages where org_id = ${orgId} limit 1
    `;
    await expect(
      inTenant(
        otherOrgId,
        () =>
          app`insert into mail_decision_verdicts (org_id, message_id, thread_id, provider, model, mode, config_version, outcome, reason)
          values (${orgId}, ${anyMessage[0]?.id ?? ""}, ${anyMessage[0]?.thread_id ?? ""}, 'typesafe', 'jev', 'shadow', 'v', 'skipped', 'x')`,
      ),
    ).rejects.toThrow(/row-level security/u);
    // The sealed credential is bound to its tenant.
    const ciphertext = await admin<{ secret_ciphertext: string }[]>`
      select secret_ciphertext from mail_decision_model_credentials where org_id = ${orgId}
    `;
    expect(ciphertext[0]?.secret_ciphertext).not.toContain("jev-test-key");
    expect(() =>
      cipher.open(otherOrgId, "mail-decision-model", ciphertext[0]?.secret_ciphertext ?? ""),
    ).toThrow();
    await expect(
      inTenant(orgId, () => decisionStore.readCredential(orgId, "typesafe")),
    ).resolves.toBe("jev-test-key");
  });

  it("joins user feedback by message id and reports precision, recall, and false positives", async () => {
    const decided = await admin<
      { message_id: string; thread_id: string; verdict: string; mode: string }[]
    >`
      select message_id, thread_id, verdict, mode from mail_decision_verdicts where org_id = ${orgId}
    `;
    const enforcedSpam = decided.find((row) => row.verdict === "spam" && row.mode === "enforce");
    const legit = decided.find((row) => row.verdict === "legitimate");
    expect(enforcedSpam).toBeDefined();
    expect(legit).toBeDefined();
    // Alice says "Not spam" on the filed thread and "Spam" on the legitimate one,
    // through the mail.spam path that now resolves message ids.
    for (const [row, label] of [
      [enforcedSpam, "ham"],
      [legit, "spam"],
    ] as const) {
      await inTenant(
        orgId,
        () =>
          mailStore.recordSpamFeedback({
            orgId,
            actorId: alice,
            mailboxActorId: alice,
            threadId: row?.thread_id ?? "",
            label,
            source: "user",
          }),
        alice,
      );
    }
    const userRows = await admin<{ message_id: string | null; label: string }[]>`
      select message_id, label from mail_spam_feedback where org_id = ${orgId} and source = 'user'
    `;
    expect(userRows.every((row) => row.message_id !== null)).toBe(true);

    const config = resolveDecisionModelConfig({ mode: "shadow", provider: "typesafe" });
    const report = await inTenant(orgId, () =>
      buildDecisionModelReport(app, { orgId, days: 30, now: new Date(Date.now() + 1000), config }),
    );
    expect(report.totals).toMatchObject({ decided: 3, skipped: 0, error: 0 });
    expect(report.verdicts).toMatchObject({ legitimate: 1, spam: 2 });
    expect(report.actionsTaken).toMatchObject({ spam: 1, none: 2 });
    expect(report.spamAssassin).toMatchObject({ compared: 3, agree: 1, modelOnly: 2 });
    expect(report.feedback.model).toMatchObject({
      labelled: 2,
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 1,
      trueNegatives: 0,
      falsePositiveRate: 1,
      precision: 0,
      recall: 0,
    });
    expect(report.tokens).toMatchObject({ input: 1536, averageInputPerMessage: 512 });
    expect(report.cost).toEqual({ estimatedUsd: 0.000065, priced: true });
    expect(report.disagreements.map((row) => row.userLabel).sort()).toEqual(["ham", "spam"]);
    expect(report.disagreements[0]?.senderDomain).toBe("sender.example");

    const otherReport = await inTenant(otherOrgId, () =>
      buildDecisionModelReport(app, { orgId: otherOrgId, days: 30, now: new Date(), config }),
    );
    expect(otherReport.totals.recorded).toBe(0);
  });
});
