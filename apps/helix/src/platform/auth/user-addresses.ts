import type postgres from "postgres";
import { BadRequestError, ConflictError, NotFoundError } from "../../api/api-error.js";
import { eligibleMailAddressDomains } from "../admin/domain-identity.js";
import { normalizeMailboxAddress } from "../mail/address-normalization.js";
import { MailRoutingStore } from "../mail/store-routing.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";

interface UserMailAddress {
  id: string | null;
  address: string;
  displayName: string | null;
  isPrimary: boolean;
  receiveEnabled: boolean;
  sendAsEnabled: boolean;
  source: "primary" | "alias" | "domain_alias";
}
export interface UserMailAddresses {
  actorId: string;
  primaryEmail: string | null;
  loginEmail: string | null;
  addresses: UserMailAddress[];
  eligibleDomains: { domain: string; primary: boolean; aliases: boolean }[];
}
export interface UserAliasModes {
  receiveEnabled?: boolean | undefined;
  sendAsEnabled?: boolean | undefined;
}
interface MemberRow {
  email: string | null;
  display_name: string;
}

/** Tenant mailbox addresses never rename a person's global login identity. */
export class PostgresUserAddressStore {
  constructor(private readonly sql: postgres.Sql) {}

  async get(orgId: string, actorId: string): Promise<UserMailAddresses | null> {
    const [member] = await this.sql<(MemberRow & { login_email: string | null })[]>`
      select actor.email, actor.display_name,
        (select auth_user.email from identity_provider_subjects link
          join "user" auth_user on auth_user.id = link.provider_subject
          where link.subject_id = membership.subject_id and link.provider = 'better-auth'
          order by link.created_at, link.provider_subject limit 1) as login_email
      from actors actor
      join organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      where actor.org_id = ${orgId} and actor.id = ${actorId}
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
    `;
    if (member === undefined) return null;
    const rows = await this.sql<
      {
        id: string | null;
        address: string;
        display_name: string | null;
        receive_enabled: boolean;
        source: UserMailAddress["source"];
      }[]
    >`
      select null::uuid as id, ${member.email}::text as address,
        ${member.display_name}::text as display_name,
        exists (select 1 from admin_domains domain
          where domain.org_id = ${orgId} and domain.domain = split_part(${member.email}, '@', 2)
            and domain.status = 'verified' and domain.identity_enabled and domain.mail_enabled)
          as receive_enabled, 'primary'::text as source
      where ${member.email}::text is not null
      union all
      select alias.id, lower(alias.email), alias.display_name,
        alias.receive_enabled and exists (select 1 from admin_domains domain
          where domain.org_id = alias.org_id and domain.domain = split_part(lower(alias.email), '@', 2)
            and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled),
        'alias'::text
      from mail_aliases alias
      where alias.org_id = ${orgId} and alias.actor_id = ${actorId}
        and alias.enabled and alias.disabled_at is null
      union all
      select null::uuid, split_part(${member.email}, '@', 1) || '@' || source.domain,
        ${member.display_name}::text, true, 'domain_alias'::text
      from admin_domains source
      join admin_domains target on target.org_id = source.org_id and target.id = source.alias_target_domain_id
      where source.org_id = ${orgId} and source.status = 'verified'
        and source.identity_mode = 'alias' and source.identity_enabled
        and source.mail_enabled and source.aliases_enabled
        and target.status = 'verified' and target.identity_enabled and target.identity_mode = 'secondary'
        and target.domain = split_part(${member.email}, '@', 2)
      order by address
    `;
    const routing = new MailRoutingStore(this.sql);
    const addresses = await Promise.all(
      rows.map(async (row): Promise<UserMailAddress> => ({
        id: row.id,
        address: row.address,
        displayName: row.display_name,
        isPrimary: row.source === "primary",
        receiveEnabled: row.receive_enabled,
        sendAsEnabled:
          (await routing.resolveAuthorizedSender(orgId, actorId, row.address)) !== null,
        source: row.source,
      })),
    );
    addresses.sort(
      (a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.address.localeCompare(b.address),
    );
    const eligibleDomains = await eligibleMailAddressDomains(this.sql, orgId);
    const unique = new Map<string, UserMailAddress>();
    for (const address of addresses)
      if (!unique.has(address.address)) unique.set(address.address, address);
    return {
      actorId,
      primaryEmail: member.email,
      loginEmail: member.login_email,
      addresses: [...unique.values()],
      eligibleDomains: [...eligibleDomains],
    };
  }

  async create(
    orgId: string,
    actorId: string,
    input: UserAliasModes & { address: string },
  ): Promise<UserMailAddresses> {
    const address = canonicalAddress(input.address);
    return this.mutate(orgId, actorId, async (tx) => {
      await eligibleDomain(tx, orgId, address, false);
      await tx`insert into mail_aliases (org_id, actor_id, email, receive_enabled, send_as_enabled)
        values (${orgId}, ${actorId}, ${address}, ${input.receiveEnabled ?? true}, ${input.sendAsEnabled ?? true})`;
    });
  }

  async update(
    orgId: string,
    actorId: string,
    id: string,
    input: UserAliasModes,
  ): Promise<UserMailAddresses> {
    return this.mutate(orgId, actorId, async (tx) => {
      if (input.receiveEnabled === true || input.sendAsEnabled === true) {
        const [alias] = await tx<{ email: string }[]>`select email from mail_aliases
          where org_id = ${orgId} and actor_id = ${actorId} and id = ${id}
            and enabled and disabled_at is null for update`;
        if (alias === undefined) throw new NotFoundError("Additional email address not found.");
        await eligibleDomain(tx, orgId, alias.email, false);
      }
      const rows = await tx`update mail_aliases set
        receive_enabled = coalesce(${input.receiveEnabled ?? null}, receive_enabled),
        send_as_enabled = coalesce(${input.sendAsEnabled ?? null}, send_as_enabled), updated_at = now()
        where org_id = ${orgId} and actor_id = ${actorId} and id = ${id}
          and enabled and disabled_at is null returning id`;
      if (rows.length === 0) throw new NotFoundError("Additional email address not found.");
    });
  }

  async remove(orgId: string, actorId: string, id: string): Promise<UserMailAddresses> {
    return this.mutate(orgId, actorId, async (tx) => {
      const rows =
        await tx`update mail_aliases set enabled = false, disabled_at = now(), updated_at = now()
        where org_id = ${orgId} and actor_id = ${actorId} and id = ${id}
          and enabled and disabled_at is null returning id`;
      if (rows.length === 0) throw new NotFoundError("Additional email address not found.");
    });
  }

  async setPrimary(
    orgId: string,
    actorId: string,
    input: { address: string },
  ): Promise<UserMailAddresses> {
    const address = canonicalAddress(input.address);
    return this.mutate(orgId, actorId, async (tx, member) => {
      if (member.email === address) return;
      await eligibleDomain(tx, orgId, address, true);
      if (member.email !== null) await eligibleDomain(tx, orgId, member.email, false);
      // Promotion releases only this user's alias; shared namespace constraints reject all other collisions.
      await tx`update mail_aliases set enabled = false, disabled_at = now(), updated_at = now()
        where org_id = ${orgId} and actor_id = ${actorId} and lower(email) = ${address}
          and disabled_at is null`;
      await tx`update actors set email = ${address}, updated_at = now()
        where org_id = ${orgId} and id = ${actorId}`;
      if (member.email !== null) {
        await tx`insert into mail_aliases (org_id, actor_id, email, receive_enabled, send_as_enabled)
          values (${orgId}, ${actorId}, ${member.email}, true, true)`;
      }
    });
  }

  private async mutate(
    orgId: string,
    actorId: string,
    change: (tx: postgres.TransactionSql, member: MemberRow) => Promise<void>,
  ): Promise<UserMailAddresses> {
    try {
      return await withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
        const [member] = await tx<MemberRow[]>`
          select actor.email, actor.display_name from actors actor
          join organization_memberships membership on membership.org_id = actor.org_id and membership.actor_id = actor.id
          where actor.org_id = ${orgId} and actor.id = ${actorId} and actor.type = 'user'
            and actor.disabled_at is null and membership.status = 'active' and membership.guest_type = 'member'
          for no key update of actor
        `;
        if (member === undefined) throw new NotFoundError("Active member mailbox not found.");
        await change(tx, member);
        // Check deferred shared-namespace constraints before the HTTP response/audit commits.
        await tx`set constraints actors_address_guard, mail_aliases_address_guard immediate`;
        await tx`set constraints actors_address_guard, mail_aliases_address_guard deferred`;
        const result = await new PostgresUserAddressStore(tenantAwarePostgresSql(this.sql)).get(
          orgId,
          actorId,
        );
        if (result === null) throw new NotFoundError("Active member mailbox not found.");
        return result;
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if (error.code === "23505")
          throw new ConflictError("This address is already assigned to a user, alias, or group.");
        if (error.code === "23514")
          throw new BadRequestError(
            "Choose an eligible verified domain and enable receiving or sending, or remove the additional address.",
          );
      }
      throw error;
    }
  }
}

function canonicalAddress(address: string): string {
  try {
    return normalizeMailboxAddress(address.trim()).address;
  } catch {
    throw new BadRequestError("Enter a valid email address.");
  }
}

async function eligibleDomain(
  tx: postgres.TransactionSql,
  orgId: string,
  address: string,
  primary: boolean,
): Promise<void> {
  const rows = await tx`select id from admin_domains where org_id = ${orgId}
    and domain = split_part(${address}, '@', 2) and status = 'verified' and mail_enabled
    and case when ${primary} then identity_enabled and identity_mode = 'secondary' else aliases_enabled end
    for share`;
  if (rows.length === 0)
    throw new BadRequestError(
      primary
        ? "Primary mail addresses require a verified secondary domain with identity and mail enabled."
        : "Additional addresses require a verified domain with mail and aliases enabled; enable these on the former primary domain before changing it.",
    );
}
