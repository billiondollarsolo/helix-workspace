/* ChatGPT-style date buckets for the assistant thread sidebar.
 *
 * Given a list of threads with `updatedAtMs`, returns a flat sequence of
 * either `{ kind: "header", label }` or `{ kind: "thread", thread }` items
 * grouped in the same shape ChatGPT uses:
 *
 *   Today
 *   Yesterday
 *   Previous 7 Days
 *   Previous 30 Days
 *   <Month YYYY>  ← one per calendar month, oldest last
 *
 * Order within each bucket is the input order, which the caller controls
 * (typically reverse-chronological).
 *
 * Returning a flat array makes the result trivial to feed into
 * `useVirtualizer` — index N is either a sticky header or a row.
 */

import type { AssistantThread } from "./assistant-data";

export interface ThreadSidebarHeader {
  readonly kind: "header";
  readonly id: string;
  readonly label: string;
}

export interface ThreadSidebarThread {
  readonly kind: "thread";
  readonly thread: AssistantThread;
}

export type ThreadSidebarItem = ThreadSidebarHeader | ThreadSidebarThread;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Group `threads` into ChatGPT-style date buckets and return a flat
 * [header, ...threads, header, ...threads] sequence.
 *
 * Threads with a missing or zero `updatedAtMs` fall into an "Older" bucket
 * at the end so they're never dropped.
 *
 * `now` is parameterized for stable tests; callers in production use
 * `Date.now()`.
 */
export function bucketThreadsByDate(
  threads: readonly AssistantThread[],
  now: number = Date.now(),
): readonly ThreadSidebarItem[] {
  if (threads.length === 0) return [];

  // Start-of-day for "now" — used to compute "today" / "yesterday" without
  // letting wall-clock drift across the boundary mid-render.
  const startOfToday = startOfDay(now);
  const startOfYesterday = startOfToday - ONE_DAY_MS;
  const startOfWeek = startOfToday - 7 * ONE_DAY_MS;
  const startOfMonth = startOfToday - 30 * ONE_DAY_MS;

  const today: AssistantThread[] = [];
  const yesterday: AssistantThread[] = [];
  const week: AssistantThread[] = [];
  const month: AssistantThread[] = [];
  const months = new Map<string, { readonly label: string; readonly items: AssistantThread[] }>();
  const older: AssistantThread[] = [];

  for (const thread of threads) {
    const ts = thread.updatedAtMs;
    if (!Number.isFinite(ts) || ts <= 0) {
      older.push(thread);
      continue;
    }
    if (ts >= startOfToday) {
      today.push(thread);
    } else if (ts >= startOfYesterday) {
      yesterday.push(thread);
    } else if (ts >= startOfWeek) {
      week.push(thread);
    } else if (ts >= startOfMonth) {
      month.push(thread);
    } else {
      const date = new Date(ts);
      const key = `${String(date.getFullYear())}-${String(date.getMonth()).padStart(2, "0")}`;
      const label = `${MONTH_LABELS[date.getMonth()] ?? "Older"} ${String(date.getFullYear())}`;
      const bucket = months.get(key);
      if (bucket === undefined) {
        months.set(key, { label, items: [thread] });
      } else {
        bucket.items.push(thread);
      }
    }
  }

  const out: ThreadSidebarItem[] = [];
  pushBucket(out, "today", "Today", today);
  pushBucket(out, "yesterday", "Yesterday", yesterday);
  pushBucket(out, "week", "Previous 7 Days", week);
  pushBucket(out, "month", "Previous 30 Days", month);

  // Months: emit oldest last (most recent month-bucket first).
  const sortedMonthKeys = [...months.keys()].sort().reverse();
  for (const key of sortedMonthKeys) {
    const bucket = months.get(key);
    if (bucket !== undefined) {
      pushBucket(out, `m-${key}`, bucket.label, bucket.items);
    }
  }

  pushBucket(out, "older", "Older", older);
  return out;
}

function pushBucket(
  out: ThreadSidebarItem[],
  id: string,
  label: string,
  items: readonly AssistantThread[],
): void {
  if (items.length === 0) return;
  out.push({ kind: "header", id, label });
  for (const thread of items) {
    out.push({ kind: "thread", thread });
  }
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
