/* Search options ⇄ operator query. The form in the search-options panel
   builds the same Gmail-style operators people can type (from:, to:,
   subject:, has:attachment, in:, after:/before:, newer_than:), and opening
   the panel on an existing query fills the form back in. */

export const SEARCH_WITHIN_DAYS = [1, 3, 7, 14, 30, 60, 180, 365] as const;
export type SearchWithinDays = (typeof SEARCH_WITHIN_DAYS)[number];

/** Places a search can look in; `anywhere` adds Spam and Trash to All Mail. */
export const SEARCH_SCOPES = [
  { value: "all", label: "All Mail" },
  { value: "inbox", label: "Inbox" },
  { value: "starred", label: "Starred" },
  { value: "sent", label: "Sent" },
  { value: "drafts", label: "Drafts" },
  { value: "scheduled", label: "Scheduled" },
  { value: "snoozed", label: "Snoozed" },
  { value: "archive", label: "Archive" },
  { value: "spam", label: "Spam" },
  { value: "trash", label: "Trash" },
  { value: "anywhere", label: "Mail, Spam and Trash" },
] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number]["value"];

export interface MailSearchOptions {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly words: string;
  readonly withinDays: SearchWithinDays | null;
  /** YYYY-MM-DD the "within" range is centred on; empty means "of today". */
  readonly withinOf: string;
  readonly scope: SearchScope;
  /** A label slug; set when searching inside a label. */
  readonly label: string;
  readonly hasAttachment: boolean;
}

export const EMPTY_SEARCH_OPTIONS: MailSearchOptions = {
  from: "",
  to: "",
  subject: "",
  words: "",
  withinDays: null,
  withinOf: "",
  scope: "all",
  label: "",
  hasAttachment: false,
};

function quote(value: string): string {
  const trimmed = value.trim().replaceAll('"', "");
  return /\s/u.test(trimmed) ? `"${trimmed}"` : trimmed;
}

function searchDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${String(date.getFullYear())}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

/** The operator query for a filled-in search form. */
export function buildMailQuery(options: MailSearchOptions): string {
  const parts: string[] = [];
  if (options.from.trim() !== "") parts.push(`from:${quote(options.from)}`);
  if (options.to.trim() !== "") parts.push(`to:${quote(options.to)}`);
  if (options.subject.trim() !== "") parts.push(`subject:${quote(options.subject)}`);
  if (options.label.trim() !== "") parts.push(`label:${quote(options.label)}`);
  if (options.hasAttachment) parts.push("has:attachment");
  if (options.scope !== "all") parts.push(`in:${options.scope}`);
  if (options.withinDays !== null) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(options.withinOf);
    if (match === null) {
      parts.push(`newer_than:${String(options.withinDays)}d`);
    } else {
      const centre = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      const after = new Date(centre);
      after.setDate(after.getDate() - options.withinDays);
      const before = new Date(centre);
      before.setDate(before.getDate() + options.withinDays + 1);
      parts.push(`after:${searchDate(after)}`, `before:${searchDate(before)}`);
    }
  }
  if (options.words.trim() !== "") parts.push(options.words.trim());
  return parts.join(" ");
}

const OPERATOR = /(^|\s)(from|to|subject|label|has|in):(?:"([^"]*)"|(\S+))/giu;

/** Fill the form from a typed query; operators the form has no field for stay in "Has the words". */
export function parseMailQuery(query: string): MailSearchOptions {
  const found: { -readonly [K in keyof MailSearchOptions]: MailSearchOptions[K] } = {
    ...EMPTY_SEARCH_OPTIONS,
  };
  const rest = query.replace(
    OPERATOR,
    (match, prefix: string, operator: string, quoted?: string, bare?: string) => {
      const value = quoted ?? bare ?? "";
      switch (operator.toLowerCase()) {
        case "from":
          found.from = value;
          break;
        case "to":
          found.to = value;
          break;
        case "subject":
          found.subject = value;
          break;
        case "label":
          found.label = value;
          break;
        case "has":
          if (value.toLowerCase() !== "attachment") return match;
          found.hasAttachment = true;
          break;
        default: {
          const scope = SEARCH_SCOPES.find((entry) => entry.value === value.toLowerCase());
          if (scope === undefined) return match;
          found.scope = scope.value;
        }
      }
      return prefix;
    },
  );
  found.words = rest.replace(/\s+/gu, " ").trim();
  return found;
}
