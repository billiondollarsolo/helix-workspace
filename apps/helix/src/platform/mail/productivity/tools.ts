import {
  mailFollowUpSetSchema,
  mailMeetingBriefInputSchema,
  mailProductivityPreferencesSchema,
  mailFilterCriteriaSchema,
} from "@helix/contracts";
import type { ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { defineTool } from "../../tools/define-tool.js";
import { zodToolSchema } from "../../webhooks/tool-schemas.js";
import type { MailProductivityService } from "./service.js";
import { fileMailAttachment } from "./filing.js";
const json = { type: "object", additionalProperties: true } as const;
const empty = z.object({}).strict();
const output = zodToolSchema(z.unknown(), json);

export function createMailProductivityTools(
  service: MailProductivityService,
): readonly ToolDefinition[] {
  return [
    defineTool({
      id: "mail.productivity.settings.get",
      description: "Read your optional mail automation preferences; background AI defaults off.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(empty, json),
      outputSchema: output,
      handler: async (_input, ctx) => ({
        settings: await service.options.store.preferences(ctx.actor),
        aiEnabled: await service.options.enabled(ctx.actor.orgId),
      }),
    }),
    defineTool({
      id: "mail.productivity.settings.set",
      description:
        "Set your own background mail preferences. Human accounts only; does not enable administrator-disabled AI or send mail.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailProductivityPreferencesSchema, json),
      outputSchema: output,
      handler: (input, ctx) => service.savePreferences(ctx.actor, input),
    }),
    defineTool({
      id: "mail.followup.set",
      description:
        "Mark an authorized conversation automatic, needs_reply, waiting_on or done. Requires its latest delivered message ID; conflicts if new mail arrived. Use mail.threads.list query is:needs-reply, is:waiting-on or is:overdue.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailFollowUpSetSchema, json),
      outputSchema: output,
      handler: async (input, ctx) => {
        await service.options.store.followUp(ctx.actor, input);
        return { updated: true };
      },
    }),
    defineTool({
      id: "mail.reply.prepare",
      description:
        "Prepare a private AI reply suggestion for a conversation, without editing human drafts or sending mail. Cached for the latest source message; review before use.",
      permission: "mail.write",
      scopeComposition: { requiredScopes: ["mail.read"] },
      sideEffects: "write",
      inputSchema: zodToolSchema(z.object({ threadId: z.string().uuid() }).strict(), json),
      outputSchema: output,
      handler: (input, ctx) => service.prepareReply(ctx.actor, input.threadId),
    }),
    defineTool({
      id: "mail.productivity.artifacts.list",
      description:
        "List your current prepared replies and attachment filing results. Access and source freshness are checked again.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(empty, json),
      outputSchema: output,
      handler: async (_input, ctx) => ({ artifacts: await service.visibleArtifacts(ctx.actor) }),
    }),
    defineTool({
      id: "mail.filter.propose",
      description:
        "Convert a plain-English instruction into a validated, reviewable mail-filter proposal. Does not save or enable a rule. Unsupported actions are rejected.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z.object({ instructions: z.string().trim().min(1).max(2000) }).strict(),
        json,
      ),
      outputSchema: output,
      handler: (input, ctx) => service.proposeRule(ctx.actor, input.instructions),
    }),
    defineTool({
      id: "mail.filter.preview",
      description:
        "Preview structured filter criteria using the same matcher as inbound mail. Samples the latest 50 conversations; reports truncation. Does not change mail.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(
        z.object({ criteria: mailFilterCriteriaSchema.strict() }).strict(),
        json,
      ),
      outputSchema: output,
      handler: (input, ctx) => service.previewRule(ctx.actor, input.criteria),
    }),
    defineTool({
      id: "mail.attachment.file",
      description:
        "Copy one authorized, scanned email attachment into a writable Drive folder. Preserves source mail and existing destination permissions; idempotent per source and folder. Never creates sharing grants.",
      permission: "drive.write",
      scopeComposition: { requiredScopes: ["mail.read"] },
      sideEffects: "write",
      inputSchema: zodToolSchema(
        z
          .object({
            threadId: z.string().uuid(),
            messageId: z.string().uuid(),
            objectId: z.string().uuid(),
            folderId: z.string().uuid(),
          })
          .strict(),
        json,
      ),
      outputSchema: output,
      handler: (input, ctx) => fileMailAttachment(service, ctx.actor, input),
    }),
    defineTool({
      id: "mail.meeting.brief",
      description:
        "Prepare a private meeting brief from an authorized calendar event and up to five explicitly selected mail threads. Uses optional Mail AI; does not publish or send it.",
      permission: "mail.read",
      scopeComposition: { requiredScopes: ["calendar.read"] },
      sideEffects: "write",
      inputSchema: zodToolSchema(mailMeetingBriefInputSchema, json),
      outputSchema: output,
      handler: (input, ctx) => service.meetingBrief(ctx.actor, input.eventId, input.threadIds),
    }),
    defineTool({
      id: "mail.action.digest",
      description:
        "Get a private structured digest of reply candidates, waiting conversations, upcoming meetings and the approval inbox link. No AI provider required; nothing is sent.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(empty, json),
      outputSchema: output,
      handler: (_input, ctx) => service.digest(ctx.actor),
    }),
  ];
}
