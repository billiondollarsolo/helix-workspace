import * as Y from "yjs";

export type NativeDocumentBlock =
  | {
      readonly kind: "paragraph";
      readonly text: string;
    }
  | {
      readonly kind: "codeBlock";
      readonly text: string;
    }
  | {
      readonly kind: "heading";
      readonly text: string;
      readonly level: number;
    }
  | {
      readonly kind: "bulletList";
      readonly items: readonly NativeDocumentBlock[];
    }
  | {
      readonly kind: "orderedList";
      readonly items: readonly NativeDocumentBlock[];
    }
  | {
      readonly kind: "listItem";
      readonly items: readonly NativeDocumentBlock[];
      readonly text: string;
    };

export interface NativeDocumentOutlineItem {
  readonly id: string;
  readonly level: number;
  readonly title: string;
}

export interface NativeDocumentStats {
  readonly blockCount: number;
  readonly characterCount: number;
  readonly headingCount: number;
  readonly wordCount: number;
}

export interface NativeDocumentInspectorSnapshot {
  readonly blocks: readonly NativeDocumentBlock[];
  readonly outline: readonly NativeDocumentOutlineItem[];
  readonly stats: NativeDocumentStats;
}

type YXmlChild = Y.XmlElement | Y.XmlText | Y.XmlHook;

interface ProseMirrorNodeLike {
  readonly type?: { readonly name?: string | undefined } | undefined;
  readonly attrs?: Record<string, unknown> | undefined;
  readonly text?: string | null | undefined;
  readonly textContent?: string | undefined;
  readonly isText?: boolean | undefined;
  readonly childCount?: number | undefined;
  child?(index: number): ProseMirrorNodeLike;
}

export function nativeDocumentBlocksFromStateBase64(
  stateBase64: string | null,
): readonly NativeDocumentBlock[] {
  const state = base64ToUint8Array(stateBase64);
  if (state === null || state.byteLength === 0) {
    return [{ kind: "paragraph", text: "" }];
  }

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
  } catch {
    return [{ kind: "paragraph", text: "" }];
  }
  return xmlChildrenToBlocks(doc.getXmlFragment("default").toArray());
}

export function nativeDocumentPlainTextFromStateBase64(stateBase64: string | null): string {
  return nativeDocumentPlainTextFromBlocks(nativeDocumentBlocksFromStateBase64(stateBase64));
}

export function nativeDocumentPlainTextFromBlocks(blocks: readonly NativeDocumentBlock[]): string {
  return blocksToPlainText(blocks);
}

export function nativeDocumentOutlineFromBlocks(
  blocks: readonly NativeDocumentBlock[],
): readonly NativeDocumentOutlineItem[] {
  const outline: NativeDocumentOutlineItem[] = [];
  collectOutline(blocks, outline);
  return outline;
}

export function nativeDocumentStatsFromBlocks(
  blocks: readonly NativeDocumentBlock[],
): NativeDocumentStats {
  const text = blocksToPlainText(blocks);
  return {
    blockCount: countBlocks(blocks),
    characterCount: text.length,
    headingCount: nativeDocumentOutlineFromBlocks(blocks).length,
    wordCount: countWords(text),
  };
}

export function nativeDocumentInspectorSnapshotFromBlocks(
  blocks: readonly NativeDocumentBlock[],
): NativeDocumentInspectorSnapshot {
  return {
    blocks,
    outline: nativeDocumentOutlineFromBlocks(blocks),
    stats: nativeDocumentStatsFromBlocks(blocks),
  };
}

export function nativeDocumentInspectorSnapshotFromProseMirrorDoc(
  doc: ProseMirrorNodeLike,
): NativeDocumentInspectorSnapshot {
  const blocks = nativeDocumentBlocksFromProseMirrorDoc(doc);
  return nativeDocumentInspectorSnapshotFromBlocks(blocks);
}

export function nativeDocumentBlocksFromProseMirrorDoc(
  doc: ProseMirrorNodeLike,
): readonly NativeDocumentBlock[] {
  const blocks: NativeDocumentBlock[] = [];
  const childCount = typeof doc.childCount === "number" ? doc.childCount : 0;
  for (let index = 0; index < childCount; index += 1) {
    const child = doc.child?.(index);
    if (child !== undefined) {
      blocks.push(...proseMirrorNodeToBlocks(child));
    }
  }
  return blocks.length === 0 ? [{ kind: "paragraph", text: proseMirrorNodeText(doc) }] : blocks;
}

