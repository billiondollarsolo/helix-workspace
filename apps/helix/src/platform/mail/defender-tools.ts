import { z } from "zod";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import {
  normalizeAllowedSender,
  parseAgentDefenderReceiveMode,
  type AgentDefenderPolicy,
} from "./defender-policy.js";
import type { PostgresAgentDefenderStore } from "./defender-store.js";

const agentDefenderAdminScope = "admin.agents";
const genericObjectJsonSchema = { type: "object", additionalProperties: true } as const;
const uuidSchema = z.string().uuid();
const senderSchema = z.string().trim().min(1).max(320);

const policySchema = z.object({
  actorId: uuidSchema,
  receiveMode: z.enum(["allowlist", "open"]).default("allowlist"),
  loopEnabled: z.boolean().default(false),
  allowedSenders: z.array(senderSchema).max(500).default([]),
  allowSend: z.boolean().default(false),
});

const policyGetSchema = z.object({ actorId: uuidSchema });
const holdsListSchema = z.object({});
const holdDecideSchema = z.object({
  agentActorId: uuidSchema,
  threadId: uuidSchema,
  action: z.enum(["release", "junk"]),
});

function serializePolicy(policy: AgentDefenderPolicy) {
  return {
    actorId: policy.actorId,
    ownerActorId: policy.ownerActorId,
    receiveMode: policy.receiveMode,
    loopEnabled: policy.loopEnabled,
    allowedSenders: [...policy.allowedSenders],
    allowSend: policy.allowSend,
  };
}

export function registerAgentDefenderTools(
  registry: RuntimeToolRegistry,
  store: PostgresAgentDefenderStore,
): void {
  for (const tool of [
    defineTool({
      id: "agent.defender.policy.get",
      description: "Read Helix Agent Defender receive policy for an agent mailbox.",
      permission: agentDefenderAdminScope,
      sideEffects: "read",
      inputSchema: zodToolSchema(policyGetSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(
        z.object({ policy: z.unknown().nullable() }),
        genericObjectJsonSchema,
      ),
      handler: async (input, ctx) => ({
        policy: await store.getPolicy(ctx.actor.orgId, input.actorId),
      }),
    }),
    defineTool({
      id: "agent.defender.policy.list",
      description: "List Agent Defender policies owned by the current operator.",
      permission: agentDefenderAdminScope,
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}), genericObjectJsonSchema),
      outputSchema: zodToolSchema(
        z.object({ policies: z.array(z.unknown()) }),
        genericObjectJsonSchema,
      ),
      handler: async (_input, ctx) => ({
        policies: (await store.listPoliciesForOwner(ctx.actor.orgId, ctx.actor.id)).map(
          serializePolicy,
        ),
      }),
    }),
    defineTool({
      id: "agent.defender.policy.set",
      description:
        "Create or update Agent Defender policy: allowlist or open receive, optional mail loop.",
      permission: agentDefenderAdminScope,
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(policySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.object({ policy: z.unknown() }), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (ctx.actor.type === "agent") {
          throw new Error("Agents cannot change Defender policy.");
        }
        const policy = await store.upsertPolicy({
          orgId: ctx.actor.orgId,
          actorId: input.actorId,
          ownerActorId: ctx.actor.id,
          receiveMode: parseAgentDefenderReceiveMode(input.receiveMode),
          loopEnabled: input.loopEnabled,
          allowedSenders: input.allowedSenders.map(normalizeAllowedSender).filter(Boolean),
          allowSend: input.allowSend && input.receiveMode === "allowlist",
        });
        return { policy: serializePolicy(policy) };
      },
    }),
    defineTool({
      id: "agent.defender.holds.list",
      description: "List inbound mail held for agents owned by the current operator.",
      permission: agentDefenderAdminScope,
      sideEffects: "read",
      inputSchema: zodToolSchema(holdsListSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(
        z.object({ holds: z.array(z.unknown()) }),
        genericObjectJsonSchema,
      ),
      handler: async (_input, ctx) => ({
        holds: await store.listHolds(ctx.actor.orgId, ctx.actor.id),
      }),
    }),
    defineTool({
      id: "agent.defender.holds.decide",
      description: "Release held mail to the agent inbox or junk it.",
      permission: agentDefenderAdminScope,
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(holdDecideSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(z.object({ ok: z.boolean() }), genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (ctx.actor.type === "agent") {
          throw new Error("Agents cannot decide held mail.");
        }
        const ok = await store.decideHold({
          orgId: ctx.actor.orgId,
          operatorActorId: ctx.actor.id,
          agentActorId: input.agentActorId,
          threadId: input.threadId,
          action: input.action,
        });
        return { ok };
      },
    }),
  ]) {
    registry.register(tool);
  }
}
