import {
  mailLabelColorName,
  mailLabelCreateInputSchema,
  mailLabelDeleteInputSchema,
  mailLabelDeleteResultSchema,
  mailLabelResultSchema,
  mailLabelUpdateInputSchema,
  mailScheduledCancelInputSchema,
  mailScheduledCancelResultSchema,
  mailScheduledListInputSchema,
  mailScheduledListResultSchema,
  mailScheduledRescheduleInputSchema,
  mailScheduledRescheduleResultSchema,
} from "@helix/contracts";
import { isJsonObject, type JsonObject, type ToolDefinition } from "@helix/sdk-types";
import type { z } from "zod";
import { BadRequestError } from "../../api/api-error.js";
import { defineTool } from "../tools/define-tool.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { MailStore } from "./store.js";
import { genericObjectJsonSchema } from "./tools-compose.js";
import type { MailLabelRecord, MailScheduledSendRecord } from "./types.js";

/** Scheduled sends stay within the window MailSendService accepts. */
const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60_000;

export function serializeLabel(label: MailLabelRecord) {
  return {
    id: label.id,
    slug: label.slug,
    name: label.name,
    color: label.color,
    colorName: mailLabelColorName(label.color),
    parentId: label.parentId,
    sortOrder: label.sortOrder,
    threadCount: label.threadCount,
    unreadCount: label.unreadCount,
    shared: label.ownerActorId === null,
    createdAt: label.createdAt.toISOString(),
    updatedAt: label.updatedAt.toISOString(),
  };
}

function serializeScheduled(send: MailScheduledSendRecord) {
  return {
    outboundId: send.outboundId,
    threadId: send.threadId,
    messageId: send.messageId,
    subject: send.subject,
    preview: send.preview,
    to: send.to.map(({ address, name }) => ({ address, ...(name === undefined ? {} : { name }) })),
    cc: send.cc.map(({ address, name }) => ({ address, ...(name === undefined ? {} : { name }) })),
    bcc: send.bcc.map(({ address, name }) => ({
      address,
      ...(name === undefined ? {} : { name }),
    })),
    hasAttachment: send.hasAttachment,
    sendAt: send.sendAt.toISOString(),
    createdAt: send.createdAt.toISOString(),
  };
}

type OptionalMailCapability =
  "createLabel" | "updateLabel" | "deleteLabel" | "listScheduledSends" | "rescheduleSend";

function capability<K extends OptionalMailCapability>(
  store: MailStore,
  name: K,
): NonNullable<MailStore[K]> {
  const method = store[name];
  if (method === undefined) throw new BadRequestError(`Mail ${name} is not available.`);
  return method.bind(store) as NonNullable<MailStore[K]>;
}

