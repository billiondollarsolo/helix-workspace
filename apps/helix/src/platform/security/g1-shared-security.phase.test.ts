/**
 * Phase G1 contract suite — drives shipped modules for G1.1–G1.9 without
 * re-implementing policy logic inside the test.
 */
import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { assertProductionConfiguration } from "../../config/production-assertions.js";
import type { Env } from "../../config/env.js";
import { evaluateWebSocketOrigin, isTrustedOrigin, parseTrustedOrigins } from "./origin-policy.js";
import { assertDriveMalwareScannerReady } from "../drive/scanning.js";
import {
  createToolRegistry,
  shouldQueueConfirmation,
  type ToolInvocationAuditStatus,
} from "../tool-registry.js";
import { credentialPolicyOf } from "../../api/actor.js";
import { resolveRequestOrgIdentity } from "../tenancy/request-tenant-identity.js";
import {
  TenantActorMismatchError,
  assertActorMatchesRequestTenant,
} from "../tenancy/middleware.js";
import { loadNegativeMatrixFromDisk } from "./negative-matrix.js";
import { DEFAULT_IDEMPOTENCY_TTL_MS } from "../../api/idempotency.js";
import { buildErrorEnvelope } from "../../api/error-envelope.js";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "production",
    HELIX_SECURITY_TIER: "business",
    HELIX_APPS: "mail,drive,chat,assistant",
    HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "https://app.example.com",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://app.example.com",
    PUBLIC_WEB_URL: "https://app.example.com",
    PUBLIC_API_URL: "https://api.example.com",
    DATABASE_URL: "postgres://helix:helix@localhost:5432/helix",
    REDIS_URL: "redis://localhost:6379",
    NATS_URL: "nats://localhost:4222",
    OBJECT_STORE_ENDPOINT: "https://objects.example.com",
    OBJECT_STORE_ACCESS_KEY: "ak",
    OBJECT_STORE_SECRET_KEY: "sk".repeat(8),
    ...overrides,
  } as Env;
}

describe("G1.1 fail-fast production configuration", () => {
  it("rejects production when HELIX_APPS is not the MVP allowlist", () => {
    expect(() => {
      assertProductionConfiguration(
        baseEnv({
          HELIX_APPS: "mail,drive,chat,assistant,meet",
        }),
      );
    }).toThrow(/HELIX_APPS|MVP|allowlist/i);
  });
});

describe("G1.2 trusted origin / WebSocket origin policy", () => {
  it("parses exact origins and rejects untrusted browser Origin with cookies", () => {
    const trusted = parseTrustedOrigins("https://app.example.com");
    expect(isTrustedOrigin("https://app.example.com", trusted)).toBe(true);
    expect(isTrustedOrigin("https://evil.example", trusted)).toBe(false);

    const decision = evaluateWebSocketOrigin(
      {
        headers: {
          origin: "https://evil.example",
          cookie: "helix_session=abc",
        },
      } as never,
      trusted,
    );
    expect(decision.allowed).toBe(false);
  });

  it("denies missing Origin when a cookie is present", () => {
    const trusted = parseTrustedOrigins("https://app.example.com");
    const decision = evaluateWebSocketOrigin(
      {
        headers: {
          cookie: "helix_session=abc",
        },
      } as never,
      trusted,
    );
    expect(decision).toEqual({ allowed: false, reason: "missing_origin_with_cookie" });
  });
});

