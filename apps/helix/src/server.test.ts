import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@helix/sdk-types";
import { createPlatformMetrics } from "./api/metrics.js";
import {
  InMemoryOAuthClientStore,
  type AccessTokenRecord,
} from "./platform/auth/oauth.js";
import { PostgresOAuthStore } from "./platform/auth/postgres-store.js";
import { PostgresAuditStore } from "./platform/audit/store.js";
import { PostgresPlatformConfigStore } from "./platform/config/admin.js";
import { PostgresOrgStore, PostgresPlanStore, type OrgRecord } from "./platform/tenancy/index.js";
import { InMemoryAgentRateCostLimiter, type AgentLimitBudget } from "./platform/limits/index.js";
import {
  PostgresTenantStorageMigrationJobStore,
  type TenantStorageMigrationJobRecord,
} from "./platform/storage/index.js";
import { registerSearchTools } from "./platform/search/index.js";
import type { IndexDocument, SearchEngine, SearchRequest, SearchResponse } from "./platform/search/types.js";
import { createToolRegistry } from "./platform/tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "./platform/tools/registry.js";
import { InMemoryIdempotencyStore } from "./api/idempotency.js";
import {
  aiRoutingPolicyFromConfig,
  createAssistantEmbeddingProvider,
  createAssistantProviders,
  createHelixServer,
  formatAssistantSseEvent,
  getAuditDestinationConfigs,
  getBetterAuthRuntimeConfig,
  getImmutableAuditShippingConfig,
  getOutboundMailConfig,
  getSmtpMailReceiverConfig,
  registerActionStatusRoutes,
  registerAssistantStreamRoute,
  registerToolRestRoutes,
  rewriteVersionedApiUrl,
  type AssistantStreamOrchestrator,
} from "./server.js";
import type { AssistantStreamEvent } from "./platform/assistant/index.js";

const now = new Date("2026-05-20T00:00:00.000Z");
const later = new Date("2026-05-20T01:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mail server env config", () => {
  it("uses Mailpit-compatible outbound SMTP env", () => {
    expect(
      getOutboundMailConfig({
        MAIL_SMTP_HOST: "mailpit",
        MAIL_SMTP_PORT: "1025",
        MAIL_SMTP_SECURE: "false",
      }),
    ).toEqual({
      host: "mailpit",
      port: 1025,
      secure: false,
    });
  });

  it("starts the in-process SMTP receiver only when explicitly enabled", () => {
    expect(getSmtpMailReceiverConfig({})).toBeUndefined();
    expect(
      getSmtpMailReceiverConfig({
        HELIX_DEFAULT_ORG_ID: "org-local",
        MAIL_SMTP_RECEIVER_ENABLED: "true",
        MAIL_SMTP_RECEIVER_HOST: "0.0.0.0",
        MAIL_SMTP_RECEIVER_PORT: "2525",
      }),
    ).toEqual({
      orgId: "org-local",
      host: "0.0.0.0",
      port: 2525,
    });
  });
});

describe("BetterAuth server env config", () => {
  it("defaults on for local dev and requires a production secret", () => {
    expect(
      getBetterAuthRuntimeConfig({
        DATABASE_URL: "postgres://helix:secret@postgres:5432/helix",
        NODE_ENV: "development",
      }),
    ).toMatchObject({
      databaseUrl: "postgres://helix:secret@postgres:5432/helix",
      baseUrl: "http://localhost:3000",
    });

    expect(
      getBetterAuthRuntimeConfig({
        BETTER_AUTH_ENABLED: "false",
      }),
    ).toBeUndefined();

    expect(() =>
      getBetterAuthRuntimeConfig({
        DATABASE_URL: "postgres://helix:secret@postgres:5432/helix",
        NODE_ENV: "production",
      }),
    ).toThrow("BETTER_AUTH_SECRET must be at least 32 characters");
  });
});

