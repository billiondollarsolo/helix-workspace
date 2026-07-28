// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/require-await -- PDF viewer tests use jsdom/pdf-lib mocks and React act wrappers. */

import { act } from "react";
import { QueryClient } from "@tanstack/react-query";
import { createWebPlatformHost, WebPlatformProvider, type WebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/lib/auth";
import {
  NativePdfViewer,
  type NativePdfViewerProps,
  redactionRectToPdfCoordinates,
  stampPointToPdfCoordinates,
} from "./native-pdf-viewer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const pdfMock = vi.hoisted(() => ({
  load: vi.fn(),
  create: vi.fn(),
  setName: vi.fn(),
  checkApproval: vi.fn(),
  uncheckApproval: vi.fn(),
  selectRegion: vi.fn(),
  getRotation: vi.fn(() => ({ angle: 90 })),
  setRotation: vi.fn(),
  removePage: vi.fn(),
  insertPage: vi.fn(),
  copyPages: vi.fn(),
  addPage: vi.fn(),
  embedPng: vi.fn(),
  drawImage: vi.fn(),
  getPage: vi.fn(),
  degrees: vi.fn((angle: number) => ({ angle })),
  rgb: vi.fn((r: number, g: number, b: number) => ({ r, g, b })),
  getWidth: vi.fn(() => 600),
  getHeight: vi.fn(() => 800),
  drawRectangle: vi.fn(),
  drawText: vi.fn(),
  save: vi.fn(() => Promise.resolve(new Uint8Array([9, 8, 7]))),
}));

const SOURCE_FOLDER_ID = "folder-review-pdfs";

const pdfJsMock = vi.hoisted(() => ({
  getDocument: vi.fn(),
  getPage: vi.fn(),
  getOutline: vi.fn(),
  getDestination: vi.fn(),
  getPageIndex: vi.fn(),
  renderPage: vi.fn(),
  getTextContent: vi.fn(),
  destroy: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdf-lib", () => ({
  degrees: pdfMock.degrees,
  rgb: pdfMock.rgb,
  PDFDocument: {
    create: pdfMock.create,
    load: pdfMock.load,
  },
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: pdfJsMock.GlobalWorkerOptions,
  getDocument: pdfJsMock.getDocument,
}));

vi.mock("@/lib/auth", () => ({
  authenticatedFetch: vi.fn(),
}));

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let platformHost: WebPlatformHost;
let comments: PdfCommentFixture[];
let pdfFormState: PdfFormStateFixture | null;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let clipboardWriteText: ReturnType<typeof vi.fn>;
let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;
let originalGetContext: typeof HTMLCanvasElement.prototype.getContext | undefined;
let originalToDataURL: typeof HTMLCanvasElement.prototype.toDataURL | undefined;
let canvasFillRect: ReturnType<typeof vi.fn>;

interface PdfCommentFixture {
  readonly id: string;
  readonly objectId: string;
  readonly actorId: string | null;
  readonly anchor: Record<string, unknown>;
  readonly body: string;
  readonly parentCommentId?: string | null;
  readonly status: "open" | "resolved";
  readonly metadata: Record<string, unknown>;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
}

