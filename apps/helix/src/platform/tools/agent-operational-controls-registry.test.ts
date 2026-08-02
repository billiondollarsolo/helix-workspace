/**
 * A10 self-unlock: after emergency kill, admin.agent_controls.set must still
 * clear kill via the real tool registry (not blocked as sideEffects: write).
 */
import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import { createToolRegistry } from "../tool-registry.js";
import { RuntimeAgentOperationalControlStore } from "./agent-operational-controls.js";
import { createAgentOperationalControlTools } from "./agent-operational-controls-tools.js";

const admin: Actor = {
  id: "admin-1",
  orgId: "org-a",
  type: "user",
  scopes: ["admin.agents", "danger.write"],
};

const agent: Actor = {
  id: "agent-1",
  orgId: "org-a",
  type: "agent",
  scopes: ["danger.write"],
};

/** Human with write scope — used after clear so confirmation gate is not required. */
const humanWriter: Actor = {
  id: "user-writer-1",
  orgId: "org-a",
  type: "user",
  scopes: ["danger.write"],
};

const passthroughSchema = {
  parse: (value: unknown) => value,
  toJsonSchema: () => ({ type: "object", additionalProperties: true }),
};

function writeTool(id: string): ToolDefinition {
  return {
    id,
    description: id,
    permission: "danger.write",
    sideEffects: "write",
    inputSchema: passthroughSchema,
    outputSchema: passthroughSchema,
    handler: async () => ({ written: true }),
  };
}

describe("A10 emergency kill self-unlock via admin.agent_controls.set", () => {
  it("engages kill, denies normal writes, then clears kill through set tool", async () => {
    const store = new RuntimeAgentOperationalControlStore();
    const registry = createToolRegistry({
      operationalControls: store,
    });
    for (const tool of createAgentOperationalControlTools(store)) {
      registry.register(tool);
    }
    registry.register(writeTool("mail.send"));

    // Engage kill via set tool
    const engage = await registry.invoke(
      "admin.agent_controls.set",
      { globalReadOnly: true },
      { actor: admin, skipConfirmation: true },
    );
    expect(engage).toMatchObject({ ok: true });
    expect(store.getSnapshot().globalReadOnly).toBe(true);

    // Normal write denied under kill (agent and human both blocked by kill)
    const deniedAgent = await registry.invoke("mail.send", {}, { actor: agent });
    expect(deniedAgent.ok).toBe(false);
    if (deniedAgent.ok) {
      throw new Error("expected agent denial under kill");
    }
    expect(deniedAgent.statusCode).toBe(503);
    expect(deniedAgent.error).toMatch(/read-only|disabled/i);

    const deniedHuman = await registry.invoke("mail.send", {}, { actor: humanWriter });
    expect(deniedHuman.ok).toBe(false);
    if (deniedHuman.ok) {
      throw new Error("expected human denial under kill");
    }
    expect(deniedHuman.statusCode).toBe(503);
    expect(deniedHuman.error).toMatch(/read-only|disabled/i);

    // Clear kill still works (self-unlock) — this is the regression the skeptic found
    const clear = await registry.invoke(
      "admin.agent_controls.set",
      { globalReadOnly: false },
      { actor: admin, skipConfirmation: true },
    );
    expect(clear).toMatchObject({ ok: true });
    expect(store.getSnapshot().globalReadOnly).toBe(false);

    // Human write allowed again after clear (proves kill is not residual).
    // Agents still require confirmation gate for mutations by policy; kill is
    // the control under test, not the agent approval path.
    const allowed = await registry.invoke("mail.send", {}, { actor: humanWriter });
    expect(allowed).toMatchObject({ ok: true, output: { written: true } });

    // Agent is no longer denied by operational kill (would be 503 read-only);
    // without a confirmation gate it fails closed on confirmation setup instead.
    const agentAfter = await registry.invoke("mail.send", {}, { actor: agent });
    expect(agentAfter.ok).toBe(false);
    if (agentAfter.ok) {
      throw new Error("expected agent to need confirmation, not execute");
    }
    expect(agentAfter.error).not.toMatch(/read-only/i);
    expect(agentAfter.error).toMatch(/confirmation/i);
  });
});
