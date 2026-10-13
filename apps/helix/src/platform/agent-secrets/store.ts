import type postgres from "postgres";
import type { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { isUniqueViolation } from "../util/sql.js";

const VALUE_PURPOSE = "agent-secret";

type AgentSecretMode = "use_only" | "handover";

/** How a secret is sent: `<headerName>: <headerPrefix><value>` to one of `allowedHosts`. */
interface AgentSecretDelivery {
  readonly allowedHosts: readonly string[];
  readonly headerName: string;
  readonly headerPrefix: string;
}

interface AgentSecretGrant {
  readonly actorId: string;
  readonly displayName: string;
  readonly actorType: "agent" | "service_account";
  readonly disabled: boolean;
  readonly grantedAt: string;
  readonly lastUsedAt: string | null;
  readonly useCount: number;
}

/** Everything the Admin console shows about a secret. Never its value. */
export interface AgentSecretSummary extends AgentSecretDelivery {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: AgentSecretMode;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly rotatedAt: string;
  readonly grants: readonly AgentSecretGrant[];
}

/** What an agent sees about a secret it was granted. */
export interface GrantedAgentSecret extends AgentSecretDelivery {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: AgentSecretMode;
  readonly version: number;
}

export interface OpenedAgentSecret extends GrantedAgentSecret {
  readonly value: string;
}

type AgentSecretErrorCode = "name_taken" | "not_an_agent" | "value_required";

export class AgentSecretError extends Error {
  constructor(
    readonly code: AgentSecretErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentSecretError";
  }
}

interface SecretRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly mode: AgentSecretMode;
  readonly allowed_hosts: readonly string[];
  readonly header_name: string;
  readonly header_prefix: string;
  readonly version: number;
}

interface SummaryRow extends SecretRow {
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly rotated_at: Date;
  readonly grants: readonly {
    readonly actorId: string;
    readonly displayName: string;
    readonly actorType: AgentSecretGrant["actorType"];
    readonly disabled: boolean;
    readonly grantedAt: string;
    readonly lastUsedAt: string | null;
    readonly useCount: number;
  }[];
}

function toGranted(row: SecretRow): GrantedAgentSecret {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    allowedHosts: [...row.allowed_hosts],
    headerName: row.header_name,
    headerPrefix: row.header_prefix,
    version: row.version,
  };
}

function toSummary(row: SummaryRow): AgentSecretSummary {
  return {
    ...toGranted(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    rotatedAt: row.rotated_at.toISOString(),
    grants: row.grants.map((grant) => ({
      ...grant,
      grantedAt: new Date(grant.grantedAt).toISOString(),
      lastUsedAt: grant.lastUsedAt === null ? null : new Date(grant.lastUsedAt).toISOString(),
    })),
  };
}

function sameDelivery(a: AgentSecretDelivery, b: AgentSecretDelivery): boolean {
  return (
    a.headerName === b.headerName &&
    a.headerPrefix === b.headerPrefix &&
    a.allowedHosts.length === b.allowedHosts.length &&
    a.allowedHosts.every((host) => b.allowedHosts.includes(host))
  );
}

export interface CreateAgentSecretInput extends AgentSecretDelivery {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly description: string;
  readonly mode: AgentSecretMode;
  readonly value: string;
}

export interface UpdateAgentSecretInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly id: string;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly headerName?: string | undefined;
  readonly headerPrefix?: string | undefined;
  readonly description?: string | undefined;
  readonly mode?: AgentSecretMode | undefined;
  /** A new value. Replacing it is the only way to change one. */
  readonly value?: string | undefined;
}

