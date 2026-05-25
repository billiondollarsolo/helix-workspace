// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEditor } from "@tiptap/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateNativeDocumentEquationToken,
  activateNativeDocumentReferenceToken,
  assignNativeDocumentHeadingAnchors,
  findNativeDocumentTextMatches,
  NativeDocumentEditor,
  nativeDocumentBookmarkInsertionText,
  nativeDocumentBookmarkOptions,
  nativeDocumentCrossReferenceInsertionText,
  nativeDocumentCrossReferenceOptions,
  nativeDocumentDecorationRanges,
  nativeDocumentEquationInsertionText,
  nativeDocumentFieldInsertionText,
  nativeDocumentFieldRefreshRanges,
  nativeDocumentFindDecorationRanges,
  nativeDocumentSmartChipInsertionText,
  nativeDocumentTableOfContentsText,
  nativeDocumentTokenDecorationAttributes,
  nativeDocumentTokenDecorationRanges,
  selectNativeDocumentAnchorRange,
  type NativeDocumentEditorProps,
} from "./native-document-editor";
import type { DocsSuggestionDraft, NativeDocumentSession } from "./api";
import { dispatchNativeDocumentAnchorSelection } from "./native-document-anchors";
import { NATIVE_DOCUMENT_COMMAND_EVENT } from "./native-document-commands";

vi.mock("@tiptap/react", () => ({
  EditorContent: () => (
    <div className="native-document-editor__content" data-testid="editor-content">
      <h1>Session heading</h1>
      <h2> </h2>
      <h2>Session heading</h2>
    </div>
  ),
  useEditor: vi.fn(),
}));

vi.mock("./queries", async () => {
  const reactQuery =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    docsSessionQueryOptions: () =>
      reactQuery.queryOptions({
        queryKey: ["docs", "session"],
        queryFn: () => Promise.resolve({ actorId: "actor-1", name: "Ada" }),
        throwOnError: false,
      }),
    docsSmartChipPickerQueryOptions: () =>
      reactQuery.queryOptions({
        queryKey: ["docs", "smart-chip-picker"],
        queryFn: () =>
          Promise.resolve({
            people: [
              { id: "actor-2", label: "Grace Hopper" },
              { id: "actor-3", label: "Katherine Johnson" },
            ],
            documents: [
              { id: "doc-2", label: "Launch notes" },
              { id: "doc-3", label: "Roadmap appendix" },
            ],
            events: [{ id: "event-1", label: "Launch review" }],
          }),
        throwOnError: false,
      }),
  };
});

vi.mock("./native-document-yjs-provider", () => ({
  applyNativeDocumentState: vi.fn(),
  NativeDocumentYjsProvider: class {
    readonly awareness = { setLocalState: vi.fn() };
    readonly connect = vi.fn();
    readonly disconnect = vi.fn();
  },
}));

const useEditorMock = vi.mocked(useEditor);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let chain: FakeEditorChain;
let canChain: FakeEditorChain;
let activeFormats: Set<string>;
let decorationMetaCalls: unknown[];
let editorDispatch: ReturnType<typeof vi.fn>;

