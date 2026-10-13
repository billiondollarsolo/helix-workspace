import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  adminConsoleReadScope,
  adminConsoleWriteScope,
  auditAdminAction,
  canReadAdminConsole,
  canWriteAdminConsole,
  conflict,
  invalidRequest,
  notFound,
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../../admin/console-shared.js";
import {
  AGENT_MAIL_MAX_ALLOWED_SENDERS,
  AGENT_MAIL_RECEIVE_MODES,
  normalizeAllowedSender,
} from "./policy.js";
import { AgentMailError, type AgentMailErrorCode, type PostgresAgentMailStore } from "./store.js";

/**
 * Admin → Agent mail: give an agent a mail address and say who may write to
 * it from outside. Mail that fails the policy waits in the mail quarantine
 * (`/api/admin/mail/quarantine`), where an administrator delivers or deletes it.
 */

export interface AgentMailAdminRoutesOptions {
  readonly store: Pick<PostgresAgentMailStore, "list" | "save">;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly auditSink: AdminConsoleAuditSink;
}

const permission = "admin.agents";

const saveBody = z
  .object({
    address: z.string().trim().max(320).nullable(),
    receiveMode: z.enum(AGENT_MAIL_RECEIVE_MODES),
    allowedSenders: z.array(z.string().trim().min(1).max(320)).max(AGENT_MAIL_MAX_ALLOWED_SENDERS),
  })
  .strict();
const idParams = z.object({ id: z.string().uuid() });

const ERROR_MESSAGES: Record<AgentMailErrorCode, string> = {
  not_an_agent: "That agent no longer exists.",
  invalid_address: "Enter a full mail address, such as billing-bot@example.com.",
  domain_not_eligible: "Use a verified domain of this organization that has mail turned on.",
  address_taken: "That address already belongs to a person, a group or another agent.",
};

/** The senders in canonical form, or the first entry that is not an address or domain. */
function canonicalSenders(
  entries: readonly string[],
): { readonly senders: string[] } | { readonly invalid: string } {
  const senders = new Set<string>();
  for (const entry of entries) {
    try {
      senders.add(normalizeAllowedSender(entry));
    } catch {
      return { invalid: entry };
    }
  }
  return { senders: [...senders].sort() };
}

export function registerAgentMailAdminRoutes(
  app: FastifyInstance,
  options: AgentMailAdminRoutesOptions,
): void {
  const { store, actorFromRequest, auditSink } = options;

  app.get("/api/admin/agent-mail", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return store.list({ orgId: actor.orgId, actorId: actor.id });
  });

  app.put("/api/admin/agent-mail/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    // Only a signed-in person decides who may write to an agent, never an agent.
    if (actor.type !== "user" || !canWriteAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send(notFound(ERROR_MESSAGES.not_an_agent));
    const body = saveBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest(body.error.issues[0]?.message ?? "Check the agent's mail settings."));
    }
    const senders = canonicalSenders(body.data.allowedSenders);
    if ("invalid" in senders) {
      return reply
        .code(400)
        .send(
          invalidRequest(
            `"${senders.invalid}" is not an address or a domain. Use ana@example.com or @example.com.`,
          ),
        );
    }
    const address = body.data.address === "" ? null : body.data.address;
    try {
      const agent = await store.save({
        orgId: actor.orgId,
        actorId: actor.id,
        agentId: params.data.id,
        address,
        receiveMode: body.data.receiveMode,
        allowedSenders: senders.senders,
      });
      await auditAdminAction(auditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "agent_mail.updated",
        objectType: "actor",
        objectId: agent.id,
        metadata: {
          address: agent.address,
          receiveMode: agent.receiveMode,
          allowedSenders: [...agent.allowedSenders],
        },
      });
      return { agent };
    } catch (error) {
      if (!(error instanceof AgentMailError)) throw error;
      const message = ERROR_MESSAGES[error.code];
      if (error.code === "not_an_agent") return reply.code(404).send(notFound(message));
      if (error.code === "address_taken") return reply.code(409).send(conflict(message));
      return reply.code(400).send(invalidRequest(message));
    }
  });
}
