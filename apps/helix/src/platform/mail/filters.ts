import type { MailMessageInput } from "./types.js";
import type { MailStore } from "./store.js";

export interface MailFilterEvaluationResult {
  readonly matchedFilterIds: readonly string[];
  readonly vacationQueued: boolean;
}

export async function evaluateInboundMail(store: MailStore, input: {
  readonly message: MailMessageInput;
  readonly stored: { readonly threadId: string; readonly messageId: string };
  readonly recipientActorId?: string | null;
  readonly now?: Date;
}): Promise<MailFilterEvaluationResult> {
  const actorId = input.recipientActorId ?? input.message.actorId;
  if (actorId === undefined || actorId === null) {
    return { matchedFilterIds: [], vacationQueued: false };
  }

  const matchedFilterIds: string[] = [];
  for (const filter of await store.listFilters(input.message.orgId, actorId)) {
    if (!filter.enabled || !matchesFilter(input.message, filter.criteria)) {
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
        ...(filter.actions.snoozeUntil === undefined ? {} : { snoozedUntil: new Date(filter.actions.snoozeUntil) }),
      },
    });
  }

  const vacationQueued = await maybeQueueVacationResponse(store, {
    message: input.message,
    actorId,
    stored: input.stored,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { matchedFilterIds, vacationQueued };
}

async function maybeQueueVacationResponse(store: MailStore, input: {
  readonly message: MailMessageInput;
  readonly actorId: string;
  readonly stored: { readonly threadId: string; readonly messageId: string };
  readonly now?: Date;
}): Promise<boolean> {
  const vacation = await store.getActiveVacation(input.message.orgId, input.actorId, input.now);
  if (vacation === null) {
    return false;
  }
  const senderEmail = input.message.from.address.toLowerCase();
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
    ...(input.message.messageId === undefined ? {} : { inReplyTo: input.message.messageId }),
    ...(input.message.references === undefined ? {} : { references: input.message.references }),
    envelope: {
      from: firstRecipient(input.message),
      to: [input.message.from],
      cc: [],
      bcc: [],
      subject: vacation.subject,
      text: vacation.body,
      attachments: [],
    },
    undoUntil: input.now ?? new Date(),
    outboxSubject: "mail.send",
  });
  return true;
}

function matchesFilter(message: MailMessageInput, criteria: {
  readonly fromContains?: string;
  readonly toContains?: string;
  readonly subjectContains?: string;
  readonly bodyContains?: string;
  readonly hasAttachment?: boolean;
}): boolean {
  if (criteria.fromContains !== undefined && !message.from.address.toLowerCase().includes(criteria.fromContains.toLowerCase())) {
    return false;
  }
  if (
    criteria.toContains !== undefined &&
    !message.to.some((address) => address.address.toLowerCase().includes(criteria.toContains?.toLowerCase() ?? ""))
  ) {
    return false;
  }
  if (criteria.subjectContains !== undefined && !message.subject.toLowerCase().includes(criteria.subjectContains.toLowerCase())) {
    return false;
  }
  if (criteria.bodyContains !== undefined && !message.bodyText.toLowerCase().includes(criteria.bodyContains.toLowerCase())) {
    return false;
  }
  if (criteria.hasAttachment !== undefined && (message.attachments?.length ?? 0) > 0 !== criteria.hasAttachment) {
    return false;
  }
  return true;
}

function firstRecipient(message: MailMessageInput) {
  const recipient = message.to[0];
  if (recipient === undefined) {
    throw new Error("Vacation response requires at least one recipient.");
  }
  return recipient;
}
