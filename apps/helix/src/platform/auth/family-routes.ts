import type { Actor } from "@helix/sdk-types";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  familyRotationInput,
  prepareFamilyRotation,
  deliverFamilyRotation,
} from "./family-credentials.js";
import { ForbiddenError } from "../../api/api-error.js";
import { assertActorMatchesRequestTenant } from "../tenancy/middleware.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import {
  familyRegistrationInput,
  familyRedemptionInput,
  type FamilyPairing,
} from "./family-pairing.js";

export function registerFamilyRoutes(
  app: FastifyInstance,
  family: FamilyPairing,
  actorFromRequest: (request: FastifyRequest) => Promise<Actor>,
) {
  const admin = async (request: FastifyRequest) => {
    const actor = await actorFromRequest(request);
    assertActorMatchesRequestTenant(request, actor);
    family.admin(actor);
    return actor;
  };
  const appId = (request: FastifyRequest) =>
    z.object({ appId: z.string().uuid() }).parse(request.params).appId;
  app.get("/api/admin/family-applications", async (request) => ({
    applications: await family.list(await admin(request)),
  }));
  app.post("/api/admin/family-applications", async (request, reply) => {
    reply.header("cache-control", "no-store");
    return family.register(
      await admin(request),
      familyRegistrationInput.parse(request.body),
      fromNodeHeaders(request.headers),
    );
  });
  app.get("/api/admin/family-applications/:appId/assignments", async (request) => ({
    assignments: await family.assignments(await admin(request), appId(request)),
  }));
  app.put("/api/admin/family-applications/:appId/assignments", async (request) => {
    const input = z
      .object({
        assignments: z
          .array(
            z
              .object({ actorId: z.string().uuid(), role: z.enum(["viewer", "member", "admin"]) })
              .strict(),
          )
          .max(5000),
      })
      .strict()
      .parse(request.body);
    await family.assign(await admin(request), appId(request), input.assignments);
    return { updated: true };
  });
  app.post("/api/admin/family-applications/:appId/rotate", async (request) => {
    const row = await prepareFamilyRotation(
      family,
      await admin(request),
      appId(request),
      familyRotationInput.parse(request.body),
      fromNodeHeaders(request.headers),
    );
    await deliverFamilyRotation(family, row);
    return { rotated: true };
  });
  app.delete("/api/admin/family-applications/:appId", async (request) => {
    await family.revoke(await admin(request), appId(request));
    return { revoked: true };
  });
  for (const [path, activate] of [
    ["redeem", false],
    ["activate", true],
  ] as const) {
    app.post(`/api/family/${path}`, async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (request.headers.cookie !== undefined)
        throw new ForbiddenError(
          "Application pairing uses installation authority, without a browser session.",
        );
      return family.redeem(familyRedemptionInput.parse(request.body), activate);
    });
  }
  app.post("/api/family/disconnect", async (request) => {
    const authorization = request.headers.authorization;
    if (
      request.headers.cookie !== undefined ||
      typeof authorization !== "string" ||
      !/^Bearer [a-f0-9]{64}$/u.test(authorization)
    )
      throw new ForbiddenError("Installation authority is required.");
    const input = z
      .object({
        orgId: z.string().uuid(),
        appId: z.string().uuid(),
        connectionId: z.string().uuid(),
      })
      .strict()
      .parse(request.body);
    return family.revokeByPeer(
      input.orgId,
      input.appId,
      input.connectionId,
      authorization.slice(7),
    );
  });
  app.get("/api/family/apps", async (request) => {
    const actor = await actorFromRequest(request);
    assertActorMatchesRequestTenant(request, actor);
    if (actor.type !== "user")
      throw new ForbiddenError("Sign in as a person to open family applications.");
    return withTenantPostgresContext(
      family.sql,
      { orgId: actor.orgId, actorId: actor.id },
      async (tx) => {
        const rows = await tx<
          { id: string; public_origin: string }[]
        >`select app.id,app.public_origin from family_applications app
        join family_app_assignments assigned on assigned.org_id=app.org_id and assigned.application_id=app.id
        join "oauthClient" client on client."clientId"=app.oidc_client_id and client.disabled is not true
        where app.org_id=${actor.orgId} and assigned.actor_id=${actor.id} and app.status='active' order by app.created_at limit 100`;
        return {
          applications: rows.map((row) => ({
            id: row.id,
            label: "Helix Bot",
            url: row.public_origin,
          })),
        };
      },
    );
  });
}