describe("createHelixServer tenant config admin routes", () => {
  it("registers tenant config read and BYO storage probe endpoints", async () => {
    const org = orgRecord();
    vi.stubEnv("BETTER_AUTH_ENABLED", "false");
    vi.spyOn(PostgresPlatformConfigStore.prototype, "loadOverrides").mockResolvedValue({});
    vi.spyOn(PostgresOAuthStore.prototype, "findToken").mockResolvedValue(
      accessToken({
        token: "tenant-config-token",
        actorId: "admin-1",
        orgId: org.id,
        scopes: ["admin.console.read", "admin.console.write"],
      }),
    );
    vi.spyOn(PostgresOrgStore.prototype, "findById").mockResolvedValue(org);
    vi.spyOn(PostgresPlanStore.prototype, "findById").mockResolvedValue(null);
    vi.spyOn(PostgresAuditStore.prototype, "append").mockResolvedValue({
      id: "audit-1",
      thisHash: "hash-1",
    });
    const migrationJob = tenantStorageMigrationJobRecord({
      orgId: org.id,
      requestedByActorId: "admin-1",
    });
    const createMigrationJob = vi
      .spyOn(PostgresTenantStorageMigrationJobStore.prototype, "create")
      .mockResolvedValue(migrationJob);
    const findMigrationJob = vi.spyOn(
      PostgresTenantStorageMigrationJobStore.prototype,
      "findByIdForOrg",
    );
    findMigrationJob.mockResolvedValue(migrationJob);

    const app = await createHelixServer();
    try {
      const headers = {
        authorization: "Bearer tenant-config-token",
        "x-helix-mfa-verified": "true",
      };
      const read = await app.inject({
        method: "GET",
        url: "/api/admin/tenant-config",
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        tenantConfig: {
          orgId: org.id,
          features: { ai_smart_compose: true },
        },
      });

      const storageProbe = await app.inject({
        method: "POST",
        url: "/api/admin/tenant-config/byo-storage/test",
        headers,
      });
      expect(storageProbe.statusCode).toBe(200);
      expect(storageProbe.json()).toMatchObject({
        health: {
          status: "degraded",
        },
      });

      const migration = await app.inject({
        method: "POST",
        url: "/api/admin/tenant-config/byo-storage/migrations",
        headers,
        payload: { target: "byo", dryRun: true },
      });
      expect(migration.statusCode).toBe(202);
      expect(migration.json()).toMatchObject({
        migration: {
          id: migrationJob.id,
          orgId: org.id,
          target: "byo",
          status: "queued",
          dryRun: true,
        },
      });
      expect(createMigrationJob).toHaveBeenCalledWith({
        orgId: org.id,
        target: "byo",
        dryRun: true,
        requestedByActorId: "admin-1",
        sourceStorage: {
          managedBy: "helix-default",
          storage: null,
        },
        targetStorage: {
          managedBy: "byo",
          storage: null,
        },
      });

      const migrationStatus = await app.inject({
        method: "GET",
        url: `/api/admin/tenant-config/byo-storage/migrations/${migrationJob.id}`,
        headers,
      });
      expect(migrationStatus.statusCode).toBe(200);
      expect(migrationStatus.json()).toMatchObject({
        migration: {
          id: migrationJob.id,
          status: "queued",
        },
      });
      expect(findMigrationJob).toHaveBeenCalledWith({
        id: migrationJob.id,
        orgId: org.id,
      });
    } finally {
      await app.close();
    }
  });
});

