import { createElement, useState, type ReactNode } from "react";
import {
  chatAttachmentContentUrl,
  saveChatAttachmentToDrive,
  type ChatAttachmentRecord,
} from "./api";

type MarkdownSegment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "code"; readonly value: string; readonly language: string };

export function ChatMessageContent({
  body,
  bodyFormat,
  renderedBodyHtml,
}: {
  readonly body: string;
  readonly bodyFormat: string;
  readonly renderedBodyHtml?: string | undefined;
}) {
  if (bodyFormat !== "markdown") {
    return body.length === 0 ? null : <p className="chat-msg-line">{body}</p>;
  }
  if (renderedBodyHtml !== undefined) {
    const document = new DOMParser().parseFromString(renderedBodyHtml, "text/html");
    return (
      <div className="chat-markdown">
        {Array.from(document.body.childNodes, renderSafeMarkdownNode)}
      </div>
    );
  }
  return (
    <div className="chat-markdown">
      {parseFencedMarkdown(body).map((segment, index) =>
        segment.kind === "code" ? (
          <ChatCodeBlock
            key={`code:${String(index)}`}
            code={segment.value}
            language={segment.language}
          />
        ) : (
          <div key={`text:${String(index)}`} className="chat-markdown-text">
            {renderInlineCode(segment.value)}
          </div>
        ),
      )}
    </div>
  );
}

// Recreate the server's small Markdown vocabulary; never insert HTML or copy attributes.
function renderSafeMarkdownNode(node: Node, index: number): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (!(node instanceof Element)) return null;
  const tag = node.tagName.toLowerCase();
  if (tag === "pre") {
    const code = node.querySelector("code");
    return (
      <ChatCodeBlock
        key={index}
        code={code?.textContent ?? node.textContent ?? ""}
        language={normalizedLanguage(code?.className.replace(/^language-/u, "") ?? "code")}
      />
    );
  }
  const children = Array.from(node.childNodes, renderSafeMarkdownNode);
  if (tag === "a") {
    const href = node.getAttribute("href") ?? "";
    try {
      const url = new URL(href);
      if (
        !["https:", "http:", "mailto:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        Array.from(href).some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)
      )
        return children;
      return (
        <a
          key={index}
          href={href}
          target={url.protocol === "mailto:" ? undefined : "_blank"}
          rel="noopener noreferrer nofollow"
        >
          {children}
        </a>
      );
    } catch {
      return children;
    }
  }
  if (!["p", "br", "strong", "em", "code", "h1", "h2", "h3", "span"].includes(tag)) return null;
  return createElement(
    tag,
    { key: index, ...(node.classList.contains("sr-only") ? { className: "sr-only" } : {}) },
    ...(tag === "br" ? [] : children),
  );
}

