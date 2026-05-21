import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import { openApiScopeCatalog } from "../platform/permissions/scope-catalog.js";
import { HELIX_SERVER_VERSION } from "./version.js";

type MutableOpenApiObject = Record<string, unknown>;

/**
 * Human-friendly descriptions for the per-plugin/feature tag groups (P1-10).
 * Tools are grouped under `feature:<plugin>` derived from their tool-id prefix
 * (`mail.send` -> `mail`) so the rendered docs are organised by product area
 * instead of a single flat `Tools` bucket.
 */
const featureTagDescriptions: Record<string, string> = {
  mail: "Mail plugin tools — compose, send, organise, and filter messages.",
  chat: "Chat plugin tools — rooms, messages, presence, and receipts.",
  drive: "Drive plugin tools — files, folders, and sharing.",
  docs: "Docs plugin tools — collaborative documents and comments.",
  calendar: "Calendar plugin tools — events, scheduling, and invitations.",
  meet: "Meet plugin tools — video meeting lifecycle.",
  assistant: "Assistant plugin tools — AI assistant conversations and actions.",
  search: "Search tools — cross-feature global search.",
  platform: "Platform tools — health, configuration, and metadata.",
  agent: "Agent credential tools — OAuth client lifecycle.",
  webhook: "Webhook tools — outbound webhook subscriptions.",
  audit: "Audit tools — audit-log access.",
  backup: "Backup and restore tools.",
  users: "User administration tools.",
  ai: "AI platform tools — provider routing and cost limits.",
  plugin: "Plugin lifecycle and catalog tools.",
};

export function buildOpenApiDocument(
  baseDocument: unknown,
  tools: readonly ToolDefinition[],
): MutableOpenApiObject {
  const document = isRecord(baseDocument) ? { ...baseDocument } : {};
  const paths = isRecord(document.paths) ? { ...document.paths } : {};
  const components = isRecord(document.components) ? { ...document.components } : {};
  const securitySchemes = isRecord(components.securitySchemes)
    ? { ...components.securitySchemes }
    : {};
  const scopes = scopeCatalog(tools);

  // Pin the real server version so the published spec never advertises 0.0.0.
  document.info = {
    ...(isRecord(document.info) ? document.info : {}),
    title: isRecord(document.info) && typeof document.info.title === "string"
      ? document.info.title
      : "Helix Platform API",
    version: HELIX_SERVER_VERSION,
  };

  paths["/api/tools"] = {
    ...asPathItem(paths["/api/tools"]),
    get: {
      tags: ["Tools"],
      operationId: "listTools",
      summary: "List registered tools",
      security: authSecurity(),
      responses: {
        "200": {
          description: "Registered tools.",
          content: {
            "application/json": {
              schema: toolListResponseSchema,
              example: {
                tools: [
                  {
                    id: "mail.send",
                    description: "Send a mail message.",
                    permission: "mail.send",
                    sideEffects: "external_communication",
                    confirmationRequired: true,
                  },
                ],
              },
            },
          },
        },
      },
    },
  };

  paths["/actions/{pendingId}"] = {
    ...asPathItem(paths["/actions/{pendingId}"]),
    get: {
      tags: ["Actions"],
      operationId: "getActionStatus",
      summary: "Get pending action status",
      description: "Poll the status of a confirmation-gated tool action.",
      security: authSecurity(),
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
          description: "Pending action status.",
          content: {
            "application/json": {
              schema: pendingActionStatusResponseSchema,
              example: pendingActionStatusExample,
            },
          },
        },
        "401": errorResponse("Authentication required."),
        "404": errorResponse("Pending action not found for the authenticated actor."),
      },
    },
  };

  paths["/api/tools/pending/{pendingId}/approve"] = {
    ...asPathItem(paths["/api/tools/pending/{pendingId}/approve"]),
    post: pendingActionMutationOperation(
      "approvePendingAction",
      "Approve pending action",
      "Approve a confirmation-gated tool action and execute it.",
    ),
  };

  paths["/api/tools/pending/{pendingId}/cancel"] = {
    ...asPathItem(paths["/api/tools/pending/{pendingId}/cancel"]),
    post: pendingActionMutationOperation(
      "cancelPendingAction",
      "Cancel pending action",
      "Cancel a confirmation-gated tool action without executing it.",
    ),
  };

  const featureTags = new Set<string>();
  for (const tool of tools) {
    const feature = featureForTool(tool.id);
    featureTags.add(feature);
    const path = `/api/tools/${encodeURIComponent(tool.id)}`;
    paths[path] = {
      ...asPathItem(paths[path]),
      post: toolOperation(tool, "post"),
      ...(tool.sideEffects === "read" ? { get: toolOperation(tool, "get") } : {}),
    };
  }

  securitySchemes.oauthClientCredentials = {
    ...asSecurityScheme(securitySchemes.oauthClientCredentials),
    type: "oauth2",
    description: "OAuth 2.1 client credentials flow for agents, CLI, and integrations.",
    flows: {
      clientCredentials: {
        tokenUrl: "/oauth/token",
        scopes,
      },
    },
  };
  securitySchemes.bearerAuth = {
    ...asSecurityScheme(securitySchemes.bearerAuth),
    type: "http",
    scheme: "bearer",
    bearerFormat: "opaque",
    description: "OAuth access token presented with Authorization: Bearer.",
  };
  securitySchemes.sessionCookie = {
    ...asSecurityScheme(securitySchemes.sessionCookie),
    type: "apiKey",
    in: "cookie",
    name: "helix_session",
    description: "Browser session cookie for first-party SPA users.",
  };
  securitySchemes.appPasswordBasic = {
    ...asSecurityScheme(securitySchemes.appPasswordBasic),
    type: "http",
    scheme: "basic",
    description: "App-password Basic auth for legacy clients and CalDAV-compatible tools.",
  };

  components.securitySchemes = securitySchemes;
  components.schemas = {
    ...(isRecord(components.schemas) ? components.schemas : {}),
    HelixError: helixErrorSchema,
  };
  document.components = components;
  document.paths = paths;
  document.tags = mergeTags(document.tags, {
    name: "Tools",
    description: "Platform tool registry.",
  });
  document.tags = mergeTags(document.tags, {
    name: "Actions",
    description: "Confirmation-gated tool action status.",
  });
  // Per-plugin/feature tag groups (P1-10) — replaces the flat `Tools` listing.
  for (const feature of [...featureTags].sort((left, right) => left.localeCompare(right))) {
    document.tags = mergeTags(document.tags, {
      name: featureTagName(feature),
      description: featureTagDescriptions[feature] ?? `${feature} plugin tools.`,
    });
  }
  return document;
}

