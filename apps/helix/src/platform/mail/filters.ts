import type { JsonObject } from "@helix/sdk-types";
import { matchesFilterCriteria, shouldSkipVacationResponse } from "./core/thread-projection.js";
import type { MailStore } from "./store.js";
import { prepareOutboundEnvelope } from "./threading.js";
import type { MailMessageInput } from "./types.js";

export interface MailFilterEvaluationResult {
  readonly matchedFilterIds: readonly string[];
  readonly vacationQueued: boolean;
}

export async function evaluateInboundMail(
  store: MailStore,
  input: {
    readonly message: MailMessageInput;
    readonly stored: { readonly threadId: string; readonly messageId: string };
    readonly recipientActorId: string;
    readonly recipientAddress: string;
    readonly now?: Date;
  },
): Promise<MailFilterEvaluationResult> {
  const actorId = input.recipientActorId;
  const sender = input.message.from.address.toLowerCase();
  const settings = await store.getUserSettings?.(input.message.orgId, actorId);
  if (settings?.blockedSenders.includes(sender) === true) {
    await store.updateThreadState({
      orgId: input.message.orgId,
      actorId,
      threadId: input.stored.threadId,
      patch: { spamAt: input.now ?? new Date() },
    });
    return { matchedFilterIds: [], vacationQueued: false };
  }

  const matchedFilterIds: string[] = [];
  for (const filter of await store.listFilters(input.message.orgId, actorId)) {
    if (!filter.enabled || !matchesFilterCriteria(input.message, filter.criteria)) {
      continue;
    }
    matchedFilterIds.push(filter.id);
    await store.updateThreadState({
      orgId: input.message.orgId,
      actorId,
      threadId: input.stored.threadId,
      patch: {
        addLabels: filter.actions.applyLabels ?? [],
        ...(filter.actions.archive === true ? { archivedAt: input.now ?? new Date() } : {}),
        ...(filter.actions.delete === true ? { deletedAt: input.now ?? new Date() } : {}),
        ...(filter.actions.snoozeUntil === undefined
          ? {}
          : { snoozedUntil: new Date(filter.actions.snoozeUntil) }),
      },
    });
  }

  const vacationQueued = await maybeQueueVacationResponse(store, {
    message: input.message,
    actorId,
    recipientAddress: input.recipientAddress,
    stored: input.stored,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { matchedFilterIds, vacationQueued };
}

async function maybeQueueVacationResponse(
  store: MailStore,
  input: {
    readonly message: MailMessageInput;
    readonly actorId: string;
    readonly recipientAddress: string;
    readonly stored: { readonly threadId: string; readonly messageId: string };
    readonly now?: Date;
  },
): Promise<boolean> {
  const vacation = await store.getActiveVacation(input.message.orgId, input.actorId, input.now);
  if (vacation === null) {
    return false;
  }

  const senderEmail = input.message.from.address.toLowerCase();
  const metadata = input.message.metadata ?? {};
  if (
    shouldSkipVacationResponse({
      senderEmail,
      headers: extractHeaders(metadata),
      isAutoReply: metadata.autoReply === true || metadata.isAutoReply === true,
    })
  ) {
    return false;
  }

  const responseRecorded = await store.recordVacationResponse({
    vacationId: vacation.id,
    orgId: input.message.orgId,
    actorId: input.actorId,
    senderEmail,
    messageId: input.stored.messageId,
    threadId: input.stored.threadId,
  });
  if (!responseRecorded) {
    return false;
  }

  await store.createOutbound({
    orgId: input.message.orgId,
    actorId: input.actorId,
    threadId: input.stored.threadId,
    envelope: prepareOutboundEnvelope({
      from: { address: input.recipientAddress },
      to: [input.message.from],
      cc: [],
      bcc: [],
      subject: vacation.subject,
      text: vacation.body,
      attachments: [],
      ...(input.message.messageId === undefined ? {} : { inReplyTo: input.message.messageId }),
      ...(input.message.references === undefined ? {} : { references: input.message.references }),
    }),
    undoUntil: input.now ?? new Date(),
    outboxSubject: "mail.send",
  });
  return true;
}

function extractHeaders(metadata: JsonObject): Readonly<Record<string, string | undefined>> {
  const headers = metadata.headers;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    const precedence = typeof metadata.precedence === "string" ? metadata.precedence : undefined;
    const autoSubmitted =
      typeof metadata.autoSubmitted === "string" ? metadata.autoSubmitted : undefined;
    return {
      ...(precedence === undefined ? {} : { precedence }),
      ...(autoSubmitted === undefined ? {} : { "auto-submitted": autoSubmitted }),
    };
  }
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}
