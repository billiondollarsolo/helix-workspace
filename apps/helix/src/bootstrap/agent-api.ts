import { systemActor } from "../api/actor.js";
import { buildAsyncApiDocument } from "../api/asyncapi.js";
import { createStoreBackedMcpResourceProvider } from "../api/mcp-resources.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  buildProtectedResourceMetadata,
  handleMcpHttpPost,
  mcpMethodNotAllowedOutcome,
  mcpUnauthorizedOutcome,
  type McpHttpOutcome,
} from "../api/mcp-http.js";
import { formatSseEvent } from "../api/mcp.js";
import { buildOpenApiDocument, openApiDocumentToYaml } from "../api/openapi.js";
import { projectToolListItem } from "../api/tool-projection.js";
import { createRequestContext } from "../api/trace.js";
import { HELIX_API_VERSION_HEADER_VALUE, versionedApiPath } from "../api/version.js";
import { oauthAuthorizationServerMetadata } from "../platform/auth/authorization-server-metadata.js";
import type { ToolInvocationPrincipal } from "../platform/auth/tool-invocation-principal.js";
import { resolveCoreAppStatuses } from "../platform/apps/core-apps.js";
import { PASSWORDS_APP_FLAG, resolvePasswordsStatus } from "../platform/passwords/status.js";
import { loadEffectiveTenantConfig } from "../platform/tenancy/index.js";
import { registerAssistantStreamRoute } from "./assistant-routes.js";
import type { installObservability } from "./observability.js";
import { CredentialAuthError } from "./request-principal.js";
import { acceptsEventStream } from "./route-scope.js";
import {
  registerActionStatusRoutes,
  registerPendingActionMutationRoutes,
  registerToolRestRoutes,
} from "./tool-routes.js";

export async function installAgentApi(context: AgentApiContext) {
  const {
    app,
    metrics,
    idempotencyStore,
    oauthStore,
    agentCredentialStore,
    calendarStore,
    chatStore,
    platformConfig,
    orgStore,
    bootEnv,
    sessionActorResolver,
    principalFromAuthenticatedRequest,
    actorFromAuthenticatedRequest,
    coreApps,
    mailStore,
    driveStore,
    eventSchemas,
    tools,
    assistantOrchestrator,
  } = context;
  app.get("/api/tools", async (request) => ({
    tools: (await tools.listVisible(await actorFromAuthenticatedRequest(request))).map(
      projectToolListItem,
    ),
  }));

  // Core-app enablement, projected for the web shell. Any authenticated user
  // can read this — the shell drives its left rail + route gating from it so
  // a disabled (or out-of-role) core app is never shown or routed to. Admins
  // toggle enablement via `/api/admin/core-apps`. The optional password
  // manager rides along so the shell needs no second request to place it.
  app.get("/api/core-apps", async (request) => {
    const actor = await actorFromAuthenticatedRequest(request);
    const tenantConfig = await loadEffectiveTenantConfig({ orgs: orgStore }, actor.orgId);
    const status = await platformConfig.getStatus();
    const modules = status.config.modules;
    const currentCoreApps = resolveCoreAppStatuses({
      ...(modules === undefined ? {} : { modules }),
      role: coreApps.role,
      appIds: coreApps.appIds,
    });
    return {
      role: coreApps.role,
      apps: currentCoreApps.statuses.map((appStatus) => ({
        id: appStatus.id,
        name: appStatus.name,
        enabled: appStatus.enabled,
        registered: coreApps.status(appStatus.id).registered,
      })),
      passwords: resolvePasswordsStatus(
        bootEnv.HELIX_PASSWORDS_URL,
        tenantConfig?.features[PASSWORDS_APP_FLAG] === true,
      ),
    };
  });

  // PRD §9.5: the assistant SSE streaming endpoint. Registered before the
  // parametric `/api/tools/:toolId` route so the static `assistant.chat` path
  // takes precedence and can negotiate `text/event-stream` for streamed turns.
  registerAssistantStreamRoute(app, {
    orchestrator: assistantOrchestrator,
    tools,
    tokenStore: oauthStore,
    credentialStore: agentCredentialStore,
    ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
    onError: (error) => {
      app.log.error(
        {
          err:
            error instanceof Error
              ? { type: error.name, message: error.message, stack: error.stack }
              : undefined,
        },
        "Assistant SSE stream error",
      );
    },
  });

  registerToolRestRoutes(
    app,
    {
      tools,
      metrics,
      tokenStore: oauthStore,
      idempotencyStore,
      credentialStore: agentCredentialStore,
      ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
    },
    ["POST"],
  );

  registerActionStatusRoutes(app, {
    tools,
    tokenStore: oauthStore,
    credentialStore: agentCredentialStore,
    ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
  });

  registerPendingActionMutationRoutes(app, {
    tools,
    tokenStore: oauthStore,
    credentialStore: agentCredentialStore,
    ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
  });

  registerToolRestRoutes(
    app,
    {
      tools,
      metrics,
      tokenStore: oauthStore,
      credentialStore: agentCredentialStore,
      ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
    },
    ["GET"],
  );

  app.get("/openapi.json", async () =>
    buildOpenApiDocument(app.swagger(), await tools.listVisible(systemActor)),
  );

  // P1-10: YAML rendering of the OpenAPI document alongside the JSON form.
  app.get("/openapi.yaml", async (_request, reply) => {
    const document = buildOpenApiDocument(app.swagger(), await tools.listVisible(systemActor));
    reply.header("content-type", "application/yaml; charset=utf-8");
    return openApiDocumentToYaml(document);
  });

  app.get("/asyncapi.json", async () => buildAsyncApiDocument({}, eventSchemas.list()));

  const mcpResourceProvider = () =>
    createStoreBackedMcpResourceProvider({
      chat: chatStore,
      calendar: calendarStore,
      mail: mailStore,
      drive: driveStore,
    });

  const publicBaseUrl = mcpPublicBaseUrl(context);
  app.post("/mcp", async (request, reply) => {
    let principal: ToolInvocationPrincipal;
    try {
      principal = await principalFromAuthenticatedRequest(request);
    } catch (error) {
      // MC5: a rejected bearer gets a 401 challenge before any SSE stream opens.
      if (error instanceof CredentialAuthError && error.statusCode === 401) {
        return sendMcpOutcome(reply, mcpUnauthorizedOutcome(publicBaseUrl, error.message));
      }
      throw error;
    }
    const outcome = await handleMcpHttpPost({
      tools,
      principal,
      request: createRequestContext(request),
      body: request.body,
      resources: mcpResourceProvider(),
      idempotencyStore,
      headers: request.headers,
      acceptsEventStream: acceptsEventStream(request),
      publicBaseUrl,
    });
    return sendMcpOutcome(reply, outcome);
  });
  // MC6: no server-initiated SSE stream and no session teardown endpoint.
  app.get("/mcp", async (_request, reply) => sendMcpOutcome(reply, mcpMethodNotAllowedOutcome()));
  app.delete("/mcp", async (_request, reply) =>
    sendMcpOutcome(reply, mcpMethodNotAllowedOutcome()),
  );
  return { ...context };
}

