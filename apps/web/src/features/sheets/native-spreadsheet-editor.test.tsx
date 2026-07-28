// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWebPlatformHost, WebPlatformProvider, type WebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { uploadDriveFile } from "@/features/drive/api";
import type { SheetsApiCell, SheetsApiTab, SheetsDriveComment } from "./api";
import { NativeSpreadsheetEditor, adjustSheetDecimalFormat } from "./native-spreadsheet-editor";

vi.mock("@/features/drive/api", () => ({
  uploadDriveFile: vi.fn(),
}));

const sheetId = "11111111-1111-4111-8111-111111111111";
const tabId = "22222222-2222-4222-8222-222222222222";
const secondTabId = "77777777-7777-4777-8777-777777777777";
const sheetVersionId = "99999999-9999-4999-8999-999999999999";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let platformHost: WebPlatformHost;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let cells: SheetsApiCell[];
let tabs: SheetsApiTab[];
let comments: SheetsDriveComment[];
let sheetMetadata: Record<string, unknown>;
let originalClipboard: Navigator["clipboard"] | undefined;
let clipboardWriteText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
const uploadDriveFileMock = vi.mocked(uploadDriveFile);

interface TestCellWindow {
  readonly startRow: number;
  readonly startCol: number;
  readonly endRow: number;
  readonly endCol: number;
}

