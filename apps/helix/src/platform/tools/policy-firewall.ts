import type {
  Actor,
  AIClassification,
  SecurityTier,
  ToolDefinition,
  ToolSideEffect,
} from "@helix/sdk-types";
import type { AutomationPolicyDecision } from "./automation-policy.js";

export const toolPolicyRequestChannels = [
  "rest",
  "mcp",
  "trpc",
  "assistant",
  "pending_execution",
  "internal",
] as const;

export type ToolPolicyRequestChannel = (typeof toolPolicyRequestChannels)[number];

export type ToolPolicyDecision =
  | {
      readonly outcome: "allow-read" | "allow" | "allow-automation";
      readonly reason:
        | "read_allowed"
        | "direct_human_write_allowed"
        | "trusted_system_write_allowed"
        | "automation_policy_match"
        | "approved_pending_execution";
    }
  | {
      readonly outcome: "queue-confirmation";
      readonly reason:
        | "agent_write_requires_approval"
        | "assistant_write_requires_approval"
        | "tier_or_tool_requires_approval"
        | "automation_policy_no_match";
    }
  | {
      readonly outcome: "deny";
      readonly reason:
        | "unknown_tool"
        | "unknown_side_effect"
        | "unknown_request_channel"
        | "unknown_actor_type"
        | "tenant_mismatch"
        | "classification_missing"
        | "scope_denied"
        | "feature_disabled"
        | "policy_self_modification"
        | "untrusted_context_high_risk_blocked";
    };

export interface ToolPolicyProvenance {
  readonly sourceIds: readonly string[];
  readonly containsUntrustedContext: boolean;
}

export interface ToolPolicyFirewallInput {
  readonly actor: Actor;
  readonly tenantId: string;
  readonly tool?: Pick<
    ToolDefinition,
    "id" | "permission" | "sideEffects" | "confirmationRequired"
  >;
  readonly effectiveClassification?: AIClassification;
  readonly sourceProvenance: ToolPolicyProvenance;
  readonly requestChannel: string;
  readonly tier: SecurityTier;
  readonly scopeAllowed: boolean;
  readonly featureEnabled: boolean;
  readonly confirmationRequired: boolean;
  readonly automationDecision?: AutomationPolicyDecision | null;
  readonly approvedPendingExecution?: boolean;
  /** Optional organization policy for prompt-injection-sensitive categories. */
  readonly blockHighRiskWhenUntrusted?: boolean;
}

export function evaluateToolPolicyFirewall(input: ToolPolicyFirewallInput): ToolPolicyDecision {
  if (input.tool === undefined) {
    return { outcome: "deny", reason: "unknown_tool" };
  }
  if (!isKnownSideEffect(input.tool.sideEffects)) {
    return { outcome: "deny", reason: "unknown_side_effect" };
  }
  if (!isKnownRequestChannel(input.requestChannel)) {
    return { outcome: "deny", reason: "unknown_request_channel" };
  }
  if (!isKnownActorType(input.actor.type)) {
    return { outcome: "deny", reason: "unknown_actor_type" };
  }
  if (input.actor.orgId !== input.tenantId) {
    return { outcome: "deny", reason: "tenant_mismatch" };
  }
  if (input.effectiveClassification === undefined) {
    return { outcome: "deny", reason: "classification_missing" };
  }
  if (!input.scopeAllowed) {
    return { outcome: "deny", reason: "scope_denied" };
  }
  if (!input.featureEnabled) {
    return { outcome: "deny", reason: "feature_disabled" };
  }
  if (
    input.automationDecision?.allowed === false &&
    input.automationDecision.reason === "policy_self_modification"
  ) {
    return { outcome: "deny", reason: "policy_self_modification" };
  }
  if (
    input.blockHighRiskWhenUntrusted === true &&
    input.sourceProvenance.containsUntrustedContext &&
    (input.tool.sideEffects === "destructive" ||
      input.tool.sideEffects === "external_communication")
  ) {
    return { outcome: "deny", reason: "untrusted_context_high_risk_blocked" };
  }
  if (input.tool.sideEffects === "read") {
    return { outcome: "allow-read", reason: "read_allowed" };
  }
  if (input.approvedPendingExecution === true) {
    return { outcome: "allow", reason: "approved_pending_execution" };
  }
  if (input.actor.type === "agent") {
    return input.automationDecision?.allowed === true
      ? { outcome: "allow-automation", reason: "automation_policy_match" }
      : {
          outcome: "queue-confirmation",
          reason:
            input.automationDecision === undefined || input.automationDecision === null
              ? "agent_write_requires_approval"
              : "automation_policy_no_match",
        };
  }
  if (input.requestChannel === "assistant") {
    return { outcome: "queue-confirmation", reason: "assistant_write_requires_approval" };
  }
  if (input.actor.type === "system" || input.actor.type === "service_account") {
    return { outcome: "allow", reason: "trusted_system_write_allowed" };
  }
  if (input.confirmationRequired) {
    return { outcome: "queue-confirmation", reason: "tier_or_tool_requires_approval" };
  }
  return { outcome: "allow", reason: "direct_human_write_allowed" };
}

function isKnownSideEffect(value: unknown): value is ToolSideEffect {
  return (
    value === "read" ||
    value === "write" ||
    value === "destructive" ||
    value === "external_communication"
  );
}

function isKnownRequestChannel(value: string): value is ToolPolicyRequestChannel {
  return toolPolicyRequestChannels.some((channel) => channel === value);
}

function isKnownActorType(value: unknown): value is Actor["type"] {
  return value === "user" || value === "agent" || value === "system" || value === "service_account";
}
