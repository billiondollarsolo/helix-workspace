import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, openApiDocumentToYaml } from "./openapi.js";
import { HELIX_SERVER_VERSION } from "./version.js";

const emptyObjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} satisfies JsonObject;

describe("buildOpenApiDocument", () => {
  it("projects tools into OpenAPI paths while preserving existing document content", () => {
    const document = buildOpenApiDocument(
      {
        openapi: "3.1.0",
        info: { title: "Existing API", version: "1.0.0" },
        paths: {
          "/health": {
            get: {
              operationId: "health",
              responses: { "200": { description: "OK" } },
            },
          },
        },
        components: {
          securitySchemes: {
            legacyApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
          },
        },
        tags: [{ name: "Existing", description: "Existing tag." }],
      },
      [
        tool({
          id: "platform.ping",
          permission: "platform.read",
          sideEffects: "read",
        }),
        tool({
          id: "mail/send",
          permission: "mail.send",
          sideEffects: "external_communication",
          confirmationRequired: true,
          rateLimit: { perActor: { perHour: 60, perDay: 200 } },
          estimatedCostUsdMicros: 1250,
        }),
      ],
    );

    expect(document.info).toEqual({ title: "Existing API", version: HELIX_SERVER_VERSION });
    expect(document.paths).toMatchObject({
      "/health": {
        get: {
          operationId: "health",
        },
      },
      "/api/tools": {
        get: {
          operationId: "listTools",
          security: [
            { oauthClientCredentials: [] },
            { bearerAuth: [] },
            { sessionCookie: [] },
            { appPasswordBasic: [] },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      tools: {
                        items: {
                          properties: {
                            rateLimit: {
                              properties: {
                                perActor: {
                                  properties: {
                                    perHour: { type: "number" },
                                    perDay: { type: "number" },
                                  },
                                },
                              },
                            },
                            estimatedCostUsdMicros: { type: "integer", minimum: 0 },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/actions/{pendingId}": {
        get: {
          operationId: "getActionStatus",
          security: [
            { oauthClientCredentials: [] },
            { bearerAuth: [] },
            { sessionCookie: [] },
            { appPasswordBasic: [] },
          ],
          parameters: [
            {
              name: "pendingId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    required: ["action"],
                    properties: {
                      action: {
                        required: [
                          "id",
                          "toolId",
                          "actorId",
                          "requesterActorId",
                          "preview",
                          "status",
                          "createdAt",
                          "expiresAt",
                        ],
                        properties: {
                          status: {
                            enum: [
                              "pending_confirmation",
                              "approved",
                              "executing",
                              "executed",
                              "failed",
                              "cancelled",
                              "expired",
                            ],
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tools/pending/{pendingId}/approve": {
        post: {
          operationId: "approvePendingAction",
          security: [
            { oauthClientCredentials: [] },
            { bearerAuth: [] },
            { sessionCookie: [] },
            { appPasswordBasic: [] },
          ],
          parameters: [
            {
              name: "pendingId",
              in: "path",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    required: ["status"],
                    properties: {
                      status: {
                        enum: ["executed", "pending_confirmation", "cancelled"],
                      },
                    },
                  },
                },
              },
            },
            "202": {
              content: {
                "application/json": {
                  schema: {
                    required: ["status"],
                  },
                },
              },
            },
          },
        },
      },
      "/api/tools/pending/{pendingId}/cancel": {
        post: {
          operationId: "cancelPendingAction",
          security: [
            { oauthClientCredentials: [] },
            { bearerAuth: [] },
            { sessionCookie: [] },
            { appPasswordBasic: [] },
          ],
        },
      },
      "/api/tools/platform.ping": {
        get: {
          operationId: "getTool_platform_ping",
          security: [
            { oauthClientCredentials: ["platform.read"] },
            { bearerAuth: [] },
            { sessionCookie: [] },
            { appPasswordBasic: [] },
          ],
          "x-helix-tool": {
            id: "platform.ping",
            permission: "platform.read",
            sideEffects: "read",
            confirmationRequired: false,
          },
        },
        post: {
          operationId: "postTool_platform_ping",
          security: [
            { oauthClientCredentials: ["platform.read"] },
            { bearerAuth: [] },
            { sessionCookie: [] },
            { appPasswordBasic: [] },
          ],
          responses: {
            "429": {
              description: "Agent or service-account rate or cost limit exceeded.",
              headers: {
                "Retry-After": {
                  schema: { type: "integer", minimum: 0 },
                },
              },
              content: {
                "application/json": {
                  schema: {
                    required: ["error", "retryAfterSeconds", "rateLimit"],
                    properties: {
                      retryAfterSeconds: { type: "integer", minimum: 0 },
                      rateLimit: {
                        required: ["reason", "retryAfterSeconds"],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/tools/mail%2Fsend": {
        post: {
          operationId: "postTool_mail_send",
          security: [
            { oauthClientCredentials: ["mail.send"] },
            { bearerAuth: [] },
            { sessionCookie: [] },
            { appPasswordBasic: [] },
          ],
          "x-helix-tool": {
            id: "mail/send",
            permission: "mail.send",
            sideEffects: "external_communication",
            confirmationRequired: true,
            rateLimit: { perActor: { perHour: 60, perDay: 200 } },
            estimatedCostUsdMicros: 1250,
          },
        },
      },
    });
    expect(document.components).toMatchObject({
      securitySchemes: {
        legacyApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        oauthClientCredentials: {
          type: "oauth2",
          description: "OAuth 2.1 client credentials flow for agents, CLI, and integrations.",
          flows: {
            clientCredentials: {
              tokenUrl: "/oauth/token",
              // Descriptions are sourced from the canonical scope catalog.
              scopes: {
                "mail.send": "Send mail to internal recipients.",
                "platform.read": "Read platform health and metadata.",
              },
            },
          },
        },
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
          description: "OAuth access token presented with Authorization: Bearer.",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "helix_session",
          description: "Browser session cookie for first-party SPA users.",
        },
        appPasswordBasic: {
          type: "http",
          scheme: "basic",
          description: "App-password Basic auth for legacy clients and CalDAV-compatible tools.",
        },
      },
    });
    expect(
      (document.paths as Record<string, unknown>)["/api/tools/mail%2Fsend"],
    ).not.toHaveProperty("get");
    expect(document.tags).toEqual([
      { name: "Existing", description: "Existing tag." },
      { name: "Tools", description: "Platform tool registry." },
      { name: "Actions", description: "Confirmation-gated tool action status." },
      {
        name: "feature:mail",
        description: "Mail plugin tools — compose, send, organise, and filter messages.",
      },
      {
        name: "feature:platform",
        description: "Platform tools — health, configuration, and metadata.",
      },
    ]);
  });

  it("groups per-tool operations under a per-plugin feature tag", () => {
    const document = buildOpenApiDocument({ openapi: "3.1.0" }, [
      tool({ id: "mail.send", permission: "mail.send", sideEffects: "write" }),
    ]);
    const paths = document.paths as Record<string, Record<string, { tags?: string[] }>>;
    expect(paths["/api/tools/mail.send"]?.post?.tags).toEqual(["feature:mail", "Tools"]);
  });

  it("adds the canonical HelixError schema and an Idempotency-Key parameter", () => {
    const document = buildOpenApiDocument({ openapi: "3.1.0" }, [
      tool({ id: "mail.send", permission: "mail.send", sideEffects: "write" }),
    ]);
    const components = document.components as { schemas?: Record<string, unknown> };
    expect(components.schemas).toHaveProperty("HelixError");
    const paths = document.paths as Record<
      string,
      Record<string, { parameters?: { name?: string }[]; responses?: Record<string, unknown> }>
    >;
    const post = paths["/api/tools/mail.send"]?.post;
    expect(post?.parameters?.some((parameter) => parameter.name === "Idempotency-Key")).toBe(true);
    expect(post?.responses).toHaveProperty("409");
  });

  it("renders a YAML document equivalent to the JSON document", () => {
    const document = buildOpenApiDocument({ openapi: "3.1.0" }, [
      tool({ id: "platform.ping", permission: "platform.read", sideEffects: "read" }),
    ]);
    const yaml = openApiDocumentToYaml(document);
    expect(yaml).toContain("openapi: 3.1.0");
    expect(yaml).toContain("/api/tools/platform.ping");
    expect(yaml.endsWith("\n")).toBe(true);
  });
});

function tool(overrides: {
  readonly id: string;
  readonly permission: string;
  readonly sideEffects: ToolDefinition["sideEffects"];
  readonly confirmationRequired?: boolean;
  readonly rateLimit?: ToolDefinition["rateLimit"];
  readonly estimatedCostUsdMicros?: number;
}): ToolDefinition {
  return {
    id: overrides.id,
    description: `${overrides.id} description`,
    inputSchema: schema(emptyObjectSchema),
    outputSchema: schema(emptyObjectSchema),
    permission: overrides.permission,
    sideEffects: overrides.sideEffects,
    ...(overrides.confirmationRequired === undefined
      ? {}
      : { confirmationRequired: overrides.confirmationRequired }),
    ...(overrides.rateLimit === undefined ? {} : { rateLimit: overrides.rateLimit }),
    ...(overrides.estimatedCostUsdMicros === undefined
      ? {}
      : { estimatedCostUsdMicros: overrides.estimatedCostUsdMicros }),
    handler: async () => ({}),
  };
}

function schema(jsonSchema: JsonObject): ToolDefinition["inputSchema"] {
  return {
    parse: (value: unknown) => value,
    toJsonSchema: () => jsonSchema,
  };
}
