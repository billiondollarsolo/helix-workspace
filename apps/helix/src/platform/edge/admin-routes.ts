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
  sendForbidden,
  type AdminConsoleAuditSink,
} from "../admin/console-shared.js";
import { EdgeCertificateError } from "./certificate.js";
import type { EdgeCertificateService } from "./service.js";

/**
 * Admin → Domains → HTTPS certificate: what the edge serves for the
 * deployment's address, and replacing it with an operator-provided
 * certificate. The private key is write-only.
 */

export interface EdgeCertificateAdminRoutesOptions {
  readonly service: Pick<
    EdgeCertificateService,
    "status" | "upload" | "remove" | "requestApply" | "manageable"
  >;
  readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  readonly auditSink: AdminConsoleAuditSink;
}

const permission = "admin.security";

const uploadBody = z
  .object({
    certificatePem: z.string().min(1).max(100_000),
    privateKeyPem: z.string().min(1).max(20_000),
  })
  .strict();

export function registerEdgeCertificateAdminRoutes(
  app: FastifyInstance,
  options: EdgeCertificateAdminRoutesOptions,
): void {
  const { service, actorFromRequest, auditSink } = options;

  app.get("/api/admin/edge/certificate", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canReadAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleReadScope);
    }
    return { certificate: await service.status(actor.orgId) };
  });

  app.put("/api/admin/edge/certificate", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    const before = await service.status(actor.orgId);
    if (!before.manageable) {
      return reply.code(409).send(conflict(before.unavailableReason ?? "Not available."));
    }
    const body = uploadBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send(invalidRequest("Provide the certificate and its private key in PEM format."));
    }
    let stored;
    try {
      stored = await service.upload({
        orgId: actor.orgId,
        actorId: actor.id,
        certificatePem: body.data.certificatePem,
        privateKeyPem: body.data.privateKeyPem,
      });
    } catch (error) {
      if (error instanceof EdgeCertificateError) {
        return reply.code(400).send(invalidRequest(error.message, [{ path: [error.field] }]));
      }
      throw error;
    }
    await auditAdminAction(auditSink, {
      orgId: actor.orgId,
      actorId: actor.id,
      verb: "edge.tls.certificate_uploaded",
      objectType: "edge_tls_certificate",
      // Audit object ids are UUIDs; a certificate is identified by fingerprint.
      metadata: {
        hostname: before.hostname,
        fingerprintSha256: stored.summary.fingerprintSha256,
        names: stored.summary.names,
        issuer: stored.summary.issuer,
        notAfter: stored.summary.notAfter,
        replacedFingerprintSha256: before.uploaded?.fingerprintSha256 ?? null,
      },
    });
    service.requestApply(actor.orgId);
    return { certificate: await service.status(actor.orgId) };
  });

  app.delete("/api/admin/edge/certificate", async (request, reply) => {
    const actor = await actorFromRequest(request);
    if (!canWriteAdminConsole(actor, permission)) {
      return sendForbidden(reply, adminConsoleWriteScope);
    }
    if (!service.manageable) {
      const { unavailableReason } = await service.status(actor.orgId);
      return reply.code(409).send(conflict(unavailableReason ?? "Not available."));
    }
    const removed = await service.remove(actor.orgId);
    if (removed !== null) {
      await auditAdminAction(auditSink, {
        orgId: actor.orgId,
        actorId: actor.id,
        verb: "edge.tls.certificate_removed",
        objectType: "edge_tls_certificate",
        metadata: {
          fingerprintSha256: removed.summary.fingerprintSha256,
          names: removed.summary.names,
          notAfter: removed.summary.notAfter,
        },
      });
      service.requestApply(actor.orgId);
    }
    return { certificate: await service.status(actor.orgId) };
  });
}
