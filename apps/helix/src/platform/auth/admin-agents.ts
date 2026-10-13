import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  invalidRequest,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";

/**
 * Admin → Agent credentials: the organization's agents and service accounts,
 * and adding an agent. An agent is an identity with no sign-in of its own; it
 * can do nothing until an administrator issues it a credential.
 */

export interface AdminAgent {
  readonly id: string;
  readonly displayName: string;
  readonly type: "agent" | "service_account";
  readonly description: string;
  readonly disabled: boolean;
  readonly createdAt: string;
}

interface AgentRow {
  readonly id: string;
  readonly display_name: string;
  readonly type: AdminAgent["type"];
  readonly description: string | null;
  readonly disabled_at: Date | null;
  readonly created_at: Date;
}

function toAgent(row: AgentRow): AdminAgent {
  return {
    id: row.id,
    displayName: row.display_name,
    type: row.type,
    description: row.description ?? "",
    disabled: row.disabled_at !== null,
    createdAt: row.created_at.toISOString(),
  };
}

export class PostgresAdminAgentStore {
  constructor(private readonly sql: postgres.Sql) {}

  list(input: { readonly orgId: string; readonly actorId: string }): Promise<AdminAgent[]> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<AgentRow[]>`
        select id, display_name, type, disabled_at, created_at,
          coalesce(metadata->>'description', metadata->>'purpose') as description
        from actors
        where org_id = ${input.orgId} and type in ('agent', 'service_account')
        order by display_name, id
        limit 500
      `;
      return rows.map(toAgent);
    });
  }

  create(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly displayName: string;
    readonly description: string;
  }): Promise<AdminAgent> {
    return withTenantPostgresContext(this.sql, input, async (tx) => {
      const rows = await tx<AgentRow[]>`
        insert into actors (org_id, type, display_name, metadata)
        values (
          ${input.orgId}, 'agent', ${input.displayName},
          ${tx.json({ description: input.description, ownerActorId: input.actorId })}
        )
        returning id, display_name, type, disabled_at, created_at,
          metadata->>'description' as description
      `;
      return toAgent(rows[0] as AgentRow);
    });
  }
}

export interface AdminAgentRoutesOptions {
  readonly store: Pick<PostgresAdminAgentStore, "list" | "create">;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly auditSink: AdminConsoleAuditSink;
}

const permission = "admin.agents";

const createBody = z
  .object({
    displayName: z.string().trim().min(1, "Give the agent a name.").max(120),
    description: z.string().trim().max(500).default(""),
  })
  .strict();

export function registerAdminAgentRoutes(
  app: FastifyInstance,
  options: AdminAgentRoutesOptions,
): void {
  const { store, actorFromRequest, auditSink } = options;

  app.get("/api/admin/agents", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { agents: await store.list({ orgId: actor.orgId, actorId: actor.id }) };
  });

  app.post("/api/admin/agents", async (request, reply) => {
    const actor = await actorFromRequest(request);
    // Only a signed-in person adds an agent, so agents cannot multiply themselves.
    if (actor.type !== "user" || !canWriteAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest(body.error.issues[0]?.message ?? "Give the agent a name."));
    }
    const agent = await store.create({ orgId: actor.orgId, actorId: actor.id, ...body.data });
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "agent.created",
      objectType: "actor",
      objectId: agent.id,
      metadata: { displayName: agent.displayName },
    });
    return reply.code(201).send({ agent });
  });
}
