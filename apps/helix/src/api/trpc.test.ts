import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { systemActor } from "./actor.js";
import { createHelixTRPCRouter } from "./trpc.js";
import { createPlatformMetrics } from "./metrics.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";

const requestContext = { requestId: "req-trpc" };

function context(actor: Actor = systemActor) {
  return { request: requestContext, principal: { actor } };
}

const schema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object", additionalProperties: true }),
};

function echoTool(overrides: Partial<ToolDefinition> & Pick<ToolDefinition, "id">): ToolDefinition {
  return {
    description: overrides.id,
    permission: "platform.read",
    sideEffects: "read",
    inputSchema: schema,
    outputSchema: schema,
    handler: async (input) => input,
    ...overrides,
  };
}

describe("createHelixTRPCRouter — per-tool projection (P1-3)", () => {
  it("generates a typed procedure per registered tool under tools.byId", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register(echoTool({ id: "mail.read", permission: "mail.read" }));
    const router = createHelixTRPCRouter({ tools, metrics: createPlatformMetrics() });

    const projection = router._def.procedures;
    expect(Object.keys(projection)).toContain("tools.byId.mail.read");
    expect(Object.keys(projection)).toContain("tools.byId.platform.ping");
  });

  it("invokes a read tool through its dedicated query procedure", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register(echoTool({ id: "mail.read", permission: "mail.read" }));
    const router = createHelixTRPCRouter({ tools, metrics: createPlatformMetrics() });

    // The per-tool projection is keyed dynamically from the registry, so the
    // statically-typed caller cannot name `mail.read` — invoke it via the
    // runtime caller surface.
    const caller = router.createCaller(context()) as unknown as {
      tools: { byId: { mail: { read: (input: unknown) => Promise<unknown> } } };
    };
    const result = await caller.tools.byId.mail.read({ folder: "inbox" });
    expect(result).toEqual({ folder: "inbox" });
  });

  it("invokes a write tool through its dedicated mutation procedure", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register(
      echoTool({
        id: "mail.send",
        permission: "mail.send",
        sideEffects: "write",
        handler: async () => ({ delivered: true }),
      }),
    );
    const router = createHelixTRPCRouter({ tools, metrics: createPlatformMetrics() });

    const caller = router.createCaller(context()) as unknown as {
      tools: { byId: { mail: { send: (input: unknown) => Promise<unknown> } } };
    };
    const result = await caller.tools.byId.mail.send({ to: "a@example.com" });
    expect(result).toEqual({ delivered: true });
  });

  it("keeps the generic tools.invoke procedure for back-compat", async () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    const router = createHelixTRPCRouter({ tools, metrics: createPlatformMetrics() });

    const caller = router.createCaller(context());
    const result = await caller.tools.invoke({ toolId: "platform.ping", input: {} });
    expect(result).toMatchObject({ ok: true, service: "helix-app" });
  });
});
