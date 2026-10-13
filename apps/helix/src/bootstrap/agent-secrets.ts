import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import type { AdminConsoleAuditSink } from "../platform/admin/console-shared.js";
import {
  PostgresAgentSecretStore,
  registerAgentSecretAdminRoutes,
} from "../platform/agent-secrets/index.js";
import {
  PostgresAdminAgentStore,
  registerAdminAgentRoutes,
} from "../platform/auth/admin-agents.js";
import type { TenantEnvelopeCipher } from "../platform/secrets/envelope.js";

/**
 * Admin → Agent credentials and Admin → Agent secrets: adding an agent, and
 * the secrets an administrator stores and grants to agents. The tools agents
 * use those secrets through are registered with the other tools.
 */
export function installAgentSecretAdministration(input: {
  readonly app: FastifyInstance;
  readonly sql: postgres.Sql;
  readonly cipher: TenantEnvelopeCipher;
  readonly auditSink: AdminConsoleAuditSink;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
}): void {
  const { app, auditSink, actorFromRequest } = input;
  registerAdminAgentRoutes(app, {
    store: new PostgresAdminAgentStore(input.sql),
    actorFromRequest,
    auditSink,
  });
  registerAgentSecretAdminRoutes(app, {
    store: new PostgresAgentSecretStore(input.sql, input.cipher),
    actorFromRequest,
    auditSink,
  });
}
