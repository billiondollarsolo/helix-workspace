import { describe, expect, it } from "vitest";
import type { Actor, AuditRecord, RequestContext, ToolDefinition } from "@helix/sdk-types";
import { tierDefaults } from "./config/tier.js";
import { createToolRegistry, featureFlagForTool } from "./tool-registry.js";
import { InMemoryConfirmationGate } from "./tools/registry.js";
import {
  InMemoryAgentRateCostLimiter,
  usdToMicros,
  type AgentLimitBudget,
} from "./limits/index.js";

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object" }),
};

const actor: Actor = {
  id: "actor-1",
  orgId: "org-1",
  type: "agent",
  scopes: ["platform.read", "danger.write"],
};

describe("RuntimeToolRegistry", () => {
  it("denies invocations without an authenticated actor by default", async () => {
    const registry = createToolRegistry();

    await expect(registry.invoke("platform.ping", {})).resolves.toEqual({
      ok: false,
      statusCode: 403,
      error: "Actor cannot invoke tool: platform.ping",
    });
  });

  it("backs ToolContext requirePermission with the registry access policy", async () => {
    const registry = createToolRegistry();
    registry.register(
      tool({
        id: "resource.check",
        permission: "platform.read",
        handler: async (_input, ctx) => {
          await ctx.requirePermission("resource.write", { type: "document", id: "doc-1" });
          return { ok: true };
        },
      }),
    );

    await expect(registry.invoke("resource.check", {}, { actor })).resolves.toMatchObject({
      ok: false,
      statusCode: 403,
      error: "Actor cannot perform action: resource.write",
    });
  });

  it("enforces declared scope composition against the parsed call input", async () => {
    const registry = createToolRegistry();
    registry.register(
      tool({
        id: "mail.send",
        permission: "mail.send",
        sideEffects: "external_communication",
        scopeComposition: {
          conditionalScopes: [
            {
              scope: "mail.external",
              reason: "external recipient",
              when: (input) =>
                ((input as { recipient?: string }).recipient ?? "").endsWith("@outside.test"),
            },
          ],
        },
        handler: async () => ({ sent: true }),
      }),
    );

    const baseActor: Actor = {
      id: "agent-1",
      orgId: "org-1",
      type: "agent",
      scopes: ["mail.send"],
    };

    // Internal recipient: base scope is sufficient.
    await expect(
      registry.invoke("mail.send", { recipient: "bob@internal" }, { actor: baseActor }),
    ).resolves.toMatchObject({ ok: true, output: { sent: true } });

    // External recipient without mail.external is denied with a descriptive error.
    const denied = await registry.invoke(
      "mail.send",
      { recipient: "partner@outside.test" },
      { actor: baseActor },
    );
    expect(denied).toMatchObject({ ok: false, statusCode: 403 });
    expect(denied.ok ? "" : denied.error).toContain("mail.external");

    // External recipient with mail.external succeeds.
    await expect(
      registry.invoke(
        "mail.send",
        { recipient: "partner@outside.test" },
        { actor: { ...baseActor, scopes: ["mail.send", "mail.external"] } },
      ),
    ).resolves.toMatchObject({ ok: true, output: { sent: true } });

    // System actors bypass composition enforcement.
    await expect(
      registry.invoke(
        "mail.send",
        { recipient: "partner@outside.test" },
        { actor: { id: "system", orgId: "org-1", type: "system" } },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it("live-reads tenant feature flags as tool kill switches", async () => {
    const evaluations: unknown[] = [];
    let enabled = false;
    const registry = createToolRegistry({
      featureFlags: {
        get: <T>() => enabled as T,
        async getAsync<T>(key: string, defaultValue: T, context?: unknown) {
          evaluations.push({ key, defaultValue, context });
          return enabled as T;
        },
      },
    });
    registry.register(
      tool({
        id: "mail.send",
        permission: "platform.read",
        sideEffects: "external_communication",
        handler: async () => ({ sent: true }),
      }),
    );

    await expect(registry.listVisible(actor)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "mail.send" })]),
    );
    const blocked = await registry.invoke("mail.send", {}, { actor });
    expect(blocked).toMatchObject({
      ok: false,
      statusCode: 403,
      error: "Tool mail.send is disabled by tenant feature flag: mail_outbound",
    });
    expect(evaluations).toEqual(
      expect.arrayContaining([
        {
          key: "mail_outbound",
          defaultValue: true,
          context: {
            orgId: actor.orgId,
            actorId: actor.id,
            attributes: { toolId: "mail.send" },
          },
        },
      ]),
    );

    enabled = true;
    await expect(registry.listVisible(actor)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "mail.send" })]),
    );
    await expect(registry.invoke("mail.send", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { sent: true },
    });
  });

  it("queues confirmation for enforced destructive calls and executes after approval", async () => {
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      confirmationGate,
      confirmationDefaults: tierDefaults.personal,
    });
    const calls: unknown[] = [];
    registry.register(
      tool({
        id: "danger.delete",
        permission: "danger.write",
        sideEffects: "destructive",
        handler: async (input) => {
          calls.push(input);
          return { deleted: true };
        },
      }),
    );

    const pending = await registry.invoke(
      "danger.delete",
      { id: "obj-1" },
      {
        actor,
        enforceConfirmation: true,
      },
    );

    expect(pending).toMatchObject({
      ok: true,
      status: "pending_confirmation",
      pending: {
        toolId: "danger.delete",
        actorId: actor.id,
        input: { id: "obj-1" },
      },
    });
    expect(calls).toEqual([]);
    if (!pending.ok || pending.status !== "pending_confirmation") {
      throw new Error("Expected pending confirmation.");
    }

    const approved = await registry.approvePending(pending.pending.id, { actor });

    expect(approved).toMatchObject({
      ok: true,
      output: { deleted: true },
    });
    expect(calls).toEqual([{ id: "obj-1" }]);
  });

  it("enforces agent request limits with retry metadata without leaking blocked input", async () => {
    const auditSink = new MemoryAuditSink();
    const registry = createToolRegistry({
      auditSink,
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: requestLimitBudget,
    });
    let calls = 0;
    registry.register(
      tool({
        id: "limited.echo",
        permission: "platform.read",
        handler: async (_input, ctx) => {
          calls += 1;
          await ctx.audit("tool.invoked", {
            ...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
          });
          return { ok: true };
        },
      }),
    );

    await expect(
      registry.invoke("limited.echo", { token: "first-token" }, { actor, request: traceRequest }),
    ).resolves.toMatchObject({
      ok: true,
      output: { ok: true },
    });

    const blocked = await registry.invoke(
      "limited.echo",
      { token: "blocked-secret-token" },
      { actor, request: traceRequest },
    );

    if (blocked.ok) {
      throw new Error("Expected agent invocation to be rate limited.");
    }
    expect(blocked.statusCode).toBe(429);
    expect(typeof blocked.retryAfterSeconds).toBe("number");
    expect(blocked.rateLimit?.reason).toBe("requests_per_minute");
    expect(typeof blocked.rateLimit?.retryAfterSeconds).toBe("number");
    expect(blocked.rateLimit?.usage.requestsPerMinute).toMatchObject({
      limit: 1,
      used: 1,
      remaining: 0,
    });
    expect(JSON.stringify(blocked)).not.toContain("blocked-secret-token");
    expect(calls).toBe(1);
    expect(auditSink.records).toHaveLength(1);
    expect(auditSink.records[0]).toMatchObject({
      actorId: actor.id,
      toolId: "limited.echo",
      trace: { traceId: traceRequest.traceId, spanId: traceRequest.spanId },
      metadata: { actorType: "agent", toolPermission: "platform.read" },
    });
  });

  it("blocks agent invocations when estimated cost would exceed the daily budget", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: null,
        requestsPerDay: null,
        costPerDayUsdMicros: usdToMicros(0.01),
        costWarningThresholdRatio: 0.8,
      },
    });
    let calls = 0;
    registry.register(
      tool({
        id: "limited.costly",
        permission: "platform.read",
        handler: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );

    const blocked = await registry.invoke(
      "limited.costly",
      {},
      {
        actor,
        estimatedCostUsdMicros: usdToMicros(0.02),
      },
    );

    if (blocked.ok) {
      throw new Error("Expected agent invocation to be cost limited.");
    }
    expect(blocked.statusCode).toBe(429);
    expect(typeof blocked.retryAfterSeconds).toBe("number");
    expect(blocked.rateLimit?.reason).toBe("cost_per_day");
    expect(blocked.rateLimit?.usage.costPerDay).toMatchObject({
      limitUsdMicros: usdToMicros(0.01),
      usedUsdMicros: 0,
      remainingUsdMicros: usdToMicros(0.01),
    });
    expect(calls).toBe(0);
  });

  it("uses tool-level estimated cost metadata when callers do not provide an estimate", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: null,
        requestsPerDay: null,
        costPerDayUsdMicros: usdToMicros(0.01),
        costWarningThresholdRatio: 0.8,
      },
    });
    let calls = 0;
    registry.register(
      tool({
        id: "limited.metadata-costly",
        permission: "platform.read",
        estimatedCostUsdMicros: usdToMicros(0.02),
        handler: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );

    const blocked = await registry.invoke("limited.metadata-costly", {}, { actor });

    if (blocked.ok) {
      throw new Error("Expected agent invocation to be cost limited.");
    }
    expect(blocked.statusCode).toBe(429);
    expect(blocked.rateLimit?.reason).toBe("cost_per_day");
    expect(calls).toBe(0);
  });

  it("records successful tool costs cumulatively for later budget decisions", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: null,
        requestsPerDay: null,
        costPerDayUsdMicros: usdToMicros(0.02),
        costWarningThresholdRatio: 0.8,
      },
    });
    let calls = 0;
    registry.register(
      tool({
        id: "limited.cumulative-cost",
        permission: "platform.read",
        estimatedCostUsdMicros: usdToMicros(0.01),
        handler: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );

    await expect(registry.invoke("limited.cumulative-cost", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { ok: true },
    });
    await expect(registry.invoke("limited.cumulative-cost", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { ok: true },
    });

    const blocked = await registry.invoke("limited.cumulative-cost", {}, { actor });

    expect(blocked).toMatchObject({
      ok: false,
      statusCode: 429,
      rateLimit: {
        reason: "cost_per_day",
        usage: {
          costPerDay: {
            usedUsdMicros: usdToMicros(0.02),
            remainingUsdMicros: 0,
          },
        },
      },
    });
    expect(calls).toBe(2);
  });

  it("does not record cost for failed tool executions", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: null,
        requestsPerDay: null,
        costPerDayUsdMicros: usdToMicros(0.02),
        costWarningThresholdRatio: 0.8,
      },
    });
    registry.register(
      tool({
        id: "limited.failed-cost",
        permission: "platform.read",
        estimatedCostUsdMicros: usdToMicros(0.02),
        handler: async () => {
          throw new Error("backend unavailable");
        },
      }),
    );
    registry.register(
      tool({
        id: "limited.after-failure",
        permission: "platform.read",
        estimatedCostUsdMicros: usdToMicros(0.02),
        handler: async () => ({ ok: true }),
      }),
    );

    await expect(registry.invoke("limited.failed-cost", {}, { actor })).resolves.toMatchObject({
      ok: false,
      statusCode: 500,
      error: "backend unavailable",
    });
    await expect(registry.invoke("limited.after-failure", {}, { actor })).resolves.toMatchObject({
      ok: true,
      output: { ok: true },
    });
  });

  it("records cost once when confirmed pending actions execute", async () => {
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      confirmationGate,
      confirmationDefaults: tierDefaults.personal,
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: null,
        requestsPerDay: null,
        costPerDayUsdMicros: usdToMicros(0.01),
        costWarningThresholdRatio: 0.8,
      },
    });
    let calls = 0;
    registry.register(
      tool({
        id: "limited.confirmed-cost",
        permission: "danger.write",
        sideEffects: "destructive",
        estimatedCostUsdMicros: usdToMicros(0.01),
        handler: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );

    const pending = await registry.invoke(
      "limited.confirmed-cost",
      {},
      {
        actor,
        enforceConfirmation: true,
      },
    );
    if (!pending.ok || pending.status !== "pending_confirmation") {
      throw new Error("Expected pending confirmation.");
    }
    expect(calls).toBe(0);

    await expect(registry.approvePending(pending.pending.id, { actor })).resolves.toMatchObject({
      ok: true,
      output: { ok: true },
    });
    const blocked = await registry.invoke("limited.confirmed-cost", {}, { actor });

    expect(blocked).toMatchObject({
      ok: false,
      statusCode: 429,
      rateLimit: { reason: "cost_per_day" },
    });
    expect(calls).toBe(1);
  });

  it("lets request-specific estimates override tool-level cost metadata", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: null,
        requestsPerDay: null,
        costPerDayUsdMicros: usdToMicros(0.01),
        costWarningThresholdRatio: 0.8,
      },
    });
    registry.register(
      tool({
        id: "limited.override-cost",
        permission: "platform.read",
        estimatedCostUsdMicros: usdToMicros(0.02),
        handler: async () => ({ ok: true }),
      }),
    );

    await expect(
      registry.invoke("limited.override-cost", {}, { actor, estimatedCostUsdMicros: 0 }),
    ).resolves.toMatchObject({
      ok: true,
      output: { ok: true },
    });
  });

  it("preserves user and system invocation behavior while limiting service accounts", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: 0,
        requestsPerDay: 0,
        costPerDayUsdMicros: null,
        costWarningThresholdRatio: 0.8,
      },
    });
    registry.register(
      tool({
        id: "limited.machine-only",
        permission: "platform.read",
        handler: async (_input, ctx) => ({ actorType: ctx.actor.type }),
      }),
    );

    await expect(
      registry.invoke("limited.machine-only", {}, { actor: userActor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { actorType: "user" },
    });
    await expect(
      registry.invoke("limited.machine-only", {}, { actor: systemTestActor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { actorType: "system" },
    });
    await expect(
      registry.invoke("limited.machine-only", {}, { actor: serviceAccountActor }),
    ).resolves.toMatchObject({
      ok: false,
      statusCode: 429,
      rateLimit: { reason: "requests_per_minute" },
    });
  });

  it("records tool invocation metrics in the central registry", async () => {
    const metrics = new MemoryToolMetrics();
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      confirmationGate,
      confirmationDefaults: tierDefaults.personal,
      metrics,
    });
    registry.register(
      tool({
        id: "observed.read",
        permission: "platform.read",
        handler: async () => ({ ok: true }),
      }),
    );
    registry.register(
      tool({
        id: "observed.delete",
        permission: "danger.write",
        sideEffects: "destructive",
        handler: async () => ({ ok: true }),
      }),
    );

    await registry.invoke("observed.read", {}, { actor });
    await registry.invoke("observed.delete", {}, { actor, enforceConfirmation: true });
    await registry.invoke("observed.read", {}, { actor: { ...actor, scopes: [] } });

    expect(metrics.records).toEqual([
      expect.objectContaining({ toolId: "observed.read", status: "executed" }),
      expect.objectContaining({ toolId: "observed.delete", status: "pending_confirmation" }),
      expect.objectContaining({ toolId: "observed.read", status: "error" }),
    ]);
    expect(metrics.records.every((record) => record.durationSeconds >= 0)).toBe(true);
  });

  it("records dedicated agent limiter denial metrics", async () => {
    const metrics = new MemoryToolMetrics();
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: requestLimitBudget,
      metrics,
    });
    registry.register(
      tool({
        id: "observed.limited",
        permission: "platform.read",
        handler: async () => ({ ok: true }),
      }),
    );

    await registry.invoke("observed.limited", {}, { actor });
    await registry.invoke("observed.limited", {}, { actor });

    expect(metrics.limiterDenials).toEqual([
      {
        toolId: "observed.limited",
        tier: "business",
        actorType: "agent",
        reason: "requests_per_minute",
      },
    ]);
  });
});