describe("immutable audit shipping env config", () => {
  it("is disabled by default and parses explicit immutable S3 settings", () => {
    expect(getImmutableAuditShippingConfig({})).toBeUndefined();
    expect(
      getImmutableAuditShippingConfig({
        AUDIT_IMMUTABLE_S3_ENABLED: "true",
        AUDIT_IMMUTABLE_S3_ENDPOINT: "http://rustfs:9000",
        AUDIT_IMMUTABLE_S3_BUCKET: "helix-audit",
        AUDIT_IMMUTABLE_S3_ACCESS_KEY: "audit-access",
        AUDIT_IMMUTABLE_S3_SECRET_KEY: "audit-secret",
        AUDIT_IMMUTABLE_S3_REGION: "us-west-2",
        AUDIT_IMMUTABLE_S3_PREFIX: "audit/prod",
        AUDIT_IMMUTABLE_S3_BATCH_SIZE: "25",
        AUDIT_IMMUTABLE_S3_INTERVAL_MS: "5000",
        AUDIT_IMMUTABLE_S3_RETENTION_DAYS: "90",
        AUDIT_IMMUTABLE_S3_OBJECT_LOCK_MODE: "GOVERNANCE",
      }),
    ).toEqual({
      endpoint: "http://rustfs:9000",
      bucket: "helix-audit",
      accessKeyId: "audit-access",
      secretAccessKey: "audit-secret",
      region: "us-west-2",
      forcePathStyle: true,
      prefix: "audit/prod",
      batchSize: 25,
      intervalMs: 5000,
      retentionDays: 90,
      objectLockMode: "GOVERNANCE",
    });
  });

  it("fails closed when immutable audit shipping is enabled without a destination", () => {
    expect(() =>
      getImmutableAuditShippingConfig({
        AUDIT_IMMUTABLE_S3_ENABLED: "true",
      }),
    ).toThrow("AUDIT_IMMUTABLE_S3_ENDPOINT or AUDIT_S3_ENDPOINT is required");
  });
});

describe("audit destination selection (Follow-up A)", () => {
  it("returns no destinations when none are enabled", () => {
    expect(getAuditDestinationConfigs({})).toEqual([]);
  });

  it("selects the SIEM syslog destination from config", () => {
    const configs = getAuditDestinationConfigs({
      AUDIT_SIEM_SYSLOG_ENABLED: "true",
      AUDIT_SIEM_SYSLOG_HOST: "siem.internal",
      AUDIT_SIEM_SYSLOG_PORT: "6514",
      AUDIT_SIEM_SYSLOG_TRANSPORT: "tls",
      AUDIT_SIEM_SYSLOG_FORMAT: "leef",
    });
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      destination: "siem-syslog",
      host: "siem.internal",
      port: 6514,
      transport: "tls",
      format: "leef",
    });
  });

  it("selects the WORM Postgres destination from config", () => {
    const configs = getAuditDestinationConfigs({ AUDIT_WORM_POSTGRES_ENABLED: "true" });
    expect(configs).toEqual([{ destination: "audit-immutable-postgres" }]);
  });

  it("selects multiple destinations additively (Tier 3: immutable S3 + SIEM)", () => {
    const configs = getAuditDestinationConfigs({
      AUDIT_IMMUTABLE_S3_ENABLED: "true",
      AUDIT_IMMUTABLE_S3_ENDPOINT: "http://rustfs:9000",
      AUDIT_IMMUTABLE_S3_BUCKET: "helix-audit",
      AUDIT_IMMUTABLE_S3_ACCESS_KEY: "k",
      AUDIT_IMMUTABLE_S3_SECRET_KEY: "s",
      AUDIT_SIEM_SYSLOG_ENABLED: "true",
      AUDIT_SIEM_SYSLOG_HOST: "siem.internal",
    });
    expect(configs.map((config) => config.destination)).toEqual([
      "immutable-s3",
      "siem-syslog",
    ]);
  });

  it("fails closed when SIEM syslog is enabled without a host", () => {
    expect(() =>
      getAuditDestinationConfigs({ AUDIT_SIEM_SYSLOG_ENABLED: "true" }),
    ).toThrow("AUDIT_SIEM_SYSLOG_HOST is required");
  });
});

