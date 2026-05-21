import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { systemActor } from "./actor.js";
import {
  createSearchMcpResourceProvider,
  formatSseEvent,
  handleMcpJsonRpcRequest,
  handleMcpStreamingRequest,
  type McpStreamEvent,
} from "./mcp.js";
import { HELIX_SERVER_VERSION, MCP_PROTOCOL_VERSION } from "./version.js";
import { InMemoryAgentRateCostLimiter, type AgentLimitBudget } from "../platform/limits/index.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import type {
  IndexDocument,
  SearchEngine,
  SearchRequest,
  SearchResponse,
} from "../platform/search/types.js";

describe("handleMcpJsonRpcRequest", () => {
  it("lists visible tools using MCP tool shape", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        actor: systemActor,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "platform.ping",
            annotations: {
              permission: "platform.read",
              sideEffects: "read",
              confirmationRequired: false,
            },
          },
        ],
      },
    });
  });

  it("advertises tools and resources capabilities during initialize", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        actor: systemActor,
        body: { jsonrpc: "2.0", id: "init", method: "initialize" },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "init",
      result: {
        capabilities: {
          tools: {},
          resources: {},
        },
      },
    });
  });

  it("calls registered tools and returns structured content", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const response = await handleMcpJsonRpcRequest({
      tools,
      actor: systemActor,
      body: {
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: { name: "platform.ping", arguments: {} },
      },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "call-1",
      result: {
        structuredContent: {
          ok: true,
          service: "helix-app",
        },
      },
    });
  });

  it("includes tool cost annotations in tools/list", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register(
      tool({
        id: "limited.cost-annotated",
        permission: "platform.read",
        estimatedCostUsdMicros: 1_250,
        handler: async () => ({ ok: true }),
      }),
    );

    const response = await handleMcpJsonRpcRequest({
      tools,
      actor: systemActor,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });

    if (!("result" in response)) {
      throw new Error("Expected tools/list result.");
    }
    const result = response.result as {
      readonly tools: readonly {
        readonly name: string;
        readonly annotations: Record<string, unknown>;
      }[];
    };
    const listedTool = result.tools.find((listed) => listed.name === "limited.cost-annotated");
    expect(listedTool).toMatchObject({
      name: "limited.cost-annotated",
      annotations: {
        permission: "platform.read",
        sideEffects: "read",
        confirmationRequired: false,
        estimatedCostUsdMicros: 1_250,
      },
    });
  });

  it("returns JSON-RPC -32029 for repeated limited agent tools/call without executing handler", async () => {
    const tools = createToolRegistry({
      accessPolicy: new AllowAllToolAccessPolicy(),
      agentRateCostLimiter: new InMemoryAgentRateCostLimiter(),
      agentLimitTier: "business",
      agentLimitBudget: requestLimitBudget,
    });
    let calls = 0;
    tools.register(
      tool({
        id: "limited.mcp",
        permission: "platform.read",
        handler: async () => {
          calls += 1;
          return { ok: true };
        },
      }),
    );

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        actor: agentActor,
        body: {
          jsonrpc: "2.0",
          id: "first",
          method: "tools/call",
          params: { name: "limited.mcp", arguments: {} },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "first",
      result: {
        structuredContent: { ok: true },
      },
    });

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        actor: agentActor,
        body: {
          jsonrpc: "2.0",
          id: "blocked",
          method: "tools/call",
          params: { name: "limited.mcp", arguments: { secret: "not-executed" } },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "blocked",
      error: {
        code: -32029,
        message: "Agent tool invocation limit exceeded: requests_per_minute",
      },
    });
    expect(calls).toBe(1);
  });

  it("lists and reads actor-scoped MCP resources from search", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const engine = new FakeSearchEngine([
      {
        id: "mail:1",
        type: "mail",
        title: "Launch mail",
        body: "Schedule moved to Friday.",
        url: "/mail/thread-1?message=mail:1",
        attributes: { orgId: "org-mcp" },
        updatedAt: "2026-05-20T12:00:00.000Z",
      },
      {
        id: "drive:1",
        type: "drive",
        title: "Launch deck",
        body: "Slides for the launch review.",
        url: "/drive/drive:1",
        attributes: { orgId: "org-mcp" },
      },
      {
        id: "chat:1",
        type: "chat",
        title: "Hidden chat",
        attributes: { orgId: "org-mcp" },
      },
    ]);
    const resources = createSearchMcpResourceProvider(engine);

    const listResponse = await handleMcpJsonRpcRequest({
      tools,
      actor: agentActor,
      resources,
      body: { jsonrpc: "2.0", id: "resources", method: "resources/list" },
    });

    expect(listResponse).toMatchObject({
      jsonrpc: "2.0",
      id: "resources",
      result: {
        resources: [
          {
            uri: "helix://resources/mail/mail%3A1",
            name: "Launch mail",
            mimeType: "text/markdown",
          },
        ],
      },
    });
    expect(engine.searches[0]).toMatchObject({
      query: "",
      types: ["mail"],
      filter: 'attributes.orgId = "org-mcp"',
      limit: 25,
    });

    const readResponse = await handleMcpJsonRpcRequest({
      tools,
      actor: agentActor,
      resources,
      body: {
        jsonrpc: "2.0",
        id: "read",
        method: "resources/read",
        params: { uri: "helix://resources/mail/mail%3A1" },
      },
    });

    if (!("result" in readResponse)) {
      throw new Error("Expected resources/read result.");
    }
    const readResult = readResponse.result as {
      readonly contents: readonly {
        readonly uri: string;
        readonly mimeType: string;
        readonly text: string;
      }[];
    };
    expect(readResult.contents[0]).toMatchObject({
      uri: "helix://resources/mail/mail%3A1",
      mimeType: "text/markdown",
    });
    expect(readResult.contents[0]?.text).toContain("Schedule moved to Friday.");
    expect(engine.searches[1]).toMatchObject({
      query: "",
      types: ["mail"],
      filter: ['attributes.orgId = "org-mcp"', 'id = "mail:1"'],
      limit: 1,
    });
  });

  it("reports the current protocol version and a real server version on initialize", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const response = await handleMcpJsonRpcRequest({
      tools,
      actor: systemActor,
      body: { jsonrpc: "2.0", id: "init", method: "initialize" },
    });

    expect(response).toMatchObject({
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "helix", version: HELIX_SERVER_VERSION },
        capabilities: { prompts: { listChanged: false } },
      },
    });
    expect(MCP_PROTOCOL_VERSION).not.toBe("2024-11-05");
    expect(HELIX_SERVER_VERSION).not.toBe("0.0.0");
  });

  it("lists and gets tool-derived prompts via prompts/list and prompts/get", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const listResponse = await handleMcpJsonRpcRequest({
      tools,
      actor: systemActor,
      body: { jsonrpc: "2.0", id: "prompts", method: "prompts/list" },
    });
    expect(listResponse).toMatchObject({
      result: {
        prompts: [{ name: "tool:platform.ping" }],
      },
    });

    const getResponse = await handleMcpJsonRpcRequest({
      tools,
      actor: systemActor,
      body: {
        jsonrpc: "2.0",
        id: "prompt-get",
        method: "prompts/get",
        params: { name: "tool:platform.ping", arguments: { input: {} } },
      },
    });
    if (!("result" in getResponse)) {
      throw new Error("Expected prompts/get result.");
    }
    const result = getResponse.result as { readonly messages: readonly unknown[] };
    expect(result.messages.length).toBeGreaterThan(0);
  });

  it("returns an MCP error for an unknown prompt", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    await expect(
      handleMcpJsonRpcRequest({
        tools,
        actor: systemActor,
        body: {
          jsonrpc: "2.0",
          id: "missing-prompt",
          method: "prompts/get",
          params: { name: "tool:does.not.exist" },
        },
      }),
    ).resolves.toMatchObject({
      error: { code: -32004 },
    });
  });

  it("streams a progress event then a terminal message event for tools/call", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const events: McpStreamEvent[] = [];
    for await (const event of handleMcpStreamingRequest({
      tools,
      actor: systemActor,
      body: {
        jsonrpc: "2.0",
        id: "stream-call",
        method: "tools/call",
        params: { name: "platform.ping", arguments: {} },
      },
    })) {
      events.push(event);
    }

    expect(events.map((event) => event.event)).toEqual(["progress", "message"]);
    const messageEvent = events[1];
    if (messageEvent === undefined) {
      throw new Error("Expected a terminal message event.");
    }
    expect(formatSseEvent(messageEvent)).toContain("event: message");
    expect(formatSseEvent(messageEvent)).toContain('"id":"stream-call"');
  });

  it("streams a single message event for non-tool methods", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const events: McpStreamEvent[] = [];
    for await (const event of handleMcpStreamingRequest({
      tools,
      actor: systemActor,
      body: { jsonrpc: "2.0", id: "stream-list", method: "tools/list" },
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.event)).toEqual(["message"]);
  });

  it("returns MCP errors for malformed and unknown resource reads", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const resources = createSearchMcpResourceProvider(new FakeSearchEngine([]));

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        actor: agentActor,
        resources,
        body: { jsonrpc: "2.0", id: "bad", method: "resources/read", params: {} },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "bad",
      error: {
        code: -32602,
        message: "resources/read requires params.uri.",
      },
    });

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        actor: agentActor,
        resources,
        body: {
          jsonrpc: "2.0",
          id: "missing",
          method: "resources/read",
          params: { uri: "helix://resources/mail/missing" },
        },
      }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: "missing",
      error: {
        code: -32004,
        message: "Resource not found: helix://resources/mail/missing",
      },
    });
  });
});

