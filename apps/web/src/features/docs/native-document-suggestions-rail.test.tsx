// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeDocumentSuggestionsRail } from "./native-document-suggestions-rail";
import { NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT } from "./native-document-anchors";

const docId = "33333333-3333-4333-8333-333333333333";
const suggestionId = "77777777-7777-4777-8777-777777777777";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let listedAnchor: Record<string, unknown>;
let listedSuggestions: ReturnType<typeof suggestion>[];

describe("NativeDocumentSuggestionsRail", () => {
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
    listedAnchor = { kind: "native-document" };
    listedSuggestions = [suggestion({})];
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });
      if (url === "/api/tools/docs.suggestion.create") {
        return Promise.resolve(Response.json(suggestion({ beforeText: "teh", afterText: "the" })));
      }
      if (url === "/api/tools/docs.suggestion.resolve") {
        const status = (body as { readonly status?: "accepted" | "rejected" }).status ?? "accepted";
        const suggestionId =
          (body as { readonly suggestionId?: string }).suggestionId ?? listedSuggestions[0]?.id;
        return Promise.resolve(Response.json(suggestion({ id: suggestionId, status })));
      }
      if (url === "/api/tools/docs.suggestion.resolve-batch") {
        const status = (body as { readonly status?: "accepted" | "rejected" }).status ?? "accepted";
        const suggestionIds = (body as { readonly suggestionIds?: readonly string[] })
          .suggestionIds;
        const suggestions = listedSuggestions
          .filter((candidate) => suggestionIds?.includes(candidate.id) ?? false)
          .map((candidate) => suggestion({ ...candidate, status }));
        return Promise.resolve(Response.json({ suggestions, count: suggestions.length }));
      }
      if (url === "/api/tools/docs.suggestion.generate") {
        return Promise.resolve(
          Response.json({
            slotId: "docs.smart-write",
            text: "the plan",
            metadata: { providerId: "test-ai", model: "test-model" },
          }),
        );
      }
      const status =
        (body as { readonly status?: "pending" | "accepted" | "rejected" } | undefined)?.status ??
        undefined;
      return Promise.resolve(
        Response.json({
          suggestions: listedSuggestions.filter(
            (candidate) => status === undefined || candidate.status === status,
          ),
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

  it("renders suggestions and resolves them", async () => {
    render();
    await settle();

    expect(container.textContent ?? "").toContain("Suggestions");
    expect(container.textContent ?? "").toContain("teh plan");
    expect(container.textContent ?? "").toContain("the plan");
    expect(
      toolCalls.find((call) => call.url === "/api/tools/docs.suggestion.list")?.body,
    ).toMatchObject({ docId, status: "pending" });

    const acceptButton = buttonWithExactText("Accept");
    expect(acceptButton).not.toBeNull();
    act(() => {
      acceptButton?.click();
    });
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/api/tools/docs.suggestion.resolve")?.body,
    ).toEqual({
      suggestionId,
      status: "accepted",
    });
    expect(
      toolCalls.filter((call) => call.url === "/api/tools/docs.suggestion.list").length,
    ).toBeGreaterThan(0);

    clickButton("Accepted");
    await settle();

    expect(
      toolCalls.filter(
        (call) =>
          call.url === "/api/tools/docs.suggestion.list" &&
          (call.body as { readonly status?: string }).status === "accepted",
      ).length,
    ).toBeGreaterThan(0);
    expect(container.textContent ?? "").toContain("Accepted");
    expect(buttonWithExactText("Accept")).toBeNull();
    expect(buttonWithExactText("Reject")).toBeNull();

    clickButton("Rejected");
    await settle();

    expect(
      toolCalls.filter(
        (call) =>
          call.url === "/api/tools/docs.suggestion.list" &&
          (call.body as { readonly status?: string }).status === "rejected",
      ).length,
    ).toBeGreaterThan(0);

    clickButton("All");
    await settle();

    expect(
      toolCalls.filter(
        (call) =>
          call.url === "/api/tools/docs.suggestion.list" &&
          !("status" in ((call.body as Record<string, unknown>) ?? {})),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("creates document-level native suggestions", async () => {
    render();
    await settle();

    setInputValue("native-document-suggestion-before", "teh plan");
    setInputValue("native-document-suggestion-after", "the plan");
    setTextareaValue("native-document-suggestion-reason", "Typo");

    const suggestButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.includes("Suggest"),
    );
    expect(suggestButton).not.toBeNull();
    act(() => {
      suggestButton?.click();
    });
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/api/tools/docs.suggestion.create")?.body,
    ).toMatchObject({
      docId,
      beforeText: "teh plan",
      afterText: "the plan",
      reason: "Typo",
      anchor: {
        kind: "native-document",
        target: "document",
        documentId: docId,
        formatVersion: 1,
      },
      metadata: { source: "web.native-document.suggestions-rail" },
    });
  });

  it("bulk accepts and rejects pending suggestions", async () => {
    listedSuggestions = [
      suggestion({ id: "77777777-7777-4777-8777-777777777777", beforeText: "teh plan" }),
      suggestion({ id: "88888888-8888-4888-8888-888888888888", beforeText: "recieve update" }),
    ];
    render();
    await settle();

    clickButton("Accept all");
    await settle();

    expect(
      toolCalls
        .filter((call) => call.url === "/api/tools/docs.suggestion.resolve-batch")
        .map((call) => call.body),
    ).toEqual([
      {
        docId,
        suggestionIds: [
          "77777777-7777-4777-8777-777777777777",
          "88888888-8888-4888-8888-888888888888",
        ],
        status: "accepted",
      },
    ]);

    toolCalls = [];
    listedSuggestions = [
      suggestion({ id: "77777777-7777-4777-8777-777777777777", beforeText: "teh plan" }),
      suggestion({ id: "88888888-8888-4888-8888-888888888888", beforeText: "recieve update" }),
    ];
    clickButton("Reject all");
    await settle();

    expect(
      toolCalls
        .filter((call) => call.url === "/api/tools/docs.suggestion.resolve-batch")
        .map((call) => call.body),
    ).toEqual([
      {
        docId,
        suggestionIds: [
          "77777777-7777-4777-8777-777777777777",
          "88888888-8888-4888-8888-888888888888",
        ],
        status: "rejected",
      },
    ]);
  });

  it("bulk reviews pending suggestions by author and type", async () => {
    listedSuggestions = [
      suggestion({
        id: "77777777-7777-4777-8777-777777777777",
        actorId: "11111111-1111-4111-8111-111111111111",
        beforeText: "manual typo",
      }),
      suggestion({
        id: "88888888-8888-4888-8888-888888888888",
        actorId: "11111111-1111-4111-8111-111111111111",
        beforeText: "translated typo",
        metadata: { aiDraft: { slotId: "docs.translate" } },
      }),
      suggestion({
        id: "99999999-9999-4999-8999-999999999999",
        actorId: "22222222-2222-4222-8222-222222222222",
        beforeText: "smart typo",
        metadata: { aiDraft: { slotId: "docs.smart-write" } },
      }),
    ];
    render();
    await settle();

    const dashboard = container.querySelector('[aria-label="Suggestion review dashboard"]');
    expect(dashboard?.textContent ?? "").toContain("Pending 3");
    expect(
      container.querySelector('[aria-label="Pending suggestions by author"]')?.textContent ?? "",
    ).toContain("11111111-1111-4111-8111-111111111111 2");
    expect(
      container.querySelector('[aria-label="Pending suggestions by type"]')?.textContent ?? "",
    ).toContain("Smart write 1");
    expect(
      container.querySelector('[aria-label="Pending suggestions by type"]')?.textContent ?? "",
    ).toContain("Translate 1");

    setSelectValue("Suggestion review author", "11111111-1111-4111-8111-111111111111");
    clickButton("Accept author");
    await settle();

    expect(
      toolCalls
        .filter((call) => call.url === "/api/tools/docs.suggestion.resolve-batch")
        .map((call) => call.body),
    ).toEqual([
      {
        docId,
        suggestionIds: [
          "77777777-7777-4777-8777-777777777777",
          "88888888-8888-4888-8888-888888888888",
        ],
        status: "accepted",
      },
    ]);

    toolCalls = [];
    listedSuggestions = [
      suggestion({
        id: "77777777-7777-4777-8777-777777777777",
        actorId: "11111111-1111-4111-8111-111111111111",
        beforeText: "manual typo",
      }),
      suggestion({
        id: "88888888-8888-4888-8888-888888888888",
        actorId: "11111111-1111-4111-8111-111111111111",
        beforeText: "translated typo",
        metadata: { aiDraft: { slotId: "docs.translate" } },
      }),
      suggestion({
        id: "99999999-9999-4999-8999-999999999999",
        actorId: "22222222-2222-4222-8222-222222222222",
        beforeText: "smart typo",
        metadata: { aiDraft: { slotId: "docs.smart-write" } },
      }),
    ];
    setSelectValue("Suggestion review type", "docs.smart-write");
    clickButton("Reject type");
    await settle();

    expect(
      toolCalls
        .filter((call) => call.url === "/api/tools/docs.suggestion.resolve-batch")
        .map((call) => call.body),
    ).toEqual([
      {
        docId,
        suggestionIds: ["99999999-9999-4999-8999-999999999999"],
        status: "rejected",
      },
    ]);
  });

  it("shows full suggestion analytics while the list is filtered", async () => {
    listedSuggestions = [
      suggestion({
        id: "77777777-7777-4777-8777-777777777777",
        beforeText: "pending typo",
        status: "pending",
        createdAt: "2000-01-01T00:00:00.000Z",
        anchor: selectionAnchor(4, 16, "pending typo"),
      }),
      suggestion({
        id: "88888888-8888-4888-8888-888888888888",
        beforeText: "accepted rewrite",
        status: "accepted",
        metadata: { aiDraft: { slotId: "docs.smart-write" } },
        anchor: selectionAnchor(40, 56, "accepted rewrite"),
      }),
      suggestion({
        id: "99999999-9999-4999-8999-999999999999",
        beforeText: "accepted summary",
        status: "accepted",
        metadata: { aiDraft: { slotId: "docs.summarize" } },
        anchor: {
          kind: "native-document",
          target: "document",
          documentId: docId,
          formatVersion: 1,
        },
      }),
      suggestion({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        beforeText: "rejected typo",
        status: "rejected",
        anchor: {
          kind: "native-document",
          target: "document",
          documentId: docId,
          formatVersion: 1,
        },
      }),
    ];
    render({ selectionAnchor: { from: 1, to: 20, text: "selected paragraph" } });
    await settle();

    const dashboard = container.querySelector('[aria-label="Suggestion review dashboard"]');
    expect(dashboard?.textContent ?? "").toContain("Pending 1");
    expect(dashboard?.textContent ?? "").toContain("Accepted 2");
    expect(dashboard?.textContent ?? "").toContain("Rejected 1");
    const analytics = container.querySelector('[aria-label="Suggestion review analytics"]');
    expect(analytics?.textContent ?? "").toContain("Reviewed 3/4");
    expect(analytics?.textContent ?? "").toContain("Acceptance 67%");
    expect(analytics?.textContent ?? "").toContain("AI-assisted 2");
    expect(analytics?.textContent ?? "").toContain("Manual 2");
    expect(analytics?.textContent ?? "").toContain("Anchored 2");
    expect(analytics?.textContent ?? "").toContain("Document-level 2");
    expect(analytics?.textContent ?? "").toContain("In selection 1");
    const trackedAnalytics = container.querySelector(
      '[aria-label="Tracked-change analytics dashboard"]',
    );
    expect(trackedAnalytics?.textContent ?? "").toContain("Stale pending 1");
    expect(trackedAnalytics?.textContent ?? "").toContain("Oldest pending");
    expect(trackedAnalytics?.textContent ?? "").toContain("Anchor coverage 2/4 (50%)");
    expect(trackedAnalytics?.textContent ?? "").toContain("AI share 2/4 (50%)");
    expect(container.textContent ?? "").toContain("pending typo");
    expect(container.textContent ?? "").not.toContain("accepted rewrite");
  });

  it("bulk accepts only pending suggestions that overlap the current selection", async () => {
    listedSuggestions = [
      suggestion({
        id: "77777777-7777-4777-8777-777777777777",
        beforeText: "first typo",
        anchor: selectionAnchor(4, 14, "first typo"),
      }),
      suggestion({
        id: "88888888-8888-4888-8888-888888888888",
        beforeText: "second typo",
        anchor: selectionAnchor(18, 29, "second typo"),
      }),
      suggestion({
        id: "99999999-9999-4999-8999-999999999999",
        beforeText: "outside typo",
        anchor: selectionAnchor(44, 56, "outside typo"),
      }),
      suggestion({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        beforeText: "unanchored typo",
        anchor: {
          kind: "native-document",
          target: "document",
          documentId: docId,
          formatVersion: 1,
        },
      }),
    ];
    render({ selectionAnchor: { from: 1, to: 30, text: "selected paragraph" } });
    await settle();

    clickButton("Accept selection");
    await settle();

    expect(
      toolCalls
        .filter((call) => call.url === "/api/tools/docs.suggestion.resolve-batch")
        .map((call) => call.body),
    ).toEqual([
      {
        docId,
        suggestionIds: [
          "77777777-7777-4777-8777-777777777777",
          "88888888-8888-4888-8888-888888888888",
        ],
        status: "accepted",
      },
    ]);

    toolCalls = [];
    listedSuggestions = [
      suggestion({
        id: "77777777-7777-4777-8777-777777777777",
        beforeText: "first typo",
        anchor: selectionAnchor(4, 14, "first typo"),
      }),
      suggestion({
        id: "88888888-8888-4888-8888-888888888888",
        beforeText: "second typo",
        anchor: selectionAnchor(18, 29, "second typo"),
      }),
      suggestion({
        id: "99999999-9999-4999-8999-999999999999",
        beforeText: "outside typo",
        anchor: selectionAnchor(44, 56, "outside typo"),
      }),
    ];

    clickButton("Reject selection");
    await settle();

    expect(
      toolCalls
        .filter((call) => call.url === "/api/tools/docs.suggestion.resolve-batch")
        .map((call) => call.body),
    ).toEqual([
      {
        docId,
        suggestionIds: [
          "77777777-7777-4777-8777-777777777777",
          "88888888-8888-4888-8888-888888888888",
        ],
        status: "rejected",
      },
    ]);
  });

  it("creates selected-text native suggestions with selection anchors", async () => {
    render({ selectionAnchor: { from: 4, to: 12, text: "teh plan" } });
    await settle();

    expect(
      container.querySelector<HTMLInputElement>("#native-document-suggestion-before")?.value,
    ).toBe("teh plan");
    setInputValue("native-document-suggestion-after", "the plan");
    clickButton("Suggest");
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/api/tools/docs.suggestion.create")?.body,
    ).toMatchObject({
      docId,
      beforeText: "teh plan",
      afterText: "the plan",
      anchor: {
        kind: "native-document",
        target: "selection",
        documentId: docId,
        formatVersion: 1,
        quote: "teh plan",
        selection: { from: 4, to: 12, text: "teh plan" },
      },
    });
  });

  it("generates AI draft text and records provider metadata on create", async () => {
    render({ selectionAnchor: { from: 4, to: 12, text: "teh plan" } });
    await settle();

    setTextareaValue("native-document-suggestion-ai-instruction", "Fix the typo");
    clickButton("Smart write");
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/api/tools/docs.suggestion.generate")?.body,
    ).toMatchObject({
      docId,
      slotId: "docs.smart-write",
      selection: "teh plan",
      prompt: "Fix the typo",
    });
    expect(
      container.querySelector<HTMLInputElement>("#native-document-suggestion-after")?.value,
    ).toBe("the plan");

    clickButton("Suggest");
    await settle();

    expect(
      toolCalls.find((call) => call.url === "/api/tools/docs.suggestion.create")?.body,
    ).toMatchObject({
      docId,
      beforeText: "teh plan",
      afterText: "the plan",
      reason: "AI-assisted rewrite",
      metadata: {
        source: "web.native-document.suggestions-rail",
        aiDraft: {
          slotId: "docs.smart-write",
          providerId: "test-ai",
          model: "test-model",
        },
      },
    });
  });

  it("dispatches selection navigation from anchored suggestions", async () => {
    listedAnchor = {
      kind: "native-document",
      target: "selection",
      documentId: docId,
      formatVersion: 1,
      quote: "teh plan",
      selection: { from: 4, to: 12, text: "teh plan" },
    };
    listedSuggestions = [suggestion({})];
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
        selection: { from: 4, to: 12, text: "teh plan" },
      },
    ]);
    window.removeEventListener(NATIVE_DOCUMENT_SELECT_ANCHOR_EVENT, onSelectAnchor);
  });
});

