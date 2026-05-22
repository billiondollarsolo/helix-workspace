// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetEditor } from "./sheet-editor";
import { SheetsList } from "./sheets-list";
import type { DriveApiEntry } from "@/features/drive/api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function fireDouble(node: Element) {
  node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
}

function fireClick(node: Element) {
  node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** A QueryClient that never retries — so error states settle fast in tests. */
function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function Wrapper({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** A fetch stub that always fails so the surface falls back to seed data. */
function failingFetch() {
  return Promise.resolve(Response.json({ error: "offline" }, { status: 503 }));
}

describe("SheetsList", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(failingFetch));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = makeQueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  });

  /** Render the list and let the (failing) sheets.list query settle so the
      seed fallback renders rather than the loading state. */
  async function renderList(props: Parameters<typeof SheetsList>[0]) {
    act(() => {
      root.render(
        <Wrapper client={client}>
          <SheetsList {...props} />
        </Wrapper>,
      );
    });
    // Drain microtasks + timers until the sheets.list query leaves its
    // loading state and the seed fallback renders.
    for (let tick = 0; tick < 20; tick += 1) {
      if (!container.textContent?.includes("Loading spreadsheets")) {
        break;
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("renders the Recent grid and the all-spreadsheets table from seed fallback", async () => {
    await renderList({ onOpen: () => {} });
    expect(container.textContent).toContain("Recent");
    expect(container.textContent).toContain("All spreadsheets");
    expect(container.textContent).toContain("Customer Renewals — Q3");
    expect(container.textContent).toContain("12 people");
  });

  it("filters by title query and shows an empty state on no match", async () => {
    await renderList({ query: "forecast", onOpen: () => {} });
    expect(container.textContent).toContain("Q3 Forecast");
    expect(container.textContent).not.toContain("Hiring Pipeline FY26");

    await renderList({ query: "zzz", onOpen: () => {} });
    expect(container.textContent).toContain("No spreadsheets match");
  });

  it("opens a spreadsheet when a row is clicked", async () => {
    let opened: string | null = null;
    await renderList({ onOpen: (id) => (opened = id) });
    const row = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Q3 Forecast"),
    );
    expect(row).toBeDefined();
    act(() => fireClick(row!));
    expect(opened).toBe("sh2");
  });

  it("surfaces a backend-unavailable notice when drive.list fails", async () => {
    await renderList({ onOpen: () => {} });
    expect(container.textContent).toContain("Sheets backend unavailable");
  });
});

describe("SheetsList — drive.list data source", () => {
  const DRIVE_SHEET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  function makeDriveEntry(overrides: Partial<DriveApiEntry> = {}): DriveApiEntry {
    return {
      id: DRIVE_SHEET_ID,
      type: "file",
      name: "Drive Renewals Sheet",
      folderId: null,
      ownerActorId: "actor-1",
      app: "sheets",
      metadata: { title: "Drive Renewals Sheet" },
      deletedAt: null,
      createdAt: "2026-05-20T10:00:00.000Z",
      updatedAt: "2026-05-20T10:00:00.000Z",
      ...overrides,
    };
  }

  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let fetchCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const body: unknown =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ url, body });

        if (url === "/api/tools/drive.list") {
          return Promise.resolve(Response.json({ entries: [makeDriveEntry()] }));
        }
        return Promise.resolve(Response.json({}, { status: 200 }));
      }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = makeQueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let tick = 0; tick < 20; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("calls drive.list with app:\"sheets\"", async () => {
    act(() => {
      root.render(
        <Wrapper client={client}>
          <SheetsList onOpen={() => {}} />
        </Wrapper>,
      );
    });
    await settle();

    const driveCall = fetchCalls.find((c) => c.url === "/api/tools/drive.list");
    expect(driveCall).toBeDefined();
    expect((driveCall?.body as { app: string }).app).toBe("sheets");
  });

  it("renders the drive entry title in the list and opens it by shared id", async () => {
    let opened: string | null = null;
    act(() => {
      root.render(
        <Wrapper client={client}>
          <SheetsList onOpen={(id) => (opened = id)} />
        </Wrapper>,
      );
    });
    await settle();

    expect(container.textContent).toContain("Drive Renewals Sheet");
    const row = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Drive Renewals Sheet"),
    );
    expect(row).toBeDefined();
    act(() => fireClick(row!));
    expect(opened).toBe(DRIVE_SHEET_ID);
  });
});

