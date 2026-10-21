import type { ToolContext, ToolDefinition } from "@helix/sdk-types";
import { z } from "zod";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../api/api-error.js";
import { defineTool } from "../tools/define-tool.js";
import { collaborationAuthorization } from "../tools/collaboration-authorization.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import { hasHeaderBreakingCharacter } from "./outbound-format.js";
import { MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES, MailSendService } from "./outbound.js";
import { hasExternalRecipient, requireTenantMailRecipients } from "./recipient-authorization.js";
import { mailOutboundDisplayStatus } from "./reliability.js";
import {
  composeForwardBody,
  forwardSubject,
  lowerAddress,
  replyRecipients,
  replySubject,
  replyThreadingHeaders,
  selectReplyParent,
} from "./reply-context.js";
import type { MailStore } from "./store.js";
import type { CreateMailToolDefinitionsOptions } from "./tools.js";
import type {
  MailAttachmentInput,
  MailOutboundEnvelope,
  MailOutboundRecord,
  MailThreadMessage,
  MailUserSettings,
} from "./types.js";

/** Send, reply, and forward: the mail tools that put a message on the wire. */

const uuidSchema = z.string().uuid();
const emailSchema = z.string().email();
const displayNameSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !hasHeaderBreakingCharacter(value), {
    message: "Display names must not contain line breaks or NUL characters.",
  });

export const addressSchema = z.union([
  emailSchema.transform((address) => ({ address })),
  z.object({ address: emailSchema, name: displayNameSchema.optional() }),
]);

const attachmentSchema = z
  .object({
    filename: z.string().min(1).max(255).optional(),
    contentType: z.string().min(1).max(255).optional(),
    objectId: z.string().uuid(),
  })
  .strict();

const deliveryShape = {
  from: addressSchema.optional(),
  replyTo: addressSchema.optional(),
  bodyText: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z.array(attachmentSchema).max(100).default([]),
  undoWindowMs: z.number().int().min(0).max(300_000).optional(),
  sendAt: z
    .string()
    .datetime()
    .refine((value) => {
      const delay = Date.parse(value) - Date.now();
      return delay > 0 && delay <= 366 * 24 * 60 * 60_000;
    }, "Scheduled mail must be sent within the next 366 days.")
    .optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
};

const sendSchema = z.object({
  draft: z.object({ id: uuidSchema, revision: z.number().int().positive() }).optional(),
  ...deliveryShape,
  to: z.array(addressSchema).min(1),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
  subject: z.string().max(998),
});

const replySchema = z.object({
  draft: z.object({ id: uuidSchema, revision: z.number().int().positive() }).optional(),
  ...deliveryShape,
  threadId: uuidSchema,
  /** Message being answered; defaults to the latest message not sent by the caller. */
  messageId: uuidSchema.optional(),
  /** Reply to the sender plus the parent's other To/Cc recipients. */
  replyAll: z.boolean().default(false),
  /** Explicit recipients; omitted, the server derives them from the parent message. */
  to: z.array(addressSchema).default([]),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
  subject: z.string().max(998).optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
});

const forwardSchema = z.object({
  ...deliveryShape,
  bodyText: z.string().default(""),
  threadId: uuidSchema,
  /** Message to forward; required so DLP labels on it apply to the forward. */
  messageId: uuidSchema,
  to: z.array(addressSchema).min(1),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
  subject: z.string().max(998).optional(),
  /** Re-attach the original's attachments (scanned and size-limited again). */
  includeAttachments: z.boolean().default(true),
});

export const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const mailSendOutputSchema = z.object({
  id: z.string().optional(),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
  status: z.string().optional(),
  undoUntil: z.string().optional(),
  queuedAt: z.string().optional(),
});

type Address = z.output<typeof addressSchema>;
type Actor = ToolContext["actor"];

