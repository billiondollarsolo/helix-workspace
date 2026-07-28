import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "@helix/sdk-types";
import {
  canonicalToolInput,
  evaluateAutomationPolicy,
  hashToolInput,
} from "./automation-policy.js";

const tool: ToolDefinition = {
  id: "chat.send",
  description: "Send a room message.",
  permission: "chat.send",
  sideEffects: "write",
  inputSchema: {
    parse: (value) => value,
    toJsonSchema: () => ({ type: "object" }),
  },
  outputSchema: {
    parse: (value) => value,
    toJsonSchema: () => ({ type: "object" }),
  },
  handler: async () => ({}),
};

const rule = {
  id: "rule-1",
  toolId: "chat.send",
  action: "chat.send",
  resourceIds: ["room-1"],
  recipients: ["owner@example.test"],
  targets: ["actor-2"],
  activeFrom: "2026-07-28T11:00:00.000Z",
  expiresAt: "2026-07-28T13:00:00.000Z",
  requestsPerMinute: 2,
  requestsPerDay: 10,
} as const;
const parsedInput = {
  roomId: "room-1",
  recipient: "OWNER@example.test",
  targetActorId: "actor-2",
  body: "safe content that is never included in generic audit",
};

describe("evaluateAutomationPolicy", () => {
  it("allows only a fully bounded exact action", () => {
    expect(
      evaluateAutomationPolicy({
        policy: { version: "9", rules: [rule] },
        tool,
        parsedInput,
        at: new Date("2026-07-28T12:00:00.000Z"),
      }),
    ).toEqual({
      allowed: true,
      policyVersion: "9",
      ruleId: "rule-1",
      requestsPerMinute: 2,
      requestsPerDay: 10,
    });
  });

  it.each([
    ["tool", { ...tool, id: "drive.rename" }, parsedInput, "tool_mismatch"],
    ["action", { ...tool, permission: "chat.admin" }, parsedInput, "action_mismatch"],
    ["resource", tool, { ...parsedInput, roomId: "room-2" }, "resource_mismatch"],
    ["recipient", tool, { ...parsedInput, recipient: "other@example.test" }, "recipient_mismatch"],
    ["target", tool, { ...parsedInput, targetActorId: "actor-3" }, "target_mismatch"],
  ])("queues when the %s bound changes", (_name, changedTool, input, reason) => {
    expect(
      evaluateAutomationPolicy({
        policy: { version: "9", rules: [rule] },
        tool: changedTool,
        parsedInput: input,
        at: new Date("2026-07-28T12:00:00.000Z"),
      }),
    ).toEqual({ allowed: false, reason });
  });

  it("fails closed for incomplete/expired policy and denies policy self-modification", () => {
    expect(
      evaluateAutomationPolicy({
        policy: {
          version: "9",
          rules: [{ ...rule, requestsPerMinute: 0 }],
        },
        tool,
        parsedInput,
      }),
    ).toEqual({ allowed: false, reason: "policy_incomplete" });
    expect(
      evaluateAutomationPolicy({
        policy: { version: "9", rules: [rule] },
        tool,
        parsedInput,
        at: new Date(rule.expiresAt),
      }),
    ).toEqual({ allowed: false, reason: "policy_expired" });
    expect(
      evaluateAutomationPolicy({
        policy: { version: "9", rules: [{ ...rule, toolId: "agent.credentials.rotate" }] },
        tool: { ...tool, id: "agent.credentials.rotate", permission: "admin.agents" },
        parsedInput,
      }),
    ).toEqual({ allowed: false, reason: "policy_self_modification" });
  });

  it("fails closed when a rule has no concrete resource, recipient, or target bound", () => {
    expect(
      evaluateAutomationPolicy({
        policy: {
          version: "9",
          rules: [
            {
              ...rule,
              resourceIds: [],
              recipients: [],
              targets: [],
            },
          ],
        },
        tool: { ...tool, id: "workspace.create", permission: "workspace.write" },
        parsedInput: { name: "unbounded workspace" },
        at: new Date("2026-07-28T12:00:00.000Z"),
      }),
    ).toEqual({ allowed: false, reason: "policy_incomplete" });
  });

  it("canonicalizes object keys before hashing immutable input", () => {
    expect(canonicalToolInput({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(hashToolInput({ b: 2, a: 1 })).toBe(hashToolInput({ a: 1, b: 2 }));
  });
});