interface PdfFormStateFixture {
  readonly objectId: string;
  readonly actorId: string;
  readonly fieldValues: readonly {
    readonly name: string;
    readonly type?: "text" | "checkbox" | "choice" | "signature" | "unsupported";
    readonly value: string | boolean;
  }[];
  readonly sourceVersionNumber: number | null;
  readonly sourceSha256: string | null;
  readonly sourceByteSize: number | null;
  readonly sourceChanged: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

describe("NativePdfViewer", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient();
    platformHost = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
    window.localStorage.clear();
    comments = [];
    pdfFormState = null;
    toolCalls = [];
    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/drive.comment.list") {
        const list = body as { readonly status?: "open" | "resolved" | "all" };
        return Promise.resolve(
          Response.json({
            comments:
              list.status === undefined || list.status === "all"
                ? comments
                : comments.filter((comment) => comment.status === list.status),
          }),
        );
      }
      if (url === "/api/tools/drive.comment.create") {
        const create = body as {
          readonly objectId: string;
          readonly parentCommentId?: string;
          readonly body: string;
          readonly anchor: Record<string, unknown>;
          readonly metadata?: Record<string, unknown>;
        };
        const comment: PdfCommentFixture = {
          id: `comment-${comments.length + 1}`,
          objectId: create.objectId,
          actorId: "actor-1",
          parentCommentId: create.parentCommentId ?? null,
          anchor: create.anchor,
          body: create.body,
          status: "open",
          metadata: create.metadata ?? {},
          resolvedAt: null,
          createdAt: "2026-05-24T14:00:00.000Z",
          updatedAt: null,
        };
        comments = [...comments, comment];
        return Promise.resolve(Response.json(comment));
      }
      if (url === "/api/tools/drive.comment.resolve") {
        const resolve = body as { readonly commentId: string };
        comments = comments.map((comment) =>
          comment.id === resolve.commentId
            ? {
                ...comment,
                status: "resolved",
                resolvedAt: "2026-05-24T14:05:00.000Z",
                updatedAt: "2026-05-24T14:05:00.000Z",
              }
            : comment,
        );
        return Promise.resolve(
          Response.json(comments.find((comment) => comment.id === resolve.commentId)),
        );
      }
      if (url === "/api/tools/drive.comment.reopen") {
        const reopen = body as { readonly commentId: string };
        comments = comments.map((comment) =>
          comment.id === reopen.commentId
            ? {
                ...comment,
                status: "open",
                resolvedAt: null,
                updatedAt: "2026-05-24T14:10:00.000Z",
              }
            : comment,
        );
        return Promise.resolve(
          Response.json(comments.find((comment) => comment.id === reopen.commentId)),
        );
      }
      if (url === "/api/tools/drive.comment.update") {
        const update = body as { readonly commentId: string; readonly body: string };
        comments = comments.map((comment) =>
          comment.id === update.commentId
            ? {
                ...comment,
                body: update.body,
                updatedAt: "2026-05-24T14:12:00.000Z",
              }
            : comment,
        );
        return Promise.resolve(
          Response.json(comments.find((comment) => comment.id === update.commentId)),
        );
      }
      if (url === "/api/tools/drive.comment.delete") {
        const remove = body as { readonly commentId: string };
        const deleted = comments.find((comment) => comment.id === remove.commentId);
        comments = comments.filter(
          (comment) => comment.id !== remove.commentId && comment.parentCommentId !== remove.commentId,
        );
        return Promise.resolve(Response.json(deleted));
      }
      if (url === "/api/tools/drive.pdfFormState.get") {
        return Promise.resolve(Response.json({ state: pdfFormState }));
      }
      if (url === "/api/tools/drive.pdfFormState.save") {
        const save = body as {
          readonly objectId: string;
          readonly fields: PdfFormStateFixture["fieldValues"];
        };
        pdfFormState = {
          objectId: save.objectId,
          actorId: "actor-1",
          fieldValues: save.fields,
          sourceVersionNumber: 1,
          sourceSha256: "0".repeat(64),
          sourceByteSize: 3,
          sourceChanged: false,
          createdAt: "2026-05-24T15:10:00.000Z",
          updatedAt: "2026-05-24T15:10:00.000Z",
        };
        return Promise.resolve(Response.json(pdfFormState));
      }
      if (url === "/api/tools/drive.pdfFormState.clear") {
        const clear = body as { readonly objectId: string };
        const cleared = pdfFormState !== null;
        pdfFormState = null;
        return Promise.resolve(Response.json({ objectId: clear.objectId, cleared }));
      }
      if (url === "/api/tools/drive.upload") {
        const upload = body as {
          readonly name: string;
          readonly folderId?: string | null;
          readonly mimeType: string;
          readonly byteSize: number;
        };
        return Promise.resolve(
          Response.json({
            objectId: "drive-pdf-copy-1",
            orgId: "org-1",
            ownerActorId: "actor-1",
            name: upload.name,
            folderId: upload.folderId ?? null,
            storageKey: `drive/pdf/${upload.name}`,
            mimeType: upload.mimeType,
            byteSize: upload.byteSize,
            sha256: "0".repeat(64),
            status: "prepared",
            uploadUrl: null,
            uploadHeaders: {},
            metadata: {},
            createdAt: "2026-05-24T15:00:00.000Z",
            updatedAt: "2026-05-24T15:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/drive.finalize") {
        const finalize = body as {
          readonly objectId: string;
          readonly storageKey?: string;
          readonly mimeType?: string;
          readonly byteSize: number;
        };
        return Promise.resolve(
          Response.json({
            id: "drive-pdf-copy-version-1",
            orgId: "org-1",
            objectId: finalize.objectId,
            versionNumber: 1,
            storageKey: finalize.storageKey ?? "drive/pdf/pdf-copy.pdf",
            mimeType: finalize.mimeType ?? "application/pdf",
            byteSize: finalize.byteSize,
            sha256: "0".repeat(64),
            metadata: {},
            createdByActorId: "actor-1",
            createdAt: "2026-05-24T15:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    });
    pdfMock.load.mockReset();
    pdfMock.create.mockReset();
    pdfMock.create.mockResolvedValue(fakeExtractPdfDocument());
    pdfMock.setName.mockReset();
    pdfMock.checkApproval.mockReset();
    pdfMock.uncheckApproval.mockReset();
    pdfMock.selectRegion.mockReset();
    pdfMock.getRotation.mockReset();
    pdfMock.getRotation.mockReturnValue({ angle: 90 });
    pdfMock.setRotation.mockReset();
    pdfMock.removePage.mockReset();
    pdfMock.insertPage.mockReset();
    pdfMock.copyPages.mockReset();
    pdfMock.copyPages.mockImplementation((_source, indexes: readonly number[]) =>
      Promise.resolve(indexes.map((index) => `copied-page-${String(index + 1)}`)),
    );
    pdfMock.addPage.mockReset();
    pdfMock.addPage.mockImplementation(() => ({ drawImage: pdfMock.drawImage }));
    pdfMock.embedPng.mockReset();
    pdfMock.embedPng.mockResolvedValue("redacted-page-image");
    pdfMock.drawImage.mockReset();
    pdfMock.degrees.mockClear();
    pdfMock.rgb.mockClear();
    pdfMock.getPage.mockReset();
    pdfMock.getWidth.mockReset();
    pdfMock.getWidth.mockReturnValue(600);
    pdfMock.getHeight.mockReset();
    pdfMock.getHeight.mockReturnValue(800);
    pdfMock.drawRectangle.mockReset();
    pdfMock.drawText.mockReset();
    pdfMock.save.mockClear();
    pdfMock.save.mockResolvedValue(new Uint8Array([9, 8, 7]));
    pdfMock.load.mockImplementation(() => Promise.resolve(fakePdfDocument()));
    pdfJsMock.getDocument.mockReset();
    pdfJsMock.getPage.mockReset();
    pdfJsMock.getOutline.mockReset();
    pdfJsMock.getDestination.mockReset();
    pdfJsMock.getPageIndex.mockReset();
    pdfJsMock.renderPage.mockReset();
    pdfJsMock.getTextContent.mockReset();
    pdfJsMock.destroy.mockReset();
    pdfJsMock.GlobalWorkerOptions.workerSrc = "";
    pdfJsMock.getDocument.mockImplementation(() => ({
      promise: Promise.resolve(fakePdfJsDocument()),
    }));
    pdfJsMock.renderPage.mockImplementation(() => ({ promise: Promise.resolve() }));
    setPdfTextByPage({
      1: "Acme renewal summary",
      2: "Forecast evidence",
      3: "Appendix approvals",
    });
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:filled-pdf"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    clipboardWriteText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    originalGetContext = HTMLCanvasElement.prototype.getContext;
    originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    canvasFillRect = vi.fn();
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(
        () =>
          ({
            fillRect: canvasFillRect,
          }) as unknown as CanvasRenderingContext2D,
      ),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: vi.fn(() => "data:image/png;base64,thumbnail"),
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    queryClient.clear();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectURL,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: originalGetContext,
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: originalToDataURL,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps displayed redaction rectangles into rotated PDF page coordinates", () => {
    const rect = { x: 10, y: 10, width: 10, height: 20 };

    expect(redactionRectToPdfCoordinates(rect, 600, 800, 0)).toEqual({
      x: 60,
      y: 560,
      width: 60,
      height: 160,
    });
    expect(redactionRectToPdfCoordinates(rect, 600, 800, 90)).toEqual({
      x: 60,
      y: 80,
      width: 120,
      height: 80,
    });
    expect(redactionRectToPdfCoordinates(rect, 600, 800, 180)).toEqual({
      x: 480,
      y: 80,
      width: 60,
      height: 160,
    });
    expect(redactionRectToPdfCoordinates(rect, 600, 800, 270)).toEqual({
      x: 420,
      y: 640,
      width: 120,
      height: 80,
    });
    expect(redactionRectToPdfCoordinates(rect, 600, 800, -90)).toEqual({
      x: 420,
      y: 640,
      width: 120,
      height: 80,
    });
  });

  it("maps displayed stamp points into rotated PDF page coordinates", () => {
    const point = { x: 10, y: 20 };

    expect(stampPointToPdfCoordinates(point, 600, 800, 0)).toEqual({ x: 60, y: 640 });
    expect(stampPointToPdfCoordinates(point, 600, 800, 90)).toEqual({ x: 120, y: 80 });
    expect(stampPointToPdfCoordinates(point, 600, 800, 180)).toEqual({ x: 540, y: 160 });
    expect(stampPointToPdfCoordinates(point, 600, 800, 270)).toEqual({ x: 480, y: 720 });
    expect(stampPointToPdfCoordinates(point, 600, 800, -90)).toEqual({ x: 480, y: 720 });
  });

  it("renders Drive PDF content with page, zoom, fillable fields, and filled-copy download", async () => {
    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: { page: 1, zoom: 100, commentId: null, sourceFolderId: SOURCE_FOLDER_ID },
      });
    });
    await settle();

    expect(renderedPage().getAttribute("data-page")).toBe("1");
    expect(renderedPage().getAttribute("data-zoom")).toBe("100");
    expect(downloadLink().href).toContain("/api/drive/objects/pdf%20object%2F1/content?download=1");
    expect(input("Customer name").value).toBe("Acme");
    expect(checkbox("Approved").checked).toBe(false);
    expect(select("Region").value).toBe("EMEA");
    expect(container.textContent).toContain("/ 3");
    expect(container.textContent).toContain("Page 3");
    expect(button("PDF thumbnail page 3")).toBeDefined();
    expect(button("PDF thumbnail page 3").querySelector("img")).not.toBeNull();
    expect(renderedPage().src).toBe("data:image/png;base64,thumbnail");
    expect(textLayer().textContent).toContain("Acme renewal summary");
    expect(pdfJsMock.getTextContent).toHaveBeenCalled();
    await changeInput("Find PDF text", "renewal");
    await settle();
    expect(container.textContent).toContain("1/1");
    expect(
      container.querySelector('[aria-label="PDF text match: Acme renewal summary"]'),
    ).not.toBeNull();
    await changeTextarea("PDF comment", "Anchor renewal text");
    await clickButton("Comment on match");
    await settle();
    const textCommentBody = latestToolBody("/api/tools/drive.comment.create");
    expect(textCommentBody).toContain('"kind":"pdf-text-match"');
    expect(textCommentBody).toContain('"target":"text"');
    expect(textCommentBody).toContain('"quote":"Acme renewal summary"');
    expect(textCommentBody).toContain('"rects"');
    expect(button("PDF text anchor: Anchor renewal text")).toBeDefined();
    expect(list("PDF outline").textContent).toContain("Executive summary");
    expect(list("PDF outline").textContent).toContain("Appendix");
    expect(list("PDF outline").textContent).toContain("125%");
    expect(pdfJsMock.getDocument).toHaveBeenCalled();
    expect(pdfJsMock.renderPage.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/tools/drive.comment.list",
      expect.objectContaining({ body: expect.stringContaining('"status":"open"') }),
    );

    act(() => {
      button("PDF thumbnail page 2").click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("2");
    expect(renderedPage().getAttribute("data-zoom")).toBe("100");

    act(() => {
      button("Outline Evidence").click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("3");
    expect(renderedPage().getAttribute("data-zoom")).toBe("125");

    act(() => {
      pageButton(1).click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("1");
    expect(renderedPage().getAttribute("data-zoom")).toBe("125");

    act(() => {
      button("Next page").click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("2");
    expect(renderedPage().getAttribute("data-zoom")).toBe("125");

    act(() => {
      button("Zoom in").click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("2");
    expect(renderedPage().getAttribute("data-zoom")).toBe("135");

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(pageInput(), "5");
      pageInput().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("3");
    expect(renderedPage().getAttribute("data-zoom")).toBe("135");
    expect(pageInput().value).toBe("3");

    act(() => {
      pageButton(1).click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("1");
    expect(renderedPage().getAttribute("data-zoom")).toBe("135");

    await changeTextarea("PDF comment", "Review numbers on this page");
    await clickButton("Place pin");
    setPdfStageRect({ left: 0, top: 0, width: 800, height: 600 });
    setPdfPlacementOverlayRect({ left: 10, top: 20, width: 400, height: 200 });
    await clickPdfPlacementOverlay(110, 120);
    expect(container.textContent).toContain("25%, 50%");
    await clickButton("Add comment");
    await settle();
    expect(list("PDF comments").textContent).toContain("Review numbers on this page");
    expect(button("PDF comment pin: Review numbers on this page")).toBeDefined();
    expect(list("PDF comments").querySelector('[aria-current="true"]')?.textContent).toContain(
      "Review numbers on this page",
    );
    expect(pageButtonByLabel("Page 1").textContent?.trim()).not.toBe("Page 1");
    const createdCommentBody = latestToolBody("/api/tools/drive.comment.create");
    expect(createdCommentBody).toContain('"page":1');
    expect(createdCommentBody).toContain('"target":"point"');
    expect(createdCommentBody).toContain('"units":"percent"');
    expect(createdCommentBody).toContain('"x":25');
    expect(createdCommentBody).toContain('"y":50');

    await changeTextarea("Reply to Review numbers on this page", "Agreed for finance review");
    await clickReplyButton("Review numbers on this page");
    await settle();
    expect(list("PDF comments").textContent).toContain("Agreed for finance review");
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/tools/drive.comment.create",
      expect.objectContaining({
        body: expect.stringContaining('"parentCommentId":"comment-2"'),
      }),
    );

    act(() => {
      button("Next page").click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("2");
    expect(renderedPage().getAttribute("data-zoom")).toBe("135");
    act(() => {
      commentPageButton(1).click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("1");
    expect(renderedPage().getAttribute("data-zoom")).toBe("135");
    await clickButton("Copy page link");
    expect(clipboardWriteText).toHaveBeenLastCalledWith(expect.stringContaining("page=1&zoom=135"));
    await clickButton("Copy comment link: Review numbers on this page");
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      expect.stringContaining("comment=comment-2"),
    );
    await clickButton("Copy annotation link: Review numbers on this page");
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      expect.stringContaining("annotation=comment-2"),
    );
    expect(clipboardWriteText).toHaveBeenLastCalledWith(expect.stringContaining("page=1&zoom=135"));
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      expect.stringContaining(`folder=${SOURCE_FOLDER_ID}`),
    );
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      expect.not.stringContaining("comment=comment-2"),
    );

    await clickResolveButton("Review numbers on this page");
    await settle();
    expect(list("PDF comments").textContent).toContain("Agreed for finance review");
    expect(list("PDF comments").textContent).not.toContain("Review numbers on this page");
    expect(
      container.querySelector('[aria-label="PDF comment pin: Review numbers on this page"]'),
    ).toBeNull();
    expect(pageButtonByLabel("Page 1").textContent?.trim()).not.toBe("Page 1");

    await changeSelect("PDF comment status", "resolved");
    await settle();
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/tools/drive.comment.list",
      expect.objectContaining({ body: expect.stringContaining('"status":"resolved"') }),
    );
    expect(list("PDF comments").textContent).toContain("Review numbers on this page");
    expect(list("PDF comments").textContent).toContain("Resolved");

    await changeSelect("PDF comment status", "all");
    await settle();
    expect(vi.mocked(authenticatedFetch)).toHaveBeenCalledWith(
      "/api/tools/drive.comment.list",
      expect.objectContaining({ body: expect.stringContaining('"status":"all"') }),
    );
    expect(list("PDF comments").textContent).toContain("Review numbers on this page");
    expect(list("PDF comments").textContent).toContain("Agreed for finance review");

    await changeInput("Customer name", "Northwind");
    await changeCheckbox("Approved", true);
    await changeSelect("Region", "NA");
    await clickButton("Download filled copy");
    await settle();

    expect(pdfMock.setName).toHaveBeenCalledWith("Northwind");
    expect(pdfMock.checkApproval).toHaveBeenCalled();
    expect(pdfMock.selectRegion).toHaveBeenCalledWith("NA");
    expect(pdfMock.save).toHaveBeenCalled();

    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save filled copy to Drive");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-filled.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    expect(typeof lastToolCallBody("/api/tools/drive.finalize").contentBase64).toBe("string");
    digestSpy.mockRestore();

    await clickButton("Place redaction");
    setPdfPlacementOverlayRect({ left: 10, top: 20, width: 400, height: 200 });
    await dragPdfRedaction(110, 70, 310, 170);
    expect(container.querySelectorAll('[aria-label="Pending PDF redaction"]')).toHaveLength(1);
    expect(list("Pending PDF redactions").textContent).toContain("Page 1");
    act(() => {
      button("Next page").click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("2");
    expect(container.querySelectorAll('[aria-label="Pending PDF redaction"]')).toHaveLength(0);
    expect(list("Pending PDF redactions").children).toHaveLength(1);
    await clickButton("Place redaction");
    setPdfPlacementOverlayRect({ left: 10, top: 20, width: 400, height: 200 });
    await dragPdfRedaction(50, 40, 90, 80);
    expect(container.querySelectorAll('[aria-label="Pending PDF redaction"]')).toHaveLength(1);
    expect(list("Pending PDF redactions").children).toHaveLength(2);
    expect(list("Pending PDF redactions").textContent).toContain("Page 2");
    expect(container.textContent).toContain("2 regions");
    act(() => {
      button("Previous page").click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("1");
    expect(container.querySelectorAll('[aria-label="Pending PDF redaction"]')).toHaveLength(1);

    pdfMock.save.mockClear();
    pdfMock.create.mockClear();
    pdfMock.copyPages.mockClear();
    pdfMock.addPage.mockClear();
    pdfMock.embedPng.mockClear();
    pdfMock.drawImage.mockClear();
    canvasFillRect.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await clickButton("Download redacted copy");
    await settle();

    expect(pdfMock.getWidth).toHaveBeenCalled();
    expect(pdfMock.getHeight).toHaveBeenCalled();
    expect(pdfMock.create).toHaveBeenCalled();
    expect(canvasFillRect).toHaveBeenNthCalledWith(1, 22.75, 30.25, 45.5, 60.5);
    expect(canvasFillRect).toHaveBeenNthCalledWith(
      2,
      9.200000000000001,
      12.200000000000001,
      9.200000000000001,
      24.400000000000002,
    );
    expect(pdfMock.embedPng).toHaveBeenCalledWith("data:image/png;base64,thumbnail");
    expect(pdfMock.embedPng).toHaveBeenCalledTimes(2);
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(1, [600, 800]);
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(2, [600, 800]);
    expect(pdfMock.drawImage).toHaveBeenCalledWith("redacted-page-image", {
      x: 0,
      y: 0,
      width: 600,
      height: 800,
    });
    expect(pdfMock.copyPages).toHaveBeenCalledTimes(1);
    expect(pdfMock.copyPages).toHaveBeenNthCalledWith(1, expect.anything(), [2]);
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const redactionDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save redacted copy to Drive");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-redacted.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    redactionDigestSpy.mockRestore();

    await clickButton("Save redaction annotations");
    await settle();
    const redactionCommentCreates = toolCalls
      .filter((call) => call.url === "/api/tools/drive.comment.create")
      .map((call) => call.body as { readonly anchor?: Record<string, unknown> })
      .filter((body) => body.anchor?.kind === "pdf-redaction");
    expect(redactionCommentCreates).toHaveLength(2);
    expect(redactionCommentCreates[0]?.anchor).toMatchObject({
      kind: "pdf-redaction",
      target: "redaction",
      units: "percent",
      objectId: "pdf object/1",
      page: 1,
      x: 25,
      y: 25,
      width: 50,
      height: 50,
    });
    expect(redactionCommentCreates[1]?.anchor).toMatchObject({
      kind: "pdf-redaction",
      target: "redaction",
      page: 2,
      x: 10,
      y: 10,
      width: 10,
      height: 20,
    });
    expect(container.querySelector('ol[aria-label="Pending PDF redactions"]')).toBeNull();
    expect(list("PDF comments").textContent).toContain("Redaction on page 1");
    expect(list("PDF comments").textContent).toContain("Page 1 · redaction 25%, 25%");
    expect(button("PDF redaction annotation: Redaction on page 1")).toBeDefined();
    await clickButton("Copy annotation link: Redaction on page 1");
    expect(clipboardWriteText).toHaveBeenLastCalledWith(expect.stringContaining("annotation="));

    pdfMock.getRotation.mockReturnValueOnce({ angle: 0 });
    await clickButton("Rotate left");
    await settle();

    expect(pdfMock.getRotation).toHaveBeenCalled();
    expect(pdfMock.degrees).toHaveBeenCalledWith(270);
    expect(pdfMock.setRotation).toHaveBeenCalledWith({ angle: 270 });
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    pdfMock.getRotation.mockClear();
    pdfMock.getRotation.mockReturnValue({ angle: 90 });
    pdfMock.degrees.mockClear();
    pdfMock.setRotation.mockClear();
    await clickButton("Rotate right");
    await settle();

    expect(pdfMock.getRotation).toHaveBeenCalled();
    expect(pdfMock.degrees).toHaveBeenCalledWith(180);
    expect(pdfMock.setRotation).toHaveBeenCalledWith({ angle: 180 });
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const rotatedPageDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save rotated right");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-page-1-rotated-right.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    rotatedPageDigestSpy.mockRestore();

    await clickButton("Extract page");
    await settle();

    expect(pdfMock.create).toHaveBeenCalled();
    expect(pdfMock.copyPages).toHaveBeenCalledWith(expect.anything(), [0]);
    expect(pdfMock.addPage).toHaveBeenCalledWith("copied-page-1");
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const extractedPageDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save extracted page");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-page-1.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    extractedPageDigestSpy.mockRestore();

    pdfMock.create.mockClear();
    pdfMock.copyPages.mockClear();
    pdfMock.addPage.mockClear();
    pdfMock.save.mockClear();
    vi.mocked(URL.createObjectURL).mockClear();
    vi.mocked(URL.revokeObjectURL).mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await clickButton("Split pages");
    await settle();

    expect(pdfMock.create).toHaveBeenCalledTimes(3);
    expect(pdfMock.copyPages).toHaveBeenNthCalledWith(1, expect.anything(), [0]);
    expect(pdfMock.copyPages).toHaveBeenNthCalledWith(2, expect.anything(), [1]);
    expect(pdfMock.copyPages).toHaveBeenNthCalledWith(3, expect.anything(), [2]);
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(1, "copied-page-1");
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(2, "copied-page-2");
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(3, "copied-page-3");
    expect(pdfMock.save).toHaveBeenCalledTimes(3);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const zipBlob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    expect(zipBlob).toBeInstanceOf(Blob);
    expect((zipBlob as Blob).type).toBe("application/zip");
    const zipText = new TextDecoder().decode(await (zipBlob as Blob).arrayBuffer());
    expect(zipText.startsWith("PK")).toBe(true);
    expect(zipText).toContain("pdf-object-1-page-001.pdf");
    expect(zipText).toContain("pdf-object-1-page-002.pdf");
    expect(zipText).toContain("pdf-object-1-page-003.pdf");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);

    const splitDigestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save split pages");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-split-pages.zip",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/zip",
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      sha256: "0".repeat(64),
      mimeType: "application/zip",
      metadata: { source: "web-shell" },
    });
    splitDigestSpy.mockRestore();

    pdfMock.removePage.mockClear();
    pdfMock.insertPage.mockClear();
    pdfMock.save.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await clickButton("Move page later");
    await settle();

    expect(pdfMock.removePage).toHaveBeenCalledWith(0);
    expect(pdfMock.insertPage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ setRotation: pdfMock.setRotation }),
    );
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const movedLaterDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save moved later");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-page-1-moved-later.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    movedLaterDigestSpy.mockRestore();

    act(() => {
      button("Next page").click();
    });
    await settle();
    pdfMock.removePage.mockClear();
    pdfMock.insertPage.mockClear();
    pdfMock.save.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await clickButton("Move page earlier");
    await settle();

    expect(pdfMock.removePage).toHaveBeenCalledWith(1);
    expect(pdfMock.insertPage).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ setRotation: pdfMock.setRotation }),
    );
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const movedEarlierDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save moved earlier");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-page-2-moved-earlier.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    movedEarlierDigestSpy.mockRestore();

    await clickButton("Delete page");
    await settle();

    expect(pdfMock.removePage).toHaveBeenCalledWith(1);
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const deletedPageDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save without page");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-without-page-2.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    deletedPageDigestSpy.mockRestore();

    expect(button("Download reordered PDF").disabled).toBe(true);
    pdfMock.load.mockClear();
    pdfMock.save.mockClear();
    await dragPageThumbnail(1, 1);
    await settle();
    expect(button("Download reordered PDF").disabled).toBe(true);
    expect(pdfMock.load).not.toHaveBeenCalled();
    expect(pdfMock.save).not.toHaveBeenCalled();

    await dragPageThumbnail(3, 1);
    await settle();
    expect(pageButtonOrder()).toEqual([3, 1, 2]);

    pdfMock.load.mockClear();
    pdfMock.getPage.mockClear();
    pdfMock.removePage.mockClear();
    pdfMock.insertPage.mockClear();
    pdfMock.save.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await clickButton("Download reordered PDF");
    await settle();

    expect(pdfMock.getPage).toHaveBeenCalledWith(2);
    expect(pdfMock.removePage).toHaveBeenCalledWith(2);
    expect(pdfMock.insertPage).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ setRotation: pdfMock.setRotation }),
    );
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const reorderedDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save reordered PDF");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-reordered.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    reorderedDigestSpy.mockRestore();

    pdfMock.load.mockClear();
    pdfMock.copyPages.mockClear();
    pdfMock.addPage.mockClear();
    pdfMock.insertPage.mockClear();
    pdfMock.save.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    expect(select("PDF merge placement").value).toBe("append");
    await uploadFile(
      "Merge PDF file",
      new File(["merged"], "appendix.pdf", { type: "application/pdf" }),
    );
    await settle();

    expect(pdfMock.load).toHaveBeenCalledTimes(2);
    expect(pdfMock.copyPages).toHaveBeenCalledWith(expect.anything(), [0, 1, 2]);
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(1, "copied-page-1");
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(2, "copied-page-2");
    expect(pdfMock.addPage).toHaveBeenNthCalledWith(3, "copied-page-3");
    expect(pdfMock.insertPage).not.toHaveBeenCalled();
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();

    const mergedDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await uploadFile(
      "Save merged PDF file",
      new File(["merged"], "appendix.pdf", { type: "application/pdf" }),
    );
    await settle();

    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-merged.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    mergedDigestSpy.mockRestore();

    pdfMock.load.mockClear();
    pdfMock.copyPages.mockClear();
    pdfMock.addPage.mockClear();
    pdfMock.insertPage.mockClear();
    pdfMock.save.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await changeSelect("PDF merge placement", "prepend");
    await uploadFile(
      "Merge PDF file",
      new File(["merged"], "front-matter.pdf", { type: "application/pdf" }),
    );
    await settle();

    expect(pdfMock.copyPages).toHaveBeenCalledWith(expect.anything(), [0, 1, 2]);
    expect(pdfMock.addPage).not.toHaveBeenCalled();
    expect(pdfMock.insertPage).toHaveBeenNthCalledWith(1, 0, "copied-page-1");
    expect(pdfMock.insertPage).toHaveBeenNthCalledWith(2, 1, "copied-page-2");
    expect(pdfMock.insertPage).toHaveBeenNthCalledWith(3, 2, "copied-page-3");
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();

    act(() => {
      pageButton(2).click();
    });
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("2");

    pdfMock.load.mockClear();
    pdfMock.copyPages.mockClear();
    pdfMock.addPage.mockClear();
    pdfMock.insertPage.mockClear();
    pdfMock.save.mockClear();
    const mergeAfterPageDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await changeSelect("PDF merge placement", "after-current-page");
    await uploadFile(
      "Save merged PDF file",
      new File(["merged"], "page-two-appendix.pdf", { type: "application/pdf" }),
    );
    await settle();

    expect(pdfMock.copyPages).toHaveBeenCalledWith(expect.anything(), [0, 1, 2]);
    expect(pdfMock.addPage).not.toHaveBeenCalled();
    expect(pdfMock.insertPage).toHaveBeenNthCalledWith(1, 2, "copied-page-1");
    expect(pdfMock.insertPage).toHaveBeenNthCalledWith(2, 3, "copied-page-2");
    expect(pdfMock.insertPage).toHaveBeenNthCalledWith(3, 4, "copied-page-3");
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-merged.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    mergeAfterPageDigestSpy.mockRestore();
  });

  it("places persisted PDF review stamp annotations", async () => {
    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: { page: 1, zoom: 100, commentId: null, sourceFolderId: SOURCE_FOLDER_ID },
      });
    });
    await settle();

    await changeSelect("PDF review stamp", "needs-review");
    await clickButton("Place stamp");
    setPdfStageRect({ left: 0, top: 0, width: 800, height: 600 });
    setPdfPlacementOverlayRect({ left: 10, top: 20, width: 400, height: 200 });
    await clickPdfPlacementOverlay(210, 120);
    await settle();

    const stampCommentBody = latestToolBody("/api/tools/drive.comment.create");
    expect(stampCommentBody).toContain('"kind":"pdf-stamp"');
    expect(stampCommentBody).toContain('"target":"stamp"');
    expect(stampCommentBody).toContain('"units":"percent"');
    expect(stampCommentBody).toContain('"stamp":"needs-review"');
    expect(stampCommentBody).toContain('"label":"Needs review"');
    expect(stampCommentBody).toContain('"x":50');
    expect(stampCommentBody).toContain('"y":50');
    expect(list("PDF comments").textContent).toContain("Needs review review stamp");
    expect(list("PDF comments").textContent).toContain("Page 1 · Needs review stamp 50%, 50%");
    expect(button("PDF stamp annotation: Needs review review stamp")).toBeDefined();
    expect(
      button("PDF stamp annotation: Needs review review stamp").getAttribute("data-selected"),
    ).toBe("true");

    await clickButton("Copy annotation link: Needs review review stamp");
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      expect.stringContaining("annotation=comment-1"),
    );
    expect(clipboardWriteText).toHaveBeenLastCalledWith(expect.stringContaining("page=1&zoom=100"));
  });

  it("persists and renders PDF freehand draw annotations", async () => {
    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: { page: 1, zoom: 100, commentId: null, sourceFolderId: SOURCE_FOLDER_ID },
      });
    });
    await settle();

    await changeTextarea("PDF comment", "Circle the renewal risk");
    await clickButton("Draw annotation");
    setPdfPlacementOverlayRect({ left: 10, top: 20, width: 400, height: 200 });
    await dragPdfFreehandAnnotation([
      [50, 40],
      [210, 80],
      [330, 170],
    ]);
    await settle();

    const freehandCommentBody = latestToolBody("/api/tools/drive.comment.create");
    expect(freehandCommentBody).toContain('"kind":"pdf-freehand"');
    expect(freehandCommentBody).toContain('"target":"draw"');
    expect(freehandCommentBody).toContain('"units":"percent"');
    expect(freehandCommentBody).toContain('"strokeColor":"#2563eb"');
    expect(freehandCommentBody).toContain('"strokeWidth":3');
    expect(freehandCommentBody).toContain('"points":[{"x":10,"y":10},{"x":50,"y":30},{"x":80,"y":75}]');
    expect(list("PDF comments").textContent).toContain("Circle the renewal risk");
    expect(list("PDF comments").textContent).toContain("Page 1 · freehand annotation 3 points");
    expect(
      container.querySelector('[aria-label="PDF freehand annotation: Circle the renewal risk"]'),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[aria-label="PDF freehand annotations"]')
        ?.getAttribute("viewBox"),
    ).toBe("0 0 100 100");

    await clickButton("Copy annotation link: Circle the renewal risk");
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      expect.stringContaining("annotation=comment-1"),
    );
  });

  it("registers PDF command palette actions for viewer controls and filled copies", async () => {
    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: { page: 1, zoom: 100, commentId: null, sourceFolderId: SOURCE_FOLDER_ID },
      });
    });
    await settle();

    expect(platformHost.getCommandPaletteItems().map((item) => item.label)).toEqual([
      "Find in PDF",
      "Previous PDF page",
      "Next PDF page",
      "Zoom in PDF",
      "Zoom out PDF",
      "Copy PDF page link",
      "Download filled PDF copy",
      "Save filled PDF copy to Drive",
    ]);

    await runPdfCommand("Find in PDF");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Find PDF text");

    await runPdfCommand("Next PDF page");
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("2");

    await runPdfCommand("Previous PDF page");
    await settle();
    expect(renderedPage().getAttribute("data-page")).toBe("1");

    await runPdfCommand("Zoom in PDF");
    await settle();
    expect(renderedPage().getAttribute("data-zoom")).toBe("110");

    await runPdfCommand("Zoom out PDF");
    await settle();
    expect(renderedPage().getAttribute("data-zoom")).toBe("100");

    await runPdfCommand("Copy PDF page link");
    expect(clipboardWriteText).toHaveBeenLastCalledWith(expect.stringContaining("page=1&zoom=100"));
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      expect.stringContaining(`folder=${SOURCE_FOLDER_ID}`),
    );

    pdfMock.save.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await runPdfCommand("Download filled PDF copy");
    await settle();
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    await runPdfCommand("Save filled PDF copy to Drive");
    await settle();
    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-filled.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    digestSpy.mockRestore();
  });

  it("blocks filled-copy export until required PDF form fields are complete", async () => {
    pdfMock.load.mockImplementation(() =>
      Promise.resolve(
        fakePdfDocument({
          customerName: "",
          approved: false,
          region: "",
          requiredFields: new Set(["Customer name", "Approved", "Region"]),
        }),
      ),
    );

    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: { page: 1, zoom: 100, commentId: null, sourceFolderId: SOURCE_FOLDER_ID },
      });
    });
    await settle();

    expect(container.textContent).toContain("Customer name required");
    expect(container.textContent).toContain("Approved required");
    expect(container.textContent).toContain("Region required");

    pdfMock.save.mockClear();
    await clickButton("Download filled copy");
    await settle();

    expect(container.textContent).toContain(
      "Complete required PDF fields before exporting: Customer name, Approved, Region.",
    );
    expect(container.textContent).toContain("Required field is blank.");
    expect(pdfMock.save).not.toHaveBeenCalled();

    await clickButton("Save filled copy to Drive");
    await settle();

    expect(pdfMock.save).not.toHaveBeenCalled();
    expect(toolCalls.some((call) => call.url === "/api/tools/drive.upload")).toBe(false);

    await changeInput("Customer name", "Northwind");
    await changeCheckbox("Approved", true);
    await changeSelect("Region", "NA");
    await settle();

    expect(container.textContent).not.toContain("Complete required PDF fields before exporting");
    pdfMock.save.mockClear();
    await clickButton("Download filled copy");
    await settle();

    expect(pdfMock.setName).toHaveBeenCalledWith("Northwind");
    expect(pdfMock.checkApproval).toHaveBeenCalled();
    expect(pdfMock.selectRegion).toHaveBeenCalledWith("NA");
    expect(pdfMock.save).toHaveBeenCalledTimes(1);

    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    pdfMock.save.mockClear();
    await clickButton("Save filled copy to Drive");
    await settle();

    expect(pdfMock.save).toHaveBeenCalledTimes(1);
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-filled.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
    });
    digestSpy.mockRestore();
  });

  it("fills, saves, and burns visible PDF signature field intent into filled copies", async () => {
    pdfMock.load.mockImplementation(() =>
      Promise.resolve(fakePdfDocument({ signatureFieldName: "Signer" })),
    );

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    await changeInput("Signer", "Ada Lovelace");
    await clickButton("Save draft");
    await settle();

    expect(lastToolCallBody("/api/tools/drive.pdfFormState.save")).toMatchObject({
      objectId: "pdf object/1",
      fields: expect.arrayContaining([
        { name: "Signer", type: "signature", value: "Ada Lovelace" },
      ]),
    });

    pdfMock.drawRectangle.mockClear();
    pdfMock.drawText.mockClear();
    await clickButton("Download filled copy");
    await settle();

    expect(pdfMock.drawRectangle).toHaveBeenCalledWith(
      expect.objectContaining({ borderWidth: 1.2 }),
    );
    expect(pdfMock.drawText).toHaveBeenCalledWith(
      "Signer",
      expect.objectContaining({ maxWidth: expect.any(Number) }),
    );
    expect(pdfMock.drawText).toHaveBeenCalledWith(
      "Signature intent: Ada Lovelace",
      expect.objectContaining({ size: 11 }),
    );
    expect(pdfMock.save).toHaveBeenCalled();
  });

  it("downloads and saves stamped PDF copies with open review stamps burned in", async () => {
    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: { page: 1, zoom: 100, commentId: null, sourceFolderId: SOURCE_FOLDER_ID },
      });
    });
    await settle();

    await changeSelect("PDF review stamp", "needs-review");
    await clickButton("Place stamp");
    setPdfStageRect({ left: 0, top: 0, width: 800, height: 600 });
    setPdfPlacementOverlayRect({ left: 10, top: 20, width: 400, height: 200 });
    await clickPdfPlacementOverlay(210, 120);
    await settle();

    pdfMock.drawRectangle.mockClear();
    pdfMock.drawText.mockClear();
    pdfMock.save.mockClear();
    vi.mocked(HTMLAnchorElement.prototype.click).mockClear();
    await clickButton("Download stamped copy");
    await settle();

    expect(pdfMock.load).toHaveBeenCalled();
    expect(pdfMock.getPage).toHaveBeenCalledWith(0);
    expect(pdfMock.drawRectangle).toHaveBeenCalledWith(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: 22,
        borderWidth: 1.5,
      }),
    );
    expect(pdfMock.drawText).toHaveBeenCalledWith(
      "NEEDS REVIEW",
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        size: 10,
      }),
    );
    expect(pdfMock.save).toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalled();

    const stampedDigestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save stamped copy to Drive");
    await settle();

    expect(container.textContent).toContain("Saved PDF copy to Drive.");
    expect(lastToolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "pdf-object-1-stamped.pdf",
      folderId: SOURCE_FOLDER_ID,
      mimeType: "application/pdf",
      byteSize: 3,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    expect(lastToolCallBody("/api/tools/drive.finalize")).toMatchObject({
      objectId: "drive-pdf-copy-1",
      byteSize: 3,
      sha256: "0".repeat(64),
      mimeType: "application/pdf",
      metadata: { source: "web-shell" },
    });
    stampedDigestSpy.mockRestore();
  });

  it("searches PDF text across pages and jumps between matching pages", async () => {
    setPdfTextByPage({
      1: "Alpha renewal",
      2: "Beta renewal",
      3: "Appendix approvals",
    });

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    expect(renderedPage().getAttribute("data-page")).toBe("1");
    await changeInput("Find PDF text", "renewal");
    await settle();

    expect(container.textContent).toContain("1/2");
    expect(container.querySelector('[aria-label="PDF text match: Alpha renewal"]')).not.toBeNull();

    await clickButton("Next PDF text match");
    await settle();

    expect(renderedPage().getAttribute("data-page")).toBe("2");
    expect(container.textContent).toContain("2/2");
    expect(container.querySelector('[aria-label="PDF text match: Beta renewal"]')).not.toBeNull();

    await clickButton("Previous PDF text match");
    await settle();

    expect(renderedPage().getAttribute("data-page")).toBe("1");
    expect(container.textContent).toContain("1/2");
    expect(container.querySelector('[aria-label="PDF text match: Alpha renewal"]')).not.toBeNull();
  });

  it("creates comments from current-page PDF text selections", async () => {
    setPdfTextItemsByPage({
      1: ["Alpha", "renewal", "summary"],
      2: ["Forecast evidence"],
      3: ["Appendix approvals"],
    });

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    await changeTextarea("PDF comment", "Review selected renewal text");
    await clickButton("Select text");
    await clickLabeledElement("PDF selectable text: Alpha");
    await clickLabeledElement("PDF selectable text: summary");
    await settle();

    expect(container.querySelector('[aria-label="Selected PDF text range"]')?.textContent).toBe(
      "Alpha renewal summary",
    );
    expect(container.textContent).toContain("3 items selected");

    await clickButton("Copy selection");
    await settle();
    expect(clipboardWriteText).toHaveBeenLastCalledWith("Alpha renewal summary");
    expect(container.textContent).toContain("Copied selected PDF text.");

    await clickButton("Comment on selection");
    await settle();

    const textCommentBody = latestToolBody("/api/tools/drive.comment.create");
    expect(textCommentBody).toContain('"kind":"pdf-text-selection"');
    expect(textCommentBody).toContain('"target":"text"');
    expect(textCommentBody).toContain('"quote":"Alpha renewal summary"');
    expect(textCommentBody).toContain('"textItemIds":["text-0","text-1","text-2"]');
    expect(textCommentBody.match(/"left":/gu)).toHaveLength(3);
    expect(button("PDF text anchor: Review selected renewal text")).toBeDefined();

    await clickLabeledElement("PDF text anchor: Review selected renewal text");
    await settle();
    expect(list("PDF comments").querySelector('[aria-current="true"]')?.textContent).toContain(
      "Review selected renewal text",
    );
  });

  it("creates comments from browser-selected PDF text spans", async () => {
    setPdfTextItemsByPage({
      1: ["Alpha", "renewal", "summary"],
      2: ["Forecast evidence"],
      3: ["Appendix approvals"],
    });

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    await changeTextarea("PDF comment", "Review browser selected text");
    selectBrowserTextRange(textLayerItem("renewal"), textLayerItem("summary"));
    await clickButton("Use browser selection");
    await settle();

    expect(container.querySelector('[aria-label="Selected PDF text range"]')?.textContent).toBe(
      "renewal summary",
    );
    expect(container.textContent).toContain("2 items selected");

    await clickButton("Comment on selection");
    await settle();

    const textCommentBody = latestToolBody("/api/tools/drive.comment.create");
    expect(textCommentBody).toContain('"kind":"pdf-text-selection"');
    expect(textCommentBody).toContain('"quote":"renewal summary"');
    expect(textCommentBody).toContain('"textItemIds":["text-1","text-2"]');
    expect(button("PDF text anchor: Review browser selected text")).toBeDefined();
  });

  it("resolves PDF comment replies individually or as a thread", async () => {
    comments = [
      {
        id: "comment-1",
        objectId: "pdf object/1",
        actorId: "actor-1",
        parentCommentId: null,
        anchor: {
          kind: "pdf-page",
          objectId: "pdf object/1",
          page: 1,
          pageCount: 3,
          target: "page",
        },
        body: "Review totals",
        status: "open",
        metadata: {},
        resolvedAt: null,
        createdAt: "2026-05-24T14:00:00.000Z",
        updatedAt: null,
      },
      {
        id: "comment-2",
        objectId: "pdf object/1",
        actorId: "actor-2",
        parentCommentId: "comment-1",
        anchor: {
          kind: "pdf-page",
          objectId: "pdf object/1",
          page: 1,
          pageCount: 3,
          target: "page",
        },
        body: "Finance confirmed",
        status: "open",
        metadata: { parentCommentId: "comment-1" },
        resolvedAt: null,
        createdAt: "2026-05-24T14:01:00.000Z",
        updatedAt: null,
      },
      {
        id: "comment-3",
        objectId: "pdf object/1",
        actorId: "actor-3",
        parentCommentId: "comment-1",
        anchor: {
          kind: "pdf-page",
          objectId: "pdf object/1",
          page: 1,
          pageCount: 3,
          target: "page",
        },
        body: "Legal still needs final approval",
        status: "open",
        metadata: { parentCommentId: "comment-1" },
        resolvedAt: null,
        createdAt: "2026-05-24T14:02:00.000Z",
        updatedAt: null,
      },
    ];

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    expect(list("PDF comments").textContent).toContain("Review totals");
    expect(list("PDF comments").textContent).toContain("Finance confirmed");
    expect(list("PDF comments").textContent).toContain("Legal still needs final approval");

    await clickButton("Resolve reply: Finance confirmed");
    await settle();

    expect(latestToolBody("/api/tools/drive.comment.resolve")).toContain('"commentId":"comment-2"');
    expect(list("PDF comments").textContent).toContain("Review totals");
    expect(list("PDF comments").textContent).not.toContain("Finance confirmed");
    expect(list("PDF comments").textContent).toContain("Legal still needs final approval");

    await clickButton("Resolve thread");
    await settle();

    const resolvedCommentIds = toolCalls
      .filter((call) => call.url === "/api/tools/drive.comment.resolve")
      .map((call) => (call.body as { readonly commentId: string }).commentId);
    expect(resolvedCommentIds).toEqual(["comment-2", "comment-1", "comment-3"]);
    expect(container.textContent).toContain("No open comments.");
  });

  it("edits and deletes PDF comments and replies", async () => {
    comments = [
      {
        id: "comment-1",
        objectId: "pdf object/1",
        actorId: "actor-1",
        parentCommentId: null,
        anchor: {
          kind: "pdf-page",
          objectId: "pdf object/1",
          page: 1,
          pageCount: 3,
          target: "page",
        },
        body: "Review totals",
        status: "open",
        metadata: {},
        resolvedAt: null,
        createdAt: "2026-05-24T14:00:00.000Z",
        updatedAt: null,
      },
      {
        id: "comment-2",
        objectId: "pdf object/1",
        actorId: "actor-2",
        parentCommentId: "comment-1",
        anchor: {
          kind: "pdf-page",
          objectId: "pdf object/1",
          page: 1,
          pageCount: 3,
          target: "page",
        },
        body: "Finance confirmed",
        status: "open",
        metadata: { parentCommentId: "comment-1" },
        resolvedAt: null,
        createdAt: "2026-05-24T14:01:00.000Z",
        updatedAt: null,
      },
    ];

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    await clickButton("Edit comment: Review totals");
    await changeTextarea("Edit PDF comment: Review totals", "Review updated totals");
    await clickButton("Save comment");
    await settle();

    expect(latestToolBody("/api/tools/drive.comment.update")).toContain('"commentId":"comment-1"');
    expect(latestToolBody("/api/tools/drive.comment.update")).toContain(
      '"body":"Review updated totals"',
    );
    expect(list("PDF comments").textContent).toContain("Review updated totals");

    await clickButton("Delete reply: Finance confirmed");
    await settle();

    expect(latestToolBody("/api/tools/drive.comment.delete")).toContain('"commentId":"comment-2"');
    expect(list("PDF comments").textContent).not.toContain("Finance confirmed");

    await clickButton("Delete comment: Review updated totals");
    await settle();

    expect(latestToolBody("/api/tools/drive.comment.delete")).toContain('"commentId":"comment-1"');
    expect(container.textContent).toContain("No open comments.");
  });

  it("reopens resolved PDF comment threads from the resolved filter", async () => {
    comments = [
      {
        id: "comment-1",
        objectId: "pdf object/1",
        actorId: "actor-1",
        parentCommentId: null,
        anchor: {
          kind: "pdf-page",
          objectId: "pdf object/1",
          page: 1,
          pageCount: 3,
          target: "page",
        },
        body: "Review resolved totals",
        status: "resolved",
        metadata: {},
        resolvedAt: "2026-05-24T14:05:00.000Z",
        createdAt: "2026-05-24T14:00:00.000Z",
        updatedAt: "2026-05-24T14:05:00.000Z",
      },
      {
        id: "comment-2",
        objectId: "pdf object/1",
        actorId: "actor-2",
        parentCommentId: "comment-1",
        anchor: {
          kind: "pdf-page",
          objectId: "pdf object/1",
          page: 1,
          pageCount: 3,
          target: "page",
        },
        body: "Resolved reply",
        status: "resolved",
        metadata: { parentCommentId: "comment-1" },
        resolvedAt: "2026-05-24T14:06:00.000Z",
        createdAt: "2026-05-24T14:01:00.000Z",
        updatedAt: "2026-05-24T14:06:00.000Z",
      },
    ];

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    await changeSelect("PDF comment status", "resolved");
    await settle();

    expect(list("PDF comments").textContent).toContain("Review resolved totals");
    expect(list("PDF comments").textContent).toContain("Resolved reply");

    await clickButton("Reopen comment: Review resolved totals");
    await settle();

    expect(latestToolBody("/api/tools/drive.comment.reopen")).toContain('"commentId":"comment-1"');
    expect(container.textContent).toContain("No resolved comments.");
  });

  it("restores PDF page, zoom, and selected comment from route state", async () => {
    comments = [
      {
        id: "comment-1",
        objectId: "pdf object/1",
        actorId: "actor-1",
        parentCommentId: null,
        anchor: {
          kind: "pdf-page-point",
          objectId: "pdf object/1",
          page: 2,
          pageCount: 3,
          target: "point",
          units: "percent",
          x: 40,
          y: 60,
        },
        body: "Check selected detail",
        status: "open",
        metadata: {},
        resolvedAt: null,
        createdAt: "2026-05-24T14:00:00.000Z",
        updatedAt: null,
      },
    ];
    const onRouteStateChange = vi.fn();

    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: {
          page: 2,
          zoom: 150,
          commentId: "comment-1",
          sourceFolderId: SOURCE_FOLDER_ID,
        },
        onRouteStateChange,
      });
    });
    await settle();

    expect(renderedPage().getAttribute("data-page")).toBe("2");
    expect(renderedPage().getAttribute("data-zoom")).toBe("150");
    expect(pageInput().value).toBe("2");
    expect(container.textContent).toContain("150%");
    expect(select("PDF comment status").value).toBe("all");
    expect(list("PDF comments").querySelector('[aria-current="true"]')?.textContent).toContain(
      "Check selected detail",
    );
    expect(button("PDF comment pin: Check selected detail").getAttribute("data-selected")).toBe(
      "true",
    );
    expect(onRouteStateChange).not.toHaveBeenCalled();

    act(() => {
      button("Next page").click();
    });
    await settle();
    expect(onRouteStateChange).toHaveBeenLastCalledWith({
      page: 3,
      zoom: 150,
      commentId: "comment-1",
      sourceFolderId: SOURCE_FOLDER_ID,
    });
  });

  it("saves, restores, and clears PDF form field drafts through Drive tools", async () => {
    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    await changeInput("Customer name", "Northwind");
    await changeCheckbox("Approved", true);
    await changeSelect("Region", "NA");
    await clickButton("Save draft");
    await settle();

    expect(container.textContent).toContain("Saved draft.");
    expect(lastToolCallBody("/api/tools/drive.pdfFormState.save")).toMatchObject({
      objectId: "pdf object/1",
      fields: [
        { name: "Customer name", type: "text", value: "Northwind" },
        { name: "Approved", type: "checkbox", value: true },
        { name: "Region", type: "choice", value: "NA" },
      ],
    });
    expect(window.localStorage.getItem("helix.pdf.form-state:pdf object/1")).toBeNull();

    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    expect(container.textContent).toContain("Restored saved draft.");
    expect(lastToolCallBody("/api/tools/drive.pdfFormState.get")).toMatchObject({
      objectId: "pdf object/1",
    });
    expect(input("Customer name").value).toBe("Northwind");
    expect(checkbox("Approved").checked).toBe(true);
    expect(select("Region").value).toBe("NA");

    await clickButton("Clear draft");
    await settle();

    expect(container.textContent).toContain("Cleared draft.");
    expect(lastToolCallBody("/api/tools/drive.pdfFormState.clear")).toMatchObject({
      objectId: "pdf object/1",
    });
    expect(pdfFormState).toBeNull();
  });

  it("resolves stale PDF form drafts by returning to current PDF defaults", async () => {
    pdfFormState = {
      objectId: "pdf object/1",
      actorId: "actor-1",
      fieldValues: [
        { name: "Customer name", type: "text", value: "Northwind" },
        { name: "Approved", type: "checkbox", value: true },
        { name: "Region", type: "choice", value: "NA" },
      ],
      sourceVersionNumber: 1,
      sourceSha256: "1".repeat(64),
      sourceByteSize: 3,
      sourceChanged: true,
      createdAt: "2026-05-24T15:10:00.000Z",
      updatedAt: "2026-05-24T15:10:00.000Z",
    };

    await act(async () => {
      renderPdfViewer({ objectId: "pdf object/1" });
    });
    await settle();

    expect(container.textContent).toContain("Restored saved draft from an earlier PDF version.");
    const conflicts = container.querySelector<HTMLElement>(
      '[aria-label="PDF stale draft field conflicts"]',
    );
    expect(conflicts).not.toBeNull();
    expect(conflicts?.textContent).toContain("Customer name");
    expect(conflicts?.textContent).toContain("PDF default: Acme");
    expect(conflicts?.textContent).toContain("Saved draft: Northwind");
    expect(conflicts?.textContent).toContain("Approved");
    expect(conflicts?.textContent).toContain("PDF default: No");
    expect(conflicts?.textContent).toContain("Saved draft: Yes");
    expect(conflicts?.textContent).toContain("Region");
    expect(conflicts?.textContent).toContain("PDF default: EMEA");
    expect(conflicts?.textContent).toContain("Saved draft: NA");
    expect(input("Customer name").value).toBe("Northwind");
    expect(checkbox("Approved").checked).toBe(true);
    expect(select("Region").value).toBe("NA");

    await clickButton("Use PDF defaults");
    await settle();

    expect(input("Customer name").value).toBe("Acme");
    expect(checkbox("Approved").checked).toBe(false);
    expect(select("Region").value).toBe("EMEA");
    expect(container.querySelector('[aria-label="PDF stale draft field conflicts"]')).toBeNull();
    expect(container.textContent).toContain("Using current PDF defaults.");
    expect(lastToolCallBody("/api/tools/drive.pdfFormState.clear")).toMatchObject({
      objectId: "pdf object/1",
    });
    expect(pdfFormState).toBeNull();
  });

  it("shows an unavailable linked PDF comment and can clear the review link", async () => {
    const onRouteStateChange = vi.fn();

    await act(async () => {
      renderPdfViewer({
        objectId: "pdf object/1",
        routeState: {
          page: 2,
          zoom: 125,
          commentId: "missing-comment",
          sourceFolderId: SOURCE_FOLDER_ID,
        },
        onRouteStateChange,
      });
    });
    await settle();

    expect(select("PDF comment status").value).toBe("all");
    expect(container.textContent).toContain(
      "Linked PDF comment is unavailable or no longer visible.",
    );
    expect(onRouteStateChange).not.toHaveBeenCalled();

    await clickButton("Clear link");
    await settle();

    expect(onRouteStateChange).toHaveBeenLastCalledWith({
      page: 2,
      zoom: 125,
      commentId: null,
      sourceFolderId: SOURCE_FOLDER_ID,
    });
  });
});

