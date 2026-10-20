import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresMailDeliveryEventStore } from "./delivery-events.js";
import { verifyProviderFeedback } from "./provider-feedback.js";
import { normalizeSesFeedback } from "./ses-feedback.js";
import { PostgresMailStore } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("mail feedback during a leased dispatch", () => {
  const sql = postgres(databaseUrl ?? "", { max: 2, prepare: false });
  const orgId = randomUUID();
  const actorId = randomUUID();
  const otherActorId = randomUUID();
  const providerId = randomUUID();
  const leaseToken = randomUUID();
  const tenantSql = tenantAwarePostgresSql(sql);
  const store = new PostgresMailStore(tenantSql);
  const feedback = new PostgresMailDeliveryEventStore(sql);
  beforeAll(async () => {
    await sql`insert into orgs (id, slug, display_name) values (${orgId}, ${orgId}, 'Feedback test')`;
    for (const id of [actorId, otherActorId]) {
      await sql`insert into actors (id, org_id, type, email, display_name) values (${id}, ${orgId}, 'agent', ${`${id}@example.test`}, 'Mail agent')`;
    }
    await sql`insert into mail_outbound_providers (id, org_id, name, kind) values (${providerId}, ${orgId}, 'Feedback test', 'smtp')`;
  });
  afterAll(async () => {
    await sql`delete from mail_drafts where org_id = ${orgId}`;
    await sql`delete from mail_suppressions where org_id = ${orgId}`;
    await sql`delete from mail_outbound_messages where org_id = ${orgId}`;
    await sql`delete from mail_outbound_providers where org_id = ${orgId}`;
    await sql`delete from activity where org_id = ${orgId}`;
    await sql`delete from messages where org_id = ${orgId}`;
    await sql`delete from threads where org_id = ${orgId}`;
    await sql`delete from outbox where payload->>'orgId' = ${orgId}`;
    await sql`delete from actors where org_id = ${orgId}`;
    await sql`delete from search_index_mutations where org_id = ${orgId}`;
    await sql`delete from orgs where id = ${orgId}`;
    await sql.end();
  });
  it("atomically consumes only the sent draft revision and preserves newer or foreign drafts", async () => {
    const draft = await store.saveDraft({
      orgId,
      actorId,
      envelope: { subject: "Draft" },
      attachmentObjectIds: [],
      idempotencyKey: randomUUID(),
    });
    const newer = await store.saveDraft({
      orgId,
      actorId,
      id: draft.id,
      expectedRevision: draft.revision,
      envelope: { subject: "Newer draft" },
      attachmentObjectIds: [],
      idempotencyKey: randomUUID(),
    });
    const send = (sender: string, revision: number) =>
      withTenantPostgresContext(tenantSql, { orgId, actorId: sender }, () =>
        store.createOutbound({
          orgId,
          actorId: sender,
          draft: { id: draft.id, revision },
          idempotencyKey: randomUUID(),
          undoUntil: new Date(),
          outboxSubject: "mail.outbound.queued",
          envelope: {
            from: { address: "sender@example.test" },
            to: [{ address: "recipient@example.test" }],
            cc: [],
            bcc: [],
            subject: "Draft",
            text: "Body",
            attachments: [],
          },
        }),
      );
    await send(actorId, draft.revision);
    expect(await store.getDraft({ orgId, actorId, id: draft.id })).not.toBeNull();
    await send(otherActorId, newer.revision);
    expect(await store.getDraft({ orgId, actorId, id: draft.id })).not.toBeNull();
    await send(actorId, newer.revision);
    expect(await store.getDraft({ orgId, actorId, id: draft.id })).toBeNull();
  });
  it("isolates idempotency by actor and preserves bounce feedback ahead of dispatch acknowledgement", async () => {
    const input = {
      orgId,
      actorId,
      idempotencyKey: "same-caller-key",
      undoUntil: new Date(),
      outboxSubject: "mail.outbound.queued",
      envelope: {
        from: { address: "sender@example.test" },
        to: [{ address: "recipient@example.test" }],
        cc: [],
        bcc: [],
        subject: "Test",
        text: "Body",
        attachments: [],
      },
    };
    const create = (actorId: string) =>
      withTenantPostgresContext(tenantSql, { orgId, actorId }, () =>
        store.createOutbound({ ...input, actorId }),
      );
    const outbound = await create(actorId);
    expect((await create(actorId)).id).toBe(outbound.id);
    expect((await create(otherActorId)).id).not.toBe(outbound.id);
    await sql`update mail_outbound_messages set status = 'sending', next_attempt_at = null, lease_owner = 'test', lease_token = ${leaseToken}, lease_expires_at = now() + interval '5 minutes', attempt_count = 1, provider_id = ${providerId} where id = ${outbound.id}`;
    const event = {
      orgId,
      providerId,
      providerEventId: randomUUID(),
      source: "provider" as const,
      kind: "bounced" as const,
      retryClass: "permanent" as const,
      recipient: "recipient@example.test",
      handoffKey: outbound.handoffKey,
      providerMessageId: "provider-accepted-id",
      occurredAt: new Date(),
      diagnostic: "550 mailbox unavailable",
    };
    expect(await feedback.record({ ...event, orgId: randomUUID() })).toBeNull();
    expect(await feedback.record({ ...event, providerId: randomUUID() })).toBeNull();
    expect(await feedback.record(event)).toMatchObject({
      outboundId: outbound.id,
      duplicate: false,
    });
    expect(await feedback.record(event)).toMatchObject({ duplicate: true });
    await expect(
      store.markOutboundSent({
        id: outbound.id,
        leaseToken,
        providerMessageId: "late-ack",
        deliveryMetadata: {},
      }),
    ).resolves.toBeNull();
    await feedback.record({
      ...event,
      providerEventId: randomUUID(),
      kind: "accepted",
      retryClass: "none",
      diagnostic: "late acceptance",
    });
    const rows =
      await sql`select status, lease_token, lease_owner, next_attempt_at, provider_message_id, last_error from mail_outbound_messages where id = ${outbound.id}`;
    expect(rows[0]).toMatchObject({
      status: "bounced",
      lease_token: null,
      lease_owner: null,
      next_attempt_at: null,
      provider_message_id: "provider-accepted-id",
      last_error: "550 mailbox unavailable",
    });
    expect(await sql`select id from mail_suppressions where org_id = ${orgId}`).toHaveLength(1);
  });
  it("correlates signed SES header handoff IDs and rejects another provider before suppression", async () => {
    const recipient = "ses-recipient@example.test";
    const outbound = await withTenantPostgresContext(tenantSql, { orgId, actorId }, () =>
      store.createOutbound({
        orgId,
        actorId,
        idempotencyKey: randomUUID(),
        undoUntil: new Date(),
        outboxSubject: "mail.outbound.queued",
        envelope: {
          from: { address: "sender@example.test" },
          to: [{ address: recipient }],
          cc: [],
          bcc: [],
          subject: "SES fixture",
          text: "Body",
          attachments: [],
        },
      }),
    );
    await sql`update mail_outbound_messages set provider_id=${providerId},provider_message_id='mail-manager-queue-id' where id=${outbound.id}`;
    const [event] = normalizeSesFeedback(
      {
        notificationType: "Complaint",
        mail: {
          messageId: "downstream-ses-id",
          headers: [{ name: "X-Helix-Idempotency-Key", value: outbound.handoffKey }],
        },
        complaint: {
          timestamp: new Date().toISOString(),
          complainedRecipients: [{ emailAddress: recipient }],
        },
      },
      randomUUID(),
    );
    assert(event);
    await expect(feedback.ingestEvent({ orgId, providerId: randomUUID(), event })).rejects.toThrow(
      "does not match",
    );
    expect(await feedback.findActiveSuppressions(orgId, [recipient])).toEqual([]);
    expect(await feedback.ingestEvent({ orgId, providerId, event })).toMatchObject({
      outboundMatched: true,
      suppressed: true,
      duplicate: false,
    });
    expect(await feedback.ingestEvent({ orgId, providerId, event })).toMatchObject({
      duplicate: true,
    });
    expect(await feedback.findActiveSuppressions(orgId, [recipient])).toHaveLength(1);
    expect(
      (await sql`select status from mail_outbound_messages where id=${outbound.id}`)[0]?.status,
    ).toBe("complained");
  });
  it("correlates Postmark metadata before acknowledgement and does not suppress policy rejections", async () => {
    const recipient = "postmark-recipient@example.test";
    const outbound = await withTenantPostgresContext(tenantSql, { orgId, actorId }, () =>
      store.createOutbound({
        orgId,
        actorId,
        idempotencyKey: randomUUID(),
        undoUntil: new Date(),
        outboxSubject: "mail.outbound.queued",
        envelope: {
          from: { address: "sender@example.test" },
          to: [{ address: recipient }],
          cc: [],
          bcc: [],
          subject: "Postmark fixture",
          text: "Body",
          attachments: [],
        },
      }),
    );
    await sql`update mail_outbound_messages set provider_id=${providerId} where id=${outbound.id}`;
    const [event] = verifyProviderFeedback({
      kind: "postmark",
      secret: "test-secret",
      headers: { authorization: `Basic ${Buffer.from("helix:test-secret").toString("base64")}` },
      rawBody: Buffer.from(
        JSON.stringify({
          RecordType: "Delivery",
          MessageID: "postmark-accepted-id",
          Recipient: recipient,
          DeliveredAt: new Date().toISOString(),
          Metadata: { helixHandoffKey: outbound.handoffKey },
        }),
      ),
    });
    assert(event);
    expect(await feedback.ingestEvent({ orgId, providerId, event })).toMatchObject({
      outboundMatched: true,
      suppressed: false,
    });
    expect(
      await feedback.ingestEvent({
        orgId,
        providerId,
        event: { ...event, providerEventId: randomUUID(), type: "rejected" },
      }),
    ).toMatchObject({ suppressed: false });
    expect(await feedback.findActiveSuppressions(orgId, [recipient])).toEqual([]);
  });
});
