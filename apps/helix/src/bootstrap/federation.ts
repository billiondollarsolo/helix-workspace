import { FederationBackupManagement } from "../platform/backup/federation-management.js";
import { registerFederationBackupRoutes } from "../platform/backup/federation-routes.js";
import { resolveAdminSecurityControls } from "../platform/auth/admin-security-policy.js";
import { runtimeEnvironment } from "../config/env.js";
import { FederationPairing, parseFederationRoutes } from "../platform/auth/federation-pairing.js";
import { FederationDirectoryWorker } from "../platform/auth/federation-directory-worker.js";
import { registerFederationRoutes } from "../platform/auth/federation-routes.js";
import type { installTools } from "./tools.js";

export function installFederationConnections(context: Awaited<ReturnType<typeof installTools>>) {
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
  if (betterAuthRuntime?.federationClients !== undefined && betterAuthConfig !== undefined) {
    const federation = new FederationPairing(
      sql,
      tenantSecretCipher,
      betterAuthRuntime.federationClients,
      agentCredentialStore,
      betterAuthConfig.baseUrl,
      runtimeEnvironment().HELIX_FEDERATION_ALLOW_PRIVATE_NETWORK === "true",
      parseFederationRoutes(runtimeEnvironment().HELIX_FEDERATION_ROUTES),
    );
    registerFederationRoutes(app, federation, actorFromAuthenticatedRequest);
    const backups = new FederationBackupManagement(federation, defaultOrg.id, (error) => {
      app.log.error({ error }, "Federation backup reconciliation failed");
    });
    registerFederationBackupRoutes(app, {
      service: backups,
      actor: actorFromAuthenticatedRequest,
      controls: async (actor) =>
        resolveAdminSecurityControls(
          context.runtimeConfiguration.current.security.tier,
          await context.securityPoliciesStore.get(actor.orgId, "mfa"),
        ),
      verified: async (request, actor) => context.mfaResolver.isMfaVerified(request, actor),
    });
    leaderGatedWorkers.push({ name: "federation-backups", worker: backups });

    leaderGatedWorkers.push({
      name: "federation-directory",
      worker: new FederationDirectoryWorker(federation, defaultOrg.id, (error) => {
        app.log.error({ error }, "Federation directory reconciliation failed");
      }),
    });
  }
}
