import * as Y from "yjs";

export const HELIX_NATIVE_DOCUMENT_ENGINE = "helix-native-document" as const;
export const LEGACY_YJS_DOCUMENT_ENGINE = "legacy-yjs" as const;
export const DOCS_NATIVE_YJS_FRAGMENT = "default" as const;

export function createNativeDocumentState(markdown = ""): {
  readonly state: Buffer;
  readonly stateVector: Buffer;
} {
  const doc = new Y.Doc();
  doc.getXmlFragment(DOCS_NATIVE_YJS_FRAGMENT).insert(0, markdownToBlocks(markdown));
  return {
    state: Buffer.from(Y.encodeStateAsUpdate(doc)),
    stateVector: Buffer.from(Y.encodeStateVector(doc)),
  };
}

export function documentTextFromStoredState(state: Buffer | null): string {
  if (state === null || state.length === 0) {
    return "";
  }
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, new Uint8Array(state));
  } catch {
    return state.toString("utf8");
  }
  const nativeText = xmlChildrenText(doc.getXmlFragment(DOCS_NATIVE_YJS_FRAGMENT).toArray());
  if (nativeText.length > 0) {
    return nativeText;
  }
  return doc.getText("markdown").toJSON();
}

export function documentStateFromStoredUpdates(updates: readonly Buffer[]): {
  readonly state: Buffer;
  readonly text: string;
  readonly appliedCount: number;
  readonly skippedCount: number;
} {
  const doc = new Y.Doc();
  let appliedCount = 0;
  let skippedCount = 0;
  for (const update of updates) {
    try {
      Y.applyUpdate(doc, new Uint8Array(update));
      appliedCount += 1;
    } catch {
      skippedCount += 1;
    }
  }
  const state = Buffer.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return {
    state,
    text: documentTextFromStoredState(state),
    appliedCount,
    skippedCount,
  };
}

/**
 * Rebuild a Y.Doc from a stored state buffer. Legacy rows can hold raw UTF-8
 * markdown instead of a Yjs update, so a decode failure falls back to seeding
 * the "markdown" text type with the raw bytes.
 */
function docFromStoredState(state: Buffer | null): Y.Doc {
  const doc = new Y.Doc();
  if (state !== null && state.length > 0) {
    try {
      Y.applyUpdate(doc, new Uint8Array(state));
    } catch {
      doc.getText("markdown").insert(0, state.toString("utf8"));
    }
  }
  return doc;
}

export function stateVectorFromStoredState(state: Buffer | null): Buffer {
  const doc = docFromStoredState(state);
  const stateVector = Buffer.from(Y.encodeStateVector(doc));
  doc.destroy();
  return stateVector;
}