export interface AgentSecretGrantChange {
  readonly secret: AgentSecretSummary;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * Secrets an administrator stores for the organization's agents. Values are
 * sealed with the tenant envelope and leave this class only through `open`,
 * which requires a grant to an active agent or service account.
 *
 * The agent-facing methods join the organization's transaction without naming
 * an actor: a request a person approved runs in that person's transaction.
 */
export class PostgresAgentSecretStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly cipher: Pick<TenantEnvelopeCipher, "seal" | "open">,
  ) {}

  list(input: { readonly orgId: string; readonly actorId: string }): Promise<AgentSecretSummary[]> {
    return withTenantPostgresContext(this.sql, input, (tx) => summaries(tx, input.orgId));
  }

  create(input: CreateAgentSecretInput): Promise<AgentSecretSummary> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      let id: string;
      try {
        // A savepoint keeps the transaction usable when the name is taken.
        const rows = await tx.savepoint(
          (sp) => sp<{ id: string }[]>`
            insert into agent_secrets (
              org_id, name, description, mode, allowed_hosts, header_name, header_prefix,
              value_ciphertext, created_by_actor_id
            ) values (
              ${input.orgId}, ${input.name}, ${input.description}, ${input.mode},
              ${[...input.allowedHosts]}, ${input.headerName}, ${input.headerPrefix},
              ${this.cipher.seal(input.orgId, VALUE_PURPOSE, input.value)}, ${input.actorId}
            )
            returning id
          `,
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AgentSecretError("name_taken", `A secret named ${input.name} already exists.`);
        }
        throw error;
      }
      return (await summaries(tx, input.orgId, id))[0] as AgentSecretSummary;
    });
  }

  /** Returns null when the secret does not exist. */
  update(input: UpdateAgentSecretInput): Promise<AgentSecretSummary | null> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const existing = (
        await tx<SecretRow[]>`
          select id, name, description, mode, allowed_hosts, header_name, header_prefix, version
          from agent_secrets
          where org_id = ${input.orgId} and id = ${input.id}
          for update
        `
      )[0];
      if (existing === undefined) return null;
      const before = toGranted(existing);
      const mode = input.mode ?? before.mode;
      const delivery: AgentSecretDelivery = {
        allowedHosts: input.allowedHosts ?? before.allowedHosts,
        headerName: input.headerName ?? before.headerName,
        headerPrefix: input.headerPrefix ?? before.headerPrefix,
      };
      // Pointing a use-only secret somewhere new, or making it readable, would
      // let whoever edits it learn a value they were never shown.
      if (
        before.mode === "use_only" &&
        input.value === undefined &&
        (mode !== before.mode || !sameDelivery(before, delivery))
      ) {
        throw new AgentSecretError(
          "value_required",
          "Enter the value again to change where a use-only secret is sent or who can read it.",
        );
      }
      const sealed =
        input.value === undefined
          ? null
          : this.cipher.seal(input.orgId, VALUE_PURPOSE, input.value);
      await tx`
        update agent_secrets set
          description = ${input.description ?? before.description},
          mode = ${mode},
          allowed_hosts = ${[...delivery.allowedHosts]},
          header_name = ${delivery.headerName},
          header_prefix = ${delivery.headerPrefix},
          value_ciphertext = coalesce(${sealed}, value_ciphertext),
          version = version + ${sealed === null ? 0 : 1},
          rotated_at = case when ${sealed !== null} then statement_timestamp() else rotated_at end,
          updated_at = statement_timestamp()
        where org_id = ${input.orgId} and id = ${input.id}
      `;
      return (await summaries(tx, input.orgId, input.id))[0] ?? null;
    });
  }

  /** Replace who holds a grant. Returns null when the secret does not exist. */
  setGrants(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly actorIds: readonly string[];
  }): Promise<AgentSecretGrantChange | null> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const found = await tx`
        select 1 from agent_secrets where org_id = ${input.orgId} and id = ${input.id} for update
      `;
      if (found.length === 0) return null;
      const change = await replaceGrants(tx, { ...input, secretId: input.id });
      return {
        ...change,
        secret: (await summaries(tx, input.orgId, input.id))[0] as AgentSecretSummary,
      };
    });
  }

  /** Returns the removed secret, or null when it did not exist. */
  remove(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
  }): Promise<AgentSecretSummary | null> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const secret = (await summaries(tx, input.orgId, input.id))[0];
      if (secret === undefined) return null;
      await tx`delete from agent_secrets where org_id = ${input.orgId} and id = ${input.id}`;
      return secret;
    });
  }

  /** The secrets granted to an agent, without their values. */
  listGranted(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<GrantedAgentSecret[]> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) =>
      (await grantedRows(tx, input)).map(toGranted),
    );
  }

  /**
   * A granted secret with its value, or null when the agent holds no grant
   * for that name. Callers decide what the agent may do with the value.
   */
  open(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly name: string;
  }): Promise<OpenedAgentSecret | null> {
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const row = (await grantedRows(tx, input, input.name))[0];
      return row === undefined
        ? null
        : {
            ...toGranted(row),
            value: this.cipher.open(input.orgId, VALUE_PURPOSE, row.value_ciphertext),
          };
    });
  }

  async recordUse(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly secretId: string;
  }): Promise<void> {
    await withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId },
      (tx) => tx`
        update agent_secret_grants
        set last_used_at = statement_timestamp(), use_count = use_count + 1
        where org_id = ${input.orgId} and secret_id = ${input.secretId}
          and actor_id = ${input.actorId}
      `,
    );
  }
}

