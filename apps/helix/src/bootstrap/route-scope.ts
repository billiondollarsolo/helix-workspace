import { type FastifyInstance, type FastifyPluginAsync, type FastifyRequest } from "fastify";
import { HELIX_API_VERSION_PREFIX, internalApiUrl } from "../api/version.js";

export function isAdminMfaProtectedPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return (
    path.startsWith("/api/admin/") ||
    path === "/trpc/tools.explain" ||
    path.startsWith("/trpc/admin.")
  );
}

/** True when the client accepts an SSE stream for the MCP transport. */
export function acceptsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  return typeof value === "string" && value.includes("text/event-stream");
}

/** Registers a product API once, beneath the only supported major-version path. */
export async function registerCanonicalApi(
  app: FastifyInstance,
  plugin: FastifyPluginAsync,
): Promise<void> {
  await app.register(
    async (api) => {
      // Routing has already selected the versioned route at this point. Keep
      // handler-local path parsing independent of the deployment prefix (DAV,
      // webhook signatures, and Better Auth all parse request.url themselves)
      // without making the unversioned URL routable.
      api.addHook("onRequest", async (request) => {
        request.raw.url = internalApiUrl(request.raw.url ?? "/");
      });
      await plugin(api, {});
    },
    { prefix: HELIX_API_VERSION_PREFIX },
  );
}
