import type { MailCategoryTab } from "./category.js";
import type { MailFolderId } from "./types.js";

export function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

/**
 * Escape LIKE/ILIKE metacharacters so user-supplied search terms are matched
 * literally. The default backslash escape character is used.
 */
export function escapeMailLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** `in:` targets: every folder view plus `anywhere`, which also covers Spam and Trash. */
type MailSearchScope = MailFolderId | "anywhere";

export interface ParsedMailSearchQuery {
  /** Free words and quoted phrases; each must appear in the subject, body or sender. */
  readonly terms: readonly string[];
  readonly from: readonly string[];
  /** Matches To and Cc (and Bcc on the actor's own messages). */
  readonly to: readonly string[];
  readonly subject: readonly string[];
  readonly filenames: readonly string[];
  /** Label slugs or names; a name may use `-` for spaces. */
  readonly labels: readonly string[];
  readonly hasAttachment?: boolean;
  readonly unread?: boolean;
  readonly starred?: boolean;
  readonly category?: MailCategoryTab;
  readonly scope?: MailSearchScope;
  /** Messages sent before this instant (exclusive). */
  readonly before?: Date;
  /** Messages sent at or after this instant. */
  readonly after?: Date;
}

const OPERATOR =
  /(^|\s)(from|to|cc|subject|has|is|label|in|before|after|older_than|newer_than|filename|category):(?:"([^"]{1,320})"|([^\s"]{1,320}))/giu;
const PHRASE = /"([^"]{1,320})"/gu;
const SCOPES: ReadonlySet<string> = new Set([
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "scheduled",
  "drafts",
  "all",
  "archive",
  "spam",
  "trash",
  "anywhere",
]);
const CATEGORIES: ReadonlySet<string> = new Set([
  "primary",
  "social",
  "promotions",
  "updates",
  "forums",
]);

/**
 * Parse Gmail-style operators: from:, to:, cc:, subject:, label:, in:,
 * has:attachment, is:unread|read|starred|unstarred, category:, filename:,
 * before:/after: (YYYY/MM/DD or YYYY-MM-DD, UTC), older_than:/newer_than:
 * (Nd, Nw, Nm, Ny) and quoted phrases. Unknown operators stay free text.
 */
export function parseMailSearchQuery(raw: string, now: Date = new Date()): ParsedMailSearchQuery {
  const from: string[] = [];
  const to: string[] = [];
  const subject: string[] = [];
  const filenames: string[] = [];
  const labels: string[] = [];
  const parsed: {
    hasAttachment?: boolean;
    unread?: boolean;
    starred?: boolean;
    category?: MailCategoryTab;
    scope?: MailSearchScope;
    before?: Date;
    after?: Date;
  } = {};
  const remainder = raw.replace(
    OPERATOR,
    (match, prefix: string, rawOperator: string, quoted?: string, bare?: string) => {
      const value = (quoted ?? bare ?? "").trim();
      const lower = value.toLowerCase();
      switch (rawOperator.toLowerCase()) {
        case "from":
          from.push(value);
          break;
        case "to":
        case "cc":
          to.push(value);
          break;
        case "subject":
          subject.push(value);
          break;
        case "filename":
          filenames.push(value);
          break;
        case "label":
          labels.push(lower);
          break;
        case "has":
          if (lower !== "attachment" && lower !== "noattachment") return match;
          parsed.hasAttachment = lower === "attachment";
          break;
        case "is":
          if (lower === "unread" || lower === "read") parsed.unread = lower === "unread";
          else if (lower === "starred" || lower === "unstarred")
            parsed.starred = lower === "starred";
          else return match;
          break;
        case "category":
          if (!CATEGORIES.has(lower)) return match;
          parsed.category = lower as MailCategoryTab;
          break;
        case "in":
          if (!SCOPES.has(lower)) return match;
          parsed.scope = lower as MailSearchScope;
          break;
        case "before":
        case "after": {
          const date = parseSearchDate(value);
          if (date === null) return match;
          if (rawOperator.toLowerCase() === "before") parsed.before = date;
          else parsed.after = date;
          break;
        }
        default: {
          const date = relativeSearchDate(lower, now);
          if (date === null) return match;
          if (rawOperator.toLowerCase() === "older_than") parsed.before = date;
          else parsed.after = date;
        }
      }
      return prefix;
    },
  );
  const terms: string[] = [];
  const words = remainder.replace(PHRASE, (_match, phrase: string) => {
    const trimmed = phrase.trim();
    if (trimmed.length > 0) terms.push(trimmed);
    return " ";
  });
  for (const word of words.split(/\s+/u)) if (word.length > 0) terms.push(word);
  return { terms, from, to, subject, filenames, labels: [...new Set(labels)], ...parsed };
}

function parseSearchDate(value: string): Date | null {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/u.exec(value);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

function relativeSearchDate(value: string, now: Date): Date | null {
  const match = /^(\d{1,4})([dwmy])$/u.exec(value);
  if (match === null) return null;
  const amount = Number(match[1]);
  const date = new Date(now.getTime());
  if (match[2] === "d") date.setUTCDate(date.getUTCDate() - amount);
  else if (match[2] === "w") date.setUTCDate(date.getUTCDate() - amount * 7);
  else if (match[2] === "m") date.setUTCMonth(date.getUTCMonth() - amount);
  else date.setUTCFullYear(date.getUTCFullYear() - amount);
  return date;
}
