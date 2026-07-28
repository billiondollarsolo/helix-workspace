// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeDocumentVersionsRail } from "./native-document-versions-rail";

const docId = "33333333-3333-4333-8333-333333333333";
const versionId = "88888888-8888-4888-8888-888888888888";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;

describe("NativeDocumentVersionsRail", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
    });
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/docs.version.rename") {
        const name = (body as { readonly name?: string }).name ?? "Milestone review";
        return Promise.resolve(
          Response.json({
            ...version({ metadata: { source: "web.native-document.editor", name } }),
          }),
        );
      }
      if (url === "/api/tools/docs.version.preview") {
        return Promise.resolve(
          Response.json({
            version: version({ metadata: { source: "web.native-document.editor" } }),
            documentId: docId,
            currentUpdateSeq: 6,
            currentText: "Shared paragraph\nCurrent paragraph\nCurrent detail\n\nCurrent follow-up",
            versionText: "Shared paragraph\nPrevious paragraph",
            completeness: "snapshot",
            complete: true,
            appliedCount: 1,
            skippedCount: 0,
            diff: [
              { kind: "unchanged", text: "Shared paragraph" },
              { kind: "removed", text: "Previous paragraph" },
              { kind: "added", text: "Current paragraph" },
              { kind: "added", text: "Current detail" },
              { kind: "added", text: "" },
              { kind: "added", text: "Current follow-up" },
            ],
            warnings: [],
          }),
        );
      }
      if (url === "/api/tools/docs.version.restore") {
        return Promise.resolve(
          Response.json({
            document: {
              id: docId,
              title: "Restored doc",
              threadId: null,
              ownerActorId: "11111111-1111-4111-8111-111111111111",
              createdByActorId: "11111111-1111-4111-8111-111111111111",
              ydocState: btoa("restored-state"),
              ydocStateVector: btoa("restored-vector"),
              updateSeq: 5,
              editorEngine: "helix-native-document",
              formatVersion: 1,
              metadata: {},
              deletedAt: null,
              createdAt: "2026-05-23T12:00:00.000Z",
              updatedAt: "2026-05-23T12:20:00.000Z",
            },
            restoredVersion: version({ metadata: { source: "web.native-document.editor" } }),
            restoreVersion: {
              ...version({
                metadata: { source: "docs.version.restore", restoredVersionId: versionId },
              }),
              id: "99999999-9999-4999-8999-999999999999",
              seq: 5,
            },
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          versions: [version({ metadata: { source: "web.native-document.editor" } })],
        }),
      );
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

  it("renders update-backed version history", async () => {
    render();
    await settle();

    expect(container.textContent ?? "").toContain("Version history");
    expect(container.textContent ?? "").toContain("Update 4");
    expect(container.textContent ?? "").toContain("128 B");
    expect(container.textContent ?? "").toContain("web.native-document.editor");
    expect(toolCalls).toContainEqual({
      url: "/api/tools/docs.version.list",
      body: { docId, limit: 25 },
    });

    setInputValue(`docs-version-name-${versionId}`, "Milestone review");
    clickButton("Save");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/docs.version.rename",
      body: { versionId, name: "Milestone review" },
    });

    clickButton("Preview");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/docs.version.preview",
      body: { versionId },
    });
    expect(container.textContent ?? "").toContain("Preview Update 4");
    expect(container.textContent ?? "").toContain("Complete");
    expect(container.textContent ?? "").toContain("snapshot");
    expect(container.textContent ?? "").toContain("Added");
    expect(container.textContent ?? "").toContain("Removed");
    expect(container.textContent ?? "").toContain("Unchanged");
    expect(container.textContent ?? "").toContain("Shared paragraph");
    expect(container.textContent ?? "").toContain("Previous paragraph");
    expect(container.textContent ?? "").toContain("Current paragraph");
    expect(container.textContent ?? "").toContain("Review current-only content");
    expect(container.querySelector('[aria-label="Restore block conflict review"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain("Block 1 · current lines 2-3 · 2 lines");
    expect(container.textContent ?? "").toContain("Block 2 · current line 4 · blank line");
    expect(container.textContent ?? "").toContain("Block 3 · current line 5 · 1 line");
    expect(container.textContent ?? "").toContain("Current detail");
    expect(container.textContent ?? "").toContain("Blank line");
    expect(container.textContent ?? "").toContain("Current follow-up");
    expect(container.textContent ?? "").toContain("I reviewed current-only content");

    expect(buttonByLabel("Restore").disabled).toBe(true);
    const restoreReview = inputByLabel("I reviewed current-only content");
    act(() => {
      restoreReview.click();
    });
    await settle();

    clickButton("Side by side");
    await settle();

    expect(container.textContent ?? "").toContain("Version");
    expect(container.textContent ?? "").toContain("Current");
    expect(container.textContent ?? "").toContain("Previous paragraph");
    expect(container.textContent ?? "").toContain("Current paragraph");

    clickButton("Unified");
    await settle();

    const changesOnly = inputByLabel("Changes only");
    act(() => {
      changesOnly.click();
    });
    await settle();

    expect(container.textContent ?? "").not.toContain("Shared paragraph");
    expect(container.textContent ?? "").toContain("Previous paragraph");
    expect(container.textContent ?? "").toContain("Current paragraph");

    clickButton("Restore");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/docs.version.restore",
      body: { versionId, expectedCurrentUpdateSeq: 6 },
    });
  });

  it("loads additional versions when more updates are available", async () => {
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/docs.version.list") {
        const beforeSeq = (body as { readonly beforeSeq?: number }).beforeSeq;
        const startSeq = beforeSeq === undefined ? 60 : beforeSeq - 1;
        const length = beforeSeq === undefined ? 25 : 5;
        return Promise.resolve(
          Response.json({
            versions: Array.from({ length }, (_, index) => versionAt(startSeq - index)),
            nextBeforeSeq: beforeSeq === undefined ? 36 : null,
          }),
        );
      }
      return Promise.resolve(Response.json({}));
    });

    render();
    await settle();

    expect(container.textContent ?? "").toContain("Update 60");
    expect(container.textContent ?? "").toContain("Update 36");
    expect(container.textContent ?? "").not.toContain("Update 31");
    expect(buttonByLabel("Load more").disabled).toBe(false);

    clickButton("Load more");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/docs.version.list",
      body: { docId, limit: 25, beforeSeq: 36 },
    });
    expect(container.textContent ?? "").toContain("Update 31");
    expect(
      Array.from(container.querySelectorAll("button")).map((button) => button.textContent?.trim()),
    ).not.toContain("Load more");
  });
});

function version(overrides: { readonly metadata?: Record<string, unknown> } = {}) {
  return {
    id: versionId,
    documentId: docId,
    actorId: "11111111-1111-4111-8111-111111111111",
    seq: 4,
    byteSize: 128,
    metadata: overrides.metadata ?? {},
    createdAt: "2026-05-23T12:10:00.000Z",
  };
}

function versionAt(seq: number) {
  return {
    ...version({ metadata: { source: "web.native-document.editor" } }),
    id: `version-${String(seq)}`,
    seq,
  };
}

function render() {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NativeDocumentVersionsRail documentId={docId} />
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

function setInputValue(id: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (input === null) {
    throw new Error(`Missing input: ${id}`);
  }
  act(() => {
    setNativeInputValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(label: string): void {
  const button = buttonByLabel(label);
  act(() => {
    button.click();
  });
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  return button;
}

function inputByLabel(label: string): HTMLInputElement {
  const input = Array.from(container.querySelectorAll<HTMLInputElement>("input")).find(
    (candidate) => candidate.parentElement?.textContent?.includes(label),
  );
  if (input === undefined) {
    throw new Error(`Missing input label: ${label}`);
  }
  return input;
}

function setNativeInputValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native input value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
}
