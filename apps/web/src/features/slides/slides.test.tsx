// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Slide } from "./slide-canvas";
import { SlideThumb } from "./slide-thumb";
import { SlidesList } from "./slides-list";
import { SlidesEditor } from "./slides-editor";
import type { SlidesApiDeck, SlidesApiSlide } from "./api";
import type { DriveApiEntry } from "@/features/drive/api";
import {
  DECKS,
  SLIDES,
  SLIDE_LAYOUT_OPTIONS,
  type AgendaSlide,
  type BulletsSlide,
  type ImageSlide,
  type SplitSlide,
  type StatsSlide,
  type TitleSlide,
} from "./seed";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** Resolve a `fetch` first-argument into a URL string without `[object Object]`. */
function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

/** Resolve a `fetch` request body into a parsed JSON value. */
function fetchBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return undefined;
  }
  return JSON.parse(body);
}

function findSlide<T>(layout: string): T {
  const slide = SLIDES.find((entry) => entry.layout === layout);
  if (!slide) {
    throw new Error(`missing seed slide for layout ${layout}`);
  }
  return slide as T;
}

/* A backend UUID deck id — passes `isBackendSlidesDeckId`. */
const BACKEND_DECK_ID = "11111111-1111-4111-8111-111111111111";
const BACKEND_SLIDE_A = "22222222-2222-4222-8222-222222222222";
const BACKEND_SLIDE_B = "33333333-3333-4333-8333-333333333333";

function apiDeck(overrides: Partial<SlidesApiDeck> = {}): SlidesApiDeck {
  return {
    id: BACKEND_DECK_ID,
    title: "Backend deck",
    ownerActorId: "actor-1",
    createdByActorId: "actor-1",
    slideCount: 2,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function apiSlide(overrides: Partial<SlidesApiSlide> & Pick<SlidesApiSlide, "id">): SlidesApiSlide {
  return {
    deckId: BACKEND_DECK_ID,
    position: 0,
    layout: "bullets",
    content: { layout: "bullets", title: "Backend slide", items: ["First point"] },
    speakerNotes: "",
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

describe("Slides seed data", () => {
  it("ports the five handoff decks verbatim", () => {
    expect(DECKS).toHaveLength(5);
    expect(DECKS[0]).toMatchObject({
      id: "s1",
      title: "Q3 All-Hands narrative",
      slides: 18,
      shared: 24,
    });
  });

  it("ports the eight handoff slides covering all six layouts", () => {
    expect(SLIDES).toHaveLength(8);
    const layouts = new Set(SLIDES.map((slide) => slide.layout));
    expect(layouts).toEqual(
      new Set(["title", "agenda", "stats", "split", "bullets", "image"]),
    );
  });

  it("exposes layout options matching the six layouts", () => {
    expect(SLIDE_LAYOUT_OPTIONS.map((option) => option.value)).toEqual([
      "title",
      "agenda",
      "stats",
      "split",
      "bullets",
      "image",
    ]);
  });
});

describe("Slide layouts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the title layout with eyebrow, title, and subtitle", () => {
    const slide = findSlide<TitleSlide>("title");
    act(() => root.render(<Slide slide={slide} />));
    expect(container.querySelector("h1")?.textContent).toBe(slide.title);
    expect(container.textContent).toContain(slide.eyebrow);
  });

  it("renders the agenda layout with zero-padded counters", () => {
    const slide = findSlide<AgendaSlide>("agenda");
    act(() => root.render(<Slide slide={slide} />));
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(slide.items.length);
    expect(container.textContent).toContain("01");
    expect(container.textContent).toContain(`0${slide.items.length}`);
  });

  it("renders the stats layout with three statistics", () => {
    const slide = findSlide<StatsSlide>("stats");
    act(() => root.render(<Slide slide={slide} />));
    expect(slide.stats).toHaveLength(3);
    slide.stats.forEach((stat) => {
      expect(container.textContent).toContain(stat.value);
      expect(container.textContent).toContain(stat.label);
    });
  });

  it("renders the split layout quote variant", () => {
    const slide = findSlide<SplitSlide>("split");
    act(() => root.render(<Slide slide={slide} />));
    expect(container.textContent).toContain(slide.left);
  });

  it("renders the bullets layout rows", () => {
    const slide = findSlide<BulletsSlide>("bullets");
    act(() => root.render(<Slide slide={slide} />));
    expect(container.querySelectorAll("li")).toHaveLength(slide.items.length);
  });

  it("renders the image layout with a dashed placeholder caption", () => {
    const slide = findSlide<ImageSlide>("image");
    act(() => root.render(<Slide slide={slide} />));
    expect(container.textContent).toContain(slide.note);
  });
});

describe("SlideThumb", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks the active thumbnail and reports the slide index", () => {
    const slide = SLIDES[2];
    if (!slide) {
      throw new Error("expected a third seed slide");
    }
    act(() =>
      root.render(
        <SlideThumb
          slide={slide}
          index={2}
          active
          onSelect={() => undefined}
        />,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-current")).toBe("true");
    expect(button?.getAttribute("aria-label")).toContain("Slide 3");
  });

  it("invokes onMoveDown when the reorder control is clicked", () => {
    const slide = SLIDES[0];
    if (!slide) {
      throw new Error("expected a seed slide");
    }
    let moved = false;
    act(() =>
      root.render(
        <SlideThumb
          slide={slide}
          index={0}
          active
          onSelect={() => undefined}
          onMoveDown={() => (moved = true)}
        />,
      ),
    );
    const down = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move slide 1 down"]',
    );
    if (!down) {
      throw new Error("expected a move-down control");
    }
    act(() => down.click());
    expect(moved).toBe(true);
  });
});