/** Personal label management and the Scheduled view. */
export function createMailLabelAndScheduleToolDefinitions(options: {
  readonly store: MailStore;
}): readonly ToolDefinition[] {
  const { store } = options;
  return [
    defineTool<z.output<typeof mailLabelCreateInputSchema>, unknown>({
      id: "mail.label.create",
      description:
        "Create a personal mail label with a palette colour, optionally nested under another of your labels.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailLabelCreateInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailLabelResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const label = await capability(
          store,
          "createLabel",
        )({
          orgId: ctx.actor.orgId,
          actorId: input.mailboxActorId ?? ctx.actor.id,
          name: input.name,
          color: input.color,
          parentId: input.parentId,
        });
        await ctx.audit("mail.label.created", { labelId: label.id, parentId: label.parentId });
        return { label: serializeLabel(label) };
      },
    }),
    defineTool<z.output<typeof mailLabelUpdateInputSchema>, unknown>({
      id: "mail.label.update",
      description:
        "Rename, recolour or move (parentId; null for top level) one of your personal mail labels.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailLabelUpdateInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailLabelResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const label = await capability(
          store,
          "updateLabel",
        )({
          orgId: ctx.actor.orgId,
          actorId: input.mailboxActorId ?? ctx.actor.id,
          id: input.id,
          name: input.name,
          color: input.color,
          parentId: input.parentId,
        });
        await ctx.audit("mail.label.updated", { labelId: label.id, parentId: label.parentId });
        return { label: serializeLabel(label) };
      },
    }),
    defineTool<z.output<typeof mailLabelDeleteInputSchema>, unknown>({
      id: "mail.label.delete",
      description:
        "Delete one of your personal mail labels and its nested labels. Threads keep their mail; only the labels are removed.",
      permission: "mail.write",
      sideEffects: "destructive",
      confirmationRequired: true,
      inputSchema: zodToolSchema(mailLabelDeleteInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailLabelDeleteResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const deletedIds = await capability(
          store,
          "deleteLabel",
        )({
          orgId: ctx.actor.orgId,
          actorId: input.mailboxActorId ?? ctx.actor.id,
          id: input.id,
        });
        await ctx.audit("mail.label.deleted", { labelId: input.id, deletedIds: [...deletedIds] });
        return { deletedIds: [...deletedIds] };
      },
    }),
    defineTool<z.output<typeof mailScheduledListInputSchema>, unknown>({
      id: "mail.scheduled.list",
      description: "List your sends scheduled for later, soonest first.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(mailScheduledListInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailScheduledListResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await capability(
          store,
          "listScheduledSends",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          limit: input.limit,
          offset: input.offset,
        });
        return { scheduled: result.scheduled.map(serializeScheduled), total: result.total };
      },
    }),
    defineTool<z.output<typeof mailScheduledRescheduleInputSchema>, unknown>({
      id: "mail.scheduled.reschedule",
      description:
        "Change when a scheduled send goes out. Returns null when it already started sending or was cancelled.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailScheduledRescheduleInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailScheduledRescheduleResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const sendAt = new Date(input.sendAt);
        const ahead = sendAt.getTime() - Date.now();
        if (ahead <= 0 || ahead > MAX_SCHEDULE_AHEAD_MS)
          throw new BadRequestError("Choose a send time in the future, within the next 366 days.");
        const scheduled = await capability(
          store,
          "rescheduleSend",
        )({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          outboundId: input.outboundId,
          sendAt,
        });
        return { scheduled: scheduled === null ? null : serializeScheduled(scheduled) };
      },
    }),
    defineTool<z.output<typeof mailScheduledCancelInputSchema>, unknown>({
      id: "mail.scheduled.cancel",
      description:
        "Cancel a scheduled send and return it to Drafts so it can be edited and sent again.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailScheduledCancelInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailScheduledCancelResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (store.saveDraft === undefined || store.discardDraft === undefined) {
          throw new BadRequestError("Draft persistence is not available.");
        }
        const mailbox = { orgId: ctx.actor.orgId, actorId: ctx.actor.id };
        const pending = (
          await capability(store, "listScheduledSends")({ ...mailbox, limit: 200, offset: 0 })
        ).scheduled.find((send) => send.outboundId === input.outboundId);
        if (pending === undefined) return { cancelled: false, draftId: null };
        // Save the draft first so a cancelled send is never lost.
        const attachments = draftAttachments(pending.envelope);
        const draft = await store.saveDraft({
          ...mailbox,
          threadId: pending.threadId,
          idempotencyKey: input.outboundId,
          attachmentObjectIds: attachments.map(({ objectId }) => objectId),
          envelope: draftEnvelope(pending, attachments),
        });
        const cancelled = await store.cancelOutbound({ ...mailbox, id: input.outboundId });
        if (cancelled === null) {
          await store.discardDraft({ ...mailbox, id: draft.id });
          return { cancelled: false, draftId: null };
        }
        return { cancelled: true, draftId: draft.id };
      },
    }),
  ];
}

interface DraftAttachment {
  readonly objectId: string;
  readonly filename?: string;
  readonly contentType?: string;
}

function draftAttachments(envelope: JsonObject): readonly DraftAttachment[] {
  if (!Array.isArray(envelope.attachments)) return [];
  return envelope.attachments.flatMap((attachment): DraftAttachment[] => {
    if (!isJsonObject(attachment)) return [];
    const { objectId, filename, contentType } = attachment;
    if (typeof objectId !== "string") return [];
    return [
      {
        objectId,
        ...(typeof filename === "string" ? { filename } : {}),
        ...(typeof contentType === "string" ? { contentType } : {}),
      },
    ];
  });
}

/** The draft shape `mail.draft.save` stores, rebuilt from a scheduled envelope. */
function draftEnvelope(
  send: MailScheduledSendRecord,
  attachments: readonly DraftAttachment[],
): JsonObject {
  const envelope = send.envelope;
  return {
    ...(typeof envelope.from === "object" && envelope.from !== null ? { from: envelope.from } : {}),
    to: send.to,
    cc: send.cc,
    bcc: send.bcc,
    subject: send.subject,
    bodyText: typeof envelope.text === "string" ? envelope.text : "",
    ...(typeof envelope.html === "string" ? { bodyHtml: envelope.html } : {}),
    attachments: attachments.map((attachment) => ({ ...attachment })),
  };
}
