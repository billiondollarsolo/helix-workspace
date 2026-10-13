import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
} from "../admin/console-shared.js";
import {
  AgentSecretError,
  type AgentSecretSummary,
  type PostgresAgentSecretStore,
} from "./store.js";

/**
 * Admin → Agent secrets: store a secret, choose how agents may use it, and
 * grant it to agents. Values are write-only: no route returns one. Granting
 * is its own request, so it can wait for a second administrator without a
 * secret's value waiting with it.
 */

export interface AgentSecretAdminRoutesOptions {
  readonly store: Pick<
    PostgresAgentSecretStore,
    "list" | "create" | "update" | "setGrants" | "remove"
  >;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly auditSink: AdminConsoleAuditSink;
}

const permission = "admin.agents";

const nameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9._-]{0,62}$/u,
    "Use lowercase letters, digits, dots, dashes and underscores, starting with a letter.",
  );
const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u,
    "Enter host names such as api.example.com, without https:// or a path.",
  );
const hostsSchema = z.array(hostSchema).max(20);
const headerNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{0,63}$/u, "Enter a header name such as Authorization.")
  .refine((name) => !["host", "content-length", "connection", "transfer-encoding"].includes(name), {
    message: "That header cannot carry a secret.",
  });
const headerPrefixSchema = z
  .string()
  .max(32)
  .regex(/^[\x20-\x7e]*$/u, "Use plain characters before the value.");
const valueSchema = z.string().min(1, "Enter the secret's value.").max(16_384);
const modeSchema = z.enum(["use_only", "handover"]);
const actorIdsSchema = z.array(z.string().uuid()).max(200);

const createBody = z
  .object({
    name: nameSchema,
    description: z.string().trim().max(500).default(""),
    mode: modeSchema,
    value: valueSchema,
    allowedHosts: hostsSchema.default([]),
    headerName: headerNameSchema.default("authorization"),
    headerPrefix: headerPrefixSchema.default("Bearer "),
  })
  .strict();

const updateBody = z
  .object({
    description: z.string().trim().max(500).optional(),
    mode: modeSchema.optional(),
    value: valueSchema.optional(),
    allowedHosts: hostsSchema.optional(),
    headerName: headerNameSchema.optional(),
    headerPrefix: headerPrefixSchema.optional(),
  })
  .strict();

const grantsBody = z.object({ actorIds: actorIdsSchema }).strict();
const idParams = z.object({ id: z.string().uuid() });

function invalid(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const first = error.issues[0];
  return reply
    .code(400)
    .send(invalidRequest(first?.message ?? "Check the secret's details.", error.issues));
}

/** A use-only secret that is sent nowhere could never be used. */
function deliveryProblem(mode: string | undefined, hosts: readonly string[] | undefined) {
  return mode === "use_only" && hosts?.length === 0
    ? "A use-only secret needs at least one host it may be sent to."
    : null;
}

function auditMetadata(secret: AgentSecretSummary): Record<string, unknown> {
  return {
    name: secret.name,
    mode: secret.mode,
    allowedHosts: [...secret.allowedHosts],
    headerName: secret.headerName,
    version: secret.version,
    grantedActorIds: secret.grants.map((grant) => grant.actorId),
  };
}

export function registerAgentSecretAdminRoutes(
  app: FastifyInstance,
  options: AgentSecretAdminRoutesOptions,
): void {
  const { store, actorFromRequest, auditSink } = options;

  /** Only a signed-in person manages secrets, so an agent can never grant itself one. */
  const writer = async (request: FastifyRequest, reply: FastifyReply): Promise<Actor | null> => {
    const actor = await actorFromRequest(request);
    if (actor.type !== "user" || !canWriteAdminConsole(actor, permission)) {
      sendForbidden(reply, adminConsoleWriteScope);
      return null;
    }
    return actor;
  };
  const failure = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (!(error instanceof AgentSecretError)) throw error;
    return error.code === "name_taken"
      ? reply.code(409).send(conflict(error.message))
      : reply.code(400).send(invalidRequest(error.message));
  };

  app.get("/api/admin/agent-secrets", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (actor.type !== "user" || !canReadAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { secrets: await store.list({ orgId: actor.orgId, actorId: actor.id }) };
  });

  app.post("/api/admin/agent-secrets", async (request, reply) => {
    const actor = await writer(request, reply);
    if (actor === null) return reply;
    const body = createBody.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const problem = deliveryProblem(body.data.mode, body.data.allowedHosts);
    if (problem !== null) return reply.code(400).send(invalidRequest(problem));
    let secret: AgentSecretSummary;
    try {
      secret = await store.create({ orgId: actor.orgId, actorId: actor.id, ...body.data });
    } catch (error) {
      return failure(reply, error);
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "agent_secret.created",
      objectType: "agent_secret",
      objectId: secret.id,
      metadata: auditMetadata(secret),
    });
    return reply.code(201).send({ secret });
  });

  app.patch("/api/admin/agent-secrets/:id", async (request, reply) => {
    const actor = await writer(request, reply);
    if (actor === null) return reply;
    const params = idParams.safeParse(request.params);
    const body = updateBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send(notFound("That secret does not exist."));
    if (!body.success) return invalid(reply, body.error);
    let secret: AgentSecretSummary | null;
    try {
      secret = await store.update({
        orgId: actor.orgId,
        actorId: actor.id,
        id: params.data.id,
        ...body.data,
      });
    } catch (error) {
      // The table refuses a use-only secret with no host.
      if (error instanceof Error && "code" in error && error.code === "23514") {
        return reply
          .code(400)
          .send(invalidRequest("A use-only secret needs at least one host it may be sent to."));
      }
      return failure(reply, error);
    }
    if (secret === null) return reply.code(404).send(notFound("That secret does not exist."));
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: body.data.value === undefined ? "agent_secret.updated" : "agent_secret.rotated",
      objectType: "agent_secret",
      objectId: secret.id,
      metadata: auditMetadata(secret),
    });
    return { secret };
  });

  app.put("/api/admin/agent-secrets/:id/grants", async (request, reply) => {
    const actor = await writer(request, reply);
    if (actor === null) return reply;
    const params = idParams.safeParse(request.params);
    const body = grantsBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send(notFound("That secret does not exist."));
    if (!body.success) return invalid(reply, body.error);
    let change;
    try {
      change = await store.setGrants({
        orgId: actor.orgId,
        actorId: actor.id,
        id: params.data.id,
        actorIds: body.data.actorIds,
      });
    } catch (error) {
      return failure(reply, error);
    }
    if (change === null) return reply.code(404).send(notFound("That secret does not exist."));
    if (change.added.length > 0 || change.removed.length > 0) {
      await auditAdminAction(auditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "agent_secret.grants_changed",
        objectType: "agent_secret",
        objectId: change.secret.id,
        metadata: {
          name: change.secret.name,
          grantedActorIds: [...change.added],
          revokedActorIds: [...change.removed],
        },
      });
    }
    return { secret: change.secret };
  });

  app.delete("/api/admin/agent-secrets/:id", async (request, reply) => {
    const actor = await writer(request, reply);
    if (actor === null) return reply;
    const params = idParams.safeParse(request.params);
    const removed = params.success
      ? await store.remove({ orgId: actor.orgId, actorId: actor.id, id: params.data.id })
      : null;
    if (removed === null) return reply.code(404).send(notFound("That secret does not exist."));
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "agent_secret.deleted",
      objectType: "agent_secret",
      objectId: removed.id,
      metadata: auditMetadata(removed),
    });
    return reply.code(204).send();
  });
}
