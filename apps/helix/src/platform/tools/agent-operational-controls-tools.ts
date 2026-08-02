/**
 * Admin tools for A10 emergency kill / org agent-write disable.
 */
import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod3";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { RuntimeAgentOperationalControlStore } from "./agent-operational-controls.js";

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const emptySchema = z.object({});
const setSchema = z.object({
  globalReadOnly: z.boolean().optional(),
  agentWritesEnabled: z.boolean().optional(),
  disableOrgId: z.string().min(1).optional(),
  enableOrgId: z.string().min(1).optional(),
});

const controlsSchema = z.object({
  globalReadOnly: z.boolean(),
  agentWritesEnabled: z.boolean(),
  agentWritesDisabledOrgIds: z.array(z.string()),
  disabledToolIds: z.array(z.string()),
});

export function createAgentOperationalControlTools(
  store: RuntimeAgentOperationalControlStore,
): readonly ToolDefinition[] {
  return [
    defineTool({
      id: "admin.agent_controls.get",
      description: "Read emergency kill and per-org agent write disable state.",
      permission: "admin.agents",
      sideEffects: "read",
      confirmationRequired: false,
      inputSchema: zodToolSchema(emptySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.object({ controls: controlsSchema }), genericObjectJsonSchema),
      handler: async () => ({ controls: store.getSnapshot() }),
    }),
    defineTool({
      id: "admin.agent_controls.set",
      description:
        "Engage emergency kill (global read-only), toggle agent writes, or disable/enable agent writes for one org.",
      permission: "admin.agents",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(setSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.object({ controls: controlsSchema }), genericObjectJsonSchema),
      handler: async (input) => {
        if (input.globalReadOnly === true) {
          store.engageEmergencyKill();
        } else if (input.globalReadOnly === false) {
          store.clearEmergencyKill();
        }
        if (input.agentWritesEnabled !== undefined) {
          store.setSnapshot({ agentWritesEnabled: input.agentWritesEnabled });
        }
        if (input.disableOrgId !== undefined) {
          store.disableAgentWritesForOrg(input.disableOrgId);
        }
        if (input.enableOrgId !== undefined) {
          store.enableAgentWritesForOrg(input.enableOrgId);
        }
        return { controls: store.getSnapshot() };
      },
    }),
  ];
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}
