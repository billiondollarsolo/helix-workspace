import { botAccountRequestSchema, botAccountApproveSchema } from "@helix/contracts";
import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { actorHasScope } from "../../api/scopes.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { BotAccountStore } from "./store.js";
import type { BotWorkspaceReader } from "./workspace.js";
const json = { type: "object", additionalProperties: true } as const;
const empty = z.object({}).strict();
const output = zodToolSchema(z.unknown(), json);
export function createBotAccountTools(
  store: BotAccountStore,
  reader: BotWorkspaceReader,
): readonly ToolDefinition[] {
  return [
    defineTool({
      id: "agent.account.request",
      description:
        "Request a persistent external bot account for administrator review. Requires a trusted installation credential with agent.accounts.request. Submit a SHA-256 hash of a locally generated 256-bit Helix API key; never submit the key. No account or key works before approval. Retry with the same externalBotId and manifest.",
      permission: "agent.accounts.request",
      sideEffects: "write",
      // Installation trust authorizes submission; only human review activates a bot.
      confirmationRequired: false,
      standingAuthorization: async (_input, actor) =>
        actor.type === "agent" && actorHasScope(actor, "agent.accounts.request")
          ? {
              id: "trusted-installation-enrollment",
              version: "1",
              requestsPerMinute: 10,
              requestsPerDay: 50,
            }
          : null,
      rateLimit: { perActor: { perHour: 10 }, perOrg: { perDay: 50 } },
      inputSchema: zodToolSchema(botAccountRequestSchema, json),
      outputSchema: output,
      handler: async (input, ctx) => {
        const request = await store.request(ctx.actor, input);
        await ctx.audit("bot.account.requested", {
          requestId: request.id,
          externalBotId: request.externalBotId,
        });
        return { request };
      },
    }),
    defineTool({
      id: "agent.account.requests.list",
      description:
        "List your account requests; human administrators can review the workspace queue. Never returns credential material.",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(empty, json),
      outputSchema: output,
      handler: async (_input, ctx) => ({ requests: await store.listRequests(ctx.actor) }),
    }),
    defineTool({
      id: "agent.account.request.get",
      description:
        "Get your account request's pending, approved, rejected or expired status and its approved account mapping. Use the pre-generated key only after approval.",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({ requestId: z.string().uuid() }).strict(), json),
      outputSchema: output,
      handler: async (input, ctx) => ({ request: await store.get(ctx.actor, input.requestId) }),
    }),
    defineTool({
      id: "agent.account.approve",
      interactiveSessionOnly: true,
      description:
        "Human Workspace administrator only: approve a pending bot account, downscope requested access and assign a human owner and verified mail address. Atomically activates its precommitted credential; creates no grants to existing users' data.",
      permission: "admin.agents",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(botAccountApproveSchema, json),
      outputSchema: output,
      handler: async (input, ctx) => {
        const request = await store.approve(ctx.actor, input);
        await ctx.audit("bot.account.approved", {
          requestId: request.id,
          botActorId: request.actorId,
          ownerActorId: request.ownerActorId,
          scopes: [...request.approvedScopes],
        });
        return { request };
      },
    }),
    defineTool({
      id: "agent.account.reject",
      description:
        "Human administrator only: reject a pending bot account request with a reason. No credential is activated.",
      permission: "admin.agents",
      sideEffects: "write",
      inputSchema: zodToolSchema(
        z
          .object({ requestId: z.string().uuid(), reason: z.string().trim().min(1).max(1000) })
          .strict(),
        json,
      ),
      outputSchema: output,
      handler: async (input, ctx) => {
        const request = await store.reject(ctx.actor, input.requestId, input.reason);
        await ctx.audit("bot.account.rejected", { requestId: request.id });
        return { request };
      },
    }),
    defineTool({
      id: "agent.workspace.list",
      description:
        "List bot workspaces you may observe. Human administrators see all tenant bots; other humans need an explicit observation grant. Does not grant control or sending authority.",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z
          .object({
            botActorId: z.string().uuid().optional(),
            offset: z.number().int().min(0).max(100000).default(0),
          })
          .strict(),
        json,
      ),
      outputSchema: output,
      handler: async (input, ctx) => {
        const bots = await store.visible(ctx.actor, input);
        return { bots: bots.slice(0, 100), hasMore: bots.length > 100 };
      },
    }),
    defineTool({
      id: "agent.workspace.access.list",
      description:
        "Human administrator only: list explicit read-only observers of one bot, including disabled people whose grants can be revoked. Administrator access is separate from these grants.",
      permission: "admin.agents",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z
          .object({
            botActorId: z.string().uuid(),
            offset: z.number().int().min(0).max(100000).default(0),
          })
          .strict(),
        json,
      ),
      outputSchema: output,
      handler: async (input, ctx) => store.observers(ctx.actor, input.botActorId, input.offset),
    }),
    defineTool({
      id: "agent.workspace.access.set",
      description:
        "Human administrator only: grant or revoke read-only observation of one bot's mail, files, chats and activity for a human in this tenant. This exposes conversations the bot participates in; grant deliberately. Does not grant bot credentials or write access.",
      permission: "admin.agents",
      sideEffects: "write",
      confirmationRequired: true,
      inputSchema: zodToolSchema(
        z
          .object({
            botActorId: z.string().uuid(),
            observerActorId: z.string().uuid(),
            enabled: z.boolean(),
          })
          .strict(),
        json,
      ),
      outputSchema: output,
      handler: async (input, ctx) => {
        await store.grant(ctx.actor, input.botActorId, input.observerActorId, input.enabled);
        await ctx.audit("bot.observer.changed", input);
        return { updated: true };
      },
    }),
    defineTool({
      id: "agent.workspace.read",
      description:
        "Read a bot's authorized mailbox, files, joined chats or activity as an approved human observer. Bounded and audited. This endpoint cannot send, modify files, change permissions or return credentials.",
      permission: "platform.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z
          .object({
            botActorId: z.string().uuid(),
            surface: z.enum(["mail", "files", "chat", "activity"]),
            threadId: z.string().uuid().optional(),
            roomId: z.string().uuid().optional(),
            query: z.string().max(320).optional(),
            offset: z.number().int().min(0).max(100000).default(0),
            cursor: z.string().max(1000).optional(),
          })
          .strict(),
        json,
      ),
      outputSchema: output,
      handler: async (input, ctx) => {
        await store.assertVisible(ctx.actor, input.botActorId);
        await ctx.audit("bot.workspace.observed", {
          botActorId: input.botActorId,
          surface: input.surface,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.roomId ? { roomId: input.roomId } : {}),
        });
        return reader.read(ctx.actor, input);
      },
    }),
  ];
}
