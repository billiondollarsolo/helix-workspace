import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { createActionTools } from "../platform/tools/actions-tools.js";
import {
  InMemoryConfirmationGate,
  InMemoryPendingActionStore,
} from "../platform/tools/registry.js";
import { zodToolSchema } from "../platform/webhooks/tool-schemas.js";
import { systemActor } from "./actor.js";
import { NotFoundError, RateLimitedError } from "./api-error.js";
import { handleMcpJsonRpcRequest } from "./mcp.js";

const agentActor: Actor = {
  id: "agent-mcp",
  orgId: "org-mcp",
  type: "agent",
  scopes: ["platform.read", "mail.read", "mail.write"],
};
const ownerActor: Actor = {
  id: "user-owner",
  orgId: "org-mcp",
  type: "user",
  scopes: ["platform.read"],
};
const otherUser: Actor = { ...ownerActor, id: "user-other" };
const agentPrincipal = {
  actor: agentActor,
  credentialId: "cred-1",
  credentialOwnerActorId: ownerActor.id,
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

function registryWithGate() {
  const tools = createToolRegistry({
    accessPolicy: new AllowAllToolAccessPolicy(),
    confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
  });
  let calls = 0;
  tools.register(
    tool({
      id: "mail.mutate",
      permission: "mail.write",
      sideEffects: "write",
      handler: async () => {
        calls += 1;
        return { call: calls };
      },
    }),
  );
  for (const action of createActionTools(tools)) tools.register(action);
  return { tools, calls: () => calls };
}

function call(id: string | number, name: string, args: unknown, meta?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
  };
}

function resultOf(response: unknown): Record<string, unknown> {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    throw new Error(`Expected a JSON-RPC result: ${JSON.stringify(response)}`);
  }
  return (response as { readonly result: Record<string, unknown> }).result;
}

function structured(response: unknown): Record<string, unknown> {
  return resultOf(response).structuredContent as Record<string, unknown>;
}

describe("MCP tools/call idempotency (MC2)", () => {
  it("accepts agent mutations without a key and dedupes retries of the same request id", async () => {
    const { tools, calls } = registryWithGate();
    const first = await handleMcpJsonRpcRequest({
      tools,
      principal: agentPrincipal,
      body: call(7, "mail.mutate", { value: 1, nested: { b: 2, a: 1 } }),
    });
    const retry = await handleMcpJsonRpcRequest({
      tools,
      principal: agentPrincipal,
      body: call(7, "mail.mutate", { nested: { a: 1, b: 2 }, value: 1 }),
    });
    const next = await handleMcpJsonRpcRequest({
      tools,
      principal: agentPrincipal,
      body: call(8, "mail.mutate", { value: 1, nested: { b: 2, a: 1 } }),
    });

    expect(structured(first)).toMatchObject({ status: "pending_confirmation" });
    const firstPending = structured(first).pending as { readonly id: string };
    expect((structured(retry).pending as { readonly id: string }).id).toBe(firstPending.id);
    expect((structured(next).pending as { readonly id: string }).id).not.toBe(firstPending.id);
    expect(calls()).toBe(0);
  });

  it("scopes derived keys to the MCP session", async () => {
    const { tools } = registryWithGate();
    const inSession = async (sessionId: string) =>
      structured(
        await handleMcpJsonRpcRequest({
          tools,
          principal: agentPrincipal,
          sessionId,
          body: call(1, "mail.mutate", { value: 1 }),
        }),
      ).pending as { readonly id: string };
    expect((await inSession("session-a")).id).not.toBe((await inSession("session-b")).id);
  });
});

