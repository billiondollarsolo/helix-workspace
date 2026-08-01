// @vitest-environment jsdom

import { act, isValidElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDocsMenus,
  buildDocsRibbon,
  type DocsChromeChain,
  type DocsChromeContext,
  type DocsChromeEditorLike,
} from "./native-document-chrome";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function createFakeChain(): DocsChromeChain {
  const chain = {} as DocsChromeChain;
  const self = (): DocsChromeChain => chain;
  chain.focus = vi.fn(self);
  chain.setTextSelection = vi.fn(self);
  chain.selectAll = vi.fn(self);
  chain.toggleBold = vi.fn(self);
  chain.toggleItalic = vi.fn(self);
  chain.toggleUnderline = vi.fn(self);
  chain.toggleStrike = vi.fn(self);
  chain.setParagraph = vi.fn(self);
  chain.toggleHeading = vi.fn(self);
  chain.toggleBulletList = vi.fn(self);
  chain.toggleOrderedList = vi.fn(self);
  chain.toggleNativeChecklist = vi.fn(self);
  chain.sinkListItem = vi.fn(self);
  chain.liftListItem = vi.fn(self);
  chain.toggleCodeBlock = vi.fn(self);
  chain.toggleBlockquote = vi.fn(self);
  chain.setNativeTextColor = vi.fn(self);
  chain.setNativeHighlightColor = vi.fn(self);
  chain.setNativeTextAlign = vi.fn(self);
  chain.unsetAllMarks = vi.fn(self);
  chain.clearNodes = vi.fn(self);
  chain.undo = vi.fn(self);
  chain.redo = vi.fn(self);
  chain.run = vi.fn(() => true);
  return chain;
}

function createFakeEditor(): { editor: DocsChromeEditorLike; chain: DocsChromeChain } {
  const chain = createFakeChain();
  const editor: DocsChromeEditorLike = {
    chain: () => chain,
    isActive: () => false,
  };
  return { editor, chain };
}

function makeCtx(editor: DocsChromeEditorLike | null): DocsChromeContext {
  return {
    editor,
    state: {
      textColor: "#000000",
      highlightColor: "#fef08a",
      paragraphStyle: "paragraph",
      documentMode: "editing",
      showRulers: true,
      showNonPrintingCharacters: false,
    },
    callbacks: {},
  };
}