describe("AI runtime config", () => {
  it("creates configured LLM providers and feature routing from platform AI config", async () => {
    const providers = createAssistantProviders({
      enabled: true,
      providers: [
        {
          id: "ollama-local",
          plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
          tags: ["local-only"],
          config: {
            baseUrl: "http://ollama:11434/v1",
            models: ["llama3.1:70b"],
            defaultModel: "llama3.1:70b",
          },
        },
      ],
      routing: {
        rules: [
          {
            feature: "assistant.chat",
            primary: { providerId: "ollama-local", model: "llama3.1:70b" },
          },
        ],
      },
    });

    expect(providers.map((provider) => provider.id)).toContain("ollama-local");
    expect(await providers.find((provider) => provider.id === "ollama-local")?.models()).toEqual([
      { id: "llama3.1:70b" },
    ]);
    expect(
      aiRoutingPolicyFromConfig({
        routing: {
          rules: [
            {
              feature: "assistant.chat",
              primary: { providerId: "ollama-local", model: "llama3.1:70b" },
              fallback: { providerId: "assistant.local", model: "assistant-local-model" },
            },
          ],
        },
      }),
    ).toEqual({
      defaultProviderId: "ollama-local",
      featureProviders: { "assistant.chat": "ollama-local" },
      featureRoutes: {
        "assistant.chat": {
          primary: { providerId: "ollama-local", model: "llama3.1:70b" },
          fallback: { providerId: "assistant.local", model: "assistant-local-model" },
        },
      },
    });
  });

  it("creates configured OpenAI-compatible embeddings for assistant memory", async () => {
    const requests: { readonly input: URL; readonly init: RequestInit | undefined }[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      requests.push({ input: input instanceof URL ? input : new URL(input), init });
      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const provider = createAssistantEmbeddingProvider(
      {
        enabled: true,
        embeddingProvider: {
          plugin: "com.helix.embedding-openai-compatible@^1.0.0",
          config: {
            id: "embedding.local",
            baseUrl: "http://ollama:11434/v1",
            apiKeyEnv: "EMBEDDING_API_KEY",
            defaultModel: "nomic-embed-text",
            defaultDimensions: 768,
            maxBatchSize: 1,
            headers: { "x-helix-provider": "test" },
          },
        },
      },
      { EMBEDDING_API_KEY: "secret-key" },
    );

    await expect(provider.embed(["hello"])).resolves.toEqual([[0.1, 0.2, 0.3]]);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toBeDefined();
    if (request === undefined) {
      throw new Error("Expected embedding request");
    }
    expect(request.input.toString()).toBe("http://ollama:11434/v1/embeddings");
    expect(request.init?.headers).toMatchObject({
      authorization: "Bearer secret-key",
      "x-helix-provider": "test",
    });
    expect(typeof request.init?.body).toBe("string");
    expect(JSON.parse(request.init?.body as string)).toEqual({
      model: "nomic-embed-text",
      input: ["hello"],
    });
  });

  it("rejects configured assistant memory embeddings with non-768 dimensions", () => {
    expect(() =>
      createAssistantEmbeddingProvider(
        {
          embeddingProvider: {
            plugin: "com.helix.embedding-openai-compatible@^1.0.0",
            config: {
              defaultModel: "text-embedding-3-small",
              defaultDimensions: 1536,
            },
          },
        },
        {},
      ),
    ).toThrow("Assistant memory embedding provider must use 768 dimensions");
  });

  it("falls back to deterministic embeddings when embedding config is missing", async () => {
    const provider = createAssistantEmbeddingProvider(undefined, {});
    await expect(provider.embed(["same"])).resolves.toEqual(await provider.embed(["same"]));
    await expect(provider.embed(["different"])).resolves.not.toEqual(await provider.embed(["same"]));
  });
});

describe("tool REST routes", () => {
  it("invokes search.query over GET with bearer-token actor auth and scoped query input", async () => {
    const engine = new FakeSearchEngine();
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "get-token",
        actorId: "actor-get",
        orgId: "org-get",
        scopes: ["platform.read", "mail.read", "drive.read"],
      }),
    );
    const app = createToolRouteTestApp({ engine, tokenStore });
    const params = new URLSearchParams({
      query: " launch ",
      limit: "5",
      offset: "2",
    });
    params.append("types", "mail");
    params.append("types", "chat");
    params.append("types", "drive");

    const response = await app.inject({
      method: "GET",
      url: `/api/tools/search.query?${params.toString()}`,
      headers: {
        authorization: "Bearer get-token",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ query: "launch", estimatedTotalHits: 0 });
    expect(engine.searches).toEqual([
      {
        query: "launch",
        types: ["mail", "drive"],
        limit: 5,
        offset: 2,
        filter: 'attributes.orgId = "org-get"',
      },
    ]);
    await app.close();
  });

  it("invokes search.query over POST with bearer-token actor auth and scoped JSON input", async () => {
    const engine = new FakeSearchEngine([{ id: "docs:1", type: "docs", title: "Launch plan" }]);
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "post-token",
        actorId: "actor-post",
        orgId: "org-post",
        scopes: ["platform.read", "docs.read"],
      }),
    );
    const app = createToolRouteTestApp({ engine, tokenStore });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/search.query",
      headers: {
        authorization: "Bearer post-token",
      },
      payload: {
        query: "launch",
        types: ["docs", "calendar"],
        limit: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      query: "launch",
      estimatedTotalHits: 1,
      hits: [{ id: "docs:1", type: "docs", title: "Launch plan" }],
    });
    expect(engine.searches).toEqual([
      {
        query: "launch",
        types: ["docs"],
        limit: 3,
        offset: 0,
        filter: 'attributes.orgId = "org-post"',
      },
    ]);
    await app.close();
  });

  it("returns Retry-After and rate-limit metadata for limited agent REST tool calls", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "agent-token",
        actorId: "agent-rest",
        orgId: "org-rest",
        actorType: "agent",
        scopes: ["platform.read"],
      }),
    );
    const tools = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: requestLimitBudget,
    });
    let calls = 0;
    tools.register(
      tool({
        id: "limited.rest",
        permission: "platform.read",
        handler: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );
    const app = fastify();
    registerToolRestRoutes(app, {
      tools,
      metrics: createPlatformMetrics(),
      tokenStore,
    });

    await expect(
      app.inject({
        method: "POST",
        url: "/api/tools/limited.rest",
        headers: { authorization: "Bearer agent-token" },
        payload: {},
      }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/limited.rest",
      headers: { authorization: "Bearer agent-token" },
      payload: {},
    });

    expect(response.statusCode).toBe(429);
    const body = rateLimitedBody(response.json());
    expect(response.headers["retry-after"]).toBe(String(body.error.details.retryAfterSeconds));
    expect(body).toMatchObject({
      error: {
        code: "rate_limited",
        message: "Agent tool invocation limit exceeded: requests_per_minute",
        details: {
          rateLimit: {
            reason: "requests_per_minute",
            usage: {
              requestsPerMinute: { limit: 1, used: 1, remaining: 0 },
            },
          },
        },
      },
    });
    expect(typeof body.error.traceId).toBe("string");
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(calls).toBe(1);
    await app.close();
  });
});

