import {
  chatBodyFormatSchema,
  chatBodySchema,
  chatMetadataSchema,
  type ChatBodyFormat,
} from "@helix/contracts";
import type { JsonObject } from "@helix/sdk-types";

const MARKDOWN_LINK_PATTERN = /(!?)\[([^\]\r\n]{1,500})\]\(([^)\s]{1,2048})\)/gu;
const RESERVED_PREVIEW_KEYS = new Set([
  "embed",
  "embeds",
  "linkPreview",
  "linkPreviews",
  "unfurl",
  "unfurls",
]);

export interface SafeChatContent {
  readonly body: string;
  readonly bodyFormat: ChatBodyFormat;
  readonly metadata: JsonObject;
}

/**
 * Canonical validation boundary for persisted Chat content. Link previews and
 * embeds are intentionally disabled: no user-supplied metadata can opt the
 * application server into fetching a URL.
 */
export function normalizeChatContent(input: {
  readonly body: string;
  readonly bodyFormat?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}): SafeChatContent {
  const body = chatBodySchema.parse(input.body.replace(/\r\n?/gu, "\n"));
  const bodyFormat = chatBodyFormatSchema.parse(input.bodyFormat ?? "plain");
  const metadata = chatMetadataSchema.parse(input.metadata ?? {});
  const safeMetadata = stripUnsafeMetadata(metadata as JsonObject);
  return { body, bodyFormat, metadata: safeMetadata };
}

/**
 * Renders plain text or the deliberately small Chat Markdown profile entirely
 * from escaped text. Raw HTML, images/embeds, and non-http(s)/mailto links are
 * never emitted. External links receive safe attributes and a visible marker.
 */
export function renderChatBodyHtml(body: string, format: ChatBodyFormat): string {
  const safeBody = chatBodySchema.parse(body);
  if (format === "plain") {
    return `<p>${escapeHtml(safeBody).replace(/\n/gu, "<br/>")}</p>`;
  }

  const blocks: string[] = [];
  for (const line of safeBody.split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      blocks.push(
        `<h${String(level)}>${renderInlineMarkdown(heading[2] ?? "")}</h${String(level)}>`,
      );
      continue;
    }
    const listItem = /^[-*]\s+(.+)$/u.exec(line);
    if (listItem !== null) {
      blocks.push(
        `<p class="chat-markdown-list-item">• ${renderInlineMarkdown(listItem[1] ?? "")}</p>`,
      );
      continue;
    }
    blocks.push(line.length === 0 ? "<br/>" : `<p>${renderInlineMarkdown(line)}</p>`);
  }
  return blocks.join("");
}

export function isSafeChatLink(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" ||
        parsed.protocol === "http:" ||
        parsed.protocol === "mailto:") &&
      parsed.username.length === 0 &&
      parsed.password.length === 0
    );
  } catch {
    return false;
  }
}

function renderInlineMarkdown(input: string): string {
  const output: string[] = [];
  let cursor = 0;
  for (const match of input.matchAll(MARKDOWN_LINK_PATTERN)) {
    const index = match.index;
    output.push(renderInlineText(input.slice(cursor, index)));
    const imageMarker = match[1] ?? "";
    const label = match[2] ?? "";
    const href = match[3] ?? "";
    if (imageMarker === "!") {
      output.push(`[image: ${escapeHtml(label)}]`);
    } else if (isSafeChatLink(href)) {
      const escapedHref = escapeHtml(href);
      const external = /^https?:/iu.test(href);
      output.push(
        external
          ? `<a href="${escapedHref}" target="_blank" rel="noopener noreferrer nofollow">${renderInlineText(label)}<span aria-hidden="true"> ↗</span><span class="sr-only"> (external link)</span></a>`
          : `<a href="${escapedHref}" rel="nofollow">${renderInlineText(label)}</a>`,
      );
    } else {
      output.push(renderInlineText(label));
    }
    cursor = index + match[0].length;
  }
  output.push(renderInlineText(input.slice(cursor)));
  return output.join("");
}

function renderInlineText(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/gu, "<code>$1</code>")
    .replace(/(^|[^*])\*([^*\n]+)\*/gu, "$1<em>$2</em>");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function stripUnsafeMetadata(value: JsonObject): JsonObject {
  return stripMetadataObject(value);
}

function stripMetadataObject(value: Readonly<Record<string, unknown>>): JsonObject {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_PREVIEW_KEYS.has(key)) continue;
    result[key] = stripMetadataValue(child);
  }
  return result as JsonObject;
}

function stripMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripMetadataValue(entry));
  }
  return typeof value === "object" && value !== null
    ? stripMetadataObject(value as Readonly<Record<string, unknown>>)
    : value;
}
