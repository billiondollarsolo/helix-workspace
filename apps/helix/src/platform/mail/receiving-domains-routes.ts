import type { Actor } from "@helix/sdk-types";
import {
  createDomainOwnershipChallenge,
  type DomainOwnershipStore,
} from "../admin/domain-identity.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod3";
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
import { MailAddressNormalizationError } from "./address-normalization.js";
import type { ReceivingDomainOwnershipVerifier } from "./receiving-domain-ownership.js";
import {
  ReceivingDomainCatchAllError,
  ReceivingDomainConflictError,
  ReceivingDomainTransitionError,
  type MailReceivingDomainRecord,
  type ReceivingDomainStore,
} from "./receiving-domains-store.js";

const mailAdminScope = "mail.admin";
const idParams = z.object({ id: z.string().uuid() });
const createBody = z
  .object({
    domain: z.string().min(1).max(253),
    catchAllActorId: z.string().uuid().nullable().default(null),
  })
  .strict();

export interface RegisterReceivingDomainAdminRoutesOptions {
  readonly store: ReceivingDomainStore;
  readonly ownershipVerifier: ReceivingDomainOwnershipVerifier;
  /* Ownership is proved on the domain, not on this capability, so issuing a
     challenge writes to the parent. */
  readonly ownershipStore: DomainOwnershipStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly auditSink?: AdminConsoleAuditSink | undefined;
}

