import type { Actor, AuditRecord, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentRateCostLimiter } from "../platform/limits/index.js";
import { toolInvocationOptions } from "../platform/auth/tool-invocation-principal.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import {
  InMemoryConfirmationGate,
  InMemoryPendingActionStore,
} from "../platform/tools/registry.js";
import type { AgentSourceStore } from "../platform/tools/agent-sources.js";
import { handleMcpJsonRpcRequest } from "./mcp.js";

const actor: Actor = {
  id: "agent",
  orgId: "org",
  type: "agent",
  scopes: ["mail.read", "mail.send"],
};
const principal = { actor, credentialId: "credential", credentialOwnerActorId: "owner" };
const schema = { parse: (value: unknown) => value, toJsonSchema: () => ({ type: "object" }) };
const readTool: ToolDefinition = {
  id: "mail.fixture.read",
  description: "Fixture",
  permission: "mail.read",
  sideEffects: "read",
  inputSchema: schema,
  outputSchema: schema,
  handler: async () => ({ ok: true }),
};
const resourceRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "resources/read",
  params: { uri: "helix://mail/thread/thread-1" },
};
const resources = () => ({
  list: async () => [],
  read: vi.fn(async (_actor: Actor, _uri: string) => ({
    uri: resourceRequest.params.uri,
    text: "Untrusted external message",
    mimeType: "text/plain",
  })),
});