function renderPdfViewer(props: NativePdfViewerProps): void {
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
      <NativePdfViewer {...props} />
    </WebPlatformProvider>,
  );
}

async function runPdfCommand(label: string): Promise<void> {
  const command = platformHost.getCommandPaletteItems().find((item) => item.label === label);
  if (command === undefined) {
    throw new Error(`Missing PDF command: ${label}`);
  }
  await act(async () => {
    await command.run();
  });
}

interface FakePdfDocumentInput {
  readonly customerName?: string;
  readonly approved?: boolean;
  readonly region?: string;
  readonly signatureFieldName?: string;
  readonly requiredFields?: ReadonlySet<string>;
}

interface FakePdfField {
  getName(): string;
  isRequired(): boolean;
  getText?(): string | undefined;
  setText?(value: string): void;
  isChecked?(): boolean;
  check?(): void;
  uncheck?(): void;
  getOptions?(): string[];
  getSelected?(): string[];
  select?(value: string): void;
  needsAppearancesUpdate?(): boolean;
}

function fakePdfDocument(input: FakePdfDocumentInput = {}) {
  const requiredFields = input.requiredFields ?? new Set<string>();
  const fields: FakePdfField[] = [
    {
      getName: () => "Customer name",
      isRequired: () => requiredFields.has("Customer name"),
      getText: () => input.customerName ?? "Acme",
      setText: pdfMock.setName,
    },
    {
      getName: () => "Approved",
      isRequired: () => requiredFields.has("Approved"),
      isChecked: () => input.approved ?? false,
      check: pdfMock.checkApproval,
      uncheck: pdfMock.uncheckApproval,
    },
    {
      getName: () => "Region",
      isRequired: () => requiredFields.has("Region"),
      getOptions: () => ["EMEA", "NA"],
      getSelected: () => [input.region ?? "EMEA"],
      select: pdfMock.selectRegion,
    },
  ];
  if (input.signatureFieldName !== undefined) {
    fields.push({
      getName: () => input.signatureFieldName ?? "Signer",
      isRequired: () => requiredFields.has(input.signatureFieldName ?? "Signer"),
      needsAppearancesUpdate: () => false,
    });
  }
  return {
    getPageCount: () => 3,
    getForm: () => ({
      getFields: () => fields,
      getField: (name: string) => {
        const match = fields.find((field) => field.getName() === name);
        if (match === undefined) {
          throw new Error(`Missing field ${name}`);
        }
        return match;
      },
    }),
    getPage: pdfMock.getPage.mockImplementation(() => ({
      getRotation: pdfMock.getRotation,
      setRotation: pdfMock.setRotation,
      getWidth: pdfMock.getWidth,
      getHeight: pdfMock.getHeight,
      drawRectangle: pdfMock.drawRectangle,
      drawText: pdfMock.drawText,
    })),
    copyPages: pdfMock.copyPages,
    addPage: pdfMock.addPage,
    insertPage: pdfMock.insertPage,
    removePage: pdfMock.removePage,
    save: pdfMock.save,
  };
}

