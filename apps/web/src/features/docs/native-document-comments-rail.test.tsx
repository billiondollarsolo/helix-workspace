// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractMentionText,
  NativeDocumentCommentsRail,
  nativeDocumentCommentThreads,
} from "./native-document-comments-rail";
import { NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT } from "./native-document-anchors";

const docId = "33333333-3333-4333-8333-333333333333";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let listedAnchor: Record<string, unknown>;
let extraListedComments: unknown[];

describe("NativeDocumentCommentsRail", () => {
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
    listedAnchor = { kind: "document" };
    extraListedComments = [];
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/docs.comment.create") {
        return Promise.resolve(
          Response.json({
            id: "55555555-5555-4555-8555-555555555555",
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            anchor: { kind: "native-document" },
            body: "Needs @ada owner",
            status: "open",
            metadata: {},
            resolvedAt: null,
            createdAt: "2026-05-20T12:05:00.000Z",
            updatedAt: "2026-05-20T12:05:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.comment.resolve") {
        return Promise.resolve(
          Response.json({
            id: "44444444-4444-4444-8444-444444444444",
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            author: { id: "11111111-1111-4111-8111-111111111111", displayName: "Ada" },
            anchor: { kind: "document" },
            body: "Existing note",
            status: "resolved",
            metadata: {},
            resolvedAt: "2026-05-20T12:06:00.000Z",
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:06:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.comment.reopen") {
        return Promise.resolve(
          Response.json({
            id: "44444444-4444-4444-8444-444444444444",
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            author: { id: "11111111-1111-4111-8111-111111111111", displayName: "Ada" },
            anchor: { kind: "document" },
            body: "Existing note",
            status: "open",
            metadata: {},
            resolvedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:07:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.comment.update") {
        const update = body as { readonly body: string };
        return Promise.resolve(
          Response.json({
            id: "44444444-4444-4444-8444-444444444444",
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            author: { id: "11111111-1111-4111-8111-111111111111", displayName: "Ada" },
            anchor: { kind: "document" },
            body: update.body,
            status: "open",
            metadata: {},
            resolvedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:07:00.000Z",
          }),
        );
      }
      if (url === "/api/tools/docs.comment.delete") {
        return Promise.resolve(
          Response.json({
            id: "44444444-4444-4444-8444-444444444444",
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            anchor: { kind: "document" },
            body: "Existing note",
            status: "open",
            metadata: {},
            resolvedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-20T12:07:00.000Z",
          }),
        );
      }
      const status =
        (body as { readonly status?: "open" | "resolved" | "all" } | undefined)?.status ?? "open";
      return Promise.resolve(
        Response.json({
          comments: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              documentId: docId,
              actorId: "11111111-1111-4111-8111-111111111111",
              author: { id: "11111111-1111-4111-8111-111111111111", displayName: "Ada" },
              anchor: listedAnchor,
              body: "Existing note",
              status: status === "all" ? "open" : status,
              metadata: {},
              resolvedAt: status === "resolved" ? "2026-05-20T12:06:00.000Z" : null,
              createdAt: "2026-05-20T12:00:00.000Z",
              updatedAt:
                status === "resolved" ? "2026-05-20T12:06:00.000Z" : "2026-05-20T12:00:00.000Z",
            },
            ...extraListedComments,
          ],
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

  it("renders comments and creates document-level comments with mention metadata", async () => {
    render();
    await settle();

    expect(container.textContent ?? "").toContain("Comments");
    expect(container.textContent ?? "").toContain("Ada");
    expect(container.textContent ?? "").toContain("Existing note");
    expect(toolCalls.find((call) => call.url === "/api/tools/docs.comment.list")?.body).toEqual({
      docId,
      status: "open",
    });

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      setTextareaValue(textarea!, "Needs @ada owner");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const addButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Add"),
    );
    expect(addButton).not.toBeNull();
    act(() => {
      addButton?.click();
    });
    await settle();

    const createCall = toolCalls.find((call) => call.url === "/api/tools/docs.comment.create");
    expect(createCall?.body).toMatchObject({
      docId,
      body: "Needs @ada owner",
      anchor: {
        kind: "native-document",
        target: "document",
        documentId: docId,
        formatVersion: 1,
      },
      metadata: {
        source: "web.native-document.comments-rail",
        mentionsText: ["ada"],
      },
    });
    expect(
      toolCalls.filter((call) => call.url === "/api/tools/docs.comment.list").length,
    ).toBeGreaterThan(1);

    const resolveButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Resolve",
    );
    expect(resolveButton).not.toBeNull();
    act(() => {
      resolveButton?.click();
    });
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/docs.comment.resolve")?.body).toEqual({
      commentId: "44444444-4444-4444-8444-444444444444",
    });

    clickButton("Resolved");
    await settle();

    expect(
      toolCalls.filter(
        (call) =>
          call.url === "/api/tools/docs.comment.list" &&
          (call.body as { readonly status?: string }).status === "resolved",
      ).length,
    ).toBeGreaterThan(0);
    expect(container.textContent ?? "").toContain("Resolved");
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.trim() === "Resolve",
      ),
    ).toBeUndefined();

    clickButton("All");
    await settle();

    expect(
      toolCalls.filter(
        (call) =>
          call.url === "/api/tools/docs.comment.list" &&
          (call.body as { readonly status?: string }).status === "all",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("creates selected-text native comments with selection anchors", async () => {
    render({ selectionAnchor: { from: 8, to: 21, text: "selected text" } });
    await settle();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    expect(textarea).not.toBeNull();
    act(() => {
      setTextareaValue(textarea!, "Review selection");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickButton("Add");
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/api/tools/docs.comment.create")?.body,
    ).toMatchObject({
      docId,
      body: "Review selection",
      anchor: {
        kind: "native-document",
        target: "selection",
        documentId: docId,
        formatVersion: 1,
        quote: "selected text",
        selection: { from: 8, to: 21, text: "selected text" },
      },
    });
  });

  it("dispatches selection navigation from anchored comments", async () => {
    listedAnchor = {
      kind: "native-document",
      target: "selection",
      documentId: docId,
      formatVersion: 1,
      quote: "Existing",
      selection: { from: 4, to: 12, text: "Existing" },
    };
    const details: unknown[] = [];
    const onSelectAnchor = (event: Event) => {
      if (event instanceof CustomEvent) {
        details.push(event.detail);
      }
    };
    window.addEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);

    render();
    await settle();
    clickButton("Show");

    expect(details).toEqual([
      {
        documentId: docId,
        selection: { from: 4, to: 12, text: "Existing" },
      },
    ]);
    window.removeEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);
  });

  it("renders threaded replies and creates reply comments with parent metadata", async () => {
    extraListedComments = [
      {
        id: "66666666-6666-4666-8666-666666666666",
        documentId: docId,
        parentCommentId: "44444444-4444-4444-8444-444444444444",
        actorId: "22222222-2222-4222-8222-222222222222",
        author: { id: "22222222-2222-4222-8222-222222222222", displayName: "Grace" },
        anchor: { kind: "document" },
        body: "Reply already here",
        status: "open",
        metadata: { parentCommentId: "44444444-4444-4444-8444-444444444444" },
        resolvedAt: null,
        createdAt: "2026-05-20T12:01:00.000Z",
        updatedAt: "2026-05-20T12:01:00.000Z",
      },
    ];

    render();
    await settle();

    expect(container.textContent ?? "").toContain("Reply already here");
    clickButton("Reply");

    const replyTextarea = container.querySelector<HTMLTextAreaElement>(
      "#native-document-reply-44444444-4444-4444-8444-444444444444",
    );
    expect(replyTextarea).not.toBeNull();
    act(() => {
      setTextareaValue(replyTextarea!, "Looping in @grace");
      replyTextarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickButton("Send");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/docs.comment.create").at(-1)?.body,
    ).toMatchObject({
      docId,
      parentCommentId: "44444444-4444-4444-8444-444444444444",
      body: "Looping in @grace",
      anchor: listedAnchor,
      metadata: {
        source: "web.native-document.comments-rail.reply",
        parentCommentId: "44444444-4444-4444-8444-444444444444",
        mentionsText: ["grace"],
      },
    });
  });

  it("edits, deletes, and reopens document comments", async () => {
    render();
    await settle();

    clickButton("Edit");
    const editTextarea = container.querySelector<HTMLTextAreaElement>(
      "#native-document-edit-44444444-4444-4444-8444-444444444444",
    );
    expect(editTextarea).not.toBeNull();
    act(() => {
      setTextareaValue(editTextarea!, "Updated note");
      editTextarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickButton("Save");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/docs.comment.update")?.body).toEqual({
      commentId: "44444444-4444-4444-8444-444444444444",
      body: "Updated note",
    });

    clickButton("Delete");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/docs.comment.delete")?.body).toEqual({
      commentId: "44444444-4444-4444-8444-444444444444",
    });
    expect(
      toolCalls.filter((call) => call.url === "/api/tools/docs.comment.list").length,
    ).toBeGreaterThan(2);

    clickButton("Resolved");
    await settle();
    clickButton("Reopen");
    await settle();

    expect(toolCalls.find((call) => call.url === "/api/tools/docs.comment.reopen")?.body).toEqual({
      commentId: "44444444-4444-4444-8444-444444444444",
    });
  });

  it("edits and deletes threaded replies by reply id", async () => {
    extraListedComments = [
      {
        id: "66666666-6666-4666-8666-666666666666",
        documentId: docId,
        parentCommentId: "44444444-4444-4444-8444-444444444444",
        actorId: "22222222-2222-4222-8222-222222222222",
        author: { id: "22222222-2222-4222-8222-222222222222", displayName: "Grace" },
        anchor: { kind: "document" },
        body: "Reply already here",
        status: "open",
        metadata: { parentCommentId: "44444444-4444-4444-8444-444444444444" },
        resolvedAt: null,
        createdAt: "2026-05-20T12:01:00.000Z",
        updatedAt: "2026-05-20T12:01:00.000Z",
      },
    ];

    render();
    await settle();

    const editButtons = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => button.textContent?.trim() === "Edit",
    );
    act(() => {
      editButtons.at(-1)?.click();
    });
    const replyEditTextarea = container.querySelector<HTMLTextAreaElement>(
      "#native-document-edit-66666666-6666-4666-8666-666666666666",
    );
    expect(replyEditTextarea).not.toBeNull();
    act(() => {
      setTextareaValue(replyEditTextarea!, "Updated reply");
      replyEditTextarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickButton("Save");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/docs.comment.update").at(-1)?.body,
    ).toEqual({
      commentId: "66666666-6666-4666-8666-666666666666",
      body: "Updated reply",
    });

    const deleteButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => button.textContent?.trim() === "Delete");
    act(() => {
      deleteButtons.at(-1)?.click();
    });
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/docs.comment.delete").at(-1)?.body,
    ).toEqual({
      commentId: "66666666-6666-4666-8666-666666666666",
    });
  });
});

describe("extractMentionText", () => {
  it("extracts unique mention tokens", () => {
    expect(extractMentionText("Loop in @ada and @grace. @ada")).toEqual(["ada", "grace"]);
  });
});

describe("nativeDocumentCommentThreads", () => {
  it("groups metadata-backed replies under parent comments", () => {
    const comments = [
      commentRecord({ id: "root-1", body: "Root one" }),
      commentRecord({
        id: "reply-1",
        body: "Reply one",
        parentCommentId: "root-1",
        metadata: { parentCommentId: "legacy-root-1" },
      }),
      commentRecord({
        id: "orphan-1",
        body: "Orphan",
        metadata: { parentCommentId: "missing" },
      }),
    ];

    expect(nativeDocumentCommentThreads(comments)).toMatchObject([
      { comment: { id: "root-1" }, replies: [{ id: "reply-1" }] },
      { comment: { id: "orphan-1" }, replies: [] },
    ]);
  });
});

function commentRecord(input: {
  readonly id: string;
  readonly body: string;
  readonly parentCommentId?: string | null;
  readonly metadata?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    documentId: docId,
    parentCommentId: input.parentCommentId ?? null,
    actorId: "11111111-1111-4111-8111-111111111111",
    anchor: { kind: "document" },
    body: input.body,
    status: "open",
    metadata: input.metadata ?? {},
    resolvedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function render(
  options: {
    readonly selectionAnchor?: {
      readonly from: number;
      readonly to: number;
      readonly text: string;
    };
  } = {},
) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <NativeDocumentCommentsRail
          documentId={docId}
          formatVersion={1}
          selectionAnchor={options.selectionAnchor ?? null}
        />
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

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter invoked via Reflect.apply with element receiver
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native textarea value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
}

function clickButton(label: string): void {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (button === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  act(() => {
    button.click();
  });
}
