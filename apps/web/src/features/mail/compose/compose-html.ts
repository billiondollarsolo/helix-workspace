/* HTML for the compose editor. The editor is a contenteditable region, so
   anything pasted or produced by formatting commands passes through an
   allowlist before it is saved or sent: formatting tags only, links limited
   to http(s) and mailto, and inline styles limited to the properties the
   toolbar sets (colour, size, alignment, indent). Scripts, event handlers,
   images, and remote URLs never survive. */

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "div",
  "em",
  "font",
  "i",
  "li",
  "ol",
  "p",
  "s",
  "span",
  "strike",
  "strong",
  "u",
  "ul",
]);

/** Elements removed with everything inside them. */
const DROP_TAGS = new Set([
  "script",
  "style",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "noscript",
  "head",
  "title",
  "meta",
  "link",
  "form",
  "input",
  "button",
  "textarea",
  "select",
]);

const ALLOWED_STYLE_PROPERTIES = new Set([
  "color",
  "font-size",
  "font-weight",
  "font-style",
  "text-decoration",
  "text-decoration-line",
  "text-align",
  "margin",
  "margin-left",
  "padding",
  "padding-left",
  "border",
  "border-left",
]);

const SAFE_STYLE_VALUE = /^[#(),.%\w\s-]*$/u;
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const BLOCK_TAGS = new Set(["p", "div", "li", "blockquote", "ul", "ol"]);

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** `https://…`, `mailto:…`, or a bare `example.com` (made https); null for anything else. */
export function safeLinkHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed)
    ? trimmed
    : /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed)
      ? `mailto:${trimmed}`
      : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return LINK_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function sanitizeStyle(style: string): string {
  return style
    .split(";")
    .map((declaration) => {
      const separator = declaration.indexOf(":");
      if (separator < 0) return null;
      const property = declaration.slice(0, separator).trim().toLowerCase();
      const value = declaration.slice(separator + 1).trim();
      if (!ALLOWED_STYLE_PROPERTIES.has(property) || value === "") return null;
      if (!SAFE_STYLE_VALUE.test(value) || /url|expression|var\(/iu.test(value)) return null;
      return `${property}: ${value}`;
    })
    .filter((declaration): declaration is string => declaration !== null)
    .join("; ");
}

function cleanChildren(source: Node, target: Node, doc: Document): void {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (!(child instanceof Element)) continue;
    const tag = child.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;
    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown wrappers keep their text and allowed descendants.
      cleanChildren(child, target, doc);
      if (BLOCK_TAGS.has(tag) || tag === "h1" || tag === "h2" || tag === "h3" || tag === "tr") {
        target.appendChild(doc.createElement("br"));
      }
      continue;
    }
    const element = doc.createElement(tag);
    if (tag === "a") {
      const href = safeLinkHref(child.getAttribute("href") ?? "");
      if (href !== null) {
        element.setAttribute("href", href);
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
      }
    }
    if (tag === "font") {
      const size = child.getAttribute("size");
      if (size !== null && /^[1-7]$/u.test(size)) element.setAttribute("size", size);
      const color = child.getAttribute("color");
      if (color !== null && /^#?[\da-z]+$/iu.test(color)) element.setAttribute("color", color);
    }
    if (tag === "ol") {
      const start = child.getAttribute("start");
      if (start !== null && /^\d{1,4}$/u.test(start)) element.setAttribute("start", start);
    }
    const style = sanitizeStyle(child.getAttribute("style") ?? "");
    if (style !== "") element.setAttribute("style", style);
    cleanChildren(child, element, doc);
    target.appendChild(element);
  }
}

/** Allowlist-sanitize editor HTML. Safe to assign to `innerHTML` and to send as `bodyHtml`. */
export function sanitizeComposeHtml(html: string): string {
  if (html.trim() === "") return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const output = document.implementation.createHTMLDocument("");
  const root = output.createElement("div");
  cleanChildren(parsed.body, root, output);
  return root.innerHTML;
}

export function textToComposeHtml(text: string): string {
  if (text === "") return "";
  return text
    .split("\n")
    .map((line) => (line === "" ? "<div><br></div>" : `<div>${escapeHtml(line)}</div>`))
    .join("");
}

function appendText(node: Node, out: string[], listDepth: number): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push((child.textContent ?? "").replaceAll("\u00a0", " "));
      continue;
    }
    if (!(child instanceof Element)) continue;
    const tag = child.tagName.toLowerCase();
    if (DROP_TAGS.has(tag)) continue;
    if (tag === "br") {
      out.push("\n");
      continue;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block && out.length > 0 && !out.at(-1)?.endsWith("\n")) out.push("\n");
    if (tag === "li") {
      const parent = child.parentElement;
      const ordered = parent?.tagName.toLowerCase() === "ol";
      const index = parent === null ? 0 : Array.from(parent.children).indexOf(child);
      out.push(
        `${"  ".repeat(Math.max(0, listDepth - 1))}${ordered ? `${String(index + 1)}.` : "-"} `,
      );
    }
    if (tag === "blockquote") {
      const inner: string[] = [];
      appendText(child, inner, listDepth);
      out.push(
        inner
          .join("")
          .replace(/\n+$/u, "")
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
    } else {
      appendText(child, out, tag === "ul" || tag === "ol" ? listDepth + 1 : listDepth);
    }
    if (tag === "a") {
      const href = child.getAttribute("href");
      if (href !== null && href !== child.textContent && !href.startsWith("mailto:")) {
        out.push(` (${href})`);
      }
    }
    if (block && !out.at(-1)?.endsWith("\n")) out.push("\n");
  }
}

/** Readable plain text for `bodyText`: line breaks for blocks, `-`/`1.` for lists, `>` for quotes. */
export function composeHtmlToText(html: string): string {
  if (html.trim() === "") return "";
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const out: string[] = [];
  appendText(parsed.body, out, 0);
  return out
    .join("")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/\n+$/u, "");
}