describe("assistant SSE streaming endpoint (PRD §9.5)", () => {
  function fakeStreamOrchestrator(
    events: readonly AssistantStreamEvent[],
    capture?: { input?: unknown },
  ): AssistantStreamOrchestrator {
    return {
      async *sendMessageStream(input) {
        if (capture !== undefined) {
          capture.input = input;
        }
        for (const event of events) {
          yield event;
        }
      },
    };
  }

  const streamEvents: readonly AssistantStreamEvent[] = [
    { type: "delta", text: "Hel", round: 0 },
    { type: "delta", text: "lo", round: 0 },
    {
      type: "final",
      turn: {
        conversation: { id: "conv-1" },
        messages: [],
        response: { id: "msg-1", content: "Hello" },
        ai: { message: "Hello" },
        toolCalls: [],
        sources: [],
        memory: [],
        pendingConfirmations: [],
      } as unknown as Extract<AssistantStreamEvent, { type: "final" }>["turn"],
    },
  ];

  it("emits delta and final SSE frames when the client accepts text/event-stream", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "sse-token",
        actorId: "actor-sse",
        orgId: "org-sse",
        scopes: ["assistant.write"],
      }),
    );
    const capture: { input?: unknown } = {};
    const app = fastify();
    registerAssistantStreamRoute(app, {
      orchestrator: fakeStreamOrchestrator(streamEvents, capture),
      tools: createToolRegistry(),
      tokenStore,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/assistant.chat",
      headers: { authorization: "Bearer sse-token", accept: "text/event-stream" },
      payload: { message: "hi" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toBe(
      streamEvents.map((event) => formatAssistantSseEvent(event)).join(""),
    );
    expect(capture.input).toMatchObject({
      actor: { id: "actor-sse", orgId: "org-sse" },
      content: "hi",
    });
    await app.close();
  });

  it("returns the canonical HelixError envelope for an invalid streaming body", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "sse-bad-token",
        actorId: "actor-sse-bad",
        orgId: "org-sse-bad",
        scopes: ["assistant.write"],
      }),
    );
    const app = fastify();
    registerAssistantStreamRoute(app, {
      orchestrator: fakeStreamOrchestrator(streamEvents),
      tools: createToolRegistry(),
      tokenStore,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/assistant.chat",
      headers: { authorization: "Bearer sse-bad-token", accept: "text/event-stream" },
      // `message` is required by assistantChatStreamBodySchema.
      payload: { conversationId: "conv-1" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/json");
    const envelope: {
      error?: { code?: string; message?: string; traceId?: string };
    } = response.json();
    expect(envelope.error?.code).toBe("bad_request");
    expect(typeof envelope.error?.message).toBe("string");
    expect(typeof envelope.error?.traceId).toBe("string");
    expect(envelope.error?.traceId).not.toBe("");
    await app.close();
  });

  it("falls through to the JSON tool path when the client does not accept SSE", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "json-token",
        actorId: "actor-json",
        orgId: "org-json",
        scopes: ["assistant.write"],
      }),
    );
    const tools = createToolRegistry();
    tools.register(
      tool({
        id: "assistant.chat",
        permission: "assistant.write",
        sideEffects: "write",
        handler: async () => ({ response: { content: "plain reply" } }),
      }),
    );
    const app = fastify();
    registerAssistantStreamRoute(app, {
      orchestrator: fakeStreamOrchestrator(streamEvents),
      tools,
      tokenStore,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/tools/assistant.chat",
      headers: { authorization: "Bearer json-token" },
      payload: { message: "hi" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ response: { content: "plain reply" } });
    await app.close();
  });
});

