// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenObjectRouteContent } from "./$objectId";
import type { DriveBlob } from "@/features/_open/drive-fetcher";

const navigateMock = vi.fn();
const loadDriveObjectForEditorMock = vi.fn();
const fetchDriveBlobMock = vi.fn();
const convertImportedDocToNativeMock = vi.fn();
const convertImportedDeckToNativeMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useRouter: () => ({ navigate: navigateMock }),
}));

vi.mock("@/features/_open/universal-loader", () => ({
  loadDriveObjectForEditor: (...args: unknown[]) => loadDriveObjectForEditorMock(...args),
}));

vi.mock("@/features/_open/drive-fetcher", () => ({
  fetchDriveBlob: (...args: unknown[]) => fetchDriveBlobMock(...args),
}));

vi.mock("@/features/_open/converters", () => ({
  ConverterNotAvailableError: class ConverterNotAvailableError extends Error {},
  convertImportedDocToNative: (...args: unknown[]) => convertImportedDocToNativeMock(...args),
  convertImportedSheetToNative: vi.fn(),
  convertImportedDeckToNative: (...args: unknown[]) => convertImportedDeckToNativeMock(...args),
}));

vi.mock("@/features/_open/ui/ImportedDocumentRenderer", () => ({
  ImportedDocumentRenderer: ({ fileName }: { readonly fileName: string }) => (
    <div>Read-only document preview: {fileName}</div>
  ),
}));

vi.mock("@/features/_open/ui/ImportedSheetRenderer", () => ({
  ImportedSheetRenderer: ({ fileName }: { readonly fileName: string }) => (
    <div>Read-only sheet preview: {fileName}</div>
  ),
}));

vi.mock("@/features/_open/ui/ImportedDeckRenderer", () => ({
  ImportedDeckRenderer: ({ fileName }: { readonly fileName: string }) => (
    <div>Read-only deck preview: {fileName}</div>
  ),
}));

vi.mock("@/features/_open/ui/UnsupportedFormatPlaceholder", () => ({
  UnsupportedFormatPlaceholder: ({ fileName }: { readonly fileName?: string }) => (
    <div>Unsupported file: {fileName}</div>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const SOURCE_BLOB: DriveBlob = {
  name: "Roadmap.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  bytes: new ArrayBuffer(8),
  byteLength: 8,
};

const IMPORTED_DOC_RESULT = {
  kind: "imported",
  blob: SOURCE_BLOB,
  parsed: {
    kind: "doc",
    format: {
      id: "docx",
      label: "Word document",
      extensions: ["docx"],
      mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      surface: "docs",
      supported: true,
    },
    tiptapDoc: { type: "doc", content: [] },
  },
} as const;

const IMPORTED_ODP_RESULT = {
  kind: "imported",
  blob: {
    name: "Planning deck.odp",
    mimeType: "application/vnd.oasis.opendocument.presentation",
    bytes: new ArrayBuffer(8),
    byteLength: 8,
  },
  parsed: {
    kind: "deck",
    format: {
      id: "odp",
      label: "ODP (OpenDocument Presentation)",
      extensions: ["odp"],
      mimeTypes: ["application/vnd.oasis.opendocument.presentation"],
      surface: "slides",
      supported: true,
    },
    slides: [],
    title: "Planning deck",
  },
} as const;

describe("OpenObjectRouteContent", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    navigateMock.mockClear();
    loadDriveObjectForEditorMock.mockResolvedValue(IMPORTED_DOC_RESULT);
    fetchDriveBlobMock.mockResolvedValue(SOURCE_BLOB);
    convertImportedDocToNativeMock.mockResolvedValue({ surface: "docs", id: "native-doc-1" });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    vi.clearAllMocks();
  });

  function render() {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OpenObjectRouteContent
            objectId="drive-object-1"
            router={{ navigate: navigateMock as never }}
          />
        </QueryClientProvider>,
      );
    });
  }

  async function settle() {
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("asks before creating an editable native copy", async () => {
    render();
    await settle();

    expect(container.textContent ?? "").toContain("Create editable copy?");
    expect(container.textContent ?? "").toContain("Roadmap.docx");
    expect(convertImportedDocToNativeMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("previews the original without importing", async () => {
    render();
    await settle();

    const previewButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Preview only",
    );
    expect(previewButton).not.toBeNull();
    act(() => {
      previewButton?.click();
    });
    await settle();

    expect(container.textContent ?? "").toContain("Read-only document preview: Roadmap.docx");
    expect(convertImportedDocToNativeMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("creates a copy only after the user chooses Create copy", async () => {
    render();
    await settle();

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Create copy",
    );
    expect(createButton).not.toBeNull();
    act(() => {
      createButton?.click();
    });
    await settle();

    expect(fetchDriveBlobMock).toHaveBeenCalledWith("drive-object-1");
    expect(convertImportedDocToNativeMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/docs/$documentId",
      params: { documentId: "native-doc-1" },
      replace: true,
    });
  });

  it("does not offer Create copy when the format has preview support but no native converter", async () => {
    loadDriveObjectForEditorMock.mockResolvedValue(IMPORTED_ODP_RESULT);

    render();
    await settle();

    expect(container.textContent ?? "").toContain("Preview/download only");
    expect(container.textContent ?? "").toContain("Planning deck.odp");
    expect(container.textContent ?? "").toContain("editable conversion for ODP");
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Create copy",
      ),
    ).toBe(false);
    expect(convertImportedDeckToNativeMock).not.toHaveBeenCalled();
  });
});