export interface NativeDocumentTextSelection {
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

export function replaceFirstTextInStoredState(input: {
  readonly state: Buffer | null;
  readonly beforeText: string;
  readonly afterText: string;
  readonly anchorSelection?: NativeDocumentTextSelection | undefined;
}): {
  readonly state: Buffer;
  readonly stateVector: Buffer;
  readonly update: Buffer;
} | null {
  if (input.beforeText.length === 0 || input.beforeText === input.afterText) {
    return null;
  }
  const doc = docFromStoredState(input.state);
  const beforeUpdate = Y.encodeStateVector(doc);
  const nativeChildren = doc.getXmlFragment(DOCS_NATIVE_YJS_FRAGMENT).toArray();
  const anchorSelection = normalizeTextSelection(input.anchorSelection);
  const replaced =
    anchorSelection === null
      ? replaceFirstTextInXmlChildren(nativeChildren, input.beforeText, input.afterText)
      : replaceAnchoredTextInXmlChildren({
          children: nativeChildren,
          selection: anchorSelection,
          beforeText: input.beforeText,
          afterText: input.afterText,
        });
  if (!replaced) {
    if (anchorSelection !== null) {
      doc.destroy();
      return null;
    }
    const markdown = doc.getText("markdown");
    const index = markdown.toJSON().indexOf(input.beforeText);
    if (index === -1) {
      doc.destroy();
      return null;
    }
    doc.transact(() => {
      markdown.delete(index, input.beforeText.length);
      markdown.insert(index, input.afterText);
    }, "docs.suggestion.accept");
  }
  const update = Y.encodeStateAsUpdate(doc, beforeUpdate);
  const state = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  return {
    state: Buffer.from(state),
    stateVector: Buffer.from(stateVector),
    update: Buffer.from(update),
  };
}

type YXmlChild = Y.XmlElement | Y.XmlText | Y.XmlHook;

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
    const line = rawLine.replace(/\s+$/u, "");
    if (codeBuffer !== null) {
      if (line.trim().startsWith("```")) {
        blocks.push(blockElement("codeBlock", codeBuffer.join("\n")));
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
    const headingMatch = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (headingMatch !== null) {
      flushList();
      blocks.push(blockElement("heading", headingMatch[2] ?? "", (headingMatch[1] ?? "").length));
      continue;
    }
    const bulletMatch = /^\s*[-*]\s+(.*)$/u.exec(line);
    if (bulletMatch !== null) {
      if (listBuffer === null || listBuffer.kind !== "bulletList") {
        flushList();
        listBuffer = { kind: "bulletList", items: [] };
      }
      listBuffer.items.push(listItem(bulletMatch[1] ?? ""));
      continue;
    }
    const orderedMatch = /^\s*\d+\.\s+(.*)$/u.exec(line);
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
    blocks.push(blockElement("codeBlock", codeBuffer.join("\n")));
  }
  flushList();
  return blocks.length === 0 ? [blockElement("paragraph", "")] : blocks;
}

function blockElement(nodeName: string, text: string, level?: number): Y.XmlElement {
  const element = new Y.XmlElement(nodeName);
  if (level !== undefined) {
    (element.setAttribute as unknown as (key: string, value: number) => void)("level", level);
  }
  const xmlText = new Y.XmlText();
  if (text.length > 0) {
    xmlText.insert(0, text);
  }
  element.insert(0, [xmlText]);
  return element;
}

function listItem(text: string): Y.XmlElement {
  const item = new Y.XmlElement("listItem");
  item.insert(0, [blockElement("paragraph", text)]);
  return item;
}

function xmlChildrenText(children: readonly YXmlChild[]): string {
  return children
    .map((child) => {
      if (child instanceof Y.XmlText) {
        return xmlTextPlainText(child);
      }
      if (child instanceof Y.XmlElement) {
        const nested = xmlChildrenText(child.toArray());
        return child.nodeName === "paragraph" || child.nodeName === "heading"
          ? `${nested}\n`
          : nested;
      }
      return "";
    })
    .join("")
    .trim();
}

function replaceFirstTextInXmlChildren(
  children: readonly YXmlChild[],
  beforeText: string,
  afterText: string,
): boolean {
  for (const child of children) {
    if (child instanceof Y.XmlText) {
      const index = xmlTextPlainText(child).indexOf(beforeText);
      if (index !== -1) {
        child.delete(index, beforeText.length);
        child.insert(index, afterText);
        return true;
      }
      continue;
    }
    if (
      child instanceof Y.XmlElement &&
      replaceFirstTextInXmlChildren(child.toArray(), beforeText, afterText)
    ) {
      return true;
    }
  }
  return false;
}

function replaceAnchoredTextInXmlChildren(input: {
  readonly children: readonly YXmlChild[];
  readonly selection: NativeDocumentTextSelection;
  readonly beforeText: string;
  readonly afterText: string;
}): boolean {
  return replaceAnchoredTextInXmlChildrenAt({ ...input, position: 0 }).replaced;
}

function replaceAnchoredTextInXmlChildrenAt(input: {
  readonly children: readonly YXmlChild[];
  readonly position: number;
  readonly selection: NativeDocumentTextSelection;
  readonly beforeText: string;
  readonly afterText: string;
}): { readonly replaced: boolean; readonly size: number } {
  let offset = input.position;
  let size = 0;
  for (const child of input.children) {
    const result = replaceAnchoredTextInXmlChild({
      child,
      position: offset,
      selection: input.selection,
      beforeText: input.beforeText,
      afterText: input.afterText,
    });
    if (result.replaced) {
      return { replaced: true, size: size + result.size };
    }
    offset += result.size;
    size += result.size;
  }
  return { replaced: false, size };
}

function replaceAnchoredTextInXmlChild(input: {
  readonly child: YXmlChild;
  readonly position: number;
  readonly selection: NativeDocumentTextSelection;
  readonly beforeText: string;
  readonly afterText: string;
}): { readonly replaced: boolean; readonly size: number } {
  if (input.child instanceof Y.XmlText) {
    const currentText = xmlTextPlainText(input.child);
    const size = currentText.length;
    if (input.selection.from < input.position || input.selection.to > input.position + size) {
      return { replaced: false, size };
    }
    const start = input.selection.from - input.position;
    const end = input.selection.to - input.position;
    const selectedText = currentText.slice(start, end);
    if (!sameSelectedText(selectedText, input.beforeText, input.selection.text)) {
      return { replaced: false, size };
    }
    input.child.delete(start, end - start);
    input.child.insert(start, input.afterText);
    return { replaced: true, size };
  }

  if (input.child instanceof Y.XmlElement) {
    const nested = replaceAnchoredTextInXmlChildrenAt({
      children: input.child.toArray(),
      position: input.position + 1,
      selection: input.selection,
      beforeText: input.beforeText,
      afterText: input.afterText,
    });
    return { replaced: nested.replaced, size: nested.size + 2 };
  }

  return { replaced: false, size: 1 };
}

function normalizeTextSelection(
  selection: NativeDocumentTextSelection | undefined,
): NativeDocumentTextSelection | null {
  if (
    selection === undefined ||
    !Number.isSafeInteger(selection.from) ||
    !Number.isSafeInteger(selection.to) ||
    selection.from < 0 ||
    selection.to <= selection.from ||
    selection.text.trim().length === 0
  ) {
    return null;
  }
  return selection;
}

function sameSelectedText(selectedText: string, beforeText: string, anchorText: string): boolean {
  const selected = selectedText.trim();
  const matchesBefore = selectedText === beforeText || selected === beforeText.trim();
  const matchesAnchor = selectedText === anchorText || selected === anchorText.trim();
  return matchesBefore && matchesAnchor;
}

function xmlTextPlainText(text: Y.XmlText): string {
  const delta = (text.toDelta as () => readonly { readonly insert?: unknown }[])();
  return delta.map((item) => (typeof item.insert === "string" ? item.insert : "")).join("");
}