describe("tool REST idempotency (P1-10)", () => {
  it("replays the stored result for a duplicate Idempotency-Key on a mutating tool", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "idem-token",
        actorId: "agent-idem",
        orgId: "org-idem",
        actorType: "agent",
        scopes: ["platform.read"],
      }),
    );
    const tools = createToolRegistry();
    let calls = 0;
    tools.register(
      tool({
        id: "idem.write",
        permission: "platform.read",
        sideEffects: "write",
        handler: async () => ({ callNumber: (calls += 1) }),
      }),
    );
    const app = fastify();
    registerToolRestRoutes(
      app,
      { tools, metrics: createPlatformMetrics(), tokenStore, idempotencyStore: new InMemoryIdempotencyStore() },
      ["POST"],
    );

    const headers = { authorization: "Bearer idem-token", "idempotency-key": "key-1" };
    const first = await app.inject({ method: "POST", url: "/api/tools/idem.write", headers, payload: {} });
    const second = await app.inject({ method: "POST", url: "/api/tools/idem.write", headers, payload: {} });

    expect(first.json()).toEqual({ callNumber: 1 });
    expect(second.json()).toEqual({ callNumber: 1 });
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(calls).toBe(1);
    await app.close();
  });

  it("returns 409 when an Idempotency-Key is reused with a different payload", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "idem-token-2",
        actorId: "agent-idem-2",
        orgId: "org-idem",
        actorType: "agent",
        scopes: ["platform.read"],
      }),
    );
    const tools = createToolRegistry();
    tools.register(
      tool({
        id: "idem.write2",
        permission: "platform.read",
        sideEffects: "write",
        handler: async () => ({ ok: true }),
      }),
    );
    const app = fastify();
    registerToolRestRoutes(
      app,
      { tools, metrics: createPlatformMetrics(), tokenStore, idempotencyStore: new InMemoryIdempotencyStore() },
      ["POST"],
    );

    const headers = { authorization: "Bearer idem-token-2", "idempotency-key": "key-2" };
    await app.inject({ method: "POST", url: "/api/tools/idem.write2", headers, payload: { a: 1 } });
    const conflict = await app.inject({
      method: "POST",
      url: "/api/tools/idem.write2",
      headers,
      payload: { a: 2 },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "idempotency_key_reused" } });
    await app.close();
  });
});