function featureForTool(toolId: string): string {
  const separatorIndex = toolId.search(/[./]/u);
  const prefix = separatorIndex === -1 ? toolId : toolId.slice(0, separatorIndex);
  return prefix.length === 0 ? "platform" : prefix;
}

function featureTagName(feature: string): string {
  return `feature:${feature}`;
}

function toolOperation(tool: ToolDefinition, method: "get" | "post"): MutableOpenApiObject {
  const feature = featureForTool(tool.id);
  const inputSchema = toSchema(tool.inputSchema.toJsonSchema());
  const outputSchema = toSchema(tool.outputSchema.toJsonSchema());
  return {
    tags: [featureTagName(feature), "Tools"],
    operationId: `${method}Tool_${operationIdSuffix(tool.id)}`,
    summary: tool.description,
    description: `Invoke the ${tool.id} tool.`,
    security: toolSecurity(tool.permission),
    "x-helix-tool": {
      id: tool.id,
      permission: tool.permission,
      sideEffects: tool.sideEffects,
      confirmationRequired: tool.confirmationRequired ?? false,
      ...(tool.rateLimit === undefined ? {} : { rateLimit: tool.rateLimit }),
      ...(tool.estimatedCostUsdMicros === undefined
        ? {}
        : { estimatedCostUsdMicros: tool.estimatedCostUsdMicros }),
    },
    ...(method === "post"
      ? {
          parameters: tool.sideEffects === "read" ? [] : [idempotencyKeyParameter()],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: inputSchema,
                example: exampleForSchema(inputSchema),
              },
            },
          },
        }
      : {
          parameters: [
            {
              name: "input",
              in: "query",
              required: false,
              schema: inputSchema,
              style: "deepObject",
              explode: true,
            },
          ],
        }),
    responses: {
      "200": {
        description: "Tool output.",
        content: {
          "application/json": {
            schema: outputSchema,
            example: exampleForSchema(outputSchema),
          },
        },
      },
      "400": errorResponse("Invalid tool input."),
      "404": errorResponse("Tool not found."),
      ...(method === "post" && tool.sideEffects !== "read"
        ? { "409": errorResponse("Idempotency-Key reused with a different request payload.") }
        : {}),
      "429": {
        description: "Agent or service-account rate or cost limit exceeded.",
        headers: {
          "Retry-After": {
            description: "Seconds until the tool invocation may be retried.",
            schema: { type: "integer", minimum: 0 },
          },
        },
        content: {
          "application/json": {
            schema: rateLimitErrorResponseSchema,
            example: {
              error: "Agent tool invocation limit exceeded: requests_per_minute",
              retryAfterSeconds: 12,
              rateLimit: { reason: "requests_per_minute", retryAfterSeconds: 12 },
            },
          },
        },
      },
      "500": errorResponse("Tool invocation failed."),
    },
  };
}

