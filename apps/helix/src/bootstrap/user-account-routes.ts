import { registerAccountSecurityRoutes } from "../platform/auth/account-security-routes.js";
import { registerAdminUsersRoutes } from "../platform/auth/admin-users.js";
import { PostgresActorOffboardingStore } from "../platform/auth/actor-offboarding.js";
import { PostgresProfileStore, registerProfileRoutes } from "../platform/auth/profile.js";
import { registerUserAddressRoutes } from "../platform/auth/user-address-routes.js";
import { PostgresUserAddressStore } from "../platform/auth/user-addresses.js";
import type { installTools } from "./tools.js";

export async function registerUserAccountRoutes(context: Awaited<ReturnType<typeof installTools>>) {
  const {
    app,
    sql,
    adminUsersStore,
    actorFromAuthenticatedRequest,
    sessionActorResolver,
    auditStore,
    betterAuthRuntime,
  } = context;
  await registerAdminUsersRoutes(app, {
    store: adminUsersStore,
    actorFromRequest: actorFromAuthenticatedRequest,
    offboarding: new PostgresActorOffboardingStore(sql),
  });
  registerProfileRoutes(app, {
    store: new PostgresProfileStore(sql),
    sessionActorResolver,
    actorFromRequest: actorFromAuthenticatedRequest,
    auditSink: auditStore,
  });
  if (betterAuthRuntime !== undefined) {
    registerAccountSecurityRoutes(app, {
      auth: betterAuthRuntime.auth,
      sessionVerifier: betterAuthRuntime.sessionVerifier,
      sessionActorResolver,
      auditSink: auditStore,
    });
  }
  registerUserAddressRoutes(app, {
    store: new PostgresUserAddressStore(sql),
    actorFromRequest: actorFromAuthenticatedRequest,
    auditSink: auditStore,
  });
}
