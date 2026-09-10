import type { JsonObject } from "@helix/sdk-types";
import type postgres from "postgres";
import { MailInboundQuotaExceededError } from "./errors.js";
import { normalizeAddress } from "./store-addresses.js";
import { type MailboxDelegateRecord } from "./store-contracts.js";
import type {
  MailAliasRecord,
  MailInboundAddressResolution,
  MailInboundRecipient,
  MailInboundRoutingAction,
  MailInboundRoutingRule,
} from "./types.js";

interface MailboxDelegateRow {
  readonly id: string;
  readonly actor_id: string;
  readonly valid_from: Date;
  readonly expires_at: Date | null;
  readonly created_at: Date;
}

interface InboundRoutingRuleRow {
  readonly id: string;
  readonly org_id: string;
  readonly priority: number;
  readonly match: JsonObject;
  readonly action_kind: MailInboundRoutingAction;
  readonly action: JsonObject;
  readonly target_actor_id: string | null;
  readonly target_address: string | null;
  readonly target_quota_exceeded: boolean | null;
  readonly source_actor_id: string | null;
  readonly source_address: string | null;
}

interface MailAliasRow {
  readonly id: string;
  readonly org_id: string;
  readonly actor_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly is_primary: boolean;
  readonly receive_enabled: boolean;
  readonly send_as_enabled: boolean;
  readonly created_at: Date;
}

function mapAlias(row: MailAliasRow): MailAliasRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    actorId: row.actor_id,
    email: row.email,
    displayName: row.display_name,
    isPrimary: row.is_primary,
    receiveEnabled: row.receive_enabled,
    sendAsEnabled: row.send_as_enabled,
    createdAt: row.created_at,
  };
}

