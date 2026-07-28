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
const approver: Actor = {
  id: "admin-1",
  orgId: "org-1",
  type: "user",
  scopes: ["admin.*"],
};
const humanActor: Actor = { ...actor, type: "user" };
const resolveTestPendingPrincipal = async (record: { readonly requesterPrincipal: Actor }) => ({
  actor: record.requesterPrincipal,
});

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
      type: "user",
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
        get: (_key, _defaultValue) => enabled as typeof _defaultValue,
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
    await expect(registry.invoke("mail.send", {}, { actor: humanActor })).resolves.toMatchObject({
      ok: true,
      output: { sent: true },
    });
  });

  it("queues confirmation for enforced destructive calls and executes after approval", async () => {
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      confirmationGate,
      confirmationDefaults: tierDefaults.personal,
      resolvePendingPrincipal: resolveTestPendingPrincipal,
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
        preview: {
          toolId: "danger.delete",
          consequence: "Permanently change or remove data using danger.delete.",
        },
      },
    });
    expect(calls).toEqual([]);
    if (!pending.ok || pending.status !== "pending_confirmation") {
      throw new Error("Expected pending confirmation.");
    }

    const approved = await registry.approvePending(pending.pending.id, { actor: approver });

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
    const domainRecords = auditSink.records.filter((record) => record.verb === "tool.invoked");
    const invocationRecords = auditSink.records.filter((record) =>
      record.verb.startsWith("tool.invocation."),
    );
    expect(domainRecords).toHaveLength(1);
    expect(domainRecords[0]).toMatchObject({
      actorId: actor.id,
      toolId: "limited.echo",
      trace: { traceId: traceRequest.traceId, spanId: traceRequest.spanId },
      metadata: { actorType: "agent", toolPermission: "platform.read" },
    });
    expect(invocationRecords).toHaveLength(2);
    expect(invocationRecords.map((record) => record.verb)).toEqual([
      "tool.invocation.executed",
      "tool.invocation.denied",
    ]);
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
      resolvePendingPrincipal: resolveTestPendingPrincipal,
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

    await expect(
      registry.approvePending(pending.pending.id, { actor: approver }),
    ).resolves.toMatchObject({
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

  it("emits exactly one generic outcome for every invocation exit", async () => {
    const outcomes: { readonly name: string; readonly records: readonly AuditRecord[] }[] = [];

    async function capture(
      name: string,
      run: (auditSink: MemoryAuditSink) => Promise<unknown>,
    ): Promise<void> {
      const auditSink = new MemoryAuditSink();
      await run(auditSink);
      outcomes.push({
        name,
        records: auditSink.records.filter((record) => record.verb.startsWith("tool.invocation.")),
      });
    }

    await capture("unknown", async (auditSink) => {
      await createToolRegistry({ auditSink }).invoke("missing.tool", {}, { actor });
    });
    await capture("access", async (auditSink) => {
      const registry = createToolRegistry({ auditSink });
      registry.register(
        tool({
          id: "matrix.access",
          permission: "platform.read",
          handler: async () => ({ ok: true }),
        }),
      );
      await registry.invoke("matrix.access", {}, { actor: { ...actor, scopes: [] } });
    });
    await capture("feature", async (auditSink) => {
      const registry = createToolRegistry({
        auditSink,
        featureFlags: {
          get: (_key, defaultValue) => defaultValue,
          async getAsync<T>() {
            return false as T;
          },
        },
      });
      registry.register(
        tool({
          id: "mail.send",
          permission: "platform.read",
          sideEffects: "external_communication",
          handler: async () => ({ ok: true }),
        }),
      );
      await registry.invoke("mail.send", {}, { actor });
    });
    await capture("rate", async (auditSink) => {
      const registry = createToolRegistry({
        auditSink,
        agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
        agentLimitBudget: {
          requestsPerMinute: 0,
          requestsPerDay: null,
          costPerDayUsdMicros: null,
          costWarningThresholdRatio: 0.8,
        },
      });
      registry.register(
        tool({
          id: "matrix.rate",
          permission: "platform.read",
          handler: async () => ({ ok: true }),
        }),
      );
      await registry.invoke("matrix.rate", {}, { actor });
    });
    await capture("validation", async (auditSink) => {
      const registry = createToolRegistry({ auditSink });
      registry.register(
        tool({
          id: "matrix.validation",
          permission: "platform.read",
          inputSchema: {
            parse: () => {
              const error = new Error("invalid shape");
              error.name = "ZodError";
              throw error;
            },
            toJsonSchema: () => ({ type: "object" }),
          },
          handler: async () => ({ ok: true }),
        }),
      );
      await registry.invoke("matrix.validation", { secret: "never-audited" }, { actor });
    });
    await capture("scope", async (auditSink) => {
      const registry = createToolRegistry({ auditSink });
      registry.register(
        tool({
          id: "matrix.scope",
          permission: "platform.read",
          scopeComposition: { requiredScopes: ["platform.admin"] },
          handler: async () => ({ ok: true }),
        }),
      );
      await registry.invoke("matrix.scope", {}, { actor });
    });
    await capture("pending", async (auditSink) => {
      const registry = createToolRegistry({
        auditSink,
        confirmationGate: new InMemoryConfirmationGate(),
      });
      registry.register(
        tool({
          id: "matrix.pending",
          permission: "danger.write",
          sideEffects: "destructive",
          handler: async () => ({ ok: true }),
        }),
      );
      await registry.invoke("matrix.pending", {}, { actor, enforceConfirmation: true });
    });
    await capture("executed", async (auditSink) => {
      const registry = createToolRegistry({ auditSink });
      registry.register(
        tool({
          id: "matrix.executed",
          permission: "platform.read",
          handler: async () => ({ ok: true }),
        }),
      );
      await registry.invoke("matrix.executed", {}, { actor });
    });
    await capture("handler", async (auditSink) => {
      const registry = createToolRegistry({ auditSink });
      registry.register(
        tool({
          id: "matrix.handler",
          permission: "platform.read",
          handler: async () => {
            throw new Error("dependency unavailable");
          },
        }),
      );
      await registry.invoke("matrix.handler", {}, { actor });
    });

    expect(
      outcomes.map(({ name, records }) => ({
        name,
        count: records.length,
        verb: records[0]?.verb,
      })),
    ).toEqual([
      { name: "unknown", count: 1, verb: "tool.invocation.denied" },
      { name: "access", count: 1, verb: "tool.invocation.denied" },
      { name: "feature", count: 1, verb: "tool.invocation.denied" },
      { name: "rate", count: 1, verb: "tool.invocation.denied" },
      { name: "validation", count: 1, verb: "tool.invocation.denied" },
      { name: "scope", count: 1, verb: "tool.invocation.denied" },
      { name: "pending", count: 1, verb: "tool.invocation.pending" },
      { name: "executed", count: 1, verb: "tool.invocation.executed" },
      { name: "handler", count: 1, verb: "tool.invocation.failed" },
    ]);
  });

  it("records only the safe generic audit shape, never input or output content", async () => {
    const auditSink = new MemoryAuditSink();
    const registry = createToolRegistry({
      auditSink,
      confirmationDefaults: tierDefaults.business,
    });
    registry.register(
      tool({
        id: "mail.deliver-sensitive",
        permission: "mail.send",
        sideEffects: "external_communication",
        handler: async () => ({
          body: "sensitive-output-body",
          providerResponse: "provider-secret-response",
        }),
      }),
    );
    const idempotencyFingerprint = "a".repeat(64);

    await registry.invoke(
      "mail.deliver-sensitive",
      {
        prompt: "ignore prior instructions",
        body: "sensitive-input-body",
        address: "private@example.test",
        filename: "secret-plan.pdf",
        token: "raw-bearer-token",
      },
      {
        actor: { ...humanActor, scopes: ["mail.send"] },
        request: traceRequest,
        credentialId: "credential-safe-id",
        idempotencyFingerprint,
      },
    );

    const record = auditSink.records[0];
    if (record === undefined) {
      throw new Error("Expected a generic audit record.");
    }
    const normalized = {
      ...record,
      createdAt: "<timestamp>",
      metadata: {
        ...record.metadata,
        durationBucket: "<duration-bucket>",
      },
    };
    expect(normalized).toMatchInlineSnapshot(`
      {
        "actorId": "actor-1",
        "createdAt": "<timestamp>",
        "metadata": {
          "actorType": "user",
          "credentialId": "credential-safe-id",
          "durationBucket": "<duration-bucket>",
          "idempotencyFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "orgId": "org-1",
          "sideEffectClass": "external_communication",
          "status": "executed",
          "toolId": "mail.deliver-sensitive",
          "toolPermission": "mail.send",
        },
        "objectType": "tool_invocation",
        "orgId": "org-1",
        "toolId": "mail.deliver-sensitive",
        "trace": {
          "spanId": "0123456789abcdef",
          "traceId": "0123456789abcdef0123456789abcdef",
        },
        "verb": "tool.invocation.executed",
      }
    `);
    const serialized = JSON.stringify(record);
    for (const sensitiveValue of [
      "ignore prior instructions",
      "sensitive-input-body",
      "private@example.test",
      "secret-plan.pdf",
      "raw-bearer-token",
      "sensitive-output-body",
      "provider-secret-response",
    ]) {
      expect(serialized).not.toContain(sensitiveValue);
    }
  });

  it("omits a raw idempotency value that is not a SHA-256 fingerprint", async () => {
    const auditSink = new MemoryAuditSink();
    const registry = createToolRegistry({ auditSink });

    await registry.invoke(
      "platform.ping",
      {},
      { actor, idempotencyFingerprint: "raw-idempotency-key-secret" },
    );

    expect(auditSink.records[0]?.metadata).not.toHaveProperty("idempotencyFingerprint");
    expect(JSON.stringify(auditSink.records[0])).not.toContain("raw-idempotency-key-secret");
  });

  it.each([
    {
      name: "destructive",
      id: "critical.delete",
      permission: "danger.write",
      sideEffects: "destructive" as const,
    },
    {
      name: "external communication",
      id: "critical.send",
      permission: "danger.write",
      sideEffects: "external_communication" as const,
    },
    {
      name: "credential change",
      id: "agent.credentials.rotate",
      permission: "agent.credentials.write",
      sideEffects: "write" as const,
    },
    {
      name: "permission change",
      id: "admin.permission.update",
      permission: "permission.write",
      sideEffects: "write" as const,
    },
    {
      name: "policy change",
      id: "admin.policy.update",
      permission: "policy.write",
      sideEffects: "write" as const,
    },
  ])("fails closed for an unaudited Business $name outcome", async (criticalTool) => {
    let calls = 0;
    const registry = createToolRegistry({
      auditSink: new FailingAuditSink(),
      confirmationDefaults: tierDefaults.business,
    });
    registry.register(
      tool({
        id: criticalTool.id,
        permission: criticalTool.permission,
        sideEffects: criticalTool.sideEffects,
        handler: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );

    const result = await registry.invoke(
      criticalTool.id,
      {},
      {
        actor: {
          ...actor,
          type: criticalTool.id === "agent.credentials.rotate" ? "agent" : "user",
          scopes: [criticalTool.permission],
        },
      },
    );

    if (criticalTool.id === "agent.credentials.rotate") {
      expect(result).toMatchObject({
        ok: false,
        statusCode: 403,
        error:
          "Agent credentials cannot modify their own authorization policy: agent.credentials.rotate",
      });
      expect(calls).toBe(0);
    } else {
      expect(result).toMatchObject({
        ok: false,
        statusCode: 503,
        error:
          "Critical tool outcome could not be durably audited; retry only with the same idempotency key.",
      });
      expect(calls).toBe(1);
    }
  });

  it("defines non-critical and Personal-tier audit outage behavior", async () => {
    const businessRegistry = createToolRegistry({
      auditSink: new FailingAuditSink(),
      confirmationDefaults: tierDefaults.business,
    });
    businessRegistry.register(
      tool({
        id: "notes.write",
        permission: "platform.read",
        sideEffects: "write",
        handler: async () => ({ ok: true }),
      }),
    );
    const personalRegistry = createToolRegistry({
      auditSink: new FailingAuditSink(),
      confirmationDefaults: tierDefaults.personal,
    });
    personalRegistry.register(
      tool({
        id: "danger.personal-delete",
        permission: "danger.write",
        sideEffects: "destructive",
        handler: async () => ({ ok: true }),
      }),
    );

    await expect(
      businessRegistry.invoke("notes.write", {}, { actor: humanActor }),
    ).resolves.toMatchObject({ ok: true, output: { ok: true } });
    await expect(
      personalRegistry.invoke("danger.personal-delete", {}, { actor: humanActor }),
    ).resolves.toMatchObject({
      ok: true,
      output: { ok: true },
    });
  });

  it("fails closed and cancels a pending action when its audit cannot persist", async () => {
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      auditSink: new FailingAuditSink(),
      confirmationGate,
      confirmationDefaults: tierDefaults.business,
    });
    registry.register(
      tool({
        id: "critical.pending",
        permission: "danger.write",
        sideEffects: "destructive",
        handler: async () => ({ ok: true }),
      }),
    );

    const result = await registry.invoke(
      "critical.pending",
      {},
      { actor, enforceConfirmation: true },
    );

    expect(result).toMatchObject({ ok: false, statusCode: 503 });
  });

  it("correlates pending approval execution and prevents duplicate executed audit outcomes", async () => {
    const auditSink = new MemoryAuditSink();
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      auditSink,
      confirmationGate,
      confirmationDefaults: tierDefaults.business,
      resolvePendingPrincipal: resolveTestPendingPrincipal,
    });
    let calls = 0;
    let executionIdempotencyKey: string | undefined;
    registry.register(
      tool({
        id: "critical.approve-once",
        permission: "danger.write",
        sideEffects: "destructive",
        handler: async (_input, context) => {
          calls += 1;
          executionIdempotencyKey = context.idempotencyKey;
          return { ok: true };
        },
      }),
    );

    const queued = await registry.invoke(
      "critical.approve-once",
      {},
      { actor, request: traceRequest, enforceConfirmation: true },
    );
    if (!queued.ok || queued.status !== "pending_confirmation") {
      throw new Error("Expected pending confirmation.");
    }

    await expect(
      registry.approvePending(queued.pending.id, {
        actor: approver,
        request: { ...traceRequest, traceId: "f".repeat(32) },
      }),
    ).resolves.toMatchObject({ ok: true, output: { ok: true } });
    await expect(
      registry.approvePending(queued.pending.id, { actor: approver }),
    ).resolves.toMatchObject({ ok: false, statusCode: 404 });

    const invocationRecords = auditSink.records.filter((record) =>
      record.verb.startsWith("tool.invocation."),
    );
    expect(invocationRecords.map((record) => record.verb)).toEqual([
      "tool.invocation.pending",
      "tool.invocation.executed",
      "tool.invocation.denied",
    ]);
    expect(
      invocationRecords.filter((record) => record.verb === "tool.invocation.executed"),
    ).toHaveLength(1);
    expect(invocationRecords[1]).toMatchObject({
      trace: { traceId: traceRequest.traceId },
      metadata: {
        pendingActionId: queued.pending.id,
        status: "executed",
      },
    });
    expect(calls).toBe(1);
    expect(executionIdempotencyKey).toBe(`pending-action:${queued.pending.id}`);
    expect(JSON.stringify(invocationRecords)).not.toContain(executionIdempotencyKey);
  });

  it("audits cancellation and fails its success closed during an audit outage", async () => {
    const auditSink = new ToggleAuditSink();
    const confirmationGate = new InMemoryConfirmationGate();
    const registry = createToolRegistry({
      auditSink,
      confirmationGate,
      confirmationDefaults: tierDefaults.business,
    });
    registry.register(
      tool({
        id: "critical.cancel",
        permission: "danger.write",
        sideEffects: "destructive",
        handler: async () => ({ ok: true }),
      }),
    );

    const first = await registry.invoke(
      "critical.cancel",
      {},
      { actor, enforceConfirmation: true },
    );
    if (!first.ok || first.status !== "pending_confirmation") {
      throw new Error("Expected pending confirmation.");
    }
    await expect(
      registry.cancelPending(first.pending.id, { actor, request: traceRequest }),
    ).resolves.toMatchObject({ ok: true, status: "cancelled" });
    expect(auditSink.records.at(-1)).toMatchObject({
      verb: "tool.invocation.cancelled",
      metadata: { pendingActionId: first.pending.id, status: "cancelled" },
    });

    const second = await registry.invoke(
      "critical.cancel",
      {},
      { actor, enforceConfirmation: true },
    );
    if (!second.ok || second.status !== "pending_confirmation") {
      throw new Error("Expected second pending confirmation.");
    }
    auditSink.fail = true;
    await expect(registry.cancelPending(second.pending.id, { actor })).resolves.toMatchObject({
      ok: false,
      statusCode: 503,
    });
  });
});

