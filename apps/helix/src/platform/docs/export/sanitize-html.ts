/**
 * Server-side HTML sanitizer for the PDF export pipeline.
 *
 * The PDF exporter renders untrusted document HTML inside a headless Chromium
 * instance. Without sanitization, a malicious document body could embed
 * script tags, iframes, or link rel=preconnect tags that would cause
 * Chromium to fetch arbitrary URLs from inside the Helix network perimeter
 * (SSRF). To defend in depth we both (a) strip every element/attribute that
 * could trigger a network fetch or run script, and (b) block all subresource
 * requests at the Chromium routing layer (see chromium.ts).
 *
 * The implementation is deliberately self-contained — no jsdom/DOMPurify/
 * sanitize-html dependency. It uses an allowlist tokenizer over the HTML
 * string and rebuilds output from scratch. Anything not on the allowlist is
 * dropped entirely (tags and their attributes).
 */

/** Block-level and inline tags we emit from renderHtmlForPdf plus the
 * common formatting tags a native Helix document can contain. Anything not
 * on this list is stripped (tag removed, but inner text is preserved unless
 * it is in DROP_CONTENT_TAGS). */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "main",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "var",
  // Container tags emitted by the PDF scaffold:
  "html",
  "head",
  "body",
  "meta",
  "style",
  "title",
]);

/** Tags whose content must be dropped entirely (not just the tag). Anything
 * inside these tags is a known injection vector. */
const DROP_CONTENT_TAGS: ReadonlySet<string> = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "frame",
  "frameset",
  "noscript",
  "noembed",
  "applet",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "svg",
  "math",
  "template",
  "audio",
  "video",
  "source",
  "track",
  "link",
  "base",
  "portal",
]);

/** Void (self-closing) tags — we never emit a closing tag for these. */
const VOID_TAGS: ReadonlySet<string> = new Set([
  "br",
  "hr",
  "img",
  "meta",
  "wbr",
  "col",
]);

/** Attributes allowed per-tag. "*" applies to any tag. */
const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  "*": new Set(["class", "id", "title", "lang", "dir"]),
  a: new Set(["href", "name", "target", "rel"]),
  img: new Set(["alt", "width", "height"]),
  td: new Set(["colspan", "rowspan", "headers", "scope"]),
  th: new Set(["colspan", "rowspan", "headers", "scope"]),
  ol: new Set(["start", "type", "reversed"]),
  meta: new Set(["charset"]),
  // <style> has no attributes we care to preserve, but the tag itself is on
  // the allowlist so the inline page CSS rendered by renderHtmlForPdf
  // survives.
};

/** URL schemes accepted in href attributes. Everything else (javascript:,
 * data: for non-image, vbscript:, etc.) is dropped. */
const ALLOWED_HREF_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);

