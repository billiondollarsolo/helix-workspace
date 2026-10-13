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
import {
  PostgresAgentMailStore,
  registerAgentMailAdminRoutes,
} from "../platform/mail/agent-mail/index.js";
import type { TenantEnvelopeCipher } from "../platform/secrets/envelope.js";

/**
 * Admin → Agent credentials, Agent secrets and Agent mail: adding an agent,
 * the secrets an administrator stores and grants to agents, and who may write
 * to an agent's mailbox. The tools agents use those secrets through are
 * registered with the other tools.
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
  registerAgentMailAdminRoutes(app, {
    store: new PostgresAgentMailStore(input.sql),
    actorFromRequest,
    auditSink,
  });
}