describe("API versioning (P1-10)", () => {
  it("rewrites a /v1 prefixed URL onto the canonical path", () => {
    expect(rewriteVersionedApiUrl("/v1/api/tools")).toBe("/api/tools");
    expect(rewriteVersionedApiUrl("/v1")).toBe("/");
    expect(rewriteVersionedApiUrl("/api/tools")).toBe("/api/tools");
    expect(rewriteVersionedApiUrl("/v1?x=1")).toBe("/?x=1");
  });
});

describe("action status routes", () => {
  it("returns a pending action over the PRD polling path for the owning actor", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    const actorToken = accessToken({
      token: "action-token",
      actorId: "agent-action",
      orgId: "org-action",
      actorType: "agent",
      scopes: ["platform.read"],
    });
    await tokenStore.saveToken(actorToken);

    const gate = new InMemoryConfirmationGate(new InMemoryPendingActionStore());
    const tools = createToolRegistry({ confirmationGate: gate });
    const pending = await gate.queue({
      tool: tool({ id: "external.write", permission: "platform.read", handler: async () => ({}) }),
      actor: {
        id: actorToken.actorId,
        orgId: actorToken.orgId,
        type: "agent",
        scopes: actorToken.scopes,
      },
      input: { value: true },
      traceId: "trace-action-1",
    });
    const app = fastify();
    registerActionStatusRoutes(app, { tools, tokenStore });

    const response = await app.inject({
      method: "GET",
      url: `/actions/${pending.id}`,
      headers: { authorization: "Bearer action-token" },
    });

    expect(response.statusCode).toBe(200);
    const body = actionStatusBody(response.json());
    expect(body.action).toMatchObject({
      id: pending.id,
      actorId: "agent-action",
      toolId: "external.write",
      status: "pending_confirmation",
      input: { value: true },
      traceId: "trace-action-1",
    });
    await app.close();
  });

  it("does not expose pending actions across actors", async () => {
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken(
      accessToken({
        token: "other-action-token",
        actorId: "agent-other",
        orgId: "org-action",
        actorType: "agent",
        scopes: ["platform.read"],
      }),
    );

    const gate = new InMemoryConfirmationGate(new InMemoryPendingActionStore());
    const tools = createToolRegistry({ confirmationGate: gate });
    const pending = await gate.queue({
      tool: tool({ id: "external.write", permission: "platform.read", handler: async () => ({}) }),
      actor: {
        id: "agent-action",
        orgId: "org-action",
        type: "agent",
        scopes: ["platform.read"],
      },
      input: { value: true },
    });
    const app = fastify();
    registerActionStatusRoutes(app, { tools, tokenStore });

    const response = await app.inject({
      method: "GET",
      url: `/api/actions/${pending.id}`,
      headers: { authorization: "Bearer other-action-token" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: "not_found",
        message: `Pending tool action was not found: ${pending.id}`,
      },
    });
    await app.close();
  });
});

