/* Presentation and routing for global search hits.
   `search.query` returns index documents whose `url` points at API-style paths
   (`/mail/<thread>?message=…`), which the web router does not serve. Each hit is
   mapped onto the owning surface's own URL state instead, from the ids the
   indexers store in `attributes`. */

import type { GlobalSearchHit, GlobalSearchType } from "./api";

/** In-app destination for a hit, shaped for `navigate()` / `<Link>`. */
export type SearchHitTarget =
  | { readonly to: "/mail"; readonly search: { readonly thread?: string } }
  | { readonly to: "/chat"; readonly search: { readonly room?: string } }
  | {
      readonly to: "/drive";
      readonly search: { readonly file?: string; readonly folder?: string };
    }
  | {
      readonly to: "/calendar";
      readonly search: { readonly event?: string; readonly date?: string };
    };

/** Section names, in the order results are grouped. */
export const SEARCH_TYPE_LABELS: Readonly<Record<GlobalSearchType, string>> = {
  mail: "Mail",
  drive: "Files",
  chat: "Chat messages",
  calendar: "Events",
};

export const SEARCH_TYPE_ORDER: readonly GlobalSearchType[] = ["mail", "drive", "chat", "calendar"];

export function searchHitTarget(hit: GlobalSearchHit): SearchHitTarget {
  const attributes = hit.attributes ?? {};
  switch (hit.type) {
    case "mail":
      return { to: "/mail", search: optional({ thread: text(attributes.threadId) }) };
    case "chat":
      return { to: "/chat", search: optional({ room: text(attributes.roomId) }) };
    case "drive":
      return attributes.kind === "folder"
        ? { to: "/drive", search: optional({ folder: text(attributes.fileId) }) }
        : {
            to: "/drive",
            search: optional({
              file: text(attributes.fileId),
              folder: text(attributes.parentFolderId),
            }),
          };
    case "calendar":
      return {
        to: "/calendar",
        search: optional({
          event: text(attributes.eventId),
          date: text(attributes.startsAt)?.slice(0, 10),
        }),
      };
  }
}

export function searchHitTitle(hit: GlobalSearchHit): string {
  const title = hit.title?.trim();
  if (title !== undefined && title.length > 0) {
    return title;
  }
  return hit.type === "mail" ? "(no subject)" : SEARCH_TYPE_LABELS[hit.type];
}

/** Who/where/when line under the title. */
export function searchHitDetail(hit: GlobalSearchHit): string {
  const attributes = hit.attributes ?? {};
  const parts: (string | undefined)[] = [];
  switch (hit.type) {
    case "mail":
      parts.push(text(attributes.fromName) ?? text(attributes.from));
      parts.push(shortDate(text(attributes.sentAt) ?? hit.updatedAt));
      break;
    case "chat":
      parts.push(text(attributes.authorName));
      parts.push(shortDate(text(attributes.createdAt) ?? hit.updatedAt));
      break;
    case "drive": {
      const folders = Array.isArray(attributes.path) ? attributes.path.map(text) : [];
      const parent = folders.length > 1 ? folders[folders.length - 2] : undefined;
      parts.push(text(attributes.ownerName));
      parts.push(parent === undefined ? undefined : `in ${parent}`);
      parts.push(shortDate(hit.updatedAt));
      break;
    }
    case "calendar":
      parts.push(shortDateTime(text(attributes.startsAt)));
      parts.push(text(attributes.location));
      break;
  }
  return parts.filter((part) => part !== undefined && part.length > 0).join(" · ");
}

/* An indexed body is the record's fields joined by newlines (subject, people,
   labels, message). A line that only lists addresses is header, not content. */
const ADDRESS_LINE =
  /^(?:[^,<>]*<[^\s<>@]+@[^\s<>]+>|[^\s,<>@]+@[^\s,<>]+)(?:,\s*(?:[^,<>]*<[^\s<>@]+@[^\s<>]+>|[^\s,<>@]+@[^\s,<>]+))*$/u;

/**
 * Message text around the first query term, for mail and chat hits. Files and
 * events have no free-text body worth quoting, so they return "".
 */
export function searchHitSnippet(hit: GlobalSearchHit, query: string, width = 160): string {
  if (hit.type !== "mail" && hit.type !== "chat") {
    return "";
  }
  const attributes = hit.attributes ?? {};
  const header = new Set(
    [hit.title, attributes.authorName, attributes.roomName, attributes.fromName]
      .map(text)
      .filter((value): value is string => value !== undefined),
  );
  const body = (hit.body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !header.has(line) && !ADDRESS_LINE.test(line))
    .join(" ")
    .replace(/\s+/gu, " ");
  if (body.length <= width) {
    return body;
  }
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const lower = body.toLowerCase();
  const at = terms.map((term) => lower.indexOf(term)).find((index) => index >= 0) ?? 0;
  const start = Math.max(0, at - Math.floor(width / 3));
  const end = Math.min(body.length, start + width);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function optional<T extends Record<string, string | undefined>>(
  values: T,
): { [K in keyof T]?: string } {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ) as { [K in keyof T]?: string };
}

function shortDate(iso: string | undefined): string | undefined {
  const date = parse(iso);
  return date === undefined
    ? undefined
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function shortDateTime(iso: string | undefined): string | undefined {
  const date = parse(iso);
  return date === undefined
    ? undefined
    : new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
}

function parse(iso: string | undefined): Date | undefined {
  if (iso === undefined) {
    return undefined;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