function idempotencyKeyParameter(): MutableOpenApiObject {
  return {
    name: "Idempotency-Key",
    in: "header",
    required: false,
    description:
      "Opaque client-generated key. Replays the stored result for duplicate requests within the idempotency window.",
    schema: { type: "string", maxLength: 255 },
  };
}

function errorResponse(description: string): MutableOpenApiObject {
  return {
    description,
    content: {
      "application/json": {
        schema: { $ref: "#/components/schemas/HelixError" },
        example: {
          error: {
            code: "bad_request",
            message: description,
            traceId: "0af7651916cd43dd8448eb211c80319c",
          },
        },
      },
    },
  };
}

function pendingActionMutationOperation(
  operationId: string,
  summary: string,
  description: string,
): MutableOpenApiObject {
  return {
    tags: ["Actions"],
    operationId,
    summary,
    description,
    security: authSecurity(),
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
        description: "Pending action mutation result.",
        content: {
          "application/json": {
            schema: pendingActionMutationResponseSchema,
            example: { status: "executed", output: { ok: true } },
          },
        },
      },
      "202": {
        description: "Approval resulted in another pending confirmation.",
        content: {
          "application/json": {
            schema: pendingActionMutationResponseSchema,
            example: { status: "pending_confirmation", pending: pendingActionStatusExample.action },
          },
        },
      },
      "400": errorResponse("Invalid pending action state."),
      "401": errorResponse("Authentication required."),
      "404": errorResponse("Pending action not found for the authenticated actor."),
    },
  };
}

function authSecurity(): readonly MutableOpenApiObject[] {
  return [
    { oauthClientCredentials: [] },
    { bearerAuth: [] },
    { sessionCookie: [] },
    { appPasswordBasic: [] },
  ];
}

function toolSecurity(permission: string): readonly MutableOpenApiObject[] {
  return [
    { oauthClientCredentials: [permission] },
    { bearerAuth: [] },
    { sessionCookie: [] },
    { appPasswordBasic: [] },
  ];
}

function scopeCatalog(tools: readonly ToolDefinition[]): MutableOpenApiObject {
  // Derived from the single canonical scope catalog (P1-6). Tool permissions
  // are unioned in so transitional tools are still documented, but canonical
  // descriptions win.
  return openApiScopeCatalog(tools.map((tool) => tool.permission));
}

function mergeTags(existing: unknown, tag: MutableOpenApiObject): readonly MutableOpenApiObject[] {
  const tags = Array.isArray(existing) ? existing.filter(isRecord) : [];
  if (tags.some((entry) => entry.name === tag.name)) {
    return tags;
  }
  return [...tags, tag];
}

function asPathItem(value: unknown): MutableOpenApiObject {
  return isRecord(value) ? value : {};
}

function asSecurityScheme(value: unknown): MutableOpenApiObject {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is MutableOpenApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationIdSuffix(toolId: string): string {
  return toolId.replace(/[^a-zA-Z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function toSchema(schema: JsonObject): JsonObject {
  return schema;
}

/**
 * Derives a minimal illustrative example from a JSON Schema. Used so every
 * documented endpoint carries at least one request/response example (P1-10).
 */
function exampleForSchema(schema: JsonObject): JsonValueForExample {
  return buildExample(schema, 0);
}

type JsonValueForExample = string | number | boolean | null | JsonValueForExample[] | {
  [key: string]: JsonValueForExample;
};

function buildExample(schema: Record<string, unknown>, depth: number): JsonValueForExample {
  if (depth > 4) {
    return null;
  }
  if (schema.example !== undefined) {
    return jsonExampleValue(schema.example);
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return jsonExampleValue(enumValues[0]);
  }
  const rawType = schema.type;
  const type = typeof rawType === "string"
    ? rawType
    : Array.isArray(rawType) && typeof rawType[0] === "string"
      ? rawType[0]
      : undefined;
  switch (type) {
    case "object": {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const result: { [key: string]: JsonValueForExample } = {};
      for (const [key, value] of Object.entries(properties)) {
        if (isRecord(value)) {
          result[key] = buildExample(value, depth + 1);
        }
      }
      return result;
    }
    case "array": {
      const items: Record<string, unknown> = isRecord(schema.items)
        ? schema.items
        : { type: "string" };
      return [buildExample(items, depth + 1)];
    }
    case "string":
      return schema.format === "date-time" ? "2026-05-21T12:00:00.000Z" : "string";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return {};
  }
}

/** Coerces an arbitrary JSON-ish value into the example value type. */
function jsonExampleValue(value: unknown): JsonValueForExample {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonExampleValue);
  }
  if (typeof value === "object") {
    const result: { [key: string]: JsonValueForExample } = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = jsonExampleValue(entry);
    }
    return result;
  }
  return null;
}

const helixErrorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["error"],
  description: "Canonical Helix error envelope returned by every REST and tool endpoint.",
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      required: ["code", "message", "traceId"],
      properties: {
        code: { type: "string", description: "Stable machine-readable error code." },
        message: { type: "string", description: "Human-readable error message." },
        traceId: { type: "string", description: "Trace identifier for support correlation." },
        details: { type: "object", additionalProperties: true },
      },
    },
  },
} satisfies JsonObject;

const toolListResponseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "permission", "sideEffects", "confirmationRequired"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          permission: { type: "string" },
          sideEffects: {
            type: "string",
            enum: ["read", "write", "destructive", "external_communication"],
          },
          confirmationRequired: { type: "boolean" },
          rateLimit: {
            type: "object",
            additionalProperties: false,
            properties: {
              perActor: {
                type: "object",
                additionalProperties: false,
                properties: {
                  perMinute: { type: "number" },
                  perHour: { type: "number" },
                  perDay: { type: "number" },
                },
              },
              perOrg: {
                type: "object",
                additionalProperties: false,
                properties: {
                  perMinute: { type: "number" },
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
  required: ["tools"],
} satisfies JsonObject;

const pendingActionStatusResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "object",
      additionalProperties: false,
      required: ["id", "toolId", "actorId", "input", "status", "createdAt", "expiresAt"],
      properties: {
        id: { type: "string", format: "uuid" },
        toolId: { type: "string" },
        actorId: { type: "string" },
        input: {},
        status: {
          type: "string",
          enum: ["pending_confirmation", "confirmed", "cancelled", "expired"],
        },
        createdAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        traceId: { type: "string" },
      },
    },
  },
} satisfies JsonObject;

const pendingActionStatusExample = {
  action: {
    id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    toolId: "mail.send",
    actorId: "agent-123",
    input: { to: "user@example.com", subject: "Hello" },
    status: "pending_confirmation",
    createdAt: "2026-05-21T12:00:00.000Z",
    expiresAt: "2026-05-21T12:15:00.000Z",
    traceId: "0af7651916cd43dd8448eb211c80319c",
  },
};

const pendingActionMutationResponseSchema = {
  type: "object",
  additionalProperties: true,
  required: ["status"],
  properties: {
    status: {
      type: "string",
      enum: ["executed", "pending_confirmation", "cancelled"],
    },
    output: {},
    pending: pendingActionStatusResponseSchema.properties.action,
  },
} satisfies JsonObject;

const rateLimitErrorResponseSchema = {
  type: "object",
  additionalProperties: true,
  required: ["error", "retryAfterSeconds", "rateLimit"],
  properties: {
    error: { type: "string" },
    retryAfterSeconds: { type: "integer", minimum: 0 },
    rateLimit: {
      type: "object",
      additionalProperties: true,
      required: ["reason", "retryAfterSeconds"],
      properties: {
        reason: { type: "string" },
        retryAfterSeconds: { type: "integer", minimum: 0 },
      },
    },
  },
} satisfies JsonObject;

/**
 * Serializes an OpenAPI document to YAML. Hand-rolled to avoid a new
 * dependency; supports the JSON value subset OpenAPI documents contain.
 */
export function openApiDocumentToYaml(document: unknown): string {
  return `${yamlValue(document, 0)}\n`;
}

function yamlValue(value: unknown, indent: number): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "string") {
    return yamlString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    const pad = "  ".repeat(indent);
    return value
      .map((item) => `\n${pad}- ${yamlInline(item, indent + 1)}`)
      .join("");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, entryValue]) => entryValue !== undefined,
    );
    if (entries.length === 0) {
      return "{}";
    }
    const pad = "  ".repeat(indent);
    return entries
      .map(([key, entryValue]) => `\n${pad}${yamlKey(key)}: ${yamlInline(entryValue, indent + 1)}`)
      .join("");
  }
  return "null";
}

function yamlInline(value: unknown, indent: number): string {
  if (Array.isArray(value) && value.length > 0) {
    return yamlValue(value, indent - 1).replace(/^\n/u, "");
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  ) {
    return yamlValue(value, indent).replace(/^\n/u, "");
  }
  return yamlValue(value, indent);
}

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_./-]+$/u.test(key) ? key : yamlString(key);
}

function yamlString(value: string): string {
  if (value.length === 0) {
    return '""';
  }
  if (/[:#\n"'{}[\],&*?|<>=!%@`]/u.test(value) || /^[\s-]/u.test(value) || /\s$/u.test(value)) {
    return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n")}"`;
  }
  return value;
}