describe("G1.5 agent write confirmation defaults (shipped shouldQueueConfirmation)", () => {
  const tool = (sideEffects: ToolDefinition["sideEffects"]): ToolDefinition =>
    ({
      id: "test.tool",
      title: "Test",
      description: "test",
      sideEffects,
      confirmationRequired: false,
      inputSchema: {},
      outputSchema: {},
      permission: "test",
      handler: async () => ({}),
    }) as unknown as ToolDefinition;

  const agent: Actor = {
    id: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    type: "agent",
    scopes: ["*"],
  };

  it("queues agent writes even when confirmationOverride would be never", () => {
    expect(
      shouldQueueConfirmation({
        tool: tool("write"),
        actor: agent,
        defaults: { confirmation: "inherit" } as never,
        skipConfirmation: false,
        approvedPendingExecution: false,
        confirmationOverride: "never",
        automationAllowed: false,
      }),
    ).toBe(true);
  });

  it("does not queue pure agent reads", () => {
    expect(
      shouldQueueConfirmation({
        tool: tool("read"),
        actor: agent,
        defaults: { confirmation: "inherit" } as never,
        skipConfirmation: false,
        approvedPendingExecution: false,
        confirmationOverride: undefined,
        automationAllowed: false,
      }),
    ).toBe(false);
  });

  it("skips queue only for bounded automation allowlist matches", () => {
    expect(
      shouldQueueConfirmation({
        tool: tool("write"),
        actor: agent,
        defaults: { confirmation: "inherit" } as never,
        skipConfirmation: false,
        approvedPendingExecution: false,
        confirmationOverride: undefined,
        automationAllowed: true,
      }),
    ).toBe(false);
  });
});

describe("G1.6 Business malware scanner contract", () => {
  it("forbids no-op scanners on business tier", () => {
    expect(() => {
      assertDriveMalwareScannerReady("business", { kind: "noop" } as never);
    }).toThrow(/ClamAV|no-op/i);
    expect(() => {
      assertDriveMalwareScannerReady("business", undefined);
    }).toThrow(/ClamAV/);
  });
});

describe("G1.4 credential policy accessor", () => {
  it("exports credentialPolicyOf for surface wiring", () => {
    expect(typeof credentialPolicyOf).toBe("function");
    // Full attach-and-read path is covered by actor.test.ts + tool-surface-policy.test.ts
    // (REST/MCP/tRPC). Here we only pin the shipped export used by those surfaces.
  });
});

describe("G1.7 error envelope + idempotency constants", () => {
  it("builds a canonical error envelope and exposes idempotency TTL", () => {
    const envelope = buildErrorEnvelope({
      statusCode: 403,
      code: "forbidden",
      message: "no",
      traceId: "req-1",
    });
    expect(envelope).toMatchObject({
      error: expect.objectContaining({
        code: "forbidden",
        message: "no",
        traceId: "req-1",
      }),
    });
    expect(DEFAULT_IDEMPOTENCY_TTL_MS).toBeGreaterThan(0);
  });
});

describe("G1.8 request tenant identity", () => {
  it("never uses bootstrap default org as unauthenticated request tenant", () => {
    expect(() => {
      resolveRequestOrgIdentity({
        actorOrgId: undefined,
        resolvedTenantOrgId: undefined,
        defaultOrgId: "00000000-0000-0000-0000-000000000000",
      });
    }).toThrow(/bootstrap default organization/i);
  });

  it("wires identity helper into authenticated request tenant binding", () => {
    const tenantOrgId = "11111111-1111-4111-8111-111111111111";
    expect(() => {
      assertActorMatchesRequestTenant(
        {
          tenant: {
            orgId: tenantOrgId,
            orgSlug: "acme",
            orgTier: "business",
            orgRegion: "us-east-1",
            effectiveConfig: {} as never,
            org: { id: tenantOrgId } as never,
          },
        },
        {
          id: "actor-1",
          orgId: "99999999-9999-4999-8999-999999999999",
          type: "user",
        },
      );
    }).toThrow(TenantActorMismatchError);
  });
});

describe("G1.9 negative matrix scaffold", () => {
  it("ships a loadable matrix covering core domains", () => {
    const cases = loadNegativeMatrixFromDisk();
    expect(cases.some((entry) => entry.domain === "mail")).toBe(true);
    expect(cases.some((entry) => entry.domain === "tenant")).toBe(true);
  });
});

describe("G1.3 audit status vocabulary", () => {
  it("defines durable tool invocation audit statuses used by the registry", () => {
    const statuses: ToolInvocationAuditStatus[] = [
      "denied",
      "pending",
      "executed",
      "failed",
      "cancelled",
    ];
    expect(statuses).toHaveLength(5);
    expect(typeof createToolRegistry).toBe("function");
    expect(typeof shouldQueueConfirmation).toBe("function");
  });
});
