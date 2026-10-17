import { FamilyBackupManagement } from "../platform/backup/family-management.js";
import { registerFamilyBackupRoutes } from "../platform/backup/family-routes.js";
import { resolveAdminSecurityControls } from "../platform/auth/admin-security-policy.js";
import { runtimeEnvironment } from "../config/env.js";
import { FamilyPairing } from "../platform/auth/family-pairing.js";
import { FamilyDirectoryWorker } from "../platform/auth/family-directory-worker.js";
import { registerFamilyRoutes } from "../platform/auth/family-routes.js";
import type { installTools } from "./tools.js";

export function installFamilyConnections(context: Awaited<ReturnType<typeof installTools>>) {
  const {
    app,
    sql,
    tenantSecretCipher,
    betterAuthRuntime,
    betterAuthConfig,
    agentCredentialStore,
    actorFromAuthenticatedRequest,
    leaderGatedWorkers,
    defaultOrg,
  } = context;
  if (betterAuthRuntime?.familyClients !== undefined && betterAuthConfig !== undefined) {
    const family = new FamilyPairing(
      sql,
      tenantSecretCipher,
      betterAuthRuntime.familyClients,
      agentCredentialStore,
      betterAuthConfig.baseUrl,
      runtimeEnvironment().HELIX_FAMILY_ALLOW_PRIVATE_NETWORK === "true",
    );
    registerFamilyRoutes(app, family, actorFromAuthenticatedRequest);
    const backups = new FamilyBackupManagement(family, defaultOrg.id, (error) => {
      app.log.error({ error }, "Family backup reconciliation failed");
    });
    registerFamilyBackupRoutes(app, {
      service: backups,
      actor: actorFromAuthenticatedRequest,
      controls: async (actor) =>
        resolveAdminSecurityControls(
          context.runtimeConfiguration.current.security.tier,
          await context.securityPoliciesStore.get(actor.orgId, "mfa"),
        ),
      verified: async (request, actor) => context.mfaResolver.isMfaVerified(request, actor),
    });
    leaderGatedWorkers.push({ name: "family-backups", worker: backups });

    leaderGatedWorkers.push({
      name: "family-directory",
      worker: new FamilyDirectoryWorker(family, defaultOrg.id, (error) => {
        app.log.error({ error }, "Family directory reconciliation failed");
      }),
    });
  }
}
