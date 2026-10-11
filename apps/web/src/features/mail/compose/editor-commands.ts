/* Formatting commands for the contenteditable compose body. The browser's
   editing commands keep undo (Ctrl+Z) working; inline styles are used so the
   result survives the outbound sanitizer (see compose-html.ts). */

import { escapeHtml, safeLinkHref, sanitizeComposeHtml } from "./compose-html";

export type EditorCommand =
  | "bold"
  | "italic"
  | "underline"
  | "insertOrderedList"
  | "insertUnorderedList"
  | "indent"
  | "outdent"
  | "justifyLeft"
  | "justifyCenter"
  | "justifyRight"
  | "removeFormat";

/** Font sizes offered in the toolbar, as the editing command's 1–7 scale. */
export const FONT_SIZES = [
  { label: "Small", value: "2" },
  { label: "Normal", value: "3" },
  { label: "Large", value: "5" },
  { label: "Huge", value: "6" },
] as const;

/* Message text colours. These go into the sent email, where the reader's
   client cannot resolve CSS variables, so they are literal sRGB values
   chosen to stay readable on a white message background. */
export const TEXT_COLORS = [
  { name: "Black", value: "rgb(32, 33, 36)" },
  { name: "Dark gray", value: "rgb(95, 99, 104)" },
  { name: "Red", value: "rgb(197, 34, 31)" },
  { name: "Orange", value: "rgb(200, 85, 0)" },
  { name: "Gold", value: "rgb(150, 110, 0)" },
  { name: "Green", value: "rgb(24, 128, 56)" },
  { name: "Teal", value: "rgb(0, 121, 107)" },
  { name: "Blue", value: "rgb(25, 103, 210)" },
  { name: "Indigo", value: "rgb(57, 73, 171)" },
  { name: "Purple", value: "rgb(132, 48, 206)" },
  { name: "Pink", value: "rgb(194, 24, 91)" },
  { name: "Brown", value: "rgb(121, 85, 72)" },
] as const;

function exec(command: string, value?: string): boolean {
  return document.execCommand(command, false, value);
}

/** Put the caret back in the editor if a toolbar control took focus. */
function focusEditor(editor: HTMLElement, range: Range | null): void {
  const selection = document.getSelection();
  if (range !== null && selection !== null) {
    editor.focus();
    selection.removeAllRanges();
    selection.addRange(range);
    return;
  }
  if (selection === null || !editor.contains(selection.anchorNode)) editor.focus();
}

function changed(editor: HTMLElement): void {
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The selection inside `editor`, cloned so a popover can restore it. */
export function saveSelection(editor: HTMLElement | null): Range | null {
  const selection = document.getSelection();
  if (editor === null || selection === null || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return editor.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

export function runCommand(
  editor: HTMLElement | null,
  command: EditorCommand,
  range: Range | null = null,
): void {
  if (editor === null) return;
  focusEditor(editor, range);
  exec("styleWithCSS", "true");
  exec(command);
  changed(editor);
}

export function setFontSize(editor: HTMLElement | null, size: string, range: Range | null): void {
  if (editor === null) return;
  focusEditor(editor, range);
  exec("styleWithCSS", "true");
  exec("fontSize", size);
  changed(editor);
}

export function setTextColor(editor: HTMLElement | null, color: string, range: Range | null): void {
  if (editor === null) return;
  focusEditor(editor, range);
  exec("styleWithCSS", "true");
  exec("foreColor", color);
  changed(editor);
}

export function toggleQuote(editor: HTMLElement | null, range: Range | null): void {
  if (editor === null) return;
  focusEditor(editor, range);
  const selection = document.getSelection();
  const quoted =
    selection?.anchorNode instanceof Node &&
    (selection.anchorNode instanceof Element
      ? selection.anchorNode
      : selection.anchorNode.parentElement
    )?.closest("blockquote") != null;
  exec("formatBlock", quoted ? "div" : "blockquote");
  changed(editor);
}

/** Insert a link at `range`, using the selected text when no text is given. */
export function insertLink(
  editor: HTMLElement | null,
  input: { readonly url: string; readonly text: string },
  range: Range | null,
): boolean {
  const href = safeLinkHref(input.url);
  if (editor === null || href === null) return false;
  focusEditor(editor, range);
  const selected = document.getSelection()?.toString() ?? "";
  const text = input.text.trim() || selected || input.url.trim();
  exec("insertHTML", `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`);
  changed(editor);
  return true;
}

export function insertText(editor: HTMLElement | null, text: string, range: Range | null): void {
  if (editor === null) return;
  focusEditor(editor, range);
  exec("insertText", text);
  changed(editor);
}

/** Paste as sanitized HTML (or plain text), never raw clipboard markup. */
export function pasteSanitized(editor: HTMLElement, data: DataTransfer): void {
  const html = data.getData("text/html");
  if (html !== "") exec("insertHTML", sanitizeComposeHtml(html));
  else exec("insertText", data.getData("text/plain"));
  changed(editor);
}
