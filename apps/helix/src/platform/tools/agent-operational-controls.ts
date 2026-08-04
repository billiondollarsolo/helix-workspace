/**
 * A10 — Org-level agent write disable + emergency kill (global read-only).
 * Pure evaluation + process-local runtime store used by admin controls and the
 * tool registry `operationalControls` provider (after env kill switches).
 */

import type { Actor, ToolDefinition } from "@helix/sdk-types";
import type {
  AgentOperationalControlDecision,
  AgentOperationalControlProvider,
  AgentOperationalControlReason,
} from "../tool-registry.js";

export type { AgentOperationalControlReason };

export interface AgentOperationalControlSnapshot {
  /** When true, all non-read tools are denied (emergency kill). */
  readonly globalReadOnly: boolean;
  /** When false, all agent non-read tools are denied org-wide. */
  readonly agentWritesEnabled: boolean;
  /** Org IDs whose agents cannot perform write/side-effect tools. */
  readonly agentWritesDisabledOrgIds: readonly string[];
  /** Exact tool ids temporarily disabled. */
  readonly disabledToolIds: readonly string[];
}

export const EMPTY_OPERATIONAL_CONTROL_SNAPSHOT: AgentOperationalControlSnapshot = {
  globalReadOnly: false,
  agentWritesEnabled: true,
  agentWritesDisabledOrgIds: [],
  disabledToolIds: [],
};

export function parseCsvIdList(value: string | undefined | null): readonly string[] {
  if (value === undefined || value === null || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function snapshotFromEnvironment(env: {
  readonly HELIX_GLOBAL_READ_ONLY?: string | undefined;
  readonly HELIX_AGENT_WRITES_ENABLED?: string | undefined;
  readonly HELIX_AGENT_WRITES_DISABLED_ORGS?: string | undefined;
  readonly HELIX_DISABLED_TOOLS?: string | undefined;
}): AgentOperationalControlSnapshot {
  return {
    globalReadOnly: isEnvFlagTrue(env.HELIX_GLOBAL_READ_ONLY),
    agentWritesEnabled: !isEnvFlagFalse(env.HELIX_AGENT_WRITES_ENABLED),
    agentWritesDisabledOrgIds: parseCsvIdList(env.HELIX_AGENT_WRITES_DISABLED_ORGS),
    disabledToolIds: parseCsvIdList(env.HELIX_DISABLED_TOOLS),
  };
}

function isEnvFlagTrue(value: string | undefined): boolean {
  const normalized = value?.trim();
  return normalized?.toLowerCase() === "true" || normalized === "1";
}

function isEnvFlagFalse(value: string | undefined): boolean {
  const normalized = value?.trim();
  return normalized?.toLowerCase() === "false" || normalized === "0";
}

/** Tools that must remain callable while emergency kill is engaged (A10 self-unlock). */
export const OPERATIONAL_CONTROL_BYPASS_TOOL_IDS: ReadonlySet<string> = new Set([
  "admin.agent_controls.get",
  "admin.agent_controls.set",
]);

/**
 * Evaluate kill switches for a non-read tool. Read tools always allowed here.
 * Admin control tools are exempt so operators can clear emergency kill without restart.
 */
export function evaluateAgentOperationalControls(input: {
  readonly actor: Pick<Actor, "type" | "orgId">;
  readonly tool: Pick<ToolDefinition, "id" | "sideEffects">;
  readonly snapshot: AgentOperationalControlSnapshot;
}): AgentOperationalControlDecision {
  if (input.tool.sideEffects === "read") {
    return { allowed: true };
  }
  if (OPERATIONAL_CONTROL_BYPASS_TOOL_IDS.has(input.tool.id)) {
    return { allowed: true };
  }
  if (input.snapshot.disabledToolIds.includes(input.tool.id)) {
    return {
      allowed: false,
      reason: "tool_disabled",
      controlId: `runtime:tool:${input.tool.id}`,
    };
  }
  if (input.snapshot.globalReadOnly) {
    return {
      allowed: false,
      reason: "global_read_only",
      controlId: "runtime:global-read-only",
    };
  }
  if (input.actor.type === "agent") {
    if (!input.snapshot.agentWritesEnabled) {
      return {
        allowed: false,
        reason: "org_agent_writes_disabled",
        controlId: "runtime:agent-writes",
      };
    }
    if (input.snapshot.agentWritesDisabledOrgIds.includes(input.actor.orgId)) {
      return {
        allowed: false,
        reason: "org_agent_writes_disabled",
        controlId: `runtime:org:${input.actor.orgId}:agent-writes`,
      };
    }
  }
  return { allowed: true };
}

/**
 * Process-local store for emergency controls set by admins without restart.
 * Registry env controls still apply first in tool-registry; this provider is
 * consulted as `operationalControls` for runtime overrides.
 */
export class RuntimeAgentOperationalControlStore implements AgentOperationalControlProvider {
  #snapshot: AgentOperationalControlSnapshot = { ...EMPTY_OPERATIONAL_CONTROL_SNAPSHOT };

  getSnapshot(): AgentOperationalControlSnapshot {
    return this.#snapshot;
  }

  setSnapshot(next: Partial<AgentOperationalControlSnapshot>): AgentOperationalControlSnapshot {
    this.#snapshot = {
      globalReadOnly: next.globalReadOnly ?? this.#snapshot.globalReadOnly,
      agentWritesEnabled: next.agentWritesEnabled ?? this.#snapshot.agentWritesEnabled,
      agentWritesDisabledOrgIds:
        next.agentWritesDisabledOrgIds ?? this.#snapshot.agentWritesDisabledOrgIds,
      disabledToolIds: next.disabledToolIds ?? this.#snapshot.disabledToolIds,
    };
    return this.#snapshot;
  }

  /** Disable agent writes for one org (idempotent). */
  disableAgentWritesForOrg(orgId: string): AgentOperationalControlSnapshot {
    if (this.#snapshot.agentWritesDisabledOrgIds.includes(orgId)) {
      return this.#snapshot;
    }
    return this.setSnapshot({
      agentWritesDisabledOrgIds: [...this.#snapshot.agentWritesDisabledOrgIds, orgId],
    });
  }

  /** Re-enable agent writes for one org. */
  enableAgentWritesForOrg(orgId: string): AgentOperationalControlSnapshot {
    return this.setSnapshot({
      agentWritesDisabledOrgIds: this.#snapshot.agentWritesDisabledOrgIds.filter(
        (id) => id !== orgId,
      ),
    });
  }

  /** Emergency kill — all non-read tools denied. */
  engageEmergencyKill(): AgentOperationalControlSnapshot {
    return this.setSnapshot({ globalReadOnly: true });
  }

  clearEmergencyKill(): AgentOperationalControlSnapshot {
    return this.setSnapshot({ globalReadOnly: false });
  }

  async evaluate(input: {
    readonly actor: Actor;
    readonly tool: ToolDefinition;
    readonly credentialId?: string;
  }): Promise<AgentOperationalControlDecision> {
    void input.credentialId;
    return evaluateAgentOperationalControls({
      actor: input.actor,
      tool: input.tool,
      snapshot: this.#snapshot,
    });
  }
}