describe("per-credential policy overrides (PRD §9.2)", () => {
  it("forces confirmation when the credential override is 'always'", async () => {
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      confirmationGate,
      // Personal tier only confirms destructive tools by default.
      confirmationDefaults: tierDefaults.personal,
    });
    registry.register(
      tool({
        id: "notes.write",
        permission: "platform.read",
        sideEffects: "write",
        handler: async () => ({ ok: true }),
      }),
    );

    // Without an override a non-destructive write executes immediately.
    await expect(
      registry.invoke("notes.write", {}, { actor, enforceConfirmation: true }),
    ).resolves.toMatchObject({ ok: true, output: { ok: true } });

    // With an "always" override the same call is queued for confirmation.
    const pending = await registry.invoke(
      "notes.write",
      {},
      {
        actor,
        enforceConfirmation: true,
        credentialPolicy: { confirmationOverride: "always" },
      },
    );
    expect(pending).toMatchObject({ ok: true, status: "pending_confirmation" });
  });

  it("bypasses confirmation when the credential override is 'never'", async () => {
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      confirmationGate,
      confirmationDefaults: tierDefaults.personal,
    });
    const calls: unknown[] = [];
    registry.register(
      tool({
        id: "danger.purge",
        permission: "danger.write",
        sideEffects: "destructive",
        handler: async (input) => {
          calls.push(input);
          return { purged: true };
        },
      }),
    );

    const result = await registry.invoke(
      "danger.purge",
      { id: "x" },
      {
        actor,
        enforceConfirmation: true,
        credentialPolicy: { confirmationOverride: "never" },
      },
    );
    expect(result).toMatchObject({ ok: true, output: { purged: true } });
    expect(calls).toEqual([{ id: "x" }]);
  });

  it("tightens the rate limit via a per-credential override", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      // Generous tier budget; the credential override is what bites.
      agentLimitBudget: {
        requestsPerMinute: 1_000,
        requestsPerDay: 1_000,
        costPerDayUsdMicros: null,
        costWarningThresholdRatio: 0.8,
      },
    });
    registry.register(
      tool({
        id: "limited.override",
        permission: "platform.read",
        handler: async () => ({ ok: true }),
      }),
    );

    const credentialPolicy = { rateLimitOverrides: { requestsPerMinute: 1 } };
    await expect(
      registry.invoke("limited.override", {}, { actor, credentialPolicy }),
    ).resolves.toMatchObject({ ok: true });

    const blocked = await registry.invoke("limited.override", {}, { actor, credentialPolicy });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.statusCode).toBe(429);
      expect(blocked.rateLimit?.reason).toBe("requests_per_minute");
    }
  });

  it("relaxes a tier rate limit when the override removes the cap", async () => {
    const registry = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: 1,
        requestsPerDay: 1,
        costPerDayUsdMicros: null,
        costWarningThresholdRatio: 0.8,
      },
    });
    registry.register(
      tool({
        id: "relaxed.override",
        permission: "platform.read",
        handler: async () => ({ ok: true }),
      }),
    );

    const credentialPolicy = {
      rateLimitOverrides: { requestsPerMinute: null, requestsPerDay: null },
    };
    await expect(
      registry.invoke("relaxed.override", {}, { actor, credentialPolicy }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      registry.invoke("relaxed.override", {}, { actor, credentialPolicy }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("featureFlagForTool", () => {
  it("maps core-app tools to tenant kill-switch flags", () => {
    expect(featureFlagForTool({ id: "mail.send" })).toBe("mail_outbound");
    expect(featureFlagForTool({ id: "mail.reply" })).toBe("mail_outbound");
    expect(featureFlagForTool({ id: "drive.share" })).toBe("b2b_sharing");
    expect(featureFlagForTool({ id: "drive.access.remove" })).toBe("b2b_sharing");
    expect(featureFlagForTool({ id: "docs.create" })).toBe("editors_native_document");
    expect(featureFlagForTool({ id: "sheets.create" })).toBe("editors_native_spreadsheet");
    expect(featureFlagForTool({ id: "slides.deck.create" })).toBe("editors_native_presentation");
    expect(featureFlagForTool({ id: "platform.ping" })).toBeUndefined();
  });
});

const requestLimitBudget: AgentLimitBudget = {
  requestsPerMinute: 1,
  requestsPerDay: 10,
  costPerDayUsdMicros: null,
  costWarningThresholdRatio: 0.8,
};

const traceRequest: RequestContext = {
  requestId: "req-1",
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  ip: "127.0.0.1",
  userAgent: "vitest",
};

const userActor: Actor = {
  id: "user-1",
  orgId: "org-1",
  type: "user",
  scopes: ["platform.read"],
};

const serviceAccountActor: Actor = {
  id: "service-1",
  orgId: "org-1",
  type: "service_account",
  scopes: ["platform.read"],
};

const systemTestActor: Actor = {
  id: "system",
  orgId: "org-1",
  type: "system",
};

class MemoryAuditSink {
  readonly records: (AuditRecord & { readonly orgId: string })[] = [];

  async append(record: AuditRecord & { readonly orgId: string }): Promise<void> {
    this.records.push(record);
  }
}

class MemoryToolMetrics {
  readonly records: {
    readonly toolId: string;
    readonly status: "executed" | "pending_confirmation" | "error";
    readonly durationSeconds: number;
  }[] = [];
  readonly limiterDenials: {
    readonly toolId: string;
    readonly tier: string;
    readonly actorType: string;
    readonly reason: string;
  }[] = [];

  recordToolInvocation(record: {
    readonly toolId: string;
    readonly status: "executed" | "pending_confirmation" | "error";
    readonly durationSeconds: number;
  }): void {
    this.records.push(record);
  }

  recordAgentToolLimiterDenial(record: {
    readonly toolId: string;
    readonly tier: string;
    readonly actorType: string;
    readonly reason: string;
  }): void {
    this.limiterDenials.push(record);
  }
}

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