function fakeExtractPdfDocument() {
  return {
    copyPages: pdfMock.copyPages,
    addPage: pdfMock.addPage,
    embedPng: pdfMock.embedPng,
    save: pdfMock.save,
  };
}

function fakePdfJsDocument() {
  return {
    numPages: 3,
    getPage: pdfJsMock.getPage.mockImplementation((pageNumber: number) =>
      Promise.resolve({
        pageNumber,
        getViewport: () => ({ width: 90 + pageNumber, height: 120 + pageNumber }),
        getTextContent: pdfJsMock.getTextContent,
        render: pdfJsMock.renderPage,
      }),
    ),
    getOutline: pdfJsMock.getOutline.mockResolvedValue([
      { title: "Executive summary", dest: ["page-1"], items: [] },
      {
        title: "Appendix",
        dest: "appendix-destination",
        items: [{ title: "Evidence", dest: [2, { name: "XYZ" }, null, null, 1.25], items: [] }],
      },
    ]),
    getDestination: pdfJsMock.getDestination.mockImplementation((destination: string) =>
      Promise.resolve(destination === "appendix-destination" ? ["page-2"] : null),
    ),
    getPageIndex: pdfJsMock.getPageIndex.mockImplementation((pageRef: unknown) => {
      if (pageRef === "page-1") return Promise.resolve(0);
      if (pageRef === "page-2") return Promise.resolve(1);
      if (pageRef === "page-3") return Promise.resolve(2);
      return Promise.reject(new Error("Unknown page ref"));
    }),
    destroy: pdfJsMock.destroy,
  };
}

