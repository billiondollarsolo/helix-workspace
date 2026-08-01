// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEditor } from "@tiptap/react";
import { uploadDriveFile } from "@/features/drive/api";
import { HELIX_DRIVE_ITEM_DRAG_MIME } from "@/features/drive/drag-payload";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  activateNativeDocumentEquationToken,
  activateNativeDocumentReferenceToken,
  assignNativeDocumentHeadingAnchors,
  findNativeDocumentTextMatches,
  NativeDocumentEditor,
  nativeDocumentChecklistContent,
  nativeDocumentImageWidthPercent,
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
  nativeDocumentTableContent,
  nativeDocumentTableOfContentsText,
  nativeDocumentTokenDecorationAttributes,
  nativeDocumentTokenDecorationRanges,
  selectNativeDocumentAnchorRange,
  type NativeDocumentEditorProps,
} from "./native-document-editor";
import {
  saveNativeDocumentState,
  type DocsSuggestionDraft,
  type NativeDocumentSession,
} from "./api";
import { dispatchNativeDocumentAnchorSelection } from "./native-document-anchors";
import {
  NATIVE_DOCUMENT_COMMAND_EVENT,
  type NativeDocumentCommandEventDetail,
} from "./native-document-commands";

const useBlockerMock = vi.hoisted(() =>
  vi.fn(() => ({
    status: "idle" as const,
    current: undefined,
    next: undefined,
    action: undefined,
    proceed: undefined,
    reset: undefined,
  })),
);

vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  useBlocker: useBlockerMock,
}));

const collaborationMockState = vi.hoisted(() => ({
  latestDocument: null as Y.Doc | null,
}));

vi.mock("@tiptap/extension-collaboration", () => ({
  default: {
    configure: vi.fn((options: { readonly document: Y.Doc }) => {
      collaborationMockState.latestDocument = options.document;
      return { name: "collaboration", options };
    }),
  },
}));

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
            files: [
              { id: "sheet-1", label: "Revenue forecast.xlsx" },
              { id: "deck-1", label: "Board update.pptx" },
            ],
            events: [{ id: "event-1", label: "Launch review" }],
          }),
        throwOnError: false,
      }),
  };
});

vi.mock("./native-document-yjs-provider", async () => {
  const actual = await vi.importActual<typeof import("./native-document-yjs-provider")>(
    "./native-document-yjs-provider",
  );
  return {
    applyNativeDocumentState: actual.applyNativeDocumentState,
    NativeDocumentYjsProvider: class {
      readonly awareness = { setLocalState: vi.fn() };
      readonly connect = vi.fn();
      readonly disconnect = vi.fn();
    },
  };
});

vi.mock("@/features/drive/api", () => ({
  uploadDriveFile: vi.fn(),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    saveNativeDocumentState: vi.fn(),
  };
});

