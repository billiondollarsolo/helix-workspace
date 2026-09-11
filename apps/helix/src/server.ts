export {
  getSmtpMailReceiverConfig,
  HELIX_LOG_REDACT_PATHS,
  verifyDefaultOrgAtBoot,
} from "./bootstrap/default-org.js";
export {
  CredentialAuthError,
  installTenantApiRpsLimitHook,
  installUntrustedIdentityHeaderGuard,
} from "./bootstrap/request-principal.js";
export { isAdminMfaProtectedPath, registerCanonicalApi } from "./bootstrap/route-scope.js";
export {
  registerActionStatusRoutes,
  registerPendingActionMutationRoutes,
  registerToolRestRoutes,
} from "./bootstrap/tool-routes.js";
export { getAuditDestinationConfigs, getImmutableAuditShippingConfig } from "./config/audit.js";
export { getBetterAuthRuntimeConfig } from "./config/auth.js";
export {
  aiRoutingPolicyFromConfig,
  createAssistantEmbeddingProvider,
  createAssistantProviders,
} from "./platform/ai/providers/factory.js";
import type { FastifyInstance } from "fastify";
import { installAgentApi } from "./bootstrap/agent-api.js";
import { installApps } from "./bootstrap/apps.js";
import { installAuditWorkers } from "./bootstrap/audit-workers.js";
import { installAuth } from "./bootstrap/auth.js";
import { installHttp } from "./bootstrap/http.js";
import { installMailWorkers } from "./bootstrap/mail-workers.js";
import { installObservability } from "./bootstrap/observability.js";
import { registerCanonicalApi } from "./bootstrap/route-scope.js";
import { installRoutes } from "./bootstrap/routes.js";
import { installSearch } from "./bootstrap/search-runtime.js";
import { installStorage } from "./bootstrap/storage.js";
import { installTools } from "./bootstrap/tools.js";
import { installWorkers } from "./bootstrap/workers.js";
import { ReadinessMonitor, registerHealthRoutes } from "./platform/health/readiness.js";
export async function createHelixServer(): Promise<FastifyInstance> {
  const http = await installHttp();
  const auth = await installAuth(http);
  const apps = await installApps(auth);
  const storage = await installStorage(apps);
  const search_runtime = await installSearch(storage);
  const mail_workers = await installMailWorkers(search_runtime);
  const audit_workers = await installAuditWorkers(mail_workers);
  const tools = await installTools(audit_workers);
  await registerCanonicalApi(tools.app, async (app) => {
    const routes = await installRoutes({ ...tools, app });
    const workers = await installWorkers(routes);
    const observability = await installObservability(workers);
    await installAgentApi(observability);
  });
  registerHealthRoutes(tools.app, new ReadinessMonitor(tools.readinessProbes));
  return tools.app;
}