export function createMailComposeToolDefinitions(
  options: CreateMailToolDefinitionsOptions,
): readonly ToolDefinition[] {
  const internalMailAuthorization = async (
    input: {
      to: readonly { address: string }[];
      cc: readonly { address: string }[];
      bcc: readonly { address: string }[];
      replyAll?: boolean;
    },
    actor: ToolContext["actor"],
  ) => {
    const authorization = await collaborationAuthorization("mail.send")(input, actor);
    if (!authorization || input.replyAll || input.to.length === 0) return null;
    const recipients = [...input.to, ...input.cc, ...input.bcc].map((entry) => entry.address);
    return (await options.areLocalRecipients?.(actor.orgId, recipients)) === true
      ? { ...authorization, internalCommunicationOnly: true as const }
      : null;
  };
  const internalDomains = new Set(
    (
      options.internalDomains ??
      (options.defaultFromDomain === undefined ? [] : [options.defaultFromDomain])
    ).map((domain) => domain.toLowerCase()),
  );
  const externalRecipientScope = {
    scope: "mail.external",
    reason:
      "Sending mail to a recipient outside the organization's domains requires the mail.external scope.",
    when: (input: { to?: unknown; cc?: unknown; bcc?: unknown }) =>
      options.resolveInternalDomains === undefined && hasExternalRecipient(input, internalDomains),
  };
  /** Same external-recipient rule for recipients the server derived itself. */
  const requireRecipientScopes = async (
    recipients: { readonly to: unknown; readonly cc: unknown; readonly bcc: unknown },
    ctx: ToolContext,
  ) => {
    if (options.resolveInternalDomains === undefined) {
      if (hasExternalRecipient(recipients, internalDomains))
        await ctx.requirePermission("mail.external");
      return;
    }
    await requireTenantMailRecipients(recipients, ctx, options.resolveInternalDomains);
  };
  const queue = async (
    input: {
      readonly undoWindowMs?: number | undefined;
      readonly sendAt?: string | undefined;
      readonly idempotencyKey?: string | undefined;
      readonly draft?: { readonly id: string; readonly revision: number } | undefined;
    },
    ctx: ToolContext,
    rest: {
      readonly envelope: MailOutboundEnvelope;
      readonly threadId?: string;
      readonly inReplyTo?: string;
      readonly references?: readonly string[];
    },
  ) => {
    const { to, cc, bcc } = rest.envelope;
    const maxRecipients = options.maxRecipients ?? 100;
    if (to.length + cc.length + bcc.length > maxRecipients) {
      throw new BadRequestError(
        `A message can have at most ${String(maxRecipients)} recipients across To, Cc and Bcc.`,
      );
    }
    await options.sendLimit?.assertMaySend({ orgId: ctx.actor.orgId, actorId: ctx.actor.id });
    return new MailSendService({
      store: options.store,
      undoWindowMs: input.undoWindowMs ?? options.undoWindowMs ?? 30_000,
    }).queue({
      orgId: ctx.actor.orgId,
      actorId: ctx.actor.id,
      ...rest,
      ...(ctx.internalCommunicationOnly ? { envelope: { ...rest.envelope, localOnly: true } } : {}),
      ...(input.draft === undefined ? {} : { draft: input.draft }),
      ...(input.sendAt === undefined ? {} : { sendAt: new Date(input.sendAt) }),
      source: ctx.actor.type === "agent" ? "agent" : "interactive",
      // A REST Idempotency-Key header (kept across approval) counts like the input field.
      ...((input.idempotencyKey ?? ctx.idempotencyKey) === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey ?? ctx.idempotencyKey }),
    });
  };
  const classify = async (ctx: ToolContext, messageId: string, content: string) =>
    options.classifyResource?.({
      actor: ctx.actor,
      resourceType: "mail.message",
      resourceId: messageId,
      derivation: { content, scanContent: true },
    });
  const loadThread = async (ctx: ToolContext, threadId: string) => {
    const thread = await options.store.getThread({
      orgId: ctx.actor.orgId,
      actorId: ctx.actor.id,
      threadId,
    });
    if (thread === null || thread.messages.length === 0) {
      throw new NotFoundError("Mail thread not found; open a thread you can read and try again.");
    }
    return thread;
  };

  return [
    defineTool<z.output<typeof sendSchema>, unknown>({
      id: "mail.send",
      description: "Send now after the undo delay, or schedule delivery for a future time.",
      permission: "mail.send",
      sideEffects: "external_communication",
      standingAuthorization: internalMailAuthorization,
      confirmationRequired: true,
      scopeComposition: { conditionalScopes: [externalRecipientScope] },
      inputSchema: zodToolSchema(sendSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailSendOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        await requireTenantMailRecipients(input, ctx, options.resolveInternalDomains);
        const from = await authorizedFrom(input.from, ctx.actor, options);
        const settings = await mailUserSettings(options.store, ctx.actor.orgId, ctx.actor.id);
        const outbound = await queue(input, ctx, {
          envelope: applySignature(toEnvelope(input, input.subject, from), settings, false),
        });
        await classify(ctx, outbound.messageId, `${input.subject}\n${input.bodyText}`);
        return serializeOutbound(outbound);
      },
    }),
    defineTool<z.output<typeof replySchema>, unknown>({
      id: "mail.reply",
      description:
        "Reply (or reply all) in a thread after the undo delay. Recipients, In-Reply-To, and References come from the parent message unless `to` is given.",
      permission: "mail.send",
      sideEffects: "external_communication",
      standingAuthorization: internalMailAuthorization,
      confirmationRequired: true,
      scopeComposition: { conditionalScopes: [externalRecipientScope] },
      inputSchema: zodToolSchema(replySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailSendOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const thread = await loadThread(ctx, input.threadId);
        const from = await authorizedFrom(input.from, ctx.actor, options);
        const own = await ownAddresses(ctx.actor, from, options);
        const parent = selectReplyParent(thread, own, input.messageId);
        if (parent === undefined) {
          throw new NotFoundError("The message to reply to is not in this thread.");
        }
        const derived = input.replyAll || input.to.length === 0;
        if (derived && ctx.actor.type !== "user") {
          throw new BadRequestError(
            "Agents must list reply recipients in `to` (read them with mail.thread.get) so confirmation shows who receives the reply.",
          );
        }
        const computed = replyRecipients(parent, own, input.replyAll);
        const recipients = derived
          ? {
              to: dedupe([...computed.to, ...input.to]),
              cc: dedupe([...computed.cc, ...input.cc], [...computed.to, ...input.to]),
              bcc: input.bcc,
            }
          : { to: input.to, cc: input.cc, bcc: input.bcc };
        if (recipients.to.length + recipients.cc.length + recipients.bcc.length === 0) {
          throw new BadRequestError("This reply has no recipients; add one in `to`.");
        }
        await requireRecipientScopes(recipients, ctx);
        const threading = replyThreadingHeaders(parent);
        const settings = await mailUserSettings(options.store, ctx.actor.orgId, ctx.actor.id);
        const subject = input.subject ?? replySubject(parent.subject ?? thread.subject);
        const inReplyTo = threading.inReplyTo ?? input.inReplyTo;
        const outbound = await queue(input, ctx, {
          threadId: input.threadId,
          ...(inReplyTo === undefined ? {} : { inReplyTo }),
          references: threading.references.length > 0 ? threading.references : input.references,
          envelope: applySignature(
            toEnvelope({ ...input, ...recipients }, subject, from),
            settings,
            true,
          ),
        });
        await classify(ctx, outbound.messageId, `${subject}\n${input.bodyText}`);
        return serializeOutbound(outbound);
      },
    }),
    defineTool<z.output<typeof forwardSchema>, unknown>({
      id: "mail.forward",
      description:
        "Forward a message as a new thread with the quoted original and its attachments, after the undo delay.",
      permission: "mail.send",
      sideEffects: "external_communication",
      standingAuthorization: internalMailAuthorization,
      confirmationRequired: true,
      scopeComposition: { conditionalScopes: [externalRecipientScope] },
      inputSchema: zodToolSchema(forwardSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailSendOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        await requireTenantMailRecipients(input, ctx, options.resolveInternalDomains);
        const thread = await loadThread(ctx, input.threadId);
        const original = thread.messages.find((message) => message.id === input.messageId);
        if (original === undefined) {
          throw new NotFoundError("The message to forward is not in this thread.");
        }
        const from = await authorizedFrom(input.from, ctx.actor, options);
        const settings = await mailUserSettings(options.store, ctx.actor.orgId, ctx.actor.id);
        const subject = input.subject ?? forwardSubject(original.subject ?? thread.subject);
        const signed = applySignature(
          toEnvelope({ ...input, bodyText: input.bodyText }, subject, from),
          settings,
          true,
        );
        const body = composeForwardBody({
          text: signed.text,
          html: signed.html,
          original,
          subject: thread.subject,
        });
        const forwarded = input.includeAttachments
          ? await originalAttachments(options.store, ctx.actor, original)
          : [];
        const outbound = await queue(input, ctx, {
          envelope: {
            ...signed,
            text: body.text,
            html: body.html,
            attachments: [...signed.attachments, ...forwarded],
          },
        });
        await classify(ctx, outbound.messageId, `${subject}\n${body.text}`);
        return serializeOutbound(outbound);
      },
    }),
  ];
}

