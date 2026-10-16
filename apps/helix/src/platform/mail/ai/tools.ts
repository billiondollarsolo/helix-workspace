import {
  mailAiSuggestionInputSchema,
  mailAiSuggestionResultSchema,
  type MailAiSuggestionInput,
} from "@helix/contracts";
import type { AICapability, Actor, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../../api/api-error.js";
import {
  deriveClassification,
  maxClassification,
  type DataClassification,
} from "../../ai/classification/index.js";
import { defineTool } from "../../tools/define-tool.js";
import { zodToolSchema } from "../../webhooks/tool-schemas.js";
import type { MailStore } from "../store.js";
import type { MailThreadDetail } from "../types.js";
import { createMailSuggestionSlotProviders } from "./suggestions.js";

export interface MailAiToolOptions {
  readonly store: Pick<MailStore, "getThread">;
  readonly ai: AICapability;
  readonly enabled: (orgId: string) => Promise<boolean>;
  readonly classifyThread: (actor: Actor, thread: MailThreadDetail) => Promise<DataClassification>;
}

export function createMailAiTools(options: MailAiToolOptions): readonly ToolDefinition[] {
  return [
    defineTool({
      id: "mail.ai.status",
      description: "Check whether your administrator enabled mail AI assistance.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}).strict(), { type: "object", properties: {} }),
      outputSchema: zodToolSchema(z.object({ enabled: z.boolean() }), {
        type: "object",
        properties: { enabled: { type: "boolean" } },
      }),
      handler: async (_input, ctx) => ({ enabled: await options.enabled(ctx.actor.orgId) }),
    }),
    defineTool({
      id: "mail.ai.suggest",
      description:
        "Draft, rewrite, suggest a reply, or summarize your mail. Reads the authorized conversation server-side. Returns text for review; never sends mail. Use mail.draft.save to save and mail.send/mail.reply with approval to send.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(mailAiSuggestionInputSchema, {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["compose", "rewrite", "reply", "summarize"] },
          threadId: { type: "string", format: "uuid" },
          subject: { type: "string", maxLength: 998 },
          body: { type: "string", maxLength: 24000 },
          instructions: { type: "string", maxLength: 2000 },
        },
      }),
      outputSchema: zodToolSchema(mailAiSuggestionResultSchema, {
        type: "object",
        properties: { text: { type: "string" }, classification: { type: "string" } },
      }),
      handler: (input, ctx) => generateMailSuggestion(options, ctx.actor, input),
    }),
  ];
}

export async function generateMailSuggestion(
  options: MailAiToolOptions,
  actor: Actor,
  input: MailAiSuggestionInput,
) {
  const providers = createMailSuggestionSlotProviders({ ai: options.ai });
  if (!(await options.enabled(actor.orgId)))
    throw new ForbiddenError(
      "Mail AI assistance is disabled. Ask an administrator to enable it in Mail settings.",
    );
  let classification = deriveClassification({
    content: [input.subject, input.body, input.instructions].join("\n"),
    scanContent: true,
  }).classification;
  let threadText = "";
  if (input.threadId !== undefined) {
    let after: string | undefined;
    do {
      const thread = await options.store.getThread({
        orgId: actor.orgId,
        actorId: actor.id,
        threadId: input.threadId,
        resourcePage: { limit: 50, ...(after === undefined ? {} : { after }) },
      });
      if (thread === null)
        throw new NotFoundError("Mail conversation was not found in your mailbox.");
      classification = maxClassification(
        classification,
        await options.classifyThread(actor, thread),
      );
      threadText +=
        `\nSubject: ${thread.subject}\n` +
        thread.messages
          .map(
            (message) =>
              `From: ${message.from?.address ?? "unknown"}\nDate: ${message.sentAt.toISOString()}\n${message.plainBody ?? message.body}`,
          )
          .join("\n\n");
      if (
        thread.bodyTruncated ||
        threadText.length > 64000 ||
        (after !== undefined && thread.nextCursor === after)
      )
        throw new BadRequestError(
          "This conversation is too large for mail assistance. Use the Assistant to review selected messages.",
        );
      after = thread.nextCursor;
    } while (after !== undefined);
  }
  const slotId =
    input.action === "summarize"
      ? "mail.summarize-thread"
      : input.action === "reply"
        ? "mail.suggest-reply"
        : "mail.compose-help";
  const provider = providers.find((entry) => entry.slotId === slotId);
  if (provider === undefined) throw new Error("Mail suggestion provider is unavailable");
  let text = "";
  for await (const chunk of provider.generate({
    actor: actor,
    feature: slotId,
    input: {
      classification,
      subject: input.subject ?? "",
      body: input.body ?? "",
      thread: threadText,
      instructions: `${input.action === "rewrite" ? "Rewrite the supplied draft, preserving its facts. " : ""}${input.instructions ?? ""}`,
    },
  }))
    text += chunk.text;
  if (!text.trim())
    throw new BadRequestError("The AI provider returned an empty suggestion. Try again.");
  return { text, classification };
}
