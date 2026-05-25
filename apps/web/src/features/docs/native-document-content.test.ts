import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  nativeDocumentBlocksFromStateBase64,
  nativeDocumentInspectorSnapshotFromProseMirrorDoc,
  nativeDocumentOutlineFromBlocks,
  nativeDocumentPlainTextFromStateBase64,
  nativeDocumentStatsFromBlocks,
} from "./native-document-content";

describe("native document content", () => {
  it("extracts safe read-only blocks from a Yjs XmlFragment state", () => {
    const stateBase64 = nativeStateBase64([
      paragraph("Intro paragraph"),
      heading("Section", 2),
      list("bulletList", ["First", "Second"]),
      codeBlock("const value = 1;"),
    ]);

    expect(nativeDocumentBlocksFromStateBase64(stateBase64)).toMatchObject([
      { kind: "paragraph", text: "Intro paragraph" },
      { kind: "heading", level: 2, text: "Section" },
      {
        kind: "bulletList",
        items: [
          { kind: "listItem", text: "First" },
          { kind: "listItem", text: "Second" },
        ],
      },
      { kind: "codeBlock", text: "const value = 1;" },
    ]);
    expect(nativeDocumentPlainTextFromStateBase64(stateBase64)).toContain("Second");
  });

  it("derives outline and document stats from native blocks", () => {
    const blocks = nativeDocumentBlocksFromStateBase64(
      nativeStateBase64([
        heading("Overview", 1),
        paragraph("First paragraph has four words."),
        heading("Details", 2),
        list("orderedList", ["Nested item", "Another item"]),
      ]),
    );

    expect(nativeDocumentOutlineFromBlocks(blocks)).toEqual([
      { id: "heading-1", level: 1, title: "Overview" },
      { id: "heading-2", level: 2, title: "Details" },
    ]);
    expect(nativeDocumentStatsFromBlocks(blocks)).toMatchObject({
      headingCount: 2,
      wordCount: 11,
    });
  });

  it("keeps outline IDs positional across duplicate, nested, and empty headings", () => {
    const nestedList = new Y.XmlElement("bulletList");
    const nestedItem = new Y.XmlElement("listItem");
    nestedItem.insert(0, [heading("Overview", 3)]);
    nestedList.insert(0, [nestedItem]);
    const blocks = nativeDocumentBlocksFromStateBase64(
      nativeStateBase64([
        heading("Overview", 1),
        heading("   ", 2),
        nestedList,
        heading("Overview", 2),
      ]),
    );

    expect(nativeDocumentOutlineFromBlocks(blocks)).toEqual([
      { id: "heading-1", level: 1, title: "Overview" },
      { id: "heading-2", level: 3, title: "Overview" },
      { id: "heading-3", level: 2, title: "Overview" },
    ]);
  });

  it("falls back to an empty paragraph for invalid state", () => {
    expect(nativeDocumentBlocksFromStateBase64("not-valid-base64")).toEqual([
      { kind: "paragraph", text: "" },
    ]);
  });

  it("derives live inspector snapshots from ProseMirror document nodes", () => {
    const snapshot = nativeDocumentInspectorSnapshotFromProseMirrorDoc(
      pmNode("doc", [
        pmNode("heading", [pmText("Live Heading")], { level: 1 }),
        pmNode("paragraph", [pmText("Edited body text")]),
        pmNode("bulletList", [pmNode("listItem", [pmNode("paragraph", [pmText("Tracked item")])])]),
      ]),
    );

    expect(snapshot.outline).toEqual([{ id: "heading-1", level: 1, title: "Live Heading" }]);
    expect(snapshot.stats).toMatchObject({
      blockCount: 5,
      headingCount: 1,
      wordCount: 7,
    });
  });
});

interface TestProseMirrorNode {
  readonly type: { readonly name: string };
  readonly attrs: Record<string, unknown>;
  readonly text?: string;
  readonly textContent: string;
  readonly childCount: number;
  child(index: number): TestProseMirrorNode;
}

function pmNode(
  name: string,
  children: readonly TestProseMirrorNode[] = [],
  attrs: Record<string, unknown> = {},
): TestProseMirrorNode {
  return {
    type: { name },
    attrs,
    textContent: children.map((child) => child.textContent).join(""),
    childCount: children.length,
    child(index: number) {
      const child = children[index];
      if (child === undefined) {
        throw new Error(`Missing child ${String(index)}`);
      }
      return child;
    },
  };
}

function pmText(text: string): TestProseMirrorNode {
  return {
    type: { name: "text" },
    attrs: {},
    text,
    textContent: text,
    childCount: 0,
    child() {
      throw new Error("Text nodes do not have children.");
    },
  };
}

function nativeStateBase64(blocks: readonly Y.XmlElement[]): string {
  const doc = new Y.Doc();
  doc.getXmlFragment("default").insert(0, [...blocks]);
  return bytesToBase64(Y.encodeStateAsUpdate(doc));
}

function paragraph(text: string): Y.XmlElement {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [xmlText(text)]);
  return element;
}

function heading(text: string, level: number): Y.XmlElement {
  const element = new Y.XmlElement("heading");
  (element.setAttribute as unknown as (name: string, value: number) => void)("level", level);
  element.insert(0, [xmlText(text)]);
  return element;
}

function list(kind: "bulletList" | "orderedList", items: readonly string[]): Y.XmlElement {
  const element = new Y.XmlElement(kind);
  element.insert(
    0,
    items.map((item) => {
      const listItem = new Y.XmlElement("listItem");
      listItem.insert(0, [paragraph(item)]);
      return listItem;
    }),
  );
  return element;
}

function codeBlock(text: string): Y.XmlElement {
  const element = new Y.XmlElement("codeBlock");
  element.insert(0, [xmlText(text)]);
  return element;
}

function xmlText(text: string): Y.XmlText {
  const value = new Y.XmlText();
  value.insert(0, text);
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
