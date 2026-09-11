import { systemActor } from "../api/actor.js";
import { buildAsyncApiDocument } from "../api/asyncapi.js";
import { createStoreBackedMcpResourceProvider } from "../api/mcp-resources.js";
import { formatSseEvent, handleMcpJsonRpcRequest, handleMcpStreamingRequest } from "../api/mcp.js";
import { buildOpenApiDocument, openApiDocumentToYaml } from "../api/openapi.js";
import { projectToolListItem } from "../api/tool-projection.js";
import { createRequestContext } from "../api/trace.js";
import { HELIX_API_VERSION_HEADER_VALUE } from "../api/version.js";
import { resolveCoreAppStatuses } from "../platform/apps/core-apps.js";
import { registerAssistantStreamRoute } from "./assistant-routes.js";
import type { installObservability } from "./observability.js";
import { acceptsEventStream } from "./route-scope.js";
import {
  registerActionStatusRoutes,
  registerPendingActionMutationRoutes,
  registerToolRestRoutes,
} from "./tool-routes.js";

export async function installAgentApi(context: Awaited<ReturnType<typeof installObservability>>) {
  const {
    app,
    metrics,
    idempotencyStore,
    oauthStore,
    agentCredentialStore,
    calendarStore,
    chatStore,
    platformConfig,
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
  // toggle enablement via `/api/admin/core-apps`.
  app.get("/api/core-apps", async (request) => {
    await actorFromAuthenticatedRequest(request);
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

  app.post("/mcp", async (request, reply) => {
    const principal = await principalFromAuthenticatedRequest(request);
    const requestContext = createRequestContext(request);
    // PRD §9.5: when the client negotiates SSE, stream the JSON-RPC response
    // over text/event-stream so long-running tool calls keep the connection
    // warm; otherwise fall back to a plain JSON-RPC POST response.
    if (acceptsEventStream(request)) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "api-version": HELIX_API_VERSION_HEADER_VALUE,
      });
      for await (const event of handleMcpStreamingRequest({
        tools,
        principal,
        request: requestContext,
        body: request.body,
        resources: mcpResourceProvider(),
        idempotencyStore,
      })) {
        reply.raw.write(formatSseEvent(event));
      }
      reply.raw.end();
      return reply;
    }
    return handleMcpJsonRpcRequest({
      tools,
      principal,
      request: requestContext,
      body: request.body,
      resources: mcpResourceProvider(),
      idempotencyStore,
    });
  });
  return { ...context };
}