type AgentApiContext = Awaited<ReturnType<typeof installObservability>>;

/** Public origin used for MCP metadata and approval links. */
function mcpPublicBaseUrl(context: Pick<AgentApiContext, "bootEnv" | "oauthIssuer">): string {
  return (
    context.bootEnv.HELIX_PUBLIC_URL ??
    context.bootEnv.PUBLIC_BASE_URL ??
    context.oauthIssuer
  ).replace(/\/+$/u, "");
}

export async function sendMcpOutcome(reply: FastifyReply, outcome: McpHttpOutcome) {
  if (outcome.kind === "stream") {
    reply.raw.writeHead(outcome.statusCode, {
      ...outcome.headers,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "api-version": HELIX_API_VERSION_HEADER_VALUE,
    });
    for await (const event of outcome.events) {
      reply.raw.write(formatSseEvent(event));
    }
    reply.raw.end();
    return reply;
  }
  reply.code(outcome.statusCode).headers(outcome.headers);
  return outcome.body === undefined ? reply.send() : reply.send(outcome.body);
}

/**
 * Root-level discovery documents for MCP clients (MC5): RFC 9728 protected
 * resource metadata and an issuer-relative RFC 8414 alias. Registered on the
 * root app because well-known URIs are not versioned.
 */
export function registerMcpWellKnownRoutes(
  app: FastifyInstance,
  context: Pick<AgentApiContext, "bootEnv" | "oauthIssuer" | "tools">,
): void {
  const publicBaseUrl = mcpPublicBaseUrl(context);
  const protectedResource = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.header("cache-control", "public, max-age=300").send(
      buildProtectedResourceMetadata({
        publicBaseUrl,
        authorizationServer: context.oauthIssuer,
        tools: context.tools.list(),
      }),
    );
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get(`/.well-known/oauth-protected-resource${versionedApiPath("/mcp")}`, protectedResource);
  app.get("/.well-known/oauth-authorization-server", async (_request, reply) =>
    reply
      .header("cache-control", "public, max-age=3600")
      .send(oauthAuthorizationServerMetadata(context.oauthIssuer)),
  );
}
