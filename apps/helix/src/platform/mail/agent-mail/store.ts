import type postgres from "postgres";
import { withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { isUniqueViolation } from "../../util/sql.js";
import { normalizeMailboxAddress } from "../address-normalization.js";
import {
  DEFAULT_AGENT_MAIL_POLICY,
  type AgentMailPolicy,
  type AgentMailReceiveMode,
} from "./policy.js";

/** An agent or service account, its mail address, and who may write to it. */
export interface AgentMailbox extends AgentMailPolicy {
  readonly id: string;
  readonly displayName: string;
  readonly type: "agent" | "service_account";
  readonly disabled: boolean;
  readonly address: string | null;
}

export type AgentMailErrorCode =
  "not_an_agent" | "invalid_address" | "domain_not_eligible" | "address_taken";

export class AgentMailError extends Error {
  constructor(readonly code: AgentMailErrorCode) {
    super(code);
    this.name = "AgentMailError";
  }
}

interface MailboxRow {
  readonly id: string;
  readonly display_name: string;
  readonly type: AgentMailbox["type"];
  readonly disabled_at: Date | null;
  readonly email: string | null;
  readonly receive_mode: AgentMailReceiveMode | null;
  readonly allowed_senders: readonly string[] | null;
}

function toMailbox(row: MailboxRow): AgentMailbox {
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.type,
    disabled: row.disabled_at !== null,
    address: row.email?.toLowerCase() ?? null,
    receiveMode: row.receive_mode ?? DEFAULT_AGENT_MAIL_POLICY.receiveMode,
    allowedSenders: row.allowed_senders ?? DEFAULT_AGENT_MAIL_POLICY.allowedSenders,
  };
}

export interface SaveAgentMailboxInput extends AgentMailPolicy {
  readonly orgId: string;
  /** The administrator making the change. */
  readonly actorId: string;
  readonly agentId: string;
  /** `null` takes the address away; mail already received stays. */
  readonly address: string | null;
}

export class PostgresAgentMailStore {
  constructor(private readonly sql: postgres.Sql) {}

  /** Every agent and service account, with the domains an address may use. */
  list(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<{ readonly agents: AgentMailbox[]; readonly domains: string[] }> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const agents = await tx<MailboxRow[]>`
        select actor.id, actor.display_name, actor.type, actor.disabled_at, actor.email,
          policy.receive_mode, policy.allowed_senders
        from actors actor
        left join agent_mail_policies policy
          on policy.org_id = actor.org_id and policy.actor_id = actor.id
        where actor.org_id = ${input.orgId} and actor.type in ('agent', 'service_account')
        order by actor.display_name, actor.id
        limit 500
      `;
      const domains = await tx<{ readonly domain: string }[]>`
        select domain from admin_domains
        where org_id = ${input.orgId} and status = 'verified' and mail_enabled
          and verified_at is not null
        order by domain
      `;
      return { agents: agents.map(toMailbox), domains: domains.map((row) => row.domain) };
    });
  }

  async save(input: SaveAgentMailboxInput): Promise<AgentMailbox> {
    const address = input.address === null ? null : canonicalAddress(input.address);
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const [agent] = await tx<{ readonly email: string | null }[]>`
          select email from actors
          where org_id = ${input.orgId} and id = ${input.agentId}
            and type in ('agent', 'service_account')
          for no key update
        `;
        if (agent === undefined) throw new AgentMailError("not_an_agent");
        if (address !== (agent.email?.toLowerCase() ?? null)) {
          if (address !== null) await assertAddressIsFree(tx, input.orgId, address);
          // The savepoint keeps a lost race for the address from aborting the transaction.
          await tx
            .savepoint(
              (sp) => sp`
                update actors set email = ${address}, updated_at = now()
                where org_id = ${input.orgId} and id = ${input.agentId}
              `,
            )
            .catch((error: unknown) => {
              throw isUniqueViolation(error) ? new AgentMailError("address_taken") : error;
            });
        }
        await tx`
          insert into agent_mail_policies (
            org_id, actor_id, receive_mode, allowed_senders, updated_by_actor_id
          ) values (
            ${input.orgId}, ${input.agentId}, ${input.receiveMode},
            ${tx.array([...input.allowedSenders])}, ${input.actorId}
          )
          on conflict (org_id, actor_id) do update set
            receive_mode = excluded.receive_mode,
            allowed_senders = excluded.allowed_senders,
            updated_by_actor_id = excluded.updated_by_actor_id,
            updated_at = statement_timestamp()
        `;
        const [saved] = await tx<MailboxRow[]>`
          select actor.id, actor.display_name, actor.type, actor.disabled_at, actor.email,
            policy.receive_mode, policy.allowed_senders
          from actors actor
          join agent_mail_policies policy
            on policy.org_id = actor.org_id and policy.actor_id = actor.id
          where actor.org_id = ${input.orgId} and actor.id = ${input.agentId}
        `;
        return toMailbox(saved as MailboxRow);
      },
    );
  }

  /**
   * The policy for each of these mailboxes that belongs to an agent or service
   * account. People are left out: their mail is not held.
   *
   * Runs while mail is received, inside the organization's context and with no
   * acting person, so it sets the organization only.
   */
  policiesFor(
    orgId: string,
    actorIds: readonly string[],
  ): Promise<ReadonlyMap<string, AgentMailPolicy>> {
    if (actorIds.length === 0) return Promise.resolve(new Map());
    return withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
      const rows = await tx<
        {
          readonly id: string;
          readonly receive_mode: AgentMailReceiveMode | null;
          readonly allowed_senders: readonly string[] | null;
        }[]
      >`
        select actor.id, policy.receive_mode, policy.allowed_senders
        from actors actor
        left join agent_mail_policies policy
          on policy.org_id = actor.org_id and policy.actor_id = actor.id
        where actor.org_id = ${orgId} and actor.id in ${tx([...actorIds])}
          and actor.type in ('agent', 'service_account')
      `;
      return new Map(
        rows.map((row) => [
          row.id,
          {
            receiveMode: row.receive_mode ?? DEFAULT_AGENT_MAIL_POLICY.receiveMode,
            allowedSenders: row.allowed_senders ?? DEFAULT_AGENT_MAIL_POLICY.allowedSenders,
          },
        ]),
      );
    });
  }
}

function canonicalAddress(address: string): string {
  try {
    return normalizeMailboxAddress(address.trim()).address;
  } catch {
    throw new AgentMailError("invalid_address");
  }
}

/** An agent's address must be on a mail domain of the organization and unused. */
async function assertAddressIsFree(
  tx: postgres.TransactionSql,
  orgId: string,
  address: string,
): Promise<void> {
  const domains = await tx`
    select 1 from admin_domains
    where org_id = ${orgId} and domain = split_part(${address}, '@', 2)
      and status = 'verified' and mail_enabled and verified_at is not null
    for share
  `;
  if (domains.length === 0) throw new AgentMailError("domain_not_eligible");
  const taken = await tx`
    select 1 from actors
    where org_id = ${orgId} and lower(email) = ${address} and disabled_at is null
    union all
    select 1 from mail_aliases
    where org_id = ${orgId} and lower(email) = ${address} and enabled and disabled_at is null
    union all
    select 1 from admin_groups
    where org_id = ${orgId} and lower(email) = ${address}
    limit 1
  `;
  if (taken.length > 0) throw new AgentMailError("address_taken");
}
