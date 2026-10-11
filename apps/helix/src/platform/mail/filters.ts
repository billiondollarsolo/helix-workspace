import { matchesFilterCriteria } from "./core/thread-projection.js";
import type { MailStore } from "./store.js";
import type { MailMessageInput } from "./types.js";
import { maybeQueueVacationResponse } from "./vacation.js";

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
    /** Spam-routed or DMARC-failing mail never triggers an auto-reply (RFC 3834). */
    readonly suppressAutoReply?: boolean;
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
    const now = input.now ?? new Date();
    await store.updateThreadState({
      orgId: input.message.orgId,
      actorId,
      threadId: input.stored.threadId,
      patch: {
        addLabels: filter.actions.applyLabels ?? [],
        ...(filter.actions.archive === true ? { archivedAt: now } : {}),
        ...(filter.actions.markRead === true ? { readAt: now } : {}),
        ...(filter.actions.star === true ? { starred: true } : {}),
        ...(filter.actions.delete === true ? { deletedAt: now } : {}),
        ...(filter.actions.snoozeUntil === undefined
          ? {}
          : { snoozedUntil: new Date(filter.actions.snoozeUntil) }),
      },
    });
  }

  if (input.suppressAutoReply === true) {
    return { matchedFilterIds, vacationQueued: false };
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
