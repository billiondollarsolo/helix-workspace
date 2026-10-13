import type { Actor, ToolContext } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { tierDefaults } from "../config/tier.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemoryConfirmationGate, InMemoryPendingActionStore } from "../tools/registry.js";
import type { OpenedAgentSecret } from "./store.js";
import { createAgentSecretTools, type AgentSecretToolOptions } from "./tools.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const agent: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId,
  type: "agent",
  scopes: ["secrets.use"],
};
const person: Actor = { ...agent, type: "user" };
const handover: OpenedAgentSecret = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "portal-password",
  description: "Supplier portal",
  mode: "handover",
  allowedHosts: [],
  headerName: "authorization",
  headerPrefix: "Bearer ",
  version: 3,
  value: "hunter2",
};
const useOnly: OpenedAgentSecret = {
  ...handover,
  id: "44444444-4444-4444-8444-444444444444",
  name: "billing-api",
  mode: "use_only",
  allowedHosts: ["api.example.com"],
  value: "tok_live_abc123",
};

function setup(actor: Actor = agent, unattended = true) {
  /** What happened, in order: audit records and uses counted. */
  const events: string[] = [];
  const store: AgentSecretToolOptions["store"] = {
    listGranted: async () => [handover, useOnly],
    open: async ({ name }) => [handover, useOnly].find((secret) => secret.name === name) ?? null,
    recordUse: async ({ secretId }) => {
      events.push(`used:${secretId}`);
    },
  };
  const context: ToolContext = {
    actor,
    can: async () => true,
    requirePermission: async () => {},
    audit: async (verb, metadata) => {
      events.push(`${verb}:${JSON.stringify(metadata)}`);
    },
  };
  const tools = createAgentSecretTools({
    store,
    requestsRunUnattended: async () => unattended,
    outbound: {
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => new Response("ok", { headers: { "content-type": "text/plain" } }),
    },
  });
  const call = (id: string, input: Record<string, unknown>) => {
    const tool = tools.find((candidate) => candidate.id === id);
    if (tool === undefined) throw new Error(`Expected the ${id} tool.`);
    return tool.handler(tool.inputSchema.parse(input), context);
  };
  return { tools, call, events };
}

