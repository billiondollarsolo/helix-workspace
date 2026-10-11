/**
 * Inline `style` allowlist for displayed mail: the text formatting compose
 * produces (colour, size, weight, emphasis, alignment, indent) and nothing
 * else. Every value must match a closed grammar of keywords, non-negative
 * lengths and colour literals, so url(), expression(), var(), escapes,
 * comments, entities and layout properties such as `position` never survive.
 */

const LENGTH = /^(?:0|\d{1,4}(?:\.\d{1,3})?(?:px|pt|em|rem|%))$/u;
const HEX_COLOR = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/u;
const COLOR_FUNCTION =
  /^(?:rgba?|hsla?)\(\s*\d{1,3}(?:\.\d+)?(?:%|deg)?(?:\s*[,/]?\s*\d{1,3}(?:\.\d+)?%?){2,3}\s*\)$/u;
const COLOR_KEYWORD = /^[a-z]{3,20}$/u;
const FONT_SIZE_KEYWORDS = new Set([
  "xx-small",
  "x-small",
  "small",
  "medium",
  "large",
  "x-large",
  "xx-large",
  "xxx-large",
  "smaller",
  "larger",
]);
const FONT_WEIGHTS = /^(?:normal|bold|bolder|lighter|[1-9]00)$/u;
const FONT_STYLES = new Set(["normal", "italic", "oblique"]);
const DECORATION_LINES = new Set(["none", "underline", "overline", "line-through"]);
const TEXT_ALIGNS = new Set(["left", "right", "center", "justify", "start", "end"]);

function isColor(value: string): boolean {
  return HEX_COLOR.test(value) || COLOR_FUNCTION.test(value) || COLOR_KEYWORD.test(value);
}

function isDecoration(value: string): boolean {
  const lines = value.split(/\s+/u);
  return lines.length <= 3 && lines.every((line) => DECORATION_LINES.has(line));
}

const PROPERTY_VALIDATORS: Readonly<Record<string, (value: string) => boolean>> = {
  color: isColor,
  "background-color": isColor,
  "font-size": (value) => FONT_SIZE_KEYWORDS.has(value) || LENGTH.test(value),
  "font-weight": (value) => FONT_WEIGHTS.test(value),
  "font-style": (value) => FONT_STYLES.has(value),
  "text-decoration": isDecoration,
  "text-decoration-line": isDecoration,
  "text-align": (value) => TEXT_ALIGNS.has(value),
  "margin-left": (value) => LENGTH.test(value),
  "padding-left": (value) => LENGTH.test(value),
};

/** Returns the allowed declarations of a `style` attribute, normalized; "" when none remain. */
export function sanitizeInlineStyle(style: string): string {
  if (/[&\\]|\/\*/u.test(style)) return "";
  const declarations: string[] = [];
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase()
      .replace(/\s+/gu, " ");
    const valid = Object.hasOwn(PROPERTY_VALIDATORS, property)
      ? PROPERTY_VALIDATORS[property]
      : undefined;
    if (valid?.(value) === true) declarations.push(`${property}: ${value}`);
  }
  return declarations.join("; ");
}