describe("NativeSpreadsheetEditor", () => {
  it("adjusts decimal precision without discarding currency or percent semantics", () => {
    expect(adjustSheetDecimalFormat({ numberFormat: "currency" }, 1)).toEqual({
      numberFormat: "custom",
      customNumberFormat: "$#,##0.000",
    });
    expect(
      adjustSheetDecimalFormat({ numberFormat: "custom", customNumberFormat: "0.00%;(0.00%)" }, -1),
    ).toEqual({
      numberFormat: "custom",
      customNumberFormat: "0.0%;(0.0%)",
    });
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    platformHost = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
    window.history.replaceState(null, "", `/sheets?sheet=${sheetId}&q=renewals`);
    toolCalls = [];
    sheetMetadata = { customKey: { keep: true } };
    originalClipboard = navigator.clipboard;
    clipboardWriteText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    tabs = [tab(), tab({ id: secondTabId, name: "Forecast", position: 1 })];
    cells = [cell(0, 0, "Customer"), cell(0, 1, "ARR"), cell(1, 0, "Acme"), cell(1, 1, "100")];
    comments = [
      comment("33333333-3333-4333-8333-333333333333", "Check ARR", {
        type: "sheet-range",
        sheetId,
        tabId,
        label: "B2",
        range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
      }),
    ];
    comments = [
      ...comments,
      comment(
        "66666666-6666-4666-8666-666666666666",
        "Reply with benchmark",
        comments[0]?.anchor ?? {},
        {},
        comments[0]?.id,
      ),
    ];
    cells.push({
      ...cell(1, 2, "=SUM(B2:B2)"),
      formula: "SUM(B2:B2)",
      calcValue: "100",
      dependencies: ["B2"],
      formulaError: null,
    });
    uploadDriveFileMock.mockResolvedValue({
      objectId: "55555555-5555-4555-8555-555555555555",
      orgId: "org-1",
      ownerActorId: "actor-1",
      name: "Forecast_photo.png",
      folderId: null,
      storageKey: "drive/555/Forecast_photo.png",
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
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/auth/get-session") {
        return Promise.resolve(
          Response.json({
            user: {
              id: "session-user",
              email: "owner@helix.local",
              name: "Owner One",
              actorId: "actor-1",
            },
          }),
        );
      }
      if (url === "/api/tools/sheets.get") {
        return Promise.resolve(
          Response.json({
            id: sheetId,
            title: "Renewals",
            tabs: sortedTabs(),
            metadata: sheetMetadata,
            ownerActorId: null,
            createdByActorId: null,
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/sheets.tab.get") {
        const request = body as { readonly tabId?: string; readonly window?: TestCellWindow };
        const targetTab = tabs.find((candidate) => candidate.id === request.tabId) ?? tab();
        return Promise.resolve(
          Response.json({
            ...targetTab,
            cells: targetTab.id === tabId ? filterTestCellsForWindow(cells, request.window) : [],
          }),
        );
      }
      if (url === "/api/tools/sheets.version.list") {
        return Promise.resolve(
          Response.json({
            versions: [
              {
                id: sheetVersionId,
                sheetId,
                versionNumber: 7,
                mimeType: "application/vnd.helix.spreadsheet+json",
                byteSize: 512,
                sha256: "0".repeat(64),
                metadata: { title: "Restored sheet", tabCount: 1, cellCount: 1 },
                createdByActorId: "actor-1",
                createdAt: "2026-05-20T13:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/tools/sheets.version.restore") {
        cells = [cell(0, 0, "Restored customer")];
        return Promise.resolve(
          Response.json({
            id: sheetId,
            title: "Renewals",
            tabs: sortedTabs(),
            metadata: sheetMetadata,
            ownerActorId: null,
            createdByActorId: null,
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T13:05:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/drive.access.list") {
        return Promise.resolve(
          Response.json({
            grants: [
              {
                actorId: "actor-2",
                role: "reader",
                displayName: "Maya Chen",
                email: "maya@helix.local",
                grantedByActorId: "actor-1",
                expiresAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          }),
        );
      }
      if (url === "/api/tools/sheets.update") {
        const update = body as { readonly metadata?: Record<string, unknown> };
        sheetMetadata = update.metadata ?? sheetMetadata;
        return Promise.resolve(
          Response.json({
            id: sheetId,
            title: "Renewals",
            tabs: sortedTabs(),
            metadata: sheetMetadata,
            ownerActorId: null,
            createdByActorId: null,
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/sheets.tab.create") {
        const create = body as {
          readonly name: string;
          readonly position?: number;
          readonly metadata?: Record<string, unknown>;
        };
        const created = tab({
          id: "88888888-8888-4888-8888-888888888888",
          name: create.name,
          position: create.position ?? tabs.length,
          metadata: create.metadata ?? {},
        });
        tabs = [...tabs, created];
        return Promise.resolve(Response.json(created));
      }
      if (url === "/api/tools/sheets.tab.update") {
        const update = body as {
          readonly tabId: string;
          readonly name?: string;
          readonly position?: number;
          readonly metadata?: Record<string, unknown>;
        };
        const existing = tabs.find((candidate) => candidate.id === update.tabId);
        if (existing === undefined) {
          return Promise.resolve(Response.json({ error: "missing tab" }, { status: 404 }));
        }
        const updated = {
          ...existing,
          ...(update.name === undefined ? {} : { name: update.name }),
          ...(update.position === undefined ? {} : { position: update.position }),
          ...(update.metadata === undefined ? {} : { metadata: update.metadata }),
          updatedAt: "2026-05-20T12:05:00.000Z",
        };
        tabs = tabs.map((candidate) => (candidate.id === update.tabId ? updated : candidate));
        return Promise.resolve(Response.json(updated));
      }
      if (url === "/api/tools/sheets.tab.delete") {
        const deletion = body as { readonly tabId: string };
        tabs = tabs.filter((candidate) => candidate.id !== deletion.tabId);
        cells = deletion.tabId === tabId ? [] : cells;
        return Promise.resolve(
          Response.json({ tabId: deletion.tabId, deletedAt: "2026-05-20T12:06:00.000Z" }),
        );
      }
      if (url === "/api/tools/sheets.cells.update") {
        const edits =
          (
            body as {
              readonly window?: TestCellWindow;
              readonly edits?: readonly {
                readonly row: number;
                readonly col: number;
                readonly value: string;
                readonly format?: Record<string, unknown>;
              }[];
            }
          ).edits ?? [];
        const window = (body as { readonly window?: TestCellWindow }).window;
        for (const edit of edits) {
          const existing = cells.find(
            (candidate) => candidate.row === edit.row && candidate.col === edit.col,
          );
          const updated = cell(
            edit.row,
            edit.col,
            edit.value,
            edit.format ?? existing?.format ?? {},
          );
          cells = [
            ...cells.filter(
              (candidate) => candidate.row !== edit.row || candidate.col !== edit.col,
            ),
            {
              ...updated,
              formula: existing?.formula ?? updated.formula,
              calcValue: existing?.calcValue ?? updated.calcValue,
              dependencies: existing?.dependencies ?? updated.dependencies,
              formulaError: existing?.formulaError ?? updated.formulaError,
            },
          ];
        }
        return Promise.resolve(
          Response.json({ ...tab(), cells: filterTestCellsForWindow(cells, window) }),
        );
      }
      if (url === "/api/tools/sheets.range.sort") {
        const sort = body as {
          readonly range: {
            readonly startRow: number;
            readonly startCol: number;
            readonly endRow: number;
            readonly endCol: number;
          };
          readonly direction: "asc" | "desc";
          readonly window?: TestCellWindow;
        };
        cells = sortedCells(cells, sort.range, sort.direction);
        return Promise.resolve(
          Response.json({ ...tab(), cells: filterTestCellsForWindow(cells, sort.window) }),
        );
      }
      if (url === "/api/tools/sheets.export") {
        const input = body as { readonly format: "csv" | "tsv" | "xlsx" | "ods" };
        return Promise.resolve(
          Response.json({
            sheetId,
            format: input.format,
            filename: `renewals.${input.format}`,
            mimeType:
              input.format === "ods"
                ? "application/vnd.oasis.opendocument.spreadsheet"
                : "application/octet-stream",
            byteSize: 3,
            contentBase64: "AQID",
            metadata: { generatedBy: `helix.sheets.export.${input.format}` },
          }),
        );
      }
      if (url === "/api/tools/sheets.comment.list") {
        const status = (body as { readonly status?: string }).status ?? "open";
        return Promise.resolve(
          Response.json({
            comments: comments.filter(
              (candidate) => status === "all" || candidate.status === status,
            ),
          }),
        );
      }
      if (url === "/api/tools/sheets.comment.create") {
        const input = body as {
          readonly body: string;
          readonly anchor: Record<string, unknown>;
          readonly metadata?: Record<string, unknown>;
          readonly parentCommentId?: string;
        };
        const created = comment(
          "44444444-4444-4444-8444-444444444444",
          input.body,
          input.anchor,
          input.metadata ?? {},
          input.parentCommentId,
        );
        comments = [...comments, created];
        return Promise.resolve(Response.json(created));
      }
      if (url === "/api/tools/sheets.comment.resolve") {
        const input = body as { readonly commentId: string };
        const resolvedAt = "2026-05-21T01:00:00.000Z";
        comments = comments.map((candidate) =>
          candidate.id === input.commentId
            ? { ...candidate, status: "resolved", resolvedAt, updatedAt: resolvedAt }
            : candidate,
        );
        return Promise.resolve(
          Response.json(comments.find((candidate) => candidate.id === input.commentId)),
        );
      }
      if (url === "/api/tools/sheets.comment.reopen") {
        const input = body as { readonly commentId: string };
        const updatedAt = "2026-05-21T02:00:00.000Z";
        comments = comments.map((candidate) =>
          candidate.id === input.commentId
            ? { ...candidate, status: "open", resolvedAt: null, updatedAt }
            : candidate,
        );
        return Promise.resolve(
          Response.json(comments.find((candidate) => candidate.id === input.commentId)),
        );
      }
      if (url === "/api/tools/sheets.comment.update") {
        const input = body as { readonly commentId: string; readonly body: string };
        const updatedAt = "2026-05-21T03:00:00.000Z";
        comments = comments.map((candidate) =>
          candidate.id === input.commentId
            ? { ...candidate, body: input.body, updatedAt }
            : candidate,
        );
        return Promise.resolve(
          Response.json(comments.find((candidate) => candidate.id === input.commentId)),
        );
      }
      if (url === "/api/tools/sheets.comment.delete") {
        const input = body as { readonly commentId: string };
        const deleted = comments.find((candidate) => candidate.id === input.commentId);
        comments = comments.filter(
          (candidate) =>
            candidate.id !== input.commentId && candidate.parentCommentId !== input.commentId,
        );
        return Promise.resolve(Response.json(deleted));
      }
      return Promise.resolve(Response.json({ error: "unknown tool" }, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("creates, renames, reorders, and deletes native sheet tabs", async () => {
    render();
    await settle();

    expect(input("Active tab name").value).toBe("Pipeline");

    await editTextInput("Active tab name", "Q2 Pipeline");
    await clickButton("Rename active tab");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.update",
      body: { tabId, name: "Q2 Pipeline" },
    });
    expect(button("Open tab Q2 Pipeline")).toBeDefined();

    await clickButton("Add sheet tab");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.create",
      body: { sheetId, name: "Sheet 3", position: 2, metadata: {} },
    });
    expect(input("Active tab name").value).toBe("Sheet 3");
    expect(input("A1").value).toBe("");

    await clickButton("Move active tab left");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.update",
      body: { tabId: secondTabId, position: 2 },
    });
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.update",
      body: { tabId: "88888888-8888-4888-8888-888888888888", position: 1 },
    });

    await clickButton("Delete active tab");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.delete",
      body: { tabId: "88888888-8888-4888-8888-888888888888" },
    });
    expect(input("Active tab name").value).toBe("Forecast");
    expect(button("Delete active tab").disabled).toBe(false);
  });

  it("copies a stable spreadsheet link from the Share menu", async () => {
    render();
    await settle();

    clickAppMenu("share");
    clickOpenMenuItem("Copy link");
    await settle();

    const expected = new URL(window.location.href);
    expected.pathname = "/sheets";
    expected.search = "";
    expected.searchParams.set("sheet", sheetId);
    expect(clipboardWriteText).toHaveBeenCalledWith(expected.href);
  });

  it("opens the real Drive share dialog from the app-bar Share button", async () => {
    render();
    await settle();

    clickAppBarShare();
    await settle();

    expect(container.querySelector('[role="dialog"][aria-label="Share Renewals"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain("People with access");
  });

  it("loads native sheet cells with bounded viewport windows", async () => {
    render();
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.get",
      body: {
        tabId,
        window: { startRow: 0, startCol: 0, endRow: 47, endCol: 23 },
      },
    });

    // Scroll the viewport by navigating from the cell grid (End key shifts the
    // viewport to the last column via the keyboard navigation path used by the
    // new chrome).
    await clickCell("A1");
    await keyDownCell("A1", "End");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.get",
      body: {
        tabId,
        window: { startRow: 0, startCol: 26, endRow: 47, endCol: 49 },
      },
    });
  });

  it("recovers uncommitted grid edits after reload and clears recovery when backend catches up", async () => {
    render();
    await settle();

    await changeCell("D2", "At risk");
    await settle();

    const recoveryKey = `helix.sheets.unsavedGrid.v1.${sheetId}.${tabId}`;
    expect(window.localStorage.getItem(recoveryKey)).not.toBeNull();
    expect(toolCalls.some((call) => call.url === "/api/tools/sheets.cells.update")).toBe(false);

    remountFreshEditor();
    await settle();

    expect(input("D2").value).toBe("At risk");
    expect(container.querySelector('[role="status"][aria-label="Recovered"]')).not.toBeNull();

    cells = [
      ...cells.filter((candidate) => candidate.row !== 1 || candidate.col !== 3),
      cell(1, 3, "At risk"),
    ];
    remountFreshEditor();
    await settle();

    expect(input("D2").value).toBe("At risk");
    expect(window.localStorage.getItem(recoveryKey)).toBeNull();
  });

  it("exports native spreadsheets as ODS workbooks", async () => {
    const createObjectURL = vi.fn(() => "blob:sheet-export");
    const revokeObjectURL = vi.fn();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    render();
    await settle();

    await clickButton("Export workbook as ODS");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.export",
      body: { sheetId, format: "ods" },
    });
    expect(createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "application/vnd.oasis.opendocument.spreadsheet" }),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:sheet-export");
    clickSpy.mockRestore();
  });

  it("lists and restores spreadsheet versions from the side panel", async () => {
    render();
    await settle();

    await openSidePanelTab("Versions");
    expect(container.textContent).toContain("Version history");
    expect(container.textContent).toContain("Version 7");
    expect(container.textContent).toContain("1 tab, 1 cell");

    await clickTextButton("Restore");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.version.restore",
      body: { sheetId, versionId: sheetVersionId },
    });
    expect(input("A1").value).toBe("Restored customer");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.get",
      body: {
        tabId,
        window: { startRow: 0, startCol: 0, endRow: 47, endCol: 23 },
      },
    });
  });

  it("registers spreadsheet command palette actions", async () => {
    const onBack = vi.fn();
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    render({ onBack });
    await settle();

    const commands = platformHost.getCommandPaletteItems();
    expect(commands.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Back to Sheets list",
        "Export spreadsheet as ODS",
        "Export active sheet as CSV",
        "Create sheet tab",
        "Insert QUERY count for selected range",
        "Sort range A to Z",
        "Analyze selected range",
        "Jump to spreadsheet comments",
      ]),
    );

    await act(async () => {
      await Promise.resolve(
        commands.find((item) => item.label === "Export spreadsheet as ODS")?.run(),
      );
    });
    await settle();
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.export",
      body: { sheetId, format: "ods" },
    });

    await act(async () => {
      await Promise.resolve(commands.find((item) => item.label === "Create sheet tab")?.run());
    });
    await settle();
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.tab.create",
      body: { sheetId, name: "Sheet 3", position: 2, metadata: {} },
    });

    await act(async () => {
      await Promise.resolve(commands.find((item) => item.label === "Back to Sheets list")?.run());
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });

  it("persists metadata-backed frozen panes and keeps frozen bands visible while scrolling", async () => {
    render();
    await settle();

    await clickCell("B2");
    await openSidePanelTab("Cells");
    await clickButton("Freeze rows to selection");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.update",
      body: {
        sheetId,
        metadata: {
          customKey: { keep: true },
          frozenPanes: [{ tabId, frozenRows: 2, frozenCols: 0 }],
        },
      },
    });

    await clickButton("Freeze columns to selection");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.update",
      body: {
        sheetId,
        metadata: {
          customKey: { keep: true },
          frozenPanes: [{ tabId, frozenRows: 2, frozenCols: 2 }],
        },
      },
    });

    // The frozen rows/cols stay visible because the visible-rows helper always
    // includes the frozen prefix — A1 and B2 remain mounted while the rest of
    // the grid scrolls beneath them. (Viewport scrolling now happens via
    // keyboard navigation on the grid; the legacy scroll-button toolbar was
    // removed when the chrome was unified onto the new ribbon.)
    expect(input("A1").value).toBe("Customer");
    expect(input("B2").value).toBe("100");

    await clickButton("Clear frozen panes");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.update",
      body: { sheetId, metadata: { customKey: { keep: true }, frozenPanes: [] } },
    });
  });

  it("renders chart data tables and parses formatted numeric chart values", async () => {
    cells = [cell(0, 0, "Customer"), cell(0, 1, "ARR"), cell(1, 0, "Acme"), cell(1, 1, "$1,200")];
    render();
    await settle();

    await clickCell("A1");
    await shiftSelectCell("B2");
    await openSidePanelTab("Charts");
    await clickButton("Add chart");
    await settle();

    expect(container.querySelector('[aria-label="Acme 1200"]')).not.toBeNull();
    const table = container.querySelector('[aria-label="Chart data Chart A1:B2"]');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain("Acme");
    expect(table?.textContent).toContain("1200");
    expect(container.querySelector('[aria-label="Embedded chart Chart A1:B2"] table')).toBeNull();
  });

  it("drops image files onto the spreadsheet grid as Drive-backed embedded images", async () => {
    render();
    await settle();
    setSpreadsheetGridRect();

    const file = new File(["png"], "Forecast_photo.png", { type: "image/png" });
    await dropImageOnSpreadsheet(file, { x: 348, y: 172 });
    await settle();

    expect(uploadDriveFileMock).toHaveBeenCalledWith({ file, folderId: null });
    const imageUpdate = toolCalls.filter((call) => call.url === "/api/tools/sheets.update").at(-1);
    expect(imageUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        images: [
          {
            tabId,
            driveObjectId: "55555555-5555-4555-8555-555555555555",
            src: "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
            alt: "Forecast photo",
            title: "Forecast_photo.png",
            mimeType: "image/png",
            placement: { anchorRow: 4, anchorCol: 3, rowSpan: 8, colSpan: 4 },
          },
        ],
      },
    });
    expect(
      container.querySelector(
        'figure[aria-label="Embedded image Forecast photo"] img[src="/api/drive/objects/55555555-5555-4555-8555-555555555555/content"]',
      ),
    ).not.toBeNull();

    await dragEmbeddedImage("Forecast photo", { x: 348, y: 172 }, { x: 540, y: 236 });
    await settle();

    const movedImageUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(movedImageUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        images: [
          {
            driveObjectId: "55555555-5555-4555-8555-555555555555",
            placement: { anchorRow: 6, anchorCol: 5, rowSpan: 8, colSpan: 4 },
          },
        ],
      },
    });

    await resizeEmbeddedImage("Forecast photo", { x: 910, y: 478 }, { x: 1102, y: 542 });
    await settle();

    const resizedImageUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(resizedImageUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        images: [
          {
            driveObjectId: "55555555-5555-4555-8555-555555555555",
            placement: { anchorRow: 6, anchorCol: 5, rowSpan: 10, colSpan: 6 },
          },
        ],
      },
    });

    await deleteEmbeddedImage("Forecast photo");
    await settle();

    const deletedImageUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(deletedImageUpdate?.body).toMatchObject({
      sheetId,
      metadata: { customKey: { keep: true }, images: [] },
    });
  });

  it("drops text onto the spreadsheet grid through the persisted cell edit path", async () => {
    render();
    await settle();
    setSpreadsheetGridRect();

    await dropTextOnSpreadsheet("Q3 target\tOwner\n42\tMaya", { x: 154, y: 106 });
    await settle();

    expect(input("B3").value).toBe("Q3 target");
    expect(input("C3").value).toBe("Owner");
    expect(input("B4").value).toBe("42");
    expect(input("C4").value).toBe("Maya");

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 1, value: "Q3 target" },
          { row: 2, col: 2, value: "Owner" },
          { row: 3, col: 1, value: "42" },
          { row: 3, col: 2, value: "Maya" },
        ],
      },
    });
  });

  it("drops safe URLs as persisted spreadsheet cell links", async () => {
    render();
    await settle();
    setSpreadsheetGridRect();

    const url = "https://example.com/renewals-plan";
    await dropTextOnSpreadsheet(url, { x: 154, y: 106 }, "text/uri-list");
    await settle();

    expect(input("B3").value).toBe(url);
    expect(input("B3").style.textDecoration).toBe("underline");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 2, col: 1, value: url, format: { linkUrl: url } }],
      },
    });

    await focusCell("B3");
    await changeCell("B3", "Renewals plan");
    await blurCell("B3");
    await settle();

    const latestCellUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.cells.update")
      .at(-1);
    expect(latestCellUpdate?.body).toMatchObject({
      tabId,
      edits: [{ row: 2, col: 1, value: "Renewals plan", format: {} }],
    });
  });

  it("keeps unsafe dropped URLs as plain spreadsheet text", async () => {
    render();
    await settle();
    setSpreadsheetGridRect();

    await dropTextOnSpreadsheet("javascript:alert(1)", { x: 154, y: 106 });
    await settle();

    expect(input("B3").value).toBe("javascript:alert(1)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 2, col: 1, value: "javascript:alert(1)" }],
      },
    });
  });

  it("renders wrapped and vertically aligned cell text through the visual cell layer", async () => {
    cells.push(
      cell(2, 1, "Workspace parity needs wrapped cell text", {
        align: "center",
        fontFamily: "serif",
        fontSize: "14",
        strikethrough: true,
        underline: true,
        verticalAlign: "bottom",
        wrapText: true,
      }),
    );

    render();
    await settle();

    const visual = visualCell("B3");
    expect(visual.textContent).toBe("Workspace parity needs wrapped cell text");
    expect(visual.style.display).toBe("flex");
    expect(visual.style.alignItems).toBe("flex-end");
    expect(visual.style.whiteSpace).toBe("pre-wrap");
    expect(visual.style.overflowWrap).toBe("anywhere");
    expect(visual.style.textAlign).toBe("center");
    expect(visual.style.fontFamily).toContain("Georgia");
    expect(visual.style.fontSize).toBe("14px");
    expect(visual.style.textDecoration).toBe("underline line-through");

    await focusCell("B3");
    expect(visualCell("B3").style.display).toBe("none");
    expect(input("B3").style.opacity).toBe("1");
  });

  it("lets non-wrapped text visually overflow through adjacent empty cells until blocked", async () => {
    cells.push(
      cell(3, 1, "Long spreadsheet label that should overflow empty cells"),
      cell(3, 4, "Blocked"),
      cell(4, 1, "Long spreadsheet label blocked immediately"),
      cell(4, 2, "Next"),
      cell(5, 0, "Blocked"),
      cell(5, 3, "Right aligned label that should overflow left", { align: "right" }),
      cell(6, 2, "Left block"),
      cell(6, 3, "Right aligned label blocked immediately", { align: "right" }),
      cell(7, 0, "Blocked"),
      cell(7, 3, "Centered label that should overflow both ways", { align: "center" }),
      cell(7, 5, "Blocked"),
      cell(8, 2, "Left block"),
      cell(8, 3, "Centered label blocked immediately", { align: "center" }),
      cell(8, 4, "Right block"),
    );

    render();
    await settle();

    expect(cellShell("B4").style.overflow).toBe("visible");
    expect(cellShell("B4").style.zIndex).toBe("2");
    expect(visualCell("B4").style.width).toBe("288px");
    expect(visualCell("B4").style.overflow).toBe("visible");
    expect(visualCell("B4").style.textOverflow).toBe("");

    expect(cellShell("B5").style.overflow).toBe("hidden");
    expect(visualCell("B5").style.width).toBe("");
    expect(visualCell("B5").style.overflow).toBe("hidden");
    expect(visualCell("B5").style.textOverflow).toBe("ellipsis");

    expect(cellShell("D6").style.overflow).toBe("visible");
    expect(cellShell("D6").style.zIndex).toBe("2");
    expect(visualCell("D6").style.left).toBe("-192px");
    expect(visualCell("D6").style.width).toBe("288px");
    expect(visualCell("D6").style.textAlign).toBe("right");

    expect(cellShell("D7").style.overflow).toBe("hidden");
    expect(visualCell("D7").style.left).toBe("0px");
    expect(visualCell("D7").style.width).toBe("");
    expect(visualCell("D7").style.textOverflow).toBe("ellipsis");

    expect(cellShell("D8").style.overflow).toBe("visible");
    expect(cellShell("D8").style.zIndex).toBe("2");
    expect(visualCell("D8").style.left).toBe("-192px");
    expect(visualCell("D8").style.width).toBe("384px");
    expect(visualCell("D8").style.textAlign).toBe("center");

    expect(cellShell("D9").style.overflow).toBe("hidden");
    expect(visualCell("D9").style.left).toBe("0px");
    expect(visualCell("D9").style.width).toBe("");
    expect(visualCell("D9").style.textOverflow).toBe("ellipsis");

    await focusCell("B4");
    expect(visualCell("B4").style.display).toBe("none");
    expect(input("B4").style.opacity).toBe("1");
  });

  it("renders a backend tab as an editable native grid and persists committed cells", async () => {
    render();
    await settle();

    expect(container.textContent).toContain("Renewals");
    expect(input("A1").value).toBe("Customer");
    expect(input("B2").value).toBe("100");
    expect(cellShell("B2").style.boxShadow).toContain("#f59e0b");
    const arrCommentOverlay = container.querySelector('[aria-label="Comment range B2"]');
    expect(arrCommentOverlay).not.toBeNull();
    expect((arrCommentOverlay as HTMLDivElement | null)?.style.left).toBe("144px");
    expect((arrCommentOverlay as HTMLDivElement | null)?.style.top).toBe("64px");
    expect(container.querySelectorAll('[aria-label="Comment range B2"]')).toHaveLength(1);
    expect(container.textContent).toContain("Check ARR");
    expect(container.textContent).toContain("Reply with benchmark");

    await clickCell("A1");
    await shiftSelectCell("B2");
    await openSidePanelTab("Charts");
    await clickButton("Add chart");
    await settle();

    const chartUpdate = toolCalls.find((call) => call.url === "/api/tools/sheets.update");
    expect(chartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          {
            type: "bar",
            title: "Chart A1:B2",
            tabId,
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
            placement: { anchorRow: 0, anchorCol: 2, rowSpan: 8, colSpan: 4 },
          },
        ],
      },
    });
    expect(container.textContent).toContain("Chart A1:B2");
    expect(container.querySelector('[aria-label="Acme 100"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Embedded chart Chart A1:B2"]')).not.toBeNull();

    await openSidePanelTab("Charts");
    await clickCell("D4");
    await clickButton("Place bar chart Chart A1:B2 at selected cell");
    await settle();

    const placedChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(placedChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          {
            title: "Chart A1:B2",
            placement: { anchorRow: 3, anchorCol: 3, rowSpan: 8, colSpan: 4 },
          },
        ],
      },
    });

    await clickCell("A1");
    await shiftSelectCell("B2");

    await openSidePanelTab("Pivots");
    await clickButton("Create pivot table");
    await settle();

    const pivotUpdate = toolCalls.filter((call) => call.url === "/api/tools/sheets.update").at(-1);
    expect(pivotUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        charts: [{ type: "bar", title: "Chart A1:B2" }],
        pivotTables: [
          {
            title: "Pivot A1:B2",
            tabId,
            rowFieldCol: 0,
            valueFieldCol: 1,
            aggregation: "sum",
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
          },
        ],
      },
    });
    expect(container.textContent).toContain("Pivot A1:B2");
    expect(container.querySelector('[aria-label="Acme pivot 100"]')).not.toBeNull();

    await editTextInput("Pivot title Pivot A1:B2", "ARR Pivot");
    await settle();

    const renamedPivotUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(renamedPivotUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        pivotTables: [{ title: "ARR Pivot" }],
      },
    });

    await selectToolbarOption("Pivot aggregation ARR Pivot", "count");
    await settle();

    const countPivotUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(countPivotUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        pivotTables: [{ title: "ARR Pivot", aggregation: "count" }],
      },
    });
    expect(container.querySelector('[aria-label="Acme pivot 1"]')).not.toBeNull();

    await clickCell("A1");
    await shiftSelectCell("C2");
    await clickButton("Use selected range for pivot table ARR Pivot");
    await settle();

    const rerangedPivotUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(rerangedPivotUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        pivotTables: [
          {
            title: "ARR Pivot",
            rowFieldCol: 0,
            valueFieldCol: 1,
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
          },
        ],
      },
    });

    await clickButton("Delete pivot table ARR Pivot");
    await settle();

    const deletedPivotUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(deletedPivotUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        pivotTables: [],
      },
    });
    expect(container.textContent).not.toContain("ARR Pivot");

    await clickCell("A1");
    await shiftSelectCell("B2");

    await openSidePanelTab("Names");
    await clickButton("Name selected range");
    await settle();

    const namedRangeUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(namedRangeUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        charts: [{ type: "bar", title: "Chart A1:B2" }],
        namedRanges: [
          {
            name: "Range_A1_B2",
            tabId,
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
          },
        ],
      },
    });
    expect(input("Named range Range_A1_B2").value).toBe("Range_A1_B2");
    expect(container.textContent).toContain("A1:B2");

    await editTextInput("Named range Range_A1_B2", "Revenue_Table");
    await settle();

    const renamedRangeUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(renamedRangeUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        namedRanges: [{ name: "Revenue_Table" }],
      },
    });

    await clickCell("A1");
    await shiftSelectCell("C2");
    await clickButton("Use selected range for named range Revenue_Table");
    await settle();

    const rerangedNamedRangeUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(rerangedNamedRangeUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        namedRanges: [
          {
            name: "Revenue_Table",
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
          },
        ],
      },
    });
    expect(container.textContent).toContain("A1:C2");

    await openSidePanelTab("Cells");
    await clickButton("Merge selected cells");
    await settle();

    const mergedRangeUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(mergedRangeUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        charts: [{ type: "bar", title: "Chart A1:B2" }],
        namedRanges: [{ name: "Revenue_Table" }],
        mergedCells: [
          {
            label: "A1:C2",
            tabId,
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
          },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Merged range A1:C2"]')).not.toBeNull();
    expect(input("B1").readOnly).toBe(true);

    await clickButton("Unmerge range A1:C2");
    await settle();

    const unmergedRangeUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(unmergedRangeUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        mergedCells: [],
      },
    });

    const revenueNamedRange = (sheetMetadata.namedRanges as Array<{ readonly id: string }>)[0];
    if (revenueNamedRange === undefined) {
      throw new Error("Expected created named range.");
    }
    await editCell("L2", "Acme");
    await settle();
    await clickCell("L2");
    await selectToolbarOption("Data validation", "list");
    await settle();
    await selectToolbarOption("Validation list source", revenueNamedRange.id);
    await settle();

    const namedRangeValidationUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.cells.update")
      .at(-1);
    expect(namedRangeValidationUpdate?.body).toMatchObject({
      tabId,
      edits: [
        {
          row: 1,
          col: 11,
          value: "Acme",
          format: {
            dataValidation: { type: "list", namedRangeId: revenueNamedRange.id },
          },
        },
      ],
    });
    expect(input("L2").getAttribute("list")).toBe("sheet-validation-1-11");
    expect(
      Array.from(document.querySelectorAll("#sheet-validation-1-11 option")).map((option) =>
        option.getAttribute("value"),
      ),
    ).toEqual(expect.arrayContaining(["Customer", "ARR", "Acme", "100"]));
    expect(container.textContent).toContain("List from Revenue_Table");

    await selectToolbarOption("Validation mode", "reject");
    await settle();
    const callsBeforeRejectedNamedRangeEdit = toolCalls.length;
    await editCell("L2", "Denied");
    await settle();
    expect(input("L2").value).toBe("Acme");
    expect(toolCalls).toHaveLength(callsBeforeRejectedNamedRangeEdit);

    await clickButton("Clear validation rule L2");
    await settle();

    await clickButton("Delete named range Revenue_Table");
    await settle();

    const deletedNamedRangeUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(deletedNamedRangeUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        namedRanges: [],
      },
    });
    expect(container.textContent).not.toContain("Revenue_Table");

    await clickCell("A1");
    await shiftSelectCell("B2");

    await selectToolbarOption("Chart type", "line");
    await clickButton("Add chart");
    await settle();

    const lineChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(lineChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          { type: "bar", title: "Chart A1:B2" },
          {
            type: "line",
            title: "Chart A1:B2",
            tabId,
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
          },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Line chart preview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Line point Acme 100"]')).not.toBeNull();

    await selectToolbarOption("Chart type", "pie");
    await clickButton("Add chart");
    await settle();

    const pieChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(pieChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          { type: "bar", title: "Chart A1:B2" },
          { type: "line", title: "Chart A1:B2" },
          {
            type: "pie",
            title: "Chart A1:B2",
            tabId,
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 1 },
          },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Pie chart preview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Pie slice Acme 100"]')).not.toBeNull();

    await editTextInput("Chart title bar Chart A1:B2", "Renewal mix");
    await settle();

    const renamedChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(renamedChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        charts: [
          { type: "bar", title: "Renewal mix" },
          { type: "line", title: "Chart A1:B2" },
          { type: "pie", title: "Chart A1:B2" },
        ],
      },
    });

    await selectToolbarOption("Chart type bar Renewal mix", "line");
    await settle();

    const typeChangedChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(typeChangedChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          { type: "line", title: "Renewal mix" },
          { type: "line", title: "Chart A1:B2" },
          { type: "pie", title: "Chart A1:B2" },
        ],
      },
    });

    await clickButton("Delete line chart Renewal mix");
    await settle();

    const deletedChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(deletedChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          { type: "line", title: "Chart A1:B2" },
          { type: "pie", title: "Chart A1:B2" },
        ],
      },
    });
    expect(container.textContent).not.toContain("Renewal mix");

    await clickCell("A1");
    await shiftSelectCell("C2");
    await clickButton("Use selected range for line chart Chart A1:B2");
    await settle();

    const rerangedChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(rerangedChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        charts: [
          {
            type: "line",
            title: "Chart A1:B2",
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
            labelCol: 0,
            valueCol: 1,
          },
          { type: "pie", title: "Chart A1:B2" },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Chart data Chart A1:B2"]')).not.toBeNull();

    await selectToolbarOption("Chart value column line Chart A1:B2", "2");
    await settle();

    const valueColumnChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(valueColumnChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          {
            type: "line",
            title: "Chart A1:B2",
            labelCol: 0,
            valueCol: 2,
          },
          { type: "pie", title: "Chart A1:B2" },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Line point Acme 100"]')).not.toBeNull();

    await selectToolbarOption("Chart type", "scatter");
    await clickButton("Add chart");
    await settle();

    const scatterChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(scatterChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          { type: "line", title: "Chart A1:B2" },
          { type: "pie", title: "Chart A1:B2" },
          {
            type: "scatter",
            title: "Chart A1:C2",
            tabId,
            range: { startRow: 0, startCol: 0, endRow: 1, endCol: 2 },
          },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Scatter chart preview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Scatter point Acme 100"]')).not.toBeNull();

    await selectToolbarOption("Chart type", "combo");
    await clickButton("Add chart");
    await settle();

    const comboChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(comboChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          { type: "line", title: "Chart A1:B2" },
          { type: "pie", title: "Chart A1:B2" },
          { type: "scatter", title: "Chart A1:C2" },
          { type: "combo", title: "Chart A1:C2" },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Combo chart preview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Combo bar Acme 100"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Combo point Acme 100"]')).not.toBeNull();

    await selectToolbarOption("Chart type", "sparkline");
    await clickButton("Add chart");
    await settle();

    const sparklineChartUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(sparklineChartUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        charts: [
          { type: "line", title: "Chart A1:B2" },
          { type: "pie", title: "Chart A1:B2" },
          { type: "scatter", title: "Chart A1:C2" },
          { type: "combo", title: "Chart A1:C2" },
          { type: "sparkline", title: "Chart A1:C2" },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Sparkline chart preview"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Sparkline point Acme 100"]')).not.toBeNull();

    await editTextarea("Reply to Check ARR", "Adding context");
    await clickButton("Add reply to Check ARR");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.comment.create",
      body: {
        sheetId,
        body: "Adding context",
        parentCommentId: "33333333-3333-4333-8333-333333333333",
        anchor: {
          type: "sheet-range",
          sheetId,
          tabId,
          label: "B2",
          range: { startRow: 1, startCol: 1, endRow: 1, endCol: 1 },
        },
        metadata: { source: "web.native-spreadsheet-editor.comments.reply" },
      },
    });
    expect(container.textContent).toContain("Adding context");

    await clickButton("Edit Check ARR");
    await editTextarea("Edit comment Check ARR", "Check ARR and renewal math");
    await clickButton("Save comment Check ARR");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.comment.update",
      body: {
        commentId: "33333333-3333-4333-8333-333333333333",
        body: "Check ARR and renewal math",
      },
    });
    expect(container.textContent).toContain("Check ARR and renewal math");

    await clickButton("Delete Adding context");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.comment.delete",
      body: { commentId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(container.textContent).not.toContain("Adding context");

    await clickCell("A1");
    await editTextarea("Sheet comment", "Check customer name");
    await clickButton("Add comment");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.comment.create",
      body: {
        sheetId,
        body: "Check customer name",
        anchor: {
          type: "sheet-range",
          sheetId,
          tabId,
          label: "A1",
          range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 },
        },
        metadata: { source: "web.native-spreadsheet-editor.comments" },
      },
    });
    expect(container.textContent).toContain("Check customer name");

    await clickButton("Resolve Check customer name");
    await settle();
    expect(container.textContent).not.toContain("Check customer name");

    await selectToolbarOption("Sheet comment status", "resolved");
    await settle();
    expect(container.textContent).toContain("Check customer name");

    await clickButton("Reopen Check customer name");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.comment.reopen",
      body: { commentId: "44444444-4444-4444-8444-444444444444" },
    });
    expect(container.textContent).not.toContain("Check customer name");

    expect(input("C2").value).toBe("100");
    await focusCell("C2");
    expect(input("C2").value).toBe("=SUM(B2:B2)");
    expect(selectedCellLabel().textContent).toBe("C2");
    expect(formulaBar().value).toBe("=SUM(B2:B2)");
    await blurCell("C2");
    expect(input("C2").value).toBe("100");
    expect(formulaBar().value).toBe("=SUM(B2:B2)");

    await focusCell("B2");
    await shiftSelectCell("C2");
    expect(selectedCellLabel().textContent).toBe("B2:C2");
    expect(selectedRangeSummary().textContent).toBe(
      "2 cells | 2 populated | 2 numbers | Sum 200 | Avg 100 | Min 100 | Max 100",
    );
    expect(copyCell("B2")).toBe("100\t=SUM(B2:B2)");

    await clickCell("A1");
    await shiftSelectCell("C2");
    expect(selectedCellLabel().textContent).toBe("A1:C2");
    expect(selectedRangeSummary().textContent).toBe(
      "6 cells | 5 populated | 2 numbers | Sum 200 | Avg 100 | Min 100 | Max 100",
    );

    await clickCell("B2");
    await keyDownCell("B2", "ArrowRight");
    await settle();
    expect(selectedCellLabel().textContent).toBe("C2");
    expect(document.activeElement).toBe(input("C2"));

    await clickCell("B2");
    await keyDownCell("B2", "ArrowRight", { shiftKey: true });
    await settle();
    expect(selectedCellLabel().textContent).toBe("B2:C2");
    expect(copyCell("B2")).toBe("100\t=SUM(B2:B2)");

    await clickCell("A1");
    await keyDownCell("A1", "ArrowLeft");
    await settle();
    expect(selectedCellLabel().textContent).toBe("A1");
    expect(document.activeElement).toBe(input("A1"));

    await keyDownCell("A1", "PageDown");
    await settle();
    expect(selectedCellLabel().textContent).toBe("A25");
    expect(document.activeElement).toBe(input("A25"));

    await keyDownCell("A25", "PageUp");
    await settle();
    expect(selectedCellLabel().textContent).toBe("A1");
    expect(document.activeElement).toBe(input("A1"));

    await keyDownCell("A1", "PageDown", { shiftKey: true });
    await settle();
    expect(selectedCellLabel().textContent).toBe("A1:A25");
    expect(copyCell("A25")).toContain("Customer");

    await keyDownCell("A25", "PageUp");
    await settle();
    expect(selectedCellLabel().textContent).toBe("A1");

    await keyDownCell("A1", "End");
    await settle();
    expect(selectedCellLabel().textContent).toBe("AX1");
    expect(document.activeElement).toBe(input("AX1"));

    await keyDownCell("AX1", "Home");
    await settle();
    expect(selectedCellLabel().textContent).toBe("A1");
    expect(document.activeElement).toBe(input("A1"));

    await clickCell("L1");
    await keyDownCell("L1", "Tab");
    await settle();
    expect(selectedCellLabel().textContent).toBe("M1");
    expect(document.activeElement).toBe(input("M1"));

    await editCell("M1", "Expansion");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: { tabId, edits: [{ row: 0, col: 12, value: "Expansion" }] },
    });

    await clickCell("M1");
    await editTextarea("Sheet comment", "Check expansion header");
    await clickButton("Add comment");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.comment.create",
      body: {
        sheetId,
        body: "Check expansion header",
        anchor: {
          type: "sheet-range",
          sheetId,
          tabId,
          label: "M1",
          range: { startRow: 0, startCol: 12, endRow: 0, endCol: 12 },
        },
        metadata: { source: "web.native-spreadsheet-editor.comments" },
      },
    });

    // Snap the viewport back to column A via the Home key on the currently
    // selected cell, then verify A1 is in the DOM again.
    await keyDownCell("M1", "Home");
    await settle();
    expect(input("A1").value).toBe("Customer");

    await clickCell("A24");
    await keyDownCell("A24", "Enter");
    await settle();
    expect(selectedCellLabel().textContent).toBe("A25");
    expect(document.activeElement).toBe(input("A25"));

    // PageUp scrolls back to the first viewport window so A1 reappears.
    await keyDownCell("A25", "PageUp");
    await settle();
    expect(input("A1").value).toBe("Customer");

    await clickCell("B2");
    await shiftSelectCell("C2");
    expect(selectedCellLabel().textContent).toBe("B2:C2");

    await clickButton("Italic");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 1, col: 1, value: "100", format: { italic: true } },
          { row: 1, col: 2, value: "=SUM(B2:B2)", format: { italic: true } },
        ],
      },
    });

    await clickCell("B2");
    await clickButton("Bold");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 1, value: "100", format: { italic: true, bold: true } }],
      },
    });

    await clickButton("Underline");
    await settle();
    await clickButton("Strikethrough");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 1, col: 1, value: "100", format: { italic: true, bold: true, underline: true } },
        ],
      },
    });
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 1,
            value: "100",
            format: { italic: true, bold: true, underline: true, strikethrough: true },
          },
        ],
      },
    });
    expect(input("B2").style.textDecoration).toBe("underline line-through");

    await openSidePanelTab("Cells");
    await clickCell("D2");
    await clickButton("Fill yellow");
    await settle();
    await clickButton("Text red");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: "", format: { fillColor: "#fef3c7" } }],
      },
    });
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 3,
            value: "",
            format: { fillColor: "#fef3c7", textColor: "#b91c1c" },
          },
        ],
      },
    });

    await editCell("E2", "1234.5");
    await settle();
    await clickCell("E2");
    await selectToolbarOption("Number format", "currency");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 4, value: "1234.5", format: { numberFormat: "currency" } }],
      },
    });
    await blurCell("E2");
    expect(input("E2").value).toBe("$1,234.50");

    await focusCell("E2");
    expect(input("E2").value).toBe("1234.5");
    await blurCell("E2");
    expect(input("E2").value).toBe("$1,234.50");

    await editCell("I2", "150");
    await settle();
    await clickCell("I2");
    await selectToolbarOption("Conditional format", "greaterThan100");
    await settle();
    expect(input("Conditional threshold").value).toBe("100");
    await editTextInput("Conditional threshold", "125");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 8,
            value: "150",
            format: {
              conditionalFormat: {
                type: "greaterThan100",
                operator: "greaterThan",
                value: 125,
                fillColor: "#dcfce7",
                textColor: "#166534",
              },
            },
          },
        ],
      },
    });
    await clickCell("A1");
    expect(cellShell("I2").style.background).not.toBe("transparent");
    expect(container.textContent).toContain("Conditional rules");
    expect(container.textContent).toContain("Greater than 125");

    await clickButton("Select conditional rule I2");
    expect(selectedCellLabel().textContent).toBe("I2");

    await clickButton("Clear conditional rule I2");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 8, value: "150", format: {} }],
      },
    });

    await clickCell("I2");
    await selectToolbarOption("Conditional format", "customFormula");
    await settle();
    expect(input("Conditional formula").value).toBe("=VALUE>0");

    await editTextInput("Conditional formula", "=B2>=100");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 8,
            value: "150",
            format: {
              conditionalFormat: {
                type: "customFormula",
                formula: "=B2>=100",
                fillColor: "#dbeafe",
                textColor: "#1d4ed8",
              },
            },
          },
        ],
      },
    });
    await clickCell("A1");
    expect(cellShell("I2").style.background).not.toBe("transparent");
    expect(container.textContent).toContain("Formula =B2>=100");

    await editCell("G3", "Needs review before close");
    await settle();
    await clickCell("G3");
    await selectToolbarOption("Conditional format", "textContains");
    await settle();
    expect(input("Conditional text contains").value).toBe("Review");
    await editTextInput("Conditional text contains", "review");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 2,
            col: 6,
            value: "Needs review before close",
            format: {
              conditionalFormat: {
                type: "textContains",
                operator: "containsText",
                text: "review",
                fillColor: "#fef3c7",
                textColor: "#92400e",
              },
            },
          },
        ],
      },
    });
    await clickCell("A1");
    expect(cellShell("G3").style.background).not.toBe("transparent");
    expect(container.textContent).toContain('Text contains "review"');

    await editCell("J2", "2026-05-24");
    await settle();
    await clickCell("J2");
    await selectToolbarOption("Number format", "date");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 9, value: "2026-05-24", format: { numberFormat: "date" } }],
      },
    });
    await blurCell("J2");
    expect(input("J2").value).toBe("May 24, 2026");
    await focusCell("J2");
    expect(input("J2").value).toBe("2026-05-24");
    await blurCell("J2");
    expect(input("J2").value).toBe("May 24, 2026");

    await editCell("K2", "1234.567");
    await settle();
    await clickCell("K2");
    await selectToolbarOption("Number format", "custom");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 10,
            value: "1234.567",
            format: { numberFormat: "custom", customNumberFormat: "#,##0.00" },
          },
        ],
      },
    });
    await blurCell("K2");
    expect(input("K2").value).toBe("1,234.57");

    await clickCell("K2");
    await editTextInput("Custom number format", "$#,##0.00");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 10,
            value: "1234.567",
            format: { numberFormat: "custom", customNumberFormat: "$#,##0.00" },
          },
        ],
      },
    });
    await clickCell("A1");
    expect(input("K2").value).toBe("$1,234.57");

    await editCell("L20", "-1234.567");
    await settle();
    await clickCell("L20");
    await selectToolbarOption("Number format", "custom");
    await settle();
    await editTextInput("Custom number format", "$#,##0.00;[Red]($#,##0.00);$0.00;@");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 19,
            col: 11,
            value: "-1234.567",
            format: {
              numberFormat: "custom",
              customNumberFormat: "$#,##0.00;[Red]($#,##0.00);$0.00;@",
            },
          },
        ],
      },
    });
    await clickCell("A1");
    expect(input("L20").value).toBe("($1,234.57)");

    await editCell("L21", "0");
    await settle();
    await clickCell("L21");
    await selectToolbarOption("Number format", "custom");
    await settle();
    await editTextInput("Custom number format", "$#,##0.00;[Red]($#,##0.00);$0.00;@");
    await clickCell("A1");
    expect(input("L21").value).toBe("$0.00");

    await editCell("L22", "Draft");
    await settle();
    await clickCell("L22");
    await selectToolbarOption("Number format", "custom");
    await settle();
    await editTextInput("Custom number format", "#,##0.00;[Red](#,##0.00);-;@");
    await clickCell("A1");
    expect(input("L22").value).toBe("Draft");

    await clickCell("F4");
    await shiftSelectCell("G5");
    await clickButton("Border outer");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 3, col: 5, value: "", format: { borders: { top: true, left: true } } },
          { row: 3, col: 6, value: "", format: { borders: { top: true, right: true } } },
          { row: 4, col: 5, value: "", format: { borders: { bottom: true, left: true } } },
          { row: 4, col: 6, value: "", format: { borders: { right: true, bottom: true } } },
        ],
      },
    });
    expect(cellShell("F4").style.boxShadow).toContain("inset");

    await clickButton("Border none");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 3, col: 5, value: "", format: {} },
          { row: 3, col: 6, value: "", format: {} },
          { row: 4, col: 5, value: "", format: {} },
          { row: 4, col: 6, value: "", format: {} },
        ],
      },
    });

    await editCell("H2", "not-a-number");
    await settle();
    await clickCell("H2");
    await selectToolbarOption("Data validation", "number");
    await settle();
    await blurCell("H2");

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 7,
            value: "not-a-number",
            format: { dataValidation: { type: "number" } },
          },
        ],
      },
    });
    expect(input("H2").title).toBe("Expected a number.");
    expect(cellShell("H2").style.boxShadow).toContain("#dc2626");
    expect(container.textContent).toContain("Validation rules");
    expect(container.textContent).toContain("Number only");
    expect(select("Validation rule mode H2").value).toBe("warn");

    await editCell("H2", "123");
    await settle();
    expect(input("H2").title).toBe("");

    await clickCell("H2");
    await selectToolbarOption("Validation mode", "reject");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 7,
            value: "123",
            format: { dataValidation: { type: "number", mode: "reject" } },
          },
        ],
      },
    });
    expect(select("Validation rule mode H2").value).toBe("reject");

    await clickButton("Select validation rule H2");
    expect(selectedCellLabel().textContent).toBe("H2");

    const callsBeforeRejectedEdit = toolCalls.length;
    await editCell("H2", "not-a-number");
    await settle();
    expect(input("H2").value).toBe("123");
    expect(toolCalls).toHaveLength(callsBeforeRejectedEdit);

    await editFormulaBar("also-not-a-number");
    await settle();
    expect(input("H2").value).toBe("123");
    expect(toolCalls).toHaveLength(callsBeforeRejectedEdit);

    await pasteCell("H2", "still-not-a-number");
    await settle();
    expect(input("H2").value).toBe("123");
    expect(toolCalls).toHaveLength(callsBeforeRejectedEdit);

    await editCell("L2", "Pending");
    await settle();
    await clickCell("L2");
    await selectToolbarOption("Data validation", "list");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 11,
            value: "Pending",
            format: {
              dataValidation: { type: "list", choices: ["Approved", "Pending", "Blocked"] },
            },
          },
        ],
      },
    });

    await editTextInput("Validation choices", "Approved, Pending, Escalated");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 1,
            col: 11,
            value: "Pending",
            format: {
              dataValidation: { type: "list", choices: ["Approved", "Pending", "Escalated"] },
            },
          },
        ],
      },
    });
    expect(input("L2").getAttribute("list")).toBe("sheet-validation-1-11");
    expect(
      Array.from(document.querySelectorAll("#sheet-validation-1-11 option")).map((option) =>
        option.getAttribute("value"),
      ),
    ).toEqual(["Approved", "Pending", "Escalated"]);
    expect(container.textContent).toContain("L2");
    expect(container.textContent).toContain("List: Approved, Pending, Escalated");

    await editCell("L2", "Denied");
    await settle();
    await blurCell("L2");
    expect(input("L2").title).toBe("Expected one of: Approved, Pending, Escalated.");

    await clickButton("Clear validation rule L2");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 11, value: "Denied", format: {} }],
      },
    });

    await pasteCell("A3", "North\t10\nSouth\t20");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 0, value: "North" },
          { row: 2, col: 1, value: "10" },
          { row: 3, col: 0, value: "South" },
          { row: 3, col: 1, value: "20" },
        ],
      },
    });

    await focusCell("C2");
    await editFormulaBar("=B2*3");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: { tabId, edits: [{ row: 1, col: 2, value: "=B2*3" }] },
    });

    await editCell("D2", "=B2*2");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: { tabId, edits: [{ row: 1, col: 3, value: "=B2*2" }] },
    });

    await clickCell("B2");
    await changeCell("B2", "101");
    await keyDownCell("B2", "Enter");
    await settle();

    expect(selectedCellLabel().textContent).toBe("B3");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: { tabId, edits: [{ row: 1, col: 1, value: "101" }] },
    });
  }, 45_000);

  it("validates URL, localized date, and custom formula catalog rules", async () => {
    render();
    await settle();
    await openSidePanelTab("Cells");

    await editCell("A3", "not-a-url");
    await settle();
    await clickCell("A3");
    await selectToolbarOption("Data validation", "url");
    await settle();
    expect(input("A3").title).toBe("Expected a URL.");
    expect(container.textContent).toContain("URL only");
    await editCell("A3", "https://example.test/status");
    await settle();
    expect(input("A3").title).toBe("");

    await editCell("B3", "2026-02-31");
    await settle();
    await clickCell("B3");
    await selectToolbarOption("Data validation", "date");
    await settle();
    expect(input("B3").title).toBe("Expected a date in yyyy-mm-dd format.");
    await openSidePanelTab("Cells");
    expect(container.textContent).toContain("Date: yyyy-mm-dd");
    await editCell("B3", "2026-02-28");
    await settle();
    expect(input("B3").title).toBe("");
    await selectToolbarOption("Validation date format", "en-GB");
    await settle();
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 2,
            col: 1,
            value: "2026-02-28",
            format: { dataValidation: { type: "date", locale: "en-GB" } },
          },
        ],
      },
    });
    expect(container.textContent).toContain("Date: d/m/yyyy");
    await editCell("B3", "05/31/2026");
    await settle();
    expect(input("B3").title).toBe("Expected a date in d/m/yyyy format.");
    await editCell("B3", "31/05/2026");
    await settle();
    expect(input("B3").title).toBe("");
    await selectToolbarOption("Validation mode", "reject");
    await settle();
    const callsBeforeRejectedDateEdit = toolCalls.length;
    await editCell("B3", "05/31/2026");
    await settle();
    expect(input("B3").value).toBe("31/05/2026");
    expect(toolCalls).toHaveLength(callsBeforeRejectedDateEdit);

    await editCell("D3", "50");
    await settle();
    await editCell("C3", "40");
    await settle();
    await clickCell("C3");
    await selectToolbarOption("Data validation", "customFormula");
    await settle();
    await editTextInput("Validation formula", "=VALUE>D3");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          {
            row: 2,
            col: 2,
            value: "40",
            format: { dataValidation: { type: "customFormula", formula: "=VALUE>D3" } },
          },
        ],
      },
    });
    expect(input("C3").title).toBe("Expected a value matching the validation formula.");
    expect(container.textContent).toContain("Formula =VALUE>D3");

    await editCell("C3", "60");
    await settle();
    expect(input("C3").title).toBe("");

    await clickCell("C3");
    await selectToolbarOption("Validation mode", "reject");
    await settle();
    const callsBeforeRejectedFormulaEdit = toolCalls.length;
    await editCell("C3", "45");
    await settle();
    expect(input("C3").value).toBe("60");
    expect(toolCalls).toHaveLength(callsBeforeRejectedFormulaEdit);
  });

  it("undoes and redoes committed cell edits from the top ribbon", async () => {
    render();
    await settle();

    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(true);

    await focusCell("B2");
    await changeCell("B2", "250");
    await blurCell("B2");
    await settle();

    expect(input("B2").value).toBe("250");
    expect(button("Undo").disabled).toBe(false);
    expect(button("Redo").disabled).toBe(true);

    await clickButton("Undo");
    await settle();

    expect(input("B2").value).toBe("100");
    expect(button("Undo").disabled).toBe(true);
    expect(button("Redo").disabled).toBe(false);
    expect(
      toolCalls.filter((call) => call.url === "/api/tools/sheets.cells.update").at(-1)?.body,
    ).toMatchObject({
      tabId,
      edits: [{ row: 1, col: 1, value: "100" }],
    });

    await clickButton("Redo");
    await settle();

    expect(input("B2").value).toBe("250");
    expect(button("Undo").disabled).toBe(false);
    expect(button("Redo").disabled).toBe(true);
    expect(
      toolCalls.filter((call) => call.url === "/api/tools/sheets.cells.update").at(-1)?.body,
    ).toMatchObject({
      tabId,
      edits: [{ row: 1, col: 1, value: "250" }],
    });
  });

  it("copy-fills selected cells with the fill handle after drag preview", async () => {
    render();
    await settle();

    await clickCell("B2");
    setSheetGridRect();
    await dragFillHandle({ x: 240, y: 96 }, { x: 190, y: 145 });

    expect(container.querySelector('[aria-label="Fill preview range"]')).toBeNull();
    expect(selectedCellLabel().textContent).toBe("B2:B4");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 1, value: "100", format: {} },
          { row: 3, col: 1, value: "100", format: {} },
        ],
      },
    });

    await clickCell("B2");
    await shiftSelectCell("C2");
    setSheetGridRect();
    await dragFillHandle({ x: 336, y: 96 }, { x: 480, y: 80 });

    expect(selectedCellLabel().textContent).toBe("B2:E2");
    expect(copyCell("B2")).toBe("100\t=SUM(B2:B2)\t100\t=SUM(D2:D2)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 1, col: 3, value: "100", format: {} },
          { row: 1, col: 4, value: "=SUM(D2:D2)", format: {} },
        ],
      },
    });

    await clickCell("C2");
    setSheetGridRect();
    await dragFillHandle({ x: 336, y: 96 }, { x: 288, y: 160 });

    expect(selectedCellLabel().textContent).toBe("C2:C5");
    expect(copyCell("C2")).toBe("=SUM(B2:B2)\n=SUM(B3:B3)\n=SUM(B4:B4)\n=SUM(B5:B5)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 2, value: "=SUM(B3:B3)", format: {} },
          { row: 3, col: 2, value: "=SUM(B4:B4)", format: {} },
          { row: 4, col: 2, value: "=SUM(B5:B5)", format: {} },
        ],
      },
    });
  });

  it("series-fills numbers and ISO dates with the fill handle", async () => {
    cells = [
      cell(0, 0, "1"),
      cell(0, 1, "2"),
      cell(1, 0, "2026-01-01"),
      cell(1, 1, "2026-01-03"),
      cell(2, 0, "01/01/2026"),
      cell(2, 1, "01/03/2026"),
      cell(3, 0, "Jan 1, 2026"),
      cell(3, 1, "Jan 8, 2026"),
    ];
    render();
    await settle();

    await clickCell("A1");
    await shiftSelectCell("B1");
    setSheetGridRect();
    await dragFillHandle({ x: 240, y: 64 }, { x: 384, y: 48 });

    expect(selectedCellLabel().textContent).toBe("A1:D1");
    expect(copyCell("A1")).toBe("1\t2\t3\t4");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 0, col: 2, value: "3", format: {} },
          { row: 0, col: 3, value: "4", format: {} },
        ],
      },
    });

    await clickCell("A2");
    await shiftSelectCell("B2");
    setSheetGridRect();
    await dragFillHandle({ x: 240, y: 96 }, { x: 384, y: 80 });

    expect(selectedCellLabel().textContent).toBe("A2:D2");
    expect(copyCell("A2")).toBe("2026-01-01\t2026-01-03\t2026-01-05\t2026-01-07");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 1, col: 2, value: "2026-01-05", format: {} },
          { row: 1, col: 3, value: "2026-01-07", format: {} },
        ],
      },
    });

    await clickCell("A3");
    await shiftSelectCell("B3");
    setSheetGridRect();
    await dragFillHandle({ x: 240, y: 128 }, { x: 384, y: 112 });

    expect(selectedCellLabel().textContent).toBe("A3:D3");
    expect(copyCell("A3")).toBe("01/01/2026\t01/03/2026\t01/05/2026\t01/07/2026");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 2, value: "01/05/2026", format: {} },
          { row: 2, col: 3, value: "01/07/2026", format: {} },
        ],
      },
    });

    await clickCell("A4");
    await shiftSelectCell("B4");
    setSheetGridRect();
    await dragFillHandle({ x: 240, y: 160 }, { x: 384, y: 144 });

    expect(selectedCellLabel().textContent).toBe("A4:D4");
    expect(copyCell("A4")).toBe("Jan 1, 2026\tJan 8, 2026\tJan 15, 2026\tJan 22, 2026");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 3, col: 2, value: "Jan 15, 2026", format: {} },
          { row: 3, col: 3, value: "Jan 22, 2026", format: {} },
        ],
      },
    });
  });

  it("autoscrolls the fill handle beyond the visible grid edge", async () => {
    render();
    await settle();

    await clickCell("B2");
    await shiftSelectCell("C2");
    setSheetGridRect();
    await dragFillHandle({ x: 336, y: 96 }, { x: 1248, y: 96 });

    expect(selectedCellLabel().textContent).toBe("B2:M2");
    const fillUpdate = toolCalls.find((call) => {
      if (call.url !== "/api/tools/sheets.cells.update") {
        return false;
      }
      const body = call.body as { readonly edits?: readonly unknown[] };
      return body.edits?.length === 10;
    });
    const fillBody = fillUpdate?.body as
      | {
          readonly tabId?: string;
          readonly edits?: readonly {
            readonly row: number;
            readonly col: number;
            readonly value: string;
            readonly format?: Record<string, unknown>;
          }[];
        }
      | undefined;
    expect(fillBody?.tabId).toBe(tabId);
    expect(fillBody?.edits).toContainEqual({ row: 1, col: 3, value: "100", format: {} });
    expect(fillBody?.edits).toContainEqual({
      row: 1,
      col: 12,
      value: "=SUM(L2:L2)",
      format: {},
    });

    await clickCell("B2");
    setSheetGridRect();
    await dragFillHandle({ x: 144, y: 96 }, { x: 96, y: 808 });

    expect(selectedCellLabel().textContent).toBe("B2:B25");
    const verticalFillUpdate = toolCalls.find((call) => {
      if (call.url !== "/api/tools/sheets.cells.update") {
        return false;
      }
      const body = call.body as { readonly edits?: readonly unknown[] };
      return body.edits?.length === 23;
    });
    const verticalFillBody = verticalFillUpdate?.body as
      | {
          readonly tabId?: string;
          readonly edits?: readonly {
            readonly row: number;
            readonly col: number;
            readonly value: string;
            readonly format?: Record<string, unknown>;
          }[];
        }
      | undefined;
    expect(verticalFillBody?.tabId).toBe(tabId);
    expect(verticalFillBody?.edits).toContainEqual({ row: 2, col: 1, value: "100", format: {} });
    expect(verticalFillBody?.edits).toContainEqual({ row: 24, col: 1, value: "100", format: {} });
  });

  it("preserves native cell formatting when copying and pasting within Sheets", async () => {
    const richFormat = {
      bold: true,
      italic: true,
      align: "right",
      fillColor: "#fef3c7",
      textColor: "#1d4ed8",
      borders: { top: true, bottom: true },
      numberFormat: "currency",
      customNumberFormat: "",
      dataValidation: { type: "number", mode: "reject" },
      conditionalFormat: {
        type: "greaterThan100",
        operator: "greaterThan",
        value: 100,
        fillColor: "#dcfce7",
        textColor: "#166534",
      },
    };
    cells = [cell(0, 0, "42", richFormat), cell(0, 1, "=A1*2", { numberFormat: "percent" })];
    render();
    await settle();

    await clickCell("A1");
    await shiftSelectCell("B1");
    const clipboard = copyCellClipboard("A1");

    expect(clipboard.getData("text/plain")).toBe("42\t=A1*2");

    await pasteCellClipboard("A3", clipboard);

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 0, value: "42", format: richFormat },
          { row: 2, col: 1, value: "=A1*2", format: { numberFormat: "percent" } },
        ],
      },
    });
  });

  it("copies, pastes, and cuts selected cells from the Edit menu", async () => {
    const richFormat = {
      bold: true,
      fillColor: "#fef3c7",
      textColor: "#1d4ed8",
      numberFormat: "currency",
    };
    cells = [cell(0, 0, "42", richFormat), cell(0, 1, "=A1*2", { numberFormat: "percent" })];
    render();
    await settle();

    await clickCell("A1");
    await shiftSelectCell("B1");
    clickAppMenu("edit");
    clickOpenMenuItem("Copy");
    await settle();

    expect(clipboardWriteText).toHaveBeenCalledWith("42\t=A1*2");

    await clickCell("A3");
    clickAppMenu("edit");
    clickOpenMenuItem("Paste");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 0, value: "42", format: richFormat },
          { row: 2, col: 1, value: "=A1*2", format: { numberFormat: "percent" } },
        ],
      },
    });
    expect(input("A3").value).toBe("42");
    expect(input("B3").value).toBe("=A1*2");

    clickAppMenu("edit");
    clickOpenMenuItem("Cut");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 2, col: 0, value: "", format: {} },
          { row: 2, col: 1, value: "", format: {} },
        ],
      },
    });
    expect(input("A3").value).toBe("");
    expect(input("B3").value).toBe("");

    await clickCell("A4");
    clickAppMenu("edit");
    clickOpenMenuItem("Paste");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [
          { row: 3, col: 0, value: "42", format: richFormat },
          { row: 3, col: 1, value: "=A1*2", format: { numberFormat: "percent" } },
        ],
      },
    });
    expect(input("A4").value).toBe("42");
    expect(input("B4").value).toBe("=A1*2");
  });

  it("selects visible rectangular ranges by dragging across cells", async () => {
    render();
    await settle();
    const updatesBefore = toolCalls.filter(
      (call) => call.url === "/api/tools/sheets.cells.update",
    ).length;

    setSheetGridRect();
    await dragSelectCells("B2", "D4", { x: 192, y: 80 }, { x: 384, y: 144 });

    expect(selectedCellLabel().textContent).toBe("B2:D4");
    expect(copyCell("B2")).toBe("100\t=SUM(B2:B2)\t\n\t\t\n\t\t");
    expect(toolCalls.filter((call) => call.url === "/api/tools/sheets.cells.update")).toHaveLength(
      updatesBefore,
    );

    await dragSelectCells("C2", "B2", { x: 288, y: 80 }, { x: 192, y: 80 });

    expect(selectedCellLabel().textContent).toBe("B2:C2");
    expect(copyCell("B2")).toBe("100\t=SUM(B2:B2)");
    expect(input("C2").value).toBe("100");
    expect(toolCalls.filter((call) => call.url === "/api/tools/sheets.cells.update")).toHaveLength(
      updatesBefore,
    );
  });

  it("filters pivot table previews with a metadata-backed slicer", async () => {
    cells = [
      cell(0, 0, "Customer"),
      cell(0, 1, "ARR"),
      cell(0, 2, "Stage"),
      cell(1, 0, "Acme"),
      cell(1, 1, "100"),
      cell(1, 2, "Active"),
      cell(2, 0, "Acme"),
      cell(2, 1, "50"),
      cell(2, 2, "Churned"),
      cell(3, 0, "Beta"),
      cell(3, 1, "200"),
      cell(3, 2, "Active"),
      cell(4, 0, "Gamma"),
      cell(4, 1, "40"),
      cell(4, 2, "Churned"),
    ];
    sheetMetadata = {
      customKey: { keep: true },
      pivotTables: [
        {
          id: "pivot-1",
          tabId,
          title: "ARR Pivot",
          rowFieldCol: 0,
          valueFieldCol: 1,
          aggregation: "sum",
          range: { startRow: 0, startCol: 0, endRow: 4, endCol: 2 },
        },
      ],
    };

    render();
    await settle();
    await openSidePanelTab("Pivots");
    await settle();

    expect(container.querySelector('[aria-label="Acme pivot 150"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Beta pivot 200"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Gamma pivot 40"]')).not.toBeNull();

    await selectToolbarOption("Pivot slicer column ARR Pivot", "2");
    await settle();
    await editTextInput("Pivot slicer value ARR Pivot", "Active");
    await settle();

    const slicerUpdate = toolCalls.filter((call) => call.url === "/api/tools/sheets.update").at(-1);
    expect(slicerUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        pivotTables: [
          {
            title: "ARR Pivot",
            slicer: { column: 2, operator: "contains", value: "Active" },
          },
        ],
      },
    });
    expect(container.querySelector('[aria-label="Acme pivot 100"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Beta pivot 200"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Gamma pivot 40"]')).toBeNull();
    expect(container.querySelector('[aria-label="Acme pivot 150"]')).toBeNull();

    await selectToolbarOption("Pivot aggregation ARR Pivot", "count");
    await settle();

    expect(container.querySelector('[aria-label="Acme pivot 1"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Beta pivot 1"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Gamma pivot 1"]')).toBeNull();
  });

  it("connects to Sheets sync, sends value-only edits, and applies remote operations", async () => {
    render();
    await settle();

    const socket = MockWebSocket.instances.at(-1);
    expect(socket?.url).toBe(`ws://localhost:3000/sync/sheets/${sheetId}?protocol=sheets-ot`);

    await act(async () => {
      socket?.open();
      socket?.receive({
        type: "ready",
        protocol: "sheets-ot",
        sheetId,
        revision: 4,
        tabs: [{ id: tabId, name: "Pipeline", position: 0 }],
      });
      await Promise.resolve();
    });
    await settle();

    expect(container.querySelector('[role="status"][aria-label="Live"]')).not.toBeNull();

    await editCell("B2", "175");
    await settle();

    expect(socket?.sent.at(-1)).toEqual({
      type: "operation",
      tabId,
      operation: {
        id: expect.any(String) as string,
        baseRevision: 4,
        changes: [{ kind: "set-cell", row: 1, col: 1, value: "175" }],
      },
    });

    await clickButton("Insert row above");
    expect(socket?.sent.at(-1)).toEqual({
      type: "operation",
      tabId,
      operation: {
        id: expect.any(String) as string,
        baseRevision: 4,
        changes: [{ kind: "insert-rows", index: 1, count: 1 }],
      },
    });
    expect(selectedCellLabel().textContent).toBe("B2");

    await clickButton("Delete row");
    expect(socket?.sent.at(-1)).toEqual({
      type: "operation",
      tabId,
      operation: {
        id: expect.any(String) as string,
        baseRevision: 4,
        changes: [{ kind: "delete-rows", index: 1, count: 1 }],
      },
    });
    expect(selectedCellLabel().textContent).toBe("B2");

    await clickButton("Insert column left");
    expect(socket?.sent.at(-1)).toEqual({
      type: "operation",
      tabId,
      operation: {
        id: expect.any(String) as string,
        baseRevision: 4,
        changes: [{ kind: "insert-columns", index: 1, count: 1 }],
      },
    });
    expect(selectedCellLabel().textContent).toBe("B2");

    await clickButton("Delete column");
    expect(socket?.sent.at(-1)).toEqual({
      type: "operation",
      tabId,
      operation: {
        id: expect.any(String) as string,
        baseRevision: 4,
        changes: [{ kind: "delete-columns", index: 1, count: 1 }],
      },
    });
    expect(selectedCellLabel().textContent).toBe("B2");

    cells = [
      ...cells.filter((candidate) => candidate.row !== 1 || candidate.col !== 0),
      cell(1, 0, "Globex"),
    ];
    await act(async () => {
      socket?.receive({
        type: "operation",
        protocol: "sheets-ot",
        sheetId,
        tabId,
        revision: 5,
        operation: {
          id: "op-remote",
          baseRevision: 4,
          changes: [{ kind: "set-cell", row: 1, col: 0, value: "Globex" }],
        },
      });
      await Promise.resolve();
    });
    await settle();

    expect(input("A2").value).toBe("Globex");
    expect(toolCalls.some((call) => call.url === "/api/tools/sheets.cells.update")).toBe(false);
  });

  it("rebases active-grid formulas when remote structural operations arrive", async () => {
    render();
    await settle();

    const socket = MockWebSocket.instances.at(-1);
    let sheetGetCountBefore = 0;
    await act(async () => {
      socket?.open();
      socket?.receive({
        type: "ready",
        protocol: "sheets-ot",
        sheetId,
        revision: 4,
        tabs: [{ id: tabId, name: "Pipeline", position: 0 }],
      });
      cells = [
        cell(1, 0, "Customer"),
        cell(1, 1, "ARR"),
        cell(2, 0, "Acme"),
        cell(2, 1, "100"),
        {
          ...cell(2, 2, "=SUM(B3:B3)"),
          formula: "SUM(B3:B3)",
          calcValue: "100",
          dependencies: ["B3"],
          formulaError: null,
        },
      ];
      sheetGetCountBefore = toolCalls.filter((call) => call.url === "/api/tools/sheets.get").length;
      socket?.receive({
        type: "operation",
        protocol: "sheets-ot",
        sheetId,
        tabId,
        revision: 5,
        operation: {
          id: "op-remote-structure",
          baseRevision: 4,
          changes: [{ kind: "insert-rows", index: 0, count: 1 }],
        },
      });
      await Promise.resolve();
    });
    await settle();

    await focusCell("C3");
    expect(input("C3").value).toBe("=SUM(B3:B3)");
    expect(toolCalls.filter((call) => call.url === "/api/tools/sheets.get").length).toBeGreaterThan(
      sheetGetCountBefore,
    );
  });

  it("protects selected ranges and blocks protected cell edits client-side", async () => {
    render();
    await settle();

    await clickCell("B2");
    await shiftSelectCell("C2");
    await openSidePanelTab("Permissions");
    await clickButton("Protect selected range");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/sheets.update").at(-1)?.body,
    ).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        protectedRanges: [
          {
            label: "B2:C2",
            tabId,
            mode: "block",
            range: { startRow: 1, startCol: 1, endRow: 1, endCol: 2 },
          },
        ],
      },
    });
    expect(input("B2").title).toBe("Protected range: B2:C2");
    expect(cellShell("B2").style.boxShadow).toContain("#64748b");
    expect(formulaBar().disabled).toBe(true);
    expect(button("Sort range A to Z").disabled).toBe(true);
    expect(button("Sort range Z to A").disabled).toBe(true);
    const protectedRangeTable = container.querySelector('[aria-label="Protected range table"]');
    expect(protectedRangeTable?.textContent).toContain("B2:C2");
    expect(protectedRangeTable?.textContent).toContain("Pipeline");
    expect(protectedRangeTable?.textContent).toContain("2");
    expect(protectedRangeTable?.textContent).toContain("Block edits");

    await clickCell("A1");
    expect(formulaBar().disabled).toBe(false);
    await clickButton("Select protected range B2:C2");
    expect(formulaBar().disabled).toBe(true);

    const callsBeforeEdit = toolCalls.length;
    await editCell("B2", "999");
    await settle();

    expect(toolCalls).toHaveLength(callsBeforeEdit);

    await selectToolbarOption("Protected range mode B2:C2", "warn");
    await settle();
    expect(
      toolCalls.filter((call) => call.url === "/api/tools/sheets.update").at(-1)?.body,
    ).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        protectedRanges: [
          {
            label: "B2:C2",
            tabId,
            mode: "warn",
            range: { startRow: 1, startCol: 1, endRow: 1, endCol: 2 },
          },
        ],
      },
    });
    expect(input("B2").title).toBe("Warning range: B2:C2");
    expect(cellShell("B2").style.boxShadow).toContain("#f59e0b");
    expect(input("B2").readOnly).toBe(false);
    expect(formulaBar().disabled).toBe(false);

    await clickCell("B2");
    await changeCell("B2", "1001");
    await keyDownCell("B2", "Enter");
    await settle();
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: { tabId, edits: [{ row: 1, col: 1, value: "1001" }] },
    });

    await clickButton("Remove protected range B2:C2");
    await settle();
    expect(
      toolCalls.filter((call) => call.url === "/api/tools/sheets.update").at(-1)?.body,
    ).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        protectedRanges: [],
      },
    });

    await clickCell("B2");
    await editCell("B2", "1000");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: { tabId, edits: [{ row: 1, col: 1, value: "1000" }] },
    });
  });

  it("inserts QUERY helper formulas next to the selected range", async () => {
    render();
    await settle();
    await openSidePanelTab("AI");

    await clickCell("B2");
    await shiftSelectCell("C2");
    await selectToolbarOption("Formula helper", "query-count");
    await settle();

    expect(selectedCellLabel().textContent).toBe("D2");
    expect(formulaBar().value).toBe('=QUERY(B2:C2, "select count(*)", 0)');
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: '=QUERY(B2:C2, "select count(*)", 0)' }],
      },
    });

    await clickCell("B2");
    await shiftSelectCell("C2");
    await selectToolbarOption("Formula helper", "query-top");
    await settle();

    expect(selectedCellLabel().textContent).toBe("D2");
    expect(formulaBar().value).toBe('=QUERY(B2:C2, "select B order by B desc limit 1", 0)');
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: '=QUERY(B2:C2, "select B order by B desc limit 1", 0)' }],
      },
    });

    await clickCell("B2");
    await shiftSelectCell("C2");
    await selectToolbarOption("Formula helper", "average");
    await settle();

    expect(selectedCellLabel().textContent).toBe("D2");
    expect(formulaBar().value).toBe("=AVERAGE(B2:C2)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: "=AVERAGE(B2:C2)" }],
      },
    });

    await clickCell("B2");
    await shiftSelectCell("C2");
    await selectToolbarOption("Formula helper", "counta");
    await settle();

    expect(selectedCellLabel().textContent).toBe("D2");
    expect(formulaBar().value).toBe("=COUNTA(B2:C2)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: "=COUNTA(B2:C2)" }],
      },
    });

    await clickCell("B2");
    await shiftSelectCell("C2");
    await selectToolbarOption("Formula helper", "sumif-equals");
    await settle();

    expect(selectedCellLabel().textContent).toBe("D2");
    expect(formulaBar().value).toBe("=SUMIF(B2:C2, B2)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: "=SUMIF(B2:C2, B2)" }],
      },
    });

    await clickCell("B2");
    await shiftSelectCell("C2");
    await selectToolbarOption("Formula helper", "countif-equals");
    await settle();

    expect(selectedCellLabel().textContent).toBe("D2");
    expect(formulaBar().value).toBe("=COUNTIF(B2:C2, B2)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: "=COUNTIF(B2:C2, B2)" }],
      },
    });

    await clickCell("B2");
    await shiftSelectCell("C2");
    await selectToolbarOption("Formula helper", "averageif-equals");
    await settle();

    expect(selectedCellLabel().textContent).toBe("D2");
    expect(formulaBar().value).toBe("=AVERAGEIF(B2:C2, B2)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 3, value: "=AVERAGEIF(B2:C2, B2)" }],
      },
    });

    await editCell("F2", "Renewal risk");
    await settle();
    await clickCell("F2");
    await selectToolbarOption("Formula helper", "helix-classify");
    await settle();

    expect(selectedCellLabel().textContent).toBe("G2");
    expect(formulaBar().value).toBe('=HELIX.AI.CLASSIFY(F2, "Risk, Expansion, Renewal")');
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 1, col: 6, value: '=HELIX.AI.CLASSIFY(F2, "Risk, Expansion, Renewal")' }],
      },
    });
  });

  it("analyzes a selected range and inserts a local formula suggestion", async () => {
    render();
    await settle();

    await clickCell("A1");
    await shiftSelectCell("B2");
    await openSidePanelTab("AI");
    await clickButton("Analyze selected range");
    await settle();

    expect(container.textContent).toContain("2 x 2 range, 4 populated cells");
    expect(container.textContent).toContain("1 numeric column detected");

    await clickButton("Insert SUM for ARR");
    await settle();

    expect(selectedCellLabel().textContent).toBe("B3");
    expect(formulaBar().value).toBe("=SUM(B2:B2)");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.cells.update",
      body: {
        tabId,
        edits: [{ row: 2, col: 1, value: "=SUM(B2:B2)" }],
      },
    });
  });

  it("sorts the selected range by the first selected column while preserving row formats", async () => {
    cells = [
      ...cells,
      cell(2, 0, "Zeta", { fillColor: "#fef3c7" }),
      cell(2, 1, "10", { fillColor: "#fef3c7" }),
      cell(3, 0, "Alpha"),
      cell(3, 1, "10"),
    ];
    render();
    await settle();

    await clickCell("A3");
    await shiftSelectCell("B4");
    await openSidePanelTab("Filters");
    await clickButton("Save A-Z filter view");
    await settle();

    const filterViewUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(filterViewUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        filterViews: [
          {
            name: "Filter_A3_B4_A_Z",
            tabId,
            sortDirection: "asc",
            sortColumn: 0,
            range: { startRow: 2, startCol: 0, endRow: 3, endCol: 1 },
          },
        ],
      },
    });
    expect(input("Filter view Filter_A3_B4_A_Z").value).toBe("Filter_A3_B4_A_Z");

    await editTextInput("Filter view Filter_A3_B4_A_Z", "Customer_Filter");
    await settle();

    const renamedFilterViewUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(renamedFilterViewUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        filterViews: [{ name: "Customer_Filter", sortDirection: "asc" }],
      },
    });

    await selectToolbarOption("Filter view sort Customer_Filter", "desc");
    await settle();

    const directionFilterViewUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(directionFilterViewUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        filterViews: [{ name: "Customer_Filter", sortDirection: "desc" }],
      },
    });

    await selectToolbarOption("Filter view sort column Customer_Filter", "1");
    await settle();

    const sortColumnFilterViewUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(sortColumnFilterViewUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        filterViews: [
          { name: "Customer_Filter", sortDirection: "desc", sortColumn: 1, sortKeys: [1, 0] },
        ],
      },
    });

    await selectToolbarOption("Filter view secondary sort column Customer_Filter", "0");
    await settle();

    const secondarySortFilterViewUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(secondarySortFilterViewUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        filterViews: [
          { name: "Customer_Filter", sortDirection: "desc", sortColumn: 1, sortKeys: [1, 0] },
        ],
      },
    });

    await editTextInput("Filter view predicate 1 contains Customer_Filter", "a");
    await clickButton("Add filter view predicate Customer_Filter");
    await settle();
    await selectToolbarOption("Filter view predicate 2 column Customer_Filter", "1");
    await settle();
    await selectToolbarOption("Filter view predicate 2 operator Customer_Filter", "greaterThan");
    await settle();
    await editTextInput("Filter view predicate 2 greater than Customer_Filter", "9");
    await clickButton("Add filter view predicate Customer_Filter");
    await settle();
    await selectToolbarOption("Filter view predicate 3 operator Customer_Filter", "notEmpty");
    await settle();

    const predicateFilterViewUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(predicateFilterViewUpdate?.body).toMatchObject({
      sheetId,
      metadata: {
        customKey: { keep: true },
        filterViews: [
          {
            name: "Customer_Filter",
            sortDirection: "desc",
            sortColumn: 1,
            sortKeys: [1, 0],
            predicate: { column: 0, operator: "contains", value: "a" },
            predicates: [
              { column: 0, operator: "contains", value: "a" },
              { column: 1, operator: "greaterThan", value: "9" },
              { column: 0, operator: "notEmpty", value: "" },
            ],
          },
        ],
      },
    });
    const filterViewList = container.querySelector('[aria-label="Saved filter view list"]');
    expect(filterViewList?.textContent).toContain("Sort B, A Z-A");
    expect(filterViewList?.textContent).toContain('A contains "a"');
    expect(filterViewList?.textContent).toContain("B > 9");
    expect(filterViewList?.textContent).toContain("A not empty");

    const cellUpdateCountBeforeApply = toolCalls.filter(
      (call) => call.url === "/api/tools/sheets.cells.update",
    ).length;
    await clickButton("Apply filter view Customer_Filter");
    await settle();

    expect(toolCalls.filter((call) => call.url === "/api/tools/sheets.cells.update")).toHaveLength(
      cellUpdateCountBeforeApply,
    );
    expect(input("A3").value).toBe("Zeta");
    expect(input("A4").value).toBe("Alpha");

    await clickButton("Sort range A to Z");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.range.sort",
      body: {
        tabId,
        direction: "asc",
        range: { startRow: 2, startCol: 0, endRow: 3, endCol: 1 },
      },
    });

    await clickButton("Clear filter preview");
    await settle();

    expect(input("A3").value).toBe("Alpha");
    expect(input("A4").value).toBe("Zeta");

    await clickButton("Delete filter view Customer_Filter");
    await settle();

    const deletedFilterViewUpdate = toolCalls
      .filter((call) => call.url === "/api/tools/sheets.update")
      .at(-1);
    expect(deletedFilterViewUpdate?.body).toMatchObject({
      sheetId,
      metadata: { filterViews: [] },
    });
    expect(container.textContent).not.toContain("Customer_Filter");

    await clickButton("Sort range Z to A");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.range.sort",
      body: {
        tabId,
        direction: "desc",
        range: { startRow: 2, startCol: 0, endRow: 3, endCol: 1 },
      },
    });
    expect(input("A3").value).toBe("Zeta");
    expect(input("A4").value).toBe("Alpha");
  });

  it("previews saved filter view predicate operators from legacy and array metadata", async () => {
    cells = [
      cell(0, 0, "Customer"),
      cell(0, 1, "ARR"),
      cell(2, 0, "Alpha"),
      cell(2, 1, "5"),
      cell(3, 0, "Beta"),
      cell(3, 1, "11"),
      cell(4, 0, ""),
      cell(4, 1, "15"),
    ];
    sheetMetadata = {
      customKey: { keep: true },
      filterViews: [
        {
          id: "filter-equals",
          tabId,
          name: "Equals_Filter",
          sortDirection: "asc",
          sortColumn: 0,
          range: { startRow: 2, startCol: 0, endRow: 4, endCol: 1 },
          predicate: { column: 0, operator: "equals", value: "Alpha" },
        },
        {
          id: "filter-greater",
          tabId,
          name: "Greater_Filter",
          sortDirection: "asc",
          sortColumn: 0,
          range: { startRow: 2, startCol: 0, endRow: 4, endCol: 1 },
          predicates: [{ column: 1, operator: "greaterThan", value: "10" }],
        },
        {
          id: "filter-not-empty",
          tabId,
          name: "Not_Empty_Filter",
          sortDirection: "asc",
          sortColumn: 0,
          range: { startRow: 2, startCol: 0, endRow: 4, endCol: 1 },
          predicates: [{ column: 0, operator: "notEmpty", value: "" }],
        },
      ],
    };
    render();
    await settle();
    await openSidePanelTab("Filters");
    await settle();

    expect(container.textContent).toContain('A equals "Alpha"');
    expect(container.textContent).toContain("B > 10");
    expect(container.textContent).toContain("A not empty");

    await clickButton("Apply filter view Equals_Filter");
    await settle();
    expect(input("A3").value).toBe("Alpha");
    expect(queryInput("A4")).toBeNull();

    await clickButton("Apply filter view Greater_Filter");
    await settle();
    expect(queryInput("A3")).toBeNull();
    expect(input("A4").value).toBe("Beta");
    expect(input("B4").value).toBe("11");

    await clickButton("Apply filter view Not_Empty_Filter");
    await settle();
    expect(input("A3").value).toBe("Alpha");
    expect(input("A4").value).toBe("Beta");
    expect(queryInput("A5")).toBeNull();
  });

  it("rebases relative formula references when sorting selected rows", async () => {
    cells = [cell(1, 0, "Zeta"), cell(1, 1, "=A2"), cell(2, 0, "Alpha"), cell(2, 1, "=$A$3+A3")];
    render();
    await settle();

    await clickCell("A2");
    await shiftSelectCell("B3");
    await clickButton("Sort range A to Z");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/sheets.range.sort",
      body: {
        tabId,
        direction: "asc",
        range: { startRow: 1, startCol: 0, endRow: 2, endCol: 1 },
      },
    });
    expect(copyCell("A2")).toBe("Alpha\t=$A$3+A2\nZeta\t=A3");
  });
});