const useEditorMock = vi.mocked(useEditor);
const uploadDriveFileMock = vi.mocked(uploadDriveFile);
const saveNativeDocumentStateMock = vi.mocked(saveNativeDocumentState);

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
let clipboardWriteText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
let clipboardReadText: ReturnType<typeof vi.fn<() => Promise<string>>>;

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
    clipboardWriteText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    clipboardReadText = vi.fn<() => Promise<string>>().mockResolvedValue("Clipboard fallback");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText, readText: clipboardReadText },
    });
    collaborationMockState.latestDocument = null;
    uploadDriveFileMock.mockResolvedValue({
      objectId: "55555555-5555-4555-8555-555555555555",
      orgId: "org-1",
      ownerActorId: "actor-1",
      name: "Roadmap_photo.png",
      folderId: null,
      storageKey: "drive/555/Roadmap_photo.png",
      mimeType: "image/png",
      byteSize: 3,
      sha256: "0".repeat(64),
      status: "prepared",
      uploadUrl: null,
      uploadHeaders: {},
      metadata: {},
      createdAt: "2026-05-20T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    });
    saveNativeDocumentStateMock.mockResolvedValue({
      id: "doc-1",
      orgId: "org-1",
      title: "Native session doc",
      threadId: null,
      ownerActorId: "actor-1",
      createdByActorId: "actor-1",
      ydocState: "state",
      ydocStateVector: "vector",
      updateSeq: 5,
      editorEngine: "helix-native-document",
      formatVersion: 1,
      metadata: {},
      deletedAt: null,
      createdAt: "2026-05-20T12:00:00.000Z",
      updatedAt: "2026-05-20T12:00:00.000Z",
    });
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
    vi.unstubAllGlobals();
    window.localStorage.clear();
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
    ).toBe('{{CHIP doc label="Roadmap draft" id="doc-1" href="/docs/doc-1"}}');
    expect(
      nativeDocumentSmartChipInsertionText("file", {
        fileId: "file-1",
        fileTitle: "Revenue forecast.xlsx",
      }),
    ).toBe('{{CHIP file label="Revenue forecast.xlsx" id="file-1" href="/open/file-1"}}');
    expect(
      nativeDocumentSmartChipInsertionText("event", {
        eventId: "event-1",
        eventTitle: "Launch review",
      }),
    ).toBe('{{CHIP event label="Launch review" id="event-1"}}');
    expect(nativeDocumentSmartChipInsertionText("event")).toBe('{{CHIP event label="Event"}}');
  });

  it("builds native checklist document content from selected text", () => {
    expect(nativeDocumentChecklistContent("First task\nSecond task")).toEqual({
      type: "nativeDocumentChecklist",
      content: [
        {
          type: "nativeDocumentChecklistItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "First task" }] }],
        },
        {
          type: "nativeDocumentChecklistItem",
          attrs: { checked: false },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Second task" }] }],
        },
      ],
    });
    expect(nativeDocumentChecklistContent()).toEqual({
      type: "nativeDocumentChecklist",
      content: [
        {
          type: "nativeDocumentChecklistItem",
          attrs: { checked: false },
          content: [{ type: "paragraph" }],
        },
      ],
    });
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

  it("finds file smart chip token decorations", () => {
    const ranges = nativeDocumentTokenDecorationRanges(
      proseMirrorDocFromText(
        '{{CHIP file label="Revenue forecast.xlsx" id="file-1" href="/open/file-1"}}',
        1,
      ),
    );

    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({
      kind: "chip-file",
      label: "Revenue forecast.xlsx",
      chipKind: "file",
      tokenId: "file-1",
      chipHref: "/open/file-1",
      title: "File smart chip",
      hoverCard: "File · Revenue forecast.xlsx · file-1",
    });
    expect(nativeDocumentTokenDecorationAttributes(ranges[0]!)).toMatchObject({
      "aria-label": "Open Revenue forecast.xlsx",
      "data-native-document-chip-kind": "file",
      "data-native-document-chip-href": "/open/file-1",
      "data-native-document-token-card": "File · Revenue forecast.xlsx · file-1",
      "data-native-document-token-id": "file-1",
      role: "link",
      tabindex: "0",
    });
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

  // The formatting toolbar moved out of the editor and into the unified chrome
  // ribbon/menu bar. Coverage for those commands now lives in
  // `native-document-chrome.test.tsx`.

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

    setInputValue("native-document-replace", "copy");
    clickButton("Replace");
    await settle();
    expect(chain.insertContentAt).toHaveBeenCalledWith({ from: 24, to: 28 }, "copy");

    clickButton("Replace all");
    await settle();
    expect(chain.insertContentAt).toHaveBeenCalledWith({ from: 9, to: 13 }, "copy");
    expect(container.textContent ?? "").toContain("Replaced 2");
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

    clickButton("Accept");
    expect(chain.insertContent).toHaveBeenCalledWith("Polished session body");
    expect(container.textContent ?? "").toContain("Draft inserted");
    expect(smartComposePromptInput().value).toBe("");
  });

  it("runs native document commands dispatched from the command palette", async () => {
    render();
    await settle();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-smart-chip", kind: "doc" },
        }),
      );
      await settle();
    });
    expect(chain.insertContent).toHaveBeenCalledWith(
      '{{CHIP doc label="Native session doc" id="doc-1" href="/docs/doc-1"}}',
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail: { command: "insert-bookmark" } }),
      );
    });
    expect(chain.insertContent).toHaveBeenCalledWith('{{BOOKMARK session-body "Session body"}}');

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-page-break" },
        }),
      );
    });
    expect(chain.insertContent).toHaveBeenCalledWith({ type: "nativeDocumentPageBreak" });

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-footnote" },
        }),
      );
      await settle();
    });
    expect(chain.insertContent).toHaveBeenCalledWith([
      {
        type: "nativeDocumentFootnote",
        attrs: { number: 1, note: "Footnote" },
      },
      { type: "text", text: " " },
    ]);
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-footnote",
        number: 1,
      },
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail: { command: "find" } }),
      );
    });
    expect(document.activeElement).toBe(findInput());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail: { command: "smart-compose" } }),
      );
    });
    expect(document.activeElement).toBe(smartComposePromptInput());
  });

  it("notifies the shell when the editor document changes", async () => {
    const onContentChange = vi.fn();
    render({ onContentChange });
    await settle();

    const editorOptions = useEditorMock.mock.calls.at(-1)?.[0];
    const editor = useEditorMock.mock.results.at(-1)?.value;
    if (editorOptions?.onUpdate === undefined || editor === undefined) {
      throw new Error("Missing TipTap update fixture");
    }

    await act(async () => {
      editorOptions.onUpdate?.({ editor } as never);
      await Promise.resolve();
    });

    expect(onContentChange).toHaveBeenCalledTimes(1);
  });

  it("copies, cuts, and pastes selected document text from native document commands", async () => {
    render();
    await settle();

    await dispatchNativeDocumentCommandForTest({ command: "copy" });

    expect(clipboardWriteText).toHaveBeenCalledWith("Session body");

    await dispatchNativeDocumentCommandForTest({ command: "cut" });

    expect(clipboardWriteText).toHaveBeenCalledWith("Session body");
    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 1, to: 13 });
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: { source: "web.native-document-editor.edit-cut" },
    });

    await dispatchNativeDocumentCommandForTest({ command: "paste" });

    expect(chain.insertContent).toHaveBeenCalledWith("Session body");
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: { source: "web.native-document-editor.edit-paste" },
    });

    await dispatchNativeDocumentCommandForTest({ command: "paste-plain" });

    expect(chain.insertContent).toHaveBeenCalledWith("Session body");
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: { source: "web.native-document-editor.edit-paste-plain" },
    });
  });

  it("drops image files into the document as Drive-backed image nodes", async () => {
    render();
    await settle();

    const editor = container.querySelector<HTMLElement>('[aria-label="Document editor"]');
    if (editor === null) {
      throw new Error("Missing document editor.");
    }
    const file = new File(["png"], "Roadmap_photo.png", { type: "image/png" });
    await dropFileOnDocument(editor, file);
    await settle();

    expect(uploadDriveFileMock).toHaveBeenCalledWith({ file, folderId: null });
    expect(chain.insertContent).toHaveBeenCalledWith({
      type: "nativeDocumentImage",
      attrs: {
        src: "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
        alt: "Roadmap photo",
        title: "Roadmap_photo.png",
        widthPercent: 80,
        caption: "",
      },
    });
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.drop-image",
        driveObjectId: "55555555-5555-4555-8555-555555555555",
        filename: "Roadmap_photo.png",
      },
    });
  });

  it("inserts Drive-backed image nodes from the top Insert image command", async () => {
    render();
    await settle();

    const input = inputByLabel("Choose document image");
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => undefined);
    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail: { command: "insert-image" } }),
      );
    });
    expect(clickSpy).toHaveBeenCalledTimes(1);

    const file = new File(["png"], "Board_update.png", { type: "image/png" });
    Object.defineProperty(input, "files", {
      configurable: true,
      value: {
        length: 1,
        item: (index: number) => (index === 0 ? file : null),
      },
    });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(uploadDriveFileMock).toHaveBeenCalledWith({ file, folderId: null });
    expect(chain.insertContentAt).toHaveBeenCalledWith(13, {
      type: "nativeDocumentImage",
      attrs: {
        src: "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
        alt: "Board update",
        title: "Board_update.png",
        widthPercent: 80,
        caption: "",
      },
    });
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-image",
        driveObjectId: "55555555-5555-4555-8555-555555555555",
        filename: "Board_update.png",
      },
    });
  });

  it("inserts safe link marks from the top Insert link command", async () => {
    render();
    await settle();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail: { command: "insert-link" } }),
      );
    });
    await settle();

    expect(inputByLabel("Link text").value).toBe("Session body");
    const hrefInput = inputByLabel("Link URL");
    act(() => {
      setNativeInputValue(hrefInput, "https://example.com/session-body");
      hrefInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      buttonByText("Apply link").click();
    });
    await settle();

    expect(chain.insertContentAt).toHaveBeenCalledWith(
      { from: 1, to: 13 },
      {
        type: "text",
        text: "Session body",
        marks: [
          {
            type: "link",
            attrs: { href: "https://example.com/session-body" },
          },
        ],
      },
    );
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-link",
        href: "https://example.com/session-body",
        textLength: 12,
      },
    });
  });

  it("inserts equation tokens from the top Insert equation command", async () => {
    render();
    await settle();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-equation" },
        }),
      );
    });
    await settle();

    const equation = equationInput();
    act(() => {
      setNativeInputValue(equation, "E=mc^2");
      equation.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      buttonByText("Insert equation").click();
    });
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{EQUATION latex="E=mc^2"}}');
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-equation",
        equationLength: 6,
      },
    });
    expect(container.querySelector('form[aria-label="Insert equation"]')).toBeNull();
  });

  it("inserts editable native table nodes from the top Insert table command", async () => {
    render();
    await settle();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-table" },
        }),
      );
    });
    await settle();

    const rows = inputByLabel("Table rows");
    const columns = inputByLabel("Table columns");
    act(() => {
      setNativeInputValue(rows, "2");
      rows.dispatchEvent(new Event("input", { bubbles: true }));
      setNativeInputValue(columns, "4");
      columns.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      buttonByText("Insert table").click();
    });
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(nativeDocumentTableContent(2, 4));
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-table",
        rows: 2,
        columns: 4,
      },
    });
    expect(container.querySelector('form[aria-label="Insert table"]')).toBeNull();
  });

  it("inserts native field tokens from the top Insert field command", async () => {
    render();
    await settle();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-field" },
        }),
      );
    });
    await settle();

    selectField("documentTitle");
    act(() => {
      buttonByText("Insert field").click();
    });
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{PROPERTY title="Native session doc"}}');
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-field",
        field: "documentTitle",
      },
    });
    expect(container.querySelector('form[aria-label="Insert field"]')).toBeNull();
  });

  it("inserts cross-reference tokens from the top Insert cross-reference command", async () => {
    render();
    await settle();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "insert-cross-reference" },
        }),
      );
    });
    await settle();

    selectCrossReference("heading-2");
    act(() => {
      buttonByText("Insert reference").click();
    });
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith('{{REF heading-2 "Session heading"}}');
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-cross-reference",
        targetId: "heading-2",
        label: "Session heading",
      },
    });
    expect(container.querySelector('form[aria-label="Insert cross-reference"]')).toBeNull();
  });

  it("inserts picked smart-chip tokens from the top Insert smart chip command", async () => {
    render();
    await settle();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, {
          detail: { command: "open-smart-chip-picker" },
        }),
      );
    });
    await settle();

    selectSmartChip("person:actor-2");
    act(() => {
      buttonByText("Insert chip").click();
    });
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      '{{CHIP person label="Grace Hopper" id="actor-2"}}',
    );
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.insert-smart-chip",
        chipKind: "person",
        targetId: "actor-2",
        label: "Grace Hopper",
      },
    });
    expect(container.querySelector('form[aria-label="Insert smart chip"]')).toBeNull();
  });

  it("normalizes document image resize widths to a usable range", () => {
    expect(nativeDocumentImageWidthPercent(10)).toBe(20);
    expect(nativeDocumentImageWidthPercent("64")).toBe(64);
    expect(nativeDocumentImageWidthPercent(130)).toBe(100);
    expect(nativeDocumentImageWidthPercent("not a number")).toBe(80);
  });

  it("drops text snippets into the document and saves native state", async () => {
    render();
    await settle();

    const editor = container.querySelector<HTMLElement>('[aria-label="Document editor"]');
    if (editor === null) {
      throw new Error("Missing document editor.");
    }
    await dropTextOnDocument(editor, "Customer quote: faster onboarding");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith("Customer quote: faster onboarding");
    expect(chain.run).toHaveBeenCalled();
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.drop-text",
        textLength: 33,
      },
    });
  });

  it("registers native document extensions for page breaks, color, highlight, and alignment", async () => {
    render();
    await settle();
    const editorOptions = useEditorMock.mock.calls[0]?.[0] as
      | { readonly extensions?: readonly { readonly name?: string }[] }
      | undefined;
    const extensionNames = new Set(editorOptions?.extensions?.map((extension) => extension.name));
    expect(extensionNames.has("nativeDocumentTextColor")).toBe(true);
    expect(extensionNames.has("nativeDocumentHighlight")).toBe(true);
    expect(extensionNames.has("nativeDocumentTextAlign")).toBe(true);
    expect(extensionNames.has("nativeDocumentPageBreak")).toBe(true);
    expect(extensionNames.has("nativeDocumentFootnote")).toBe(true);
  });

  it("marks the editor layout when non-printing characters are visible", async () => {
    render({ showNonPrintingCharacters: true });
    await settle();

    expect(
      container.querySelector<HTMLElement>(".native-document-editor__content-layout")?.dataset
        .showNonprinting,
    ).toBe("true");
  });

  it("passes read-only document mode into TipTap editability", async () => {
    render({ editable: false });
    await settle();

    const editorOptions = useEditorMock.mock.calls[0]?.[0];
    expect(editorOptions?.editable).toBe(false);
    const editor = useEditorMock.mock.results[0]?.value as
      | { readonly setEditable?: ReturnType<typeof vi.fn> }
      | undefined;
    expect(editor?.setEditable).toHaveBeenCalledWith(false);
  });

  it("drops URLs into the document as link marks", async () => {
    render();
    await settle();

    const editor = container.querySelector<HTMLElement>('[aria-label="Document editor"]');
    if (editor === null) {
      throw new Error("Missing document editor.");
    }
    await dropTextOnDocument(editor, "https://example.com/roadmap", "text/uri-list");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith({
      type: "text",
      text: "https://example.com/roadmap",
      marks: [
        {
          type: "link",
          attrs: { href: "https://example.com/roadmap" },
        },
      ],
    });
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.drop-text",
        textLength: 27,
        href: "https://example.com/roadmap",
      },
    });
  });

  it("drops internal document URLs into the document as persisted doc smart chips", async () => {
    render();
    await settle();

    const editor = container.querySelector<HTMLElement>('[aria-label="Document editor"]');
    if (editor === null) {
      throw new Error("Missing document editor.");
    }
    const url = "http://127.0.0.1:5175/docs/doc-2";
    await dropTextOnDocument(editor, url, "text/uri-list");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      `{{CHIP doc label="Launch notes" id="doc-2" href="${url}"}}`,
    );
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.drop-smart-chip",
        textLength: url.length,
        href: url,
        chipKind: "doc",
        targetId: "doc-2",
        label: "Launch notes",
      },
    });
  });

  it("drops internal spreadsheet URLs into the document as persisted file smart chips", async () => {
    render();
    await settle();

    const editor = container.querySelector<HTMLElement>('[aria-label="Document editor"]');
    if (editor === null) {
      throw new Error("Missing document editor.");
    }
    const url = "http://127.0.0.1:5175/sheets?sheet=sheet-1";
    await dropTextOnDocument(editor, url, "text/uri-list");
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      `{{CHIP file label="Revenue forecast.xlsx" id="sheet-1" href="${url}"}}`,
    );
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.drop-smart-chip",
        textLength: url.length,
        href: url,
        chipKind: "file",
        targetId: "sheet-1",
        label: "Revenue forecast.xlsx",
      },
    });
  });

  it("drops Drive item drag payloads into the document as persisted file smart chips", async () => {
    render();
    await settle();

    const editor = container.querySelector<HTMLElement>('[aria-label="Document editor"]');
    if (editor === null) {
      throw new Error("Missing document editor.");
    }
    const href = "http://127.0.0.1:5175/open/raw-pptx-1";
    await dropTextOnDocument(editor, "ignored text", "text/plain", {
      [HELIX_DRIVE_ITEM_DRAG_MIME]: JSON.stringify({
        id: "raw-pptx-1",
        name: "Board update.pptx",
        href,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        app: "slides",
      }),
    });
    await settle();

    expect(chain.insertContent).toHaveBeenCalledWith(
      `{{CHIP file label="Board update.pptx" id="raw-pptx-1" href="${href}"}}`,
    );
    expect(saveNativeDocumentStateMock).toHaveBeenCalledWith({
      docId: "doc-1",
      stateBase64: expect.any(String),
      stateVectorBase64: expect.any(String),
      metadata: {
        source: "web.native-document-editor.drop-smart-chip",
        textLength: "Board update.pptx".length,
        href,
        chipKind: "file",
        targetId: "raw-pptx-1",
        label: "Board update.pptx",
      },
    });
  });

  it("recovers unsaved Yjs document state after reload and clears recovery when server catches up", async () => {
    const onRecoveryStatusChange = vi.fn();
    render({ onRecoveryStatusChange });
    await settle();

    const ydoc = latestNativeDocumentYDoc();
    act(() => {
      ydoc.getText("recovery").insert(0, "Unsaved docs story");
    });
    await settle();

    const recoveryKey = "helix.docs.unsavedYjs.v1.doc-1";
    expect(window.localStorage.getItem(recoveryKey)).not.toBeNull();
    expect(
      container.querySelector('[data-testid="native-document-editor-status"]')?.textContent,
    ).toBe("Recovered local changes");
    expect(onRecoveryStatusChange).toHaveBeenCalledWith(true);
    expect(useBlockerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: false, enableBeforeUnload: true }),
    );

    remountFreshEditor({ onRecoveryStatusChange });
    await settle();

    const recoveredYdoc = latestNativeDocumentYDoc();
    expect(recoveredYdoc.getText("recovery").toJSON()).toBe("Unsaved docs story");
    expect(
      container.querySelector('[data-testid="native-document-editor-status"]')?.textContent,
    ).toBe("Recovered local changes");

    remountFreshEditor({
      onRecoveryStatusChange,
      session: nativeDocumentSession({
        stateBase64: testBase64FromUint8Array(Y.encodeStateAsUpdate(recoveredYdoc)),
        stateVectorBase64: testBase64FromUint8Array(Y.encodeStateVector(recoveredYdoc)),
      }),
    });
    await settle();

    expect(window.localStorage.getItem(recoveryKey)).toBeNull();
    expect(latestNativeDocumentYDoc().getText("recovery").toJSON()).toBe("Unsaved docs story");
    expect(useBlockerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: true, enableBeforeUnload: false }),
    );
  });

  function render(
    options: {
      readonly generateSuggestionDraft?: NativeDocumentEditorProps["generateSuggestionDraft"];
      readonly onContentChange?: NativeDocumentEditorProps["onContentChange"];
      readonly onRecoveryStatusChange?: NativeDocumentEditorProps["onRecoveryStatusChange"];
      readonly editable?: boolean;
      readonly showNonPrintingCharacters?: boolean;
      readonly session?: NativeDocumentSession;
    } = {},
  ) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <NativeDocumentEditor
            session={options.session ?? nativeDocumentSession()}
            generateSuggestionDraft={options.generateSuggestionDraft}
            onContentChange={options.onContentChange}
            editable={options.editable}
            showNonPrintingCharacters={options.showNonPrintingCharacters}
            onRecoveryStatusChange={options.onRecoveryStatusChange}
          />
        </QueryClientProvider>,
      );
    });
  }

  function remountFreshEditor(
    options: {
      readonly onRecoveryStatusChange?: NativeDocumentEditorProps["onRecoveryStatusChange"];
      readonly session?: NativeDocumentSession;
    } = {},
  ) {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    root = createRoot(container);
    render(options);
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

  async function dispatchNativeDocumentCommandForTest(
    detail: NativeDocumentCommandEventDetail,
  ): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new CustomEvent(NATIVE_DOCUMENT_COMMAND_EVENT, { detail }));
      await Promise.resolve();
    });
    await settle();
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

  async function dropFileOnDocument(element: HTMLElement, file: File): Promise<void> {
    const dataTransfer = {
      dropEffect: "none",
      items: {
        length: 1,
        0: {
          kind: "file",
          type: file.type,
          getAsFile: () => file,
        },
      },
      files: {
        length: 1,
        0: file,
        item: (index: number) => (index === 0 ? file : null),
      },
    } as unknown as DataTransfer;
    await act(async () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      Object.defineProperty(event, "clientX", { value: 240 });
      Object.defineProperty(event, "clientY", { value: 320 });
      element.dispatchEvent(event);
      await Promise.resolve();
    });
  }

  async function dropTextOnDocument(
    element: HTMLElement,
    text: string,
    type = "text/plain",
    extraData: Record<string, string> = {},
  ): Promise<void> {
    const dataByType = { [type]: text, ...extraData };
    const dataTransfer = {
      dropEffect: "none",
      types: Object.keys(dataByType),
      getData: (requestedType: string) => dataByType[requestedType] ?? "",
      items: { length: 0 },
      files: { length: 0, item: () => null },
    } as unknown as DataTransfer;
    await act(async () => {
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      Object.defineProperty(event, "clientX", { value: 240 });
      Object.defineProperty(event, "clientY", { value: 320 });
      element.dispatchEvent(event);
      await Promise.resolve();
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
});

interface FakeEditorChain {
  focus: ReturnType<typeof vi.fn>;
  setTextSelection: ReturnType<typeof vi.fn>;
  scrollIntoView: ReturnType<typeof vi.fn>;
  insertContent: ReturnType<typeof vi.fn>;
  insertContentAt: ReturnType<typeof vi.fn>;
  deleteRange: ReturnType<typeof vi.fn>;
  toggleBold: ReturnType<typeof vi.fn>;
  toggleItalic: ReturnType<typeof vi.fn>;
  toggleUnderline: ReturnType<typeof vi.fn>;
  toggleStrike: ReturnType<typeof vi.fn>;
  setParagraph: ReturnType<typeof vi.fn>;
  toggleHeading: ReturnType<typeof vi.fn>;
  toggleBulletList: ReturnType<typeof vi.fn>;
  toggleOrderedList: ReturnType<typeof vi.fn>;
  toggleNativeChecklist: ReturnType<typeof vi.fn>;
  toggleCodeBlock: ReturnType<typeof vi.fn>;
  setNativeTextColor: ReturnType<typeof vi.fn>;
  setNativeHighlightColor: ReturnType<typeof vi.fn>;
  setNativeTextAlign: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
}

function createFakeEditorChain(): FakeEditorChain {
  const chain = {} as FakeEditorChain;
  chain.focus = vi.fn(() => chain);
  chain.setTextSelection = vi.fn(() => chain);
  chain.scrollIntoView = vi.fn(() => chain);
  chain.insertContent = vi.fn(() => chain);
  chain.insertContentAt = vi.fn(() => chain);
  chain.deleteRange = vi.fn(() => chain);
  chain.toggleBold = vi.fn(() => chain);
  chain.toggleItalic = vi.fn(() => chain);
  chain.toggleUnderline = vi.fn(() => chain);
  chain.toggleStrike = vi.fn(() => chain);
  chain.setParagraph = vi.fn(() => chain);
  chain.toggleHeading = vi.fn(() => chain);
  chain.toggleBulletList = vi.fn(() => chain);
  chain.toggleOrderedList = vi.fn(() => chain);
  chain.toggleNativeChecklist = vi.fn(() => chain);
  chain.toggleCodeBlock = vi.fn(() => chain);
  chain.setNativeTextColor = vi.fn(() => chain);
  chain.setNativeHighlightColor = vi.fn(() => chain);
  chain.setNativeTextAlign = vi.fn(() => chain);
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
    setEditable: vi.fn(),
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
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native input value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
}

function setNativeSelectValue(element: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native select value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
}

function latestNativeDocumentYDoc(): Y.Doc {
  const doc = collaborationMockState.latestDocument;
  if (doc === null) {
    throw new Error("Missing native document Yjs doc.");
  }
  return doc;
}

function testBase64FromUint8Array(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis.btoa(binary);
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

function nativeDocumentSession(
  overrides: {
    readonly stateBase64?: string | null;
    readonly stateVectorBase64?: string | null;
  } = {},
): NativeDocumentSession {
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
      ownerActorId: "actor-1",
      editorEngine: "helix-native-document",
      formatVersion: 1,
      updateSeq: 4,
      stateBase64: overrides.stateBase64 ?? null,
      stateVectorBase64: overrides.stateVectorBase64 ?? null,
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
