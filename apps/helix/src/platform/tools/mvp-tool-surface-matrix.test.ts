/**
 * E3.6 / E4.6 / E5.6 / E9.1 — MVP tool surface matrix.
 *
 * Loads real mail / drive / chat / admin.agent_controls tool definitions (not
 * hand-maintained stubs) and asserts:
 * - every tool declares a known `sideEffects` class and a non-empty permission
 * - every non-read tool queues confirmation for agent principals via
 *   `evaluateToolPolicyFirewall` (no automation match, no approved pending)
 *
 * Evidence companion: `docs/architecture/mvp-tool-channel-inventory.md`.
 */
import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition, ToolSideEffect } from "@helix/sdk-types";
import { createChatToolDefinitions } from "../chat/tools.js";
import { createDriveToolDefinitions } from "../drive/tools.js";
import { createMailToolDefinitions } from "../mail/tools.js";
import {
  EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
  evaluateAgentOperationalControls,
  RuntimeAgentOperationalControlStore,
} from "./agent-operational-controls.js";
import { createAgentOperationalControlTools } from "./agent-operational-controls-tools.js";
import { evaluateToolPolicyFirewall, type ToolPolicyFirewallInput } from "./policy-firewall.js";

const KNOWN_SIDE_EFFECTS = new Set<ToolSideEffect>([
  "read",
  "write",
  "destructive",
  "external_communication",
]);

const agent: Actor = {
  id: "agent-matrix-1",
  orgId: "org-matrix",
  type: "agent",
  scopes: ["*"],
};

function loadMvpToolSurface(): readonly ToolDefinition[] {
  const store = new RuntimeAgentOperationalControlStore();
  return [
    ...createMailToolDefinitions({ store: {} as never }),
    ...createDriveToolDefinitions({ store: {} as never }),
    ...createChatToolDefinitions({ store: {} as never }),
    ...createAgentOperationalControlTools(store),
  ];
}

function isWriteLike(sideEffects: ToolSideEffect): boolean {
  return sideEffects !== "read";
}

function agentPolicyInput(
  tool: Pick<ToolDefinition, "id" | "permission" | "sideEffects" | "confirmationRequired">,
  overrides: Partial<ToolPolicyFirewallInput> = {},
): ToolPolicyFirewallInput {
  return {
    actor: agent,
    tenantId: agent.orgId,
    tool,
    effectiveClassification: "standard",
    sourceProvenance: { sourceIds: [], containsUntrustedContext: false },
    requestChannel: "assistant",
    tier: "business",
    scopeAllowed: true,
    featureEnabled: true,
    // Tool-level confirmation flag must not short-circuit agent write policy;
    // agents always queue without an exact automation match (ADR-0005).
    confirmationRequired: tool.confirmationRequired === true,
    automationDecision: null,
    approvedPendingExecution: false,
    ...overrides,
  };
}

