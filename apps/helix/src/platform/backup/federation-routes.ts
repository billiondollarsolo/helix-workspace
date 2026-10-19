import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ForbiddenError } from "../../api/api-error.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import { federationBackupPolicy, federationBackupRequest } from "./federation-protocol.js";
import { type FederationBackupManagement, recoveryEnrollment } from "./federation-management.js";

export function registerFederationBackupRoutes(
  app: FastifyInstance,
  options: {
    service: FederationBackupManagement;
    actor: (request: FastifyRequest) => Promise<Actor>;
    controls: (
      actor: Actor,
    ) => Promise<{ sensitiveActionMfaRequired: boolean; secondAdminApprovalRequired: boolean }>;
    verified: (request: FastifyRequest, actor: Actor) => Promise<boolean>;
  },
) {
  const actor = async (request: FastifyRequest, sensitive = false) => {
    const resolved = await options.actor(request);
    assertActorMatchesRequestTenant(request, resolved);
    if (
      sensitive &&
      (await options.controls(resolved)).sensitiveActionMfaRequired &&
      !(await options.verified(request, resolved))
    )
      throw new ForbiddenError("Verify recent MFA before changing recovery authority.");
    return resolved;
  };
  const id = (request: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(request.params).id;
  app.get("/api/admin/federation-backups", async (request) => ({
    targets: await options.service.list(await actor(request)),
  }));
  app.post("/api/admin/federation-backups", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return options.service.enroll(
      await actor(request, true),
      recoveryEnrollment.parse(request.body),
    );
  });
  app.put("/api/admin/federation-backups/:id/policy", async (request) =>
    options.service.policy(
      await actor(request, true),
      id(request),
      federationBackupPolicy.parse(request.body),
    ),
  );
  app.delete("/api/admin/federation-backups/:id", async (request) =>
    options.service.detach(await actor(request, true), id(request)),
  );
  app.get("/api/admin/federation-backup-jobs", async (request) => ({
    jobs: await options.service.jobs(await actor(request)),
  }));
  app.post("/api/admin/federation-backups/:id/jobs", async (request) => {
    const principal = await actor(request, true);
    const controls = await options.controls(principal);
    return options.service.createJob(
      principal,
      id(request),
      federationBackupRequest.parse(request.body),
      controls.secondAdminApprovalRequired ? 1 : 0,
    );
  });
  app.post("/api/admin/federation-backup-jobs/:id/approve", async (request) =>
    options.service.approve(await actor(request, true), id(request)),
  );
  app.post("/api/admin/federation-recovery-sets", async (request) => {
    const input = z.object({ id: z.string().uuid() }).strict().parse(request.body);
    return options.service.recoverySet(await actor(request, true), input.id);
  });
}