function render({ onBack = () => undefined }: { readonly onBack?: () => void } = {}) {
  act(() => {
    root.render(
      <WebPlatformProvider
        host={platformHost}
        useColorMode={() => ({
          mode: "system",
          resolvedMode: "light",
          setMode: () => undefined,
          toggle: () => undefined,
        })}
      >
        <QueryClientProvider client={queryClient}>
          <NativeSpreadsheetEditor sheetId={sheetId} onBack={onBack} />
        </QueryClientProvider>
      </WebPlatformProvider>,
    );
  });
}

function remountFreshEditor() {
  act(() => {
    root.unmount();
  });
  queryClient.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  platformHost = createWebPlatformHost({
    queryClient,
    getColorMode: () => "system",
  });
  root = createRoot(container);
  render();
}

async function editCell(label: string, value: string): Promise<void> {
  const target = input(label);
  await act(async () => {
    target.focus();

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
  });
}

async function editFormulaBar(value: string): Promise<void> {
  const target = formulaBar();
  await act(async () => {
    target.focus();

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
  });
}

async function editTextInput(label: string, value: string): Promise<void> {
  const target = input(label);
  await act(async () => {
    target.focus();

    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
  });
}

async function editTextarea(label: string, value: string): Promise<void> {
  const target = textarea(label);
  await act(async () => {
    target.focus();

    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function changeCell(label: string, value: string): Promise<void> {
  const target = input(label);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function pasteCell(label: string, text: string): Promise<void> {
  return pasteCellClipboard(label, clipboardStub(text));
}

async function pasteCellClipboard(
  label: string,
  clipboard: ReturnType<typeof clipboardStub>,
): Promise<void> {
  const target = input(label);
  await act(async () => {
    target.focus();
    target.dispatchEvent(clipboardEvent("paste", clipboard));
    await Promise.resolve();
  });
}

function copyCell(label: string): string {
  return copyCellClipboard(label).getData("text/plain");
}

function copyCellClipboard(label: string): ReturnType<typeof clipboardStub> {
  const clipboard = clipboardStub("");
  input(label).dispatchEvent(clipboardEvent("copy", clipboard));
  return clipboard;
}

async function focusCell(label: string): Promise<void> {
  await act(async () => {
    input(label).focus();
    await Promise.resolve();
  });
}

async function shiftSelectCell(label: string): Promise<void> {
  await act(async () => {
    input(label).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, shiftKey: true }));
    await Promise.resolve();
  });
}

async function clickCell(label: string): Promise<void> {
  await act(async () => {
    input(label).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await Promise.resolve();
  });
}

function setSheetGridRect(): void {
  const gridWrap = sheetGridWrap();
  Object.defineProperty(gridWrap, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

function setSpreadsheetGridRect(): void {
  const grid = container.querySelector('[role="grid"]');
  if (!(grid instanceof HTMLDivElement)) {
    throw new Error("Missing spreadsheet grid.");
  }
  Object.defineProperty(grid, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 900,
      width: 1200,
      height: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
}

async function dropImageOnSpreadsheet(
  file: File,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  const grid = container.querySelector('[role="grid"]');
  if (!(grid instanceof HTMLDivElement)) {
    throw new Error("Missing spreadsheet grid.");
  }
  const dataTransfer = {
    dropEffect: "none",
    files: {
      length: 1,
      0: file,
      item: (index: number) => (index === 0 ? file : null),
    },
    items: {
      length: 1,
      0: {
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      },
    },
  } as unknown as DataTransfer;

  await act(async () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    Object.defineProperty(event, "clientX", { value: point.x });
    Object.defineProperty(event, "clientY", { value: point.y });
    grid.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function dropTextOnSpreadsheet(
  text: string,
  point: { readonly x: number; readonly y: number },
  type = "text/plain",
): Promise<void> {
  const grid = container.querySelector('[role="grid"]');
  if (!(grid instanceof HTMLDivElement)) {
    throw new Error("Missing spreadsheet grid.");
  }
  const dataTransfer = {
    dropEffect: "none",
    types: [type],
    getData: (requestedType: string) => (requestedType === type ? text : ""),
    files: { length: 0, item: () => null },
    items: { length: 0 },
  } as unknown as DataTransfer;

  await act(async () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    Object.defineProperty(event, "clientX", { value: point.x });
    Object.defineProperty(event, "clientY", { value: point.y });
    grid.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function dragEmbeddedImage(
  alt: string,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): Promise<void> {
  const target = embeddedImage(alt);
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: start.x,
        clientY: start.y,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    await Promise.resolve();
  });
}

async function resizeEmbeddedImage(
  alt: string,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): Promise<void> {
  const handle = embeddedImageResizeHandle(alt);
  await act(async () => {
    handle.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: start.x,
        clientY: start.y,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    await Promise.resolve();
  });
}

async function deleteEmbeddedImage(alt: string): Promise<void> {
  const target = embeddedImage(alt);
  await act(async () => {
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Delete",
      }),
    );
    await Promise.resolve();
  });
}

function embeddedImage(alt: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(`figure[aria-label="Embedded image ${alt}"]`);
  if (target === null) {
    throw new Error(`Missing embedded image: ${alt}`);
  }
  return target;
}

function embeddedImageResizeHandle(alt: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(
    `button[aria-label="Resize embedded image ${alt}"]`,
  );
  if (target === null) {
    throw new Error(`Missing embedded image resize handle: ${alt}`);
  }
  return target;
}

async function dragSelectCells(
  startLabel: string,
  endLabel: string,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): Promise<void> {
  await act(async () => {
    input(startLabel).dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: start.x,
        clientY: start.y,
      }),
    );
    input(endLabel).dispatchEvent(
      new MouseEvent("mouseover", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    await Promise.resolve();
  });
  await settle();
}

function sheetGridWrap(): HTMLDivElement {
  const grid = container.querySelector('[role="grid"]');
  const gridWrap = grid?.parentElement;
  if (!(gridWrap instanceof HTMLDivElement)) {
    throw new Error("Missing grid wrapper.");
  }
  return gridWrap;
}

async function dragFillHandle(
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
): Promise<void> {
  const handle = fillHandle();
  await act(async () => {
    handle.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: start.x,
        clientY: start.y,
      }),
    );
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    await Promise.resolve();
  });
  expect(container.querySelector('[aria-label="Fill preview range"]')).not.toBeNull();
  await act(async () => {
    document.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        clientX: end.x,
        clientY: end.y,
      }),
    );
    await Promise.resolve();
  });
  await settle();
}

