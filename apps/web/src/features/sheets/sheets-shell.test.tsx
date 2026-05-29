// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SheetsShell } from "./sheets-shell";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: navigateMock,
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
let digestSpy: { mockRestore: () => void };
let driveEntries: readonly unknown[];

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
    driveEntries = [];
    navigateMock.mockClear();
    digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/drive.upload") {
        if (importShouldFail) {
          return Promise.resolve(
            Response.json({ error: { message: "Drive upload failed" } }, { status: 503 }),
          );
        }
        const name = (body as { name?: string }).name ?? "Upload.csv";
        const objectId = `upload-${name
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-|-$/gu, "")}`;
        return Promise.resolve(
          Response.json({
            objectId,
            orgId: "org-1",
            ownerActorId: "actor-1",
            name,
            folderId: null,
            storageKey: `drive/${name}`,
            mimeType: (body as { mimeType?: string }).mimeType ?? "application/octet-stream",
            byteSize: (body as { byteSize?: number }).byteSize ?? 0,
            sha256: "0".repeat(64),
            status: "prepared",
            uploadUrl: null,
            uploadHeaders: {},
            metadata: {},
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/drive.finalize") {
        return Promise.resolve(
          Response.json({
            id: "version-1",
            orgId: "org-1",
            objectId: (body as { objectId?: string }).objectId,
            versionNumber: 1,
            storageKey: (body as { storageKey?: string }).storageKey,
            mimeType: (body as { mimeType?: string }).mimeType,
            byteSize: (body as { byteSize?: number }).byteSize,
            sha256: "0".repeat(64),
            metadata: {},
            createdByActorId: "actor-1",
            createdAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/drive.list") {
        return Promise.resolve(Response.json({ entries: driveEntries }));
      }
      if (url === "/api/tools/drive.trash") {
        return Promise.resolve(Response.json({ id: (body as { objectId?: string }).objectId }));
      }
      if (url === "/api/tools/drive.restore") {
        return Promise.resolve(Response.json({ id: (body as { objectId?: string }).objectId }));
      }
      if (url === "/api/tools/drive.delete") {
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url === "/api/tools/drive.star.set") {
        return Promise.resolve(
          Response.json({
            id: (body as { objectId?: string }).objectId,
            metadata: { starred: (body as { starred?: boolean }).starred },
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
    digestSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("uploads CSV files as raw Drive objects and opens the copy/preview flow", async () => {
    render();
    await settle();

    dispatchCsvFile("Renewals.csv", "Customer,ARR\nAcme,1200");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Renewals.csv",
      mimeType: "text/csv",
      byteSize: 22,
    });
    expect(toolCalls.some((call) => call.url.includes("sheets.import"))).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "upload-renewals-csv" },
    });
  });

  it("surfaces CSV upload failures without opening the editor", async () => {
    importShouldFail = true;
    render();
    await settle();

    dispatchCsvFile("Too large.csv", "A,B\n1,2");
    await settle();

    expect(container.textContent).toContain("Could not import spreadsheet: Drive upload failed");
    expect(container.querySelector('[aria-label="Native spreadsheet editor"]')).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("uploads Excel-family files as raw Drive objects and opens the copy/preview flow", async () => {
    render();
    await settle();

    dispatchExcelWorkbookFile(
      "Forecast.xlsb",
      [1, 2, 3],
      "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
    );
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Forecast.xlsb",
      mimeType: "application/vnd.ms-excel.sheet.binary.macroenabled.12",
      byteSize: 3,
    });
    expect(toolCalls.some((call) => call.url.includes("sheets.import"))).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "upload-forecast-xlsb" },
    });
  });

  it("uploads ODS files as raw Drive objects and opens the copy/preview flow", async () => {
    render();
    await settle();

    dispatchOdsFile("Forecast.ods", [4, 5, 6]);
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Forecast.ods",
      mimeType: "application/vnd.oasis.opendocument.spreadsheet",
      byteSize: 3,
    });
    expect(toolCalls.some((call) => call.url.includes("sheets.import"))).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "upload-forecast-ods" },
    });
  });

  it("uploads TSV files as raw Drive objects and opens the copy/preview flow", async () => {
    render();
    await settle();

    dispatchTsvFile("Pipeline.tsv", "Customer\tStage\nAcme\tCommit");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Pipeline.tsv",
      mimeType: "text/tab-separated-values",
      byteSize: 26,
    });
    expect(toolCalls.some((call) => call.url.includes("sheets.import"))).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "upload-pipeline-tsv" },
    });
  });

  it("uses normal empty states for shared, starred, and trash folders", async () => {
    render();
    await settle();

    await clickButton("Shared with me");
    expect(container.textContent).toContain("No shared spreadsheets yet.");
    expect(container.textContent).not.toContain("Coming soon");

    await clickButton("Starred");
    expect(container.textContent).toContain("No starred spreadsheets yet.");
    expect(container.textContent).not.toContain("Coming soon");

    await clickButton("Trash");
    expect(container.textContent).toContain("Trash is empty.");
    expect(container.textContent).not.toContain("Coming soon");
  });

  it("loads more spreadsheet rows through Drive when the first page is full", async () => {
    driveEntries = Array.from({ length: 101 }, (_, index) =>
      spreadsheetDriveEntry({
        id: `66666666-6666-4666-8666-${String(index).padStart(12, "0")}`,
        name: `Spreadsheet ${String(index).padStart(3, "0")}.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    render();
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.list")?.body).toMatchObject({
      app: "sheets",
      limit: 101,
    });
    await clickButton("Show more spreadsheets");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/drive.list").at(-1)?.body,
    ).toMatchObject({ app: "sheets", limit: 201 });
  });

  it("moves spreadsheet list rows to trash through Drive", async () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    driveEntries = [
      spreadsheetDriveEntry({
        id: objectId,
        name: "Quarter forecast.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ];
    render();
    await settle();

    await clickButton("List view");
    await clickButton("More actions for Quarter forecast.xlsx");
    await clickButton("Move to trash");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.trash")?.body).toEqual({
      objectId,
    });
    expect(toolCalls.some((call) => call.url.includes("sheets.delete"))).toBe(false);
  });

  it("stars spreadsheet list rows through Drive", async () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    driveEntries = [
      spreadsheetDriveEntry({
        id: objectId,
        name: "Quarter forecast.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ];
    render();
    await settle();

    await clickButton("List view");
    await clickButton("More actions for Quarter forecast.xlsx");
    await clickMenuItem("Star");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.star.set")?.body).toEqual({
      objectId,
      starred: true,
    });
  });

  it("restores and permanently deletes trashed spreadsheets through Drive", async () => {
    const objectId = "22222222-2222-4222-8222-222222222222";
    driveEntries = [
      spreadsheetDriveEntry({
        id: objectId,
        name: "Deleted budget.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        deletedAt: "2026-05-22T12:00:00.000Z",
      }),
    ];
    render();
    await settle();

    await clickButton("Trash");
    await clickButton("List view");
    await clickButton("More actions for Deleted budget.xlsx");
    await clickButton("Restore");
    await settle();
    await clickButton("More actions for Deleted budget.xlsx");
    await clickButton("Delete forever");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.restore")?.body).toEqual({
      objectId,
      folderId: null,
    });
    expect(toolCalls.find((call) => call.url === "/api/tools/drive.delete")?.body).toEqual({
      objectId,
    });
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

async function clickButton(label: string): Promise<void> {
  const target = [...container.querySelectorAll<HTMLElement>("button,[role='button']")].find(
    (control) =>
      control.textContent?.includes(label) === true ||
      control.getAttribute("aria-label")?.includes(label) === true,
  );
  if (target === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

async function clickMenuItem(label: string): Promise<void> {
  const target = [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(
    (button) => button.textContent?.trim().includes(label) === true,
  );
  if (target === undefined) {
    throw new Error(`Missing menu item: ${label}`);
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function spreadsheetDriveEntry(input: {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly deletedAt?: string | null;
}) {
  return {
    id: input.id,
    type: "file",
    name: input.name,
    folderId: null,
    ownerActorId: "actor-1",
    ownerDisplayName: "You",
    app: null,
    mimeType: input.mimeType,
    metadata: {},
    deletedAt: input.deletedAt ?? null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
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
  dispatchImportFile(input, file);
}

function dispatchTsvFile(filename: string, tsvText: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import spreadsheet"]');
  expect(input).not.toBeNull();
  const file = new File([tsvText], filename, { type: "text/tab-separated-values" });
  dispatchImportFile(input, file);
}

function dispatchExcelWorkbookFile(filename: string, bytes: readonly number[], mimeType: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import spreadsheet"]');
  expect(input).not.toBeNull();
  const file = new File([Uint8Array.from(bytes)], filename, { type: mimeType });
  dispatchImportFile(input, file);
}

function dispatchOdsFile(filename: string, bytes: readonly number[]) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Import spreadsheet"]');
  expect(input).not.toBeNull();
  const file = new File([Uint8Array.from(bytes)], filename, {
    type: "application/vnd.oasis.opendocument.spreadsheet",
  });
  dispatchImportFile(input, file);
}

function dispatchImportFile(input: HTMLInputElement | null, file: File) {
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });

  act(() => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