describe("SheetEditor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(failingFetch));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = makeQueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  });

  function renderEditor(props: Parameters<typeof SheetEditor>[0]) {
    act(() => {
      root.render(
        <Wrapper client={client}>
          <SheetEditor {...props} />
        </Wrapper>,
      );
    });
  }

  function findCell(text: string) {
    return Array.from(container.querySelectorAll('[role="gridcell"]')).find(
      (cell) => cell.textContent === text,
    );
  }

  it("renders the toolbar, formula bar, and tabs from seed fallback", () => {
    renderEditor({ sheetId: "sh1", onBack: () => {} });
    expect(container.textContent).toContain("Customer Renewals — Q3");
    expect(container.textContent).toContain("fx Σ Sum");
    expect(container.textContent).toContain("Customers");
    expect(container.textContent).toContain("Forecast");
  });

  it("renders the accent-soft totals row aggregating ARR", () => {
    renderEditor({ sheetId: "sh1", onBack: () => {} });
    expect(container.textContent).toContain("Total ARR");
    expect(container.textContent).toContain("$2,160,000");
  });

  it("updates the formula-bar reference on single click", () => {
    renderEditor({ sheetId: "sh1", onBack: () => {} });
    const cell = findCell("Northwind");
    expect(cell).toBeDefined();
    act(() => fireClick(cell!));
    const reference = container.querySelector(".mono");
    expect(reference?.textContent).toBe("A3");
  });

  it("edits a seed cell inline on double-click and commits on Enter", () => {
    renderEditor({ sheetId: "sh1", onBack: () => {} });
    const cell = findCell("Atlas Holdings");
    expect(cell).toBeDefined();
    act(() => fireDouble(cell!));

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Edit cell A2"]',
    );
    expect(input).toBeDefined();
    act(() => {
      input!.value = "Atlas Renamed";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(findCell("Atlas Renamed")).toBeDefined();
    expect(findCell("Atlas Holdings")).toBeUndefined();
  });

  it("switches the grid when a sheet tab is selected", () => {
    renderEditor({ sheetId: "sh1", onBack: () => {} });
    const tab = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Pipeline",
    );
    expect(tab).toBeDefined();
    act(() => fireClick(tab!));
    expect(container.textContent).toContain("Helios Retail");
    expect(container.textContent).not.toContain("Atlas Holdings");
  });

  it("calls onBack from the back button", () => {
    let back = false;
    renderEditor({ sheetId: "sh1", onBack: () => (back = true) });
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to spreadsheets"]',
    );
    expect(button).toBeDefined();
    act(() => fireClick(button!));
    expect(back).toBe(true);
  });
});

describe("SheetEditor backend wiring", () => {
  const backendSheetId = "11111111-1111-4111-8111-111111111111";
  const backendTabId = "22222222-2222-4222-8222-222222222222";

  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let calls: { url: string; body: unknown }[];

  /** Fetch stub routing each Sheets tool to a canned backend response. */
  function backendFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });

    if (url.endsWith("/sheets.get")) {
      return Promise.resolve(
        Response.json({
          id: backendSheetId,
          ownerActorId: null,
          createdByActorId: null,
          title: "Renewals FY26",
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
          tabs: [
            {
              id: backendTabId,
              sheetId: backendSheetId,
              name: "Accounts",
              position: 0,
              metadata: {},
              deletedAt: null,
              createdAt: "2026-05-21T00:00:00.000Z",
              updatedAt: "2026-05-21T00:00:00.000Z",
            },
          ],
        }),
      );
    }
    if (url.endsWith("/sheets.tab.get")) {
      return Promise.resolve(
        Response.json({
          id: backendTabId,
          sheetId: backendSheetId,
          name: "Accounts",
          position: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
          cells: [{ id: "c1", sheetTabId: backendTabId, row: 0, col: 0, value: "Account", format: {}, createdAt: "x", updatedAt: "x" }],
        }),
      );
    }
    if (url.endsWith("/sheets.cells.update")) {
      return Promise.resolve(
        Response.json({
          id: backendTabId,
          sheetId: backendSheetId,
          name: "Accounts",
          position: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-21T00:00:00.000Z",
          updatedAt: "2026-05-21T00:00:00.000Z",
          cells: [],
        }),
      );
    }
    return Promise.resolve(Response.json({}, { status: 200 }));
  }

  beforeEach(() => {
    calls = [];
    vi.stubGlobal("fetch", vi.fn(backendFetch));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = makeQueryClient();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  });

  async function settle() {
    for (let tick = 0; tick < 20; tick += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("loads a backend sheet via sheets.get + sheets.tab.get", async () => {
    act(() => {
      root.render(
        <Wrapper client={client}>
          <SheetEditor sheetId={backendSheetId} onBack={() => {}} />
        </Wrapper>,
      );
    });
    await settle();
    expect(container.textContent).toContain("Renewals FY26");
    expect(container.textContent).toContain("Accounts");
    expect(calls.some((c) => c.url.endsWith("/sheets.get"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/sheets.tab.get"))).toBe(true);
  });

  it("persists an inline cell edit through sheets.cells.update", async () => {
    act(() => {
      root.render(
        <Wrapper client={client}>
          <SheetEditor sheetId={backendSheetId} onBack={() => {}} />
        </Wrapper>,
      );
    });
    await settle();

    const cell = Array.from(container.querySelectorAll('[role="gridcell"]')).find(
      (node) => node.textContent === "Account",
    );
    expect(cell).toBeDefined();
    act(() => fireDouble(cell!));

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Edit cell A1"]',
    );
    expect(input).not.toBeNull();
    act(() => {
      input!.value = "Customer";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();

    const cellsCall = calls.find((c) => c.url.endsWith("/sheets.cells.update"));
    expect(cellsCall).toBeDefined();
    expect(cellsCall?.body).toEqual({
      tabId: backendTabId,
      edits: [{ row: 0, col: 0, value: "Customer" }],
    });
  });
});