describe("per-credential policy overrides (PRD §9.2)", () => {
  it.each(["disabled", "scope_revoked"] as const)(
    "fails approved execution closed when the requester is %s",
    async (condition) => {
      const confirmationGate = new InMemoryConfirmationGate();
      const credentialPolicy = {
        ipAllowlist: [],
        allowedHours: null,
        confirmationOverride: "inherit" as const,
        rateLimitOverrides: {},
        automationPolicy: null,
        version: "1",
      };
      const registry = createToolRegistry({
        confirmationGate,
        confirmationDefaults: tierDefaults.personal,
        resolvePendingPrincipal: async (record) =>
          condition === "disabled"
            ? null
            : {
                actor: { ...record.requesterPrincipal, scopes: [] },
                ...(record.requesterCredentialId === null
                  ? {}
                  : { credentialId: record.requesterCredentialId }),
                credentialOwnerActorId: approver.id,
                credentialPolicy,
              },
      });
      let executions = 0;
      registry.register(
        tool({
          id: "fresh.scope.write",
          permission: "danger.write",
          sideEffects: "write",
          handler: async () => {
            executions += 1;
            return { ok: true };
          },
        }),
      );
      const queued = await registry.invoke(
        "fresh.scope.write",
        {},
        {
          actor,
          credentialId: "credential-1",
          credentialOwnerActorId: approver.id,
          credentialPolicy,
        },
      );
      if (!queued.ok || queued.status !== "pending_confirmation") {
        throw new Error("Expected pending confirmation.");
      }

      await expect(
        registry.approvePending(queued.pending.id, { actor: approver }),
      ).resolves.toMatchObject({ ok: false, statusCode: 403 });
      expect(executions).toBe(0);
    },
  );

  it("keeps agent writes confirmation-gated with or without an 'always' override", async () => {
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

    // RD-5 gates every agent write even on a tier whose human-session default
    // would allow this non-destructive mutation.
    await expect(
      registry.invoke("notes.write", {}, { actor, enforceConfirmation: true }),
    ).resolves.toMatchObject({ ok: true, status: "pending_confirmation" });

    // An explicit "always" override remains fail-closed.
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

  it("bypasses confirmation only for an exact, fully bounded automation rule", async () => {
    const registry = createToolRegistry({
      confirmationGate: new InMemoryConfirmationGate(),
      confirmationDefaults: tierDefaults.personal,
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
    });
    let executions = 0;
    registry.register(
      tool({
        id: "chat.send",
        permission: "chat.send",
        sideEffects: "write",
        handler: async () => {
          executions += 1;
          return { ok: true };
        },
      }),
    );
    const credentialPolicy = {
      ipAllowlist: [],
      allowedHours: null,
      confirmationOverride: "inherit" as const,
      rateLimitOverrides: {},
      version: "3",
      automationPolicy: {
        version: "11",
        rules: [
          {
            id: "chat-room-owner",
            toolId: "chat.send",
            action: "chat.send",
            resourceIds: ["room-1"],
            recipients: ["owner@example.test"],
            targets: ["actor-2"],
            activeFrom: "2020-01-01T00:00:00.000Z",
            expiresAt: "2030-01-01T00:00:00.000Z",
            requestsPerMinute: 10,
            requestsPerDay: 100,
          },
        ],
      },
    };
    const exact = {
      roomId: "room-1",
      recipient: "owner@example.test",
      targetActorId: "actor-2",
      body: "hello",
    };

    await expect(
      registry.invoke("chat.send", exact, {
        actor: { ...actor, scopes: ["chat.send"] },
        credentialId: "credential-1",
        credentialOwnerActorId: approver.id,
        credentialPolicy,
        enforceConfirmation: true,
      }),
    ).resolves.toMatchObject({ ok: true, output: { ok: true } });
    await expect(
      registry.invoke(
        "chat.send",
        { ...exact, roomId: "room-2" },
        {
          actor: { ...actor, scopes: ["chat.send"] },
          credentialId: "credential-1",
          credentialOwnerActorId: approver.id,
          credentialPolicy,
          enforceConfirmation: true,
        },
      ),
    ).resolves.toMatchObject({ ok: true, status: "pending_confirmation" });
    expect(executions).toBe(1);
  });

  it("fails closed for an agent mutation when the legacy override is 'never'", async () => {
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
    expect(result).toMatchObject({ ok: true, status: "pending_confirmation" });
    expect(calls).toEqual([]);
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

  it("re-applies the current credential rate policy to approved execution", async () => {
    const confirmationGate = new InMemoryConfirmationGate();
    const credentialPolicy = {
      ipAllowlist: [],
      allowedHours: null,
      confirmationOverride: "always" as const,
      rateLimitOverrides: { requestsPerMinute: 1 },
      automationPolicy: null,
      version: "1",
    };
    const registry = createToolRegistry({
      confirmationGate,
      confirmationDefaults: tierDefaults.personal,
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: {
        requestsPerMinute: 1_000,
        requestsPerDay: 1_000,
        costPerDayUsdMicros: null,
        costWarningThresholdRatio: 0.8,
      },
      resolvePendingPrincipal: async (record) => ({
        actor,
        ...(record.requesterCredentialId === null
          ? {}
          : { credentialId: record.requesterCredentialId }),
        credentialOwnerActorId: approver.id,
        credentialPolicy,
      }),
    });
    let executions = 0;
    registry.register(
      tool({
        id: "pending.policy",
        permission: "platform.read",
        sideEffects: "write",
        handler: async () => {
          executions += 1;
          return { ok: true };
        },
      }),
    );
    const queued = await registry.invoke(
      "pending.policy",
      {},
      {
        actor,
        enforceConfirmation: true,
        credentialId: "credential-1",
        credentialOwnerActorId: approver.id,
        credentialPolicy,
      },
    );
    if (!queued.ok || queued.status !== "pending_confirmation") {
      throw new Error("Expected a pending action.");
    }

    const approved = await registry.approvePending(queued.pending.id, {
      actor: approver,
    });

    expect(approved).toMatchObject({
      ok: false,
      statusCode: 429,
      rateLimit: { reason: "requests_per_minute" },
    });
    expect(executions).toBe(0);
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

  it("provides a content-free dry-run explanation with stable firewall reasons", async () => {
    const registry = createToolRegistry();
    registry.register(
      tool({
        id: "policy.explain-target",
        permission: "platform.read",
        sideEffects: "write",
        handler: async () => ({ ok: true }),
      }),
    );
    const credentialPolicy = {
      version: "7",
      automationPolicy: {
        version: "7",
        rules: [
          {
            id: "room-rule",
            toolId: "policy.explain-target",
            action: "platform.read",
            resourceIds: ["room-1"],
            recipients: [],
            targets: [],
            activeFrom: "2020-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
            requestsPerMinute: 1,
            requestsPerDay: 5,
          },
        ],
      },
    };
    const policyContext = {
      effectiveClassification: "confidential" as const,
      sourceIds: ["mail-1"],
      containsUntrustedContext: true,
      requestChannel: "mcp" as const,
    };

    await expect(
      registry.explainPolicy(
        "policy.explain-target",
        { roomId: "room-1", body: "never echo this content" },
        { actor, credentialId: "credential-1", credentialPolicy, policyContext },
      ),
    ).resolves.toEqual({
      toolId: "policy.explain-target",
      effectiveClassification: "confidential",
      requestChannel: "mcp",
      sourceIds: ["mail-1"],
      decision: { outcome: "allow-automation", reason: "automation_policy_match" },
    });
    await expect(
      registry.explainPolicy(
        "policy.explain-target",
        { roomId: "room-2", body: "never echo this content" },
        { actor, credentialId: "credential-1", credentialPolicy, policyContext },
      ),
    ).resolves.toMatchObject({
      decision: { outcome: "queue-confirmation", reason: "automation_policy_no_match" },
    });
    await expect(
      registry.explainPolicy("unknown.tool", {}, { actor, policyContext }),
    ).resolves.toMatchObject({
      decision: { outcome: "deny", reason: "unknown_tool" },
    });
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

class FailingAuditSink {
  async append(_record: AuditRecord & { readonly orgId: string }): Promise<void> {
    throw new Error("audit store unavailable");
  }
}

class ToggleAuditSink extends MemoryAuditSink {
  fail = false;

  override async append(record: AuditRecord & { readonly orgId: string }): Promise<void> {
    if (this.fail) {
      throw new Error("audit store unavailable");
    }
    await super.append(record);
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