function setPdfTextByPage(textByPage: Readonly<Record<number, string>>): void {
  pdfJsMock.getTextContent.mockImplementation(function getTextContent(this: {
    pageNumber?: number;
  }) {
    return Promise.resolve(pdfTextContent(textByPage[this.pageNumber ?? 1] ?? ""));
  });
}

function setPdfTextItemsByPage(textByPage: Readonly<Record<number, readonly string[]>>): void {
  pdfJsMock.getTextContent.mockImplementation(function getTextContent(this: {
    pageNumber?: number;
  }) {
    return Promise.resolve(pdfTextItemsContent(textByPage[this.pageNumber ?? 1] ?? []));
  });
}

function pdfTextContent(text: string) {
  return pdfTextItemsContent(text.length === 0 ? [] : [text]);
}

function pdfTextItemsContent(texts: readonly string[]) {
  return {
    items: texts.map((text, index) => ({
      str: text,
      transform: [12, 0, 0, 12, 24 + index * 48, 96],
      width: Math.max(36, text.length * 6),
      height: 12,
    })),
  };
}

function renderedPage(): HTMLImageElement {
  const target = container.querySelector<HTMLImageElement>('img[aria-label="Rendered PDF page"]');
  if (target === null) {
    throw new Error("Missing rendered PDF page");
  }
  return target;
}