async function summaries(
  tx: postgres.TransactionSql,
  orgId: string,
  id?: string,
): Promise<AgentSecretSummary[]> {
  const rows = await tx<SummaryRow[]>`
    select s.id, s.name, s.description, s.mode, s.allowed_hosts, s.header_name, s.header_prefix,
      s.version, s.created_at, s.updated_at, s.rotated_at,
      coalesce(held.grants, '[]'::jsonb) as grants
    from agent_secrets s
    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'actorId', a.id,
          'displayName', a.display_name,
          'actorType', a.type,
          'disabled', a.disabled_at is not null,
          'grantedAt', g.granted_at,
          'lastUsedAt', g.last_used_at,
          'useCount', g.use_count
        )
        order by a.display_name, a.id
      ) as grants
      from agent_secret_grants g
      join actors a on a.org_id = g.org_id and a.id = g.actor_id
      where g.org_id = s.org_id and g.secret_id = s.id
    ) held on true
    where s.org_id = ${orgId} and (${id ?? null}::uuid is null or s.id = ${id ?? null})
    order by s.name
  `;
  return rows.map(toSummary);
}

/** Grants count only for agents and service accounts that are still active. */
function grantedRows(
  tx: postgres.TransactionSql,
  input: { readonly orgId: string; readonly actorId: string },
  name?: string,
): Promise<(SecretRow & { readonly value_ciphertext: string })[]> {
  return tx<(SecretRow & { readonly value_ciphertext: string })[]>`
    select s.id, s.name, s.description, s.mode, s.allowed_hosts, s.header_name, s.header_prefix,
      s.version, s.value_ciphertext
    from agent_secret_grants g
    join agent_secrets s on s.org_id = g.org_id and s.id = g.secret_id
    join actors a on a.org_id = g.org_id and a.id = g.actor_id
    where g.org_id = ${input.orgId} and g.actor_id = ${input.actorId}
      and a.type in ('agent', 'service_account') and a.disabled_at is null
      and (${name ?? null}::text is null or s.name = ${name ?? null})
    order by s.name
  `;
}

async function replaceGrants(
  tx: postgres.TransactionSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly secretId: string;
    readonly actorIds: readonly string[];
  },
): Promise<{ readonly added: string[]; readonly removed: string[] }> {
  const wanted = [...new Set(input.actorIds)];
  const agents = await tx<{ id: string }[]>`
    select id from actors
    where org_id = ${input.orgId} and id = any(${tx.array(wanted)}::uuid[])
      and type in ('agent', 'service_account')
  `;
  if (agents.length !== wanted.length) {
    throw new AgentSecretError(
      "not_an_agent",
      "Secrets can be granted only to this organization's agents and service accounts.",
    );
  }
  const removed = await tx<{ actor_id: string }[]>`
    delete from agent_secret_grants
    where org_id = ${input.orgId} and secret_id = ${input.secretId}
      and actor_id <> all(${tx.array(wanted)}::uuid[])
    returning actor_id
  `;
  const added = await tx<{ actor_id: string }[]>`
    insert into agent_secret_grants (org_id, secret_id, actor_id, granted_by_actor_id)
    select ${input.orgId}, ${input.secretId}, wanted.id, ${input.actorId}
    from unnest(${tx.array(wanted)}::uuid[]) wanted(id)
    on conflict (secret_id, actor_id) do nothing
    returning actor_id
  `;
  return {
    added: added.map((row) => row.actor_id),
    removed: removed.map((row) => row.actor_id),
  };
}
