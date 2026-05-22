/* Live search-operator parser for Mail — ported from the handoff's
   `threads` useMemo. Supports `from:`, `has:attachment`, `label:`,
   `is:starred`, `is:unread`, plus freeform terms. All tokens must match. */

import type { MailFolderId, MailTabId, MailThread } from "./mail-seed";
import { MAIL_EMPTY_FOLDERS } from "./mail-seed";

/** Selects the base thread pool for a folder + category tab. */
export function selectMailPool(
  threads: readonly MailThread[],
  folder: MailFolderId,
  tab: MailTabId,
): readonly MailThread[] {
  if (folder === "starred") {
    return threads.filter((thread) => thread.starred === true);
  }
  if ((MAIL_EMPTY_FOLDERS as readonly string[]).includes(folder)) {
    return [];
  }
  return threads.filter((thread) => thread.tab === tab);
}

/** Tests a single search token against a thread. */
function matchToken(thread: MailThread, token: string): boolean {
  if (token.startsWith("from:")) {
    const value = token.slice(5);
    return (
      thread.from.toLowerCase().includes(value) ||
      (thread.fromEmail ?? "").toLowerCase().includes(value)
    );
  }
  if (token === "has:attachment") {
    return thread.hasAttachment === true;
  }
  if (token.startsWith("label:")) {
    return thread.labels.includes(token.slice(6));
  }
  if (token === "is:starred") {
    return thread.starred === true;
  }
  if (token === "is:unread") {
    return thread.unread === true;
  }
  const haystack = [
    thread.from,
    thread.subject,
    thread.preview,
    thread.body ?? "",
    thread.labels.join(" "),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(token);
}

/** Filters a pool by the live query string. Empty query returns the pool. */
export function filterMailThreads(
  pool: readonly MailThread[],
  query: string,
): readonly MailThread[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    return pool;
  }
  const tokens = trimmed.toLowerCase().match(/\S+/g) ?? [];
  if (tokens.length === 0) {
    return pool;
  }
  return pool.filter((thread) => tokens.every((token) => matchToken(thread, token)));
}

/** Convenience: pool selection + query filtering in one call. */
export function searchMailThreads(
  threads: readonly MailThread[],
  options: { readonly folder: MailFolderId; readonly tab: MailTabId; readonly query: string },
): readonly MailThread[] {
  return filterMailThreads(
    selectMailPool(threads, options.folder, options.tab),
    options.query,
  );
}
