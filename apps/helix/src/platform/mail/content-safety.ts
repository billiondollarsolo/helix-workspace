import type { ParsedMail } from "mailparser";

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const DROP_CONTENT_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "svg",
  "math",
  "template",
  "audio",
  "video",
  "link",
  "base",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const TAG_PATTERN = /<\s*(\/?)([a-zA-Z][a-zA-Z0-9:-]*)([^>]*)>/gu;
const ATTR_PATTERN = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/gu;
const COMMENT_PATTERN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>/gu;

const EXECUTABLE_EXTENSIONS =
  /\.(?:apk|app|bat|cmd|com|cpl|dll|dmg|exe|hta|jar|js|jse|msi|msp|ps1|scr|svg|vbe|vbs|wsf)$/iu;
const ACTIVE_MIME_TYPES = new Set([
  "application/hta",
  "application/java-archive",
  "application/javascript",
  "application/vnd.microsoft.portable-executable",
  "application/x-dosexec",
  "application/x-msdownload",
  "application/x-msi",
  "application/x-sh",
  "image/svg+xml",
  "text/html",
  "text/javascript",
]);

export interface SanitizedMailHtml {
  readonly html: string;
  readonly remoteImagesBlocked: number;
}

/**
 * Allowlist sanitizer used both before persistence and again when projecting a
 * stored HTML message. Images may only reference MIME `cid:` parts; network,
 * data, file, and protocol-relative sources are removed.
 */
export function sanitizeMailHtml(html: string): SanitizedMailHtml {
  const stripped = html.replace(COMMENT_PATTERN, "");
  const output: string[] = [];
  let cursor = 0;
  let dropTag: string | null = null;
  let dropDepth = 0;
  let remoteImagesBlocked = 0;

  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(stripped); match !== null; match = TAG_PATTERN.exec(stripped)) {
    if (dropDepth === 0) output.push(escapeBareText(stripped.slice(cursor, match.index)));
    cursor = match.index + match[0].length;
    const closing = match[1] === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const rawAttributes = match[3] ?? "";
    const selfClosing = /\/\s*$/u.test(rawAttributes) || VOID_TAGS.has(tag);

    if (DROP_CONTENT_TAGS.has(tag)) {
      if (closing && dropTag === tag) {
        dropDepth -= 1;
        if (dropDepth === 0) dropTag = null;
      } else if (!closing && !selfClosing) {
        if (dropDepth === 0) dropTag = tag;
        if (dropTag === tag) dropDepth += 1;
      }
      continue;
    }
    if (dropDepth > 0 || !ALLOWED_TAGS.has(tag)) continue;
    if (closing) {
      if (!VOID_TAGS.has(tag)) output.push(`</${tag}>`);
      continue;
    }

    const attributes = sanitizeAttributes(tag, rawAttributes);
    remoteImagesBlocked += attributes.remoteImageBlocked ? 1 : 0;
    output.push(
      attributes.value.length === 0
        ? `<${tag}${selfClosing ? "/" : ""}>`
        : `<${tag} ${attributes.value}${selfClosing ? "/" : ""}>`,
    );
  }
  if (dropDepth === 0) output.push(escapeBareText(stripped.slice(cursor)));
  return { html: output.join(""), remoteImagesBlocked };
}

export function sanitizeMailHeaderDisplayValue(value: string, maxLength = 998): string {
  return replaceControlCharacters(value, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

export interface InboundAttachmentPolicy {
  readonly quarantine: boolean;
  readonly reasons: readonly string[];
}

export function inspectInboundAttachments(
  attachments: ParsedMail["attachments"],
): InboundAttachmentPolicy {
  const reasons = new Set<string>();
  for (const attachment of attachments) {
    const filename = attachment.filename ?? "";
    const mimeType = attachment.contentType.toLowerCase();
    if (EXECUTABLE_EXTENSIONS.test(filename)) reasons.add("active_attachment_extension");
    if (ACTIVE_MIME_TYPES.has(mimeType)) reasons.add("active_attachment_mime");
  }
  return { quarantine: reasons.size > 0, reasons: [...reasons] };
}

function sanitizeAttributes(
  tag: string,
  raw: string,
): { readonly value: string; readonly remoteImageBlocked: boolean } {
  const parts: string[] = [];
  let remoteImageBlocked = false;
  ATTR_PATTERN.lastIndex = 0;
  for (let match = ATTR_PATTERN.exec(raw); match !== null; match = ATTR_PATTERN.exec(raw)) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name.startsWith("on") || name === "style" || name === "srcset") continue;
    if (name === "title" || name === "lang" || name === "dir") {
      parts.push(`${name}="${escapeAttribute(value)}"`);
      continue;
    }
    if (tag === "a" && name === "href" && safeLink(value)) {
      parts.push(`href="${escapeAttribute(value)}"`, 'rel="noopener noreferrer nofollow"');
      continue;
    }
    if (tag === "img" && name === "src") {
      if (/^cid:[^<>"\s]+$/iu.test(value)) {
        parts.push(`src="${escapeAttribute(value)}"`);
      } else {
        remoteImageBlocked = true;
        parts.push('data-helix-remote-image="blocked"');
      }
      continue;
    }
    if (
      tag === "img" &&
      (name === "alt" || name === "width" || name === "height") &&
      !parts.some((part) => part.startsWith(`${name}=`))
    ) {
      parts.push(`${name}="${escapeAttribute(value)}"`);
    }
  }
  return { value: [...new Set(parts)].join(" "), remoteImageBlocked };
}

function safeLink(value: string): boolean {
  const compact = replaceControlCharacters(value, "").replaceAll(" ", "");
  return /^(?:https?:|mailto:|#)/iu.test(compact);
}

function replaceControlCharacters(value: string, replacement: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    output += code <= 31 || (code >= 127 && code <= 159) ? replacement : character;
  }
  return output;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeBareText(value: string): string {
  return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
