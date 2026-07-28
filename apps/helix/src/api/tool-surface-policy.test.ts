import fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import {
  registerPendingActionMutationRoutes,
  registerToolRestRoutes,
  CredentialAuthError,
} from "../server.js";
import { handleMcpJsonRpcRequest } from "./mcp.js";
import { createHelixTRPCRouter } from "./trpc.js";
import { createPlatformMetrics } from "./metrics.js";
import { createToolRegistry, type RuntimeToolRegistry } from "../platform/tool-registry.js";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import {
  createApiKeyMaterial,
  EMPTY_CREDENTIAL_POLICY,
  type AgentCredentialPolicy,
  type AgentCredentialRecord,
  type AgentCredentialStore,
} from "../platform/auth/credentials.js";
import { InMemoryConfirmationGate } from "../platform/tools/registry.js";
import { InMemoryAgentRateCostLimiter } from "../platform/limits/index.js";
import {
  credentialToolInvocationPrincipal,
  type ToolInvocationPrincipal,
} from "../platform/auth/tool-invocation-principal.js";

const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000014",
  orgId: "00000000-0000-4000-8000-000000000024",
  type: "agent",
  scopes: ["policy.invoke"],
};
const requestContext = { requestId: "policy-surface-test" };
const metrics = createPlatformMetrics();

type Surface = "rest" | "mcp" | "trpc";

describe.each<Surface>(["rest", "mcp", "trpc"])(
  "credential policy on the %s tool surface",
  (surface) => {
    it.each([
      {
        name: "confirmationOverride=always queues an ordinary write",
        override: "always" as const,
        sideEffects: "write" as const,
        expected: "pending_confirmation",
      },
      {
        name: "confirmationOverride=never fails closed for an agent mutation",
        override: "never" as const,
        sideEffects: "destructive" as const,
        expected: "pending_confirmation",
      },
    ])("$name", async ({ override, sideEffects, expected }) => {
      const confirmationGate = new InMemoryConfirmationGate();
      const tools = createPolicyRegistry({ confirmationGate });
      let executions = 0;
      tools.register(
        policyTool(sideEffects, async () => {
          executions += 1;
          return { executed: true };
        }),
      );
      const policy = {
        ...EMPTY_CREDENTIAL_POLICY,
        confirmationOverride: override,
      };

      const result = await invokeSurface(surface, tools, policy);
      expect(result).toBe(expected);
      expect(executions).toBe(expected === "executed" ? 1 : 0);
    });

    it("enforces the credential request-rate override", async () => {
      const tools = createPolicyRegistry({
        agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      });
      let executions = 0;
      tools.register(
        policyTool("read", async () => {
          executions += 1;
          return { executed: true };
        }),
      );
      const policy: AgentCredentialPolicy = {
        ...EMPTY_CREDENTIAL_POLICY,
        rateLimitOverrides: { requestsPerMinute: 1 },
      };

      await expect(invokeSurface(surface, tools, policy)).resolves.toBe("executed");
      await expect(invokeSurface(surface, tools, policy)).resolves.toBe("rate_limited");
      expect(executions).toBe(1);
    });
  },
);

it("re-authenticates a queued credential before approval and denies it after revocation", async () => {
  const confirmationGate = new InMemoryConfirmationGate();
  const tools = createPolicyRegistry({ confirmationGate });
  let executions = 0;
  tools.register(
    policyTool("write", async () => {
      executions += 1;
      return { executed: true };
    }),
  );
  const policy: AgentCredentialPolicy = {
    ...EMPTY_CREDENTIAL_POLICY,
    confirmationOverride: "always",
  };
  const authentication = new MutableApiKeyAuthentication(policy);
  const app = createRestApp(tools, authentication);

  const queued = await app.inject({
    method: "POST",
    url: "/api/tools/policy.invoke",
    headers: { "x-api-key": authentication.apiKey },
    payload: {},
  });
  expect(queued.statusCode).toBe(202);
  const pendingId = queued.json<{ pending: { id: string } }>().pending.id;

  authentication.revoke();
  const approval = await app.inject({
    method: "POST",
    url: `/api/tools/pending/${pendingId}/approve`,
    headers: { "x-api-key": authentication.apiKey },
  });

  expect(approval.statusCode).toBe(403);
  expect(approval.json()).toMatchObject({ code: "credential_revoked" });
  expect(executions).toBe(0);
  await app.close();
});