describe("Slides surface — backend wiring", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let toolCalls: Array<{ url: string; body: unknown }>;
  let decks: SlidesApiDeck[];
  let slides: SlidesApiSlide[];

  /** Build a DriveApiEntry for a deck, mapping SlidesApiDeck fields into metadata. */
  function apiDeckToDriveEntry(deck: SlidesApiDeck): DriveApiEntry {
    return {
      id: deck.id,
      type: "file",
      name: deck.title,
      folderId: null,
      ownerActorId: deck.ownerActorId,
      app: "slides",
      metadata: {
        title: deck.title,
        slideCount: deck.slideCount,
        ownerName: "You",
        sharedCount: 0,
      },
      deletedAt: null,
      createdAt: deck.createdAt,
      updatedAt: deck.updatedAt,
    };
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    toolCalls = [];
    decks = [apiDeck()];
    slides = [
      apiSlide({ id: BACKEND_SLIDE_A, position: 0 }),
      apiSlide({ id: BACKEND_SLIDE_B, position: 1 }),
    ];
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = fetchUrl(input);
      const body = fetchBody(init?.body);
      if (url !== "/api/auth/get-session") {
        toolCalls.push({ url, body });
      }
      if (url === "/api/auth/get-session") {
        return Promise.resolve(Response.json({}));
      }
      if (url === "/api/tools/drive.list") {
        return Promise.resolve(
          Response.json({ entries: decks.map(apiDeckToDriveEntry) }),
        );
      }
      if (url === "/api/tools/slides.deck.get") {
        return Promise.resolve(Response.json({ deck: decks[0], slides }));
      }
      if (url === "/api/tools/slides.deck.create") {
        const created = apiDeck({
          id: BACKEND_DECK_ID,
          title: (body as { title: string }).title,
        });
        return Promise.resolve(Response.json(created));
      }
      if (url === "/api/tools/slides.deck.update") {
        return Promise.resolve(Response.json(apiDeck()));
      }
      if (url === "/api/tools/slides.deck.delete") {
        return Promise.resolve(Response.json({ deckId: BACKEND_DECK_ID, deleted: true }));
      }
      if (url === "/api/tools/slides.slide.create") {
        return Promise.resolve(Response.json(apiSlide({ id: "new-slide", position: 2 })));
      }
      if (url === "/api/tools/slides.slide.update") {
        return Promise.resolve(Response.json(apiSlide({ id: BACKEND_SLIDE_A })));
      }
      if (url === "/api/tools/slides.slide.delete") {
        return Promise.resolve(Response.json({ slideId: BACKEND_SLIDE_A, deleted: true }));
      }
      if (url === "/api/tools/slides.slide.reorder") {
        return Promise.resolve(Response.json({ deckId: BACKEND_DECK_ID, slides }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  function renderList(query = "") {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SlidesList onOpen={() => undefined} query={query} />
        </QueryClientProvider>,
      );
    });
  }

  function renderEditor(deckId: string) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SlidesEditor deckId={deckId} onBack={() => undefined} />
        </QueryClientProvider>,
      );
    });
  }

  async function settle() {
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  function callsTo(toolId: string): Array<{ url: string; body: unknown }> {
    return toolCalls.filter((call) => call.url === `/api/tools/${toolId}`);
  }

  it("lists backend decks from drive.list with app:\"slides\" merged over the seed", async () => {
    renderList();
    await settle();
    const driveCalls = callsTo("drive.list");
    expect(driveCalls).toHaveLength(1);
    expect((driveCalls[0]?.body as { app: string }).app).toBe("slides");
    expect(container.textContent).toContain("Backend deck");
    // Seed decks still render as offline fallback rows.
    expect(container.textContent).toContain("Q3 All-Hands narrative");
  });

  it("creates a deck via slides.deck.create when New deck is clicked", async () => {
    renderList();
    await settle();
    const newButton = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("New deck"),
    );
    if (!newButton) {
      throw new Error("expected a New deck button");
    }
    act(() => newButton.click());
    await settle();
    const createCalls = callsTo("slides.deck.create");
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0]?.body as { title: string }).title).toBe("Untitled deck");
  });

  it("deletes a backend deck via slides.deck.delete from the row menu", async () => {
    renderList();
    await settle();
    const menuButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More actions for Backend deck"]',
    );
    if (!menuButton) {
      throw new Error("expected a row action menu");
    }
    act(() => menuButton.click());
    const deleteItem = [...container.querySelectorAll('button[role="menuitem"]')].find((node) =>
      node.textContent?.includes("Delete"),
    );
    act(() => (deleteItem as HTMLButtonElement).click());
    await settle();
    const deleteCalls = callsTo("slides.deck.delete");
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0]?.body as { deckId: string }).deckId).toBe(BACKEND_DECK_ID);
  });

  it("falls back to seed decks when drive.list errors", async () => {
    fetchMock.mockImplementation((input) => {
      const url = fetchUrl(input);
      if (url === "/api/auth/get-session") {
        return Promise.resolve(Response.json({}));
      }
      if (url === "/api/tools/drive.list") {
        return Promise.resolve(Response.json({ error: "boom" }, { status: 500 }));
      }
      return Promise.resolve(Response.json({}));
    });
    renderList();
    await settle();
    expect(container.textContent).toContain("Slides backend unavailable");
    expect(container.textContent).toContain("Q3 All-Hands narrative");
  });

  it("loads a backend deck's slides via slides.deck.get", async () => {
    renderEditor(BACKEND_DECK_ID);
    await settle();
    const getCalls = callsTo("slides.deck.get");
    expect(getCalls).toHaveLength(1);
    expect((getCalls[0]?.body as { deckId: string }).deckId).toBe(BACKEND_DECK_ID);
    expect(container.textContent).toContain("Slide 1 of 2");
  });

  it("adds a slide via slides.slide.create from the thumbnail strip", async () => {
    renderEditor(BACKEND_DECK_ID);
    await settle();
    const addButton = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes("Add slide"),
    );
    if (!addButton) {
      throw new Error("expected an Add slide button");
    }
    act(() => addButton.click());
    await settle();
    expect(callsTo("slides.slide.create")).toHaveLength(1);
  });

  it("reorders slides via slides.slide.reorder when a thumb is moved down", async () => {
    renderEditor(BACKEND_DECK_ID);
    await settle();
    const down = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Move slide 1 down"]',
    );
    if (!down) {
      throw new Error("expected a move-down control");
    }
    act(() => down.click());
    await settle();
    const reorderCalls = callsTo("slides.slide.reorder");
    expect(reorderCalls).toHaveLength(1);
    expect((reorderCalls[0]?.body as { slideIds: string[] }).slideIds).toEqual([
      BACKEND_SLIDE_B,
      BACKEND_SLIDE_A,
    ]);
  });

  it("deletes the current slide via slides.slide.delete", async () => {
    renderEditor(BACKEND_DECK_ID);
    await settle();
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete slide"]',
    );
    if (!deleteButton) {
      throw new Error("expected a Delete slide button");
    }
    act(() => deleteButton.click());
    await settle();
    const deleteCalls = callsTo("slides.slide.delete");
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0]?.body as { slideId: string }).slideId).toBe(BACKEND_SLIDE_A);
  });

  it("changes a slide layout via slides.slide.update", async () => {
    renderEditor(BACKEND_DECK_ID);
    await settle();
    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Slide layout"]',
    );
    if (!select) {
      throw new Error("expected a layout select");
    }
    act(() => {
      select.value = "title";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    const updateCalls = callsTo("slides.slide.update");
    expect(updateCalls).toHaveLength(1);
    expect((updateCalls[0]?.body as { content: { layout: string } }).content.layout).toBe("title");
  });
});

