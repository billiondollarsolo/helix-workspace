import { BadRequestError } from "../api/api-error.js";
import { registerPlatformConfigAdminRoutes } from "../platform/config/admin.js";
import { registerAiRetrievalRoutes } from "../platform/config/ai-retrieval-routes.js";
import { getWebSearchEnabled, testWebSearch } from "../platform/search/web.js";
import type { installTools } from "./tools.js";

export async function registerAiConfigurationRoutes(
  context: Awaited<ReturnType<typeof installTools>>,
) {
  const {
    app,
    platformConfig,
    actorFromAuthenticatedRequest,
    runtimeConfiguration,
    semanticSearchRuntime,
    searchReindexJobService,
    assertRuntimeResidency,
  } = context;
  await registerPlatformConfigAdminRoutes(app, {
    service: platformConfig,
    actorFromRequest: actorFromAuthenticatedRequest,
    validateConfig: (config) => {
      try {
        semanticSearchRuntime.validate(config);
      } catch {
        throw new BadRequestError(
          "Invalid workspace retrieval configuration. Check the backend, embedding model, dimensions, endpoints, and security policy.",
        );
      }
      try {
        assertRuntimeResidency(config);
      } catch {
        throw new BadRequestError(
          "This provider configuration violates deployment residency. Production AI providers must declare processing in the workspace's region; configure a matching regional endpoint and processing region.",
        );
      }
    },
  });
  await registerAiRetrievalRoutes(app, {
    actorFromRequest: actorFromAuthenticatedRequest,
    config: () => runtimeConfiguration.current,
    vector: semanticSearchRuntime,
    web: { test: testWebSearch, enabled: getWebSearchEnabled },
    ...(searchReindexJobService === undefined ? {} : { jobs: searchReindexJobService }),
  });
}