function fillHandle(): HTMLButtonElement {
  const handle = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Spreadsheet fill handle"]',
  );
  if (handle === null) {
    throw new Error("Missing fill handle.");
  }
  return handle;
}

async function keyDownCell(
  label: string,
  key: string,
  options: { readonly shiftKey?: boolean } = {},
): Promise<void> {
  await act(async () => {
    input(label).dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        shiftKey: options.shiftKey ?? false,
      }),
    );
    await Promise.resolve();
  });
}

async function blurCell(label: string): Promise<void> {
  await act(async () => {
    input(label).blur();
    await Promise.resolve();
  });
}

function input(label: string): HTMLInputElement {
  const target = queryInput(label);
  if (target === null) {
    throw new Error(`Missing cell input: ${label}`);
  }
  return target;
}

function queryInput(label: string): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

function cellShell(label: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(`[data-testid="sheet-cell-shell-${label}"]`);
  if (target === null) {
    throw new Error(`Missing cell shell: ${label}`);
  }
  return target;
}

function visualCell(label: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(`[data-testid="sheet-cell-visual-${label}"]`);
  if (target === null) {
    throw new Error(`Missing visual cell: ${label}`);
  }
  return target;
}

function formulaBar(): HTMLInputElement {
  return input("Formula bar");
}