describe("MVP tool surface matrix (E3.6 / E4.6 / E5.6 / E9.1)", () => {
  const tools = loadMvpToolSurface();

  it("loads real mail.*, drive.*, chat.*, admin.agent_controls.* definitions", () => {
    const ids = tools.map((tool) => tool.id).sort();
    expect(ids.some((id) => id.startsWith("mail."))).toBe(true);
    expect(ids.some((id) => id.startsWith("drive."))).toBe(true);
    expect(ids.some((id) => id.startsWith("chat."))).toBe(true);
    expect(ids).toEqual(
      expect.arrayContaining(["admin.agent_controls.get", "admin.agent_controls.set"]),
    );
    // Guard against accidental empty factories / wrong import path.
    expect(ids.length).toBeGreaterThanOrEqual(40);
  });

  it("declares sideEffects and a non-empty permission on every registered tool", () => {
    for (const tool of tools) {
      expect(tool.id, "tool id").toMatch(/^(mail|drive|chat|admin\.agent_controls)\./);
      expect(
        KNOWN_SIDE_EFFECTS.has(tool.sideEffects),
        `${tool.id} sideEffects=${tool.sideEffects}`,
      ).toBe(true);
      expect(typeof tool.permission, `${tool.id} permission type`).toBe("string");
      expect(tool.permission.trim().length, `${tool.id} permission empty`).toBeGreaterThan(0);
    }
  });

  it("queues confirmation for every agent write/destructive/external tool", () => {
    const writeLike = tools.filter((tool) => isWriteLike(tool.sideEffects));
    expect(writeLike.length).toBeGreaterThan(0);

    for (const tool of writeLike) {
      const decision = evaluateToolPolicyFirewall(agentPolicyInput(tool));
      expect(
        decision,
        `${tool.id} (${tool.sideEffects}) must not allow agent mutation without confirmation`,
      ).toEqual({
        outcome: "queue-confirmation",
        reason: "agent_write_requires_approval",
      });
      expect(decision.outcome).not.toBe("allow");
      expect(decision.outcome).not.toBe("allow-automation");
      expect(decision.outcome).not.toBe("allow-read");
    }
  });

  it("allows agent reads without confirmation while still requiring scopes elsewhere", () => {
    const reads = tools.filter((tool) => tool.sideEffects === "read");
    expect(reads.length).toBeGreaterThan(0);

    for (const tool of reads) {
      const decision = evaluateToolPolicyFirewall(agentPolicyInput(tool));
      expect(decision, tool.id).toEqual({
        outcome: "allow-read",
        reason: "read_allowed",
      });
    }
  });

  it("keeps agent writes allowed by operational controls when kill is clear (firewall owns confirmation)", () => {
    // Operational controls gate kill / org disable only. Confirmation is the
    // policy firewall path above — do not conflate the two.
    for (const tool of tools.filter((t) => isWriteLike(t.sideEffects))) {
      const operational = evaluateAgentOperationalControls({
        actor: agent,
        tool,
        snapshot: EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
      });
      // admin.agent_controls.* bypass kill evaluation; others are allowed when kill is clear.
      expect(operational.allowed, tool.id).toBe(true);
    }
  });

  it("denies non-bypass write tools under emergency kill via operational controls", () => {
    const killed = {
      ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
      globalReadOnly: true,
    };
    for (const tool of tools.filter((t) => isWriteLike(t.sideEffects))) {
      const operational = evaluateAgentOperationalControls({
        actor: agent,
        tool,
        snapshot: killed,
      });
      if (tool.id.startsWith("admin.agent_controls.")) {
        // Self-unlock path for operators clearing kill (A10).
        expect(operational.allowed, tool.id).toBe(true);
      } else {
        expect(operational.allowed, tool.id).toBe(false);
        expect(operational).toMatchObject({ reason: "global_read_only" });
      }
    }
  });

  it("covers high-risk MVP mutations used as matrix anchors", () => {
    const byId = new Map(tools.map((tool) => [tool.id, tool]));
    const anchors: Array<{
      id: string;
      sideEffects: ToolSideEffect;
      permission: string;
    }> = [
      { id: "mail.send", sideEffects: "external_communication", permission: "mail.send" },
      { id: "mail.reply", sideEffects: "external_communication", permission: "mail.send" },
      { id: "mail.delete", sideEffects: "destructive", permission: "mail.write" },
      { id: "drive.share", sideEffects: "write", permission: "drive.write" },
      { id: "drive.delete", sideEffects: "destructive", permission: "drive.delete" },
      { id: "drive.upload", sideEffects: "write", permission: "drive.write" },
      { id: "chat.send", sideEffects: "write", permission: "chat.post" },
      { id: "chat.delete", sideEffects: "destructive", permission: "chat.post" },
      {
        id: "admin.agent_controls.set",
        sideEffects: "write",
        permission: "admin.agents",
      },
    ];

    for (const anchor of anchors) {
      const tool = byId.get(anchor.id);
      expect(tool, `missing anchor tool ${anchor.id}`).toBeDefined();
      if (tool === undefined) {
        continue;
      }
      expect(tool.sideEffects).toBe(anchor.sideEffects);
      expect(tool.permission).toBe(anchor.permission);
      expect(evaluateToolPolicyFirewall(agentPolicyInput(tool)).outcome).toBe("queue-confirmation");
    }
  });
});
