/* Seed helper: build a real Yjs document body for seeded Docs documents.
 *
 * The Docs editor (apps/web) renders a document's body through Tiptap's
 * `Collaboration` extension, which binds to a Yjs `XmlFragment` named
 * `"default"` — the ProseMirror document tree. The backend persists that
 * tree in `docs_documents.ydoc_state` as an encoded Yjs update and replays
 * it into a fresh `Y.Doc` for every sync room (see
 * `apps/helix/src/platform/docs/routes.ts`).
 *
 * The workspace seed previously wrote raw markdown bytes into `ydoc_state`,
 * which is not a valid Yjs update — so the document fell back to stuffing the
 * bytes into a `getText("markdown")` type that the editor never reads.
 * Result: every seeded doc opened with an empty body.
 *
 * This module converts a doc's markdown into a populated `default`
 * XmlFragment matching the StarterKit ProseMirror schema (paragraphs,
 * headings, bullet/ordered lists, code blocks, with bold / italic / inline
 * code marks) and returns the encoded Yjs state so the seed can store a body
 * the editor actually renders.
 */

import * as Y from "yjs";

/** ProseMirror inline mark names emitted into Yjs XmlText formatting. */
type InlineMark = "bold" | "italic" | "code";

interface InlineRun {
  readonly text: string;
  readonly marks: ReadonlySet<InlineMark>;
}

/**
 * Parse a single line of markdown into styled inline runs, honoring
 * `**bold**`, `*italic*` / `_italic_`, and inline `code` spans.
 */
function parseInline(line: string): readonly InlineRun[] {
  const runs: InlineRun[] = [];
  let index = 0;
  let plainStart = 0;
  const active = new Set<InlineMark>();

  const flushPlain = (end: number): void => {
    if (end > plainStart) {
      runs.push({ text: line.slice(plainStart, end), marks: new Set(active) });
    }
  };

  while (index < line.length) {
    const two = line.slice(index, index + 2);
    const one = line[index];
    // Inside an inline-code span, only a closing backtick is significant —
    // `*` / `_` are literal characters (e.g. `resource_type`).
    if (one === "`") {
      flushPlain(index);
      if (active.has("code")) {
        active.delete("code");
      } else {
        active.add("code");
      }
      index += 1;
      plainStart = index;
      continue;
    }
    if (active.has("code")) {
      index += 1;
      continue;
    }
    if (two === "**") {
      flushPlain(index);
      if (active.has("bold")) {
        active.delete("bold");
      } else {
        active.add("bold");
      }
      index += 2;
      plainStart = index;
      continue;
    }
    if ((one === "*" || one === "_") && line[index + 1] !== one) {
      flushPlain(index);
      if (active.has("italic")) {
        active.delete("italic");
      } else {
        active.add("italic");
      }
      index += 1;
      plainStart = index;
      continue;
    }
    index += 1;
  }
  flushPlain(line.length);
  return runs.filter((run) => run.text.length > 0);
}

/** Build a Yjs XmlText for one line of markdown, with inline marks applied. */
function inlineText(line: string): Y.XmlText {
  const text = new Y.XmlText();
  let offset = 0;
  for (const run of parseInline(line)) {
    const attributes: Record<string, true> = {};
    for (const mark of run.marks) {
      attributes[mark] = true;
    }
    text.insert(offset, run.text, attributes);
    offset += run.text.length;
  }
  return text;
}

/** A Yjs XmlText with no inline marks (used for code-block contents). */
function inlineTextPlain(value: string): Y.XmlText {
  const text = new Y.XmlText();
  if (value.length > 0) {
    text.insert(0, value);
  }
  return text;
}

/**
 * Set a Yjs XmlElement attribute, preserving the value's runtime type.
 *
 * Yjs serializes attribute values as-is, and the Yjs → ProseMirror import
 * passes them straight to the node schema — so a heading's `level` must stay
 * a `number`. `XmlElement`'s default attribute map is typed `string`-valued,
 * hence the local cast.
 */
function setTypedAttribute(element: Y.XmlElement, name: string, value: number): void {
  (element.setAttribute as unknown as (key: string, value: number) => void)(name, value);
}

/** Create a ProseMirror block element (paragraph/heading) with one text line. */
function blockElement(nodeName: string, line: string, level?: number): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  if (level !== undefined) {
    setTypedAttribute(element, "level", level);
  }
  element.insert(0, [inlineText(line)]);
  return element;
}

/** Create a `listItem` wrapping a single paragraph for a list entry. */
function listItem(line: string): Y.XmlElement {
  const item = new Y.XmlElement("listItem");
  item.insert(0, [blockElement("paragraph", line)]);
  return item;
}

/** Create a `codeBlock` element from collected code lines. */
function codeBlockElement(lines: readonly string[]): Y.XmlElement {
  const codeBlock = new Y.XmlElement("codeBlock");
  codeBlock.insert(0, [inlineTextPlain(lines.join("\n"))]);
  return codeBlock;
}

/**
 * Convert a markdown string into the ProseMirror block nodes that make up a
 * StarterKit document body.
 */
function markdownToBlocks(markdown: string): Y.XmlElement[] {
  const blocks: Y.XmlElement[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");

  let listBuffer: { kind: "bulletList" | "orderedList"; items: Y.XmlElement[] } | null = null;
  let codeBuffer: string[] | null = null;

  const flushList = (): void => {
    if (listBuffer !== null && listBuffer.items.length > 0) {
      const list = new Y.XmlElement(listBuffer.kind);
      list.insert(0, listBuffer.items);
      blocks.push(list);
    }
    listBuffer = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");

    if (codeBuffer !== null) {
      if (line.trim().startsWith("```")) {
        blocks.push(codeBlockElement(codeBuffer));
        codeBuffer = null;
      } else {
        codeBuffer.push(rawLine);
      }
      continue;
    }
    if (line.trim().startsWith("```")) {
      flushList();
      codeBuffer = [];
      continue;
    }

    if (line.trim().length === 0) {
      flushList();
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch !== null) {
      flushList();
      blocks.push(blockElement("heading", headingMatch[2] ?? "", (headingMatch[1] ?? "").length));
      continue;
    }

    const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bulletMatch !== null) {
      if (listBuffer === null || listBuffer.kind !== "bulletList") {
        flushList();
        listBuffer = { kind: "bulletList", items: [] };
      }
      listBuffer.items.push(listItem(bulletMatch[1] ?? ""));
      continue;
    }

    const orderedMatch = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (orderedMatch !== null) {
      if (listBuffer === null || listBuffer.kind !== "orderedList") {
        flushList();
        listBuffer = { kind: "orderedList", items: [] };
      }
      listBuffer.items.push(listItem(orderedMatch[1] ?? ""));
      continue;
    }

    flushList();
    blocks.push(blockElement("paragraph", line));
  }

  if (codeBuffer !== null && codeBuffer.length > 0) {
    blocks.push(codeBlockElement(codeBuffer));
  }
  flushList();

  if (blocks.length === 0) {
    blocks.push(blockElement("paragraph", ""));
  }
  return blocks;
}

/**
 * Build the Yjs document state for a Docs body from markdown.
 *
 * The returned buffer is a valid Yjs update encoding the `"default"`
 * XmlFragment that Tiptap's `Collaboration` extension renders. Store it in
 * `docs_documents.ydoc_state`.
 */
export function buildDocsBodyState(markdown: string): {
  readonly state: Buffer;
  readonly stateVector: Buffer;
} {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("default");
  fragment.insert(0, markdownToBlocks(markdown));
  return {
    state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    stateVector: Buffer.from(Y.encodeStateVector(doc)),
  };
}