function base64ToUint8Array(value: string | null): Uint8Array | null {
  if (value === null || value.length === 0) {
    return null;
  }
  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function xmlChildrenToBlocks(children: readonly YXmlChild[]): readonly NativeDocumentBlock[] {
  return children.flatMap((child): NativeDocumentBlock[] => {
    if (child instanceof Y.XmlText) {
      return [{ kind: "paragraph", text: xmlTextPlainText(child) }];
    }
    if (!(child instanceof Y.XmlElement)) {
      return [];
    }

    const nodeName = child.nodeName;
    const nested = xmlChildrenToBlocks(child.toArray());
    if (nodeName === "heading") {
      const level = child.getAttribute("level");
      return [
        {
          kind: "heading",
          text: xmlChildrenText(child.toArray()),
          level: typeof level === "number" ? level : 1,
        },
      ];
    }
    if (nodeName === "paragraph" || nodeName === "codeBlock") {
      return [{ kind: nodeName, text: xmlChildrenText(child.toArray()) }];
    }
    if (nodeName === "bulletList" || nodeName === "orderedList") {
      return [{ kind: nodeName, items: nested }];
    }
    if (nodeName === "listItem") {
      return [{ kind: "listItem", items: nested, text: blocksToPlainText(nested) }];
    }
    return [{ kind: "paragraph", text: xmlChildrenText(child.toArray()) }];
  });
}

function xmlChildrenText(children: readonly YXmlChild[]): string {
  return children
    .map((child) => {
      if (child instanceof Y.XmlText) {
        return xmlTextPlainText(child);
      }
      if (child instanceof Y.XmlElement) {
        return xmlChildrenText(child.toArray());
      }
      return "";
    })
    .join("");
}

function blocksToPlainText(blocks: readonly NativeDocumentBlock[]): string {
  return blocks
    .map((block) => {
      if ("text" in block) {
        return block.text;
      }
      return blocksToPlainText(block.items);
    })
    .join("\n")
    .trim();
}

function collectOutline(
  blocks: readonly NativeDocumentBlock[],
  outline: NativeDocumentOutlineItem[],
): void {
  for (const block of blocks) {
    if (block.kind === "heading" && block.text.trim().length > 0) {
      outline.push({
        id: `heading-${String(outline.length + 1)}`,
        level: block.level,
        title: block.text.trim(),
      });
      continue;
    }
    if ("items" in block) {
      collectOutline(block.items, outline);
    }
  }
}

function countBlocks(blocks: readonly NativeDocumentBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    count += 1;
    if ("items" in block) {
      count += countBlocks(block.items);
    }
  }
  return count;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  return trimmed.split(/\s+/u).filter(Boolean).length;
}

function xmlTextPlainText(text: Y.XmlText): string {
  const delta = (text.toDelta as () => readonly { readonly insert?: unknown }[])();
  return delta.map((item) => (typeof item.insert === "string" ? item.insert : "")).join("");
}

function proseMirrorNodeToBlocks(node: ProseMirrorNodeLike): readonly NativeDocumentBlock[] {
  const nodeName = node.type?.name;
  if (node.isText === true) {
    return [{ kind: "paragraph", text: node.text ?? "" }];
  }
  if (nodeName === "heading") {
    const level = node.attrs?.level;
    return [
      {
        kind: "heading",
        text: proseMirrorNodeText(node),
        level: typeof level === "number" ? level : 1,
      },
    ];
  }
  if (nodeName === "codeBlock") {
    return [{ kind: "codeBlock", text: proseMirrorNodeText(node) }];
  }
  if (nodeName === "bulletList" || nodeName === "orderedList") {
    return [{ kind: nodeName, items: proseMirrorChildBlocks(node) }];
  }
  if (nodeName === "listItem") {
    const items = proseMirrorChildBlocks(node);
    return [
      { kind: "listItem", items, text: blocksToPlainText(items) || proseMirrorNodeText(node) },
    ];
  }
  if (nodeName === "paragraph") {
    return [{ kind: "paragraph", text: proseMirrorNodeText(node) }];
  }
  const childBlocks = proseMirrorChildBlocks(node);
  return childBlocks.length === 0
    ? [{ kind: "paragraph", text: proseMirrorNodeText(node) }]
    : childBlocks;
}

function proseMirrorChildBlocks(node: ProseMirrorNodeLike): readonly NativeDocumentBlock[] {
  const blocks: NativeDocumentBlock[] = [];
  const childCount = typeof node.childCount === "number" ? node.childCount : 0;
  for (let index = 0; index < childCount; index += 1) {
    const child = node.child?.(index);
    if (child !== undefined) {
      blocks.push(...proseMirrorNodeToBlocks(child));
    }
  }
  return blocks;
}

function proseMirrorNodeText(node: ProseMirrorNodeLike): string {
  if (typeof node.text === "string") {
    return node.text;
  }
  if (typeof node.textContent === "string") {
    return node.textContent;
  }
  return proseMirrorChildBlocks(node)
    .map((block) => ("text" in block ? block.text : blocksToPlainText(block.items)))
    .join("\n")
    .trim();
}
