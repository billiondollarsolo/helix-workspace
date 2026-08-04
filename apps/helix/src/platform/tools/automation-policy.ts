import type { JsonObject, JsonValue, PendingActionPreview, ToolDefinition } from "@helix/sdk-types";
import type { AgentAutomationPolicy, AgentAutomationPolicyRule } from "../auth/credentials.js";
import { getCryptoProvider } from "../crypto/index.js";

export const pendingPolicySnapshotVersion = "1";

export type AutomationPolicyDecision =
  | {
      readonly allowed: true;
      readonly policyVersion: string;
      readonly ruleId: string;
      readonly requestsPerMinute: number;
      readonly requestsPerDay: number;
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "missing_policy"
        | "policy_incomplete"
        | "policy_self_modification"
        | "policy_expired"
        | "tool_mismatch"
        | "action_mismatch"
        | "resource_mismatch"
        | "recipient_mismatch"
        | "target_mismatch";
    };

type AutomationPolicyDenialReason = Extract<
  AutomationPolicyDecision,
  { readonly allowed: false }
>["reason"];

export interface ExtractedActionBounds {
  readonly resourceIds: readonly string[];
  readonly recipients: readonly string[];
  readonly targets: readonly string[];
}

const resourceKeys = new Set([
  "attachmentId",
  "conversationId",
  "documentId",
  "draftId",
  "eventId",
  "fileId",
  "folderId",
  "messageId",
  "objectId",
  "roomId",
  "threadId",
  "uploadId",
]);
const targetKeys = new Set([
  "actorId",
  "actorIds",
  "memberActorId",
  "memberActorIds",
  "target",
  "targetActorId",
  "targetActorIds",
  "targetId",
  "targetIds",
  "userId",
  "userIds",
]);
const recipientKeys = new Set(["address", "bcc", "cc", "email", "recipient", "recipients", "to"]);

export function evaluateAutomationPolicy(input: {
  readonly policy: AgentAutomationPolicy | null | undefined;
  readonly tool: ToolDefinition;
  readonly parsedInput: unknown;
  readonly at?: Date;
}): AutomationPolicyDecision {
  if (
    input.tool.id.startsWith("agent.credentials.") ||
    input.tool.id.includes("automation.policy") ||
    input.tool.permission === "admin.agents" ||
    input.tool.permission === "admin.config.write"
  ) {
    return { allowed: false, reason: "policy_self_modification" };
  }
  const policy = input.policy;
  if (policy === null || policy === undefined) {
    return { allowed: false, reason: "missing_policy" };
  }
  if (
    typeof policy.version !== "string" ||
    policy.version.length === 0 ||
    !Array.isArray(policy.rules) ||
    policy.rules.length === 0
  ) {
    return { allowed: false, reason: "policy_incomplete" };
  }

  const bounds = extractActionBounds(input.parsedInput);
  const at = input.at ?? new Date();
  let closestReason: AutomationPolicyDenialReason = "tool_mismatch";
  for (const rule of policy.rules) {
    const completeness = validateRuleCompleteness(rule);
    if (completeness !== null) {
      closestReason = completeness;
      continue;
    }
    const boundedRule = rule as AgentAutomationPolicyRule;
    if (boundedRule.toolId !== input.tool.id) {
      continue;
    }
    if (boundedRule.action !== input.tool.permission) {
      closestReason = "action_mismatch";
      continue;
    }
    const activeFrom = new Date(boundedRule.activeFrom);
    const expiresAt = new Date(boundedRule.expiresAt);
    if (at < activeFrom || at >= expiresAt) {
      closestReason = "policy_expired";
      continue;
    }
    if (!sameExactStrings(boundedRule.resourceIds, bounds.resourceIds)) {
      closestReason = "resource_mismatch";
      continue;
    }
    if (!sameExactStrings(boundedRule.recipients.map(normalizeRecipient), bounds.recipients)) {
      closestReason = "recipient_mismatch";
      continue;
    }
    if (!sameExactStrings(boundedRule.targets, bounds.targets)) {
      closestReason = "target_mismatch";
      continue;
    }
    return {
      allowed: true,
      policyVersion: policy.version,
      ruleId: boundedRule.id,
      requestsPerMinute: boundedRule.requestsPerMinute,
      requestsPerDay: boundedRule.requestsPerDay,
    };
  }
  return { allowed: false, reason: closestReason };
}

