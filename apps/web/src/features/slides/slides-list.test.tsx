// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidesList } from "./slides-list";

const deckId = "11111111-1111-4111-8111-111111111111";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let onOpen: ReturnType<typeof vi.fn>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;

describe("SlidesList", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    onOpen = vi.fn();
    toolCalls = [];
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = parseRequestBody(init);
      toolCalls.push({ url, body });

      if (url === "/api/tools/drive.list") {
        return Promise.resolve(Response.json({ entries: [] }));
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
    root.unmount();
    container.remove();
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
  const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.includes(label) === true,
  );
  if (target === undefined) {
    throw new Error(`Missing button: ${label}`);
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
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