function textLayer(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="PDF text layer"]');
  if (target === null) {
    throw new Error("Missing PDF text layer");
  }
  return target;
}

function textLayerItem(text: string): HTMLElement {
  const target = [...textLayer().querySelectorAll<HTMLElement>("[data-pdf-text-item-id]")].find(
    (candidate) => candidate.textContent === text,
  );
  if (target === undefined) {
    throw new Error(`Missing PDF text item: ${text}`);
  }
  return target;
}

function selectBrowserTextRange(start: HTMLElement, end: HTMLElement): void {
  const range = document.createRange();
  range.setStartBefore(start);
  range.setEndAfter(end);
  const selection = window.getSelection();
  if (selection === null) {
    throw new Error("Browser selection is unavailable.");
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function pdfStage(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="PDF page canvas"]');
  if (target === null) {
    throw new Error("Missing PDF page canvas");
  }
  return target;
}

function pdfPlacementOverlay(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="PDF placement overlay"]');
  if (target === null) {
    throw new Error("Missing PDF placement overlay");
  }
  return target;
}

function downloadLink(): HTMLAnchorElement {
  const target = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((link) =>
    link.textContent?.includes("Download"),
  );
  if (target === undefined) {
    throw new Error("Missing download link");
  }
  return target;
}

function button(label: string): HTMLButtonElement {
  const target =
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ??
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes(label) === true,
    ) ??
    null;
  if (target === null) {
    throw new Error(`Missing button: ${label}`);
  }
  return target;
}