/** Original attachment bytes, re-staged (and re-scanned) by the outbound store. */
async function originalAttachments(
  store: MailStore,
  actor: Actor,
  original: MailThreadMessage,
): Promise<MailAttachmentInput[]> {
  if (original.attachments.length === 0) return [];
  if (store.readMessageAttachment === undefined) {
    throw new BadRequestError(
      "Forwarding attachments is unavailable here; forward with includeAttachments: false.",
    );
  }
  const attachments: MailAttachmentInput[] = [];
  for (const attachment of original.attachments) {
    const read = await store.readMessageAttachment({
      orgId: actor.orgId,
      actorId: actor.id,
      messageId: original.id,
      objectId: attachment.objectId,
      maxBytes: MAIL_MAX_OUTBOUND_ATTACHMENT_BYTES,
    });
    if (read === null) {
      throw new NotFoundError(
        `Attachment ${attachment.filename ?? attachment.objectId} is no longer available; forward without attachments.`,
      );
    }
    attachments.push({
      ...((read.filename ?? attachment.filename) === undefined
        ? {}
        : { filename: read.filename ?? attachment.filename }),
      mimeType: read.mimeType,
      contentType: read.mimeType,
      content: read.content,
      ...(read.contentId === undefined ? {} : { contentId: read.contentId }),
      disposition: read.disposition,
    });
  }
  return attachments;
}

