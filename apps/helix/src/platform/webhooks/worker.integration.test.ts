import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { WebhookHttpClient } from "./delivery.js";
import { PostgresWebhookStore, TenantEnvelopeWebhookSecretResolver } from "./store.js";
import { OutboundWebhookWorker } from "./worker.js";

/**
 * Outbound webhooks under the runtime database role. Webhooks are tenant rows,
 * and the worker runs outside any request: unless it enters the event's
 * organization it sees no webhooks at all and nothing is ever delivered.
 */

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip =
  skipUnlessLiveDatabase("Outbound webhook delivery through the runtime database role") ||
  adminUrl === undefined ||
  appUrl === undefined;

describe.skipIf(skip)("OutboundWebhookWorker with tenant row security", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 3 }));
  const cipher = new TenantEnvelopeCipher("webhook-worker-test-master-secret");
  const store = new PostgresWebhookStore(app, cipher);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const agentId = randomUUID();
  const personId = randomUUID();
  const posted: { readonly url: string; readonly body: string }[] = [];
  const httpClient: WebhookHttpClient = {
    post: async (input) => {
      posted.push({ url: input.url, body: input.body });
      return { status: 204, headers: {}, body: "" };
    },
  };
  const inOrg = <T>(org: string, work: () => Promise<T>) =>
    withTenantPostgresContext(app, { orgId: org }, async () => work());
  const worker = (scoped: boolean) =>
    new OutboundWebhookWorker({
      store,
      events: { publish: async () => undefined, subscribe: async () => async () => undefined },
      httpClient,
      secretResolver: new TenantEnvelopeWebhookSecretResolver(cipher),
      ...(scoped ? { runForOrg: inOrg, listOrgIds: async () => [orgId, otherOrgId] } : {}),
    });
  const newMail = (org: string, mailbox: string) => ({
    subject: "activity.mail.received",
    payload: { orgId: org, actorId: mailbox, subject: "Quarterly numbers" },
    occurredAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await admin`
        insert into orgs (id, slug, display_name, status, tier, region)
        values (${id}, ${`hooks-${id.slice(0, 8)}`}, 'Webhook test', 'active', 'personal', 'default')
      `;
    }
    await admin`
      insert into actors (id, org_id, type, display_name) values
        (${agentId}, ${orgId}, 'agent', 'Billing bot'),
        (${personId}, ${orgId}, 'user', 'Lee')
    `;
    const secret = "s".repeat(40);
    await inOrg(orgId, () =>
      store.createOutbound({
        orgId,
        name: "Billing bot's mail",
        url: "https://agent.example/new-mail",
        eventSubjects: ["activity.mail.received"],
        secret,
        metadata: { onlyActorIds: [agentId] },
      }),
    );
    await inOrg(otherOrgId, () =>
      store.createOutbound({
        orgId: otherOrgId,
        name: "Everything",
        url: "https://other.example/everything",
        eventSubjects: [">"],
        secret,
      }),
    );
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("sees no webhooks unless it enters the event's organization", async () => {
    await expect(worker(false).handle(newMail(orgId, agentId))).resolves.toMatchObject({
      attempted: 0,
    });
    expect(posted).toEqual([]);
  });

  it("delivers an agent's new mail to the agent's webhook and to nobody else's", async () => {
    await expect(worker(true).handle(newMail(orgId, agentId))).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    // The other organization subscribes to everything and still hears nothing.
    expect(posted.map((request) => request.url)).toEqual(["https://agent.example/new-mail"]);
    expect(JSON.parse(posted[0]?.body ?? "{}")).toMatchObject({
      subject: "activity.mail.received",
      data: { actorId: agentId, subject: "Quarterly numbers" },
    });
    // A colleague's new mail is not sent to the agent's webhook.
    await expect(worker(true).handle(newMail(orgId, personId))).resolves.toMatchObject({
      attempted: 0,
    });
    const [delivery] = await admin<{ status: string; org_id: string }[]>`
      select status, org_id from webhook_deliveries where org_id in (${orgId}, ${otherOrgId})
    `;
    expect(delivery).toEqual({ status: "delivered", org_id: orgId });
  });

  it("retries a waiting delivery inside its own organization", async () => {
    const failing: WebhookHttpClient = {
      post: async () => ({ status: 500, headers: {}, body: "down" }),
    };
    const flaky = new OutboundWebhookWorker({
      store,
      events: { publish: async () => undefined, subscribe: async () => async () => undefined },
      httpClient: failing,
      secretResolver: new TenantEnvelopeWebhookSecretResolver(cipher),
      runForOrg: inOrg,
      listOrgIds: async () => [orgId, otherOrgId],
      retryPolicy: { maxAttempts: 3, delaysMs: [1] },
    });
    await expect(flaky.handle(newMail(orgId, agentId))).resolves.toMatchObject({ failed: 1 });
    posted.length = 0;
    const later = new Date(Date.now() + 60_000);
    await expect(worker(true).drainRetries(later)).resolves.toEqual({
      attempted: 1,
      delivered: 1,
      failed: 0,
    });
    expect(posted.map((request) => request.url)).toEqual(["https://agent.example/new-mail"]);
  });
});
