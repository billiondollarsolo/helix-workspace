import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMailStore } from "../mail/index.js";

const databaseUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
const orgA = "da260000-0000-4000-8000-000000000001";
const orgB = "da260000-0000-4000-8000-000000000002";
const actorA = "da260000-0000-4000-8000-000000000011";
const actorB = "da260000-0000-4000-8000-000000000012";
const alpha = "da260000-0000-4000-8000-000000000021";
const beta = "da260000-0000-4000-8000-000000000022";
const alias = "da260000-0000-4000-8000-000000000023";
const foreignClaim = "da260000-0000-4000-8000-000000000024";
const permission = "da260000-0000-4000-8000-000000000031";
const foreignProvider = "da260000-0000-4000-8000-000000000041";
const alphaName = "iam26-alpha.example.com";
const betaName = "iam26-beta.example.com";
const aliasName = "iam26-alias.example.com";

describe("multi-domain aggregate lifecycle", { skip: databaseUrl === undefined }, () => {
  let sql: postgres.Sql;
  let mail: PostgresMailStore;

  beforeAll(async () => {
    if (databaseUrl === undefined) throw new Error("Database URL is required.");
    sql = postgres(databaseUrl, { max: 4, prepare: false });
    const ready = await sql<{ readonly ready: boolean }[]>`
      select to_regprocedure('helix_set_domain_capabilities(uuid,uuid,boolean,boolean,boolean,boolean,boolean,uuid,text,uuid,uuid)') is not null as ready
    `;
    if (ready[0]?.ready !== true) throw new Error("Run migrations through 0103 first.");
    await cleanup();
    await sql`
      insert into orgs (id, slug, display_name, status)
      values
        (${orgA}, 'domain-aggregate-a', 'Domain aggregate A', 'active'),
        (${orgB}, 'domain-aggregate-b', 'Domain aggregate B', 'active')
    `;
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes)
      values
        (${actorA}, ${orgA}, 'user', ${`alice@${alphaName}`}, 'Alice', array['mail.send']),
        (${actorB}, ${orgB}, 'user', 'owner@outside.example.com', 'Owner B', array['admin.*'])
    `;
    await sql`
      insert into mail_outbound_providers (id, org_id, name, kind, created_by)
      values (${foreignProvider}, ${orgB}, 'Foreign provider', 'smtp', ${actorB})
    `;
    await sql`
      insert into admin_domains (
        id, org_id, domain, verification_host, verification_value,
        verification_expires_at, created_by
      ) values
        (${alpha}, ${orgA}, ${alphaName}, ${`_verify.${alphaName}`}, 'alpha', now() + interval '1 day', ${actorA}),
        (${beta}, ${orgA}, ${betaName}, ${`_verify.${betaName}`}, 'beta', now() + interval '1 day', ${actorA}),
        (${alias}, ${orgA}, ${aliasName}, ${`_verify.${aliasName}`}, 'alias', now() + interval '1 day', ${actorA})
    `;
    mail = new PostgresMailStore(sql);
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("keeps claims exclusive and identity, SSO, mail, sharing, rename, and release coherent", async () => {
    await expect(
      sql`
        insert into admin_domains (
          id, org_id, domain, verification_host, verification_value,
          verification_expires_at, created_by
        ) values (
          ${foreignClaim}, ${orgB}, ${alphaName}, '_verify.foreign', 'foreign',
          now() + interval '1 day', ${actorB}
        )
      `,
    ).rejects.toMatchObject({ code: "23505" });

    for (const id of [alpha, beta, alias]) {
      await sql`select helix_record_domain_verification(${orgA}, ${id}, true, ${actorA})`;
      const [verified] = await sql<
        {
          readonly identity_enabled: boolean;
          readonly mail_enabled: boolean;
          readonly aliases_enabled: boolean;
          readonly custom_host_enabled: boolean;
          readonly federation_enabled: boolean;
        }[]
      >`
        select identity_enabled, mail_enabled, aliases_enabled,
               custom_host_enabled, federation_enabled
        from admin_domains where id = ${id}
      `;
      expect(verified).toEqual({
        identity_enabled: false,
        mail_enabled: false,
        aliases_enabled: false,
        custom_host_enabled: false,
        federation_enabled: false,
      });
      await sql`
        select helix_set_domain_capabilities(
          ${orgA}, ${id}, true, true, true, true, true, null,
          ${id === alias ? "alias" : "secondary"}, ${id === alias ? alpha : null}, ${actorA}
        )
      `;
    }
    await expect(
      sql`
        select helix_set_domain_capabilities(
          ${orgA}, ${alpha}, true, true, true, true, true, ${foreignProvider},
          'secondary', null, ${actorA}
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });
    await sql`
      insert into tenant_idp_configs (org_id, protocol, display_name)
      values (${orgA}, 'saml', 'Corporate SSO')
    `;
    await sql`
      insert into permissions (id, org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
      values (${permission}, ${orgA}, ${actorA}, 'document', gen_random_uuid(), 'editor', ${actorA})
    `;
    await sql`
      insert into admin_groups (org_id, name, email, kind, created_by)
      values (${orgA}, 'Team', ${`team@${betaName}`}, 'mailing_list', ${actorA})
    `;
    await expect(
      sql`
        insert into mail_aliases (org_id, actor_id, email)
        values (${orgA}, ${actorA}, ${`alice@${aliasName}`})
      `,
    ).rejects.toMatchObject({ code: "23505" });
    await sql`
      insert into mail_aliases (org_id, actor_id, email)
      values (${orgA}, ${actorA}, ${`support@${aliasName}`})
    `;

    const discovery = await sql<
      { readonly org_slug: string; readonly canonical_email: string; readonly protocol: string }[]
    >`select * from helix_discover_domain_identity(${`alice@${aliasName}`})`;
    expect(discovery).toEqual([
      {
        org_id: orgA,
        org_slug: "domain-aggregate-a",
        canonical_email: `alice@${alphaName}`,
        protocol: "saml",
      },
    ]);
    expect(await inbound(`alice@${aliasName}`)).toMatchObject({ actor_id: actorA });
    expect(await inbound(`support@${aliasName}`)).toMatchObject({ actor_id: actorA });
    await expect(mail.resolveAuthorizedSender(orgA, actorA, `alice@${aliasName}`)).resolves.toBe(
      `alice@${aliasName}`,
    );
    await sql`select helix_quarantine_domain(${orgA}, ${alias}, ${actorA})`;
    await expect(inbound(`alice@${aliasName}`)).resolves.toBeUndefined();
    await expect(
      mail.resolveAuthorizedSender(orgA, actorA, `alice@${aliasName}`),
    ).resolves.toBeNull();
    await sql`select helix_record_domain_verification(${orgA}, ${alias}, true, ${actorA})`;
    await sql`
      select helix_set_domain_capabilities(
        ${orgA}, ${alias}, true, true, true, true, true, null, 'alias', ${alpha}, ${actorA}
      )
    `;

    await Promise.all([
      sql`select helix_set_primary_domain(${orgA}, ${beta}, ${actorA})`,
      sql`select helix_set_primary_domain(${orgA}, ${beta}, ${actorA})`,
    ]);
    await expect(primaryIds()).resolves.toEqual([beta]);
    const transitions = await sql<{ readonly id: string }[]>`
      select id from admin_domain_primary_transitions
      where org_id = ${orgA} and from_domain_id = ${alpha} and to_domain_id = ${beta}
      order by changed_at desc limit 1
    `;
    expect(transitions).toHaveLength(1);
    const transition = transitions[0];
    if (transition === undefined) throw new Error("Primary transition was not recorded.");
    await expect(
      sql`select helix_set_primary_domain(${orgA}, ${alpha}, ${actorA})`,
    ).rejects.toThrow("domain_primary_cooldown");
    await sql`select helix_rollback_primary_domain(${orgA}, ${transition.id}, ${actorA})`;
    await expect(primaryIds()).resolves.toEqual([alpha]);

    await sql`
      update admin_domain_primary_transitions
      set changed_at = now() - interval '2 hours'
      where id = ${transition.id}
    `;
    await sql`select helix_set_primary_domain(${orgA}, ${beta}, ${actorA})`;
    await sql.begin(async (tx) => {
      await tx`update actors set email = ${`alice@${betaName}`} where id = ${actorA}`;
      await tx`
        update identity_subjects subject
        set canonical_email = ${`alice@${betaName}`}, updated_at = now()
        from organization_memberships membership
        where membership.subject_id = subject.id and membership.actor_id = ${actorA}
      `;
    });
    await sql`
      select helix_set_domain_capabilities(
        ${orgA}, ${alias}, true, true, true, true, true, null, 'alias', ${beta}, ${actorA}
      )
    `;
    await sql`
      select helix_set_domain_capabilities(
        ${orgA}, ${alpha}, true, true, true, true, true, null, 'alias', ${beta}, ${actorA}
      )
    `;
    expect(await inbound(`alice@${alphaName}`)).toMatchObject({ actor_id: actorA });
    await expect(mail.resolveAuthorizedSender(orgA, actorA, `alice@${alphaName}`)).resolves.toBe(
      `alice@${alphaName}`,
    );
    const grants = await sql<{ readonly status: string }[]>`
      select status from permissions where id = ${permission}
    `;
    expect(grants).toEqual([{ status: "active" }]);

    await sql`
      update organization_memberships
      set status = 'deprovisioned', suspended_at = null, ended_at = now()
      where actor_id = ${actorA}
    `;
    await expect(inbound(`alice@${alphaName}`)).resolves.toBeUndefined();
    await expect(
      mail.resolveAuthorizedSender(orgA, actorA, `alice@${alphaName}`),
    ).resolves.toBeNull();

    await sql`select helix_release_domain(${orgA}, ${alpha})`;
    await expect(
      sql`
        insert into admin_domains (
          id, org_id, domain, verification_host, verification_value,
          verification_expires_at, created_by
        ) values (
          ${foreignClaim}, ${orgB}, ${alphaName}, '_verify.foreign', 'foreign',
          now() + interval '1 day', ${actorB}
        )
      `,
    ).rejects.toThrow("domain_acquisition_cooldown");
    await sql`update admin_domains set claimable_after = now() - interval '1 second' where id = ${alpha}`;
    await expect(
      sql`
        insert into admin_domains (
          id, org_id, domain, verification_host, verification_value,
          verification_expires_at, created_by
        ) values (
          ${foreignClaim}, ${orgB}, ${alphaName}, '_verify.foreign', 'foreign',
          now() + interval '1 day', ${actorB}
        )
      `,
    ).resolves.toBeDefined();
    await sql`
      select helix_record_domain_verification(${orgB}, ${foreignClaim}, true, ${actorB})
    `;
    await sql`
      select helix_set_domain_capabilities(
        ${orgB}, ${foreignClaim}, false, true, true, false, false, null,
        'secondary', null, ${actorB}
      )
    `;
    await sql`
      insert into mail_aliases (org_id, actor_id, email)
      values (${orgB}, ${actorB}, ${`support@${alphaName}`})
    `;
    expect(await inbound(`support@${alphaName}`)).toMatchObject({ actor_id: actorB });
    await sql`
      select helix_set_domain_capabilities(
        ${orgB}, ${foreignClaim}, true, true, true, false, false, null,
        'secondary', null, ${actorB}
      )
    `;
  });

  it("exposes the aggregate and transition audit only inside the runtime tenant context", async () => {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`
        select set_config('helix.org_id', ${orgA}, true),
               set_config('helix.actor_id', ${actorA}, true)
      `;
      const domains = await tx<{ readonly org_id: string }[]>`
        select org_id from admin_domains order by domain
      `;
      const foreignTransitions = await tx<{ readonly count: number }[]>`
        select count(*)::integer as count
        from admin_domain_primary_transitions where org_id = ${orgB}
      `;
      const canonical = await tx<{ readonly email: string | null }[]>`
        select helix_canonical_login_email(${orgA}, ${`alice@${aliasName}`}) as email
      `;
      return { domains, foreignTransitions, canonical };
    });

    expect(result.domains.every((domain) => domain.org_id === orgA)).toBe(true);
    expect(result.foreignTransitions).toEqual([{ count: 0 }]);
    expect(result.canonical).toEqual([{ email: `alice@${betaName}` }]);
  });

  async function inbound(address: string) {
    const rows = await sql<{ readonly actor_id: string }[]>`
      select actor_id from helix_resolve_inbound_mailbox(
        ${address}, ${address.slice(address.lastIndexOf("@") + 1)}
      )
    `;
    return rows[0];
  }

  async function primaryIds(): Promise<string[]> {
    const rows = await sql<{ readonly id: string }[]>`
      select id from admin_domains where org_id = ${orgA} and is_primary
    `;
    return rows.map((row) => row.id);
  }

  async function cleanup(): Promise<void> {
    await sql`delete from permissions where id = ${permission}`;
    await sql`delete from mail_aliases where org_id in (${orgA}, ${orgB})`;
    await sql`delete from admin_groups where org_id = ${orgA}`;
    await sql`delete from tenant_idp_configs where org_id = ${orgA}`;
    await sql`delete from admin_domain_primary_transitions where org_id in (${orgA}, ${orgB})`;
    await sql`
      delete from admin_domains
      where id in (${alpha}, ${beta}, ${alias}, ${foreignClaim})
    `;
    await sql`delete from mail_outbound_providers where id = ${foreignProvider}`;
    await sql`delete from actors where id in (${actorA}, ${actorB})`;
    await sql`
      delete from identity_subjects
      where canonical_email in (
        ${`alice@${alphaName}`}, ${`alice@${betaName}`}, 'owner@outside.example.com'
      )
    `;
    await sql`delete from orgs where id in (${orgA}, ${orgB})`;
  }
});
