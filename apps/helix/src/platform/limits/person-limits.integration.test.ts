import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { MailInboundQuotaExceededError } from "../mail/errors.js";
import { MailRoutingStore } from "../mail/store-routing.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresPersonLimitStore, type PersonLimitValues } from "./person-limits.js";

/**
 * Per-person limits under the runtime database role: an organization default,
 * one person's own value, and what happens at the limit for stored files, for
 * mail arriving, and for mail being sent.
 */

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip =
  skipUnlessLiveDatabase("Per-person limits through the runtime database role") ||
  adminUrl === undefined ||
  appUrl === undefined;

const MB = 1024 * 1024;

describe.skipIf(skip)("per-person limits", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 3 }));
  const orgId = randomUUID();
  const adminId = randomUUID();
  const leeId = randomUUID();
  const samId = randomUUID();
  const domain = `limits-${orgId.slice(0, 8)}.example`;
  let defaults: PersonLimitValues = {
    storageBytes: null,
    mailSendPerHour: 60,
    mailSendPerDay: 200,
  };
  const store = new PostgresPersonLimitStore(app, async () => defaults);
  const routing = new MailRoutingStore(app);
  const setDefaults = async (next: PersonLimitValues) => {
    defaults = next;
    // The storage check reads the organization's default from its settings.
    await admin`
      update orgs set quotas = ${admin.json({ storage_bytes_per_person_limit: next.storageBytes })}
      where id = ${orgId}
    `;
  };
  const own = (actorId: string, overrides: Partial<PersonLimitValues>) =>
    store.setOverrides({
      orgId,
      actorId,
      updatedByActorId: adminId,
      overrides: { storageBytes: null, mailSendPerHour: null, mailSendPerDay: null, ...overrides },
    });
  const file = (ownerId: string, byteSize: number) => admin`
    insert into objects (org_id, owner_actor_id, kind, storage_key, mime_type, byte_size)
    values (${orgId}, ${ownerId}, 'file', ${`limits/${randomUUID()}`}, 'text/plain', ${byteSize})
  `;
  /** A message in `mailboxId`'s mailbox; with `sentBy`, also queued by that person. */
  const message = async (mailboxId: string, body: string, sentBy?: string, key?: string) => {
    const [thread] = await admin<{ id: string }[]>`
      insert into threads (org_id, kind) values (${orgId}, 'mail') returning id
    `;
    const [stored] = await admin<{ id: string }[]>`
      insert into messages (org_id, thread_id, kind, body)
      values (${orgId}, ${thread?.id ?? ""}, 'mail', ${body}) returning id
    `;
    await admin`
      insert into mail_message_deliveries (org_id, message_id, actor_id)
      values (${orgId}, ${stored?.id ?? ""}, ${mailboxId})
    `;
    if (sentBy !== undefined) {
      await admin`
        insert into mail_outbound_messages (
          org_id, actor_id, message_id, thread_id, envelope, undo_until, next_attempt_at,
          idempotency_key
        ) values (
          ${orgId}, ${sentBy}, ${stored?.id ?? ""}, ${thread?.id ?? ""}, '{}'::jsonb, now(), now(),
          ${key ?? null}
        )
      `;
    }
  };
  const full = async (actorId: string, additional = 0) =>
    (
      await app<{ full: boolean }[]>`
        select helix_actor_storage_full(${orgId}, ${actorId}, ${additional}) as full
      `
    )[0]?.full;

  beforeAll(async () => {
    await admin`
      insert into orgs (id, slug, display_name, status, tier, region)
      values (${orgId}, ${`limits-${orgId.slice(0, 8)}`}, 'Limits test', 'active', 'personal', 'default')
    `;
    await admin`insert into admin_domains (
        id, org_id, domain, status, verified_at, mail_enabled,
        verification_host, verification_value, verification_expires_at
      ) values (${randomUUID()}, ${orgId}, ${domain}, 'verified', now(), true,
        ${`_helix-verification.${domain}`}, 'fixture', now() + interval '1 day')`;
    await admin`
      insert into actors (id, org_id, type, display_name, email) values
        (${adminId}, ${orgId}, 'user', 'Admin', null),
        (${leeId}, ${orgId}, 'agent', 'Lee', ${`lee@${domain}`}),
        (${samId}, ${orgId}, 'agent', 'Sam', ${`sam@${domain}`})
    `;
    await file(leeId, 3 * MB);
    await message(leeId, "x".repeat(MB));
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("counts a person's files and mailbox, and applies the default unless they have their own", async () => {
    const lee = await store.get({ orgId, actorId: leeId });
    expect(lee?.usage.storageBytes).toBe(4 * MB);
    expect(lee?.effective).toEqual({
      storageBytes: null,
      mailSendPerHour: 60,
      mailSendPerDay: 200,
    });
    // Nobody is full while there is no limit.
    expect(await full(leeId)).toBe(false);

    await setDefaults({ ...defaults, storageBytes: 5 * MB });
    expect((await store.get({ orgId, actorId: leeId }))?.effective.storageBytes).toBe(5 * MB);
    expect(await full(leeId)).toBe(false);
    // Lee has 1 MB left: a 2 MB upload is refused, a 1 MB one fits.
    expect(await full(leeId, 2 * MB)).toBe(true);
    expect(await full(leeId, MB)).toBe(false);

    // Lee's own limit wins over the default, up or down.
    await own(leeId, { storageBytes: 4 * MB });
    expect(await full(leeId)).toBe(true);
    await own(leeId, { storageBytes: 50 * MB });
    expect(await full(leeId, 2 * MB)).toBe(false);
    expect((await store.listOverrides(orgId)).map((person) => person.displayName)).toEqual(["Lee"]);
    // Handing every value back removes the override.
    await own(leeId, {});
    expect(await store.listOverrides(orgId)).toEqual([]);
    expect((await store.get({ orgId, actorId: leeId }))?.effective.storageBytes).toBe(5 * MB);
  });

  it("turns mail away from a full mailbox and keeps delivering to everyone else", async () => {
    await own(leeId, { storageBytes: MB });
    await expect(routing.resolveInboundRecipients(`lee@${domain}`)).rejects.toBeInstanceOf(
      MailInboundQuotaExceededError,
    );
    await expect(routing.resolveInboundRecipients(`sam@${domain}`)).resolves.toMatchObject([
      { actorId: samId },
    ]);
    await own(leeId, {});
    await expect(routing.resolveInboundRecipients(`lee@${domain}`)).resolves.toMatchObject([
      { actorId: leeId },
    ]);
  });

  it("stops a person at their hourly or daily sending limit, not counting notices", async () => {
    const send = () => store.assertMaySend({ orgId, actorId: samId });
    await own(samId, { mailSendPerHour: 2 });
    await message(leeId, "one", samId);
    // A sharing notice sent in Sam's name does not use up Sam's allowance.
    await message(leeId, "notice", samId, `notice:${randomUUID()}`);
    await expect(send()).resolves.toBeUndefined();
    await message(leeId, "two", samId);
    await expect(send()).rejects.toMatchObject({
      code: "rate_limited",
      message: expect.stringContaining("2 messages an hour") as string,
    });
    expect((await store.get({ orgId, actorId: samId }))?.usage).toMatchObject({
      mailSentLastHour: 2,
      mailSentLastDay: 2,
    });
    // An administrator raises it for Sam alone; Lee still has the default.
    await own(samId, { mailSendPerHour: 500, mailSendPerDay: 2 });
    await expect(send()).rejects.toMatchObject({
      message: expect.stringContaining("2 messages a day") as string,
    });
    await own(samId, { mailSendPerHour: 500, mailSendPerDay: 500 });
    await expect(send()).resolves.toBeUndefined();
    await expect(
      withTenantPostgresContext(app, { orgId, actorId: leeId }, () =>
        store.assertMaySend({ orgId, actorId: leeId }),
      ),
    ).resolves.toBeUndefined();
  });
});
