import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  createNativeDocumentState,
  DOCS_NATIVE_YJS_FRAGMENT,
  documentStateFromStoredUpdates,
  documentTextFromStoredState,
  replaceFirstTextInStoredState,
  stateVectorFromStoredState,
} from "./native-state.js";

describe("native document state", () => {
  it("seeds markdown into the TipTap-compatible Yjs XmlFragment", () => {
    const { state, stateVector } = createNativeDocumentState("# Title\n\nA paragraph");
    const doc = new Y.Doc();

    Y.applyUpdate(doc, new Uint8Array(state));

    const fragment = doc.getXmlFragment(DOCS_NATIVE_YJS_FRAGMENT);
    const children = fragment.toArray();
    const heading = children[0];
    const paragraph = children[1];
    expect(heading).toBeInstanceOf(Y.XmlElement);
    expect(paragraph).toBeInstanceOf(Y.XmlElement);
    if (!(heading instanceof Y.XmlElement) || !(paragraph instanceof Y.XmlElement)) {
      throw new Error("Expected native state to contain XML element blocks");
    }
    expect(heading.nodeName).toBe("heading");
    expect(heading.getAttribute("level")).toBe(1);
    expect(blockText(heading)).toBe("Title");
    expect(paragraph.nodeName).toBe("paragraph");
    expect(blockText(paragraph)).toBe("A paragraph");
    expect(stateVector.byteLength).toBeGreaterThan(0);
  });

  it("extracts document text from native, legacy Y.Text, and raw legacy states", () => {
    const native = createNativeDocumentState("Native body");
    const legacyDoc = new Y.Doc();
    legacyDoc.getText("markdown").insert(0, "Legacy body");
    const legacyState = Buffer.from(Y.encodeStateAsUpdate(legacyDoc));

    expect(documentTextFromStoredState(native.state)).toBe("Native body");
    expect(documentTextFromStoredState(legacyState)).toBe("Legacy body");
    expect(documentTextFromStoredState(Buffer.from("Raw legacy body", "utf8"))).toBe(
      "Raw legacy body",
    );
    expect(documentTextFromStoredState(null)).toBe("");
  });

  it("replaces text in native and legacy Yjs states for accepted suggestions", () => {
    const native = createNativeDocumentState("# Plan\n\nNeeds owner");
    const replacedNative = replaceFirstTextInStoredState({
      state: native.state,
      beforeText: "Needs owner",
      afterText: "Ada owns this",
    });
    expect(replacedNative).not.toBeNull();
    expect(documentTextFromStoredState(replacedNative?.state ?? null)).toContain("Ada owns this");
    expect(replacedNative?.update.byteLength).toBeGreaterThan(0);
    expect(replacedNative?.stateVector.byteLength).toBeGreaterThan(0);

    const legacyDoc = new Y.Doc();
    legacyDoc.getText("markdown").insert(0, "Legacy needs owner");
    const replacedLegacy = replaceFirstTextInStoredState({
      state: Buffer.from(Y.encodeStateAsUpdate(legacyDoc)),
      beforeText: "needs owner",
      afterText: "has owner",
    });
    expect(documentTextFromStoredState(replacedLegacy?.state ?? null)).toBe("Legacy has owner");
  });

  it("uses native selection anchors before first text match replacement", () => {
    const native = createNativeDocumentState("First repeat\n\nSecond repeat");
    const replacedNative = replaceFirstTextInStoredState({
      state: native.state,
      beforeText: "repeat",
      afterText: "choice",
      anchorSelection: { from: 22, to: 28, text: "repeat" },
    });

    expect(documentTextFromStoredState(replacedNative?.state ?? null)).toBe(
      "First repeat\nSecond choice",
    );

    const staleAnchorReplacement = replaceFirstTextInStoredState({
      state: native.state,
      beforeText: "repeat",
      afterText: "fallback",
      anchorSelection: { from: 22, to: 28, text: "missing" },
    });

    expect(staleAnchorReplacement).toBeNull();

    const unanchoredReplacement = replaceFirstTextInStoredState({
      state: native.state,
      beforeText: "repeat",
      afterText: "fallback",
    });

    expect(documentTextFromStoredState(unanchoredReplacement?.state ?? null)).toBe(
      "First fallback\nSecond repeat",
    );
  });

  it("reconstructs best-effort state from ordered Yjs updates", () => {
    const doc = new Y.Doc();
    const markdown = doc.getText("markdown");
    markdown.insert(0, "First");
    const first = Buffer.from(Y.encodeStateAsUpdate(doc));
    const stateVector = Y.encodeStateVector(doc);
    markdown.insert(5, " Second");
    const second = Buffer.from(Y.encodeStateAsUpdate(doc, stateVector));

    const reconstructed = documentStateFromStoredUpdates([
      first,
      Buffer.from("not a yjs update", "utf8"),
      second,
    ]);

    expect(reconstructed.text).toBe("First Second");
    expect(reconstructed.appliedCount).toBe(2);
    expect(reconstructed.skippedCount).toBe(1);
    expect(stateVectorFromStoredState(reconstructed.state).byteLength).toBeGreaterThan(0);
  });
});

function blockText(element: Y.XmlElement): string {
  const deltas: Array<{ readonly insert?: unknown }> = [];
  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      deltas.push(...(child.toDelta() as Array<{ readonly insert?: unknown }>));
    }
  }
  return deltas.map((delta) => (typeof delta.insert === "string" ? delta.insert : "")).join("");
}
