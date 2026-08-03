import { randomUUID } from "node:crypto";
import type { JsonObject, ToolDefinition } from "@helix/sdk-types";
import {
  mailAliasCreateInputSchema,
  mailAliasDeleteInputSchema,
  mailAliasListResultSchema,
  mailAliasSchema,
  mailDraftDiscardInputSchema,
  mailDraftDiscardResultSchema,
  mailDraftGetInputSchema,
  mailDraftListResultSchema,
  mailDraftSaveInputSchema,
  mailDraftSchema,
  mailFilterSchema,
  mailFiltersListResultSchema,
  mailOutboundCancelInputSchema,
  mailOutboundCancelResultSchema,
  mailOutboundRetryInputSchema,
  mailOutboundRetryResultSchema,
  mailSpamInputSchema,
  mailSpamResultSchema,
  mailThreadsListResultSchema,
} from "@helix/contracts";
import { z } from "zod3";
import type { RuntimeToolRegistry } from "../tool-registry.js";
import { zodToolSchema } from "../webhooks/tool-schemas.js";
import type { ResourceClassifier } from "../../api/classify-resource.js";
import { BadRequestError } from "../../api/api-error.js";
import type { MailStore } from "./store.js";
import { MailFilterNotFoundError, MailInboundActorForbiddenError } from "./errors.js";
import { ingestRawMail, MailauthAuthenticator, type MailAuthenticator } from "./ingest.js";
import { MailSendService } from "./outbound.js";
import { MAIL_CATEGORY_TABS } from "./category.js";
import type {
  MailFilterActions,
  MailFilterCriteria,
  MailFolderSummary,
  MailLabelRecord,
  MailOutboundEnvelope,
  MailOutboundRecord,
  MailThreadRowRecord,
} from "./types.js";
import { MAIL_FOLDER_IDS } from "./types.js";
import { mailOutboundDisplayStatus } from "./reliability.js";

// ponytail: tools.ts is the mail tool surface (~1100 LOC). Split draft/alias
// tool groups into tools-drafts.ts / tools-aliases.ts when next expanding (G9).

const uuidSchema = z.string().uuid();
const emailSchema = z.string().email();

const addressSchema = z.union([
  emailSchema.transform((address) => ({ address })),
  z.object({
    address: emailSchema,
    name: z.string().min(1).optional(),
  }),
]);

const attachmentSchema = z.object({
  filename: z.string().min(1).optional(),
  contentType: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  objectId: z.string().uuid().optional(),
  path: z.string().min(1).optional(),
});

const sendSchema = z.object({
  from: addressSchema.optional(),
  to: z.array(addressSchema).min(1),
  cc: z.array(addressSchema).default([]),
  bcc: z.array(addressSchema).default([]),
  subject: z.string().max(998),
  bodyText: z.string(),
  bodyHtml: z.string().optional(),
  attachments: z.array(attachmentSchema).default([]),
  undoWindowMs: z.number().int().min(0).max(300_000).optional(),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

const headerValueSchema = z
  .string()
  .max(998)
  .refine((value) => !/[\r\n]/u.test(value), {
    message: "Header values must not contain line breaks.",
  });

const inboundAcceptSchema = z.object({
  messageId: headerValueSchema.optional(),
  from: addressSchema,
  to: z.array(addressSchema).min(1),
  cc: z.array(addressSchema).default([]),
  subject: headerValueSchema.default(""),
  bodyText: z.string(),
  receivedAt: z.string().datetime().optional(),
  remoteAddress: z.string().min(1).optional(),
  helo: headerValueSchema.optional(),
});

const replySchema = sendSchema.omit({ subject: true }).extend({
  threadId: uuidSchema,
  subject: z.string().max(998).optional(),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
});

const labelApplySchema = z.object({
  threadId: uuidSchema,
  add: z.array(z.string().min(1)).default([]),
  remove: z.array(z.string().min(1)).default([]),
});

const threadIdSchema = z.object({ threadId: uuidSchema });

const snoozeSchema = z.object({
  threadId: uuidSchema,
  until: z.string().datetime(),
});

const readStateSchema = z.object({
  threadId: uuidSchema,
  unread: z.boolean().default(false),
});

const starStateSchema = z.object({
  threadId: uuidSchema,
  starred: z.boolean(),
});

const spamSchema = mailSpamInputSchema;

const filterCriteriaSchema = z.object({
  fromContains: z.string().min(1).optional(),
  toContains: z.string().min(1).optional(),
  subjectContains: z.string().min(1).optional(),
  bodyContains: z.string().min(1).optional(),
  hasAttachment: z.boolean().optional(),
});

const filterActionsSchema = z.object({
  applyLabels: z.array(z.string().min(1)).optional(),
  archive: z.boolean().optional(),
  delete: z.boolean().optional(),
  snoozeUntil: z.string().datetime().optional(),
});

const filterCreateSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(100),
  criteria: filterCriteriaSchema.default({}),
  actions: filterActionsSchema.default({}),
});

const filterUpdateSchema = filterCreateSchema.partial().extend({ id: uuidSchema });
const filterDeleteSchema = z.object({ id: uuidSchema });

