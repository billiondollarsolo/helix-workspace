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

export interface ParsedMailSearchQuery {
  readonly text: string;
  readonly from?: string;
  readonly labels: readonly string[];
  readonly hasAttachment?: boolean;
}

/** Parse only the bounded operators advertised by the Mail search UI. */
export function parseMailSearchQuery(raw: string): ParsedMailSearchQuery {
  let from: string | undefined;
  let hasAttachment: boolean | undefined;
  const labels: string[] = [];
  const text = raw
    .replace(
      /(^|\s)(from|label|has):(?:"([^"]{1,320})"|([^\s"]{1,320}))/giu,
      (match, prefix: string, rawOperator: string, quoted?: string, bare?: string) => {
        const operator = rawOperator.toLowerCase();
        const value = (quoted ?? bare ?? "").trim();
        const normalizedValue = value.toLowerCase();
        if (
          operator === "has" &&
          normalizedValue !== "attachment" &&
          normalizedValue !== "noattachment"
        ) {
          return match;
        }
        if (operator === "from") from = value;
        if (operator === "label") labels.push(value);
        if (operator === "has") hasAttachment = normalizedValue === "attachment";
        return prefix;
      },
    )
    .trim()
    .replace(/\s+/gu, " ");
  return {
    text,
    ...(from === undefined ? {} : { from }),
    labels: [...new Set(labels)],
    ...(hasAttachment === undefined ? {} : { hasAttachment }),
  };
}