function input(label: string): HTMLInputElement {
  const target = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing input: ${label}`);
  }
  return target;
}

function checkbox(label: string): HTMLInputElement {
  const target = input(label);
  if (target.type !== "checkbox") {
    throw new Error(`Input is not a checkbox: ${label}`);
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

function list(label: string): HTMLOListElement {
  const target = container.querySelector<HTMLOListElement>(`ol[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing list: ${label}`);
  }
  return target;
}

function pageInput(): HTMLInputElement {
  const target = container.querySelector<HTMLInputElement>('input[aria-label="Page number"]');
  if (target === null) {
    throw new Error("Missing page input");
  }
  return target;
}

function pageButtonByLabel(label: string): HTMLButtonElement {
  const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label) === true,
  );
  if (target === undefined) {
    throw new Error(`Missing page button: ${label}`);
  }
  return target;
}

function pageButton(pageNumber: number): HTMLButtonElement {
  const target = container.querySelector<HTMLButtonElement>(
    `button[aria-label="PDF thumbnail page ${String(pageNumber)}"]`,
  );
  if (target === null) {
    throw new Error(`Missing page button: ${String(pageNumber)}`);
  }
  return target;
}

function pageButtonOrder(): readonly number[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="PDF thumbnail page "]'),
  ]
    .map((target) => Number(target.getAttribute("aria-label")?.replace("PDF thumbnail page ", "")))
    .filter((pageNumber) => Number.isInteger(pageNumber));
}

async function dragPageThumbnail(sourcePage: number, targetPage: number): Promise<void> {
  const data = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "move",
    dropEffect: "move",
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
  await act(async () => {
    pageButton(sourcePage).dispatchEvent(dragEvent("dragstart", dataTransfer));
  });
  await act(async () => {
    pageButton(targetPage).dispatchEvent(dragEvent("dragover", dataTransfer));
  });
  await act(async () => {
    pageButton(targetPage).dispatchEvent(dragEvent("drop", dataTransfer));
  });
  await act(async () => {
    pageButton(sourcePage).dispatchEvent(dragEvent("dragend", dataTransfer));
  });
}

function dragEvent(type: string, dataTransfer: object): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return event;
}

function commentPageButton(pageNumber: number): HTMLButtonElement {
  const target = list("PDF comments").querySelector<HTMLButtonElement>("button");
  if (target === null || target.textContent?.includes(`Page ${pageNumber}`) !== true) {
    throw new Error(`Missing comment page button: ${String(pageNumber)}`);
  }
  return target;
}

function replyButtonForComment(commentBody: string): HTMLButtonElement {
  return commentActionButton(commentBody, "Reply");
}

function resolveButtonForComment(commentBody: string): HTMLButtonElement {
  return commentActionButton(commentBody, "Resolve");
}

function commentActionButton(commentBody: string, action: "Reply" | "Resolve"): HTMLButtonElement {
  const replyComposer = textarea(`Reply to ${commentBody}`);
  const commentItem = replyComposer.closest("li");
  const target = [...(commentItem?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim() === action,
  );
  if (target === undefined) {
    throw new Error(`Missing ${action.toLowerCase()} button for comment: ${commentBody}`);
  }
  return target;
}

function setPdfStageRect(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): void {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  Object.defineProperty(pdfStage(), "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      right,
      bottom,
      x: rect.left,
      y: rect.top,
      toJSON: () => undefined,
    }),
  });
}

function setPdfPlacementOverlayRect(rect: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): void {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  Object.defineProperty(pdfPlacementOverlay(), "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      right,
      bottom,
      x: rect.left,
      y: rect.top,
      toJSON: () => undefined,
    }),
  });
}

function latestToolBody(url: string): string {
  const call = vi
    .mocked(authenticatedFetch)
    .mock.calls.filter(([input]) => input === url)
    .at(-1);
  const body = call?.[1]?.body;
  if (typeof body !== "string") {
    throw new Error(`Missing tool body for ${url}`);
  }
  return body;
}

async function changeInput(label: string, value: string): Promise<void> {
  const target = input(label);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function changeCheckbox(label: string, value: boolean): Promise<void> {
  const target = checkbox(label);
  await act(async () => {
    if (target.checked !== value) {
      target.click();
    }
  });
}

async function changeSelect(label: string, value: string): Promise<void> {
  const target = select(label);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    valueSetter?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function changeTextarea(label: string, value: string): Promise<void> {
  const target = textarea(label);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    valueSetter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
  });
}

async function clickLabeledElement(label: string): Promise<void> {
  const target = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing labeled element: ${label}`);
  }
  await act(async () => {
    target.click();
  });
}