const vacationGetSchema = z.object({});
const vacationSetSchema = z
  .object({
    enabled: z.boolean(),
    subject: z.string().max(998).default("Out of office"),
    body: z.string().default(""),
    startsAt: z.string().datetime().nullable().default(null),
    endsAt: z.string().datetime().nullable().default(null),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .refine(
    (input) =>
      input.startsAt === null ||
      input.endsAt === null ||
      new Date(input.startsAt) <= new Date(input.endsAt),
    { message: "startsAt must be before or equal to endsAt", path: ["endsAt"] },
  );

const searchSchema = z.object({
  query: z.string().optional(),
  labels: z.array(z.string().min(1)).default([]),
  limit: z.number().int().positive().max(100).default(50),
});

const outboundGetSchema = z.object({
  id: z.string().min(1),
});

const folderEnum = z.enum(MAIL_FOLDER_IDS);
const categoryEnum = z.enum(MAIL_CATEGORY_TABS);

const threadsListSchema = z.object({
  folder: folderEnum.default("inbox"),
  tab: categoryEnum.optional(),
  label: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

const foldersListSchema = z.object({});
const labelsListSchema = z.object({});

const genericObjectJsonSchema = {
  type: "object",
  additionalProperties: true,
} as const;

const mailOkThreadSchema = z.object({
  ok: z.literal(true),
  threadId: z.string(),
});
const mailOkThreadUnreadSchema = mailOkThreadSchema.extend({
  unread: z.boolean(),
});
const mailOkThreadStarredSchema = mailOkThreadSchema.extend({
  starred: z.boolean(),
});
const mailOkThreadSnoozedSchema = mailOkThreadSchema.extend({
  snoozedUntil: z.string(),
});
const mailJsonObjectSchema = z.object({}).passthrough();
const mailThreadGetOutputSchema = z.object({
  thread: mailJsonObjectSchema.nullable(),
});
const mailSearchHitsOutputSchema = z.object({
  hits: z.array(mailJsonObjectSchema),
});
const mailFoldersListOutputSchema = z.object({
  folders: z.array(mailJsonObjectSchema),
});
const mailLabelsListOutputSchema = z.object({
  labels: z.array(mailJsonObjectSchema),
});
const mailVacationOutputSchema = mailJsonObjectSchema.nullable();
const mailOutboundGetOutputSchema = z.object({
  outbound: mailJsonObjectSchema.nullable(),
});
const mailSendOutputSchema = z.object({
  id: z.string().optional(),
  messageId: z.string().optional(),
  threadId: z.string().optional(),
  status: z.string().optional(),
  undoUntil: z.string().optional(),
  queuedAt: z.string().optional(),
});
const mailFilterDeleteOutputSchema = z.object({
  id: z.string(),
  deleted: z.boolean(),
});
const mailInboundAcceptOutputSchema = z.object({
  ok: z.literal(true),
  threadId: z.string(),
  messageId: z.string(),
  attachmentObjectIds: z.array(z.string()),
  subject: z.string(),
  receivedAt: z.string(),
  auth: mailJsonObjectSchema,
  filterResult: mailJsonObjectSchema.optional(),
});
const mailLabelApplyOutputSchema = z.object({
  ok: z.literal(true),
  threadId: z.string(),
});
const mailAliasDeleteOutputSchema = z.object({
  deleted: z.boolean(),
});

export interface CreateMailToolDefinitionsOptions {
  readonly store: MailStore;
  readonly defaultFromDomain?: string;
  readonly undoWindowMs?: number;
  /**
   * Domains considered internal to the organization. A `mail.send` / `mail.reply`
   * call addressing any recipient (to/cc/bcc) outside these domains additionally
   * requires the `mail.external` composite scope (PRD §9.4). When omitted,
   * `defaultFromDomain` is used as the sole internal domain.
   */
  readonly internalDomains?: readonly string[];
  /**
   * Auto-classifies newly sent mail messages (PRD §8.4). When provided, the
   * `mail.send` / `mail.reply` handlers classify the resulting message from
   * its subject and body. Best-effort: classification never fails the send.
   */
  readonly classifyResource?: ResourceClassifier;
  /**
   * Authenticator used by the `mail.inbound.accept` bridge tool to verify
   * SPF/DKIM/DMARC on incoming RFC822. Defaults to the real
   * {@link MailauthAuthenticator}; tests inject a fake to control the
   * verification *result* (never to bypass authentication). The result is
   * persisted on the stored message and drives downstream spam/quarantine
   * decisions — a `fail`/`softfail`/`temperror` verdict does NOT drop the
   * message, but it is recorded so the From header is not trusted.
   */
  readonly inboundAuthenticator?: MailAuthenticator;
}

/** Lower-cased domain portion of an email address, or "" when unparseable. */
function addressDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? "" : address.slice(at + 1).toLowerCase();
}

/**
 * True when any recipient of a send/reply call addresses a domain outside the
 * configured internal-domain set. Used to gate the `mail.external` scope.
 */
function hasExternalRecipient(
  input: { readonly to?: unknown; readonly cc?: unknown; readonly bcc?: unknown },
  internalDomains: ReadonlySet<string>,
): boolean {
  const recipients = [input.to, input.cc, input.bcc]
    .flatMap((group): unknown[] => (Array.isArray(group) ? (group as unknown[]) : []))
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (entry !== null && typeof entry === "object" && "address" in entry) {
        const address = (entry as { address?: unknown }).address;
        return typeof address === "string" ? address : "";
      }
      return "";
    })
    .filter((address) => address.length > 0);
  return recipients.some((address) => {
    const domain = addressDomain(address);
    return domain.length > 0 && !internalDomains.has(domain);
  });
}

export function createMailToolDefinitions(
  options: CreateMailToolDefinitionsOptions,
): readonly ToolDefinition[] {
  const sendService = new MailSendService({
    store: options.store,
    ...(options.undoWindowMs === undefined ? {} : { undoWindowMs: options.undoWindowMs }),
  });

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
      hasExternalRecipient(input, internalDomains),
  };

  return [
    defineTool<z.output<typeof sendSchema>, unknown>({
      id: "mail.send",
      description: "Send an email on behalf of the user after the undo-send delay.",
      permission: "mail.send",
      sideEffects: "external_communication",
      confirmationRequired: true,
      scopeComposition: { conditionalScopes: [externalRecipientScope] },
      rateLimit: { perActor: { perHour: 60, perDay: 200 } },
      inputSchema: zodToolSchema(sendSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailSendOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const outbound = await new MailSendService({
          store: options.store,
          undoWindowMs: input.undoWindowMs ?? options.undoWindowMs ?? 30_000,
        }).queue({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          envelope: toEnvelope(input, actorFrom(ctx.actor, options.defaultFromDomain)),
          source: ctx.actor.type === "agent" ? "agent" : "interactive",
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
        });
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "mail.message",
          resourceId: outbound.messageId,
          derivation: { content: `${input.subject}\n${input.bodyText}`, scanContent: true },
        });
        return serializeOutbound(outbound);
      },
    }),
    defineTool<z.output<typeof replySchema>, unknown>({
      id: "mail.reply",
      description: "Reply to an existing mail thread after the undo-send delay.",
      permission: "mail.send",
      sideEffects: "external_communication",
      confirmationRequired: true,
      scopeComposition: { conditionalScopes: [externalRecipientScope] },
      inputSchema: zodToolSchema(replySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailSendOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const outbound = await sendService.queue({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          references: input.references,
          source: ctx.actor.type === "agent" ? "agent" : "interactive",
          ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
          envelope: toEnvelope(
            {
              ...input,
              subject: input.subject ?? "Re:",
            },
            actorFrom(ctx.actor, options.defaultFromDomain),
          ),
        });
        await options.classifyResource?.({
          actor: ctx.actor,
          resourceType: "mail.message",
          resourceId: outbound.messageId,
          derivation: {
            content: `${input.subject ?? "Re:"}\n${input.bodyText}`,
            scanContent: true,
          },
        });
        return serializeOutbound(outbound);
      },
    }),
    defineTool<z.output<typeof inboundAcceptSchema>, unknown>({
      id: "mail.inbound.accept",
      description:
        "Accept an inbound RFC822 payload on behalf of the SMTP receiver. " +
        "Service-only: requires the `mail.system` scope and a service-account / " +
        "system actor. SPF/DKIM/DMARC are always verified against the raw " +
        "message; the verification result is persisted on the stored message " +
        "and used downstream — auth failures do not drop the message but do " +
        "mean the From header is not trusted.",
      // CRITICAL-4 (REVIEW.md): previously `mail.write` — any user could
      // forge inbound mail. Now `mail.system`, a service-only scope that is
      // explicitly NOT in agentCredentialScopeCatalog or
      // appPasswordScopeCatalog (see scope-catalog.ts).
      permission: "mail.system",
      sideEffects: "write",
      confirmationRequired: false,
      inputSchema: zodToolSchema(inboundAcceptSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailInboundAcceptOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        // Defence-in-depth: the `mail.system` scope is itself service-only,
        // but a misconfigured token granted to a user actor MUST still be
        // rejected. SPF/DKIM/DMARC fakery is no longer possible — see below.
        if (ctx.actor.type !== "service_account" && ctx.actor.type !== "system") {
          throw new MailInboundActorForbiddenError(ctx.actor.type);
        }
        const receivedAt = input.receivedAt === undefined ? new Date() : new Date(input.receivedAt);
        const raw = structuredInboundInputToRfc822(input, receivedAt);
        // Always verify with the real authenticator (MailauthAuthenticator by
        // default). Tests may inject a fake to control the *result*, but the
        // verification step itself is unskippable.
        const authenticator = options.inboundAuthenticator ?? new MailauthAuthenticator();
        const result = await ingestRawMail({
          store: options.store,
          input: {
            orgId: ctx.actor.orgId,
            raw,
            envelopeFrom: input.from.address,
            envelopeTo: input.to.map((recipient) => recipient.address),
            ...(input.remoteAddress === undefined ? {} : { remoteAddress: input.remoteAddress }),
            ...(input.helo === undefined ? {} : { helo: input.helo }),
            receivedAt,
          },
          authenticator,
        });
        return {
          ok: true,
          threadId: result.stored.threadId,
          messageId: result.stored.messageId,
          attachmentObjectIds: [...result.stored.attachmentObjectIds],
          subject: input.subject,
          receivedAt: receivedAt.toISOString(),
          auth: result.auth,
          filterResult: result.filterResult,
        };
      },
    }),
    defineTool<z.output<typeof labelApplySchema>, unknown>({
      id: "mail.label.apply",
      description: "Apply or remove labels on a mail thread.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(labelApplySchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailLabelApplyOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        await options.store.updateThreadState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          patch: { addLabels: input.add, removeLabels: input.remove },
        });
        return { ok: true, threadId: input.threadId };
      },
    }),
    threadStateTool("mail.archive", "Archive a mail thread.", "mail.write", async (input, ctx) => {
      await options.store.updateThreadState({
        orgId: ctx.actor.orgId,
        actorId: ctx.actor.id,
        threadId: input.threadId,
        patch: { archivedAt: new Date() },
      });
      return { ok: true, threadId: input.threadId };
    }),
    threadStateTool(
      "mail.delete",
      "Move a mail thread to trash.",
      "mail.write",
      async (input, ctx) => {
        await options.store.updateThreadState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          patch: { deletedAt: new Date() },
        });
        return { ok: true, threadId: input.threadId };
      },
    ),
    defineTool<z.output<typeof spamSchema>, z.output<typeof mailSpamResultSchema>>({
      id: "mail.spam",
      description:
        "Mark or unmark a mail thread as spam (Not spam when spam:false). Writes durable feedback.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(spamSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailSpamResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const spamAt = input.spam ? new Date() : null;
        await options.store.updateThreadState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          patch: { spamAt },
        });
        if (options.store.recordSpamFeedback !== undefined) {
          await options.store.recordSpamFeedback({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            threadId: input.threadId,
            label: input.spam ? "spam" : "ham",
            source: "user",
            evidence: { via: "mail.spam", spam: input.spam },
          });
        }
        return {
          ok: true as const,
          threadId: input.threadId,
          spamAt: spamAt === null ? null : spamAt.toISOString(),
        };
      },
    }),
    defineTool<z.output<typeof threadIdSchema>, unknown>({
      id: "mail.thread.get",
      description: "Fetch one visible mail thread with its message stack.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(threadIdSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailThreadGetOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const thread = await options.store.getThread({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
        });
        return { thread: thread === null ? null : serializeThread(thread) };
      },
    }),
    defineTool<z.output<typeof readStateSchema>, unknown>({
      id: "mail.read.set",
      description: "Mark a mail thread read or unread for the current user.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(readStateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailOkThreadUnreadSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        await options.store.updateThreadState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          patch: { readAt: input.unread ? null : new Date() },
        });
        return { ok: true, threadId: input.threadId, unread: input.unread };
      },
    }),
    defineTool<z.output<typeof starStateSchema>, unknown>({
      id: "mail.star.set",
      description: "Star or unstar a mail thread for the current user.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(starStateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailOkThreadStarredSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        await options.store.updateThreadState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          patch: { starred: input.starred },
        });
        return { ok: true, threadId: input.threadId, starred: input.starred };
      },
    }),
    defineTool<z.output<typeof snoozeSchema>, unknown>({
      id: "mail.snooze",
      description: "Snooze a mail thread until a future date.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(snoozeSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailOkThreadSnoozedSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        await options.store.updateThreadState({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          threadId: input.threadId,
          patch: { snoozedUntil: new Date(input.until) },
        });
        return { ok: true, threadId: input.threadId, snoozedUntil: input.until };
      },
    }),
    defineTool<Record<string, never>, z.output<typeof mailFiltersListResultSchema>>({
      id: "mail.filter.list",
      description: "List mail filters for the current actor.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}).default({}), genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailFiltersListResultSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => {
        const filters = await options.store.listFilters(ctx.actor.orgId, ctx.actor.id);
        return { filters: filters.map(serializeFilter) };
      },
    }),
    defineTool<z.output<typeof filterCreateSchema>, z.output<typeof mailFilterSchema>>({
      id: "mail.filter.create",
      description: "Create a mail filter.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(filterCreateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailFilterSchema, genericObjectJsonSchema),
      handler: async (input, ctx) =>
        serializeFilter(
          await options.store.createFilter({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            name: input.name,
            enabled: input.enabled,
            priority: input.priority,
            criteria: normalizeCriteria(input.criteria),
            actions: normalizeActions(input.actions),
          }),
        ),
    }),
    defineTool<z.output<typeof filterUpdateSchema>, z.output<typeof mailFilterSchema>>({
      id: "mail.filter.update",
      description: "Update a mail filter.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(filterUpdateSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailFilterSchema, genericObjectJsonSchema),
      handler: async ({ id, ...patch }, ctx) => {
        const filter = await options.store.updateFilter({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          id,
          patch: normalizeFilterPatch(patch),
        });
        if (filter === null) {
          throw new MailFilterNotFoundError(id);
        }
        return serializeFilter(filter);
      },
    }),
    defineTool<z.output<typeof filterDeleteSchema>, unknown>({
      id: "mail.filter.delete",
      description: "Delete a mail filter.",
      permission: "mail.write",
      sideEffects: "destructive",
      inputSchema: zodToolSchema(filterDeleteSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailFilterDeleteOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        deleted: await options.store.deleteFilter({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          id: input.id,
        }),
      }),
    }),
    defineTool<z.output<typeof vacationGetSchema>, unknown>({
      id: "mail.vacation.get",
      description: "Fetch the current user's mail vacation auto-responder settings.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(vacationGetSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailVacationOutputSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => {
        const vacation = await options.store.getVacation(ctx.actor.orgId, ctx.actor.id);
        return { vacation: vacation === null ? null : serializeVacation(vacation) };
      },
    }),
    defineTool<z.output<typeof vacationSetSchema>, unknown>({
      id: "mail.vacation.set",
      description: "Set the current user's mail vacation auto-responder settings.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(vacationSetSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailVacationOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        vacation: serializeVacation(
          await options.store.setVacation({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            enabled: input.enabled,
            subject: input.subject,
            body: input.body,
            startsAt: input.startsAt === null ? null : new Date(input.startsAt),
            endsAt: input.endsAt === null ? null : new Date(input.endsAt),
            metadata: normalizeMetadata(input.metadata),
          }),
        ),
      }),
    }),
    defineTool<z.output<typeof searchSchema>, unknown>({
      id: "mail.search",
      description: "Search mail visible to the current actor.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(searchSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailSearchHitsOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => ({
        hits: (
          await options.store.search({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            query: input.query,
            labels: input.labels,
            limit: input.limit,
          })
        ).map((hit) => ({
          ...hit,
          sentAt: hit.sentAt.toISOString(),
        })),
      }),
    }),
    defineTool<z.output<typeof threadsListSchema>, unknown>({
      id: "mail.threads.list",
      description:
        "List mail threads for a folder view (Inbox/Starred/Snoozed/Sent/Drafts/Archive/Trash), optionally filtered by category tab, label, and query. Returns the UI thread-row projection.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(threadsListSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailThreadsListResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const result = await options.store.listThreads({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          folder: input.folder,
          ...(input.tab === undefined ? {} : { tab: input.tab }),
          ...(input.label === undefined ? {} : { label: input.label }),
          ...(input.query === undefined ? {} : { query: input.query }),
          limit: input.limit,
          offset: input.offset,
        });
        return {
          threads: result.threads.map(serializeThreadRow),
          total: result.total,
          limit: result.limit,
          offset: result.offset,
        };
      },
    }),
    defineTool<z.output<typeof foldersListSchema>, unknown>({
      id: "mail.folders.list",
      description:
        "List mail folders with per-folder thread and unread counts for the current actor.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(foldersListSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailFoldersListOutputSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => ({
        folders: (
          await options.store.listFolders({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
          })
        ).map(serializeFolder),
      }),
    }),
    defineTool<z.output<typeof labelsListSchema>, unknown>({
      id: "mail.labels.list",
      description:
        "List mail labels (org-shared and actor-owned) with display colours and live thread counts.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(labelsListSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailLabelsListOutputSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => ({
        labels: (
          await options.store.listLabels({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
          })
        ).map(serializeLabel),
      }),
    }),
    defineTool<z.output<typeof outboundGetSchema>, unknown>({
      id: "mail.outbound.get",
      description: "Read an outbound mail delivery record for the current actor.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(outboundGetSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailOutboundGetOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const outbound = await options.store.getOutbound(input.id);
        if (
          outbound === null ||
          outbound.orgId !== ctx.actor.orgId ||
          outbound.actorId !== ctx.actor.id
        ) {
          return { outbound: null };
        }
        return { outbound: serializeOutboundDetail(outbound) };
      },
    }),
    defineTool<
      z.output<typeof mailOutboundCancelInputSchema>,
      z.output<typeof mailOutboundCancelResultSchema>
    >({
      id: "mail.outbound.cancel",
      description: "Cancel a queued outbound mail message during its undo-send window.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailOutboundCancelInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailOutboundCancelResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const cancelled = await sendService.cancel({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          id: input.outboundId,
        });
        return {
          outbound: cancelled === null ? null : serializeOutboundDetail(cancelled),
        };
      },
    }),
    defineTool<
      z.output<typeof mailOutboundRetryInputSchema>,
      z.output<typeof mailOutboundRetryResultSchema>
    >({
      id: "mail.outbound.retry",
      description: "Explicitly retry a failed outbound message through its bound provider.",
      permission: "mail.send",
      sideEffects: "external_communication",
      confirmationRequired: true,
      inputSchema: zodToolSchema(mailOutboundRetryInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailOutboundRetryResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        const retried = await sendService.retry({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          id: input.outboundId,
        });
        return { outbound: retried === null ? null : serializeOutboundDetail(retried) };
      },
    }),
    defineTool<z.output<typeof mailDraftSaveInputSchema>, z.output<typeof mailDraftSchema>>({
      id: "mail.draft.save",
      description: "Create or update a mail draft for the current actor.",
      permission: "mail.write",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailDraftSaveInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailDraftSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.saveDraft === undefined) {
          throw new BadRequestError("Draft persistence is not available.");
        }
        const draft = await options.store.saveDraft({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          envelope: {
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            bodyText: input.bodyText,
            ...(input.bodyHtml === undefined ? {} : { bodyHtml: input.bodyHtml }),
            attachments: input.attachments,
          } as JsonObject,
          ...(input.expectedVersion === undefined
            ? {}
            : { expectedVersion: input.expectedVersion }),
        });
        return serializeDraft(draft, input);
      },
    }),
    defineTool<z.output<typeof mailDraftGetInputSchema>, unknown>({
      id: "mail.draft.get",
      description: "Fetch one mail draft owned by the current actor.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(mailDraftGetInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(
        z.object({ draft: mailDraftSchema.nullable() }),
        genericObjectJsonSchema,
      ),
      handler: async (input, ctx) => {
        if (options.store.getDraft === undefined) {
          return { draft: null };
        }
        const draft = await options.store.getDraft({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
          id: input.id,
        });
        return { draft: draft === null ? null : serializeDraft(draft) };
      },
    }),
    defineTool<Record<string, never>, z.output<typeof mailDraftListResultSchema>>({
      id: "mail.draft.list",
      description: "List mail drafts for the current actor (newest first).",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}), genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailDraftListResultSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => {
        if (options.store.listDrafts === undefined) {
          return { drafts: [] };
        }
        const drafts = await options.store.listDrafts({
          orgId: ctx.actor.orgId,
          actorId: ctx.actor.id,
        });
        return { drafts: drafts.map((d) => serializeDraft(d)) };
      },
    }),
    defineTool<
      z.output<typeof mailDraftDiscardInputSchema>,
      z.output<typeof mailDraftDiscardResultSchema>
    >({
      id: "mail.draft.discard",
      description: "Discard a mail draft owned by the current actor.",
      permission: "mail.write",
      sideEffects: "destructive",
      inputSchema: zodToolSchema(mailDraftDiscardInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailDraftDiscardResultSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.discardDraft === undefined) {
          return { deleted: false };
        }
        return {
          deleted: await options.store.discardDraft({
            orgId: ctx.actor.orgId,
            actorId: ctx.actor.id,
            id: input.id,
          }),
        };
      },
    }),
    defineTool<Record<string, never>, z.output<typeof mailAliasListResultSchema>>({
      id: "mail.alias.list",
      description: "List mail aliases for the current actor.",
      permission: "mail.read",
      sideEffects: "read",
      inputSchema: zodToolSchema(z.object({}), genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailAliasListResultSchema, genericObjectJsonSchema),
      handler: async (_input, ctx) => {
        if (options.store.listAliases === undefined) {
          return { aliases: [] };
        }
        const aliases = await options.store.listAliases(ctx.actor.orgId, ctx.actor.id);
        return { aliases: aliases.map(serializeAlias) };
      },
    }),
    defineTool<z.output<typeof mailAliasCreateInputSchema>, z.output<typeof mailAliasSchema>>({
      id: "mail.alias.create",
      description: "Create a mail alias (admin routing mutation).",
      permission: "mail.admin",
      sideEffects: "write",
      inputSchema: zodToolSchema(mailAliasCreateInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailAliasSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.createAlias === undefined) {
          throw new BadRequestError("Alias management is not available.");
        }
        const alias = await options.store.createAlias({
          orgId: ctx.actor.orgId,
          actorId: input.targetActorId,
          email: input.address,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          isPrimary: input.isPrimary,
        });
        return serializeAlias(alias);
      },
    }),
    defineTool<
      z.output<typeof mailAliasDeleteInputSchema>,
      z.output<typeof mailAliasDeleteOutputSchema>
    >({
      id: "mail.alias.delete",
      description: "Disable a mail alias (admin routing mutation).",
      permission: "mail.admin",
      sideEffects: "destructive",
      inputSchema: zodToolSchema(mailAliasDeleteInputSchema, genericObjectJsonSchema),
      outputSchema: zodToolSchema(mailAliasDeleteOutputSchema, genericObjectJsonSchema),
      handler: async (input, ctx) => {
        if (options.store.deleteAlias === undefined) {
          return { deleted: false };
        }
        return {
          deleted: await options.store.deleteAlias({
            orgId: ctx.actor.orgId,
            id: input.id,
          }),
        };
      },
    }),
  ];
}

