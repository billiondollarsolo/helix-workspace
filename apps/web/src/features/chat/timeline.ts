/* Message timeline — the rows a conversation renders between its messages:
   date dividers ("Today", "Yesterday", "Monday, 3 March"), the "Unread"
   divider at the reader's last-read position, and sender grouping (one
   avatar and name for a run of messages within five minutes). */

import type { ChatMessageView } from "./view-model";

/** Consecutive messages from one sender closer together than this share a header. */
const GROUP_WINDOW_MS = 5 * 60_000;

export type ChatTimelineItem =
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | { readonly kind: "unread"; readonly key: "unread" }
  | {
      readonly kind: "message";
      readonly key: string;
      readonly message: ChatMessageView;
      /** Continues the previous message's run: no avatar or name. */
      readonly grouped: boolean;
    };

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", or the full date ("Monday, 3 March"; with the year when it differs). */
export function chatDayLabel(date: Date, now: Date, locale?: string): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(locale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * The first message from someone else sent after `lastReadAt`, where the
 * "Unread" divider goes. Null when everything is read.
 */
export function firstUnreadMessageId(
  messages: readonly ChatMessageView[],
  lastReadAt: string | null,
): string | null {
  const readUntil = lastReadAt === null ? Number.NEGATIVE_INFINITY : Date.parse(lastReadAt);
  const first = messages.find(
    (message) =>
      !message.isMine && message.pending !== true && Date.parse(message.sentAt) > readUntil,
  );
  return first?.id ?? null;
}

export function buildChatTimeline(
  messages: readonly ChatMessageView[],
  options: { readonly now: Date; readonly firstUnreadId?: string | null; readonly locale?: string },
): readonly ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];
  let previous: ChatMessageView | undefined;
  let previousDay: number | undefined;
  for (const message of messages) {
    const sentAt = new Date(message.sentAt);
    const day = startOfDay(sentAt);
    let breaksRun = false;
    if (day !== previousDay) {
      items.push({
        kind: "day",
        key: `day:${String(day)}`,
        label: chatDayLabel(sentAt, options.now, options.locale),
      });
      previousDay = day;
      breaksRun = true;
    }
    if (message.id === options.firstUnreadId) {
      items.push({ kind: "unread", key: "unread" });
      breaksRun = true;
    }
    const grouped =
      !breaksRun &&
      previous !== undefined &&
      previous.actorId !== null &&
      previous.actorId === message.actorId &&
      sentAt.getTime() - Date.parse(previous.sentAt) < GROUP_WINDOW_MS;
    items.push({ kind: "message", key: message.id, message, grouped });
    previous = message;
  }
  return items;
}