async function invokeSurface(
  surface: Surface,
  tools: RuntimeToolRegistry,
  policy: AgentCredentialPolicy,
): Promise<"executed" | "pending_confirmation" | "rate_limited"> {
  if (surface === "rest") {
    const authentication = new MutableApiKeyAuthentication(policy);
    const app = createRestApp(tools, authentication);
    const response = await app.inject({
      method: "POST",
      url: "/api/tools/policy.invoke",
      headers: { "x-api-key": authentication.apiKey },
      payload: {},
    });
    await app.close();
    if (response.statusCode === 202) {
      return "pending_confirmation";
    }
    return response.statusCode === 429 ? "rate_limited" : "executed";
  }

  const principal = principalWith(policy);
  if (surface === "mcp") {
    const response = await handleMcpJsonRpcRequest({
      tools,
      principal,
      request: requestContext,
      body: {
        jsonrpc: "2.0",
        id: "policy-call",
        method: "tools/call",
        params: { name: "policy.invoke", arguments: {} },
      },
    });
    if ("error" in response) {
      return response.error.code === -32029 ? "rate_limited" : "executed";
    }
    const result = response.result as {
      readonly structuredContent?: { readonly status?: string };
    };
    return result.structuredContent?.status === "pending_confirmation"
      ? "pending_confirmation"
      : "executed";
  }

  const router = createHelixTRPCRouter({ tools, metrics });
  const caller = router.createCaller({ request: requestContext, principal });
  try {
    const result = await caller.tools.invoke({ toolId: "policy.invoke", input: {} });
    return isPending(result) ? "pending_confirmation" : "executed";
  } catch (error) {
    return errorCode(error) === "TOO_MANY_REQUESTS" ? "rate_limited" : "executed";
  }
}

function createRestApp(
  tools: RuntimeToolRegistry,
  authentication: MutableApiKeyAuthentication,
): FastifyInstance {
  const app = fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CredentialAuthError) {
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    throw error;
  });
  const options = {
    tools,
    metrics,
    tokenStore: {
      async saveToken() {},
      async findToken() {
        return null;
      },
    },
    credentialStore: authentication.store,
  };
  registerToolRestRoutes(app, options, ["POST"]);
  registerPendingActionMutationRoutes(app, options);
  return app;
}

function createPolicyRegistry(options: {
  readonly confirmationGate?: InMemoryConfirmationGate;
  readonly agentRateCostLimiter?: InMemoryAgentRateCostLimiter;
}): RuntimeToolRegistry {
  return createToolRegistry({
    accessPolicy: new AllowAllToolAccessPolicy(),
    ...(options.confirmationGate === undefined
      ? {}
      : { confirmationGate: options.confirmationGate }),
    ...(options.agentRateCostLimiter === undefined
      ? {}
      : {
          agentRateCostLimiter: options.agentRateCostLimiter,
          agentLimitTier: "business",
          agentLimitBudget: {
            requestsPerMinute: 100,
            requestsPerDay: 1_000,
            costPerDayUsdMicros: null,
          },
        }),
  });
}

function policyTool(
  sideEffects: ToolDefinition["sideEffects"],
  handler: () => Promise<{ readonly executed: true }>,
): ToolDefinition {
  return {
    id: "policy.invoke",
    description: "Exercise credential policy propagation.",
    permission: "policy.invoke",
    sideEffects,
    inputSchema: schema,
    outputSchema: schema,
    handler,
  };
}

function principalWith(policy: AgentCredentialPolicy): ToolInvocationPrincipal {
  return credentialToolInvocationPrincipal({
    actor,
    credentialId: "00000000-0000-4000-8000-000000000034",
    credentialPolicy: policy,
  });
}

class MutableApiKeyAuthentication {
  readonly apiKey: string;
  readonly store: AgentCredentialStore;
  #record: AgentCredentialRecord;

  constructor(policy: AgentCredentialPolicy) {
    const material = createApiKeyMaterial();
    this.apiKey = material.apiKey;
    this.#record = {
      id: "00000000-0000-4000-8000-000000000034",
      credentialType: "api_key",
      actorId: actor.id,
      orgId: actor.orgId,
      scopes: actor.scopes ?? [],
      clientId: null,
      secretHash: null,
      apiKeyHash: material.apiKeyHash,
      certFingerprint: null,
      label: "surface-test",
      policy,
      expiresAt: null,
      revokedAt: null,
    };
    this.store = {
      findByApiKeyHash: async (hash) => (hash === this.#record.apiKeyHash ? this.#record : null),
      findByCertFingerprint: async () => null,
      findByClientId: async () => null,
    };
  }

  revoke(): void {
    this.#record = { ...this.#record, revokedAt: new Date() };
  }
}

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object", additionalProperties: true }),
};

function isPending(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "pending_confirmation"
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
