import { describe, expect, it } from "vitest";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import {
  EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
  evaluateAgentOperationalControls,
  RuntimeAgentOperationalControlStore,
  snapshotFromEnvironment,
} from "./agent-operational-controls.js";

const agent: Actor = {
  id: "agent-1",
  orgId: "org-a",
  type: "agent",
  scopes: ["*"],
};
const user: Actor = {
  id: "user-1",
  orgId: "org-a",
  type: "user",
  scopes: ["*"],
};
const writeTool = {
  id: "mail.send",
  sideEffects: "write",
} as ToolDefinition;
const readTool = {
  id: "mail.search",
  sideEffects: "read",
} as ToolDefinition;

describe("evaluateAgentOperationalControls (A10)", () => {
  it("allows reads even during emergency kill", () => {
    expect(
      evaluateAgentOperationalControls({
        actor: agent,
        tool: readTool,
        snapshot: { ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT, globalReadOnly: true },
      }),
    ).toEqual({ allowed: true });
  });

  it("denies agent writes when org is disabled or global agent writes off", () => {
    expect(
      evaluateAgentOperationalControls({
        actor: agent,
        tool: writeTool,
        snapshot: {
          ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
          agentWritesDisabledOrgIds: ["org-a"],
        },
      }).allowed,
    ).toBe(false);
    expect(
      evaluateAgentOperationalControls({
        actor: agent,
        tool: writeTool,
        snapshot: { ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT, agentWritesEnabled: false },
      }).allowed,
    ).toBe(false);
  });

  it("denies user mutations under emergency kill but allows user writes when only agents disabled", () => {
    expect(
      evaluateAgentOperationalControls({
        actor: user,
        tool: writeTool,
        snapshot: { ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT, globalReadOnly: true },
      }),
    ).toMatchObject({ allowed: false, reason: "global_read_only" });
    expect(
      evaluateAgentOperationalControls({
        actor: user,
        tool: writeTool,
        snapshot: {
          ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
          agentWritesDisabledOrgIds: ["org-a"],
        },
      }),
    ).toEqual({ allowed: true });
  });

  it("parses environment snapshot and runtime store engages kill + org disable", async () => {
    const fromEnv = snapshotFromEnvironment({
      HELIX_GLOBAL_READ_ONLY: "true",
      HELIX_AGENT_WRITES_ENABLED: "false",
      HELIX_AGENT_WRITES_DISABLED_ORGS: "org-a, org-b",
      HELIX_DISABLED_TOOLS: "mail.send",
    });
    expect(fromEnv.globalReadOnly).toBe(true);
    expect(fromEnv.agentWritesEnabled).toBe(false);
    expect(fromEnv.agentWritesDisabledOrgIds).toEqual(["org-a", "org-b"]);

    const store = new RuntimeAgentOperationalControlStore();
    store.disableAgentWritesForOrg("org-a");
    const orgDeny = await store.evaluate({ actor: agent, tool: writeTool });
    expect(orgDeny.allowed).toBe(false);

    store.enableAgentWritesForOrg("org-a");
    store.engageEmergencyKill();
    const kill = await store.evaluate({ actor: user, tool: writeTool });
    expect(kill).toMatchObject({ allowed: false, reason: "global_read_only" });
    store.clearEmergencyKill();
    expect((await store.evaluate({ actor: user, tool: writeTool })).allowed).toBe(true);
  });

  it("cross-tenant: org-b disable does not block org-a agents (negative isolation)", () => {
    const decision = evaluateAgentOperationalControls({
      actor: agent,
      tool: writeTool,
      snapshot: {
        ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
        agentWritesDisabledOrgIds: ["org-b"],
      },
    });
    expect(decision.allowed).toBe(true);
  });
});