function suggestion(
  overrides: Partial<{
    readonly id: string;
    readonly actorId: string | null;
    readonly beforeText: string;
    readonly afterText: string;
    readonly reason: string;
    readonly status: "pending" | "accepted" | "rejected";
    readonly anchor: Record<string, unknown>;
    readonly metadata: Record<string, unknown>;
    readonly resolvedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string | null;
  }>,
) {
  return {
    id: overrides.id ?? suggestionId,
    documentId: docId,
    actorId: overrides.actorId ?? "11111111-1111-4111-8111-111111111111",
    anchor: overrides.anchor ?? listedAnchor,
    beforeText: overrides.beforeText ?? "teh plan",
    afterText: overrides.afterText ?? "the plan",
    reason: overrides.reason ?? "Typo",
    status: overrides.status ?? "pending",
    metadata: overrides.metadata ?? {},
    resolvedByActorId: null,
    resolvedAt: overrides.resolvedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-05-20T12:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-20T12:00:00.000Z",
  };
}

function selectionAnchor(from: number, to: number, text: string) {
  return {
    kind: "native-document",
    target: "selection",
    documentId: docId,
    formatVersion: 1,
    quote: text,
    selection: { from, to, text },
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
        <NativeDocumentSuggestionsRail
          documentId={docId}
          formatVersion={1}
          selectionAnchor={options.selectionAnchor ?? null}
        />
      </QueryClientProvider>,
    );
  });
}

function clickButton(label: string): void {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  if (button === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  act(() => {
    button.click();
  });
}

function buttonWithExactText(label: string): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
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

function setTextareaValue(id: string, value: string): void {
  const textarea = container.querySelector<HTMLTextAreaElement>(`#${id}`);
  if (textarea === null) {
    throw new Error(`Missing textarea: ${id}`);
  }
  act(() => {
    setNativeTextareaValue(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelectValue(label: string, value: string): void {
  const select = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (select === null) {
    throw new Error(`Missing select: ${label}`);
  }
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setNativeInputValue(element: HTMLInputElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter invoked via Reflect.apply with element receiver
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native input value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
}

function setNativeTextareaValue(element: HTMLTextAreaElement, value: string): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter invoked via Reflect.apply with element receiver
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === undefined) {
    throw new Error("native textarea value setter unavailable");
  }
  Reflect.apply(setter, element, [value]);
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
