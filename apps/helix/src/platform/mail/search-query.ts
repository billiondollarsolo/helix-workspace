/**
 * M13 — structured mail search operators (Gmail-style) without inventing hits.
 * Free-text remainder is for subject/body ILIKE; operators filter results.
 */

export interface ParsedMailSearchQuery {
  readonly freeText: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly subject: readonly string[];
  readonly hasAttachment: boolean | null;
  readonly isUnread: boolean | null;
  readonly isStarred: boolean | null;
  readonly operators: readonly string[];
}

const OPERATOR_PATTERN = /\b(from|to|subject|has|is):(?:"([^"]+)"|([^\s]+))/giu;

export function parseMailSearchQuery(raw: string | undefined | null): ParsedMailSearchQuery {
  const source = (raw ?? "").trim();
  if (source.length === 0) {
    return emptyParsed();
  }

  const from: string[] = [];
  const to: string[] = [];
  const subject: string[] = [];
  const operators: string[] = [];
  let hasAttachment: boolean | null = null;
  let isUnread: boolean | null = null;
  let isStarred: boolean | null = null;

  let freeText = source.replace(
    OPERATOR_PATTERN,
    (full, key: string, quoted?: string, bare?: string) => {
      const value = (quoted ?? bare ?? "").trim();
      const op = key.toLowerCase();
      const normalized = value.toLowerCase();
      operators.push(`${op}:${value}`);
      if (op === "from" && value.length > 0) {
        from.push(normalized);
      } else if (op === "to" && value.length > 0) {
        to.push(normalized);
      } else if (op === "subject" && value.length > 0) {
        subject.push(normalized);
      } else if (op === "has") {
        if (normalized === "attachment" || normalized === "attachments") {
          hasAttachment = true;
        }
      } else if (op === "is") {
        if (normalized === "unread") {
          isUnread = true;
        } else if (normalized === "read") {
          isUnread = false;
        } else if (normalized === "starred") {
          isStarred = true;
        } else if (normalized === "unstarred") {
          isStarred = false;
        }
      }
      return " ";
    },
  );

  freeText = freeText.replace(/\s+/gu, " ").trim();

  return {
    freeText,
    from,
    to,
    subject,
    hasAttachment,
    isUnread,
    isStarred,
    operators,
  };
}

export interface MailSearchHitLike {
  readonly subject: string;
  readonly preview?: string;
  readonly from?: { readonly address?: string; readonly name?: string } | null;
  readonly to?: readonly { readonly address?: string }[];
  readonly hasAttachment?: boolean;
  readonly unread?: boolean;
  readonly starred?: boolean;
}

/** Apply structured operators to a hit. Free-text is expected to be applied by SQL. */
export function mailSearchHitMatchesOperators(
  hit: MailSearchHitLike,
  parsed: ParsedMailSearchQuery,
): boolean {
  if (parsed.from.length > 0) {
    const hay = `${hit.from?.address ?? ""} ${hit.from?.name ?? ""}`.toLowerCase();
    if (!parsed.from.every((needle) => hay.includes(needle))) {
      return false;
    }
  }
  if (parsed.to.length > 0) {
    const hay = (hit.to ?? [])
      .map((entry) => entry.address ?? "")
      .join(" ")
      .toLowerCase();
    if (!parsed.to.every((needle) => hay.includes(needle))) {
      return false;
    }
  }
  if (parsed.subject.length > 0) {
    const hay = hit.subject.toLowerCase();
    if (!parsed.subject.every((needle) => hay.includes(needle))) {
      return false;
    }
  }
  if (parsed.hasAttachment === true && hit.hasAttachment !== true) {
    return false;
  }
  if (parsed.isUnread === true && hit.unread !== true) {
    return false;
  }
  if (parsed.isUnread === false && hit.unread === true) {
    return false;
  }
  if (parsed.isStarred === true && hit.starred !== true) {
    return false;
  }
  if (parsed.isStarred === false && hit.starred === true) {
    return false;
  }
  return true;
}

function emptyParsed(): ParsedMailSearchQuery {
  return {
    freeText: "",
    from: [],
    to: [],
    subject: [],
    hasAttachment: null,
    isUnread: null,
    isStarred: null,
    operators: [],
  };
}