const COMMENT_AND_DECL_PATTERN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>/gu;
// We capture the entire run of attributes (up to `>`) as one blob so we can
// reliably detect a trailing `/` self-close marker; per-attribute parsing
// happens in `sanitizeAttributes`.
const TAG_PATTERN = /<\s*(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/gu;
const ATTR_PATTERN =
  /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gu;

/**
 * Returns a sanitized copy of html safe to feed to Chromium. Drops every
 * element / attribute not on the allowlist and removes all on* handlers
 * and dangerous URL schemes.
 *
 * IMPORTANT: this is one layer of defense. The chromium renderer also blocks
 * every subresource request via page.route('**', route => route.abort()),
 * so even if the sanitizer let something through, Chromium still will not
 * fetch external URLs.
 */
export function sanitizeHtmlForExport(html: string): string {
  // 1. Strip comments, CDATA, doctypes, and processing instructions outright.
  //    We re-emit <!doctype html> below so the structural decl is preserved.
  const stripped = html.replace(COMMENT_AND_DECL_PATTERN, "");

  // 2. Walk the token stream, tracking when we are inside a drop-content tag
  //    so we can throw away everything between e.g. <script>...</script>.
  const output: string[] = ["<!doctype html>"];
  let cursor = 0;
  let dropDepth = 0;
  let dropTag: string | null = null;

  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(stripped); match !== null; match = TAG_PATTERN.exec(stripped)) {
    const start = match.index;
    const between = stripped.slice(cursor, start);
    cursor = start + match[0].length;

    if (dropDepth === 0) {
      output.push(between);
    }

    const isClosing = match[1] === "/";
    const tagName = (match[2] ?? "").toLowerCase();
    // Self-close marker is the final `/` before `>`. Only treat it as such
    // when it's at the very end of the attr blob and preceded by whitespace
    // or the empty string — otherwise we'd corrupt an attribute value that
    // happens to end in `/` (e.g. an unquoted URL).
    const rawAttrBlobRaw = match[3] ?? "";
    const selfCloseMatch = /^([\s\S]*?)\s*\/$/u.exec(rawAttrBlobRaw);
    const selfClosingMarker = selfCloseMatch !== null;
    const rawAttrs = selfClosingMarker ? (selfCloseMatch[1] ?? "") : rawAttrBlobRaw;

    if (DROP_CONTENT_TAGS.has(tagName)) {
      if (isClosing) {
        if (dropTag === tagName && dropDepth > 0) {
          dropDepth -= 1;
          if (dropDepth === 0) {
            dropTag = null;
          }
        }
      } else if (!selfClosingMarker && !VOID_TAGS.has(tagName)) {
        if (dropDepth === 0) {
          dropTag = tagName;
        }
        if (dropTag === tagName) {
          dropDepth += 1;
        }
      }
      // Either way, we never emit the tag itself.
      continue;
    }

    if (dropDepth > 0) {
      // Still inside e.g. <script>: ignore everything until we close it.
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) {
      // Strip the tag but keep surrounding text.
      continue;
    }

    if (isClosing) {
      if (VOID_TAGS.has(tagName)) {
        continue;
      }
      output.push(`</${tagName}>`);
      continue;
    }

    const attrs = sanitizeAttributes(tagName, rawAttrs);
    if (VOID_TAGS.has(tagName) || selfClosingMarker) {
      output.push(attrs.length === 0 ? `<${tagName}/>` : `<${tagName} ${attrs}/>`);
    } else {
      output.push(attrs.length === 0 ? `<${tagName}>` : `<${tagName} ${attrs}>`);
    }
  }
  if (dropDepth === 0) {
    output.push(stripped.slice(cursor));
  }
  return output.join("");
}

function sanitizeAttributes(tagName: string, raw: string): string {
  const allowed = ALLOWED_ATTRIBUTES[tagName] ?? new Set<string>();
  const global = ALLOWED_ATTRIBUTES["*"] ?? new Set<string>();
  const parts: string[] = [];
  ATTR_PATTERN.lastIndex = 0;
  for (let match = ATTR_PATTERN.exec(raw); match !== null; match = ATTR_PATTERN.exec(raw)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";

    // Drop every event handler (onclick, onload, …) and known-dangerous
    // namespaced attributes (xlink:href).
    if (name.startsWith("on")) {
      continue;
    }
    if (name === "xlink:href" || name === "xmlns" || name === "srcdoc") {
      continue;
    }
    if (!allowed.has(name) && !global.has(name)) {
      continue;
    }

    // URL-bearing attributes must be #fragment, http(s):, or mailto:.
    // Everything else (javascript:, data:, file:, ftp:, etc.) is rejected.
    if (name === "href") {
      if (!isSafeHref(value)) {
        continue;
      }
    }

    parts.push(`${name}="${escapeAttributeValue(value)}"`);
  }
  return parts.join(" ");
}

function isSafeHref(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) {
    return true;
  }
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u.exec(trimmed);
  if (schemeMatch === null) {
    // Relative URL with no scheme — safe enough (Chromium will not fetch
    // anything because we abort all routes anyway).
    return true;
  }
  return ALLOWED_HREF_SCHEMES.has(`${(schemeMatch[1] ?? "").toLowerCase()}:`);
}

function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/"/gu, "&quot;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
}
