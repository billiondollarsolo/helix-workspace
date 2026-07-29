import { describe, expect, it } from "vitest";
import type { Actor, ToolSideEffect } from "@helix/sdk-types";
import { evaluateToolPolicyFirewall, type ToolPolicyFirewallInput } from "./policy-firewall.js";

const actors: Record<"human" | "agent" | "system", Actor> = {
  human: { id: "human-1", orgId: "org-1", type: "user", scopes: ["demo.write"] },
  agent: { id: "agent-1", orgId: "org-1", type: "agent", scopes: ["demo.write"] },
  system: { id: "system-1", orgId: "org-1", type: "system" },
};

function policyInput(
  actor: Actor,
  sideEffects: ToolSideEffect,
  overrides: Partial<ToolPolicyFirewallInput> = {},
): ToolPolicyFirewallInput {
  return {
    actor,
    tenantId: "org-1",
    tool: {
      id: `demo.${sideEffects}`,
      permission: "demo.write",
      sideEffects,
    },
    effectiveClassification: "standard",
    sourceProvenance: { sourceIds: [], containsUntrustedContext: false },
    requestChannel: "rest",
    tier: "business",
    scopeAllowed: true,
    featureEnabled: true,
    confirmationRequired: false,
    ...overrides,
  };
}

describe("evaluateToolPolicyFirewall", () => {
  it.each(["human", "agent", "system"] as const)("allows %s reads deterministically", (kind) => {
    expect(evaluateToolPolicyFirewall(policyInput(actors[kind], "read"))).toEqual({
      outcome: "allow-read",
      reason: "read_allowed",
    });
  });

  it.each(["write", "external_communication", "destructive"] as const)(
    "queues agent %s without an exact automation policy",
    (sideEffects) => {
      expect(
        evaluateToolPolicyFirewall(
          policyInput(actors.agent, sideEffects, {
            automationDecision: { allowed: false, reason: "resource_mismatch" },
          }),
        ),
      ).toEqual({
        outcome: "queue-confirmation",
        reason: "automation_policy_no_match",
      });
    },
  );

  it("allows an agent write only after an independently exact automation decision", () => {
    expect(
      evaluateToolPolicyFirewall(
        policyInput(actors.agent, "write", {
          requestChannel: "mcp",
          automationDecision: {
            allowed: true,
            policyVersion: "7",
            ruleId: "bounded-rule",
            requestsPerMinute: 1,
            requestsPerDay: 5,
          },
        }),
      ),
    ).toEqual({ outcome: "allow-automation", reason: "automation_policy_match" });
  });

  it("queues every assistant-proposed human write while preserving direct human writes", () => {
    expect(
      evaluateToolPolicyFirewall(
        policyInput(actors.human, "write", { requestChannel: "assistant" }),
      ),
    ).toEqual({
      outcome: "queue-confirmation",
      reason: "assistant_write_requires_approval",
    });
    expect(evaluateToolPolicyFirewall(policyInput(actors.human, "write"))).toEqual({
      outcome: "allow",
      reason: "direct_human_write_allowed",
    });
  });

  it("honors tier/tool confirmation without accepting a credential-wide agent bypass", () => {
    expect(
      evaluateToolPolicyFirewall(
        policyInput(actors.human, "write", { tier: "enterprise", confirmationRequired: true }),
      ),
    ).toEqual({
      outcome: "queue-confirmation",
      reason: "tier_or_tool_requires_approval",
    });
    expect(
      evaluateToolPolicyFirewall(
        policyInput(actors.agent, "write", {
          confirmationRequired: false,
          automationDecision: { allowed: false, reason: "missing_policy" },
        }),
      ),
    ).toEqual({
      outcome: "queue-confirmation",
      reason: "automation_policy_no_match",
    });
  });

  it.each([
    ["unknown tool", { tool: undefined }, "unknown_tool"],
    [
      "unknown effect",
      { tool: { id: "demo", permission: "demo.write", sideEffects: "network" } },
      "unknown_side_effect",
    ],
    ["unknown channel", { requestChannel: "graphql" }, "unknown_request_channel"],
    ["tenant mismatch", { tenantId: "org-2" }, "tenant_mismatch"],
    ["missing classification", { effectiveClassification: undefined }, "classification_missing"],
    ["scope denial", { scopeAllowed: false }, "scope_denied"],
    ["feature disabled", { featureEnabled: false }, "feature_disabled"],
  ] as const)("fails closed for %s", (_label, override, reason) => {
    expect(
      evaluateToolPolicyFirewall(
        policyInput(actors.agent, "write", override as unknown as Partial<ToolPolicyFirewallInput>),
      ),
    ).toEqual({ outcome: "deny", reason });
  });

  it("can block high-risk categories whenever untrusted retrieval influenced the proposal", () => {
    expect(
      evaluateToolPolicyFirewall(
        policyInput(actors.human, "external_communication", {
          requestChannel: "assistant",
          sourceProvenance: { sourceIds: ["mail-1"], containsUntrustedContext: true },
          blockHighRiskWhenUntrusted: true,
        }),
      ),
    ).toEqual({
      outcome: "deny",
      reason: "untrusted_context_high_risk_blocked",
    });
  });

  it("denies automation policy self-modification", () => {
    expect(
      evaluateToolPolicyFirewall(
        policyInput(actors.agent, "write", {
          automationDecision: { allowed: false, reason: "policy_self_modification" },
        }),
      ),
    ).toEqual({ outcome: "deny", reason: "policy_self_modification" });
  });
});
