// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidesList } from "./slides-list";

const deckId = "11111111-1111-4111-8111-111111111111";
const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: navigateMock,
  }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let onOpen: ReturnType<typeof vi.fn>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let importShouldFail: boolean;
let digestSpy: { mockRestore: () => void };
let driveEntries: readonly unknown[];

describe("SlidesList", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    onOpen = vi.fn();
    navigateMock.mockClear();
    toolCalls = [];
    importShouldFail = false;
    driveEntries = [];
    digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = parseRequestBody(init);
      toolCalls.push({ url, body });

      if (url === "/api/tools/drive.list") {
        return Promise.resolve(Response.json({ entries: driveEntries }));
      }
      if (url === "/api/tools/drive.trash") {
        return Promise.resolve(
          Response.json({ id: (body as { readonly objectId?: string }).objectId }),
        );
      }
      if (url === "/api/tools/drive.restore") {
        return Promise.resolve(
          Response.json({ id: (body as { readonly objectId?: string }).objectId }),
        );
      }
      if (url === "/api/tools/drive.delete") {
        return Promise.resolve(Response.json({ ok: true }));
      }
      if (url === "/api/tools/drive.star.set") {
        return Promise.resolve(
          Response.json({
            id: (body as { readonly objectId?: string }).objectId,
            metadata: { starred: (body as { readonly starred?: boolean }).starred },
          }),
        );
      }
      if (url === "/api/tools/drive.upload") {
        if (importShouldFail) {
          return Promise.resolve(
            Response.json({ error: { message: "Drive upload failed" } }, { status: 503 }),
          );
        }
        const name = (body as { readonly name?: string }).name ?? "Upload.pptx";
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
            mimeType:
              (body as { readonly mimeType?: string }).mimeType ?? "application/octet-stream",
            byteSize: (body as { readonly byteSize?: number }).byteSize ?? 0,
            sha256: "0".repeat(64),
            status: "pending_upload",
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
            objectId: (body as { readonly objectId?: string }).objectId,
            versionNumber: 1,
            storageKey: (body as { readonly storageKey?: string }).storageKey,
            mimeType: (body as { readonly mimeType?: string }).mimeType,
            byteSize: (body as { readonly byteSize?: number }).byteSize,
            sha256: "0".repeat(64),
            metadata: {},
            createdByActorId: "actor-1",
            createdAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/slides.deck.create") {
        return Promise.resolve(
          Response.json({
            id: deckId,
            title: (body as { readonly title?: string }).title ?? "Generated",
            ownerActorId: "actor-1",
            createdByActorId: "actor-1",
            slideCount: 0,
            metadata: {},
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/slides.slide.create") {
        const create = body as {
          readonly position?: number;
          readonly content?: { readonly layout?: string };
        };
        return Promise.resolve(
          Response.json({
            id: `22222222-2222-4222-8222-22222222222${String(create.position ?? 0)}`,
            deckId,
            position: create.position ?? 0,
            layout: create.content?.layout ?? "bullets",
            content: create.content ?? { layout: "bullets", title: "Slide", items: [] },
            speakerNotes: "",
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }
      return Promise.resolve(Response.json({ error: "unexpected" }, { status: 500 }));
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

  it("generates a local deck plan and persists it with existing Slides tools", async () => {
    render();
    await settle();

    await clickButton("Generate deck");
    await changeTextarea("Deck prompt", "enterprise launch; customer proof; rollout risks");
    expect(container.textContent).toContain("Enterprise Launch Customer Proof Rollout Risks");
    expect(container.textContent).toContain("6 slides");

    await clickButton("Create generated deck");
    await settle();

    expect(onOpen).toHaveBeenCalledWith({ id: deckId, openMode: "native" });
    expect(toolCalls.filter((call) => call.url === "/api/tools/drive.list")).toHaveLength(2);
    expect(
      toolCalls.filter((call) => call.url.startsWith("/api/tools/slides.")).map((call) => call.url),
    ).toEqual([
      "/api/tools/slides.deck.create",
      "/api/tools/slides.slide.create",
      "/api/tools/slides.slide.create",
      "/api/tools/slides.slide.create",
      "/api/tools/slides.slide.create",
      "/api/tools/slides.slide.create",
      "/api/tools/slides.slide.create",
    ]);
    expect(
      toolCalls.some((call) => call.url.includes("assistant") || call.url.includes("ai")),
    ).toBe(false);
    expect(
      toolCalls.find((call) => call.url === "/api/tools/slides.deck.create")?.body,
    ).toMatchObject({
      title: "Enterprise Launch Customer Proof Rollout Risks",
      metadata: { generatedBy: "helix.presentation-assist.local" },
    });
  });

  it("uploads PPTX files as raw Drive objects and opens the copy/preview flow", async () => {
    render();
    await settle();

    dispatchPresentationFile(
      "Board narrative.pptx",
      [1, 2, 3],
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Board narrative.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      byteSize: 3,
    });
    expect(toolCalls.some((call) => call.url.includes("slides.import"))).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "upload-board-narrative-pptx" },
    });
  });

  it("uploads legacy PPT files as raw Drive objects before the preview/download decision", async () => {
    render();
    await settle();

    dispatchPresentationFile("Legacy deck.ppt", [4, 5, 6], "application/vnd.ms-powerpoint");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.upload")?.body).toMatchObject({
      name: "Legacy deck.ppt",
      mimeType: "application/vnd.ms-powerpoint",
      byteSize: 3,
    });
    expect(toolCalls.some((call) => call.url.includes("slides.import"))).toBe(false);
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/open/$objectId",
      params: { objectId: "upload-legacy-deck-ppt" },
    });
  });

  it("surfaces presentation upload failures without opening a deck", async () => {
    importShouldFail = true;
    render();
    await settle();

    dispatchPresentationFile(
      "Broken.pptx",
      [7, 8, 9],
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    await settle();

    expect(container.textContent).toContain("Could not import presentation: Drive upload failed");
    expect(onOpen).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("uses normal empty states for shared, starred, and trash folders", async () => {
    render();
    await settle();

    await clickButton("Shared with me");
    expect(container.textContent).toContain("No shared presentations yet.");
    expect(container.textContent).not.toContain("Coming soon");

    await clickButton("Starred");
    expect(container.textContent).toContain("No starred presentations yet.");
    expect(container.textContent).not.toContain("Coming soon");

    await clickButton("Trash");
    expect(container.textContent).toContain("Trash is empty.");
    expect(container.textContent).not.toContain("Coming soon");
  });

  it("loads more presentation rows through Drive when the first page is full", async () => {
    driveEntries = Array.from({ length: 101 }, (_, index) =>
      presentationDriveEntry({
        id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
        name: `Presentation ${String(index).padStart(3, "0")}.pptx`,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    );

    render();
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.list")?.body).toMatchObject({
      app: "slides",
      limit: 101,
    });
    await clickButton("Show more presentations");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/drive.list").at(-1)?.body,
    ).toMatchObject({ app: "slides", limit: 201 });
  });

  it("moves presentation list rows to trash through Drive", async () => {
    const objectId = "33333333-3333-4333-8333-333333333333";
    driveEntries = [
      presentationDriveEntry({
        id: objectId,
        name: "Board narrative.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ];
    render();
    await settle();

    await clickButton("List view");
    await clickButton("More actions for Board narrative.pptx");
    await clickButton("Move to trash");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.trash")?.body).toEqual({
      objectId,
    });
    expect(toolCalls.some((call) => call.url.includes("slides.deck.delete"))).toBe(false);
  });

  it("stars presentation list rows through Drive", async () => {
    const objectId = "33333333-3333-4333-8333-333333333333";
    driveEntries = [
      presentationDriveEntry({
        id: objectId,
        name: "Board narrative.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
    ];
    render();
    await settle();

    await clickButton("List view");
    await clickButton("More actions for Board narrative.pptx");
    await clickMenuItem("Star");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/drive.star.set")?.body).toEqual({
      objectId,
      starred: true,
    });
  });

  it("restores and permanently deletes trashed presentations through Drive", async () => {
    const objectId = "44444444-4444-4444-8444-444444444444";
    driveEntries = [
      presentationDriveEntry({
        id: objectId,
        name: "Deleted deck.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        deletedAt: "2026-05-22T12:00:00.000Z",
      }),
    ];
    render();
    await settle();

    await clickButton("Trash");
    await clickButton("List view");
    await clickButton("More actions for Deleted deck.pptx");
    await clickButton("Restore");
    await settle();
    await clickButton("More actions for Deleted deck.pptx");
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

function render(): void {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SlidesList onOpen={onOpen} query="" />
      </QueryClientProvider>,
    );
  });
}

async function clickButton(label: string): Promise<void> {
  const target = await findButton(label);
  if (target === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

async function findButton(label: string): Promise<HTMLButtonElement | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        button.textContent?.includes(label) === true ||
        button.getAttribute("aria-label")?.includes(label) === true,
    );
    if (target !== undefined) {
      return target;
    }
    await act(async () => {
      await Promise.resolve();
    });
  }
  return undefined;
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

function presentationDriveEntry(input: {
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

async function changeTextarea(label: string, value: string): Promise<void> {
  const target = [...container.querySelectorAll<HTMLTextAreaElement>("textarea")].find(
    (textarea) => textarea.getAttribute("aria-label") === label,
  );
  if (target === undefined) {
    throw new Error(`Missing textarea: ${label}`);
  }
  await act(async () => {
    setTextareaValue(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

function dispatchPresentationFile(filename: string, bytes: readonly number[], mimeType: string) {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="Import presentation"]',
  );
  expect(input).not.toBeNull();
  const file = new File([Uint8Array.from(bytes)], filename, { type: mimeType });
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => [file],
  });

  act(() => {
    input?.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function parseRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    return {};
  }
  return JSON.parse(init.body) as unknown;
}

function setTextareaValue(target: HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  descriptor?.set?.call(target, value);
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
