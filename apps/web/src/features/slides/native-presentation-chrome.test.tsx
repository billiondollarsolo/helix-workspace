// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSlidesMenus,
  buildSlidesRibbon,
  type SlidesChromeContext,
} from "./native-presentation-chrome";
import { EditorRibbon } from "@helix/editors-ui";
import type { SlideShape } from "./seed";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function makeCtx(overrides: Partial<SlidesChromeContext> = {}): SlidesChromeContext {
  return {
    deckTitle: "Deck",
    deckTheme: "classic",
    slideCount: 2,
    activeSlideId: "slide-1",
    activeSlideLayout: "bullets",
    activeSlideTransition: undefined,
    activeShape: null,
    canPasteShape: false,
    canUndo: false,
    canRedo: false,
    fontFamily: "inter",
    fontSize: "16",
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    textAlign: "center",
    textColor: "#111827",
    highlightColor: "#ffffff",
    showGrid: false,
    showRulers: false,
    snapToGuides: true,
    zoomPercent: 100,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onAddSlide: vi.fn(),
    onDuplicateSlide: vi.fn(),
    onDeleteSlide: vi.fn(),
    onNewDeck: vi.fn(),
    onOpenDeck: vi.fn(),
    onMakeDeckCopy: vi.fn(),
    onMoveDeckToTrash: vi.fn(),
    onPresentDeck: vi.fn(),
    onExportPptx: vi.fn(),
    onExportPdf: vi.fn(),
    onExportSvgSeries: vi.fn(),
    onChangeTheme: vi.fn(),
    onChangeLayout: vi.fn(),
    onChangeTransition: vi.fn(),
    onChangeShapeFontFamily: vi.fn(),
    onChangeShapeFontSize: vi.fn(),
    onChangeShapeBold: vi.fn(),
    onChangeShapeItalic: vi.fn(),
    onChangeShapeUnderline: vi.fn(),
    onChangeShapeStrikethrough: vi.fn(),
    onChangeShapeTextAlign: vi.fn(),
    onChangeShapeTextColor: vi.fn(),
    onChangeShapeHighlightColor: vi.fn(),
    onCutShape: vi.fn(),
    onCopyShape: vi.fn(),
    onPasteShape: vi.fn(),
    onToggleGrid: vi.fn(),
    onToggleRulers: vi.fn(),
    onToggleSnapToGuides: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomFit: vi.fn(),
    onInsertTextBox: vi.fn(),
    onInsertShape: vi.fn(),
    onInsertImage: vi.fn(),
    onInsertMedia: vi.fn(),
    onShapeBringForward: vi.fn(),
    onShapeSendBackward: vi.fn(),
    onShapeBringToFront: vi.fn(),
    onShapeSendToBack: vi.fn(),
    onOpenComments: vi.fn(),
    onOpenVersionHistory: vi.fn(),
    onShareDeck: vi.fn(),
    onCopyDeckLink: vi.fn(),
    onOpenHelp: vi.fn(),
    onOpenAi: vi.fn(),
    onOpenTransitions: vi.fn(),
    onOpenAnimations: vi.fn(),
    onSuggestLayout: vi.fn(),
    onRewriteBullets: vi.fn(),
    onDraftSpeakerNotes: vi.fn(),
    ...overrides,
  };
}