function selectedCellLabel(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Selected cell"]');
  if (target === null) {
    throw new Error("Missing selected cell label");
  }
  return target;
}

function selectedRangeSummary(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Selected range summary"]');
  if (target === null) {
    throw new Error("Missing selected range summary");
  }
  return target;
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
}

async function clickTextButton(label: string): Promise<void> {
  const target = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (target === undefined) {
    throw new Error(`Missing text button: ${label}`);
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function clickAppMenu(menuId: string): void {
  const target = container.querySelector<HTMLButtonElement>(`button[data-menu-id="${menuId}"]`);
  if (target === null) {
    throw new Error(`Missing app menu: ${menuId}`);
  }
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function clickAppBarShare(): void {
  const target =
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Share" && button.dataset.menuId !== "share",
    ) ?? null;
  if (target === null) {
    throw new Error("Missing app-bar Share button");
  }
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function clickOpenMenuItem(label: string): void {
  const target =
    Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']")).find((node) =>
      node.textContent?.includes(label),
    ) ?? null;
  if (target === null) {
    throw new Error(
      `Missing open menu item: ${label}. Found: ${JSON.stringify(
        Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']")).map((node) =>
          node.textContent?.trim(),
        ),
      )}`,
    );
  }
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function openSidePanelTab(label: string): Promise<void> {
  const triggers = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
  const trigger = triggers.find(
    (node) =>
      node.textContent?.trim().startsWith(label) === true ||
      node.getAttribute("aria-label") === label,
  );
  if (trigger === undefined) {
    throw new Error(`Missing side-panel tab: ${label}`);
  }
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    await Promise.resolve();
  });
  // Allow the effect that updates seenTabIds to commit so the new tab content mounts.
  await act(async () => {
    await Promise.resolve();
  });
}

async function selectToolbarOption(label: string, value: string): Promise<void> {
  await act(async () => {
    const target = select(label);
    target.value = value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing button: ${label}`);
  }
  return target;
}

function select(label: string): HTMLSelectElement {
  const target = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing select: ${label}`);
  }
  return target;
}

function textarea(label: string): HTMLTextAreaElement {
  const target = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing textarea: ${label}`);
  }
  return target;
}

function clipboardStub(initialText: string) {
  const values = new Map<string, string>([["text/plain", initialText]]);
  return {
    getData: (type: string) => values.get(type) ?? "",
    setData: (type: string, value: string) => {
      values.set(type, value);
    },
  };
}

function clipboardEvent(type: "copy" | "paste", clipboardData: ReturnType<typeof clipboardStub>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  return event;
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === "string") {
      this.sent.push(JSON.parse(data));
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  receive(message: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
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

function sortedTabs(): SheetsApiTab[] {
  return [...tabs].sort((left, right) =>
    left.position === right.position
      ? left.createdAt.localeCompare(right.createdAt)
      : left.position - right.position,
  );
}

function tab(overrides: Partial<SheetsApiTab> = {}): SheetsApiTab {
  return {
    id: tabId,
    sheetId,
    name: "Pipeline",
    position: 0,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function cell(
  row: number,
  col: number,
  value: string,
  format: Record<string, unknown> = {},
): SheetsApiCell {
  return {
    id: `${String(row)}-${String(col)}`,
    sheetTabId: tabId,
    row,
    col,
    value,
    formula: null,
    calcValue: value,
    dependencies: [],
    formulaError: null,
    format,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function filterTestCellsForWindow(
  sourceCells: readonly SheetsApiCell[],
  window: TestCellWindow | undefined,
): readonly SheetsApiCell[] {
  if (window === undefined) {
    return sourceCells;
  }
  const top = Math.min(window.startRow, window.endRow);
  const left = Math.min(window.startCol, window.endCol);
  const bottom = Math.max(window.startRow, window.endRow);
  const right = Math.max(window.startCol, window.endCol);
  return sourceCells.filter(
    (sourceCell) =>
      sourceCell.row >= top &&
      sourceCell.row <= bottom &&
      sourceCell.col >= left &&
      sourceCell.col <= right,
  );
}

function sortedCells(
  currentCells: readonly SheetsApiCell[],
  range: {
    readonly startRow: number;
    readonly startCol: number;
    readonly endRow: number;
    readonly endCol: number;
  },
  direction: "asc" | "desc",
): SheetsApiCell[] {
  const top = Math.min(range.startRow, range.endRow);
  const bottom = Math.max(range.startRow, range.endRow);
  const left = Math.min(range.startCol, range.endCol);
  const right = Math.max(range.startCol, range.endCol);
  const byCoordinate = new Map(
    currentCells.map((item) => [`${String(item.row)}:${String(item.col)}`, item]),
  );
  const rows = Array.from({ length: bottom - top + 1 }, (_, rowOffset) => {
    const row = top + rowOffset;
    return {
      row,
      rowOffset,
      cells: Array.from({ length: right - left + 1 }, (_, colOffset) => {
        const col = left + colOffset;
        const existing = byCoordinate.get(`${String(row)}:${String(col)}`);
        return { value: existing?.value ?? "", format: existing?.format ?? {} };
      }),
    };
  }).sort((leftRow, rightRow) => {
    const compared = compareSortValues(
      leftRow.cells[0]?.value ?? "",
      rightRow.cells[0]?.value ?? "",
    );
    return compared === 0
      ? leftRow.rowOffset - rightRow.rowOffset
      : direction === "asc"
        ? compared
        : -compared;
  });
  const sorted = currentCells.filter(
    (item) => item.row < top || item.row > bottom || item.col < left || item.col > right,
  );
  rows.forEach((sourceRow, rowOffset) => {
    const row = top + rowOffset;
    sourceRow.cells.forEach((item, colOffset) => {
      const col = left + colOffset;
      if (item.value.length > 0 || Object.keys(item.format).length > 0) {
        sorted.push(cell(row, col, shiftFormula(item.value, row - sourceRow.row), item.format));
      }
    });
  });
  return sorted;
}

function compareSortValues(left: string, right: string): number {
  const leftTrimmed = left.trim();
  const rightTrimmed = right.trim();
  if (leftTrimmed.length === 0 || rightTrimmed.length === 0) {
    if (leftTrimmed.length === rightTrimmed.length) {
      return 0;
    }
    return leftTrimmed.length === 0 ? 1 : -1;
  }
  return leftTrimmed.localeCompare(rightTrimmed, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function shiftFormula(value: string, rowDelta: number): string {
  if (!value.startsWith("=") || rowDelta === 0) {
    return value;
  }
  return value.replace(
    /\b(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)\b/gu,
    (match, colAbsolute: string, colLabel: string, rowAbsolute: string, rowLabel: string) => {
      if (rowAbsolute === "$") {
        return match;
      }
      return `${colAbsolute}${colLabel}${String(Math.max(1, Number.parseInt(rowLabel, 10) + rowDelta))}`;
    },
  );
}

function comment(
  id: string,
  body: string,
  anchor: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
  parentCommentId: string | null | undefined = null,
): SheetsDriveComment {
  return {
    id,
    sheetId,
    parentCommentId,
    actorId: "55555555-5555-4555-8555-555555555555",
    anchor,
    body,
    status: "open",
    metadata,
    resolvedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: null,
    author: {
      id: "55555555-5555-4555-8555-555555555555",
      displayName: "Mira Jones",
    },
  };
}