describe("SlidesList — seed fallback (no backend)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = fetchUrl(input);
        if (url === "/api/auth/get-session") {
          return Promise.resolve(Response.json({}));
        }
        return Promise.resolve(Response.json({ error: "offline" }, { status: 503 }));
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  });

  function renderList(query: string) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SlidesList onOpen={() => undefined} query={query} />
        </QueryClientProvider>,
      );
    });
  }

  async function settle() {
    for (let i = 0; i < 30; i += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }

  it("renders a Recent grid and a row per seed deck", async () => {
    renderList("");
    await settle();
    expect(container.textContent).toContain("Recent");
    expect(container.textContent).toContain("All presentations");
    DECKS.forEach((deck) => {
      expect(container.textContent).toContain(deck.owner);
    });
  });

  it("opens a seed deck when a table row is clicked", async () => {
    let opened: string | null = null;
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SlidesList onOpen={(id) => (opened = id)} query="" />
        </QueryClientProvider>,
      );
    });
    await settle();
    const rows = [...container.querySelectorAll("button")].filter((node) =>
      node.textContent?.includes("Q3 All-Hands narrative"),
    );
    const tableRow = rows[rows.length - 1];
    if (!tableRow) {
      throw new Error("expected a deck table row");
    }
    act(() => {
      tableRow.click();
    });
    expect(opened).toBe("s1");
  });

  it("filters decks by the live search query", async () => {
    renderList("board");
    await settle();
    expect(container.textContent).toContain("Board update — May 2026");
    expect(container.textContent).not.toContain("Engineering onsite");
  });

  it("shows an empty state when nothing matches", async () => {
    renderList("zzz");
    await settle();
    expect(container.textContent).toContain("No presentations for");
  });
});