const requestLimitBudget: AgentLimitBudget = {
  requestsPerMinute: 1,
  requestsPerDay: 10,
  costPerDayUsdMicros: null,
  costWarningThresholdRatio: 0.8,
};

const agentActor: Actor = {
  id: "agent-mcp",
  orgId: "org-mcp",
  type: "agent",
  scopes: ["platform.read", "mail.read"],
};

class FakeSearchEngine implements SearchEngine {
  readonly id = "fake-search";
  readonly searches: SearchRequest[] = [];

  constructor(private readonly documents: readonly IndexDocument[]) {}

  async index(): Promise<void> {}

  async upsert(): Promise<void> {}

  async delete(): Promise<void> {}

  async search(request: SearchRequest): Promise<SearchResponse> {
    this.searches.push(request);
    const hits = this.documents.filter((document) => matchesRequest(document, request));
    return { hits, query: request.query, estimatedTotalHits: hits.length };
  }
}

function matchesRequest(document: IndexDocument, request: SearchRequest): boolean {
  return (
    matchesTypes(document, request.types) &&
    matchesFilter(document, request.filter) &&
    matchesQuery(document, request.query)
  );
}

function matchesTypes(document: IndexDocument, types: readonly string[] | undefined): boolean {
  return types === undefined || types.includes(document.type);
}