describe("MCP pending actions (MC3)", () => {
  it("returns approval and status links, expiry, and polling instructions", async () => {
    const { tools } = registryWithGate();
    const response = await handleMcpJsonRpcRequest({
      tools,
      principal: agentPrincipal,
      publicBaseUrl: "https://helix.example.com/",
      body: call("pending", "mail.mutate", { value: 1 }),
    });
    const content = structured(response);
    const pending = content.pending as { readonly id: string; readonly expiresAt: string };
    expect(content).toMatchObject({
      status: "pending_confirmation",
      approvalUrl: `https://helix.example.com/v1/api/tools/pending/${pending.id}/approve`,
      statusUrl: `https://helix.example.com/v1/actions/${pending.id}`,
      expiresAt: pending.expiresAt,
      pollTool: "actions.get",
      pending: { approvalUrl: expect.stringContaining(pending.id) },
    });
    const text = (resultOf(response).content as readonly { readonly text: string }[])[0]?.text;
    expect(text).toContain("Ask the user to approve");
    expect(text).toContain(`actions.get tool with {"id":"${pending.id}"}`);
    expect(text).toContain(pending.expiresAt);
  });

  it("lets only the requester or the approval owner read a pending action via actions.get", async () => {
    const { tools } = registryWithGate();
    const queued = await handleMcpJsonRpcRequest({
      tools,
      principal: agentPrincipal,
      body: call("queue", "mail.mutate", { value: 1 }),
    });
    const pendingId = (structured(queued).pending as { readonly id: string }).id;
    const read = (actor: Actor) =>
      handleMcpJsonRpcRequest({
        tools,
        principal: { actor },
        body: call("get", "actions.get", { id: pendingId }),
      });

    expect(structured(await read(agentActor))).toMatchObject({
      action: { id: pendingId, status: "pending_confirmation" },
    });
    expect(structured(await read(ownerActor))).toMatchObject({ action: { id: pendingId } });
    for (const outsider of [
      otherUser,
      { ...agentActor, id: "agent-other" },
      { ...ownerActor, orgId: "org-other" },
    ]) {
      const denied = await read(outsider);
      expect(resultOf(denied)).toMatchObject({
        isError: true,
        structuredContent: { code: "not_found" },
      });
      expect(JSON.stringify(denied)).not.toContain('"status":"pending_confirmation"');
    }
  });
});

describe("MCP tool failures (MC7)", () => {
  it("returns validation failures as isError results naming the field", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register(
      tool({
        id: "strict.read",
        permission: "platform.read",
        inputSchema: zodToolSchema(z.object({ to: z.string().email() }), {
          type: "object",
          additionalProperties: true,
        }),
        handler: async () => ({ ok: true }),
      }),
    );
    const response = await handleMcpJsonRpcRequest({
      tools,
      principal: { actor: systemActor },
      body: call("bad", "strict.read", { to: "nope" }),
    });
    expect(resultOf(response)).toMatchObject({
      isError: true,
      structuredContent: { code: "bad_request", field: "to", hint: expect.any(String) },
    });
    expect((resultOf(response).content as readonly { readonly text: string }[])[0]?.text).toContain(
      "to: Invalid email",
    );
  });

  it("maps 403, 404, and 429 failures to isError results and keeps retryAfterSeconds", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register(
      tool({
        id: "missing.read",
        permission: "platform.read",
        handler: async () => {
          throw new NotFoundError("Thread was not found.");
        },
      }),
    );
    tools.register(
      tool({
        id: "busy.read",
        permission: "platform.read",
        handler: async () => {
          throw new RateLimitedError("Slow down.", { retryAfterSeconds: 42 });
        },
      }),
    );
    tools.register(
      tool({ id: "admin.read", permission: "admin.agents", handler: async () => ({}) }),
    );
    const scoped = createToolRegistry();
    scoped.register(
      tool({ id: "admin.read", permission: "admin.agents", handler: async () => ({}) }),
    );

    const missing = await handleMcpJsonRpcRequest({
      tools,
      principal: { actor: systemActor },
      body: call(1, "missing.read", {}),
    });
    expect(missing).not.toHaveProperty("error");
    expect(resultOf(missing)).toMatchObject({
      isError: true,
      structuredContent: { code: "not_found", message: "Thread was not found." },
    });

    const busy = await handleMcpJsonRpcRequest({
      tools,
      principal: { actor: systemActor },
      body: call(2, "busy.read", {}),
    });
    expect(resultOf(busy)).toMatchObject({
      isError: true,
      structuredContent: { code: "rate_limited", retryAfterSeconds: 42 },
    });

    const forbidden = await handleMcpJsonRpcRequest({
      tools: scoped,
      principal: { actor: agentActor },
      body: call(3, "admin.read", {}),
    });
    expect(resultOf(forbidden)).toMatchObject({
      isError: true,
      structuredContent: { code: "forbidden" },
    });
  });

  it("keeps protocol errors for unknown tools and malformed params", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    await expect(
      handleMcpJsonRpcRequest({
        tools,
        principal: { actor: systemActor },
        body: call(1, "does.not.exist", {}),
      }),
    ).resolves.toMatchObject({ error: { code: -32602, message: "Unknown tool: does.not.exist" } });
    await expect(
      handleMcpJsonRpcRequest({
        tools,
        principal: { actor: systemActor },
        body: call(2, "platform.ping", ["not", "an", "object"]),
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
  });
});