export function registerMailTools(
  registry: RuntimeToolRegistry,
  options: CreateMailToolDefinitionsOptions,
): void {
  for (const tool of createMailToolDefinitions(options)) {
    registry.register(tool);
  }
}

function threadStateTool(
  id: string,
  description: string,
  permission: string,
  handler: ToolDefinition<z.output<typeof threadIdSchema>>["handler"],
): ToolDefinition {
  return {
    id,
    description,
    permission,
    sideEffects: id === "mail.delete" ? "destructive" : "write",
    inputSchema: zodToolSchema(threadIdSchema, genericObjectJsonSchema),
    outputSchema: zodToolSchema(mailOkThreadSchema, genericObjectJsonSchema),
    handler,
  };
}

function defineTool<Input, Output>(
  tool: ToolDefinition<Input, Output>,
): ToolDefinition<Input, Output> {
  return tool;
}

function toEnvelope(
  input: z.output<typeof sendSchema> | z.output<typeof replySchema>,
  defaultFrom: MailOutboundEnvelope["from"],
): MailOutboundEnvelope {
  const from =
    "from" in input && input.from !== undefined ? normalizeAddress(input.from) : defaultFrom;
  return {
    from,
    to: input.to.map(normalizeAddress),
    cc: input.cc.map(normalizeAddress),
    bcc: input.bcc.map(normalizeAddress),
    subject: "subject" in input && input.subject !== undefined ? input.subject : "Re:",
    text: input.bodyText,
    ...(input.bodyHtml === undefined ? {} : { html: input.bodyHtml }),
    attachments: input.attachments.map((attachment) => ({
      ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
      mimeType: attachment.contentType ?? "application/octet-stream",
      ...(attachment.content === undefined
        ? { content: Buffer.alloc(0) }
        : { content: Buffer.from(attachment.content, "base64") }),
      ...(attachment.contentType === undefined ? {} : { contentType: attachment.contentType }),
      ...(attachment.path === undefined ? {} : { path: attachment.path }),
      ...(attachment.objectId === undefined ? {} : { objectId: attachment.objectId }),
    })),
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

function structuredInboundInputToRfc822(
  input: z.output<typeof inboundAcceptSchema>,
  receivedAt: Date,
): string {
  const headers = [
    `From: ${formatMailAddress(input.from)}`,
    `To: ${input.to.map(formatMailAddress).join(", ")}`,
    ...(input.cc.length === 0 ? [] : [`Cc: ${input.cc.map(formatMailAddress).join(", ")}`]),
    `Subject: ${input.subject}`,
    `Message-ID: ${formatMessageId(input.messageId)}`,
    `Date: ${receivedAt.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${input.bodyText}\r\n`;
}

function formatMailAddress(address: z.output<typeof addressSchema>): string {
  if (!("name" in address) || address.name === undefined) {
    return address.address;
  }
  return `"${address.name.replaceAll('"', '\\"')}" <${address.address}>`;
}

function formatMessageId(messageId: string | undefined): string {
  if (messageId === undefined || messageId.length === 0) {
    return `<${cryptoRandomId()}@helix.local>`;
  }
  return messageId.startsWith("<") && messageId.endsWith(">") ? messageId : `<${messageId}>`;
}

function cryptoRandomId(): string {
  return randomUUID();
}

function normalizeCriteria(criteria: z.output<typeof filterCriteriaSchema>): MailFilterCriteria {
  return {
    ...(criteria.fromContains === undefined ? {} : { fromContains: criteria.fromContains }),
    ...(criteria.toContains === undefined ? {} : { toContains: criteria.toContains }),
    ...(criteria.subjectContains === undefined
      ? {}
      : { subjectContains: criteria.subjectContains }),
    ...(criteria.bodyContains === undefined ? {} : { bodyContains: criteria.bodyContains }),
    ...(criteria.hasAttachment === undefined ? {} : { hasAttachment: criteria.hasAttachment }),
  };
}

function normalizeActions(actions: z.output<typeof filterActionsSchema>): MailFilterActions {
  return {
    ...(actions.applyLabels === undefined ? {} : { applyLabels: actions.applyLabels }),
    ...(actions.archive === undefined ? {} : { archive: actions.archive }),
    ...(actions.delete === undefined ? {} : { delete: actions.delete }),
    ...(actions.snoozeUntil === undefined ? {} : { snoozeUntil: actions.snoozeUntil }),
  };
}

function normalizeFilterPatch(input: Omit<z.output<typeof filterUpdateSchema>, "id">) {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ...(input.criteria === undefined ? {} : { criteria: normalizeCriteria(input.criteria) }),
    ...(input.actions === undefined ? {} : { actions: normalizeActions(input.actions) }),
  };
}

function normalizeMetadata(metadata: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(metadata)) as JsonObject;
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

function serializeOutbound(
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

function serializeOutboundDetail(outbound: MailOutboundRecord) {
  return {
    ...serializeOutbound(outbound),
    outboxId: outbound.outboxId,
    sentAt: outbound.sentAt?.toISOString() ?? null,
    cancelledAt: outbound.cancelledAt?.toISOString() ?? null,
    failedAt: outbound.failedAt?.toISOString() ?? null,
    lastError: outbound.lastError,
    providerMessageId: outbound.providerMessageId,
    deliveryMetadata: outbound.deliveryMetadata,
  };
}

function serializeFilter(filter: {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly criteria: unknown;
  readonly actions: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): z.output<typeof mailFilterSchema> {
  return {
    id: filter.id,
    name: filter.name,
    enabled: filter.enabled,
    priority: filter.priority,
    criteria: filter.criteria as z.output<typeof mailFilterSchema>["criteria"],
    actions: filter.actions as z.output<typeof mailFilterSchema>["actions"],
    createdAt: filter.createdAt.toISOString(),
    updatedAt: filter.updatedAt.toISOString(),
  };
}

function serializeVacation(vacation: {
  readonly id: string;
  readonly enabled: boolean;
  readonly subject: string;
  readonly body: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}) {
  return {
    id: vacation.id,
    enabled: vacation.enabled,
    subject: vacation.subject,
    body: vacation.body,
    startsAt: vacation.startsAt?.toISOString() ?? null,
    endsAt: vacation.endsAt?.toISOString() ?? null,
    metadata: vacation.metadata,
    createdAt: vacation.createdAt.toISOString(),
    updatedAt: vacation.updatedAt.toISOString(),
  };
}

function serializeThreadRow(row: MailThreadRowRecord) {
  return {
    threadId: row.threadId,
    messageId: row.messageId,
    subject: row.subject,
    from: row.from,
    fromEmail: row.fromEmail,
    preview: row.preview,
    time: row.time,
    unread: row.unread,
    starred: row.starred,
    hasAttachment: row.hasAttachment,
    messageCount: row.messageCount,
    labels: [...row.labels],
    category: row.category,
    folder: row.folder,
    snoozedUntil: row.snoozedUntil,
  };
}

function serializeFolder(folder: MailFolderSummary) {
  return {
    id: folder.id,
    label: folder.label,
    total: folder.total,
    unread: folder.unread,
  };
}

function serializeLabel(label: MailLabelRecord) {
  return {
    id: label.id,
    slug: label.slug,
    name: label.name,
    color: label.color,
    sortOrder: label.sortOrder,
    threadCount: label.threadCount,
    shared: label.ownerActorId === null,
    createdAt: label.createdAt.toISOString(),
    updatedAt: label.updatedAt.toISOString(),
  };
}

function serializeDraft(
  draft: {
    readonly id: string;
    readonly orgId: string;
    readonly actorId: string;
    readonly threadId: string | null;
    readonly envelope: JsonObject;
    readonly version: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
  fallback?: z.output<typeof mailDraftSaveInputSchema>,
) {
  const env = draft.envelope;
  const to = Array.isArray(env.to) ? env.to : (fallback?.to ?? []);
  const cc = Array.isArray(env.cc) ? env.cc : (fallback?.cc ?? []);
  const bcc = Array.isArray(env.bcc) ? env.bcc : (fallback?.bcc ?? []);
  const subject = typeof env.subject === "string" ? env.subject : (fallback?.subject ?? "");
  const bodyText = typeof env.bodyText === "string" ? env.bodyText : (fallback?.bodyText ?? "");
  const bodyHtml =
    typeof env.bodyHtml === "string"
      ? env.bodyHtml
      : fallback?.bodyHtml === undefined
        ? undefined
        : fallback.bodyHtml;
  const attachments = Array.isArray(env.attachments)
    ? env.attachments
    : (fallback?.attachments ?? []);
  return {
    id: draft.id,
    orgId: draft.orgId,
    actorId: draft.actorId,
    threadId: draft.threadId,
    to: to as z.output<typeof mailDraftSchema>["to"],
    cc: cc as z.output<typeof mailDraftSchema>["cc"],
    bcc: bcc as z.output<typeof mailDraftSchema>["bcc"],
    subject,
    bodyText,
    ...(bodyHtml === undefined ? {} : { bodyHtml }),
    attachments: attachments as z.output<typeof mailDraftSchema>["attachments"],
    version: draft.version,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  };
}

function serializeAlias(alias: {
  readonly id: string;
  readonly orgId: string;
  readonly actorId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly isPrimary: boolean;
  readonly createdAt: Date;
}) {
  return {
    id: alias.id,
    orgId: alias.orgId,
    actorId: alias.actorId,
    address: alias.email,
    displayName: alias.displayName,
    isPrimary: alias.isPrimary,
    createdAt: alias.createdAt.toISOString(),
  };
}

function serializeThread(thread: {
  readonly id: string;
  readonly subject: string;
  readonly preview: string;
  readonly participants: readonly unknown[];
  readonly messages: readonly {
    readonly id: string;
    readonly from?: unknown;
    readonly to: readonly unknown[];
    readonly cc: readonly unknown[];
    readonly bcc: readonly unknown[];
    readonly sentAt: Date;
    readonly body: string;
    readonly bodyFormat: string;
    readonly hasAttachment: boolean;
    readonly attachments: readonly unknown[];
  }[];
  readonly labels: readonly string[];
  readonly archivedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly snoozedUntil: Date | null;
  readonly lastActivity: Date;
  readonly unread: boolean;
  readonly starred: boolean;
  readonly direction: string;
}) {
  return {
    ...thread,
    messages: thread.messages.map((message) => ({
      ...message,
      sentAt: message.sentAt.toISOString(),
    })),
    archivedAt: thread.archivedAt?.toISOString() ?? null,
    deletedAt: thread.deletedAt?.toISOString() ?? null,
    snoozedUntil: thread.snoozedUntil?.toISOString() ?? null,
    lastActivity: thread.lastActivity.toISOString(),
  };
}