describe("buildDocsMenus", () => {
  it("returns the nine Google-style menus with stable ids", () => {
    const { editor } = createFakeEditor();
    const menus = buildDocsMenus(makeCtx(editor));

    expect(menus.map((menu) => menu.id)).toEqual([
      "file",
      "edit",
      "view",
      "insert",
      "format",
      "tools",
      "ai",
      "share",
      "help",
    ]);
    expect(menus).toHaveLength(9);
  });

  it("populates File / Edit / Format / Insert menus with the expected commands", () => {
    const menus = buildDocsMenus(makeCtx(null));
    const ids = new Set<string>();
    for (const menu of menus) {
      for (const item of menu.items) {
        if ("id" in item && typeof item.id === "string") {
          ids.add(item.id);
        }
        if ("kind" in item && item.kind === "submenu") {
          for (const child of item.items) {
            if ("id" in child && typeof child.id === "string") {
              ids.add(child.id);
            }
          }
        }
      }
    }

    expect(ids.has("file.rename")).toBe(true);
    expect(ids.has("file.download.docx")).toBe(true);
    expect(ids.has("edit.undo")).toBe(true);
    expect(ids.has("edit.findReplace")).toBe(true);
    expect(ids.has("format.bold")).toBe(true);
    expect(ids.has("format.italic")).toBe(true);
    expect(ids.has("format.paragraph.h1")).toBe(true);
    expect(ids.has("insert.link")).toBe(true);
    expect(ids.has("insert.table")).toBe(true);
    expect(ids.has("insert.pageBreak")).toBe(true);
    expect(ids.has("ai.ask")).toBe(true);
    expect(ids.has("ai.compose")).toBe(true);
    expect(ids.has("ai.summarize")).toBe(false);
    expect(ids.has("ai.translate")).toBe(false);
    expect(ids.has("ai.rewrite")).toBe(false);
    expect(ids.has("share.invite")).toBe(true);
    expect(ids.has("share.copyLink")).toBe(true);
    expect(ids.has("share.publish")).toBe(false);
    expect(ids.has("share.email")).toBe(false);
    expect(ids.has("help.docs")).toBe(false);
    expect(ids.has("help.shortcuts")).toBe(true);
    expect(ids.has("help.feedback")).toBe(false);
    expect(ids.has("help.about")).toBe(true);
  });

  it("marks commands without capabilities as disabled with an explicit reason", () => {
    const menus = buildDocsMenus(makeCtx(null));
    const toolsMenu = menus.find((menu) => menu.id === "tools");
    const fileMenu = menus.find((menu) => menu.id === "file");
    if (toolsMenu === undefined || fileMenu === undefined) {
      throw new Error("Missing Docs menus");
    }
    const preferences = toolsMenu.items.find(
      (item) => "id" in item && item.id === "tools.preferences",
    );
    const newDocument = fileMenu.items.find((item) => "id" in item && item.id === "file.new");

    expect(preferences).toMatchObject({
      disabled: true,
      disabledReason: "This command is not available in this editor yet.",
    });
    expect(newDocument).toMatchObject({
      disabled: true,
      disabledReason: "This command is not available in this editor yet.",
    });
  });

  it("invokes the editor chain when Bold is selected from the Format menu", () => {
    const { editor, chain } = createFakeEditor();
    const menus = buildDocsMenus(makeCtx(editor));
    const formatMenu = menus.find((menu) => menu.id === "format");
    if (formatMenu === undefined) throw new Error("Missing Format menu");
    const boldItem = formatMenu.items.find((item) => "id" in item && item.id === "format.bold");
    if (boldItem === undefined || !("onSelect" in boldItem)) {
      throw new Error("Missing format.bold command");
    }
    boldItem.onSelect();
    expect(chain.toggleBold).toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalled();
  });

  it("wires alignment and clear-formatting menu commands to editor content commands", () => {
    const { editor, chain } = createFakeEditor();
    const menus = buildDocsMenus(makeCtx(editor));
    const formatMenu = menus.find((menu) => menu.id === "format");
    if (formatMenu === undefined) throw new Error("Missing Format menu");
    const alignSubmenu = formatMenu.items.find(
      (item) => "kind" in item && item.kind === "submenu" && item.id === "format.align",
    );
    const clearItem = formatMenu.items.find((item) => "id" in item && item.id === "format.clear");
    if (alignSubmenu === undefined || !("items" in alignSubmenu)) {
      throw new Error("Missing align submenu");
    }
    const rightItem = alignSubmenu.items.find(
      (item) => "id" in item && item.id === "format.align.right",
    );
    if (rightItem === undefined || !("onSelect" in rightItem)) {
      throw new Error("Missing align right command");
    }
    if (clearItem === undefined || !("onSelect" in clearItem)) {
      throw new Error("Missing clear formatting command");
    }

    rightItem.onSelect();
    clearItem.onSelect();

    expect(chain.setNativeTextAlign).toHaveBeenCalledWith("right");
    expect(chain.unsetAllMarks).toHaveBeenCalled();
    expect(chain.clearNodes).toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalledTimes(2);
  });

  it("wires Select all to the editor selection command", () => {
    const { editor, chain } = createFakeEditor();
    const menus = buildDocsMenus(makeCtx(editor));
    const editMenu = menus.find((menu) => menu.id === "edit");
    if (editMenu === undefined) throw new Error("Missing Edit menu");
    const selectAll = editMenu.items.find((item) => "id" in item && item.id === "edit.selectAll");
    if (selectAll === undefined || !("onSelect" in selectAll)) {
      throw new Error("Missing select all command");
    }

    selectAll.onSelect();

    expect(chain.selectAll).toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalledTimes(1);
  });

  it("wires Cut, Copy, Paste, and Paste without formatting to document callbacks", () => {
    const onCut = vi.fn();
    const onCopy = vi.fn();
    const onPaste = vi.fn();
    const onPastePlain = vi.fn();
    const { editor } = createFakeEditor();
    const menus = buildDocsMenus({
      ...makeCtx(editor),
      callbacks: { onCut, onCopy, onPaste, onPastePlain },
    });
    const editMenu = menus.find((menu) => menu.id === "edit");
    if (editMenu === undefined) throw new Error("Missing Edit menu");
    const item = (id: string): { readonly onSelect: () => void } => {
      const found = editMenu.items.find((candidate) => "id" in candidate && candidate.id === id);
      if (found === undefined || !("onSelect" in found)) {
        throw new Error(`Missing ${id}`);
      }
      return { onSelect: found.onSelect };
    };

    item("edit.cut").onSelect();
    item("edit.copy").onSelect();
    item("edit.paste").onSelect();
    item("edit.pastePlain").onSelect();

    expect(onCut).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPastePlain).toHaveBeenCalledTimes(1);
  });

  it("wires checklist menu command to native checklist content", () => {
    const { editor, chain } = createFakeEditor();
    const menus = buildDocsMenus(makeCtx(editor));
    const formatMenu = menus.find((menu) => menu.id === "format");
    if (formatMenu === undefined) throw new Error("Missing Format menu");
    const listsSubmenu = formatMenu.items.find(
      (item) => "kind" in item && item.kind === "submenu" && item.id === "format.lists",
    );
    if (listsSubmenu === undefined || !("items" in listsSubmenu)) {
      throw new Error("Missing lists submenu");
    }
    const checklist = listsSubmenu.items.find(
      (item) => "id" in item && item.id === "format.lists.checklist",
    );
    if (checklist === undefined || !("onSelect" in checklist)) {
      throw new Error("Missing checklist command");
    }

    checklist.onSelect();

    expect(chain.toggleNativeChecklist).toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalledTimes(1);
  });

  it("routes the Download submenu items to the onExport callback", () => {
    const onExport = vi.fn();
    const menus = buildDocsMenus({
      editor: null,
      state: {
        textColor: "#000",
        highlightColor: "#fef08a",
        paragraphStyle: "paragraph",
        documentMode: "editing",
        showRulers: true,
        showNonPrintingCharacters: false,
      },
      callbacks: { onExport },
    });
    const fileMenu = menus.find((menu) => menu.id === "file");
    if (fileMenu === undefined) throw new Error("Missing File menu");
    const download = fileMenu.items.find(
      (item) => "kind" in item && item.kind === "submenu" && item.id === "file.download",
    );
    if (download === undefined || !("items" in download))
      throw new Error("Missing download submenu");
    for (const child of download.items) {
      if ("onSelect" in child) child.onSelect();
    }
    expect(onExport).toHaveBeenCalledWith("docx");
    expect(onExport).toHaveBeenCalledWith("pdf");
    expect(onExport).toHaveBeenCalledWith("epub");
  });

  it("routes File menu lifecycle items to document callbacks", () => {
    const onNewDocument = vi.fn();
    const onOpenDocuments = vi.fn();
    const onMakeCopy = vi.fn();
    const onMoveToTrash = vi.fn();
    const menus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: { onNewDocument, onOpenDocuments, onMakeCopy, onMoveToTrash },
    });
    const fileMenu = menus.find((menu) => menu.id === "file");
    if (fileMenu === undefined) throw new Error("Missing File menu");
    const newDocument = fileMenu.items.find((item) => "id" in item && item.id === "file.new");
    const openDocuments = fileMenu.items.find((item) => "id" in item && item.id === "file.open");
    const makeCopy = fileMenu.items.find((item) => "id" in item && item.id === "file.makeCopy");
    const moveToTrash = fileMenu.items.find(
      (item) => "id" in item && item.id === "file.moveToTrash",
    );
    if (newDocument === undefined || !("onSelect" in newDocument)) {
      throw new Error("Missing New document command");
    }
    if (openDocuments === undefined || !("onSelect" in openDocuments)) {
      throw new Error("Missing Open documents command");
    }
    if (makeCopy === undefined || !("onSelect" in makeCopy)) {
      throw new Error("Missing Make a copy command");
    }
    if (moveToTrash === undefined || !("onSelect" in moveToTrash)) {
      throw new Error("Missing Move to trash command");
    }

    newDocument.onSelect();
    openDocuments.onSelect();
    makeCopy.onSelect();
    moveToTrash.onSelect();

    expect(onNewDocument).toHaveBeenCalledTimes(1);
    expect(onOpenDocuments).toHaveBeenCalledTimes(1);
    expect(onMakeCopy).toHaveBeenCalledTimes(1);
    expect(onMoveToTrash).toHaveBeenCalledTimes(1);
  });

  it("routes the Share copy-link item to the clipboard callback", () => {
    const onCopyLink = vi.fn();
    const menus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: { onCopyLink },
    });
    const shareMenu = menus.find((menu) => menu.id === "share");
    if (shareMenu === undefined) throw new Error("Missing Share menu");
    const copyLink = shareMenu.items.find((item) => "id" in item && item.id === "share.copyLink");
    if (copyLink === undefined || !("onSelect" in copyLink)) {
      throw new Error("Missing Copy link command");
    }

    copyLink.onSelect();

    expect(onCopyLink).toHaveBeenCalledTimes(1);
    expect(shareMenu.items.some((item) => "id" in item && item.id === "share.publish")).toBe(false);
    expect(shareMenu.items.some((item) => "id" in item && item.id === "share.email")).toBe(false);
  });

  it("routes Help menu items to real help callbacks and hides unsupported entries", () => {
    const onOpenKeyboardShortcuts = vi.fn();
    const onOpenAbout = vi.fn();
    const menus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: { onOpenKeyboardShortcuts, onOpenAbout },
    });
    const helpMenu = menus.find((menu) => menu.id === "help");
    if (helpMenu === undefined) throw new Error("Missing Help menu");
    const shortcuts = helpMenu.items.find((item) => "id" in item && item.id === "help.shortcuts");
    const about = helpMenu.items.find((item) => "id" in item && item.id === "help.about");
    if (shortcuts === undefined || !("onSelect" in shortcuts)) {
      throw new Error("Missing keyboard shortcuts command");
    }
    if (about === undefined || !("onSelect" in about)) {
      throw new Error("Missing about command");
    }

    shortcuts.onSelect();
    about.onSelect();

    expect(onOpenKeyboardShortcuts).toHaveBeenCalledTimes(1);
    expect(onOpenAbout).toHaveBeenCalledTimes(1);
    expect(helpMenu.items.some((item) => "id" in item && item.id === "help.docs")).toBe(false);
    expect(helpMenu.items.some((item) => "id" in item && item.id === "help.feedback")).toBe(false);
  });

  it("dispatches link, image, table, equation, cross-reference, field, smart-chip, and page-break insert menu items", () => {
    const onInsertLink = vi.fn();
    const onInsertImage = vi.fn();
    const onInsertTable = vi.fn();
    const onInsertEquation = vi.fn();
    const onInsertCrossReference = vi.fn();
    const onInsertField = vi.fn();
    const onInsertSmartChip = vi.fn();
    const onInsertPageBreak = vi.fn();
    const onInsertFootnote = vi.fn();
    const menus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: {
        onInsertLink,
        onInsertImage,
        onInsertTable,
        onInsertEquation,
        onInsertCrossReference,
        onInsertField,
        onInsertSmartChip,
        onInsertPageBreak,
        onInsertFootnote,
      },
    });
    const insertMenu = menus.find((menu) => menu.id === "insert");
    if (insertMenu === undefined) throw new Error("Missing Insert menu");
    const link = insertMenu.items.find((item) => "id" in item && item.id === "insert.link");
    const image = insertMenu.items.find((item) => "id" in item && item.id === "insert.image");
    const table = insertMenu.items.find((item) => "id" in item && item.id === "insert.table");
    const equation = insertMenu.items.find((item) => "id" in item && item.id === "insert.equation");
    const crossReference = insertMenu.items.find(
      (item) => "id" in item && item.id === "insert.crossRef",
    );
    const field = insertMenu.items.find((item) => "id" in item && item.id === "insert.field");
    const smartChip = insertMenu.items.find(
      (item) => "id" in item && item.id === "insert.smartChip",
    );
    const pageBreak = insertMenu.items.find(
      (item) => "id" in item && item.id === "insert.pageBreak",
    );
    const footnote = insertMenu.items.find((item) => "id" in item && item.id === "insert.footnote");
    if (link === undefined || !("onSelect" in link)) {
      throw new Error("Missing Link command");
    }
    if (image === undefined || !("onSelect" in image)) {
      throw new Error("Missing Image command");
    }
    if (table === undefined || !("onSelect" in table)) {
      throw new Error("Missing Table command");
    }
    if (equation === undefined || !("onSelect" in equation)) {
      throw new Error("Missing Equation command");
    }
    if (crossReference === undefined || !("onSelect" in crossReference)) {
      throw new Error("Missing Cross-reference command");
    }
    if (field === undefined || !("onSelect" in field)) {
      throw new Error("Missing Field command");
    }
    if (smartChip === undefined || !("onSelect" in smartChip)) {
      throw new Error("Missing Smart chip command");
    }
    if (pageBreak === undefined || !("onSelect" in pageBreak)) {
      throw new Error("Missing Page break command");
    }
    if (footnote === undefined || !("onSelect" in footnote)) {
      throw new Error("Missing Footnote command");
    }
    link.onSelect();
    image.onSelect();
    table.onSelect();
    equation.onSelect();
    crossReference.onSelect();
    field.onSelect();
    smartChip.onSelect();
    pageBreak.onSelect();
    footnote.onSelect();
    expect(onInsertLink).toHaveBeenCalledTimes(1);
    expect(onInsertImage).toHaveBeenCalledTimes(1);
    expect(onInsertTable).toHaveBeenCalledTimes(1);
    expect(onInsertEquation).toHaveBeenCalledTimes(1);
    expect(onInsertCrossReference).toHaveBeenCalledTimes(1);
    expect(onInsertField).toHaveBeenCalledTimes(1);
    expect(onInsertSmartChip).toHaveBeenCalledTimes(1);
    expect(onInsertPageBreak).toHaveBeenCalledTimes(1);
    expect(onInsertFootnote).toHaveBeenCalledTimes(1);
  });

  it("routes outline and word-count menu items to inspector callbacks", () => {
    const onOpenOutline = vi.fn();
    const onOpenWordCount = vi.fn();
    const menus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: { onOpenOutline, onOpenWordCount },
    });
    const viewMenu = menus.find((menu) => menu.id === "view");
    const toolsMenu = menus.find((menu) => menu.id === "tools");
    if (viewMenu === undefined) throw new Error("Missing View menu");
    if (toolsMenu === undefined) throw new Error("Missing Tools menu");
    const outline = viewMenu.items.find((item) => "id" in item && item.id === "view.outline");
    const wordCount = toolsMenu.items.find((item) => "id" in item && item.id === "tools.wordCount");
    if (outline === undefined || !("onSelect" in outline)) {
      throw new Error("Missing Show outline command");
    }
    if (wordCount === undefined || !("onSelect" in wordCount)) {
      throw new Error("Missing Word count command");
    }

    outline.onSelect();
    wordCount.onSelect();

    expect(onOpenOutline).toHaveBeenCalledTimes(1);
    expect(onOpenWordCount).toHaveBeenCalledTimes(1);
  });

  it("routes fullscreen menu item to the fullscreen callback", () => {
    const onToggleFullscreen = vi.fn();
    const menus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: { onToggleFullscreen },
    });
    const viewMenu = menus.find((menu) => menu.id === "view");
    if (viewMenu === undefined) throw new Error("Missing View menu");
    const fullscreen = viewMenu.items.find((item) => "id" in item && item.id === "view.fullscreen");
    if (fullscreen === undefined || !("onSelect" in fullscreen)) {
      throw new Error("Missing Full screen command");
    }

    fullscreen.onSelect();

    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it("routes View display toggles to callbacks and reflects current state", () => {
    const onToggleRulers = vi.fn();
    const onToggleNonPrintingCharacters = vi.fn();
    const visibleMenus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: { onToggleRulers, onToggleNonPrintingCharacters },
    });
    const visibleViewMenu = visibleMenus.find((menu) => menu.id === "view");
    if (visibleViewMenu === undefined) throw new Error("Missing View menu");
    const hideRuler = visibleViewMenu.items.find(
      (item) => "id" in item && item.id === "view.rulers",
    );
    const showNonPrinting = visibleViewMenu.items.find(
      (item) => "id" in item && item.id === "view.nonprinting",
    );
    if (hideRuler === undefined || !("onSelect" in hideRuler)) {
      throw new Error("Missing ruler command");
    }
    if (showNonPrinting === undefined || !("onSelect" in showNonPrinting)) {
      throw new Error("Missing non-printing characters command");
    }

    expect(hideRuler.label).toBe("Hide ruler");
    expect(showNonPrinting.label).toBe("Show non-printing characters");
    hideRuler.onSelect();
    showNonPrinting.onSelect();
    expect(onToggleRulers).toHaveBeenCalledTimes(1);
    expect(onToggleNonPrintingCharacters).toHaveBeenCalledTimes(1);

    const hiddenMenus = buildDocsMenus({
      ...makeCtx(null),
      state: {
        textColor: "#000000",
        highlightColor: "#fef08a",
        paragraphStyle: "paragraph",
        documentMode: "editing",
        showRulers: false,
        showNonPrintingCharacters: true,
      },
      callbacks: { onToggleRulers, onToggleNonPrintingCharacters },
    });
    const hiddenViewMenu = hiddenMenus.find((menu) => menu.id === "view");
    const showRuler = hiddenViewMenu?.items.find(
      (item) => "id" in item && item.id === "view.rulers",
    );
    const hideNonPrinting = hiddenViewMenu?.items.find(
      (item) => "id" in item && item.id === "view.nonprinting",
    );
    expect(showRuler).toMatchObject({ label: "Show ruler" });
    expect(hideNonPrinting).toMatchObject({ label: "Hide non-printing characters" });
  });

  it("routes View mode items to the document mode callback and omits unsupported suggesting", () => {
    const onSetDocumentMode = vi.fn();
    const menus = buildDocsMenus({
      ...makeCtx(null),
      callbacks: { onSetDocumentMode },
    });
    const viewMenu = menus.find((menu) => menu.id === "view");
    const modeSubmenu = viewMenu?.items.find(
      (item) => "kind" in item && item.kind === "submenu" && item.id === "view.mode",
    );
    if (modeSubmenu === undefined || !("items" in modeSubmenu)) {
      throw new Error("Missing View mode submenu");
    }

    const editing = modeSubmenu.items.find(
      (item) => "id" in item && item.id === "view.mode.editing",
    );
    const viewing = modeSubmenu.items.find(
      (item) => "id" in item && item.id === "view.mode.viewing",
    );

    expect(
      modeSubmenu.items.some((item) => "id" in item && item.id === "view.mode.suggesting"),
    ).toBe(false);
    expect(editing).toMatchObject({ kind: "checkbox", checked: true });
    expect(viewing).toMatchObject({ kind: "checkbox", checked: false });
    if (viewing === undefined || !("onCheckedChange" in viewing)) {
      throw new Error("Missing Viewing mode item");
    }
    viewing.onCheckedChange(true);
    expect(onSetDocumentMode).toHaveBeenCalledWith("viewing");

    const viewingMenus = buildDocsMenus({
      ...makeCtx(null),
      state: {
        ...makeCtx(null).state,
        documentMode: "viewing",
      },
      callbacks: { onSetDocumentMode },
    });
    const viewingMode = viewingMenus
      .find((menu) => menu.id === "view")
      ?.items.find((item) => "kind" in item && item.kind === "submenu" && item.id === "view.mode");
    const checkedViewing =
      viewingMode !== undefined && "items" in viewingMode
        ? viewingMode.items.find((item) => "id" in item && item.id === "view.mode.viewing")
        : undefined;
    expect(checkedViewing).toMatchObject({ kind: "checkbox", checked: true });
  });
});

