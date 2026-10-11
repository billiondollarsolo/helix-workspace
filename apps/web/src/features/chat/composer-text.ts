/* Text editing helpers for the Chat composer: @mention detection and
   insertion, Markdown formatting of the selection, and the body format.

   Mentions use the handles the server resolves (see the backend
   `memberHandleResolver`): a member's email local part, or their display
   name lowercased with spaces turned into dots. The server stores resolved
   mentions in the message metadata, which drives Mentions and @ badges. */

import type { ChatMemberView } from "./view-model";

const HANDLE_PATTERN = /^[a-zA-Z0-9._-]+$/u;
/** Characters that make an `@` part of a word or email address rather than a mention. */
const WORD_BEFORE_AT = /[a-zA-Z0-9._%+-]/u;

export interface TextEdit {
  readonly text: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
}

/** The handle the server will resolve back to this member, or null when none is safe. */
export function mentionHandle(member: Pick<ChatMemberView, "name" | "email">): string | null {
  const local = member.email?.split("@")[0]?.toLowerCase() ?? "";
  const slug = member.name.trim().toLowerCase().replace(/\s+/gu, ".");
  return [local, slug].find((handle) => handle.length > 0 && HANDLE_PATTERN.test(handle)) ?? null;
}

/** The `@query` being typed at the caret, if any. */
export function activeMentionQuery(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (!/^[a-zA-Z0-9._-]*$/u.test(query) || query.length > 64) return null;
  const preceding = at === 0 ? "" : (before[at - 1] ?? "");
  if (preceding !== "" && WORD_BEFORE_AT.test(preceding)) return null;
  return { start: at, query };
}

/** Members whose name, email or handle starts a word with `query`. */
export function mentionSuggestions(
  members: readonly ChatMemberView[],
  query: string,
  selfActorId: string | null,
): readonly ChatMemberView[] {
  const needle = query.toLowerCase();
  return members
    .filter((member) => member.actorId !== selfActorId && mentionHandle(member) !== null)
    .filter((member) => {
      if (needle.length === 0) return true;
      const words = [
        ...member.name.toLowerCase().split(/\s+/u),
        member.email?.toLowerCase() ?? "",
        mentionHandle(member) ?? "",
      ];
      return words.some((word) => word.startsWith(needle));
    })
    .slice(0, 8);
}

/** Replace `@query` (from `start` to the caret) with `@handle ` and put the caret after it. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  handle: string,
): TextEdit {
  const inserted = `@${handle} `;
  const next = `${text.slice(0, start)}${inserted}${text.slice(caret)}`;
  const position = start + inserted.length;
  return { text: next, selectionStart: position, selectionEnd: position };
}

/** Insert text at the selection, replacing it. */
export function insertText(edit: TextEdit, value: string): TextEdit {
  const next = `${edit.text.slice(0, edit.selectionStart)}${value}${edit.text.slice(edit.selectionEnd)}`;
  const position = edit.selectionStart + value.length;
  return { text: next, selectionStart: position, selectionEnd: position };
}

export type ChatFormat = "bold" | "italic" | "strikethrough" | "code" | "link" | "list";

const WRAPPERS: Readonly<Record<Exclude<ChatFormat, "link" | "list">, string>> = {
  bold: "**",
  italic: "*",
  strikethrough: "~~",
  code: "`",
};

/** Apply Markdown formatting to the selection (or insert empty markers at the caret). */
export function applyFormat(edit: TextEdit, format: ChatFormat): TextEdit {
  const { text, selectionStart: start, selectionEnd: end } = edit;
  const selected = text.slice(start, end);
  if (format === "list") {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const block = text.slice(lineStart, end);
    const listed = block
      .split("\n")
      .map((line) => (line.startsWith("- ") ? line : `- ${line}`))
      .join("\n");
    const next = `${text.slice(0, lineStart)}${listed}${text.slice(end)}`;
    return {
      text: next,
      selectionStart: lineStart + listed.length,
      selectionEnd: lineStart + listed.length,
    };
  }
  if (format === "link") {
    const label = selected.length > 0 ? selected : "link";
    const prefix = `[${label}](`;
    const url = "https://";
    const next = `${text.slice(0, start)}${prefix}${url})${text.slice(end)}`;
    const urlStart = start + prefix.length;
    return { text: next, selectionStart: urlStart, selectionEnd: urlStart + url.length };
  }
  const marker = WRAPPERS[format];
  const next = `${text.slice(0, start)}${marker}${selected}${marker}${text.slice(end)}`;
  return {
    text: next,
    selectionStart: start + marker.length,
    selectionEnd: start + marker.length + selected.length,
  };
}

const MARKDOWN_SYNTAX = [
  /\*\*[^*\n]+\*\*/u,
  /(^|[^*])\*[^*\n]+\*/u,
  /~~[^~\n]+~~/u,
  /`[^`\n]+`/u,
  /\[[^\]\n]+\]\([^)\s]+\)/u,
  /^[-*]\s+\S/mu,
  /^#{1,3}\s+\S/mu,
  /^```/mu,
];

/** Send as Markdown only when the body uses the formatting the server renders. */
export function chatBodyFormat(body: string): "plain" | "markdown" {
  return MARKDOWN_SYNTAX.some((pattern) => pattern.test(body)) ? "markdown" : "plain";
}