function mapMailboxDelegate(row: MailboxDelegateRow | undefined): MailboxDelegateRecord {
  if (row === undefined) {
    throw new Error("Unable to persist mailbox delegate.");
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    validFrom: row.valid_from,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function emailDomain(address: string): string | null {
  const separator = address.lastIndexOf("@");
  return separator > 0 && separator < address.length - 1 ? address.slice(separator + 1) : null;
}
export class MailRoutingStore {
  constructor(private readonly sql: postgres.Sql) {}

  async resolveInboundRecipient(address: string): Promise<MailInboundRecipient | null> {
    const recipients = await this.resolveInboundRecipients(address);
    return recipients.length === 1 ? (recipients[0] ?? null) : null;
  }

  async resolveInboundRecipients(address: string): Promise<readonly MailInboundRecipient[]> {
    const normalized = normalizeAddress(address);
    const domain = emailDomain(normalized);
    if (domain === null) {
      return [];
    }
    const rows = await this.sql<
      {
        readonly org_id: string;
        readonly actor_id: string;
        readonly address: string;
        readonly quota_exceeded: boolean;
      }[]
    >`
      select org_id, actor_id, address, quota_exceeded
      from helix_resolve_inbound_mailboxes(${normalized}, ${domain})
    `;
    if (rows.some((recipient) => recipient.quota_exceeded)) {
      throw new MailInboundQuotaExceededError();
    }
    return rows.map((recipient) => ({
      orgId: recipient.org_id,
      actorId: recipient.actor_id,
      address: recipient.address,
    }));
  }

  async resolveInboundAddress(address: string): Promise<MailInboundAddressResolution> {
    const normalized = normalizeAddress(address);
    const domain = emailDomain(normalized);
    if (domain === null) return { address: normalized, recipients: [], rules: [] };

    const [recipients, rows] = await Promise.all([
      this.resolveInboundRecipients(normalized),
      this.sql<InboundRoutingRuleRow[]>`
        select * from helix_resolve_inbound_routing_rules(${normalized}, ${domain})
      `,
    ]);
    if (rows.some((row) => row.target_quota_exceeded === true)) {
      throw new MailInboundQuotaExceededError();
    }
    const rules = new Map<string, MailInboundRoutingRule>();
    for (const row of rows) {
      const current = rules.get(row.id);
      const targetRecipients = [
        ...(current?.targetRecipients ?? []),
        ...(row.target_actor_id === null || row.target_address === null
          ? []
          : [{ orgId: row.org_id, actorId: row.target_actor_id, address: row.target_address }]),
      ];
      rules.set(row.id, {
        id: row.id,
        orgId: row.org_id,
        priority: row.priority,
        match: row.match,
        actionKind: row.action_kind,
        action: row.action,
        targetRecipients,
        ...(row.source_actor_id === null || row.source_address === null
          ? {}
          : {
              sourceRecipient: {
                orgId: row.org_id,
                actorId: row.source_actor_id,
                address: row.source_address,
              },
            }),
      });
    }
    return { address: normalized, recipients, rules: [...rules.values()] };
  }

  async grantMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
    readonly expiresAt?: Date | null;
  }): Promise<MailboxDelegateRecord> {
    const rows = await this.sql<MailboxDelegateRow[]>`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id,
        valid_from, expires_at
      )
      values (
        ${input.orgId}, ${input.delegateActorId}, 'mailbox', ${input.ownerActorId},
        'manager', ${input.ownerActorId}, now(), ${input.expiresAt ?? null}
      )
      on conflict (org_id, resource_id, actor_id)
        where resource_type = 'mailbox' and status = 'active'
      do update set
        valid_from = now(),
        expires_at = excluded.expires_at,
        updated_at = now()
      returning id, actor_id, valid_from, expires_at, created_at
    `;
    return mapMailboxDelegate(rows[0]);
  }

  async listMailboxDelegates(
    orgId: string,
    ownerActorId: string,
  ): Promise<readonly MailboxDelegateRecord[]> {
    const rows = await this.sql<MailboxDelegateRow[]>`
      select id, actor_id, valid_from, expires_at, created_at
      from permissions
      where org_id = ${orgId}
        and resource_type = 'mailbox'
        and resource_id = ${ownerActorId}
        and role = 'manager'
        and status = 'active'
        and valid_from <= now()
        and (expires_at is null or expires_at > now())
        and revoked_at is null
      order by created_at, actor_id
    `;
    return rows.map(mapMailboxDelegate);
  }

  async revokeMailboxDelegate(input: {
    readonly orgId: string;
    readonly ownerActorId: string;
    readonly delegateActorId: string;
  }): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      update permissions
      set
        status = 'revoked',
        revoked_at = now(),
        revocation_epoch = revocation_epoch + 1,
        updated_at = now()
      where org_id = ${input.orgId}
        and resource_type = 'mailbox'
        and resource_id = ${input.ownerActorId}
        and actor_id = ${input.delegateActorId}
        and status = 'active'
      returning id
    `;
    return rows.length > 0;
  }

  async findActorByAddress(
    orgId: string,
    address: string,
  ): Promise<{ readonly actorId: string; readonly email: string } | null> {
    const normalized = normalizeAddress(address);
    const rows = await this.sql<{ readonly id: string; readonly email: string }[]>`
      with requested as (
        select ${normalized}::text as address,
               split_part(${normalized}, '@', 2) as domain,
               helix_canonical_login_email(${orgId}, ${normalized}) as canonical
      )
      select actor.id, actor.email
      from requested
      join admin_domains domain
        on domain.org_id = ${orgId} and domain.domain = requested.domain
      join actors actor on actor.org_id = ${orgId}
      join organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      where requested.canonical is not null
        and domain.status = 'verified' and domain.identity_enabled and domain.mail_enabled
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
        and lower(actor.email) = requested.canonical
      union all
      select alias.actor_id as id, alias.email
      from requested
      join mail_aliases alias
        on alias.org_id = ${orgId} and lower(alias.email) = requested.address
      join actors actor on actor.id = alias.actor_id and actor.org_id = alias.org_id
      join organization_memberships membership
        on membership.org_id = actor.org_id and membership.actor_id = actor.id
      join admin_domains domain
        on domain.org_id = alias.org_id and domain.domain = requested.domain
      where alias.enabled and alias.disabled_at is null and alias.receive_enabled
        and actor.type = 'user' and actor.disabled_at is null
        and membership.status = 'active' and membership.guest_type = 'member'
        and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
      limit 2
    `;
    const row = rows[0];
    return rows.length !== 1 || row === undefined ? null : { actorId: row.id, email: row.email };
  }

  async resolveAuthorizedSender(
    orgId: string,
    actorId: string,
    address: string,
  ): Promise<string | null> {
    const normalized = normalizeAddress(address);
    const rows = await this.sql<{ readonly address: string }[]>`
      with member as (
        select actor.email, actor.type as actor_type
        from actors actor
        where actor.org_id = ${orgId} and actor.id = ${actorId}
          and helix_mailbox_principal_is_active(actor.org_id, actor.id)
      )
      select ${normalized}::text as address
      from member
      where (
        lower(member.email) = ${normalized}
        and exists (
          select 1 from admin_domains domain
          where domain.org_id = ${orgId}
            and domain.domain = split_part(${normalized}, '@', 2)
            and domain.status = 'verified' and domain.mail_enabled
            and (domain.identity_enabled or member.actor_type in ('agent', 'service_account'))
        )
      ) or exists (
        select 1 from mail_aliases alias
        left join admin_domains domain
          on domain.org_id = alias.org_id
         and domain.domain = split_part(lower(alias.email), '@', 2)
        where alias.org_id = ${orgId} and alias.actor_id = ${actorId}
          and alias.enabled and alias.disabled_at is null and alias.send_as_enabled
          and lower(alias.email) = ${normalized}
          and domain.status = 'verified' and domain.mail_enabled and domain.aliases_enabled
      ) or exists (
        select 1
        from admin_domains source
        join admin_domains target
          on target.id = source.alias_target_domain_id and target.org_id = source.org_id
        where source.org_id = ${orgId}
          and source.domain = split_part(${normalized}, '@', 2)
          and source.status = 'verified' and source.identity_mode = 'alias'
          and source.identity_enabled and source.mail_enabled and source.aliases_enabled
          and target.status = 'verified' and target.identity_enabled
          and target.domain = split_part(lower(member.email), '@', 2)
          and split_part(${normalized}, '@', 1) = split_part(lower(member.email), '@', 1)
      )
      limit 1
    `;
    return rows[0]?.address ?? null;
  }

  async listAliases(orgId: string, actorId?: string): Promise<readonly MailAliasRecord[]> {
    const rows =
      actorId === undefined
        ? await this.sql<MailAliasRow[]>`
            select * from mail_aliases
            where org_id = ${orgId}
              and disabled_at is null
            order by is_primary desc, lower(email) asc
          `
        : await this.sql<MailAliasRow[]>`
            select * from mail_aliases
            where org_id = ${orgId}
              and actor_id = ${actorId}
              and disabled_at is null
            order by is_primary desc, lower(email) asc
          `;
    return rows.map(mapAlias);
  }

  async createAlias(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly email: string;
    readonly displayName?: string | null;
    readonly isPrimary?: boolean;
    readonly receiveEnabled?: boolean;
    readonly sendAsEnabled?: boolean;
  }): Promise<MailAliasRecord> {
    const rows = await this.sql<MailAliasRow[]>`
      insert into mail_aliases (
        org_id, actor_id, email, display_name, is_primary, enabled,
        receive_enabled, send_as_enabled
      )
      values (
        ${input.orgId},
        ${input.actorId},
        ${input.email},
        ${input.displayName ?? null},
        ${input.isPrimary ?? false},
        true,
        ${input.receiveEnabled ?? true},
        ${input.sendAsEnabled ?? true}
      )
      returning *
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Failed to create mail alias.");
    }
    return mapAlias(row);
  }

  async deleteAlias(input: { readonly orgId: string; readonly id: string }): Promise<boolean> {
    const rows = await this.sql<{ readonly id: string }[]>`
      update mail_aliases
      set disabled_at = now(), enabled = false, updated_at = now()
      where id = ${input.id}
        and org_id = ${input.orgId}
        and disabled_at is null
      returning id
    `;
    return rows[0] !== undefined;
  }
}