describe("MCP tool annotations (MC8)", () => {
  it("publishes standard hints, keeps Helix fields in _meta, and flags approval", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register(
      tool({
        id: "mail.send",
        permission: "mail.send",
        sideEffects: "external_communication",
        confirmationRequired: true,
        handler: async () => ({}),
      }),
    );
    tools.register(
      tool({
        id: "drive.delete",
        permission: "drive.delete",
        sideEffects: "destructive",
        handler: async () => ({}),
      }),
    );
    tools.register(
      tool({
        id: "mail.label.apply",
        permission: "mail.write",
        sideEffects: "write",
        handler: async () => ({}),
      }),
    );
    const response = await handleMcpJsonRpcRequest({
      tools,
      principal: { actor: agentActor },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    const listed = (resultOf(response).tools as readonly Record<string, unknown>[]).reduce<
      Record<string, Record<string, unknown>>
    >((byName, entry) => ({ ...byName, [String(entry.name)]: entry }), {});

    expect(listed["mail.send"]).toMatchObject({
      title: "Mail send",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { "helix/permission": "mail.send", "helix/confirmationRequired": true },
    });
    expect(String(listed["mail.send"]?.description)).toContain("Requires human approval");
    expect(listed["drive.delete"]).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    });
    expect(String(listed["mail.label.apply"]?.description)).toContain("human approval");
    expect(listed["platform.ping"]).toMatchObject({
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
    });
    expect(listed["platform.ping"]?.description).toBe("Platform health check tool.");
    expect(listed["mail.send"]?.inputSchema).toMatchObject({ type: "object" });
  });
});

describe("MCP prompts and client idempotency keys", () => {
  it("lists curated prompts only when their tools are visible, not one per tool", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const listPrompts = async () => {
      const response = await handleMcpJsonRpcRequest({
        tools,
        principal: { actor: systemActor },
        body: { jsonrpc: "2.0", id: "prompts", method: "prompts/list" },
      });
      if (!("result" in response)) throw new Error("Expected prompts/list result.");
      return (response.result as { readonly prompts: readonly { readonly name: string }[] })
        .prompts;
    };
    expect(await listPrompts()).toEqual([]);

    tools.register(
      tool({ id: "mail.thread.get", permission: "mail.read", handler: async () => ({}) }),
    );
    tools.register(
      tool({ id: "mail.threads.list", permission: "mail.read", handler: async () => ({}) }),
    );
    expect((await listPrompts()).map((prompt) => prompt.name)).toEqual([
      "triage-inbox",
      "summarize-thread",
    ]);

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        principal: { actor: systemActor },
        body: {
          jsonrpc: "2.0",
          id: "missing-arg",
          method: "prompts/get",
          params: { name: "summarize-thread" },
        },
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });

    const getResponse = await handleMcpJsonRpcRequest({
      tools,
      principal: { actor: systemActor },
      body: {
        jsonrpc: "2.0",
        id: "prompt-get",
        method: "prompts/get",
        params: { name: "summarize-thread", arguments: { threadId: "thread-1" } },
      },
    });
    if (!("result" in getResponse)) {
      throw new Error("Expected prompts/get result.");
    }
    const result = getResponse.result as {
      readonly messages: readonly { readonly content: { readonly text: string } }[];
    };
    expect(result.messages[0]?.content.text).toContain(
      'mail.thread.get with {"threadId":"thread-1"}',
    );
  });

  it("replays client idempotency keys and rejects reuse with different arguments", async () => {
    const tools = createToolRegistry({
      accessPolicy: new AllowAllToolAccessPolicy(),
      confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
    });
    let calls = 0;
    tools.register(
      tool({
        id: "mail.mutate",
        permission: "mail.write",
        sideEffects: "write",
        handler: async () => {
          calls += 1;
          return { call: calls };
        },
      }),
    );
    const principal = {
      actor: { ...agentActor, scopes: [...(agentActor.scopes ?? []), "mail.write"] },
    };
    const body = {
      jsonrpc: "2.0",
      id: "mutate",
      method: "tools/call",
      params: {
        name: "mail.mutate",
        arguments: { value: 1 },
        _meta: { idempotencyKey: "mutation-0001" },
      },
    };

    const [first, duplicate] = await Promise.all([
      handleMcpJsonRpcRequest({ tools, principal, body }),
      handleMcpJsonRpcRequest({ tools, principal, body }),
    ]);
    expect(first).toMatchObject({
      result: {
        structuredContent: {
          status: "pending_confirmation",
          pending: { status: "pending_confirmation" },
        },
      },
    });
    expect(duplicate).toEqual(first);
    expect(calls).toBe(0);

    await expect(
      handleMcpJsonRpcRequest({
        tools,
        principal,
        body: {
          ...body,
          params: {
            name: "mail.mutate",
            arguments: { value: 2 },
            _meta: { idempotencyKey: "mutation-0001" },
          },
        },
      }),
    ).resolves.toMatchObject({
      result: { isError: true, structuredContent: { code: "conflict" } },
    });
    await expect(
      handleMcpJsonRpcRequest({
        tools,
        principal,
        body: { ...body, params: { ...body.params, _meta: { idempotencyKey: "short" } } },
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
    expect(calls).toBe(0);
  });
});