export function ChatAttachmentGallery({
  attachments,
  attachmentObjectIds,
}: {
  readonly attachments: readonly ChatAttachmentRecord[];
  readonly attachmentObjectIds: readonly string[];
}) {
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
  const [errorId, setErrorId] = useState<string | null>(null);
  const known = new Set(attachments.map(({ objectId }) => objectId));
  const driveFallbacks = attachmentObjectIds
    .filter((objectId) => !known.has(objectId))
    .map<ChatAttachmentRecord>((objectId) => ({
      objectId,
      source: "drive",
      filename: "Drive attachment",
      mimeType: "application/octet-stream",
      byteSize: 1,
    }));
  const items = [...attachments, ...driveFallbacks];
  if (items.length === 0) return null;

  return (
    <div className="chat-attachments" aria-label="Message attachments">
      {items.map((attachment) => {
        const chatMedia = attachment.source === "chat";
        const contentUrl = chatMedia
          ? chatAttachmentContentUrl(attachment.objectId)
          : `/api/drive/objects/${encodeURIComponent(attachment.objectId)}/content`;
        const downloadUrl = chatMedia
          ? chatAttachmentContentUrl(attachment.objectId, true)
          : `${contentUrl}?download=1`;
        return (
          <figure key={attachment.objectId} className="chat-attachment">
            {chatMedia ? (
              <a
                href={contentUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open ${attachment.filename}`}
              >
                <img src={contentUrl} alt={attachment.filename} loading="lazy" decoding="async" />
              </a>
            ) : null}
            <figcaption>
              <span className="chat-attachment-name">{attachment.filename}</span>
              <span className="chat-attachment-actions">
                <a href={contentUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
                <a href={downloadUrl} download>
                  Download
                </a>
                {chatMedia ? (
                  <button
                    type="button"
                    disabled={saved.has(attachment.objectId)}
                    onClick={() => {
                      setErrorId(null);
                      void saveChatAttachmentToDrive(attachment.objectId)
                        .then(() => {
                          setSaved((current) => new Set(current).add(attachment.objectId));
                        })
                        .catch(() => {
                          setErrorId(attachment.objectId);
                        });
                    }}
                  >
                    {saved.has(attachment.objectId) ? "Saved" : "Save to Drive"}
                  </button>
                ) : null}
              </span>
              {errorId === attachment.objectId ? (
                <span className="chat-attachment-error" role="alert">
                  Couldn’t save to Drive.
                </span>
              ) : null}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

function ChatCodeBlock({ code, language }: { readonly code: string; readonly language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="chat-code-block">
      <header>
        <span>{language}</span>
        <button
          type="button"
          aria-label={`Copy ${language} code`}
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <pre>
        <code>{highlightCode(code, language)}</code>
      </pre>
    </section>
  );
}

export function parseFencedMarkdown(body: string): readonly MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const fence = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gmu;
  let cursor = 0;
  for (const match of body.matchAll(fence)) {
    const start = match.index;
    if (start > cursor) segments.push({ kind: "text", value: body.slice(cursor, start) });
    const code = match[2] ?? "";
    segments.push({
      kind: "code",
      value: code.endsWith("\n") ? code.slice(0, -1) : code,
      language: normalizedLanguage(match[1] ?? ""),
    });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) segments.push({ kind: "text", value: body.slice(cursor) });
  return segments.length === 0 ? [{ kind: "text", value: body }] : segments;
}

export function applyCodeMarkup(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  kind: "inline" | "fenced",
): { readonly value: string; readonly selectionStart: number; readonly selectionEnd: number } {
  const selected = value.slice(selectionStart, selectionEnd) || "code";
  const prefix = kind === "inline" ? "`" : "```\n";
  const suffix = kind === "inline" ? "`" : "\n```";
  return {
    value: `${value.slice(0, selectionStart)}${prefix}${selected}${suffix}${value.slice(selectionEnd)}`,
    selectionStart: selectionStart + prefix.length,
    selectionEnd: selectionStart + prefix.length + selected.length,
  };
}

function renderInlineCode(value: string): readonly ReactNode[] {
  return value
    .split(/(`[^`\n]+`)/gu)
    .map((part, index) =>
      part.startsWith("`") && part.endsWith("`") ? (
        <code key={String(index)}>{part.slice(1, -1)}</code>
      ) : (
        <span key={String(index)}>{part}</span>
      ),
    );
}

function normalizedLanguage(value: string): string {
  const language = value.trim().toLowerCase();
  return /^[a-z0-9+#._-]{1,32}$/u.test(language) ? language : "code";
}

function highlightCode(code: string, language: string): readonly ReactNode[] {
  if (
    !/^(?:js|jsx|ts|tsx|javascript|typescript|json|css|html|sql|bash|sh|python|py)$/u.test(language)
  ) {
    return [code];
  }
  const token =
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|true|false|null|select|from|where|insert|update|delete|create|alter|table)\b|\b\d+(?:\.\d+)?\b)/giu;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of code.matchAll(token)) {
    const start = match.index;
    if (start > cursor) nodes.push(code.slice(cursor, start));
    const value = match[0];
    const className =
      value.startsWith("//") || value.startsWith("/*")
        ? "comment"
        : /^['"]/u.test(value)
          ? "string"
          : /^\d/u.test(value)
            ? "number"
            : "keyword";
    nodes.push(
      <span key={`${String(start)}:${value}`} className={`chat-code-${className}`}>
        {value}
      </span>,
    );
    cursor = start + value.length;
  }
  if (cursor < code.length) nodes.push(code.slice(cursor));
  return nodes;
}
