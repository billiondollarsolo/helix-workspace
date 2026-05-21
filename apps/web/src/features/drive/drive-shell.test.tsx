// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveShell } from "./drive-shell";

const suggestionSlotHarness = vi.hoisted(() => ({
  calls: [] as Array<{ readonly slotId: string; readonly context: unknown }>,
}));

vi.mock("@helix/sdk-web", () => ({
  SuggestionSlot: ({
    context,
    emptyFallback,
    slotId,
  }: {
    readonly context?: unknown;
    readonly emptyFallback?: React.ReactNode;
    readonly slotId: string;
  }) => {
    suggestionSlotHarness.calls.push({ slotId, context });
    return <div data-testid={`suggestion-slot-${slotId}`}>{emptyFallback ?? null}</div>;
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const fileId = "33333333-3333-4333-8333-333333333333";
const routeFileId = "33333333-3333-4333-8333-444444444444";
const folderId = "44444444-4444-4444-8444-444444444444";
const docId = "55555555-5555-4555-8555-555555555555";
const imageFileId = "99999999-9999-4999-8999-999999999999";

describe("DriveShell backend tool integration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let preparedUploadUrl: string | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 0,
        },
      },
    });
    preparedUploadUrl = null;
    suggestionSlotHarness.calls.length = 0;
    fetchMock = vi.fn<typeof fetch>((input) => {
      if (input === "/api/tools/drive.list") {
        return Promise.resolve(
          Response.json({
            entries: [
              {
                id: fileId,
                type: "file",
                name: "Backend roadmap.pdf",
                folderId: null,
                ownerActorId: "22222222-2222-4222-8222-222222222222",
                mimeType: "application/pdf",
                byteSize: 2048,
                sha256: null,
                storageKey: "drive/backend-roadmap.pdf",
                versionNumber: 1,
                preview: {
                  kind: "pdf",
                  status: "available",
                  mimeType: "application/pdf",
                  url: "https://cdn.example/backend-roadmap.pdf",
                  pageCount: 7,
                },
                metadata: {},
                deletedAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
              {
                id: folderId,
                type: "folder",
                name: "Client work",
                parentId: null,
                ownerActorId: "22222222-2222-4222-8222-222222222222",
                metadata: {},
                deletedAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
              {
                id: imageFileId,
                type: "file",
                name: "Launch mockup.png",
                folderId: null,
                ownerActorId: "22222222-2222-4222-8222-222222222222",
                mimeType: "image/png",
                byteSize: 4096,
                sha256: null,
                storageKey: "drive/launch-mockup.png",
                versionNumber: 1,
                preview: {
                  kind: "image",
                  status: "available",
                  mimeType: "image/png",
                  url: "https://cdn.example/launch-mockup.png",
                  width: 1200,
                  height: 800,
                },
                metadata: {},
                deletedAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:10:00.000Z",
              },
              {
                id: routeFileId,
                type: "file",
                name: "Route selected budget.txt",
                folderId: null,
                ownerActorId: "22222222-2222-4222-8222-222222222222",
                mimeType: "text/plain",
                byteSize: 128,
                sha256: null,
                storageKey: "drive/route-selected-budget.txt",
                versionNumber: 1,
                preview: {
                  kind: "text",
                  status: "available",
                  mimeType: "text/plain",
                  text: "Selected from Drive route state",
                },
                metadata: {},
                deletedAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:05:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/docs.create") {
        return Promise.resolve(
          Response.json({
            id: docId,
            title: "Untitled document",
            threadId: "66666666-6666-4666-8666-666666666666",
            ownerActorId: "11111111-1111-4111-8111-111111111111",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            ydocState: null,
            ydocStateVector: null,
            updateSeq: 0,
            metadata: {},
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (input === "/api/tools/drive.search") {
        return Promise.resolve(
          Response.json({
            hits: [
              {
                objectId: fileId,
                name: "Backend search brief.txt",
                mimeType: "text/plain",
                byteSize: 512,
                sha256: null,
                folderId: null,
                preview: "Backend search preview",
                previewMetadata: {
                  kind: "text",
                  status: "available",
                  mimeType: "text/plain",
                  text: "Backend typed text preview",
                },
                updatedAt: "2026-05-20T12:30:00.000Z",
              },
            ],
          }),
        );
      }
      if (input === "/api/tools/drive.upload") {
        return Promise.resolve(
          Response.json({
            objectId: "77777777-7777-4777-8777-777777777777",
            orgId: "11111111-1111-4111-8111-111111111111",
            ownerActorId: "22222222-2222-4222-8222-222222222222",
            name: "upload.txt",
            folderId: null,
            storageKey: "drive/upload.txt",
            mimeType: "text/plain",
            byteSize: 11,
            sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
            status: "pending_upload",
            uploadUrl: preparedUploadUrl,
            metadata: { source: "web.drive-shell" },
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (input === preparedUploadUrl) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (input === "/api/tools/drive.finalize") {
        return Promise.resolve(
          Response.json({
            id: "88888888-8888-4888-8888-888888888888",
            orgId: "11111111-1111-4111-8111-111111111111",
            objectId: "77777777-7777-4777-8777-777777777777",
            versionNumber: 1,
            storageKey: "drive/upload.txt",
            mimeType: "text/plain",
            byteSize: 11,
            sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
            metadata: { source: "web.drive-shell" },
            createdByActorId: "22222222-2222-4222-8222-222222222222",
            createdAt: "2026-05-20T12:01:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads the initial backend Drive list", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/tools/drive.list");
  });

  it("renders Drive items inside the virtualized container in list and grid views", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");

    const listVirtualContainer = container.querySelector('[data-testid="drive-virtualized-items"]');
    expect(listVirtualContainer).toBeInstanceOf(HTMLTableElement);
    expect(listVirtualContainer?.classList.contains("drive-list")).toBe(true);
    expect(listVirtualContainer?.textContent).toContain("Backend roadmap.pdf");
    expect(listVirtualContainer?.querySelector("[data-index='0']")).toBeInstanceOf(
      HTMLTableRowElement,
    );

    await clickIconButton("Grid view");

    const gridVirtualContainer = container.querySelector('[data-testid="drive-virtualized-items"]');
    expect(gridVirtualContainer).toBeInstanceOf(HTMLDivElement);
    expect(gridVirtualContainer?.classList.contains("drive-grid")).toBe(true);
    expect(gridVirtualContainer?.textContent).toContain("Backend roadmap.pdf");
    expect(gridVirtualContainer?.querySelector("[data-index='0']")).toBeInstanceOf(HTMLDivElement);
  });

  it("renders list view with table semantics and syncs row selection metadata", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");

    const table = container.querySelector('table[aria-label="Drive items"]');
    expect(table).toBeInstanceOf(HTMLTableElement);
    expect(table?.querySelector('[data-slot="table-header"]')).toBeInstanceOf(
      HTMLTableSectionElement,
    );
    expect(table?.querySelector('[data-slot="table-body"]')).toBeInstanceOf(
      HTMLTableSectionElement,
    );
    expect(
      Array.from(table?.querySelectorAll("th") ?? []).map((header) => header.textContent?.trim()),
    ).toEqual(["Selection", "Name", "Owner", "Modified", "Size", "Sharing", "Actions"]);

    const roadmapRow = findTableRow("Backend roadmap.pdf");
    expect(roadmapRow).toBeInstanceOf(HTMLTableRowElement);
    expect(roadmapRow?.querySelector("td")).toBeInstanceOf(HTMLTableCellElement);
    expect(roadmapRow?.getAttribute("aria-selected")).toBe("false");

    await toggleItemSelection("Backend roadmap.pdf");

    const selectedRow = findTableRow("Backend roadmap.pdf");
    expect(selectedRow?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("1 selected");
    expect(container.querySelector(".drive-item.selected")?.textContent).toContain(
      "Backend roadmap.pdf",
    );
  });

  it("renders backend Drive search results", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");

    await typeSearch("brief");
    await waitForText("Backend search brief.txt");
    await clickButton("Backend search brief.txt");
    await waitForText("Backend typed text preview");

    const searchCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/drive.search");
    expect(searchCall?.[1]?.method).toBe("POST");
    expect(jsonBody(searchCall)).toMatchObject({ query: "brief", folderId: null, limit: 50 });
  });

  it("loads route-backed Drive search state", async () => {
    renderDrive({
      routeState: { folderId: null, includeTrashed: false, query: "brief" },
    });
    await waitForText("Backend search brief.txt");

    const searchCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/drive.search");
    expect(jsonBody(searchCall)).toMatchObject({ query: "brief", folderId: null, limit: 50 });
  });

  it("publishes folder and trash controls as route state", async () => {
    const onRouteStateChange = vi.fn();
    renderDrive({
      onRouteStateChange,
      routeState: { folderId: null, includeTrashed: false, query: "" },
    });
    await waitForText("Client work");

    await clickButton("Client work");
    expect(onRouteStateChange.mock.lastCall?.[0]).toMatchObject({
      folderId,
      includeTrashed: false,
      query: "",
    });

    await clickNavButton("Trash");
    expect(onRouteStateChange.mock.lastCall?.[0]).toMatchObject({
      folderId: null,
      includeTrashed: true,
    });
  });

  it("renders typed backend preview metadata in the preview panel", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");
    await clickButton("Backend roadmap.pdf");

    const previewFrame = container.querySelector(".drive-preview-frame");
    expect(previewFrame?.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://cdn.example/backend-roadmap.pdf",
    );
  });

  it("renders Drive AI suggestion slots with selected file context", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");
    await clickButton("Backend roadmap.pdf");
    await waitForText("No file summary");

    expect(
      container.querySelector('[data-testid="suggestion-slot-drive.summarize-file"]'),
    ).toBeInstanceOf(HTMLElement);
    expect(
      container.querySelector('[data-testid="suggestion-slot-drive.describe-image"]'),
    ).toBeNull();
    expect(lastSuggestionContext("drive.summarize-file")).toMatchObject({
      routePath: "/drive",
      resource: {
        id: fileId,
        type: "drive.file",
        label: "Backend roadmap.pdf",
      },
      classification: "standard",
      metadata: {
        name: "Backend roadmap.pdf",
        mimeType: "application/pdf",
        kind: "pdf",
        path: ["My Drive", "Backend roadmap.pdf"],
      },
    });

    await clickButton("Launch mockup.png");
    await waitForText("No image description");

    expect(lastSuggestionContext("drive.describe-image")).toMatchObject({
      resource: {
        id: imageFileId,
        type: "drive.file",
        label: "Launch mockup.png",
      },
      metadata: {
        name: "Launch mockup.png",
        mimeType: "image/png",
        kind: "image",
        imageUrl: "https://cdn.example/launch-mockup.png",
      },
    });
  });

  it("hydrates the selected Drive file from route state when backend data contains it", async () => {
    renderDrive({ initialFileId: routeFileId });
    await waitForText("Route selected budget.txt");
    await waitForText("Selected from Drive route state");

    const selectedItem = container.querySelector(".drive-item.selected");
    expect(selectedItem?.textContent).toContain("Route selected budget.txt");
    expect(container.querySelector(".drive-preview-panel")?.textContent).toContain(
      "Route selected budget.txt",
    );
  });

  it("calls the backend trash mutation from the shell", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");
    await clickButton("Backend roadmap.pdf");

    await clickButton("Trash");

    const trashCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/drive.trash");
    expect(trashCall?.[1]?.method).toBe("POST");
    expect(jsonBody(trashCall)).toEqual({ objectId: fileId });
  });

  it("submits share targets through the Drive share dialog", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");
    await clickButton("Backend roadmap.pdf");

    await clickButton("Share");
    await setDialogFieldValue("People or groups", "reviewers@example.com");
    await setDialogFieldValue("Permission", "editor");
    await clickButton("Share");

    const shareCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/drive.share");
    expect(shareCall?.[1]?.method).toBe("POST");
    expect(jsonBody(shareCall)).toEqual({
      objectId: fileId,
      actorIds: ["reviewers@example.com"],
      role: "editor",
      expiresAt: null,
    });
    await waitForText("SharingShared");
  });

  it("blocks Drive share submit when the target is blank", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");
    await clickButton("Backend roadmap.pdf");

    await clickButton("Share");
    await clickButton("Share");
    await waitForText("People or groups is required.");

    const shareInput = container.querySelector(".helix-dialog input");
    expect(shareInput).toBeInstanceOf(HTMLInputElement);
    expect(shareInput?.getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/drive.share")).toBe(false);
  });

  it("uploads files through presigned PUT and finalizes without inline content", async () => {
    preparedUploadUrl = "https://uploads.example/upload.txt";
    const file = new File(["hello world"], "upload.txt", { type: "text/plain" });
    renderDrive();
    await waitForText("Backend roadmap.pdf");

    await uploadFiles([file]);
    await waitForText("upload.txt");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/drive.finalize")).toBe(
        true,
      ),
    );

    const uploadCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/drive.upload");
    const presignedPutCall = fetchMock.mock.calls.find((call) => call[0] === preparedUploadUrl);
    const finalizeCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/drive.finalize",
    );
    expect(uploadCall?.[1]?.method).toBe("POST");
    expect(jsonBody(uploadCall)).toMatchObject({
      name: "upload.txt",
      folderId: null,
      mimeType: "text/plain",
      byteSize: 11,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      metadata: { source: "web.drive-shell" },
    });
    expect(presignedPutCall?.[1]).toMatchObject({
      method: "PUT",
      headers: { "content-type": "text/plain" },
    });
    expect(presignedPutCall?.[1]?.body).toBe(file);
    expect(finalizeCall?.[1]?.method).toBe("POST");
    expect(jsonBody(finalizeCall)).toMatchObject({
      objectId: "77777777-7777-4777-8777-777777777777",
      byteSize: 11,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      mimeType: "text/plain",
      storageKey: "drive/upload.txt",
      metadata: { source: "web.drive-shell" },
    });
    expect(jsonBody(finalizeCall)).not.toHaveProperty("contentBase64");
  });

  it("falls back to inline contentBase64 when no presigned upload URL is provided", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");

    await uploadFiles([new File(["hello world"], "upload.txt", { type: "text/plain" })]);
    await waitForText("upload.txt");
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => call[0] === "/api/tools/drive.finalize")).toBe(
        true,
      ),
    );

    const presignedPutCall = fetchMock.mock.calls.find((call) => call[0] === preparedUploadUrl);
    const finalizeCall = fetchMock.mock.calls.find(
      (call) => call[0] === "/api/tools/drive.finalize",
    );
    expect(presignedPutCall).toBeUndefined();
    expect(finalizeCall?.[1]?.method).toBe("POST");
    expect(jsonBody(finalizeCall)).toMatchObject({
      objectId: "77777777-7777-4777-8777-777777777777",
      byteSize: 11,
      sha256: "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      mimeType: "text/plain",
      storageKey: "drive/upload.txt",
      contentBase64: "aGVsbG8gd29ybGQ=",
      metadata: { source: "web.drive-shell" },
    });
  });

  it("creates Drive-backed Docs documents in the selected folder", async () => {
    renderDrive();
    await waitForText("Client work");

    await clickButton("Client work");
    await clickButton("New doc");
    await waitForText("Untitled document.helixdoc");

    const createCall = fetchMock.mock.calls.find((call) => call[0] === "/api/tools/docs.create");
    expect(createCall?.[1]?.method).toBe("POST");
    expect(jsonBody(createCall)).toMatchObject({
      title: "Untitled document",
      initialMarkdown: "# Untitled document\n",
      folderId,
      metadata: {
        source: "web.drive-shell",
        driveFolderId: folderId,
      },
    });
    await waitForText("Documents in Drive");
  });

  it("renders a real empty state instead of demo data when the backend list is empty", async () => {
    fetchMock.mockImplementation((input) => {
      if (input === "/api/tools/drive.list") {
        return Promise.resolve(Response.json({ entries: [] }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    });

    renderDrive();
    await waitForText("No Drive files");
    await waitForText("Upload a file to add it to Drive.");

    // Demo/sample content must never leak into the production UI.
    expect(container.textContent).not.toContain("AI Services and Keys.helixdoc");
    expect(container.textContent).not.toContain("Training Course Links.helixdoc");
    expect(container.textContent).not.toContain("Memorial Speech.helixdoc");
    expect(container.querySelector(".drive-empty-state")).toBeInstanceOf(HTMLElement);
  });

  it("renders an offline state when the backend list fails", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    renderDrive();
    await waitForText("Drive backend is offline");

    expect(container.textContent).not.toContain("Q2 launch roadmap.pdf");
    expect(container.textContent).not.toContain("admin-demo-cut.mp4");
  });

  it("keeps failed optimistic uploads visible as offline local files", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    renderDrive();
    await waitForText("Drive backend is offline");

    await uploadFiles([new File(["local only"], "local-notes.txt", { type: "text/plain" })]);

    await waitForText("local-notes.txt");
    await waitForText("Offline/local");
    expect(container.textContent).not.toContain("Q2 launch roadmap.pdf");
  });

  it("renders Suggested folders and Suggested files headings on the Drive home", async () => {
    renderDrive();
    await waitForText("Backend roadmap.pdf");

    expect(container.textContent).toContain("Suggested folders");
    expect(container.textContent).toContain("Suggested files");

    const headings = Array.from(container.querySelectorAll(".drive-section-title")).map(
      (el) => el.textContent,
    );
    expect(headings).toContain("Suggested folders");
    expect(headings).toContain("Suggested files");
  });

  it("hides Suggested folders and Suggested files when navigated into a folder", async () => {
    renderDrive();
    await waitForText("Client work");

    await clickButton("Client work");

    expect(container.textContent).not.toContain("Suggested folders");
    expect(container.textContent).not.toContain("Suggested files");
  });

  it("renders suggested folder cards inside drive-suggested-folders section", async () => {
    renderDrive();
    await waitForText("Suggested folders");

    // Wait for suggestions to load (drive.list resolves with folders)
    await waitFor(() => {
      const section = container.querySelector(".drive-suggested-folders");
      expect(section).toBeInstanceOf(HTMLElement);
      // The backend returns a folder named "Client work"
      expect(section?.textContent).toContain("Client work");
    });

    const cards = container.querySelectorAll(".drive-suggested-card");
    expect(cards.length).toBeGreaterThan(0);
  });

  it("renders suggested file rows inside drive-suggested-files section", async () => {
    renderDrive();
    await waitForText("Suggested files");

    await waitFor(() => {
      const section = container.querySelector(".drive-suggested-files");
      expect(section).toBeInstanceOf(HTMLElement);
      // Backend returns "Backend roadmap.pdf" as a file
      expect(section?.textContent).toContain("Backend roadmap.pdf");
    });
  });

  let lastDriveProps: ComponentProps<typeof DriveShell> | undefined;

  function renderDrive(props?: ComponentProps<typeof DriveShell>) {
    lastDriveProps = props;
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DriveShell {...props} />
        </QueryClientProvider>,
      );
    });
  }

  /**
   * The in-content Drive search field was removed in favor of the top-bar
   * search. Drive search is now driven by route state, so the test helper
   * re-renders the shell with an updated `routeState.query`.
   */
  async function typeSearch(value: string) {
    const baseRouteState = lastDriveProps?.routeState ?? {
      folderId: null,
      includeTrashed: false,
      query: "",
    };
    renderDrive({
      ...lastDriveProps,
      routeState: { ...baseRouteState, query: value },
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll("button"))
      .filter((candidate) => candidate.textContent?.includes(text))
      .findLast((candidate) => !candidate.classList.contains("drive-nav-item"));
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickNavButton(text: string) {
    const button = Array.from(container.querySelectorAll("button.drive-nav-item")).find(
      (candidate) => candidate.textContent?.includes(text),
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Navigation button not found: ${text}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function clickIconButton(label: string) {
    const button = container.querySelector(`button[aria-label="${label}"]`);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`Icon button not found: ${label}`);
    }
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function toggleItemSelection(name: string) {
    const checkbox = container.querySelector(`label[aria-label="Select ${name}"] input`);
    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error(`Selection checkbox not found: ${name}`);
    }
    act(() => {
      checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function findTableRow(text: string): Element | undefined {
    return Array.from(container.querySelectorAll("tr[aria-rowindex]")).find((row) =>
      row.textContent?.includes(text),
    );
  }

  async function uploadFiles(files: readonly File[]) {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error("Drive upload input not found.");
    }
    act(() => {
      Object.defineProperty(input, "files", {
        configurable: true,
        value: fileList(files),
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  function fileList(files: readonly File[]): FileList {
    return Object.assign([...files], {
      item: (index: number) => files[index] ?? null,
    });
  }

  async function setDialogFieldValue(label: string, value: string) {
    const field = Array.from(container.querySelectorAll(".helix-dialog .drive-field")).find(
      (candidate) => candidate.querySelector("span")?.textContent === label,
    );
    const input = field?.querySelector("input, select");
    if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement)) {
      throw new Error(`Dialog field not found: ${label}`);
    }
    act(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")
        ?.set as ((this: HTMLInputElement | HTMLSelectElement, value: string) => void) | undefined;
      if (valueSetter !== undefined) {
        Reflect.apply(valueSetter, input, [value]);
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function waitForText(text: string) {
    await waitFor(() => expect(container.textContent).toContain(text));
  }

  async function waitFor(assertion: () => void | Promise<void>) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await act(async () => {
          await Promise.resolve();
        });
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
    }
    throw lastError;
  }
});

function lastSuggestionContext(slotId: string): unknown {
  const call = suggestionSlotHarness.calls.findLast((candidate) => candidate.slotId === slotId);
  if (call === undefined) {
    throw new Error(`Suggestion slot not rendered: ${slotId}`);
  }
  return call.context;
}

function jsonBody(call: readonly [RequestInfo | URL, RequestInit?] | undefined): unknown {
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error("Expected JSON request body.");
  }
  return JSON.parse(body) as unknown;
}