describe("buildDocsRibbon", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("returns valid React JSX", () => {
    const { editor } = createFakeEditor();
    const node = buildDocsRibbon(makeCtx(editor));
    expect(isValidElement(node)).toBe(true);
  });

  it("renders a toolbar containing Bold / Italic / Underline ribbon toggles", () => {
    const { editor } = createFakeEditor();
    act(() => {
      root.render(buildDocsRibbon(makeCtx(editor)));
    });
    const toolbar = container.querySelector("[role='toolbar']");
    expect(toolbar).not.toBeNull();
    expect(container.querySelector("button[aria-label='Bold']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='Italic']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='Underline']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='Strikethrough']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='Undo']")).not.toBeNull();
    expect(container.querySelector("button[aria-label='Redo']")).not.toBeNull();
  });

  it("invokes the editor toggleBold chain when the Bold toggle is clicked", () => {
    const { editor, chain } = createFakeEditor();
    act(() => {
      root.render(buildDocsRibbon(makeCtx(editor)));
    });
    const bold = container.querySelector<HTMLButtonElement>("button[aria-label='Bold']");
    if (bold === null) throw new Error("Missing Bold toggle");
    act(() => {
      bold.click();
    });
    expect(chain.toggleBold).toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalled();
  });

  it("wires alignment ribbon buttons to editor text alignment", () => {
    const { editor, chain } = createFakeEditor();
    act(() => {
      root.render(buildDocsRibbon(makeCtx(editor)));
    });
    const alignRight = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Align right']",
    );
    if (alignRight === null) throw new Error("Missing Align right button");
    act(() => {
      alignRight.click();
    });
    expect(chain.setNativeTextAlign).toHaveBeenCalledWith("right");
    expect(chain.run).toHaveBeenCalled();
  });

  it("wires indent ribbon buttons to real list item commands", () => {
    const { editor, chain } = createFakeEditor();
    act(() => {
      root.render(buildDocsRibbon(makeCtx(editor)));
    });
    const decrease = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Decrease indent']",
    );
    const increase = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Increase indent']",
    );
    if (decrease === null) throw new Error("Missing Decrease indent button");
    if (increase === null) throw new Error("Missing Increase indent button");

    act(() => {
      decrease.click();
      increase.click();
    });

    expect(chain.liftListItem).toHaveBeenCalledWith("listItem");
    expect(chain.sinkListItem).toHaveBeenCalledWith("listItem");
    expect(chain.run).toHaveBeenCalledTimes(2);
  });

  it("wires checklist ribbon button to the native checklist command", () => {
    const { editor, chain } = createFakeEditor();
    act(() => {
      root.render(buildDocsRibbon(makeCtx(editor)));
    });
    const checklist = container.querySelector<HTMLButtonElement>("button[aria-label='Checklist']");
    if (checklist === null) throw new Error("Missing Checklist button");

    act(() => {
      checklist.click();
    });

    expect(chain.toggleNativeChecklist).toHaveBeenCalled();
    expect(chain.run).toHaveBeenCalledTimes(1);
  });

  it("routes the link, image, table, and equation ribbon buttons to insert callbacks", () => {
    const onInsertLink = vi.fn();
    const onInsertImage = vi.fn();
    const onInsertTable = vi.fn();
    const onInsertEquation = vi.fn();
    const { editor } = createFakeEditor();
    act(() => {
      root.render(
        buildDocsRibbon({
          ...makeCtx(editor),
          callbacks: { onInsertLink, onInsertImage, onInsertTable, onInsertEquation },
        }),
      );
    });
    const linkButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Insert link']",
    );
    const imageButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Insert image']",
    );
    const tableButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Insert table']",
    );
    const equationButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Insert equation']",
    );
    if (linkButton === null) throw new Error("Missing Insert link button");
    if (imageButton === null) throw new Error("Missing Insert image button");
    if (tableButton === null) throw new Error("Missing Insert table button");
    if (equationButton === null) throw new Error("Missing Insert equation button");
    act(() => {
      linkButton.click();
      imageButton.click();
      tableButton.click();
      equationButton.click();
    });
    expect(onInsertLink).toHaveBeenCalledTimes(1);
    expect(onInsertImage).toHaveBeenCalledTimes(1);
    expect(onInsertTable).toHaveBeenCalledTimes(1);
    expect(onInsertEquation).toHaveBeenCalledTimes(1);
  });

  it("disables unwired ribbon commands and exposes the reason", () => {
    const { editor } = createFakeEditor();
    act(() => {
      root.render(buildDocsRibbon(makeCtx(editor)));
    });
    const insertLink = container.querySelector<HTMLButtonElement>(
      "button[aria-label='Insert link']",
    );
    if (insertLink === null) throw new Error("Missing Insert link button");

    expect(insertLink.disabled).toBe(true);
    expect(insertLink.title).toBe("This command is not available in this editor yet.");
    expect(insertLink.getAttribute("aria-description")).toBe(
      "This command is not available in this editor yet.",
    );
  });
});
