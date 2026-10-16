import { registerAccountSecurityRoutes } from "../platform/auth/account-security-routes.js";
import { registerExternalEmailMfaRoutes } from "../platform/auth/external-email-mfa-routes.js";
import {
  PostgresAdminUserInviteStore,
  registerAdminUserInviteRoutes,
} from "../platform/auth/admin-user-invites.js";
import { registerAdminUsersRoutes } from "../platform/auth/admin-users.js";
import { PostgresActorOffboardingStore } from "../platform/auth/actor-offboarding.js";
import { PostgresProfileStore, registerProfileRoutes } from "../platform/auth/profile.js";
import { registerUserAddressRoutes } from "../platform/auth/user-address-routes.js";
import { PostgresUserAddressStore } from "../platform/auth/user-addresses.js";
import type { installTools } from "./tools.js";
import { registerPasswordVaultRoutes } from "../platform/passwords/routes.js";
import { PostgresPasswordVaultStore } from "../platform/passwords/vault.js";
import { PASSWORDS_APP_FLAG } from "../platform/passwords/status.js";
import { loadEffectiveTenantConfig } from "../platform/tenancy/index.js";

export async function registerUserAccountRoutes(context: Awaited<ReturnType<typeof installTools>>) {
  const {
    app,
    sql,
    adminUsersStore,
    actorFromAuthenticatedRequest,
    sessionActorResolver,
    auditStore,
    betterAuthRuntime,
    externalEmailMfa,
    recoveryCodes,
    bootEnv,
    orgStore,
    outboxStore,
  } = context;
  await registerAdminUsersRoutes(app, {
    store: adminUsersStore,
    actorFromRequest: actorFromAuthenticatedRequest,
    offboarding: new PostgresActorOffboardingStore(sql),
  });
  await registerAdminUserInviteRoutes(app, {
    store: new PostgresAdminUserInviteStore(sql),
    orgs: orgStore,
    outbox: outboxStore,
    actorFromRequest: actorFromAuthenticatedRequest,
    publicBaseUrl:
      bootEnv.HELIX_PUBLIC_URL ??
      bootEnv.BETTER_AUTH_URL ??
      bootEnv.PUBLIC_BASE_URL ??
      "http://localhost:3000",
  });
  registerProfileRoutes(app, {
    store: new PostgresProfileStore(sql),
    sessionActorResolver,
    actorFromRequest: actorFromAuthenticatedRequest,
    auditSink: auditStore,
  });
  registerPasswordVaultRoutes(app, {
    store: new PostgresPasswordVaultStore(sql),
    sessionActorResolver,
    audit: auditStore,
    enabled: async (orgId) =>
      (await loadEffectiveTenantConfig({ orgs: orgStore }, orgId))?.features[PASSWORDS_APP_FLAG] ===
      true,
  });
  if (betterAuthRuntime !== undefined) {
    registerAccountSecurityRoutes(app, {
      auth: betterAuthRuntime.auth,
      sessionVerifier: betterAuthRuntime.sessionVerifier,
      sessionActorResolver,
      auditSink: auditStore,
    });
    if (externalEmailMfa !== undefined)
      registerExternalEmailMfaRoutes(app, {
        auth: betterAuthRuntime.auth,
        verifier: betterAuthRuntime.sessionVerifier,
        actors: sessionActorResolver,
        factors: externalEmailMfa,
        recoveryCodes,
        audit: auditStore,
      });
  }
  registerUserAddressRoutes(app, {
    store: new PostgresUserAddressStore(sql),
    actorFromRequest: actorFromAuthenticatedRequest,
    auditSink: auditStore,
  });
}