async function clickReplyButton(commentBody: string): Promise<void> {
  await act(async () => {
    replyButtonForComment(commentBody).click();
  });
}

async function clickResolveButton(commentBody: string): Promise<void> {
  await act(async () => {
    resolveButtonForComment(commentBody).click();
  });
}

async function uploadFile(label: string, file: File): Promise<void> {
  const target = input(label);
  Object.defineProperty(target, "files", {
    configurable: true,
    value: [file],
  });
  await act(async () => {
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function clickPdfPlacementOverlay(clientX: number, clientY: number): Promise<void> {
  await act(async () => {
    pdfPlacementOverlay().dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX, clientY }),
    );
  });
}

async function dragPdfRedaction(
  startClientX: number,
  startClientY: number,
  endClientX: number,
  endClientY: number,
): Promise<void> {
  const overlay = pdfPlacementOverlay();
  await act(async () => {
    overlay.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: startClientX,
        clientY: startClientY,
      }),
    );
  });
  await act(async () => {
    overlay.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: endClientX,
        clientY: endClientY,
      }),
    );
  });
  await act(async () => {
    overlay.dispatchEvent(
      new MouseEvent("pointerup", {
        bubbles: true,
        clientX: endClientX,
        clientY: endClientY,
      }),
    );
  });
}

async function dragPdfFreehandAnnotation(points: readonly (readonly [number, number])[]): Promise<void> {
  if (points.length < 2) {
    throw new Error("Freehand annotation drag needs at least two points.");
  }
  const overlay = pdfPlacementOverlay();
  const [startX, startY] = points[0] ?? [0, 0];
  await act(async () => {
    overlay.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        clientX: startX,
        clientY: startY,
      }),
    );
  });
  for (const [clientX, clientY] of points.slice(1, -1)) {
    await act(async () => {
      overlay.dispatchEvent(
        new MouseEvent("pointermove", {
          bubbles: true,
          clientX,
          clientY,
        }),
      );
    });
  }
  const [endX, endY] = points.at(-1) ?? [startX, startY];
  await act(async () => {
    overlay.dispatchEvent(
      new MouseEvent("pointerup", {
        bubbles: true,
        clientX: endX,
        clientY: endY,
      }),
    );
  });
}

function lastToolCallBody(url: string): Record<string, unknown> {
  const call = [...toolCalls].reverse().find((candidate) => candidate.url === url);
  if (call === undefined || !isRecord(call.body)) {
    throw new Error(`Missing tool call body: ${url}`);
  }
  return call.body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}