function createToolRouteTestApp(options: {
  readonly engine: SearchEngine;
  readonly tokenStore: InMemoryOAuthClientStore;
}) {
  const app = fastify();
  const tools = createToolRegistry();
  registerSearchTools(tools, { engine: options.engine });
  registerToolRestRoutes(app, {
    tools,
    metrics: createPlatformMetrics(),
    tokenStore: options.tokenStore,
  });
  return app;
}

function accessToken(
  input: Pick<AccessTokenRecord, "token" | "actorId" | "orgId" | "scopes"> & {
    readonly actorType?: AccessTokenRecord["actorType"];
  },
): AccessTokenRecord {
  return {
    token: input.token,
    clientId: "client-1",
    actorId: input.actorId,
    orgId: input.orgId,
    actorType: input.actorType ?? "user",
    scopes: input.scopes,
    issuedAt: now,
    expiresAt: later,
  };
}

function orgRecord(overrides: Partial<OrgRecord> = {}): OrgRecord {
  return {
    id: "org-tenant-config",
    slug: "tenant-config",
    displayName: "Tenant Config",
    status: "active",
    tier: "business",
    planId: "business",
    region: "us-east-1",
    byoConfig: {},
    featureFlags: { ai_smart_compose: true },
    quotas: { api_rps_limit: 25 },
    branding: { display_name_override: "Tenant Config" },
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
    ...overrides,
  };
}

function tenantStorageMigrationJobRecord(
  overrides: Partial<TenantStorageMigrationJobRecord> = {},
): TenantStorageMigrationJobRecord {
  const now = new Date("2026-05-20T02:00:00.000Z");
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "org-tenant-config",
    target: "byo",
    status: "queued",
    dryRun: true,
    requestedByActorId: "admin-1",
    sourceStorage: {
      managedBy: "helix-default",
      storage: null,
    },
    targetStorage: {
      managedBy: "byo",
      storage: null,
    },
    plannedCount: 0,
    copiedCount: 0,
    verifiedCount: 0,
    failures: [],
    lastError: null,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const requestLimitBudget: AgentLimitBudget = {
  requestsPerMinute: 1,
  requestsPerDay: 10,
  costPerDayUsdMicros: null,
  costWarningThresholdRatio: 0.8,
};

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object" }),
};

function tool(
  overrides: Partial<ToolDefinition> & Pick<ToolDefinition, "id" | "permission" | "handler">,
): ToolDefinition {
  return {
    description: overrides.id,
    inputSchema: schema,
    outputSchema: schema,
    sideEffects: "read",
    ...overrides,
  };
}

interface RateLimitedBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly traceId: string;
    readonly details: {
      readonly retryAfterSeconds: number;
      readonly rateLimit: {
        readonly reason: string;
        readonly retryAfterSeconds: number;
        readonly usage: {
          readonly requestsPerMinute: {
            readonly limit: number;
            readonly used: number;
            readonly remaining: number;
          };
        };
      };
    };
  };
}

function rateLimitedBody(value: unknown): RateLimitedBody {
  return value as RateLimitedBody;
}

interface ActionStatusBody {
  readonly action: {
    readonly id: string;
    readonly actorId: string;
    readonly toolId: string;
    readonly status: string;
    readonly input: unknown;
    readonly traceId?: string;
  };
}

function actionStatusBody(value: unknown): ActionStatusBody {
  return value as ActionStatusBody;
}

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly searches: SearchRequest[] = [];

  constructor(private readonly hits: readonly IndexDocument[] = []) {}

  async index(): Promise<void> {}

  async upsert(): Promise<void> {}

  async delete(): Promise<void> {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    this.searches.push(request);
    return {
      hits: this.hits,
      query: request.query,
      estimatedTotalHits: this.hits.length,
      processingTimeMs: 1,
    };
  }
}