function dedupe(list: readonly Address[], exclude: readonly Address[] = []): Address[] {
  const seen = new Set(exclude.map((entry) => lowerAddress(entry.address)));
  return list.filter((entry) => {
    const key = lowerAddress(entry.address);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Addresses that identify the caller: primary, aliases, the chosen From, and extras. */
async function ownAddresses(
  actor: Actor,
  from: MailOutboundEnvelope["from"],
  options: CreateMailToolDefinitionsOptions,
): Promise<ReadonlySet<string>> {
  const [aliases, extra] = await Promise.all([
    options.store.listAliases?.(actor.orgId, actor.id),
    options.resolveOwnAddresses?.(actor.orgId, actor.id),
  ]);
  return new Set(
    [
      from.address,
      ...(actor.email === undefined ? [] : [actor.email]),
      ...(aliases ?? []).map((alias) => alias.email),
      ...(extra ?? []),
    ].map(lowerAddress),
  );
}

function toEnvelope(
  input: {
    readonly to: readonly Address[];
    readonly cc: readonly Address[];
    readonly bcc: readonly Address[];
    readonly replyTo?: Address | undefined;
    readonly bodyText: string;
    readonly bodyHtml?: string | undefined;
    readonly attachments: readonly z.output<typeof attachmentSchema>[];
  },
  subject: string,
  from: MailOutboundEnvelope["from"],
): MailOutboundEnvelope {
  return {
    from,
    to: input.to.map(normalizeAddress),
    cc: input.cc.map(normalizeAddress),
    bcc: input.bcc.map(normalizeAddress),
    ...(input.replyTo === undefined ? {} : { replyTo: normalizeAddress(input.replyTo) }),
    subject,
    text: input.bodyText,
    ...(input.bodyHtml === undefined ? {} : { html: input.bodyHtml }),
    attachments: input.attachments.map((attachment) => ({
      ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
      mimeType: attachment.contentType ?? "application/octet-stream",
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      objectId: attachment.objectId,
    })),
  };
}

export async function mailUserSettings(
  store: MailStore,
  orgId: string,
  actorId: string,
): Promise<MailUserSettings> {
  return (
    (await store.getUserSettings?.(orgId, actorId)) ?? {
      signatureText: "",
      signatureHtml: null,
      includeSignatureOnReplies: true,
      blockedSenders: [],
      updatedAt: new Date(0),
    }
  );
}

function applySignature(
  envelope: MailOutboundEnvelope,
  settings: MailUserSettings,
  reply: boolean,
): MailOutboundEnvelope {
  if (
    (reply && !settings.includeSignatureOnReplies) ||
    (settings.signatureText.length === 0 && settings.signatureHtml === null)
  ) {
    return envelope;
  }
  const signatureHtml =
    settings.signatureHtml ??
    settings.signatureText
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;")
      .replaceAll("\n", "<br>");
  return {
    ...envelope,
    text: `${envelope.text}\n\n-- \n${settings.signatureText}`,
    ...(envelope.html === undefined
      ? {}
      : { html: `${envelope.html}<br><div class="helix-mail-signature">${signatureHtml}</div>` }),
  };
}

async function authorizedFrom(
  requested: Address | undefined,
  actor: Actor,
  options: CreateMailToolDefinitionsOptions,
): Promise<MailOutboundEnvelope["from"]> {
  const primary = actorFrom(actor, options.defaultFromDomain);
  const candidate = requested?.address ?? primary.address;
  if (options.store.resolveAuthorizedSender !== undefined) {
    const authorized = await options.store.resolveAuthorizedSender(
      actor.orgId,
      actor.id,
      candidate,
    );
    if (authorized === null) {
      throw new ForbiddenError("The requested From address is not an authorized sending identity.");
    }
    const requestedName =
      requested !== undefined && "name" in requested ? requested.name : undefined;
    return {
      address: authorized,
      ...((requestedName ?? actor.displayName) === undefined
        ? {}
        : { name: requestedName ?? actor.displayName }),
    };
  }
  if (
    requested === undefined ||
    requested.address.toLowerCase() === primary.address.toLowerCase()
  ) {
    return primary;
  }
  const alias = (await options.store.listAliases?.(actor.orgId, actor.id))?.find(
    (entry) => entry.email.toLowerCase() === requested.address.toLowerCase(),
  );
  if (alias === undefined) {
    throw new ForbiddenError("The requested From address is not an authorized sending identity.");
  }
  return {
    address: alias.email,
    ...(alias.displayName === null && actor.displayName === undefined
      ? {}
      : { name: alias.displayName ?? actor.displayName }),
  };
}

function normalizeAddress(address: {
  readonly address: string;
  readonly name?: string | undefined;
}): MailOutboundEnvelope["from"] {
  return {
    address: address.address,
    ...(address.name === undefined ? {} : { name: address.name }),
  };
}

function actorFrom(
  actor: { readonly email?: string; readonly displayName?: string; readonly id: string },
  domain?: string,
): MailOutboundEnvelope["from"] {
  return {
    address: actor.email ?? `${actor.id}@${domain ?? "localhost"}`,
    ...(actor.displayName === undefined ? {} : { name: actor.displayName }),
  };
}

export function serializeOutbound(
  outbound: Pick<
    MailOutboundRecord,
    "id" | "messageId" | "threadId" | "status" | "undoUntil" | "createdAt" | "deliveryMetadata"
  >,
) {
  return {
    id: outbound.id,
    messageId: outbound.messageId,
    threadId: outbound.threadId,
    status: outbound.status,
    deliveryStatus: mailOutboundDisplayStatus(outbound),
    undoUntil: outbound.undoUntil.toISOString(),
    queuedAt: outbound.createdAt.toISOString(),
  };
}