describe("agent secret tools", () => {
  it("need the secrets.use permission and mark a handed-over value as sensitive", () => {
    const { tools } = setup();
    expect(tools.map((tool) => [tool.id, tool.permission, tool.sideEffects])).toEqual([
      ["secrets.list", "secrets.use", "read"],
      ["secrets.get", "secrets.use", "read"],
      ["secrets.http_request", "secrets.use", "external_communication"],
    ]);
    expect(tools.find((tool) => tool.id === "secrets.get")?.sensitiveOutputKeys).toEqual(["value"]);
  });

  it("lists what was granted without any value", async () => {
    const { call } = setup();
    const output = await call("secrets.list", {});
    expect(output).toEqual({
      secrets: [
        {
          name: "portal-password",
          description: "Supplier portal",
          mode: "handover",
          allowedHosts: [],
          version: 3,
        },
        {
          name: "billing-api",
          description: "Supplier portal",
          mode: "use_only",
          allowedHosts: ["api.example.com"],
          version: 3,
        },
      ],
    });
    expect(JSON.stringify(output)).not.toMatch(/hunter2|tok_live/u);
  });

  it("hands over a value only after recording that it did", async () => {
    const { call, events } = setup();
    await expect(call("secrets.get", { name: "portal-password" })).resolves.toEqual({
      name: "portal-password",
      value: "hunter2",
      version: 3,
    });
    expect(events).toEqual([
      `agent_secret.revealed:${JSON.stringify({ secretId: handover.id, secret: "portal-password", version: 3 })}`,
      `used:${handover.id}`,
    ]);
    expect(events.join()).not.toContain("hunter2");
  });

  it("never reads out a use-only secret, and says the same for missing and ungranted ones", async () => {
    const { call, events } = setup();
    await expect(call("secrets.get", { name: "billing-api" })).rejects.toThrow(/use-only/u);
    await expect(call("secrets.get", { name: "someone-elses" })).rejects.toThrow(
      /No secret named someone-elses is available/u,
    );
    expect(events.map((event) => event.split(":")[0])).toEqual([
      "agent_secret.access_denied",
      "agent_secret.access_denied",
    ]);
  });

  it("sends a use-only secret for the agent and records the host, not the value", async () => {
    const { call, events } = setup();
    await expect(
      call("secrets.http_request", {
        secret: "billing-api",
        url: "https://api.example.com/v1/invoices",
      }),
    ).resolves.toEqual({ status: 200, contentType: "text/plain", body: "ok" });
    expect(events[0]).toBe(
      `agent_secret.used:${JSON.stringify({ secretId: useOnly.id, secret: "billing-api", version: 3, method: "GET", host: "api.example.com" })}`,
    );
    expect(events.join()).not.toContain("tok_live");
  });

  it("records nothing as used when the request is refused", async () => {
    const { call, events } = setup();
    await expect(
      call("secrets.http_request", { secret: "billing-api", url: "https://evil.example.net/" }),
    ).rejects.toThrow(/sent only to/u);
    expect(events).toEqual([]);
  });

  it("refuses people, whatever they were granted", async () => {
    const { call, events } = setup(person);
    for (const [id, input] of [
      ["secrets.list", {}],
      ["secrets.get", { name: "portal-password" }],
      ["secrets.http_request", { secret: "billing-api", url: "https://api.example.com/" }],
    ] as const) {
      await expect(call(id, input), id).rejects.toThrow(/only to agents/u);
    }
    expect(events).toEqual([]);
  });

  it("runs a request unattended only when an administrator's grant covers exactly that request", async () => {
    const request = (input: Record<string, unknown>, actor = agent, unattended = true) => {
      const tool = setup(actor, unattended).tools.find((it) => it.id === "secrets.http_request");
      if (tool?.standingAuthorization === undefined) throw new Error("Expected the hook.");
      return tool.standingAuthorization(tool.inputSchema.parse(input), actor);
    };
    const granted = { secret: "billing-api", url: "https://api.example.com/v1/invoices" };
    await expect(request(granted)).resolves.toEqual({
      id: `agent-secret-grant:${useOnly.id}`,
      version: "3",
      requestsPerMinute: 60,
      requestsPerDay: 5_000,
    });
    // Another host, a secret with no hosts, one that was not granted, an
    // organization that asks for confirmation, a person: each waits.
    await expect(request({ ...granted, url: "https://evil.example.net/" })).resolves.toBeNull();
    await expect(request({ ...granted, secret: "portal-password" })).resolves.toBeNull();
    await expect(request({ ...granted, secret: "someone-elses" })).resolves.toBeNull();
    await expect(request(granted, agent, false)).resolves.toBeNull();
    await expect(request(granted, person)).resolves.toBeNull();
  });

  it("goes through the registry without a person only with that authorization", async () => {
    const audited: string[] = [];
    const invoke = async (unattended: boolean, url: string) => {
      const registry = createToolRegistry({
        confirmationGate: new InMemoryConfirmationGate(new InMemoryPendingActionStore()),
        confirmationDefaults: tierDefaults.business,
        // An unattended request must be recorded or it does not run.
        auditSink: { append: async (record) => audited.push(record.verb) },
      });
      for (const tool of setup(agent, unattended).tools) registry.register(tool);
      return registry.invoke(
        "secrets.http_request",
        { secret: "billing-api", url },
        { actor: agent, credentialId: "55555555-5555-4555-8555-555555555555" },
      );
    };
    await expect(invoke(true, "https://api.example.com/v1/invoices")).resolves.toMatchObject({
      ok: true,
      output: { status: 200, body: "ok" },
    });
    expect(audited).toContain("tool.invocation.executed");
    for (const [unattended, url] of [
      [false, "https://api.example.com/v1/invoices"],
      [true, "https://evil.example.net/"],
    ] as const) {
      await expect(invoke(unattended, url), url).resolves.toMatchObject({
        ok: true,
        status: "pending_confirmation",
      });
    }
  });
});