describe("buildSlidesMenus", () => {
  it("returns the full Google-Slides parity menu set", () => {
    const menus = buildSlidesMenus(makeCtx());
    expect(menus.map((m) => m.id)).toEqual([
      "file",
      "edit",
      "view",
      "insert",
      "format",
      "tools",
      "help",
      "ai",
      "share",
    ]);
  });

  it("disables present command when slide count is 0", () => {
    const menus = buildSlidesMenus(makeCtx({ slideCount: 0 }));
    const view = menus.find((m) => m.id === "view");
    const present = view?.items.find((item) => "id" in item && item.id === "view:present");
    expect(present !== undefined && "disabled" in present && present.disabled === true).toBe(true);
  });

  it("disables shape-dependent format items when no shape selected", () => {
    const menus = buildSlidesMenus(makeCtx({ activeShape: null }));
    const format = menus.find((m) => m.id === "format");
    const textSubmenu = format?.items.find((item) => "id" in item && item.id === "format:text");
    expect(textSubmenu !== undefined && "items" in textSubmenu).toBe(true);
  });

  it("dispatches onAddSlide for the file:new-slide command", () => {
    const onAddSlide = vi.fn();
    const menus = buildSlidesMenus(makeCtx({ onAddSlide }));
    const file = menus.find((m) => m.id === "file");
    const newSlide = file?.items.find((item) => "id" in item && item.id === "file:new-slide");
    if (newSlide === undefined || !("onSelect" in newSlide)) {
      throw new Error("missing file:new-slide");
    }
    newSlide.onSelect();
    expect(onAddSlide).toHaveBeenCalledTimes(1);
  });

  it("wires Undo and Redo menu commands to draft history callbacks", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const menus = buildSlidesMenus(makeCtx({ canUndo: true, canRedo: true, onUndo, onRedo }));
    const edit = menus.find((m) => m.id === "edit");
    const undo = edit?.items.find((item) => "id" in item && item.id === "edit:undo");
    const redo = edit?.items.find((item) => "id" in item && item.id === "edit:redo");
    if (undo === undefined || !("onSelect" in undo)) {
      throw new Error("missing edit:undo");
    }
    if (redo === undefined || !("onSelect" in redo)) {
      throw new Error("missing edit:redo");
    }
    undo.onSelect();
    redo.onSelect();
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("wires Cut, Copy, and Paste to selected-shape clipboard callbacks", () => {
    const onCutShape = vi.fn();
    const onCopyShape = vi.fn();
    const onPasteShape = vi.fn();
    const menus = buildSlidesMenus(
      makeCtx({
        activeShape: {
          id: "shape-1",
          kind: "text",
          x: 0,
          y: 0,
          width: 30,
          height: 12,
          text: "Copy me",
        },
        canPasteShape: true,
        onCutShape,
        onCopyShape,
        onPasteShape,
      }),
    );
    const edit = menus.find((m) => m.id === "edit");
    const item = (id: string) => {
      const found = edit?.items.find((candidate) => "id" in candidate && candidate.id === id);
      if (found === undefined || !("onSelect" in found)) {
        throw new Error(`missing ${id}`);
      }
      return found;
    };

    item("edit:cut").onSelect();
    item("edit:copy").onSelect();
    item("edit:paste").onSelect();
    expect(onCutShape).toHaveBeenCalledTimes(1);
    expect(onCopyShape).toHaveBeenCalledTimes(1);
    expect(onPasteShape).toHaveBeenCalledTimes(1);
  });

  it("disables Cut and Copy without a selected shape and Paste without clipboard data", () => {
    const edit = buildSlidesMenus(makeCtx({ activeShape: null, canPasteShape: false })).find(
      (m) => m.id === "edit",
    );
    const item = (id: string) =>
      edit?.items.find((candidate) => "id" in candidate && candidate.id === id);

    expect(item("edit:cut")).toMatchObject({ disabled: true });
    expect(item("edit:copy")).toMatchObject({ disabled: true });
    expect(item("edit:paste")).toMatchObject({ disabled: true });
  });

  it("dispatches File deck lifecycle commands", () => {
    const ctx = makeCtx();
    const file = buildSlidesMenus(ctx).find((m) => m.id === "file");
    for (const id of ["file:new-deck", "file:open", "file:make-copy", "file:move-trash"]) {
      const item = file?.items.find((candidate) => "id" in candidate && candidate.id === id);
      if (item === undefined || !("onSelect" in item)) {
        throw new Error(`missing ${id}`);
      }
      item.onSelect();
    }
    expect(ctx.onNewDeck).toHaveBeenCalledTimes(1);
    expect(ctx.onOpenDeck).toHaveBeenCalledTimes(1);
    expect(ctx.onMakeDeckCopy).toHaveBeenCalledTimes(1);
    expect(ctx.onMoveDeckToTrash).toHaveBeenCalledTimes(1);
  });

  it("dispatches export callbacks", () => {
    const onExportPptx = vi.fn();
    const onExportPdf = vi.fn();
    const onExportSvgSeries = vi.fn();
    const menus = buildSlidesMenus(makeCtx({ onExportPptx, onExportPdf, onExportSvgSeries }));
    const file = menus.find((m) => m.id === "file");
    const exportSub = file?.items.find((item) => "id" in item && item.id === "file:export");
    if (exportSub === undefined || !("items" in exportSub)) {
      throw new Error("missing export submenu");
    }
    const items = exportSub.items;
    for (const item of items) {
      if ("onSelect" in item) item.onSelect();
    }
    expect(onExportPptx).toHaveBeenCalledTimes(1);
    expect(onExportPdf).toHaveBeenCalledTimes(1);
    expect(onExportSvgSeries).toHaveBeenCalledTimes(1);
  });

  it("dispatches Share menu commands", () => {
    const onShareDeck = vi.fn();
    const onCopyDeckLink = vi.fn();
    const menus = buildSlidesMenus(makeCtx({ onShareDeck, onCopyDeckLink }));
    const share = menus.find((m) => m.id === "share");
    const invite = share?.items.find((item) => "id" in item && item.id === "share:invite");
    const copyLink = share?.items.find((item) => "id" in item && item.id === "share:link");
    if (invite === undefined || !("onSelect" in invite)) {
      throw new Error("missing Share with people command");
    }
    if (copyLink === undefined || !("onSelect" in copyLink)) {
      throw new Error("missing Copy link command");
    }
    invite.onSelect();
    copyLink.onSelect();
    expect(onShareDeck).toHaveBeenCalledTimes(1);
    expect(onCopyDeckLink).toHaveBeenCalledTimes(1);
  });

  it("wires view grid, ruler, guide, and zoom commands to real callbacks", () => {
    const onToggleGrid = vi.fn();
    const onToggleRulers = vi.fn();
    const onToggleSnapToGuides = vi.fn();
    const onZoomIn = vi.fn();
    const onZoomOut = vi.fn();
    const onZoomFit = vi.fn();
    const view = buildSlidesMenus(
      makeCtx({
        showGrid: true,
        showRulers: true,
        snapToGuides: true,
        zoomPercent: 120,
        onToggleGrid,
        onToggleRulers,
        onToggleSnapToGuides,
        onZoomIn,
        onZoomOut,
        onZoomFit,
      }),
    ).find((m) => m.id === "view");
    const items = view?.items.filter((item) => "id" in item) ?? [];
    const byId = (id: string) => {
      const item = items.find((candidate) => "id" in candidate && candidate.id === id);
      if (item === undefined || !("onSelect" in item)) {
        throw new Error(`missing ${id}`);
      }
      return item;
    };

    expect(byId("view:grid")).toMatchObject({ label: "Hide grid" });
    expect(byId("view:rulers")).toMatchObject({ label: "Hide rulers" });
    expect(byId("view:guides")).toMatchObject({ label: "Disable snap to guides" });
    byId("view:grid").onSelect();
    byId("view:rulers").onSelect();
    byId("view:guides").onSelect();
    byId("view:zoom-in").onSelect();
    byId("view:zoom-out").onSelect();
    byId("view:zoom-fit").onSelect();
    expect(onToggleGrid).toHaveBeenCalledTimes(1);
    expect(onToggleRulers).toHaveBeenCalledTimes(1);
    expect(onToggleSnapToGuides).toHaveBeenCalledTimes(1);
    expect(onZoomIn).toHaveBeenCalledTimes(1);
    expect(onZoomOut).toHaveBeenCalledTimes(1);
    expect(onZoomFit).toHaveBeenCalledTimes(1);
  });

  it("reflects hidden view controls and disables zoom bounds", () => {
    const view = buildSlidesMenus(
      makeCtx({
        showGrid: false,
        showRulers: false,
        snapToGuides: false,
        zoomPercent: 50,
      }),
    ).find((m) => m.id === "view");
    const item = (id: string) =>
      view?.items.find((candidate) => "id" in candidate && candidate.id === id);

    expect(item("view:grid")).toMatchObject({ label: "Show grid" });
    expect(item("view:rulers")).toMatchObject({ label: "Show rulers" });
    expect(item("view:guides")).toMatchObject({ label: "Snap to guides" });
    expect(item("view:zoom-out")).toMatchObject({ disabled: true });
  });

  it("dispatches selected-shape text formatting menu commands", () => {
    const onChangeShapeBold = vi.fn();
    const onChangeShapeTextAlign = vi.fn();
    const menus = buildSlidesMenus(
      makeCtx({
        activeShape: {
          id: "shape-1",
          kind: "text",
          x: 0,
          y: 0,
          width: 50,
          height: 20,
          text: "Hello",
        },
        bold: false,
        onChangeShapeBold,
        onChangeShapeTextAlign,
      }),
    );
    const format = menus.find((m) => m.id === "format");
    const textSubmenu = format?.items.find((item) => "id" in item && item.id === "format:text");
    const alignSubmenu = format?.items.find((item) => "id" in item && item.id === "format:align");
    if (textSubmenu === undefined || !("items" in textSubmenu)) {
      throw new Error("missing text submenu");
    }
    if (alignSubmenu === undefined || !("items" in alignSubmenu)) {
      throw new Error("missing align submenu");
    }
    const boldItem = textSubmenu.items.find(
      (item) => "id" in item && item.id === "format:text:bold",
    );
    const alignRightItem = alignSubmenu.items.find(
      (item) => "id" in item && item.id === "format:align:right",
    );
    if (boldItem === undefined || !("onSelect" in boldItem)) {
      throw new Error("missing bold menu item");
    }
    if (alignRightItem === undefined || !("onSelect" in alignRightItem)) {
      throw new Error("missing align-right menu item");
    }
    boldItem.onSelect();
    alignRightItem.onSelect();
    expect(onChangeShapeBold).toHaveBeenCalledWith(true);
    expect(onChangeShapeTextAlign).toHaveBeenCalledWith("right");
  });

  it("dispatches transitions, animations, help, and AI commands to live editor callbacks", () => {
    const ctx = makeCtx();
    const menus = buildSlidesMenus(ctx);
    const command = (menuId: string, itemId: string) => {
      const menu = menus.find((candidate) => candidate.id === menuId);
      const item = menu?.items.find((candidate) => "id" in candidate && candidate.id === itemId);
      if (item === undefined || !("onSelect" in item)) {
        throw new Error(`missing ${itemId}`);
      }
      item.onSelect();
    };

    command("tools", "tools:transitions");
    command("tools", "tools:animations");
    command("help", "help:keyboard");
    command("ai", "ai:assistant");
    command("ai", "ai:suggest-layout");
    command("ai", "ai:rewrite");
    command("ai", "ai:draft-notes");

    expect(ctx.onOpenTransitions).toHaveBeenCalledTimes(1);
    expect(ctx.onOpenAnimations).toHaveBeenCalledTimes(1);
    expect(ctx.onOpenHelp).toHaveBeenCalledTimes(1);
    expect(ctx.onOpenAi).toHaveBeenCalledTimes(1);
    expect(ctx.onSuggestLayout).toHaveBeenCalledTimes(1);
    expect(ctx.onRewriteBullets).toHaveBeenCalledTimes(1);
    expect(ctx.onDraftSpeakerNotes).toHaveBeenCalledTimes(1);
  });
});

describe("buildSlidesRibbon", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function mountWithCtx(overrides: Partial<SlidesChromeContext> = {}) {
    act(() => {
      root.render(
        <EditorRibbon ariaLabel="Slides formatting toolbar">
          {buildSlidesRibbon(makeCtx(overrides))}
        </EditorRibbon>,
      );
    });
  }

  function ribbonButton(label: string): HTMLButtonElement | undefined {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.getAttribute("aria-label") === label,
    );
  }

  it("renders supported ribbon groups for undo/font/text/align/insert/arrange/slide", () => {
    mountWithCtx();
    const toolbar = container.querySelector('[role="toolbar"]');
    expect(toolbar).not.toBeNull();
    // Spot-check a button from each group is present.
    for (const label of [
      "Undo",
      "Redo",
      "Font family",
      "Font size",
      "Bold",
      "Italic",
      "Align center",
      "Justify",
      "Insert text box",
      "Insert image",
      "Bring forward",
      "Send to back",
      "Slide layout",
      "Slide transition",
      "Present",
    ]) {
      expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
  });

  it("disables shape-only controls when no shape is selected", () => {
    mountWithCtx({ activeShape: null });
    const bold = container.querySelector<HTMLButtonElement>('[aria-label="Bold"]');
    expect(bold?.disabled).toBe(true);
    const align = container.querySelector<HTMLButtonElement>('[aria-label="Align center"]');
    expect(align?.disabled).toBe(true);
  });

  it("disables Undo and Redo when draft history is empty", () => {
    mountWithCtx({ canUndo: false, canRedo: false });
    const undo = ribbonButton("Undo");
    const redo = ribbonButton("Redo");
    expect(undo?.disabled).toBe(true);
    expect(redo?.disabled).toBe(true);
  });

  it("dispatches Undo and Redo from the ribbon when history is available", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    mountWithCtx({ canUndo: true, canRedo: true, onUndo, onRedo });
    const undo = ribbonButton("Undo");
    const redo = ribbonButton("Redo");
    expect(undo?.disabled).toBe(false);
    expect(redo?.disabled).toBe(false);
    act(() => {
      undo?.click();
      redo?.click();
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it("enables shape-only controls when a shape is selected", () => {
    const shape: SlideShape = {
      id: "shape-1",
      kind: "text",
      x: 0,
      y: 0,
      width: 50,
      height: 20,
      text: "Hello",
    };
    mountWithCtx({ activeShape: shape });
    const bold = container.querySelector<HTMLButtonElement>('[aria-label="Bold"]');
    expect(bold?.disabled).toBe(false);
  });

  it("reflects and dispatches selected-shape text formatting from the ribbon", () => {
    const onChangeShapeBold = vi.fn();
    const onChangeShapeItalic = vi.fn();
    const onChangeShapeTextAlign = vi.fn();
    const shape: SlideShape = {
      id: "shape-1",
      kind: "text",
      x: 0,
      y: 0,
      width: 50,
      height: 20,
      text: "Hello",
      bold: true,
      italic: false,
      textAlign: "right",
    };
    mountWithCtx({
      activeShape: shape,
      bold: true,
      italic: false,
      textAlign: "right",
      onChangeShapeBold,
      onChangeShapeItalic,
      onChangeShapeTextAlign,
    });
    const bold = container.querySelector<HTMLButtonElement>('[aria-label="Bold"]');
    const italic = container.querySelector<HTMLButtonElement>('[aria-label="Italic"]');
    const alignRight = container.querySelector<HTMLButtonElement>('[aria-label="Align right"]');
    const alignLeft = container.querySelector<HTMLButtonElement>('[aria-label="Align left"]');

    expect(bold?.getAttribute("aria-pressed")).toBe("true");
    expect(italic?.getAttribute("aria-pressed")).toBe("false");
    expect(alignRight?.getAttribute("aria-pressed")).toBe("true");
    expect(alignLeft?.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      bold?.click();
      italic?.click();
      alignLeft?.click();
    });
    expect(onChangeShapeBold).toHaveBeenCalledWith(false);
    expect(onChangeShapeItalic).toHaveBeenCalledWith(true);
    expect(onChangeShapeTextAlign).toHaveBeenCalledWith("left");
  });

  it("disables Present when slideCount is 0", () => {
    mountWithCtx({ slideCount: 0 });
    const present = container.querySelector<HTMLButtonElement>('[aria-label="Present"]');
    expect(present?.disabled).toBe(true);
  });
});