/** Register the audited receiving-domain lifecycle control plane. */
export async function registerReceivingDomainAdminRoutes(
  app: FastifyInstance,
  options: RegisterReceivingDomainAdminRoutesOptions,
): Promise<void> {
  const { store, ownershipVerifier, ownershipStore, actorFromRequest, auditSink } = options;

  app.get("/api/admin/mail/receiving-domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canRead(actor)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    const domains = await store.listDomains(actor.orgId);
    await audit(auditSink, actor, "mail.receiving_domain.listed", undefined, {
      count: domains.length,
    });
    return { domains: domains.map(serializeReceivingDomain) };
  });

  app.post("/api/admin/mail/receiving-domains", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWrite(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const body = createBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send(invalidRequest("Invalid receiving domain.", body.error.issues));
    }

    try {
      const domain = await store.createDomain({
        orgId: actor.orgId,
        domain: body.data.domain,
        catchAllActorId: body.data.catchAllActorId,
        createdBy: actor.id,
      });
      /* Issued against the domain identity so the same proof serves sending.
         Always re-issued on create: the operator is being shown a record to
         publish, and showing one that a previous challenge superseded would
         send them to publish a value that can never verify. */
      const challenge = createDomainOwnershipChallenge(domain.domain);
      await ownershipStore.setOwnershipChallenge(
        actor.orgId,
        domain.adminDomainId,
        challenge.tokenHash,
      );
      await audit(auditSink, actor, "mail.receiving_domain.created", domain.id, {
        domain: domain.domain,
        catchAllConfigured: domain.catchAllActorId !== null,
      });
      return await reply.code(201).send({
        domain: serializeReceivingDomain(domain),
        verification: {
          dnsName: challenge.dnsName,
          dnsValue: challenge.dnsValue,
        },
      });
    } catch (error) {
      if (error instanceof ReceivingDomainConflictError) {
        return reply.code(409).send(conflict(error.message));
      }
      if (
        error instanceof ReceivingDomainCatchAllError ||
        error instanceof MailAddressNormalizationError
      ) {
        return reply.code(400).send(invalidRequest(error.message));
      }
      throw error;
    }
  });

  /* Re-issue the one-time TXT challenge. Create shows the token once and stores
     only a digest; without this an operator who closed the dialog is stuck. */
  app.post("/api/admin/mail/receiving-domains/:id/challenge", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWrite(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid receiving-domain id."));
    }
    const current = await store.getDomain(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Receiving domain not found."));
    }
    try {
      if (current.status !== "pending") {
        /* Rotating a satisfied challenge would invite re-proving settled
           ownership, and the parent may have other capabilities relying on it. */
        return await reply
          .code(409)
          .send(conflict(`Cannot reissue a challenge for a domain in ${current.status} state.`));
      }
      const challenge = createDomainOwnershipChallenge(current.domain);
      await ownershipStore.setOwnershipChallenge(
        actor.orgId,
        current.adminDomainId,
        challenge.tokenHash,
      );
      const domain = current;
      await audit(auditSink, actor, "mail.receiving_domain.challenge_reissued", domain.id, {
        domain: domain.domain,
      });
      return {
        domain: serializeReceivingDomain(domain),
        verification: { dnsName: challenge.dnsName, dnsValue: challenge.dnsValue },
      };
    } catch (error) {
      return sendLifecycleError(reply, error);
    }
  });

  app.post("/api/admin/mail/receiving-domains/:id/verify", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWrite(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid receiving-domain id."));
    }
    const current = await store.getDomain(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Receiving domain not found."));
    }
    if (current.status === "pending") {
      let owned: boolean;
      try {
        owned = await ownershipVerifier.verify(current);
      } catch {
        return reply.code(503).send({
          error: "Domain ownership verification is temporarily unavailable.",
          code: "service_unavailable",
        });
      }
      if (!owned) {
        return reply
          .code(409)
          .send(conflict("Domain ownership TXT challenge has not been observed."));
      }
    }
    try {
      const domain = await store.markVerified(actor.orgId, current.id);
      if (domain === null) {
        return await reply.code(404).send(notFound("Receiving domain not found."));
      }
      await audit(auditSink, actor, "mail.receiving_domain.verified", domain.id, {
        domain: domain.domain,
      });
      return { domain: serializeReceivingDomain(domain) };
    } catch (error) {
      return sendLifecycleError(reply, error);
    }
  });

  /* Removing the capability, not the domain: the `admin_domains` identity and
     its DNS records stay, so re-adding does not start from nothing. Ownership
     is not inherited though -- the challenge is per-capability, so a re-added
     domain proves itself again. */
  app.delete("/api/admin/mail/receiving-domains/:id", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWrite(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid receiving-domain id."));
    }
    const current = await store.getDomain(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Receiving domain not found."));
    }
    const removed = await store.deleteDomain(actor.orgId, current.id);
    if (!removed) {
      return reply.code(404).send(notFound("Receiving domain not found."));
    }
    await audit(auditSink, actor, "mail.receiving_domain.deleted", current.id, {
      domain: current.domain,
      /* Recorded because deleting an `active` domain stops mail immediately,
         which is the case worth finding in an audit log later. */
      statusAtDeletion: current.status,
    });
    return { deleted: true };
  });

  app.post("/api/admin/mail/receiving-domains/:id/enable", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWrite(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid receiving-domain id."));
    }
    const current = await store.getDomain(actor.orgId, params.data.id);
    if (current === null) {
      return reply.code(404).send(notFound("Receiving domain not found."));
    }
    if (current.status !== "active") {
      let owned: boolean;
      try {
        owned = await ownershipVerifier.verify(current);
      } catch {
        return reply.code(503).send({
          error: "Domain ownership verification is temporarily unavailable.",
          code: "service_unavailable",
        });
      }
      if (!owned) {
        return reply
          .code(409)
          .send(conflict("A current domain ownership TXT challenge is required to enable mail."));
      }
    }
    try {
      const domain = await store.enableDomain(actor.orgId, params.data.id);
      if (domain === null) {
        return await reply.code(404).send(notFound("Receiving domain not found."));
      }
      await audit(auditSink, actor, "mail.receiving_domain.enabled", domain.id, {
        domain: domain.domain,
      });
      return { domain: serializeReceivingDomain(domain) };
    } catch (error) {
      return sendLifecycleError(reply, error);
    }
  });

  app.post("/api/admin/mail/receiving-domains/:id/disable", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWrite(actor)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(invalidRequest("Invalid receiving-domain id."));
    }
    try {
      const domain = await store.disableDomain(actor.orgId, params.data.id);
      if (domain === null) {
        return await reply.code(404).send(notFound("Receiving domain not found."));
      }
      await audit(auditSink, actor, "mail.receiving_domain.disabled", domain.id, {
        domain: domain.domain,
      });
      return { domain: serializeReceivingDomain(domain) };
    } catch (error) {
      return sendLifecycleError(reply, error);
    }
  });
}

function canRead(actor: Actor): boolean {
  return canReadAdminConsole(actor) || (actor.scopes ?? []).includes(mailAdminScope);
}

function canWrite(actor: Actor): boolean {
  return canWriteAdminConsole(actor) || (actor.scopes ?? []).includes(mailAdminScope);
}

function serializeReceivingDomain(record: MailReceivingDomainRecord): Record<string, unknown> {
  return {
    id: record.id,
    orgId: record.orgId,
    domain: record.domain,
    status: record.status,
    verifiedAt: record.verifiedAt,
    catchAllActorId: record.catchAllActorId,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function audit(
  sink: AdminConsoleAuditSink | undefined,
  actor: Actor,
  verb: string,
  objectId: string | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  await auditAdminAction(sink, {
    orgId: actor.orgId,
    actorId: actor.id,
    verb,
    objectType: "mail_receiving_domain",
    ...(objectId === undefined ? {} : { objectId }),
    metadata,
  });
}

function sendLifecycleError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof ReceivingDomainConflictError ||
    error instanceof ReceivingDomainTransitionError
  ) {
    return reply.code(409).send(conflict(error.message));
  }
  if (error instanceof ReceivingDomainCatchAllError) {
    return reply.code(400).send(invalidRequest(error.message));
  }
  throw error;
}
