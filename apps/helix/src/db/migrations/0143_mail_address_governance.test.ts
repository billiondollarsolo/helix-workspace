import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMailStore } from "../../platform/mail/store.js";

const migration = readFileSync(
  new URL("./0143_mail_address_governance.sql", import.meta.url),
  "utf8",
);

describe("0143 mail address governance migration", () => {
  it("defines explicit alias modes, bounded expansion, forwarding policy, and audit", () => {
    expect(migration).toContain("receive_enabled boolean not null");
    expect(migration).toContain("send_as_enabled boolean not null");
    expect(migration).toContain("mail_aliases_actor_org_fk");
    expect(migration).toContain("mail_routing_forward_cycle_check");
    expect(migration).toContain("helix_external_mail_forward_allowed");
    expect(migration).toContain("helix_resolve_inbound_mailboxes");
    expect(migration).toContain("mail recipient expansion limit exceeded");
    expect(migration).toContain("mail_address_events_no_update_or_delete");
  });
});

describe.skipIf(process.env.DATABASE_URL === undefined)("Mail address governance", () => {
  const database = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const mail = new PostgresMailStore(database);
  const org = "f1430000-0000-4000-8000-000000000001";
  const otherOrg = "f1430000-0000-4000-8000-000000000002";
  const owner = "f1430000-0000-4000-8000-000000000011";
  const delegate = "f1430000-0000-4000-8000-000000000012";
  const foreign = "f1430000-0000-4000-8000-000000000013";
  const domain = "mail-143.example.test";
  const otherDomain = "mail-143-other.example.test";

  async function cleanup() {
    await database.begin(async (tx) => {
      await tx.unsafe("set local session_replication_role = replica");
      await tx`delete from mail_address_events where org_id in (${org}, ${otherOrg})`;
      await tx`delete from mail_inbound_routing_rules where org_id in (${org}, ${otherOrg})`;
      await tx`delete from permissions where org_id in (${org}, ${otherOrg})`;
      await tx`delete from mail_aliases where org_id in (${org}, ${otherOrg})`;
      await tx`delete from admin_group_members where org_id in (${org}, ${otherOrg})`;
      await tx`delete from admin_groups where org_id in (${org}, ${otherOrg})`;
      await tx`delete from admin_security_policies where org_id in (${org}, ${otherOrg})`;
      await tx`delete from admin_domains where org_id in (${org}, ${otherOrg})`;
      await tx`delete from organization_memberships where org_id in (${org}, ${otherOrg})`;
      await tx`delete from actors where org_id in (${org}, ${otherOrg})`;
      await tx`delete from identity_subjects where canonical_email like '%mail-143%.example.test'`;
      await tx`delete from orgs where id in (${org}, ${otherOrg})`;
    });
  }

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name) values
        (${org}, 'mail-address-governance', 'Mail address governance'),
        (${otherOrg}, 'mail-address-governance-other', 'Mail address governance other')
    `;
    await database`
      insert into admin_domains (
        org_id, domain, status, verified_at, verification_host, verification_value,
        verification_expires_at, identity_enabled, mail_enabled, aliases_enabled, is_primary
      ) values
        (${org}, ${domain}, 'verified', now(), ${`_verify.${domain}`}, 'verified',
          now() + interval '1 day', true, true, true, true),
        (${otherOrg}, ${otherDomain}, 'verified', now(), ${`_verify.${otherDomain}`}, 'verified',
          now() + interval '1 day', true, true, true, true)
    `;
    await database`
      insert into actors (id, org_id, type, email, display_name) values
        (${owner}, ${org}, 'user', ${`owner@${domain}`}, 'Owner'),
        (${delegate}, ${org}, 'user', ${`delegate@${domain}`}, 'Delegate'),
        (${foreign}, ${otherOrg}, 'user', ${`foreign@${otherDomain}`}, 'Foreign')
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  it("rejects foreign and inactive alias targets and separates receive from send-as", async () => {
    await expect(
      database`
        insert into mail_aliases (org_id, actor_id, email)
        values (${org}, ${foreign}, ${`foreign@${domain}`})
      `,
    ).rejects.toMatchObject({ code: "23503" });

    await database`update actors set disabled_at = now() where id = ${delegate}`;
    await expect(
      database`
        insert into mail_aliases (org_id, actor_id, email)
        values (${org}, ${delegate}, ${`inactive@${domain}`})
      `,
    ).rejects.toMatchObject({ code: "23514" });
    await database`update actors set disabled_at = null where id = ${delegate}`;
    await expect(
      database`
        insert into mail_aliases (org_id, actor_id, email)
        values (${org}, ${delegate}, 'alias@unverified.example')
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await database`
      insert into mail_aliases (
        org_id, actor_id, email, receive_enabled, send_as_enabled
      ) values
        (${org}, ${owner}, ${`receive@${domain}`}, true, false),
        (${org}, ${owner}, ${`send@${domain}`}, false, true)
    `;
    await expect(mail.resolveInboundRecipients(`receive@${domain}`)).resolves.toHaveLength(1);
    await expect(mail.resolveInboundRecipients(`send@${domain}`)).resolves.toEqual([]);
    await expect(mail.resolveAuthorizedSender(org, owner, `receive@${domain}`)).resolves.toBeNull();
    await expect(mail.resolveAuthorizedSender(org, owner, `send@${domain}`)).resolves.toBe(
      `send@${domain}`,
    );
  });

  it("expands mailing lists only to active same-organization members", async () => {
    const groups = await database<{ readonly id: string }[]>`
      insert into admin_groups (org_id, name, email, kind, created_by)
      values (${org}, 'Team', ${`team@${domain}`}, 'mailing_list', ${owner})
      returning id
    `;
    const groupId = groups[0]?.id;
    if (groupId === undefined) throw new Error("Group was not created.");
    await database`
      insert into admin_group_members (org_id, group_id, actor_id, added_by) values
        (${org}, ${groupId}, ${owner}, ${owner}),
        (${org}, ${groupId}, ${delegate}, ${owner})
    `;
    await expect(
      database`
        insert into mail_aliases (org_id, actor_id, email)
        values (${org}, ${owner}, ${`team@${domain}`})
      `,
    ).rejects.toMatchObject({ code: "23505" });

    await expect(mail.resolveInboundRecipients(`team@${domain}`)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: owner }),
        expect.objectContaining({ actorId: delegate }),
      ]),
    );
    await expect(
      database`
        insert into admin_group_members (org_id, group_id, actor_id, added_by)
        values (${org}, ${groupId}, ${foreign}, ${owner})
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("requires explicit owner delegation and records grant and revoke evidence", async () => {
    await expect(
      database`
        insert into permissions (
          org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
        ) values (${org}, ${delegate}, 'mailbox', ${owner}, 'manager', ${delegate})
      `,
    ).rejects.toMatchObject({ code: "23514" });
    const grants = await database<{ readonly id: string }[]>`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values (${org}, ${delegate}, 'mailbox', ${owner}, 'manager', ${owner})
      returning id
    `;
    const grantId = grants[0]?.id;
    if (grantId === undefined) throw new Error("Delegate was not granted.");
    await database`update actors set disabled_at = now() where id = ${delegate}`;
    await expect(
      mail.revokeMailboxDelegate({ orgId: org, ownerActorId: owner, delegateActorId: delegate }),
    ).resolves.toBe(true);
    await database`update actors set disabled_at = null where id = ${delegate}`;

    const events = await database<{ readonly event_type: string }[]>`
      select event_type from mail_address_events
      where object_id = ${grantId} order by created_at
    `;
    expect(events.map((event) => event.event_type)).toEqual([
      "delegate_granted",
      "delegate_revoked",
    ]);
  });

  it("blocks external forwarding by default and rejects forwarding cycles", async () => {
    await database`
      insert into mail_aliases (org_id, actor_id, email) values
        (${org}, ${owner}, ${`route-a@${domain}`}),
        (${org}, ${owner}, ${`route-b@${domain}`})
    `;
    await expect(
      database`
        insert into mail_inbound_routing_rules (
          org_id, name, match, action_kind, action, created_by
        ) values (
          ${org}, 'blocked external',
          ${database.json({ recipientPattern: `route-a@${domain}` })}, 'forward',
          ${database.json({ forwardTo: "person@blocked.example" })}, ${owner}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await database`
      insert into admin_security_policies (org_id, policy_type, enabled, settings, updated_by)
      values (
        ${org}, 'external_sharing', true,
        ${database.json({ mode: "allowlist", allowedDomains: ["allowed.example"] })}, ${owner}
      )
    `;
    await database`
      insert into mail_inbound_routing_rules (
        org_id, name, match, action_kind, action, created_by
      ) values (
        ${org}, 'allowed external',
        ${database.json({ recipientPattern: `route-a@${domain}` })}, 'forward',
        ${database.json({ forwardTo: "person@allowed.example" })}, ${owner}
      )
    `;
    await database`
      insert into mail_inbound_routing_rules (
        org_id, name, match, action_kind, action, created_by
      ) values (
        ${org}, 'route a to b',
        ${database.json({ recipientPattern: `route-a@${domain}` })}, 'forward',
        ${database.json({ forwardTo: `route-b@${domain}` })}, ${owner}
      )
    `;
    await expect(
      database`
        insert into mail_inbound_routing_rules (
          org_id, name, match, action_kind, action, created_by
        ) values (
          ${org}, 'route b to a',
          ${database.json({ recipientPattern: `route-b@${domain}` })}, 'forward',
          ${database.json({ forwardTo: `route-a@${domain}` })}, ${owner}
        )
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