describe("NativeDocumentEditor find and replace", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    root = createRoot(container);
    chain = createFakeEditorChain();
    canChain = createFakeEditorChain();
    activeFormats = new Set(["bold", "underline", "heading:1"]);
    decorationMetaCalls = [];
    editorDispatch = vi.fn();
    mockEditorDocument("Session body paragraph body", 1);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("finds case-insensitive, non-overlapping text ranges in ProseMirror text nodes", () => {
    const doc = proseMirrorDocFromText("Alpha alpha aaaa", 3);

    expect(findNativeDocumentTextMatches(doc, "ALPHA")).toEqual([
      { from: 3, to: 8 },
      { from: 9, to: 14 },
    ]);
    expect(findNativeDocumentTextMatches(doc, "aa")).toEqual([
      { from: 15, to: 17 },
      { from: 17, to: 19 },
    ]);
    expect(findNativeDocumentTextMatches(doc, "")).toEqual([]);
  });

  it("builds valid find decoration ranges with one active match", () => {
    expect(
      nativeDocumentFindDecorationRanges(
        30,
        [
          { from: 3, to: 8 },
          { from: 9, to: 14 },
          { from: -1, to: 2 },
          { from: 22, to: 32 },
        ],
        5,
      ),
    ).toEqual([
      { from: 3, to: 8, active: false, index: 0 },
      { from: 9, to: 14, active: true, index: 1 },
    ]);
    expect(nativeDocumentFindDecorationRanges(30, [], 0)).toEqual([]);
    expect(nativeDocumentFindDecorationRanges(0, [{ from: 1, to: 2 }], 0)).toEqual([]);
  });

  it("assigns positional anchors to non-empty rendered editor headings", async () => {
    render();
    await settle();

    expect(container.querySelector<HTMLHeadingElement>("#heading-1")?.textContent).toBe(
      "Session heading",
    );
    expect(container.querySelector<HTMLHeadingElement>("#heading-2")?.textContent).toBe(
      "Session heading",
    );
    expect(
      Array.from(
        container.querySelectorAll<HTMLHeadingElement>(".native-document-editor__content h2"),
      )[0]?.id,
    ).toBe("");
  });

  it("can assign native heading anchors without React", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="native-document-editor__content"><h1>One</h1><h2> </h2><h2>One</h2></div>';

    expect(assignNativeDocumentHeadingAnchors(root)).toBe(2);
    expect(root.querySelector("#heading-1")?.textContent).toBe("One");
    expect(root.querySelector("#heading-2")?.textContent).toBe("One");
  });

  it("generates table-of-contents text from anchored headings", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="native-document-editor__content"><h1 id="heading-1">One</h1><h2 id="heading-2">Two</h2></div>';

    expect(nativeDocumentTableOfContentsText(root)).toBe(
      'Table of contents\n\n- {{REF heading-1 "One"}}\n  - {{REF heading-2 "Two"}}\n',
    );
    expect(nativeDocumentCrossReferenceOptions(root)).toEqual([
      { id: "heading-1", level: 1, title: "One" },
      { id: "heading-2", level: 2, title: "Two" },
    ]);
    expect(
      nativeDocumentCrossReferenceInsertionText({
        id: "heading-2",
        level: 2,
        title: 'Two "{draft}"',
      }),
    ).toBe('{{REF heading-2 "Two draft"}}');
  });

  it("builds bookmark tokens and exposes bookmark cross-reference options", () => {
    const root = document.createElement("div");
    root.innerHTML = [
      '<div class="native-document-editor__content">',
      '<h1 id="heading-1">One</h1>',
      '<span data-native-document-token-kind="bookmark" data-native-document-bookmark-id="launch-checklist" data-native-document-token-label="Launch checklist">Launch checklist</span>',
      "</div>",
    ].join("");

    expect(nativeDocumentBookmarkInsertionText("Launch checklist")).toBe(
      '{{BOOKMARK launch-checklist "Launch checklist"}}',
    );
    expect(nativeDocumentBookmarkInsertionText('Launch "{check}"')).toBe(
      '{{BOOKMARK launch-check "Launch check"}}',
    );
    expect(nativeDocumentBookmarkOptions(root)).toEqual([
      { id: "launch-checklist", level: 1, title: "Launch checklist" },
    ]);
    expect(nativeDocumentCrossReferenceOptions(root)).toEqual([
      { id: "heading-1", level: 1, title: "One" },
      { id: "launch-checklist", level: 1, title: "Launch checklist" },
    ]);
  });

  it("generates deterministic first-pass field tokens", () => {
    const now = new Date("2026-05-24T15:45:30.000Z");

    expect(nativeDocumentFieldInsertionText("date", { now })).toBe("{{DATE 2026-05-24}}");
    expect(nativeDocumentFieldInsertionText("time", { now })).toBe("{{TIME 15:45 UTC}}");
    expect(nativeDocumentFieldInsertionText("page")).toBe("{{PAGE}}");
    expect(nativeDocumentFieldInsertionText("author", { actorName: "Ada Lovelace" })).toBe(
      "{{AUTHOR Ada Lovelace}}",
    );
    expect(
      nativeDocumentFieldInsertionText("documentTitle", {
        documentTitle: 'Roadmap "{draft}"',
      }),
    ).toBe('{{PROPERTY title="Roadmap draft"}}');
  });

  it("builds document field refresh replacements without changing page fields", () => {
    const text = [
      "{{DATE 2025-01-01}}",
      "{{TIME 01:02 UTC}}",
      "{{PAGE}}",
      "{{AUTHOR Old}}",
      '{{PROPERTY title="Old title"}}',
      '{{REF heading-2 "Session heading"}}',
    ].join(" ");

    expect(
      nativeDocumentFieldRefreshRanges(proseMirrorDocFromText(text, 4), {
        actorName: "Ada Lovelace",
        documentTitle: "Native session doc",
        now: new Date("2026-05-24T15:45:30.000Z"),
      }).map((range) => range.text),
    ).toEqual([
      "{{DATE 2026-05-24}}",
      "{{TIME 15:45 UTC}}",
      "{{AUTHOR Ada Lovelace}}",
      '{{PROPERTY title="Native session doc"}}',
    ]);
    expect(nativeDocumentFieldRefreshRanges(proseMirrorDocFromText("{{PAGE}}", 1))).toEqual([]);
  });

  it("generates sanitized first-pass equation tokens", () => {
    expect(nativeDocumentEquationInsertionText("E=mc^2")).toBe('{{EQUATION latex="E=mc^2"}}');
    expect(nativeDocumentEquationInsertionText('x = "{y}"\n+ z')).toBe(
      '{{EQUATION latex="x = y + z"}}',
    );
  });

  it("generates deterministic first-pass smart chip tokens", () => {
    expect(
      nativeDocumentSmartChipInsertionText("person", {
        actorId: "actor-1",
        actorName: "Ada Lovelace",
      }),
    ).toBe('{{CHIP person label="Ada Lovelace" id="actor-1"}}');
    expect(
      nativeDocumentSmartChipInsertionText("doc", {
        documentId: "doc-1",
        documentTitle: 'Roadmap "{draft}"',
      }),
    ).toBe('{{CHIP doc label="Roadmap draft" id="doc-1"}}');
    expect(
      nativeDocumentSmartChipInsertionText("event", {
        eventId: "event-1",
        eventTitle: "Launch review",
      }),
    ).toBe('{{CHIP event label="Launch review" id="event-1"}}');
    expect(nativeDocumentSmartChipInsertionText("event")).toBe('{{CHIP event label="Event"}}');
  });

  it("selects anchored comment and suggestion ranges", async () => {
    render();
    await settle();

    act(() => {
      dispatchNativeDocumentAnchorSelection({
        documentId: "doc-1",
        selection: { from: 3, to: 11, text: "Session" },
      });
    });

    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 3, to: 11 });
    expect(chain.scrollIntoView).toHaveBeenCalled();
  });

  it("rejects invalid or cross-document anchor ranges", () => {
    const editor = { chain: vi.fn(() => chain) };

    expect(
      selectNativeDocumentAnchorRange(editor, "doc-1", {
        documentId: "doc-2",
        selection: { from: 3, to: 11, text: "Session" },
      }),
    ).toBe(false);
    expect(
      selectNativeDocumentAnchorRange(editor, "doc-1", {
        documentId: "doc-1",
        selection: { from: 11, to: 3, text: "Session" },
      }),
    ).toBe(false);
    expect(editor.chain).not.toHaveBeenCalled();

    expect(
      selectNativeDocumentAnchorRange(editor, "doc-1", {
        documentId: "doc-1",
        selection: { from: 3, to: 11, text: "Session" },
      }),
    ).toBe(true);
    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 3, to: 11 });
  });

  it("filters anchored decoration ranges to valid document positions", () => {
    expect(
      nativeDocumentDecorationRanges(
        20,
        [
          { id: "comment-1", kind: "comment", selection: { from: 2, to: 7, text: "body" } },
          {
            id: "suggestion-1",
            kind: "suggestion",
            selection: { from: 9, to: 14, text: "copy" },
          },
          { id: "stale-1", kind: "comment", selection: { from: 14, to: 40, text: "stale" } },
          { id: "empty-1", kind: "suggestion", selection: { from: 8, to: 8, text: "empty" } },
          { id: "moved-1", kind: "comment", selection: { from: 15, to: 19, text: "gone" } },
        ],
        (from, to) => {
          const textByRange: Record<string, string> = {
            "2:7": "body",
            "9:14": "copy",
            "15:19": "kept",
          };
          return textByRange[`${String(from)}:${String(to)}`] ?? "";
        },
      ),
    ).toEqual([
      { id: "comment-1", kind: "comment", from: 2, to: 7 },
      { id: "suggestion-1", kind: "suggestion", from: 9, to: 14 },
    ]);
  });

  it("finds native document token decoration ranges without changing persisted text", () => {
    const chip = '{{CHIP person label="Ada" id="actor-1"}}';
    const equation = '{{EQUATION latex="E=mc^2"}}';
    const bookmark = '{{BOOKMARK launch-checklist "Launch checklist"}}';
    const reference = '{{REF heading-2 "Session heading"}}';
    const date = "{{DATE 2026-05-24}}";
    const time = "{{TIME 15:45 UTC}}";
    const page = "{{PAGE}}";
    const author = "{{AUTHOR Ada}}";
    const property = '{{PROPERTY title="Native session doc"}}';
    const unknown = "{{UNKNOWN value}}";
    const text = [
      "A",
      chip,
      equation,
      bookmark,
      reference,
      date,
      time,
      page,
      author,
      property,
      unknown,
    ].join(" ");

    const ranges = nativeDocumentTokenDecorationRanges(proseMirrorDocFromText(text, 3));

    expect(ranges.map((range) => [range.kind, range.label])).toEqual([
      ["chip-person", "Ada"],
      ["equation", "E=mc^2"],
      ["bookmark", "Launch checklist"],
      ["reference", "Session heading"],
      ["field", "2026-05-24"],
      ["field", "15:45 UTC"],
      ["field", "Page 1"],
      ["field", "Ada"],
      ["field", "Native session doc"],
    ]);
    const chipRange = ranges[0];
    if (chipRange === undefined) {
      throw new Error("Expected smart chip token range.");
    }
    expect(chipRange).toMatchObject({
      from: 5,
      to: 5 + chip.length,
      chipKind: "person",
      tokenId: "actor-1",
      hoverCard: "Person · Ada · actor-1",
      title: "Person smart chip",
    });
    expect(nativeDocumentTokenDecorationAttributes(chipRange)).toMatchObject({
      "data-native-document-chip-kind": "person",
      "data-native-document-token-card": "Person · Ada · actor-1",
      "data-native-document-token-id": "actor-1",
      "data-native-document-token-from": "5",
      "data-native-document-token-to": String(5 + chip.length),
      tabindex: "0",
    });
    const equationRange = ranges[1];
    if (equationRange === undefined) {
      throw new Error("Expected equation token range.");
    }
    expect(nativeDocumentTokenDecorationAttributes(equationRange)).toMatchObject({
      "aria-label": "Edit equation E=mc^2",
      "data-native-document-equation-latex": "E=mc^2",
      "data-native-document-token-from": String(equationRange.from),
      "data-native-document-token-to": String(equationRange.to),
      role: "button",
      tabindex: "0",
    });
    const bookmarkRange = ranges[2];
    if (bookmarkRange === undefined) {
      throw new Error("Expected bookmark token range.");
    }
    expect(bookmarkRange).toMatchObject({
      kind: "bookmark",
      label: "Launch checklist",
      tokenId: "launch-checklist",
      title: "Bookmark: Launch checklist",
    });
    expect(nativeDocumentTokenDecorationAttributes(bookmarkRange)).toMatchObject({
      "aria-label": "Bookmark Launch checklist",
      "data-native-document-bookmark-id": "launch-checklist",
      "data-native-document-token-id": "launch-checklist",
      id: "launch-checklist",
      tabindex: "-1",
    });
    const referenceRange = ranges[3];
    if (referenceRange === undefined) {
      throw new Error("Expected cross-reference token range.");
    }
    expect(referenceRange).toMatchObject({
      kind: "reference",
      label: "Session heading",
      tokenId: "heading-2",
      referenceTargetId: "heading-2",
      title: "Cross-reference",
    });
    expect(nativeDocumentTokenDecorationAttributes(referenceRange)).toMatchObject({
      "aria-label": "Go to Session heading",
      "data-native-document-reference-target": "heading-2",
      "data-native-document-token-id": "heading-2",
      role: "button",
      tabindex: "0",
    });
    expect(text).toContain(unknown);
    expect(ranges.some((range) => range.label.includes("UNKNOWN"))).toBe(false);
  });

  it("activates cross-reference tokens by focusing the referenced heading", () => {
    const rootElement = document.createElement("div");
    rootElement.innerHTML = [
      '<span data-native-document-token-kind="reference" data-native-document-reference-target="heading-2" tabindex="0">',
      "<span>Session heading</span>",
      "</span>",
      '<h2 id="heading-2">Session heading</h2>',
    ].join("");
    document.body.append(rootElement);
    const tokenChild = rootElement.querySelector("span span");
    const heading = rootElement.querySelector<HTMLElement>("#heading-2");
    if (tokenChild === null || heading === null) {
      throw new Error("Missing reference token fixture.");
    }
    const scrollIntoView = vi.fn();
    heading.scrollIntoView = scrollIntoView;

    expect(activateNativeDocumentReferenceToken(rootElement, tokenChild)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(heading);
    expect(heading.tabIndex).toBe(-1);

    expect(activateNativeDocumentReferenceToken(rootElement, heading)).toBe(false);
    rootElement.remove();
  });

  it("activates cross-reference tokens that point to bookmarks", () => {
    const rootElement = document.createElement("div");
    rootElement.innerHTML = [
      '<span data-native-document-token-kind="reference" data-native-document-reference-target="launch-checklist" tabindex="0">',
      "<span>Launch checklist</span>",
      "</span>",
      '<span id="launch-checklist" data-native-document-token-kind="bookmark" tabindex="-1">Launch checklist</span>',
    ].join("");
    document.body.append(rootElement);
    const tokenChild = rootElement.querySelector("span span");
    const bookmark = rootElement.querySelector<HTMLElement>("#launch-checklist");
    if (tokenChild === null || bookmark === null) {
      throw new Error("Missing bookmark reference fixture.");
    }
    const scrollIntoView = vi.fn();
    bookmark.scrollIntoView = scrollIntoView;

    expect(activateNativeDocumentReferenceToken(rootElement, tokenChild)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(bookmark);
    rootElement.remove();
  });

  it("extracts equation token activation data from decorated descendants", () => {
    const rootElement = document.createElement("div");
    rootElement.innerHTML = [
      '<span data-native-document-token-kind="equation" data-native-document-token-from="7" data-native-document-token-to="34" data-native-document-equation-latex="E=mc^2" tabindex="0">',
      "<span>E=mc^2</span>",
      "</span>",
    ].join("");
    const tokenChild = rootElement.querySelector("span span");
    if (tokenChild === null) {
      throw new Error("Missing equation token fixture.");
    }

    expect(activateNativeDocumentEquationToken(rootElement, tokenChild)).toEqual({
      from: 7,
      to: 34,
      latex: "E=mc^2",
    });
    expect(activateNativeDocumentEquationToken(rootElement, rootElement)).toBeNull();
  });

  it("selects matches and replaces through editor transactions", async () => {
    render();
    await settle();

    setInputValue("native-document-find", "body");
    submitFindForm();
    await settle();

    expect(container.textContent ?? "").toContain("1 of 2");
    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 9, to: 13 });
    expect(latestFindDecorationMeta()).toMatchObject({
      findMatches: [
        { from: 9, to: 13 },
        { from: 24, to: 28 },
      ],
      activeFindMatchIndex: 0,
    });

    clickButton("Next");
    await settle();

    expect(container.textContent ?? "").toContain("2 of 2");
    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 24, to: 28 });
    expect(latestFindDecorationMeta()).toMatchObject({
      findMatches: [
        { from: 9, to: 13 },
        { from: 24, to: 28 },
      ],
      activeFindMatchIndex: 1,
    });

    clickButton("Previous");
    await settle();

    expect(container.textContent ?? "").toContain("1 of 2");
    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 9, to: 13 });

    clickButton("Next");
    await settle();

    setInputValue("native-document-replace", "copy");
    clickButton("Replace");
    await settle();

    expect(chain.insertContentAt).toHaveBeenCalledWith({ from: 24, to: 28 }, "copy");

    clickButton("Replace all");
    await settle();

    expect(chain.insertContentAt).toHaveBeenCalledWith({ from: 9, to: 13 }, "copy");
    expect(container.textContent ?? "").toContain("Replaced 2");
    expect(latestFindDecorationMeta()).toMatchObject({
      findMatches: [],
      activeFindMatchIndex: 0,
    });
  });

  it("runs document formatting commands from the toolbar", async () => {
    render();
    await settle();

    expect(buttonByLabel("Bold").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByLabel("Underline").getAttribute("aria-pressed")).toBe("true");
    expect(buttonByLabel("Heading 1").getAttribute("aria-pressed")).toBe("true");

    clickButtonByLabel("Bold");
    clickButtonByLabel("Italic");
    clickButtonByLabel("Underline");
    clickButtonByLabel("Strikethrough");
    clickButtonByLabel("Paragraph");
    clickButtonByLabel("Heading 1");
    clickButtonByLabel("Heading 2");
    clickButtonByLabel("Bullet list");
    clickButtonByLabel("Ordered list");
    clickButtonByLabel("Code block");
    await settle();

    expect(chain.toggleBold).toHaveBeenCalled();
    expect(chain.toggleItalic).toHaveBeenCalled();
    expect(chain.toggleUnderline).toHaveBeenCalled();
    expect(chain.toggleStrike).toHaveBeenCalled();
    expect(chain.setParagraph).toHaveBeenCalled();
    expect(chain.toggleHeading).toHaveBeenCalledWith({ level: 1 });
    expect(chain.toggleHeading).toHaveBeenCalledWith({ level: 2 });
    expect(chain.toggleBulletList).toHaveBeenCalled();
    expect(chain.toggleOrderedList).toHaveBeenCalled();
    expect(chain.toggleCodeBlock).toHaveBeenCalled();
  });

  it("inserts an auto-generated table of contents from document headings", async () => {
    render();
    await settle();

    clickButton("TOC");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      'Table of contents\n\n- {{REF heading-1 "Session heading"}}\n  - {{REF heading-2 "Session heading"}}\n',
    );
    expect(chain.run).toHaveBeenCalled();
  });

  it("inserts document field tokens from the toolbar", async () => {
    render();
    await settle();

    selectField("author");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith("{{AUTHOR Ada}}");

    selectField("documentTitle");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{PROPERTY title="Native session doc"}}');
    expect(fieldSelect().value).toBe("");
  });

  it("refreshes existing document field tokens from the toolbar", async () => {
    const text = [
      "{{DATE 2025-01-01}}",
      "{{TIME 01:02 UTC}}",
      "{{PAGE}}",
      "{{AUTHOR Old}}",
      '{{PROPERTY title="Old title"}}',
    ].join(" ");
    mockEditorDocument(text, 2);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-05-24T15:45:30.000Z"));
    render();
    await settle();

    clickButton("Refresh fields");
    await settle();

    expect(chain.insertContentAt).toHaveBeenNthCalledWith(
      1,
      { from: 65, to: 95 },
      '{{PROPERTY title="Native session doc"}}',
    );
    expect(chain.insertContentAt).toHaveBeenNthCalledWith(
      2,
      { from: 50, to: 64 },
      "{{AUTHOR Ada}}",
    );
    expect(chain.insertContentAt).toHaveBeenNthCalledWith(
      3,
      { from: 22, to: 40 },
      "{{TIME 15:45 UTC}}",
    );
    expect(chain.insertContentAt).toHaveBeenNthCalledWith(
      4,
      { from: 2, to: 21 },
      "{{DATE 2026-05-24}}",
    );
    expect(chain.run).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("inserts equation tokens from the toolbar", async () => {
    render();
    await settle();

    setInputValue("native-document-equation", "E=mc^2");
    clickButton("Equation");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{EQUATION latex="E=mc^2"}}');
    expect(equationInput().value).toBe("");
  });

  it("edits existing equation tokens without changing other content", async () => {
    render();
    await settle();

    appendEquationToken({ from: 5, to: 33, latex: "E=mc^2" });
    clickElementByLabel("Edit equation E=mc^2");
    await settle();

    expect(inputByLabel("Edit equation LaTeX").value).toBe("E=mc^2");
    setInputValue("native-document-edit-equation", 'x = "{y}"\n+ z');
    clickButton("Save equation");
    await settle();

    expect(chain.insertContentAt).toHaveBeenCalledWith(
      { from: 5, to: 33 },
      '{{EQUATION latex="x = y + z"}}',
    );
    expect(inputMaybe("Edit equation LaTeX")).toBeNull();
  });

  it("cancels equation token edits and blocks empty saves", async () => {
    render();
    await settle();

    appendEquationToken({ from: 5, to: 33, latex: "E=mc^2" });
    clickElementByLabel("Edit equation E=mc^2");
    await settle();

    setInputValue("native-document-edit-equation", " ");
    expect(buttonByText("Save equation").disabled).toBe(true);
    clickButton("Cancel");
    await settle();

    expect(inputMaybe("Edit equation LaTeX")).toBeNull();
    expect(chain.insertContentAt).not.toHaveBeenCalled();
  });

  it("inserts heading cross-reference tokens from the toolbar", async () => {
    render();
    await settle();

    selectCrossReference("heading-2");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{REF heading-2 "Session heading"}}');
    expect(crossReferenceSelect().value).toBe("");
  });

  it("inserts bookmark tokens from selected text", async () => {
    render();
    await settle();

    clickButton("Bookmark");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{BOOKMARK session-body "Session body"}}');
  });

  it("refreshes heading cross-reference options after document updates", async () => {
    render();
    await settle();

    const editorContent = container.querySelector<HTMLElement>(".native-document-editor__content");
    if (editorContent === null) {
      throw new Error("Missing editor content.");
    }
    const addedHeading = document.createElement("h3");
    addedHeading.textContent = "New section";
    editorContent.append(addedHeading);

    const editorOptions = useEditorMock.mock.calls[0]?.[0] as
      | {
          readonly onUpdate?: (payload: {
            readonly editor: {
              readonly state: { readonly doc: ReturnType<typeof proseMirrorDocFromText> };
            };
          }) => void;
        }
      | undefined;
    const editorInstance = useEditorMock.mock.results[0]?.value as
      | {
          readonly state: { readonly doc: ReturnType<typeof proseMirrorDocFromText> };
        }
      | undefined;
    if (editorOptions?.onUpdate === undefined || editorInstance === undefined) {
      throw new Error("Missing editor update callback.");
    }

    act(() => {
      editorOptions.onUpdate?.({ editor: editorInstance });
    });
    await settle();

    expect(Array.from(crossReferenceSelect().options).map((option) => option.value)).toContain(
      "heading-3",
    );
    selectCrossReference("heading-3");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{REF heading-3 "New section"}}');
  });

  it("inserts smart chip tokens from the toolbar", async () => {
    render();
    await settle();

    selectSmartChip("person");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{CHIP person label="Ada" id="actor-1"}}');

    selectSmartChip("person:actor-2");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      '{{CHIP person label="Grace Hopper" id="actor-2"}}',
    );

    selectSmartChip("doc");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      '{{CHIP doc label="Native session doc" id="doc-1"}}',
    );

    selectSmartChip("doc:doc-2");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      '{{CHIP doc label="Launch notes" id="doc-2"}}',
    );

    selectSmartChip("event");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{CHIP event label="Event"}}');

    selectSmartChip("event:event-1");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      '{{CHIP event label="Launch review" id="event-1"}}',
    );
    expect(smartChipSelect().value).toBe("");
  });

  it("runs native document commands dispatched from the command palette", async () => {
    render();
    await settle();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-smart-chip", kind: "doc" },
        }),
      );
    });
    expect(chain.insertContent).toHaveBeenCalledWith(
      '{{CHIP doc label="Native session doc" id="doc-1"}}',
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail: { command: "insert-bookmark" } }),
      );
    });
    expect(chain.insertContent).toHaveBeenCalledWith('{{BOOKMARK session-body "Session body"}}');

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail: { command: "find" } }),
      );
    });
    expect(document.activeElement).toBe(findInput());
  });

  it("stages smart compose drafts for explicit acceptance", async () => {
    const generateSuggestionDraft = vi.fn(
      (): Promise<DocsSuggestionDraft> =>
        Promise.resolve({
          slotId: "docs.smart-write",
          text: "Polished session body",
          metadata: { providerId: "test-ai" },
        }),
    );
    render({ generateSuggestionDraft });
    await settle();

    setInputValue("native-document-smart-compose-prompt", "Polish this");
    clickButton("Compose");
    await settle();

    expect(generateSuggestionDraft).toHaveBeenCalledWith({
      docId: "doc-1",
      slotId: "docs.smart-write",
      selection: "Session body",
      prompt: "Polish this",
    });
    expect(chain.insertContent).not.toHaveBeenCalledWith("Polished session body");
    expect(container.textContent ?? "").toContain("Draft ready. Press Tab to accept");
    expect(container.textContent ?? "").toContain("Polished session body");
    expect(decorationMetaCalls).toContainEqual({
      ghostText: { position: 13, text: "Polished session body" },
    });

    clickButton("Accept");

    expect(chain.insertContent).toHaveBeenCalledWith("Polished session body");
    expect(container.textContent ?? "").toContain("Draft inserted");
    expect(smartComposePromptInput().value).toBe("");
  });

  it("ignores stale smart compose drafts after document updates", async () => {
    let resolveDraft: ((draft: DocsSuggestionDraft) => void) | undefined;
    const generateSuggestionDraft = vi.fn(
      (): Promise<DocsSuggestionDraft> =>
        new Promise((resolve) => {
          resolveDraft = resolve;
        }),
    );
    render({ generateSuggestionDraft });
    await settle();

    clickButton("Compose");
    await settle();
    const editorOptions = useEditorMock.mock.calls[0]?.[0] as
      | {
          readonly onUpdate?: (payload: {
            readonly editor: {
              readonly state: { readonly doc: ReturnType<typeof proseMirrorDocFromText> };
            };
          }) => void;
        }
      | undefined;
    const editorInstance = useEditorMock.mock.results[0]?.value as
      | {
          readonly state: { readonly doc: ReturnType<typeof proseMirrorDocFromText> };
        }
      | undefined;
    if (editorOptions?.onUpdate === undefined || editorInstance === undefined) {
      throw new Error("Missing editor update callback.");
    }
    act(() => {
      editorOptions.onUpdate?.({ editor: editorInstance });
    });
    await settle();
    expect(buttonByText("Compose").disabled).toBe(false);
    act(() => {
      resolveDraft?.({
        slotId: "docs.smart-write",
        text: "Stale draft body",
        metadata: { providerId: "test-ai" },
      });
    });
    await settle();

    expect(container.textContent ?? "").toContain("Document changed. Compose again");
    expect(container.textContent ?? "").not.toContain("Stale draft body");
    expect(decorationMetaCalls).not.toContainEqual({
      ghostText: { position: 13, text: "Stale draft body" },
    });
  });

  it("ignores stale smart compose drafts after selection changes", async () => {
    let resolveDraft: ((draft: DocsSuggestionDraft) => void) | undefined;
    const generateSuggestionDraft = vi.fn(
      (): Promise<DocsSuggestionDraft> =>
        new Promise((resolve) => {
          resolveDraft = resolve;
        }),
    );
    render({ generateSuggestionDraft });
    await settle();

    clickButton("Compose");
    await settle();
    const editorOptions = useEditorMock.mock.calls[0]?.[0] as
      | {
          readonly onSelectionUpdate?: (payload: {
            readonly editor: {
              readonly state: {
                readonly selection: {
                  readonly from: number;
                  readonly to: number;
                  readonly empty: boolean;
                };
                readonly doc: ReturnType<typeof proseMirrorDocFromText>;
              };
            };
          }) => void;
        }
      | undefined;
    if (editorOptions?.onSelectionUpdate === undefined) {
      throw new Error("Missing editor selection callback.");
    }
    act(() => {
      editorOptions.onSelectionUpdate?.({
        editor: {
          state: {
            selection: { from: 1, to: 10, empty: false },
            doc: proseMirrorDocFromText("paragraph", 1),
          },
        },
      });
    });
    await settle();
    expect(buttonByText("Compose").disabled).toBe(false);
    act(() => {
      resolveDraft?.({
        slotId: "docs.smart-write",
        text: "Stale selection draft",
        metadata: { providerId: "test-ai" },
      });
    });
    await settle();

    expect(container.textContent ?? "").toContain("Selection changed. Compose again");
    expect(container.textContent ?? "").not.toContain("Stale selection draft");
    expect(decorationMetaCalls).not.toContainEqual({
      ghostText: { position: 13, text: "Stale selection draft" },
    });
  });

  it("accepts staged smart compose drafts from the editor keyboard handler", async () => {
    const generateSuggestionDraft = vi.fn(
      (): Promise<DocsSuggestionDraft> =>
        Promise.resolve({
          slotId: "docs.smart-write",
          text: "Keyboard accepted body",
          metadata: { providerId: "test-ai" },
        }),
    );
    render({ generateSuggestionDraft });
    await settle();

    clickButton("Compose");
    await settle();
    keyDownEditor("Tab");

    expect(chain.insertContent).toHaveBeenCalledWith("Keyboard accepted body");
    expect(container.textContent ?? "").toContain("Draft inserted");
  });

  it("captures keyboard shortcuts for find and match navigation", async () => {
    render();
    await settle();

    setInputValue("native-document-find", "body");
    pressShortcut("f");
    await settle();

    expect(document.activeElement).toBe(container.querySelector("#native-document-find"));

    pressShortcut("g");
    await settle();

    expect(container.textContent ?? "").toContain("1 of 2");
    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 9, to: 13 });

    pressShortcut("g");
    await settle();

    expect(container.textContent ?? "").toContain("2 of 2");
    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 24, to: 28 });

    pressShortcut("g", { shiftKey: true });
    await settle();

    expect(container.textContent ?? "").toContain("1 of 2");
    expect(chain.setTextSelection).toHaveBeenLastCalledWith({ from: 9, to: 13 });
  });

  function render(
    options: {
      readonly generateSuggestionDraft?: NativeDocumentEditorProps["generateSuggestionDraft"];
    } = {},
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NativeDocumentEditor
            session={nativeDocumentSession()}
            generateSuggestionDraft={options.generateSuggestionDraft}
          />
        </QueryClientProvider>,
      );
    });
  }

  function submitFindForm(): void {
    const form = container.querySelector<HTMLFormElement>('form[aria-label="Find and replace"]');
    if (form === null) {
      throw new Error("Missing find and replace form.");
    }
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  }

  function latestFindDecorationMeta(): unknown {
    const meta = [...decorationMetaCalls]
      .reverse()
      .find(
        (entry) =>
          isRecord(entry) &&
          Array.isArray(entry.findMatches) &&
          typeof entry.activeFindMatchIndex === "number",
      );
    if (meta === undefined) {
      throw new Error("Missing find decoration metadata.");
    }
    return meta;
  }

  function clickButton(label: string): void {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    if (button === undefined) {
      throw new Error(`Missing button: ${label}`);
    }
    act(() => {
      button.click();
    });
  }

  function buttonByLabel(label: string): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (button === null) {
      throw new Error(`Missing button: ${label}`);
    }
    return button;
  }

  function clickButtonByLabel(label: string): void {
    const button = buttonByLabel(label);
    act(() => {
      button.click();
    });
  }

  function clickElementByLabel(label: string): void {
    const element = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    if (element === null) {
      throw new Error(`Missing element: ${label}`);
    }
    act(() => {
      element.click();
    });
  }

  function buttonByText(label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.includes(label),
    );
    if (button === undefined) {
      throw new Error(`Missing button: ${label}`);
    }
    return button;
  }

  function inputByLabel(label: string): HTMLInputElement {
    const input = inputMaybe(label);
    if (input === null) {
      throw new Error(`Missing input: ${label}`);
    }
    return input;
  }

  function inputMaybe(label: string): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  }

  function appendEquationToken(input: {
    readonly from: number;
    readonly to: number;
    readonly latex: string;
  }): void {
    const editorContent = container.querySelector<HTMLElement>(".native-document-editor__content");
    if (editorContent === null) {
      throw new Error("Missing editor content.");
    }
    const token = document.createElement("span");
    token.dataset.nativeDocumentTokenKind = "equation";
    token.dataset.nativeDocumentTokenFrom = String(input.from);
    token.dataset.nativeDocumentTokenTo = String(input.to);
    token.dataset.nativeDocumentEquationLatex = input.latex;
    token.setAttribute("aria-label", `Edit equation ${input.latex}`);
    token.setAttribute("role", "button");
    token.tabIndex = 0;
    token.textContent = input.latex;
    editorContent.append(token);
  }

  function fieldSelect(): HTMLSelectElement {
    const select = container.querySelector<HTMLSelectElement>("#native-document-field");
    if (select === null) {
      throw new Error("Missing field select.");
    }
    return select;
  }

  function equationInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>("#native-document-equation");
    if (input === null) {
      throw new Error("Missing equation input.");
    }
    return input;
  }

  function selectField(value: string): void {
    const select = fieldSelect();
    act(() => {
      setNativeSelectValue(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function crossReferenceSelect(): HTMLSelectElement {
    const select = container.querySelector<HTMLSelectElement>("#native-document-cross-reference");
    if (select === null) {
      throw new Error("Missing cross-reference select.");
    }
    return select;
  }

  function selectCrossReference(value: string): void {
    const select = crossReferenceSelect();
    act(() => {
      setNativeSelectValue(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function smartChipSelect(): HTMLSelectElement {
    const select = container.querySelector<HTMLSelectElement>("#native-document-smart-chip");
    if (select === null) {
      throw new Error("Missing smart chip select.");
    }
    return select;
  }

  function smartComposePromptInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>(
      "#native-document-smart-compose-prompt",
    );
    if (input === null) {
      throw new Error("Missing smart compose prompt input.");
    }
    return input;
  }

  function keyDownEditor(key: string): void {
    const editorOptions = useEditorMock.mock.calls[0]?.[0] as
      | {
          readonly editorProps?: {
            readonly handleKeyDown?: (view: unknown, event: KeyboardEvent) => boolean;
          };
        }
      | undefined;
    const handleKeyDown = editorOptions?.editorProps?.handleKeyDown;
    if (handleKeyDown === undefined) {
      throw new Error("Missing editor key handler.");
    }
    act(() => {
      handleKeyDown(
        {},
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  function findInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>("#native-document-find");
    if (input === null) {
      throw new Error("Missing find input.");
    }
    return input;
  }

  function selectSmartChip(value: string): void {
    const select = smartChipSelect();
    act(() => {
      setNativeSelectValue(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  function pressShortcut(key: string, options: { readonly shiftKey?: boolean } = {}): void {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          ctrlKey: true,
          shiftKey: options.shiftKey ?? false,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }
});

interface FakeEditorChain {
  focus: ReturnType<typeof vi.fn>;
  setTextSelection: ReturnType<typeof vi.fn>;
  scrollIntoView: ReturnType<typeof vi.fn>;
  insertContent: ReturnType<typeof vi.fn>;
  insertContentAt: ReturnType<typeof vi.fn>;
  toggleBold: ReturnType<typeof vi.fn>;
  toggleItalic: ReturnType<typeof vi.fn>;
  toggleUnderline: ReturnType<typeof vi.fn>;
  toggleStrike: ReturnType<typeof vi.fn>;
  setParagraph: ReturnType<typeof vi.fn>;
  toggleHeading: ReturnType<typeof vi.fn>;
  toggleBulletList: ReturnType<typeof vi.fn>;
  toggleOrderedList: ReturnType<typeof vi.fn>;
  toggleCodeBlock: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createFakeEditorChain(): FakeEditorChain {
  const chain = {} as FakeEditorChain;
  chain.focus = vi.fn(() => chain);
  chain.setTextSelection = vi.fn(() => chain);
  chain.scrollIntoView = vi.fn(() => chain);
  chain.insertContent = vi.fn(() => chain);
  chain.insertContentAt = vi.fn(() => chain);
  chain.toggleBold = vi.fn(() => chain);
  chain.toggleItalic = vi.fn(() => chain);
  chain.toggleUnderline = vi.fn(() => chain);
  chain.toggleStrike = vi.fn(() => chain);
  chain.setParagraph = vi.fn(() => chain);
  chain.toggleHeading = vi.fn(() => chain);
  chain.toggleBulletList = vi.fn(() => chain);
  chain.toggleOrderedList = vi.fn(() => chain);
  chain.toggleCodeBlock = vi.fn(() => chain);
  chain.run = vi.fn(() => true);
  return chain;
}

function mockEditorDocument(text: string, pos: number): void {
  const fakeTransaction = {};
  useEditorMock.mockReturnValue({
    state: {
      doc: proseMirrorDocFromText(text, pos),
      selection: { from: 1, to: 13, empty: false },
      tr: {
        setMeta: vi.fn((_key: unknown, value: unknown) => {
          decorationMetaCalls.push(value);
          return fakeTransaction;
        }),
      },
    },
    view: { dispatch: editorDispatch },
    chain: vi.fn(() => chain),
    can: vi.fn(() => ({ chain: vi.fn(() => canChain) })),
    isActive: vi.fn((name: string, attributes?: { readonly level?: number }) => {
      if (name === "heading") {
        return activeFormats.has(`heading:${String(attributes?.level ?? "")}`);
      }
      return activeFormats.has(name);
    }),
  } as never);
}

function proseMirrorDocFromText(text: string, pos: number) {
  return {
    textBetween(from: number, to: number) {
      const start = Math.max(from - pos, 0);
      const end = Math.max(to - pos, start);
      return text.slice(start, end);
    },
    descendants(
      callback: (node: { readonly isText: boolean; readonly text: string }, pos: number) => void,
    ) {
      callback({ isText: true, text }, pos);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setInputValue(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) {
    throw new Error(`Missing input: ${id}`);
  }
  act(() => {
    setNativeInputValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setNativeInputValue(element: HTMLInputElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter invoked via Reflect.apply with element receiver
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native input value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
}

function setNativeSelectValue(element: HTMLSelectElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter invoked via Reflect.apply with element receiver
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native select value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
}

async function settle() {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

function nativeDocumentSession(): NativeDocumentSession {
  return {
    editor: "document",
    engine: "helix-native-document",
    formatVersion: 1,
    resource: {
      orgId: "org-1",
      resourceId: "doc-1",
      kind: "document",
    },
    document: {
      id: "doc-1",
      orgId: "org-1",
      title: "Native session doc",
      editorEngine: "helix-native-document",
      formatVersion: 1,
      updateSeq: 4,
      stateBase64: null,
      stateVectorBase64: null,
      updatedAt: "2026-05-23T12:00:00.000Z",
    },
    shellRoute: "/docs/:id",
    apiRoute: "/api/editors/documents/:documentId",
    sync: {
      protocol: "yjs",
      route: "/sync/docs/:docId",
      url: "/sync/docs/doc-1?protocol=yjs",
      awareness: true,
    },
  };
}
