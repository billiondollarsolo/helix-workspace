// @vitest-environment jsdom

import { StrictMode, act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFetchHandle } from "./UniversalEditorRouter";
import { UniversalEditorRouter } from "./UniversalEditorRouter";

const navigateMock = vi.fn();
const loadDriveObjectForEditorMock = vi.fn();
const fetchDriveBlobMock = vi.fn();
const convertImportedDeckToNativeMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: navigateMock }),
}));

vi.mock("../universal-loader.js", () => ({
  loadDriveObjectForEditor: (...args: unknown[]) => loadDriveObjectForEditorMock(...args),
}));

vi.mock("../drive-fetcher.js", () => ({
  fetchDriveBlob: (...args: unknown[]) => fetchDriveBlobMock(...args),
}));

vi.mock("../converters.js", () => ({
  ConverterNotAvailableError: class ConverterNotAvailableError extends Error {},
  convertImportedDocToNative: vi.fn(),
  convertImportedSheetToNative: vi.fn(),
  convertImportedDeckToNative: (...args: unknown[]) => convertImportedDeckToNativeMock(...args),
}));

vi.mock("./ImportedDeckRenderer.js", () => ({
  ImportedDeckRenderer: ({ fileName }: { readonly fileName?: string }) => (
    <div>Read-only deck preview: {fileName}</div>
  ),
}));

vi.mock("./ImportedDocumentRenderer.js", () => ({
  ImportedDocumentRenderer: ({ fileName }: { readonly fileName?: string }) => (
    <div>Read-only document preview: {fileName}</div>
  ),
}));

vi.mock("./ImportedSheetRenderer.js", () => ({
  ImportedSheetRenderer: ({ fileName }: { readonly fileName?: string }) => (
    <div>Read-only sheet preview: {fileName}</div>
  ),
}));