describe("SlidesEditor — seed fallback (no backend)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
  });

  function renderEditor(onBack: () => void) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SlidesEditor deckId="s1" onBack={onBack} />
        </QueryClientProvider>,
      );
    });
  }

  it("renders the deck title and slide counter for a seed deck", () => {
    renderEditor(() => undefined);
    expect(container.textContent).toContain("Q3 All-Hands narrative");
    expect(container.textContent).toContain(`Slide 1 of ${SLIDES.length}`);
  });

  it("advances to the selected slide via the thumbnail strip", () => {
    renderEditor(() => undefined);
    const thumbs = [...container.querySelectorAll("button")].filter((node) =>
      node.getAttribute("aria-label")?.startsWith("Slide "),
    );
    const thirdThumb = thumbs[2];
    if (!thirdThumb) {
      throw new Error("expected a third slide thumbnail");
    }
    act(() => {
      thirdThumb.click();
    });
    expect(container.textContent).toContain(`Slide 3 of ${SLIDES.length}`);
  });

  it("toggles the speaker-notes panel via the Notes button", () => {
    renderEditor(() => undefined);
    expect(container.querySelector("#slide-speaker-notes")).not.toBeNull();
    const notesButton = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.includes("Notes"),
    );
    act(() => {
      notesButton?.click();
    });
    expect(container.querySelector("#slide-speaker-notes")).toBeNull();
  });

  it("returns to the list view when Back is clicked", () => {
    let back = false;
    renderEditor(() => (back = true));
    const backButton = container.querySelector(
      'button[aria-label="Back to presentations"]',
    );
    act(() => {
      (backButton as HTMLButtonElement).click();
    });
    expect(back).toBe(true);
  });
});