describe("MCP resource policy", () => {
  it("uses the same request budget as tools and audits the credential without reading on denial", async () => {
    const audit: AuditRecord[] = [];
    const tools = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitBudget: { requestsPerMinute: 1 },
      auditSink: {
        append: async (record) => {
          audit.push(record);
        },
      },
    });
    tools.register(readTool);
    const provider = resources();
    const first = await tools.invoke(readTool.id, {}, toolInvocationOptions(principal));
    expect(first.ok).toBe(true);
    const denied = await handleMcpJsonRpcRequest({
      tools,
      principal,
      resources: provider,
      body: resourceRequest,
    });
    expect(denied).toMatchObject({ error: { code: -32029 } });
    expect(provider.read).not.toHaveBeenCalled();
    expect(audit.at(-1)).toMatchObject({
      verb: "tool.invocation.denied",
      metadata: { toolId: "mail.resource.read", credentialId: "credential", requestChannel: "mcp" },
    });
    expect(tools.list().map((tool) => tool.id)).toEqual([
      readTool.id,
      "platform.identity",
      "platform.ping",
    ]);
  });

  it("counts a successful resource once and blocks a later tool call", async () => {
    const tools = createToolRegistry({
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitBudget: { requestsPerMinute: 1 },
    });
    tools.register(readTool);
    const provider = resources();
    const first = await handleMcpJsonRpcRequest({
      tools,
      principal,
      resources: provider,
      body: resourceRequest,
    });
    expect(first).toMatchObject({ result: { contents: [{ text: "Untrusted external message" }] } });
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(await tools.invoke(readTool.id, {}, toolInvocationOptions(principal))).toMatchObject({
      ok: false,
      statusCode: 429,
    });
  });

  it("enforces feature/read scope before the provider and keeps writes available only through review", async () => {
    const provider = resources();
    const tools = createToolRegistry();
    expect(
      await handleMcpJsonRpcRequest({
        tools,
        principal: { actor: { ...actor, scopes: [] } },
        resources: provider,
        body: resourceRequest,
      }),
    ).toMatchObject({ error: { code: -32003 } });
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("applies resource labels and scans resource output before it reaches the agent", async () => {
    const provider = resources();
    const evaluations: unknown[] = [];
    const tools = createToolRegistry({
      dlp: {
        evaluate: async (input) => {
          evaluations.push(input);
          return {
            action:
              typeof input.content === "object" && input.content !== null && "text" in input.content
                ? "block"
                : "allow",
            boundary: "api_agent",
            classification: "restricted",
            findings: [],
            acknowledged: false,
          };
        },
      },
    });
    const result = await handleMcpJsonRpcRequest({
      tools,
      principal,
      resources: provider,
      body: resourceRequest,
    });
    expect(result).toMatchObject({ error: { code: -32003 } });
    expect(JSON.stringify(result)).not.toContain("Untrusted external message");
    expect(evaluations).toHaveLength(2);
    expect(evaluations[0]).toMatchObject({
      resources: [{ resourceType: "mail.thread", resourceId: "thread-1" }],
    });
  });

  it("binds a resource warning approval to its requester, URI and credential policy", async () => {
    let blocked = false;
    const provider = resources();
    const tools = createToolRegistry({
      resourceReader: async (actor, uri) => provider.read(actor, uri),
      confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
      resolvePendingPrincipal: async () => principal,
      dlp: {
        evaluate: async (input) => ({
          action: blocked
            ? "block"
            : typeof input.content === "object" &&
                input.content !== null &&
                "text" in input.content &&
                !input.acknowledged
              ? "warn"
              : "allow",
          boundary: "api_agent",
          classification: "confidential",
          findings: [],
          acknowledged: input.acknowledged ?? false,
        }),
      },
    });
    const pending = await handleMcpJsonRpcRequest({
      tools,
      principal,
      resources: provider,
      body: resourceRequest,
    });
    const pendingId = (pending as { error: { data: { pending: { id: string } } } }).error.data
      .pending.id;
    expect(
      await tools.approvePending(pendingId, { actor: { ...actor, id: "owner", type: "user" } }),
    ).toMatchObject({ ok: true });
    const request = {
      ...resourceRequest,
      params: { ...resourceRequest.params, approvalId: pendingId },
    };
    expect(
      await handleMcpJsonRpcRequest({ tools, principal, resources: provider, body: request }),
    ).toMatchObject({ result: { contents: [{ text: "Untrusted external message" }] } });
    for (const changed of [
      { ...principal, credentialId: "another" },
      {
        ...principal,
        credentialPolicy: {
          version: "changed",
          ipAllowlist: [],
          allowedHours: null,
          confirmationOverride: "inherit" as const,
          rateLimitOverrides: {},
          automationPolicy: null,
        },
      },
    ])
      expect(
        await handleMcpJsonRpcRequest({
          tools,
          principal: changed,
          resources: provider,
          body: request,
        }),
      ).toMatchObject({ error: { code: -32003 } });
    expect(
      await handleMcpJsonRpcRequest({
        tools,
        principal,
        resources: provider,
        body: { ...request, params: { ...request.params, uri: "helix://mail/thread/another" } },
      }),
    ).toMatchObject({ error: { code: -32003 } });
    blocked = true;
    expect(
      await handleMcpJsonRpcRequest({ tools, principal, resources: provider, body: request }),
    ).toMatchObject({ error: { code: -32003 } });
  });

  it("rejects forged resource identifiers before provider or label evaluation", async () => {
    const reader = vi.fn(async () => ({ text: "secret" }));
    const tools = createToolRegistry({ resourceReader: reader });
    expect(
      await tools.invoke(
        "mail.resource.read",
        { uri: "helix://drive/file/file-1", resourceId: "thread-1" },
        toolInvocationOptions(principal),
      ),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(["rest", "mcp"] as const)(
    "retains read sources across registries and queues sensitive %s automation",
    async (channel) => {
      const stored = new Map<string, readonly string[]>();
      const sourceStore: AgentSourceStore = {
        get: async (org, actorId) => stored.get(`${org}:${actorId}`) ?? [],
        record: async (org, actorId, sources) => {
          stored.set(`${org}:${actorId}`, [...sources]);
        },
      };
      const first = createToolRegistry({ agentSources: sourceStore });
      expect(
        await handleMcpJsonRpcRequest({
          tools: first,
          principal,
          resources: resources(),
          body: resourceRequest,
        }),
      ).toHaveProperty("result");
      const audit: AuditRecord[] = [];
      const handler = vi.fn(async () => ({ sent: true }));
      const second = createToolRegistry({
        agentSources: sourceStore,
        confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
        auditSink: {
          append: async (record) => {
            audit.push(record);
          },
        },
      });
      second.register({
        ...readTool,
        id: "mail.fixture.send",
        permission: "mail.send",
        sideEffects: "external_communication",
        handler,
        standingAuthorization: async () => ({
          id: "bounded",
          version: "1",
          requestsPerMinute: 30,
          requestsPerDay: 1000,
        }),
      });
      const result =
        channel === "rest"
          ? await second.invoke(
              "mail.fixture.send",
              {},
              {
                ...toolInvocationOptions(principal),
                policyContext: {
                  effectiveClassification: "standard",
                  sourceIds: ["forged"],
                  containsUntrustedContext: false,
                  requestChannel: channel,
                },
              },
            )
          : await handleMcpJsonRpcRequest({
              tools: second,
              principal,
              body: {
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "mail.fixture.send", arguments: {} },
              },
            });
      if (channel === "rest")
        expect(result).toMatchObject({ ok: true, status: "pending_confirmation" });
      else
        expect(result).toMatchObject({
          result: { structuredContent: { status: "pending_confirmation" } },
        });
      expect(handler).not.toHaveBeenCalled();
      expect(audit.at(-1)?.metadata).toMatchObject({
        containsUntrustedContext: true,
        sourceIds: expect.arrayContaining(["thread-1", "tool:mail.resource.read"]),
      });
      expect(JSON.stringify(audit.at(-1))).not.toContain("forged");
    },
  );
});