function matchesQuery(document: IndexDocument, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return `${document.title ?? ""} ${document.body ?? ""}`.toLowerCase().includes(normalized);
}

function matchesFilter(
  document: IndexDocument,
  filter: string | readonly string[] | undefined,
): boolean {
  if (filter === undefined) {
    return true;
  }
  const filters = typeof filter === "string" ? [filter] : filter;
  return filters.every((entry) => {
    if (entry.startsWith("attributes.orgId = ")) {
      return document.attributes?.orgId === JSON.parse(entry.slice("attributes.orgId = ".length));
    }
    if (entry.startsWith("id = ")) {
      return document.id === JSON.parse(entry.slice("id = ".length));
    }
    return true;
  });
}

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

describe("MCP method span coverage (P2-6)", () => {
  it("emits an mcp.<method> span for each JSON-RPC request", async () => {
    const { installSpanCapture } = await import(
      "../platform/observability/span-testing.js"
    );
    const harness = installSpanCapture();
    try {
      const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
      await handleMcpJsonRpcRequest({
        tools,
        actor: systemActor,
        body: { jsonrpc: "2.0", id: 7, method: "tools/list" },
      });
      const span = harness
        .spans()
        .find((candidate) => candidate.name === "mcp.tools/list");
      expect(span).toBeDefined();
      expect(span?.attributes["helix.mcp.method"]).toBe("tools/list");
    } finally {
      await harness.dispose();
    }
  });

  it("marks the span as errored for an unsupported method", async () => {
    const { installSpanCapture } = await import(
      "../platform/observability/span-testing.js"
    );
    const harness = installSpanCapture();
    try {
      const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
      await handleMcpJsonRpcRequest({
        tools,
        actor: systemActor,
        body: { jsonrpc: "2.0", id: 8, method: "does/not-exist" },
      });
      const span = harness
        .spans()
        .find((candidate) => candidate.name === "mcp.does/not-exist");
      expect(span?.status.code).toBe(2 /* SpanStatusCode.ERROR */);
    } finally {
      await harness.dispose();
    }
  });
});
