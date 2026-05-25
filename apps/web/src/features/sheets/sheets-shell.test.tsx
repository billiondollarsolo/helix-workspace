// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetsShell } from "./sheets-shell";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(),
  }),
}));

vi.mock("@/components/shell", () => ({
  SurfaceFrame: ({
    actions,
    children,
  }: {
    readonly actions?: ReactNode;
    readonly children: ReactNode;
  }) => (
    <main>
      <div>{actions}</div>
      <div>{children}</div>
    </main>
  ),
}));

vi.mock("./native-spreadsheet-editor", () => ({
  NativeSpreadsheetEditor: ({ sheetId }: { readonly sheetId: string }) => (
    <div aria-label="Native spreadsheet editor">{sheetId}</div>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let importShouldFail: boolean;

describe("SheetsShell", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
    importShouldFail = false;
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/sheets.import-csv") {
        if (importShouldFail) {
          return Promise.resolve(
            Response.json({ error: { message: "CSV import is limited" } }, { status: 400 }),
          );
        }
        return Promise.resolve(
          Response.json({
            id: "11111111-1111-4111-8111-111111111111",
            title: "Renewals",
            tabs: [
              {
                id: "22222222-2222-4222-8222-222222222222",
                sheetId: "11111111-1111-4111-8111-111111111111",
                name: "Renewals",
                position: 0,
              },
            ],
            import: {
              format: "csv",
              filename: "Renewals.csv",
              rowCount: 2,
              columnCount: 2,
              populatedCellCount: 4,
            },
          }),
        );
      }
      if (url === "/api/tools/sheets.import-xlsx") {
        return Promise.resolve(
          Response.json({
            id: "33333333-3333-4333-8333-333333333333",
            title: "Forecast",
            tabs: [],
            import: {
              format: "xlsx",
              filename: "Forecast.xlsx",
              sheetCount: 1,
              rowCount: 2,
              columnCount: 2,
              populatedCellCount: 4,
            },
          }),
        );
      }
      if (url === "/api/tools/sheets.import-ods") {
        return Promise.resolve(
          Response.json({
            id: "55555555-5555-4555-8555-555555555555",
            title: "Forecast",
            tabs: [],
            import: {
              format: "ods",
              filename: "Forecast.ods",
              sheetCount: 1,
              rowCount: 2,
              columnCount: 2,
              populatedCellCount: 4,
            },
          }),
        );
      }
      if (url === "/api/tools/sheets.import-tsv") {
        return Promise.resolve(
          Response.json({
            id: "44444444-4444-4444-8444-444444444444",
            title: "Pipeline",
            tabs: [],
            import: {
              format: "tsv",
              filename: "Pipeline.tsv",
              rowCount: 2,
              columnCount: 2,
              populatedCellCount: 4,
            },
          }),
        );
      }
      return Promise.resolve(Response.json({ entries: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  it("imports CSV files into native spreadsheets and opens the created sheet", async () => {
    render();
    await settle();

    dispatchCsvFile("Renewals.csv", "Customer,ARR\nAcme,1200");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/sheets.import-csv")?.body).toEqual({
      filename: "Renewals.csv",
      title: "Renewals",
      csvText: "Customer,ARR\nAcme,1200",
      metadata: { source: "web.sheets-shell.import-csv" },
    });
    expect(container.querySelector('[aria-label="Native spreadsheet editor"]')?.textContent).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("surfaces CSV import failures without opening the editor", async () => {
    importShouldFail = true;
    render();
    await settle();

    dispatchCsvFile("Too large.csv", "A,B\n1,2");
    await settle();

    expect(container.textContent).toContain("Could not import spreadsheet: CSV import is limited");
    expect(container.querySelector('[aria-label="Native spreadsheet editor"]')).toBeNull();
  });

  it("imports XLSX files into native spreadsheets and opens the created sheet", async () => {
    render();
    await settle();

    dispatchXlsxFile("Forecast.xlsx", [1, 2, 3]);
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/sheets.import-xlsx")?.body).toEqual({
      filename: "Forecast.xlsx",
      title: "Forecast",
      contentBase64: "AQID",
      metadata: { source: "web.sheets-shell.import-xlsx" },
    });
    expect(container.querySelector('[aria-label="Native spreadsheet editor"]')?.textContent).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
  });

  it("imports ODS files into native spreadsheets and opens the created sheet", async () => {
    render();
    await settle();

    dispatchOdsFile("Forecast.ods", [4, 5, 6]);
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/sheets.import-ods")?.body).toEqual({
      filename: "Forecast.ods",
      title: "Forecast",
      contentBase64: "BAUG",
      metadata: { source: "web.sheets-shell.import-ods" },
    });
    expect(container.querySelector('[aria-label="Native spreadsheet editor"]')?.textContent).toBe(
      "55555555-5555-4555-8555-555555555555",
    );
  });

  it("imports TSV files into native spreadsheets and opens the created sheet", async () => {
    render();
    await settle();

    dispatchTsvFile("Pipeline.tsv", "Customer\tStage\nAcme\tCommit");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/sheets.import-tsv")?.body).toEqual({
      filename: "Pipeline.tsv",
      title: "Pipeline",
      tsvText: "Customer\tStage\nAcme\tCommit",
      metadata: { source: "web.sheets-shell.import-tsv" },
    });
    expect(container.querySelector('[aria-label="Native spreadsheet editor"]')?.textContent).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
  });
});

function render() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SheetsShell />
      </QueryClientProvider>,
    );
  });
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

function dispatchCsvFile(filename: string, csvText: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import spreadsheet"]');
  expect(input).not.toBeNull();
  const file = new File([csvText], filename, { type: "text/csv" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: () => Promise.resolve(csvText),
  });
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });

  act(() => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function dispatchTsvFile(filename: string, tsvText: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import spreadsheet"]');
  expect(input).not.toBeNull();
  const file = new File([tsvText], filename, { type: "text/tab-separated-values" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: () => Promise.resolve(tsvText),
  });
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });

  act(() => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function dispatchXlsxFile(filename: string, bytes: readonly number[]) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import spreadsheet"]');
  expect(input).not.toBeNull();
  const fileBytes = Uint8Array.from(bytes);
  const file = new File([fileBytes], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: () => Promise.resolve(Uint8Array.from(bytes).buffer),
  });
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });

  act(() => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function dispatchOdsFile(filename: string, bytes: readonly number[]) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import spreadsheet"]');
  expect(input).not.toBeNull();
  const fileBytes = Uint8Array.from(bytes);
  const file = new File([fileBytes], filename, {
    type: "application/vnd.oasis.opendocument.spreadsheet",
  });
  Object.defineProperty(file, "arrayBuffer", {
    configurable: true,
    value: () => Promise.resolve(Uint8Array.from(bytes).buffer),
  });
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });

  act(() => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
