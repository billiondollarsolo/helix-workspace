import { sanitizeHtmlForExport } from "../docs/export/sanitize-html.js";

const ACTIVE_DOCUMENT_TAGS = /<\/?(?:html|head|body|meta|title)\b[^>]*>/giu;
const STYLE_BLOCKS = /<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/giu;
const LINK_TARGETS = /\s(?:target|rel)="[^"]*"/giu;
const HREFS = /\shref="([^"]*)"/giu;
const REMOTE_CONTENT = /<img\b[^>]*\bsrc\s*=|@import\b|url\s*\(/iu;

export interface SanitizedMailHtml {
  readonly html: string;
  readonly remoteContentBlocked: boolean;
}

/** Inert mail fragment for the browser's opaque-origin, no-network iframe. */
export function sanitizeMailHtml(source: string): SanitizedMailHtml {
  const html = sanitizeHtmlForExport(source)
    .replace(/^<!doctype html>/u, "")
    .replace(STYLE_BLOCKS, "")
    .replace(ACTIVE_DOCUMENT_TAGS, "")
    .replace(LINK_TARGETS, "")
    .replace(HREFS, (_attribute, href: string) =>
      isExternalMailHref(href)
        ? ` href="#helix-link" data-helix-href="${href}"`
        : "",
    );
  return { html, remoteContentBlocked: REMOTE_CONTENT.test(source) };
}

function isExternalMailHref(href: string): boolean {
  let normalized = "";
  for (let index = 0; index < href.length; index += 1) {
    const code = href.charCodeAt(index);
    if (code > 0x20 && code !== 0x7f) {
      normalized += href.charAt(index);
    }
  }
  return /^(?:https?:|mailto:)/iu.test(normalized);
}
