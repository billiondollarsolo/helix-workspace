import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import nodemailer from "nodemailer";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { ensureAdminDomain } from "../admin/domain-identity.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { SmtpMailReceiver } from "./ingest.js";
import { LocalMailTransport } from "./local-delivery.js";
import { MailSendService, OutboundMailDispatcher } from "./outbound.js";
import { PostgresMailStore, type MailStore } from "./store.js";
import { MailRoutingStore } from "./store-routing.js";
import type { ClaimedOutboundMail } from "./store-contracts.js";
import type { MailMessageInput, MailOutboundRecord } from "./types.js";

describe.skipIf(skipUnlessLiveDatabase("group Mail delivery"))(
  "group posting through canonical routing and transport",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
    const sql = tenantAwarePostgresSql(
      postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 3 }),
    );
    const store = new PostgresMailStore(sql),
      routing = new MailRoutingStore(sql);
    const orgId = randomUUID(),
      otherOrg = randomUUID(),
      alice = randomUUID(),
      bob = randomUUID(),
      foreign = randomUUID(),
      group = randomUUID();
    const domain = `${orgId}.test`,
      aliasDomain = `alias.${domain}`,
      secondaryDomain = `second.${domain}`;
    const email = (id: string) => `${id}@${domain}`;
    const list = `team@${domain}`,
      listAlias = `team@${aliasDomain}`;
    const tenant = <T>(operation: () => Promise<T>, actorId?: string, tenantId = orgId) =>
      withTenantPostgresContext(
        sql,
        { orgId: tenantId, ...(actorId === undefined ? {} : { actorId }) },
        operation,
      );
    const remote = vi.fn(async () => {
      throw new Error("Local groups must not fall through to SMTP");
    });
    const dispatcher = new OutboundMailDispatcher(
      store,
      async (outbound) => new LocalMailTransport(sql, outbound, remote),
      { runForTenant: (id, operation) => withTenantPostgresContext(sql, { orgId: id }, operation) },
    );
    const messages: MailMessageInput[] = [];
    let receiver: SmtpMailReceiver | undefined;
    let afterResolve: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Group Mail','active'),(${otherOrg},${otherOrg},'Other','active')`;
      const primary = await ensureAdminDomain(admin, { orgId, domain });
      await admin`update admin_domains set status='verified',verified_at=now(),identity_enabled=true,mail_enabled=true,aliases_enabled=true,is_primary=true where id=${primary}`;
      const alias = await ensureAdminDomain(admin, { orgId, domain: aliasDomain });
      await admin`update admin_domains set status='verified',verified_at=now(),identity_enabled=true,mail_enabled=true,aliases_enabled=true,identity_mode='alias',alias_target_domain_id=${primary} where id=${alias}`;
      const secondary = await ensureAdminDomain(admin, { orgId, domain: secondaryDomain });
      await admin`update admin_domains set status='verified',verified_at=now(),identity_enabled=true,mail_enabled=true,aliases_enabled=true where id=${secondary}`;
      for (const id of [alice, bob])
        await admin`insert into actors(id,org_id,type,email,display_name) values(${id},${orgId},'user',${email(id)},${id})`;
      await admin`insert into actors(id,org_id,type,email,display_name) values(${foreign},${otherOrg},'user',${`${foreign}@outside.test`},'Foreign')`;
      await admin`insert into admin_groups(id,org_id,name,email,kind,created_by) values(${group},${orgId},'Team',${list},'mailing_list',${alice})`;
      for (const id of [alice, bob]) await addMember(id);
      receiver = new SmtpMailReceiver({
        store: {
          insertInboundMessage: async (input: MailMessageInput) => {
            messages.push(input);
            return {
              created: true,
              deliveredActorIds: input.mailboxActorIds ?? [],
              threadId: randomUUID(),
              messageId: randomUUID(),
              attachmentObjectIds: [],
            };
          },
          listFilters: async () => [],
          getActiveVacation: async () => null,
          updateThreadState: async () => {},
        } as unknown as MailStore,
        resolveRecipient: async (address) => {
          const resolution = await store.resolveInboundAddress(address);
          const callback = afterResolve;
          afterResolve = undefined;
          await callback?.();
          return resolution;
        },
        authenticator: {
          authenticate: async () => ({ spf: "pass", dkim: "pass", dmarc: "pass", arc: "none" }),
        },
        transportSecurity: { mode: "development-plaintext" },
      });
      await receiver.listen(0, "127.0.0.1");
    });
    afterAll(async () => {
      await receiver?.close();
      await cleanupTestTenants(admin, [orgId, otherOrg]);
      await Promise.all([admin.end(), sql.end()]);
    });
    async function addMember(id: string) {
      await admin`insert into admin_group_members(org_id,group_id,actor_id,role,added_by) values(${orgId},${group},${id},'member',${alice})`;
    }
    async function claim(record: MailOutboundRecord): Promise<ClaimedOutboundMail> {
      const value = await tenant(() =>
        store.claimDueOutbound({ owner: "group-test", leaseMs: 60000 }),
      );
      expect(value?.id).toBe(record.id);
      if (value === null) throw new Error("Expected claim");
      return value;
    }
    async function queue(to: readonly string[], from = email(alice), authenticated = true) {
      const input = {
        orgId,
        actorId: alice,
        envelope: {
          from: { address: from },
          to: to.map((address) => ({ address })),
          cc: [],
          bcc: [],
          subject: "Group boundary",
          text: "Current membership",
          attachments: [],
        },
      };
      return tenant(() =>
        authenticated
          ? new MailSendService({ store, undoWindowMs: 0 }).queue(input)
          : store.createOutbound({ ...input, undoUntil: new Date(), outboxSubject: "mail.send" }),
      );
    }
    async function smtp() {
      if (receiver === undefined) throw new Error("SMTP receiver is not started.");
      const address = receiver.nodeServer.server.address() as AddressInfo;
      const transport = nodemailer.createTransport({
        host: "127.0.0.1",
        port: address.port,
        secure: false,
        ignoreTLS: true,
      });
      try {
        return await transport.sendMail({
          envelope: { from: email(alice), to: [listAlias] },
          raw: `From: ${email(alice)}\r\nTo: ${listAlias}\r\nSubject: Spoofed local sender\r\nMessage-ID: <${randomUUID()}@external.test>\r\n\r\nHello`,
        });
      } finally {
        transport.close();
      }
    }
    it("defaults to authenticated organization senders and never trusts incidental actor context or a local From", async () => {
      await expect(store.resolveInboundAddress(list)).rejects.toMatchObject({ responseCode: 550 });
      await expect(tenant(() => store.resolveInboundAddress(list), alice)).rejects.toMatchObject({
        responseCode: 550,
      });
      await expect(
        tenant(() => routing.resolveInboundAddress(list, true), foreign, otherOrg),
      ).rejects.toMatchObject({ responseCode: 550 });
      await expect(
        tenant(() => routing.resolveInboundAddress(list, true), foreign),
      ).rejects.toMatchObject({ responseCode: 550 });
      expect(
        (await tenant(() => routing.resolveInboundAddress(listAlias, true), alice)).recipients
          .map((r) => r.actorId)
          .sort(),
      ).toEqual([alice, bob].sort());
      await expect(smtp()).rejects.toMatchObject({ responseCode: 550 });
      expect(messages).toHaveLength(0);
    });
    it("delivers group and automatic alias-domain addresses once per current member", async () => {
      const record = await queue([list, listAlias, email(bob)]);
      const result = await dispatcher.dispatch(await claim(record));
      expect(result?.status).toBe("accepted");
      expect(result?.deliveryMetadata.mailboxCount).toBe(2);
      const rows = await admin<
        { actor_id: string }[]
      >`select actor_id from mail_message_deliveries where org_id=${orgId} and message_id=${record.messageId} and received_at is not null order by actor_id`;
      expect(rows.map((r) => r.actor_id)).toEqual([alice, bob].sort());
      expect(remote).not.toHaveBeenCalled();
      const queued = await queue([listAlias]);
      await admin`delete from admin_group_members where org_id=${orgId} and group_id=${group} and actor_id=${bob}`;
      try {
        expect((await dispatcher.dispatch(await claim(queued)))?.status).toBe("accepted");
        expect(
          await admin`select 1 from mail_message_deliveries where org_id=${orgId} and message_id=${queued.messageId} and actor_id=${bob}`,
        ).toHaveLength(0);
      } finally {
        await addMember(bob);
      }
    });
    it("does not launder automatic forwards or forged queued provenance into internal group posts", async () => {
      const record = await queue([list], email(alice), false);
      const claimed = await claim(record);
      await expect(
        new LocalMailTransport(
          sql,
          { ...claimed, deliveryMetadata: { senderAuthenticated: true } },
          remote,
        ).send(claimed.envelope, { idempotencyKey: claimed.handoffKey }),
      ).rejects.toThrow("provenance");
      const result = await dispatcher.dispatch(claimed);
      expect(result?.status).toBe("failed");
      expect(result?.lastError).toContain("authenticated workspace senders");
      expect(remote).not.toHaveBeenCalled();
      expect(
        await admin`select 1 from mail_message_deliveries where message_id=${record.messageId} and actor_id=${bob}`,
      ).toHaveLength(0);
    });
    it("accepts external SMTP only after opt-in and enforces current active membership and expansion limits", async () => {
      await admin`update admin_groups set posting_policy='anyone' where id=${group}`;
      try {
        await smtp();
        expect(messages.at(-1)?.mailboxActorIds?.slice().sort()).toEqual([alice, bob].sort());
        await expect(
          sql`select * from helix_resolve_inbound_mailboxes(${list},${domain},1)`,
        ).rejects.toMatchObject({ code: "54000" });
        await admin`update actors set disabled_at=now() where id=${bob}`;
        expect((await store.resolveInboundAddress(list)).recipients.map((r) => r.actorId)).toEqual([
          alice,
        ]);
      } finally {
        await admin`update actors set disabled_at=null where id=${bob}`;
        await admin`update admin_groups set posting_policy='organization' where id=${group}`;
      }
    });
    it("never falls back to legacy expansion when a group domain or alias target becomes unavailable", async () => {
      await expect(
        admin`update admin_domains set is_primary=false,identity_enabled=false where org_id=${orgId} and domain=${domain}`,
      ).rejects.toMatchObject({ code: "23514" });
      await admin`update admin_domains set aliases_enabled=false where org_id=${orgId} and domain=${domain}`;
      try {
        await expect(
          tenant(() => routing.resolveInboundAddress(listAlias, true), alice),
        ).rejects.toMatchObject({ responseCode: 550 });
        await expect(smtp()).rejects.toMatchObject({ responseCode: 550 });
        const queued = await queue([listAlias]);
        expect((await dispatcher.dispatch(await claim(queued)))?.status).toBe("failed");
        expect(remote).not.toHaveBeenCalled();
      } finally {
        await admin`update admin_domains set aliases_enabled=true where org_id=${orgId} and domain=${domain}`;
      }
      await admin`update orgs set suspended_at=now() where id=${orgId}`;
      try {
        await expect(store.resolveInboundAddress(list)).rejects.toMatchObject({
          responseCode: 550,
        });
      } finally {
        await admin`update orgs set suspended_at=null where id=${orgId}`;
      }
    });
    it("rechecks SMTP posting permission after RCPT and rejects groups with no active recipients", async () => {
      const before = messages.length;
      await admin`update admin_groups set posting_policy='anyone' where id=${group}`;
      afterResolve = async () => {
        await admin`update admin_groups set posting_policy='organization' where id=${group}`;
      };
      await expect(smtp()).rejects.toMatchObject({ responseCode: 550 });
      expect(messages).toHaveLength(before);
      await admin`delete from admin_group_members where org_id=${orgId} and group_id=${group}`;
      try {
        const queued = await queue([listAlias]);
        const result = await dispatcher.dispatch(await claim(queued));
        expect(result?.status).toBe("failed");
        expect(result?.lastError).toContain("no active member mailboxes");
        expect(remote).not.toHaveBeenCalled();
      } finally {
        for (const id of [alice, bob]) await addMember(id);
      }
    });
    it("rejects alias-domain address collisions and foreign group members", async () => {
      await expect(
        admin`insert into mail_aliases(org_id,actor_id,email,enabled) values(${orgId},${bob},${listAlias},true)`,
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        admin`insert into admin_group_members(org_id,group_id,actor_id,role) values(${otherOrg},${group},${foreign},'member')`,
      ).rejects.toMatchObject({ code: "23503" });
    });
    it("rechecks revoked send-as at dispatch, while valid secondary-domain aliases can post internally", async () => {
      const address = `alice@${secondaryDomain}`;
      await admin`insert into mail_aliases(org_id,actor_id,email,enabled) values(${orgId},${alice},${address},true)`;
      const accepted = await queue([listAlias], address);
      expect((await dispatcher.dispatch(await claim(accepted)))?.status).toBe("accepted");
      const denied = await queue([listAlias], address);
      await admin`update mail_aliases set send_as_enabled=false where org_id=${orgId} and email=${address}`;
      const result = await dispatcher.dispatch(await claim(denied));
      expect(result?.status).toBe("failed");
      expect(result?.lastError).toContain("sender address is no longer authorized");
      expect(remote).not.toHaveBeenCalled();
      expect(
        await admin`select 1 from mail_message_deliveries where message_id=${denied.messageId} and actor_id=${bob}`,
      ).toHaveLength(0);
    });
  },
);