vi.mock("./UnsupportedFormatPlaceholder.js", () => ({
  UnsupportedFormatPlaceholder: ({
    fileName,
    byteSize,
  }: {
    readonly fileName?: string;
    readonly byteSize?: number;
  }) => (
    <div>
      Unsupported fallback: {fileName} ({byteSize})
    </div>
  ),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const IMPORTED_DECK_RESULT = {
  kind: "imported",
  blob: {
    name: "Board narrative.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    byteLength: 12,
  },
  format: {
    id: "pptx",
    label: "PPTX (PowerPoint)",
    surface: "slides",
    supported: true,
  },
  parsed: {
    kind: "deck",
    format: {
      id: "pptx",
      label: "PPTX (PowerPoint)",
      surface: "slides",
      supported: true,
    },
    slides: [],
    title: "Board narrative",
  },
} as const;

const IMPORTED_ODP_DECK_RESULT = {
  kind: "imported",
  blob: {
    name: "Planning deck.odp",
    mimeType: "application/vnd.oasis.opendocument.presentation",
    byteLength: 12,
  },
  format: {
    id: "odp",
    label: "ODP (OpenDocument Presentation)",
    surface: "slides",
    supported: true,
  },
  parsed: {
    kind: "deck",
    format: {
      id: "odp",
      label: "ODP (OpenDocument Presentation)",
      surface: "slides",
      supported: true,
    },
    slides: [],
    title: "Planning deck",
  },
} as const;

const UNSUPPORTED_LEGACY_PPT_RESULT = {
  kind: "unsupported",
  blob: {
    name: "Legacy board deck.ppt",
    mimeType: "application/vnd.ms-powerpoint",
    byteLength: 24576,
  },
  result: {
    kind: "unsupported",
    format: {
      id: "ppt-legacy",
      label: "PPT (legacy PowerPoint, binary)",
      surface: "slides",
      supported: false,
    },
    reason: "PPT parsing is being built.",
  },
} as const;

const MISSING_NATIVE_FETCH: NativeFetchHandle<null> = {
  isLoading: false,
  isError: true,
  isSuccess: false,
  data: undefined,
};

describe("UniversalEditorRouter", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    navigateMock.mockClear();
    loadDriveObjectForEditorMock.mockResolvedValue(IMPORTED_DECK_RESULT);
    fetchDriveBlobMock.mockResolvedValue({
      name: "Board narrative.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      bytes: new ArrayBuffer(12),
      byteLength: 12,
    });
    convertImportedDeckToNativeMock.mockResolvedValue({ surface: "slides", id: "native-deck-1" });
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

  function render(
    options: {
      readonly strict?: boolean;
      readonly objectId?: string;
      readonly nativeEditingEnabled?: boolean;
    } = {},
  ) {
    const objectId = options.objectId ?? "drive-deck-1";
    const node = (
      <QueryClientProvider client={queryClient}>
        <UniversalEditorRouter
          objectId={objectId}
          surface="slides"
          nativeEditingEnabled={options.nativeEditingEnabled}
          nativeFetch={MISSING_NATIVE_FETCH}
          renderNative={() => <div>Native deck</div>}
        />
      </QueryClientProvider>
    );
    act(() => {
      root.render(options.strict === true ? <StrictMode>{node}</StrictMode> : node);
    });
  }

  async function settle() {
    for (let i = 0; i < 20; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  it("asks before creating an editable native copy for imported Drive blobs", async () => {
    render();
    await settle();

    expect(container.textContent ?? "").toContain("Create editable copy?");
    expect(container.textContent ?? "").toContain("Board narrative.pptx");
    expect(convertImportedDeckToNativeMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("can preview without importing", async () => {
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

    expect(container.textContent ?? "").toContain("Read-only deck preview: Board narrative.pptx");
    expect(convertImportedDeckToNativeMock).not.toHaveBeenCalled();
  });

  it("creates and opens a native copy only after Create copy", async () => {
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

    expect(fetchDriveBlobMock).toHaveBeenCalledWith("drive-deck-1");
    expect(convertImportedDeckToNativeMock).toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/slides",
      search: { deck: "native-deck-1" },
    });
  });

  it("creates only one native copy when React replays effects in StrictMode", async () => {
    render({ strict: true, objectId: "drive-deck-strict" });
    await settle();

    const createButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Create copy",
    );
    expect(createButton).not.toBeNull();
    act(() => {
      createButton?.click();
    });
    await settle();

    expect(convertImportedDeckToNativeMock).toHaveBeenCalledTimes(1);
    expect(fetchDriveBlobMock).toHaveBeenCalledTimes(1);
  });

  it("does not offer Create copy when a parsed deck has no native converter", async () => {
    loadDriveObjectForEditorMock.mockResolvedValue(IMPORTED_ODP_DECK_RESULT);

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
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("keeps imported Office files preview/download only when Editors alpha is disabled", async () => {
    render({ nativeEditingEnabled: false });
    await settle();

    expect(container.textContent ?? "").toContain("Preview/download only");
    expect(container.textContent ?? "").toContain("Editors alpha is disabled");
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => button.textContent?.trim() === "Create copy",
      ),
    ).toBe(false);
    expect(convertImportedDeckToNativeMock).not.toHaveBeenCalled();
  });

  it("does not render a native editor when Editors alpha is disabled", async () => {
    const nativeFetch: NativeFetchHandle<{ readonly id: string }> = {
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: { id: "native-deck-1" },
    };

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UniversalEditorRouter
            objectId="native-deck-1"
            surface="slides"
            nativeEditingEnabled={false}
            nativeFetch={nativeFetch}
            renderNative={() => <div>Native deck</div>}
          />
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(container.textContent ?? "").not.toContain("Native deck");
    expect(loadDriveObjectForEditorMock).toHaveBeenCalledWith("native-deck-1", {
      expectedSurface: "slides",
    });
  });

  it("passes the original filename and size to unsupported format fallbacks", async () => {
    loadDriveObjectForEditorMock.mockResolvedValue(UNSUPPORTED_LEGACY_PPT_RESULT);

    render();
    await settle();

    expect(container.textContent ?? "").toContain(
      "Unsupported fallback: Legacy board deck.ppt (24576)",
    );
    expect(convertImportedDeckToNativeMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