export function extractActionBounds(input: unknown): ExtractedActionBounds {
  const resources = new Set<string>();
  const recipients = new Set<string>();
  const targets = new Set<string>();
  collectBounds(input, undefined, resources, recipients, targets);
  return {
    resourceIds: [...resources].sort(),
    recipients: [...recipients].sort(),
    targets: [...targets].sort(),
  };
}

export function buildSafeActionPreview(
  tool: ToolDefinition,
  parsedInput: unknown,
): PendingActionPreview {
  const bounds = extractActionBounds(parsedInput);
  return {
    toolId: tool.id,
    action: tool.permission,
    ...bounds,
    consequence: consequenceFor(tool),
  };
}

export function canonicalToolInput(input: JsonValue): string {
  return JSON.stringify(sortJson(input));
}

export function hashToolInput(input: JsonValue): string {
  return getCryptoProvider().hash("sha256", canonicalToolInput(input), "hex");
}

export function policySnapshot(input: {
  readonly credentialPolicyVersion?: string;
  readonly automationPolicy?: AgentAutomationPolicy | null;
}): JsonObject {
  return {
    schemaVersion: pendingPolicySnapshotVersion,
    credentialPolicyVersion: input.credentialPolicyVersion ?? "unknown",
    automationPolicyVersion: input.automationPolicy?.version ?? null,
  };
}

function validateRuleCompleteness(rule: unknown): AutomationPolicyDenialReason | null {
  if (typeof rule !== "object" || rule === null) {
    return "policy_incomplete";
  }
  const candidate = rule as Partial<AgentAutomationPolicyRule>;
  const activeFrom = candidate.activeFrom;
  const expiresAt = candidate.expiresAt;
  const requestsPerMinute = candidate.requestsPerMinute;
  const requestsPerDay = candidate.requestsPerDay;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    typeof candidate.toolId !== "string" ||
    candidate.toolId.length === 0 ||
    typeof candidate.action !== "string" ||
    candidate.action.length === 0 ||
    !Array.isArray(candidate.resourceIds) ||
    !Array.isArray(candidate.recipients) ||
    !Array.isArray(candidate.targets) ||
    !candidate.resourceIds.every(isConcreteBound) ||
    !candidate.recipients.every(isConcreteBound) ||
    !candidate.targets.every(isConcreteBound) ||
    candidate.resourceIds.length + candidate.recipients.length + candidate.targets.length === 0 ||
    !validDate(activeFrom) ||
    !validDate(expiresAt) ||
    new Date(activeFrom) >= new Date(expiresAt) ||
    !Number.isSafeInteger(requestsPerMinute) ||
    (requestsPerMinute ?? 0) <= 0 ||
    !Number.isSafeInteger(requestsPerDay) ||
    (requestsPerDay ?? 0) <= 0
  ) {
    return "policy_incomplete";
  }
  return null;
}

function isConcreteBound(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function collectBounds(
  value: unknown,
  key: string | undefined,
  resources: Set<string>,
  recipients: Set<string>,
  targets: Set<string>,
): void {
  if (typeof value === "string") {
    if (key === undefined || value.length === 0) {
      return;
    }
    if (resourceKeys.has(key)) {
      resources.add(value);
    }
    if (recipientKeys.has(key)) {
      recipients.add(normalizeRecipient(value));
    }
    if (targetKeys.has(key)) {
      targets.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectBounds(item, key, resources, recipients, targets);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectBounds(child, childKey, resources, recipients, targets);
  }
}

function consequenceFor(tool: ToolDefinition): string {
  switch (tool.sideEffects) {
    case "external_communication":
      return `Send external communication using ${tool.id}.`;
    case "destructive":
      return `Permanently change or remove data using ${tool.id}.`;
    case "write":
      return `Change workspace data using ${tool.id}.`;
    case "read":
      return `Read workspace data using ${tool.id}.`;
  }
}

function normalizeRecipient(value: string): string {
  return value.trim().toLowerCase();
}

function sameExactStrings(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...new Set(left)].sort();
  return (
    normalizedLeft.length === right.length &&
    normalizedLeft.every((value, index) => value === right[index])
  );
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
