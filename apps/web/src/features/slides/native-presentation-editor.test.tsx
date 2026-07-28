// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWebPlatformHost, WebPlatformProvider, type WebPlatformHost } from "@helix/sdk-web";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlidesApiSlide, SlidesDriveComment } from "./api";
import {
  NativePresentationEditor,
  type NativePresentationEditorProps,
} from "./native-presentation-editor";
import type { SlideShape } from "./seed";

const deckId = "11111111-1111-4111-8111-111111111111";
const firstSlideId = "22222222-2222-4222-8222-222222222222";
const secondSlideId = "33333333-3333-4333-8333-333333333333";
const deckVersionId = "99999999-9999-4999-8999-999999999999";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let platformHost: WebPlatformHost;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let toolCalls: Array<{ readonly url: string; readonly body: unknown }>;
let deckMetadata: Record<string, unknown>;
let slides: SlidesApiSlide[];
let comments: SlidesDriveComment[];
let originalMediaDevices: Navigator["mediaDevices"] | undefined;
let originalClipboard: Navigator["clipboard"] | undefined;
let clipboardWriteText: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;

describe("NativePresentationEditor", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    window.localStorage.clear();
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    platformHost = createWebPlatformHost({
      queryClient,
      getColorMode: () => "system",
    });
    window.history.replaceState(null, "", `/slides?deck=${deckId}&comment=comment-1&q=board`);
    toolCalls = [];
    deckMetadata = { audience: "board" };
    originalMediaDevices = navigator.mediaDevices;
    originalClipboard = navigator.clipboard;
    clipboardWriteText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    MockMediaRecorder.instances = [];
    MockMediaStreamTrack.instances = [];
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", undefined);
    slides = [
      slide(
        firstSlideId,
        0,
        {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
        },
        {
          speakerNotes: "Opening notes",
        },
      ),
      slide(secondSlideId, 1, {
        layout: "title",
        title: "Appendix",
        subtitle: "Reference",
      }),
    ];
    comments = [
      comment("comment-1", {
        anchor: {
          kind: "slides-slide",
          target: "slide",
          deckId,
          slideId: firstSlideId,
          slideIndex: 0,
          slideTitle: "Launch story",
        },
        body: "Tighten the opening.",
      }),
    ];
    fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      toolCalls.push({ url, body });

      if (url === "/api/auth/get-session") {
        return Promise.resolve(
          Response.json({
            user: {
              id: "session-user",
              email: "owner@helix.local",
              name: "Owner One",
              actorId: "actor-1",
            },
          }),
        );
      }

      if (url === "/api/tools/slides.deck.get") {
        return Promise.resolve(Response.json({ deck: deck(), slides }));
      }

      if (url === "/api/tools/drive.access.list") {
        return Promise.resolve(
          Response.json({
            grants: [
              {
                actorId: "actor-2",
                role: "reader",
                displayName: "Maya Chen",
                email: "maya@helix.local",
                grantedByActorId: "actor-1",
                expiresAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: "2026-05-20T12:00:00.000Z",
              },
            ],
          }),
        );
      }

      if (url === "/api/tools/slides.deck.update") {
        const update = body as {
          readonly deckId: string;
          readonly title?: string;
          readonly metadata?: Record<string, unknown>;
        };
        deckMetadata = update.metadata ?? deckMetadata;
        return Promise.resolve(
          Response.json({
            ...deck(),
            title: update.title ?? deck().title,
            metadata: deckMetadata,
          }),
        );
      }

      if (url === "/api/tools/drive.comment.list") {
        const list = body as { readonly status?: "open" | "resolved" | "all" };
        return Promise.resolve(
          Response.json({
            comments:
              list.status === undefined || list.status === "all"
                ? comments
                : comments.filter((candidate) => candidate.status === list.status),
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
        const created = comment(`comment-${String(comments.length + 1)}`, {
          objectId: create.objectId,
          parentCommentId: create.parentCommentId ?? null,
          anchor: create.anchor,
          body: create.body,
          metadata: create.metadata ?? {},
        });
        comments = [...comments, created];
        return Promise.resolve(Response.json(created));
      }

      if (url === "/api/tools/drive.comment.resolve") {
        const resolve = body as { readonly commentId: string };
        comments = comments.map((candidate) =>
          candidate.id === resolve.commentId
            ? {
                ...candidate,
                status: "resolved",
                resolvedAt: "2026-05-20T12:10:00.000Z",
                updatedAt: "2026-05-20T12:10:00.000Z",
              }
            : candidate,
        );
        return Promise.resolve(
          Response.json(comments.find((candidate) => candidate.id === resolve.commentId)),
        );
      }

      if (url === "/api/tools/drive.comment.reopen") {
        const reopen = body as { readonly commentId: string };
        comments = comments.map((candidate) =>
          candidate.id === reopen.commentId
            ? {
                ...candidate,
                status: "open",
                resolvedAt: null,
                updatedAt: "2026-05-20T12:12:00.000Z",
              }
            : candidate,
        );
        return Promise.resolve(
          Response.json(comments.find((candidate) => candidate.id === reopen.commentId)),
        );
      }

      if (url === "/api/tools/drive.comment.update") {
        const update = body as { readonly commentId: string; readonly body: string };
        comments = comments.map((candidate) =>
          candidate.id === update.commentId
            ? {
                ...candidate,
                body: update.body,
                updatedAt: "2026-05-20T12:14:00.000Z",
              }
            : candidate,
        );
        return Promise.resolve(
          Response.json(comments.find((candidate) => candidate.id === update.commentId)),
        );
      }

      if (url === "/api/tools/drive.comment.delete") {
        const remove = body as { readonly commentId: string };
        const deleted = comments.find((candidate) => candidate.id === remove.commentId);
        comments = comments.filter(
          (candidate) =>
            candidate.id !== remove.commentId && candidate.parentCommentId !== remove.commentId,
        );
        return Promise.resolve(Response.json(deleted));
      }

      if (url.startsWith("/api/people?")) {
        return Promise.resolve(
          Response.json({
            people: [
              {
                id: "actor-maya",
                email: "maya@example.com",
                displayName: "Maya Chen",
              },
              {
                id: "actor-owner",
                email: "owner@example.com",
                displayName: "Product Owner",
              },
            ],
          }),
        );
      }

      if (url === "/api/tools/slides.export") {
        const exportInput = body as { readonly format?: string };
        const format = exportInput.format ?? "pptx";
        return Promise.resolve(
          Response.json({
            deckId,
            format,
            filename:
              format === "pdf"
                ? "board-narrative.pdf"
                : format === "svg-series"
                  ? "board-narrative-svg-series.zip"
                  : "board-narrative.pptx",
            mimeType:
              format === "pdf"
                ? "application/pdf"
                : format === "svg-series"
                  ? "application/zip"
                  : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            byteSize: 5,
            contentBase64: btoa(format),
            metadata: { generatedBy: `helix.slides.export.${format}` },
          }),
        );
      }

      if (url === "/api/tools/slides.version.list") {
        return Promise.resolve(
          Response.json({
            versions: [
              {
                id: deckVersionId,
                deckId,
                versionNumber: 4,
                mimeType: "application/vnd.helix.presentation+json",
                byteSize: 768,
                sha256: "0".repeat(64),
                metadata: { title: "Restored deck", slideCount: 1 },
                createdByActorId: "actor-1",
                createdAt: "2026-05-20T13:00:00.000Z",
              },
            ],
          }),
        );
      }

      if (url === "/api/tools/slides.version.restore") {
        slides = [
          slide(firstSlideId, 0, {
            layout: "title",
            title: "Restored deck title",
            subtitle: "Recovered from snapshot",
          }),
        ];
        return Promise.resolve(Response.json({ deck: deck(), slides }));
      }

      if (url === "/api/tools/slides.slide.update") {
        const update = body as {
          readonly slideId: string;
          readonly content?: SlidesApiSlide["content"];
          readonly speakerNotes?: string;
        };
        const existing = slides.find((candidate) => candidate.id === update.slideId);
        if (existing === undefined) {
          return Promise.resolve(Response.json({ error: "missing slide" }, { status: 404 }));
        }
        const updated = {
          ...existing,
          content: update.content ?? existing.content,
          speakerNotes: update.speakerNotes ?? existing.speakerNotes,
        };
        slides = slides.map((candidate) => (candidate.id === update.slideId ? updated : candidate));
        return Promise.resolve(Response.json(updated));
      }

      if (url === "/api/tools/slides.slide.create") {
        const create = body as {
          readonly deckId: string;
          readonly content: SlidesApiSlide["content"];
          readonly speakerNotes?: string;
          readonly position?: number;
        };
        const targetPosition = Math.max(
          0,
          Math.min(create.position ?? slides.length, slides.length),
        );
        const created = slide(
          "44444444-4444-4444-8444-444444444444",
          targetPosition,
          create.content,
          {
            speakerNotes: create.speakerNotes ?? "",
          },
        );
        slides = [...slides.slice(0, targetPosition), created, ...slides.slice(targetPosition)].map(
          (candidate, position) => ({ ...candidate, position }),
        );
        return Promise.resolve(Response.json(created));
      }

      if (url === "/api/tools/slides.slide.reorder") {
        const reorder = body as { readonly deckId: string; readonly slideIds: readonly string[] };
        slides = reorder.slideIds.map((slideId, position) => {
          const existing = slides.find((candidate) => candidate.id === slideId);
          if (existing === undefined) {
            throw new Error(`Missing slide in reorder: ${slideId}`);
          }
          return { ...existing, position };
        });
        return Promise.resolve(Response.json({ deckId: reorder.deckId, slides }));
      }

      if (url === "/api/tools/slides.slide.delete") {
        const deletion = body as { readonly slideId: string };
        slides = slides
          .filter((candidate) => candidate.id !== deletion.slideId)
          .map((candidate, position) => ({ ...candidate, position }));
        return Promise.resolve(Response.json({ slideId: deletion.slideId, deleted: true }));
      }

      if (url === "/api/tools/drive.list") {
        return Promise.resolve(
          Response.json({
            entries: [
              driveFile({
                id: "77777777-7777-4777-8777-777777777777",
                name: "Roadmap_hero.png",
                mimeType: "image/png",
              }),
              driveFile({
                id: "88888888-8888-4888-8888-888888888888",
                name: "Product_demo_clip.mp4",
                mimeType: "video/mp4",
              }),
              driveFile({
                id: "99999999-9999-4999-8999-999999999999",
                name: "Founder_update.mp3",
                mimeType: "audio/mpeg",
              }),
              driveFile({
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                name: "Board_packet.pdf",
                mimeType: "application/pdf",
              }),
            ],
          }),
        );
      }

      if (url === "/api/tools/drive.upload") {
        return Promise.resolve(
          Response.json({
            objectId: "55555555-5555-4555-8555-555555555555",
            orgId: "org-1",
            ownerActorId: "actor-1",
            name: "Roadmap_photo.png",
            folderId: null,
            storageKey: "drive/555/Roadmap_photo.png",
            mimeType: "image/png",
            byteSize: 3,
            sha256: "0".repeat(64),
            status: "prepared",
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
            id: "66666666-6666-4666-8666-666666666666",
            orgId: "org-1",
            objectId: "55555555-5555-4555-8555-555555555555",
            versionNumber: 1,
            storageKey: "drive/555/Roadmap_photo.png",
            mimeType: "image/png",
            byteSize: 3,
            sha256: "0".repeat(64),
            metadata: {},
            createdByActorId: "actor-1",
            createdAt: "2026-05-20T12:00:00.000Z",
          }),
        );
      }

      return Promise.resolve(Response.json({ error: "unknown tool" }, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    container.remove();
    queryClient.clear();
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("copies a stable deck link from the Share menu", async () => {
    render();
    await settle();

    clickAppMenu("share");
    clickOpenMenuItem("Copy link");
    await settle();

    const expected = new URL(window.location.href);
    expected.pathname = "/slides";
    expected.search = "";
    expected.searchParams.set("deck", deckId);
    expect(clipboardWriteText).toHaveBeenCalledWith(expected.href);
  });

  it("opens the real Drive share dialog from the app-bar Share button", async () => {
    render();
    await settle();

    clickAppBarShare();
    await settle();

    expect(
      container.querySelector('[role="dialog"][aria-label="Share Board narrative"]'),
    ).not.toBeNull();
    expect(container.textContent ?? "").toContain("People with access");
    expect(container.textContent ?? "").toContain("Maya Chen");
  });

  it("persists Slides view grid, rulers, snap, and zoom preferences from the View menu", async () => {
    render();
    await settle();

    expect(container.querySelector('[data-slides-grid="true"]')).toBeNull();
    expect(container.querySelector('[data-slides-ruler="horizontal"]')).toBeNull();
    expect(canvasWrap().dataset.slidesSnapToGuides).toBe("true");
    expect(slidesEditorFrame().dataset.slidesZoomPercent).toBe("100");

    clickAppMenu("view");
    clickOpenMenuItem("Show grid");
    await settle();
    expect(container.querySelector('[data-slides-grid="true"]')).not.toBeNull();

    clickAppMenu("view");
    clickOpenMenuItem("Show rulers");
    await settle();
    expect(container.querySelector('[data-slides-ruler="horizontal"]')).not.toBeNull();
    expect(container.querySelector('[data-slides-ruler="vertical"]')).not.toBeNull();

    clickAppMenu("view");
    clickOpenMenuItem("Disable snap to guides");
    await settle();
    expect(canvasWrap().dataset.slidesSnapToGuides).toBe("false");

    clickAppMenu("view");
    clickOpenMenuItem("Zoom in");
    await settle();
    expect(slidesEditorFrame().dataset.slidesZoomPercent).toBe("110");
    const stored = JSON.parse(window.localStorage.getItem("helix.slides.view.v1") ?? "{}") as {
      readonly showGrid?: boolean;
      readonly showRulers?: boolean;
      readonly snapToGuides?: boolean;
      readonly zoomPercent?: number;
    };
    expect(stored).toMatchObject({
      showGrid: true,
      showRulers: true,
      snapToGuides: false,
      zoomPercent: 110,
    });

    remountFreshEditor();
    await settle();
    expect(container.querySelector('[data-slides-grid="true"]')).not.toBeNull();
    expect(container.querySelector('[data-slides-ruler="horizontal"]')).not.toBeNull();
    expect(canvasWrap().dataset.slidesSnapToGuides).toBe("false");
    expect(slidesEditorFrame().dataset.slidesZoomPercent).toBe("110");

    clickAppMenu("view");
    clickOpenMenuItem("Fit to window");
    await settle();
    expect(slidesEditorFrame().dataset.slidesZoomPercent).toBe("100");
  });

  it("snaps moved slide shapes to center guides when snap to guides is enabled", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "title",
        title: "Snap story",
        subtitle: "Guides",
        shapes: [
          {
            id: "shape-snap",
            kind: "text",
            x: 20,
            y: 20,
            width: 20,
            height: 20,
            text: "Snap me",
          },
        ],
      }),
    ];

    render();
    await settle();

    setElementRect(shapeLayer(), { left: 0, top: 0, width: 1000, height: 500 });
    await dragElement(shapeByLabel("Text box Snap me"), { x: 200, y: 100 }, { x: 405, y: 195 });
    expect(Number(input("Shape x").value)).toBeCloseTo(40);
    expect(Number(input("Shape y").value)).toBeCloseTo(40);

    clickAppMenu("view");
    clickOpenMenuItem("Disable snap to guides");
    await settle();
    await dragElement(shapeByLabel("Text box Snap me"), { x: 400, y: 200 }, { x: 445, y: 205 });
    expect(Number(input("Shape x").value)).toBeCloseTo(45);
    expect(Number(input("Shape y").value)).toBeCloseTo(41);
  });

  it("copies, pastes, and cuts selected slide shapes from the Edit menu", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "title",
        title: "Clipboard story",
        subtitle: "Shape editing",
        shapes: [
          {
            id: "shape-1",
            kind: "text",
            x: 10,
            y: 12,
            width: 24,
            height: 12,
            text: "Copy me",
            tone: "light",
          },
        ],
      }),
    ];

    render();
    await settle();

    expect(shapeCount("Text box Copy me")).toBe(1);

    clickAppMenu("edit");
    clickOpenMenuItem("Copy");
    await settle();
    const stored = JSON.parse(
      window.localStorage.getItem("helix.slides.shapeClipboard.v1") ?? "{}",
    ) as {
      readonly shape?: { readonly text?: string };
    };
    expect(stored.shape?.text).toBe("Copy me");

    clickAppMenu("edit");
    clickOpenMenuItem("Paste");
    await settle();
    expect(shapeCount("Text box Copy me")).toBe(2);
    expect(input("Shape x").value).toBe("14");
    expect(input("Shape y").value).toBe("16");

    clickAppMenu("edit");
    clickOpenMenuItem("Cut");
    await settle();
    expect(shapeCount("Text box Copy me")).toBe(1);

    clickAppMenu("edit");
    clickOpenMenuItem("Paste");
    await settle();
    expect(shapeCount("Text box Copy me")).toBe(2);

    await clickButton("Save slide");
    await settle();
    const saved = latestToolCallBody("/api/tools/slides.slide.update") as {
      readonly content: { readonly shapes?: readonly SlideShape[] };
    };
    expect(saved.content.shapes).toEqual([
      expect.objectContaining({ id: "shape-1", text: "Copy me", x: 10, y: 12 }),
      expect.objectContaining({ id: "shape-2", text: "Copy me", x: 18, y: 20 }),
    ]);
  });

  it("undoes and redoes unsaved slide draft edits from the top ribbon", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "title",
        title: "Undo story",
        subtitle: "Draft controls",
        shapes: [
          {
            id: "shape-undo",
            kind: "text",
            x: 16,
            y: 20,
            width: 42,
            height: 16,
            text: "Undo me",
          },
        ],
      }),
    ];

    render();
    await settle();

    const undoButton = container.querySelector<HTMLButtonElement>('button[aria-label="Undo"]');
    const redoButton = container.querySelector<HTMLButtonElement>('button[aria-label="Redo"]');
    expect(undoButton?.disabled).toBe(true);
    expect(redoButton?.disabled).toBe(true);

    await clickButtonByLabel("Bold");
    const formattedText = shapeByLabel("Text box Undo me").querySelector<HTMLElement>("span");
    expect(formattedText?.style.fontWeight).toBe("700");
    expect(undoButton?.disabled).toBe(false);
    expect(redoButton?.disabled).toBe(true);

    await clickButtonByLabel("Undo");
    expect(formattedText?.style.fontWeight).toBe("400");
    expect(undoButton?.disabled).toBe(true);
    expect(redoButton?.disabled).toBe(false);

    await clickButtonByLabel("Redo");
    expect(formattedText?.style.fontWeight).toBe("700");
    expect(undoButton?.disabled).toBe(false);
    expect(redoButton?.disabled).toBe(true);

    await clickButton("Save slide");
    await settle();
    expect(latestUpdatedShape(firstSlideId, "shape-undo")).toMatchObject({ bold: true });
  });

  it("renders a native deck, saves typed slide content, and creates slides", async () => {
    render();
    await settle();

    expect(container.textContent).toContain("Board narrative");
    expect(container.textContent).toContain("Launch story");
    expect(input("Slide title").value).toBe("Launch story");
    expect(textarea("Slide bullets").value).toBe("Positioning\nDemo");
    expect(select("Deck theme").value).toBe("classic");

    await changeSelect("Deck theme", "meadow");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.deck.update",
      body: {
        deckId,
        metadata: { audience: "board", theme: "meadow" },
      },
    });
    expect(select("Deck theme").value).toBe("meadow");
    expect(
      container.querySelector<HTMLElement>('[aria-label="Slide preview"]')?.style.background,
    ).toContain("linear-gradient");

    const callsBeforePresent = toolCalls.length;
    await clickButton("Present");
    expect(dialog("Presentation mode").textContent).toContain("Slide 1 of 2");
    expect(dialog("Presentation mode").textContent).toContain("Opening notes");
    expect(
      dialog("Presentation mode").querySelector<HTMLElement>('[aria-label="Slide preview"]')?.style
        .background,
    ).toContain("linear-gradient");
    expect(nextSlidePreview().textContent).toContain("Appendix");
    await clickElement(presentationStage());
    expect(dialog("Presentation mode").textContent).toContain("Appendix");
    expect(dialog("Presentation mode").textContent).toContain("Slide 2 of 2");
    expect(dialog("Presentation mode").textContent).toContain("No speaker notes");
    expect(nextSlidePreview().textContent).toContain("End of deck");
    await pressDocumentKey("ArrowLeft");
    expect(dialog("Presentation mode").textContent).toContain("Launch story");
    await pressDocumentKey("Escape");
    expect(container.querySelector('[role="dialog"][aria-label="Presentation mode"]')).toBeNull();
    expect(toolCalls).toHaveLength(callsBeforePresent);

    await clickButton("Appendix");
    expect(select("Title background").value).toBe("accent");
    await changeSelect("Title background", "neutral");
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: secondSlideId,
        content: {
          layout: "title",
          title: "Appendix",
          subtitle: "Reference",
          bg: "neutral",
        },
        speakerNotes: "",
      },
    });
    expect(
      container.querySelector<HTMLElement>('[aria-label="Slide preview"]')?.style.background,
    ).toContain("linear-gradient");

    await clickButton("Present");
    expect(dialog("Presentation mode").textContent).toContain("Slide 2 of 2");
    expect(dialog("Presentation mode").textContent).toContain("Appendix");
    await clickButton("Exit");
    await clickButton("Launch story");

    await changeInput("Slide title", "Updated story");
    await changeTextarea("Slide bullets", "Market\nRevenue");
    await changeTextarea("Speaker notes", "Talk track");
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Updated story",
          items: ["Market", "Revenue"],
        },
        speakerNotes: "Talk track",
      },
    });

    await changeSelect("Slide layout", "stats");
    await changeInput("Slide title", "Executive numbers");
    await changeTextarea("Slide stats", "42% | Expansion | Upmarket\n8 | Regions | Active");
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "stats",
          title: "Executive numbers",
          stats: [
            { value: "42%", label: "Expansion", note: "Upmarket" },
            { value: "8", label: "Regions", note: "Active" },
          ],
        },
        speakerNotes: "Talk track",
      },
    });

    await clickButton("Text");
    await changeInput("Shape text", "Q3 emphasis");
    await changeInput("Shape x", "20");
    await changeInput("Shape y", "24");
    await changeInput("Shape width", "36");
    await changeInput("Shape height", "16");
    await changeSelect("Shape tone", "dark");
    await changeSelect("Shape animation", "fly");
    await changeSelect("Shape motion path", "right");
    await changeInput("Animation order", "2");
    await changeInput("Animation duration", "950");
    await changeSelect("Animation easing", "easeOut");
    await changeSelect("Shape exit animation", "fade");
    await changeInput("Exit animation order", "1");
    await changeInput("Exit animation duration", "480");
    await changeSelect("Exit animation easing", "easeIn");
    const timeline = table("Shape animation timeline");
    expect(container.textContent).toContain("Animation timeline");
    expect(timeline.textContent).toContain("Entrance");
    expect(timeline.textContent).toContain("Fly right");
    expect(timeline.textContent).toContain("Order 2");
    expect(timeline.textContent).toContain("950ms / Ease out");
    expect(timeline.textContent).toContain("Exit");
    expect(timeline.textContent).toContain("Fade");
    expect(timeline.textContent).toContain("Order 1");
    expect(timeline.textContent).toContain("480ms / Ease in");
    await clickButtonByLabel("Select animation entrance Q3 emphasis");
    expect(select("Slide shape").value).toBe("shape-1");
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "stats",
          title: "Executive numbers",
          stats: [
            { value: "42%", label: "Expansion", note: "Upmarket" },
            { value: "8", label: "Regions", note: "Active" },
          ],
          shapes: [
            {
              id: "shape-1",
              kind: "text",
              x: 20,
              y: 24,
              width: 36,
              height: 16,
              text: "Q3 emphasis",
              tone: "dark",
              animation: {
                type: "fly",
                motionPath: "right",
                order: 2,
                durationMs: 950,
                easing: "easeOut",
              },
              exitAnimation: {
                type: "fade",
                order: 1,
                durationMs: 480,
                easing: "easeIn",
              },
            },
          ],
        },
        speakerNotes: "Talk track",
      },
    });
    expect(container.textContent).toContain("Q3 emphasis");

    await clickButton("Present");
    expect(dialog("Presentation mode").textContent).toContain("Build 0 of 2");
    expect(
      dialog("Presentation mode").querySelector<HTMLElement>('[aria-label="Text box Q3 emphasis"]'),
    ).toBeNull();
    await clickElement(presentationStage());
    expect(dialog("Presentation mode").textContent).toContain("Build 1 of 2");
    const animatedShape = dialog("Presentation mode").querySelector<HTMLElement>(
      '[aria-label="Text box Q3 emphasis"]',
    );
    expect(animatedShape?.style.animationName).toBe("helix-slide-shape-fly-right");
    expect(animatedShape?.style.animationDuration).toBe("950ms");
    expect(animatedShape?.style.animationTimingFunction).toBe("ease-out");
    expect(animatedShape?.style.animationDelay).toBe("280ms");
    await clickElement(presentationStage());
    expect(dialog("Presentation mode").textContent).toContain("Build 2 of 2");
    const exitingShape = dialog("Presentation mode").querySelector<HTMLElement>(
      '[aria-label="Text box Q3 emphasis"]',
    );
    expect(exitingShape?.style.animationName).toBe("helix-slide-shape-exit-fade");
    expect(exitingShape?.style.animationDuration).toBe("480ms");
    expect(exitingShape?.style.animationTimingFunction).toBe("cubic-bezier(.42,0,1,1)");
    expect(exitingShape?.style.animationDelay).toBe("0ms");
    await pressDocumentKey("Escape");

    setElementRect(shapeLayer(), { left: 0, top: 0, width: 800, height: 450 });
    await dragElement(shapeByLabel("Text box Q3 emphasis"), { x: 160, y: 108 }, { x: 240, y: 153 });
    expect(input("Shape x").value).toBe("30");
    expect(input("Shape y").value).toBe("34");
    expect(input("Shape width").value).toBe("36");
    expect(input("Shape height").value).toBe("16");

    await dragElement(shapeByLabel("Resize Q3 emphasis"), { x: 448, y: 225 }, { x: 488, y: 270 });
    expect(input("Shape x").value).toBe("30");
    expect(input("Shape y").value).toBe("34");
    expect(input("Shape width").value).toBe("41");
    expect(input("Shape height").value).toBe("26");
    await clickButtonByLabel("Bold");
    await clickButtonByLabel("Italic");
    await clickButtonByLabel("Underline");
    await clickButtonByLabel("Align right");
    const formattedText = shapeByLabel("Text box Q3 emphasis").querySelector<HTMLElement>("span");
    expect(formattedText?.style.fontWeight).toBe("700");
    expect(formattedText?.style.fontStyle).toBe("italic");
    expect(formattedText?.style.textDecoration).toContain("underline");
    expect(formattedText?.style.textAlign).toBe("right");
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "stats",
          title: "Executive numbers",
          stats: [
            { value: "42%", label: "Expansion", note: "Upmarket" },
            { value: "8", label: "Regions", note: "Active" },
          ],
          shapes: [
            {
              id: "shape-1",
              kind: "text",
              x: 30,
              y: 34,
              width: 41,
              height: 26,
              text: "Q3 emphasis",
              tone: "dark",
              bold: true,
              italic: true,
              underline: true,
              textAlign: "right",
              animation: {
                type: "fly",
                motionPath: "right",
                order: 2,
                durationMs: 950,
                easing: "easeOut",
              },
              exitAnimation: {
                type: "fade",
                order: 1,
                durationMs: 480,
                easing: "easeIn",
              },
            },
          ],
        },
        speakerNotes: "Talk track",
      },
    });

    await clickButton("Rectangle");
    await changeInput("Shape text", "Backdrop");
    await changeInput("Shape x", "18");
    await changeInput("Shape y", "22");
    await changeInput("Shape width", "40");
    await changeInput("Shape height", "22");
    await changeSelect("Shape tone", "accent");
    await clickButtonByLabel("Send shape backward");
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "stats",
          title: "Executive numbers",
          stats: [
            { value: "42%", label: "Expansion", note: "Upmarket" },
            { value: "8", label: "Regions", note: "Active" },
          ],
          shapes: [
            {
              id: "shape-2",
              kind: "rectangle",
              x: 18,
              y: 22,
              width: 40,
              height: 22,
              text: "Backdrop",
              tone: "accent",
            },
            {
              id: "shape-1",
              kind: "text",
              x: 30,
              y: 34,
              width: 41,
              height: 26,
              text: "Q3 emphasis",
              tone: "dark",
              bold: true,
              italic: true,
              underline: true,
              textAlign: "right",
              animation: {
                type: "fly",
                motionPath: "right",
                order: 2,
                durationMs: 950,
                easing: "easeOut",
              },
              exitAnimation: {
                type: "fade",
                order: 1,
                durationMs: 480,
                easing: "easeIn",
              },
            },
          ],
        },
        speakerNotes: "Talk track",
      },
    });

    await clickButton("Connector");
    expect(select("Shape kind").value).toBe("connector");
    expect(shapeByLabel("Connector")).toBeDefined();
    await changeInput("Shape x", "44");
    await changeInput("Shape y", "30");
    await changeInput("Shape width", "18");
    await changeInput("Shape height", "28");
    await changeSelect("Shape tone", "light");
    expect(select("Connector direction").value).toBe("up");
    expect(select("Connector arrow").value).toBe("end");
    await changeSelect("Connector direction", "down");
    await changeSelect("Connector arrow", "start");
    expect(select("Connector arrow").value).toBe("start");
    expect(connectorSvgLine().getAttribute("marker-start")).toMatch(/^url\(#connector-arrow-/u);
    expect(connectorSvgLine().getAttribute("marker-end")).toBeNull();
    await changeSelect("Connector arrow", "both");
    expect(connectorSvgLine().getAttribute("marker-start")).toMatch(/^url\(#connector-arrow-/u);
    expect(connectorSvgLine().getAttribute("marker-end")).toMatch(/^url\(#connector-arrow-/u);
    await changeSelect("Connector arrow", "none");
    expect(select("Connector direction").value).toBe("down");
    expect(select("Connector arrow").value).toBe("none");
    const connectorLine = connectorSvgLine();
    expect(connectorLine.getAttribute("y1")).toBe("8");
    expect(connectorLine.getAttribute("y2")).toBe("92");
    expect(connectorLine.getAttribute("marker-end")).toBeNull();
    expect(shapeByLabel("Connector").querySelector("marker")).toBeNull();
    await dragElement(
      shapeByLabel("Move Connector 3 right endpoint"),
      { x: 496, y: 261 },
      { x: 576, y: 81 },
    );
    expect(input("Shape x").value).toBe("44");
    expect(input("Shape y").value).toBe("18");
    expect(input("Shape width").value).toBe("28");
    expect(input("Shape height").value).toBe("12");
    expect(select("Connector direction").value).toBe("up");
    expect(connectorSvgLine().getAttribute("y1")).toBe("92");
    expect(connectorSvgLine().getAttribute("y2")).toBe("8");
    await dragElement(
      shapeByLabel("Move Connector 3 left endpoint"),
      { x: 352, y: 135 },
      { x: 640, y: 360 },
    );
    expect(input("Shape x").value).toBe("72");
    expect(input("Shape y").value).toBe("18");
    expect(input("Shape width").value).toBe("8");
    expect(input("Shape height").value).toBe("62");
    expect(select("Connector direction").value).toBe("down");
    expect(connectorSvgLine().getAttribute("y1")).toBe("8");
    expect(connectorSvgLine().getAttribute("y2")).toBe("92");
    await changeSelect("Connector arrow", "both");
    expect(connectorSvgLine().getAttribute("marker-start")).toMatch(/^url\(#connector-arrow-/u);
    expect(connectorSvgLine().getAttribute("marker-end")).toMatch(/^url\(#connector-arrow-/u);
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "stats",
          title: "Executive numbers",
          stats: [
            { value: "42%", label: "Expansion", note: "Upmarket" },
            { value: "8", label: "Regions", note: "Active" },
          ],
          shapes: [
            {
              id: "shape-2",
              kind: "rectangle",
              x: 18,
              y: 22,
              width: 40,
              height: 22,
              text: "Backdrop",
              tone: "accent",
            },
            {
              id: "shape-1",
              kind: "text",
              x: 30,
              y: 34,
              width: 41,
              height: 26,
              text: "Q3 emphasis",
              tone: "dark",
              bold: true,
              italic: true,
              underline: true,
              textAlign: "right",
              animation: {
                type: "fly",
                motionPath: "right",
                order: 2,
                durationMs: 950,
                easing: "easeOut",
              },
              exitAnimation: {
                type: "fade",
                order: 1,
                durationMs: 480,
                easing: "easeIn",
              },
            },
            {
              id: "shape-3",
              kind: "connector",
              x: 72,
              y: 18,
              width: 8,
              height: 62,
              text: "",
              tone: "light",
              connectorDirection: "down",
              connectorArrow: "both",
            },
          ],
        },
        speakerNotes: "Talk track",
      },
    });

    await clickButton("Image");
    expect(select("Shape kind").value).toBe("image");
    await changeInput("Shape image URL", "https://example.test/product.png");
    await changeInput("Shape image alt text", "Product mockup");
    expect(select("Shape image fit").value).toBe("cover");
    await changeSelect("Shape image fit", "contain");
    expect(select("Shape image mask").value).toBe("rounded");
    await changeSelect("Shape image mask", "circle");
    await changeInput("Shape x", "48");
    await changeInput("Shape y", "14");
    await changeInput("Shape width", "30");
    await changeInput("Shape height", "26");
    const imageShape = shapeByLabel("Image Product mockup");
    expect(imageShape.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.test/product.png",
    );
    expect(imageShape.querySelector("img")?.getAttribute("alt")).toBe("Product mockup");
    expect(imageShape.querySelector("img")?.style.objectFit).toBe("contain");
    expect(imageShape.querySelector("img")?.style.borderRadius).toBe("9999px");

    await changeInput("Shape image alt text", "");
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    await uploadFile(
      "Upload shape image",
      new File(["png"], "Roadmap_photo.png", { type: "image/png" }),
    );
    await settle();
    digestSpy.mockRestore();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/drive.upload",
      body: {
        name: "Roadmap_photo.png",
        folderId: null,
        mimeType: "image/png",
        byteSize: 3,
        sha256: "0".repeat(64),
        metadata: { source: "web-shell" },
      },
    });
    expect(toolCalls).toContainEqual({
      url: "/api/tools/drive.finalize",
      body: {
        objectId: "55555555-5555-4555-8555-555555555555",
        byteSize: 3,
        sha256: "0".repeat(64),
        mimeType: "image/png",
        storageKey: "drive/555/Roadmap_photo.png",
        contentBase64: "cG5n",
        metadata: { source: "web-shell" },
      },
    });
    const uploadedImageShape = shapeByLabel("Image Roadmap photo");
    expect(uploadedImageShape.querySelector("img")?.getAttribute("src")).toBe(
      "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
    );
    expect(uploadedImageShape.querySelector("img")?.getAttribute("alt")).toBe("Roadmap photo");

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "stats",
          title: "Executive numbers",
          stats: [
            { value: "42%", label: "Expansion", note: "Upmarket" },
            { value: "8", label: "Regions", note: "Active" },
          ],
          shapes: [
            {
              id: "shape-2",
              kind: "rectangle",
              x: 18,
              y: 22,
              width: 40,
              height: 22,
              text: "Backdrop",
              tone: "accent",
            },
            {
              id: "shape-1",
              kind: "text",
              x: 30,
              y: 34,
              width: 41,
              height: 26,
              text: "Q3 emphasis",
              tone: "dark",
              bold: true,
              italic: true,
              underline: true,
              textAlign: "right",
              animation: {
                type: "fly",
                motionPath: "right",
                order: 2,
                durationMs: 950,
                easing: "easeOut",
              },
              exitAnimation: {
                type: "fade",
                order: 1,
                durationMs: 480,
                easing: "easeIn",
              },
            },
            {
              id: "shape-3",
              kind: "connector",
              x: 72,
              y: 18,
              width: 8,
              height: 62,
              text: "",
              tone: "light",
              connectorDirection: "down",
              connectorArrow: "both",
            },
            {
              id: "shape-4",
              kind: "image",
              x: 48,
              y: 14,
              width: 30,
              height: 26,
              text: "",
              tone: "accent",
              imageUrl: "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
              imageAlt: "Roadmap photo",
              imageFit: "contain",
              imageMask: "circle",
            },
          ],
        },
        speakerNotes: "Talk track",
      },
    });

    await clickButtonByLabel("Move Executive numbers down");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.reorder",
      body: {
        deckId,
        slideIds: [secondSlideId, firstSlideId],
      },
    });

    await clickButtonByLabel("Delete Appendix");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.delete",
      body: { slideId: secondSlideId },
    });
    expect(container.textContent).not.toContain("Appendix");

    await clickButton("Add slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.create",
      body: {
        deckId,
        content: {
          layout: "bullets",
          title: "Key points",
          items: ["First point"],
        },
        speakerNotes: "",
      },
    });
    expect(input("Slide title").value).toBe("Key points");
  });

  it("recovers unsaved slide drafts after reload and clears recovery after save", async () => {
    render();
    await settle();

    await changeInput("Slide title", "Recovered unsaved story");
    await changeTextarea("Slide bullets", "Positioning\nDemo\nPricing");
    await settle();

    const recoveryKey = `helix.slides.unsavedDraft.v1.${firstSlideId}`;
    expect(window.localStorage.getItem(recoveryKey)).not.toBeNull();
    expect(toolCalls.some((call) => call.url === "/api/tools/slides.slide.update")).toBe(false);

    remountFreshEditor();
    await settle();

    expect(input("Slide title").value).toBe("Recovered unsaved story");
    expect(textarea("Slide bullets").value).toBe("Positioning\nDemo\nPricing");

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Recovered unsaved story",
          items: ["Positioning", "Demo", "Pricing"],
        },
        speakerNotes: "Opening notes",
      },
    });
    expect(window.localStorage.getItem(recoveryKey)).toBeNull();
  });

  it("drops image files onto the slide canvas as Drive-backed image shapes", async () => {
    render();
    await settle();

    const preview = slidePreview();
    setElementRect(preview, { left: 100, top: 50, width: 800, height: 450 });
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    await dropFileOnSlide(preview, new File(["png"], "Roadmap_photo.png", { type: "image/png" }), {
      x: 500,
      y: 275,
    });
    await settle();
    digestSpy.mockRestore();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/drive.upload",
      body: {
        name: "Roadmap_photo.png",
        folderId: null,
        mimeType: "image/png",
        byteSize: 3,
        sha256: "0".repeat(64),
        metadata: { source: "web-shell" },
      },
    });
    expect(toolCalls).toContainEqual({
      url: "/api/tools/drive.finalize",
      body: {
        objectId: "55555555-5555-4555-8555-555555555555",
        byteSize: 3,
        sha256: "0".repeat(64),
        mimeType: "image/png",
        storageKey: "drive/555/Roadmap_photo.png",
        contentBase64: "cG5n",
        metadata: { source: "web-shell" },
      },
    });

    const droppedShape = shapeByLabel("Image Roadmap photo");
    expect(droppedShape.querySelector("img")?.getAttribute("src")).toBe(
      "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
    );
    expect(droppedShape.querySelector("img")?.getAttribute("alt")).toBe("Roadmap photo");
    expect(input("Shape x").value).toBe("34");
    expect(input("Shape y").value).toBe("38");

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "shape-1",
              kind: "image",
              x: 34,
              y: 38,
              width: 32,
              height: 24,
              text: "",
              tone: "accent",
              imageUrl: "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
              imageAlt: "Roadmap photo",
            },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });
  });

  it("drops text snippets onto the slide canvas as editable text shapes", async () => {
    render();
    await settle();

    const preview = slidePreview();
    setElementRect(preview, { left: 100, top: 50, width: 800, height: 450 });
    await dropTextOnSlide(preview, "Customer quote: faster onboarding", { x: 420, y: 230 });
    await settle();

    shapeByLabel("Text box Customer quote: faster onboarding");
    expect(input("Shape text").value).toBe("Customer quote: faster onboarding");
    expect(input("Shape x").value).toBe("23");
    expect(input("Shape y").value).toBe("33");

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "shape-1",
              kind: "text",
              x: 23,
              y: 33,
              width: 34,
              height: 14,
              text: "Customer quote: faster onboarding",
              tone: "light",
            },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });
  });

  it("drops safe URLs as linked text shapes that persist and present as anchors", async () => {
    render();
    await settle();

    const preview = slidePreview();
    const linkUrl = "https://example.com/launch-plan";
    setElementRect(preview, { left: 100, top: 50, width: 800, height: 450 });
    await dropTextOnSlide(preview, linkUrl, { x: 420, y: 230 }, "text/uri-list");
    await settle();

    shapeByLabel(`Text box ${linkUrl}`);
    expect(input("Shape text").value).toBe(linkUrl);
    expect(input("Shape link").value).toBe(linkUrl);

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "shape-1",
              kind: "text",
              x: 23,
              y: 33,
              width: 34,
              height: 14,
              text: linkUrl,
              linkUrl,
              tone: "light",
            },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });

    await clickButton("Present");
    const presenterLink = dialog("Presentation mode").querySelector<HTMLAnchorElement>(
      `a[href="${linkUrl}"]`,
    );
    expect(presenterLink?.textContent).toBe(linkUrl);
    expect(presenterLink?.target).toBe("_blank");
    expect(presenterLink?.rel).toBe("noopener noreferrer");
  });

  it("keeps unsafe dropped URLs as unlinked slide text", async () => {
    render();
    await settle();

    const preview = slidePreview();
    setElementRect(preview, { left: 100, top: 50, width: 800, height: 450 });
    await dropTextOnSlide(preview, "javascript:alert(1)", { x: 420, y: 230 });
    await settle();

    shapeByLabel("Text box javascript:alert(1)");
    expect(input("Shape text").value).toBe("javascript:alert(1)");
    expect(input("Shape link").value).toBe("");

    await clickButton("Save slide");
    await settle();

    expect(latestUpdatedShape(firstSlideId, "shape-1")).not.toHaveProperty("linkUrl");
  });

  it("nudges, resizes, and deletes selected slide shapes from the keyboard", async () => {
    render();
    await settle();

    await clickButton("Text");
    await changeInput("Shape text", "Keyboard object");
    await changeInput("Shape x", "20");
    await changeInput("Shape y", "24");
    await changeInput("Shape width", "36");
    await changeInput("Shape height", "16");
    const shape = shapeByLabel("Text box Keyboard object");
    shape.focus();

    await keyDownElement(shape, "ArrowRight");
    await keyDownElement(shape, "ArrowDown");
    await keyDownElement(shape, "ArrowRight", { shiftKey: true });
    await keyDownElement(shape, "ArrowDown", { shiftKey: true });

    expect(input("Shape x").value).toBe("21");
    expect(input("Shape y").value).toBe("25");
    expect(input("Shape width").value).toBe("37");
    expect(input("Shape height").value).toBe("17");

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "shape-1",
              kind: "text",
              x: 21,
              y: 25,
              width: 37,
              height: 17,
              text: "Keyboard object",
              tone: "light",
            },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });

    await keyDownElement(shapeByLabel("Text box Keyboard object"), "Delete");
    expect(container.querySelector('[aria-label="Text box Keyboard object"]')).toBeNull();
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
        },
        speakerNotes: "Opening notes",
      },
    });
  });

  it("supports Drive-backed slide and shape review comments", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "bullets",
        title: "Launch story",
        items: ["Positioning", "Demo"],
        shapes: [
          {
            id: "shape-1",
            kind: "text",
            x: 12,
            y: 18,
            width: 32,
            height: 12,
            text: "Launch metric",
            tone: "accent",
          },
        ],
      }),
      slide(secondSlideId, 1, {
        layout: "title",
        title: "Appendix",
        subtitle: "Reference",
      }),
    ];
    comments = [
      comment("comment-1", {
        anchor: {
          kind: "slides-slide",
          target: "slide",
          deckId,
          slideId: firstSlideId,
          slideIndex: 0,
          slideTitle: "Launch story",
        },
        body: "Tighten the opening.",
      }),
    ];

    render();
    await settle();

    expect(container.textContent).toContain("Review comments");
    expect(container.textContent).toContain("Tighten the opening.");
    expect(
      container.querySelector('[aria-label="1 open comments for Launch story"]'),
    ).not.toBeNull();

    await clickButtonByLabel("Copy comment link: Tighten the opening.");
    const copiedCommentLink = clipboardWriteText.mock.calls.at(-1)?.[0] ?? "";
    expect(copiedCommentLink).toContain("/slides");
    expect(copiedCommentLink).toContain(`deck=${deckId}`);
    expect(copiedCommentLink).toContain("comment=comment-1");

    await clickButton("Appendix");
    expect(input("Slide title").value).toBe("Appendix");
    await clickButtonByLabel("Open comment anchor comment-1");
    expect(input("Slide title").value).toBe("Launch story");
    expect(container.querySelector('[aria-label="Slides comment mentions"]')).toBeNull();

    await changeTextarea("Slides comment", "Clarify the launch metric with @ma");
    expect(
      container.querySelector('[aria-label="Slides comment mentions"]')?.textContent,
    ).toContain("Maya Chen");
    await clickButtonByLabel("Mention Maya Chen");
    expect(textarea("Slides comment").value).toBe("Clarify the launch metric with @maya ");
    await clickButton("Comment on selected shape");
    await settle();

    expect(latestToolCallBody("/api/tools/drive.comment.create")).toMatchObject({
      objectId: deckId,
      body: "Clarify the launch metric with @maya",
      anchor: {
        kind: "slides-shape",
        target: "shape",
        deckId,
        slideId: firstSlideId,
        shapeId: "shape-1",
        shapeLabel: "Launch metric",
      },
      metadata: {
        source: "web.native-presentation-editor.comments",
        anchorKind: "shape",
        mentionsText: ["maya"],
      },
    });
    expect(container.textContent).toContain("Clarify the launch metric with @maya");

    await changeTextarea("Reply to comment-1", "Agreed @ow");
    await clickButtonByLabel("Mention Product Owner");
    expect(textarea("Reply to comment-1").value).toBe("Agreed @owner ");
    await clickButton("Reply");
    await settle();
    expect(latestToolCallBody("/api/tools/drive.comment.create")).toMatchObject({
      parentCommentId: "comment-1",
      body: "Agreed @owner",
      metadata: {
        source: "web.native-presentation-editor.comments.reply",
        parentCommentId: "comment-1",
        mentionsText: ["owner"],
      },
    });

    await clickButtonByLabel("Edit comment comment-2");
    await changeTextarea("Edit comment comment-2", "Clarify the metric callout.");
    await clickButtonByLabel("Save comment comment-2");
    await settle();
    expect(latestToolCallBody("/api/tools/drive.comment.update")).toEqual({
      commentId: "comment-2",
      body: "Clarify the metric callout.",
    });
    expect(container.textContent).toContain("Clarify the metric callout.");

    await clickButtonByLabel("Resolve comment comment-1");
    await settle();
    expect(latestToolCallBody("/api/tools/drive.comment.resolve")).toEqual({
      commentId: "comment-1",
    });
    expect(container.textContent).not.toContain("Tighten the opening.");

    await changeSelect("Slides comment status", "resolved");
    await settle();
    expect(container.textContent).toContain("Tighten the opening.");
    await clickButtonByLabel("Reopen comment comment-1");
    await settle();
    expect(latestToolCallBody("/api/tools/drive.comment.reopen")).toEqual({
      commentId: "comment-1",
    });

    await changeSelect("Slides comment status", "open");
    await settle();
    await clickButtonByLabel("Delete comment comment-2");
    await settle();
    expect(latestToolCallBody("/api/tools/drive.comment.delete")).toEqual({
      commentId: "comment-2",
    });
  });

  it("opens a route-linked Slides comment without emitting a redundant route update", async () => {
    comments = [
      comment("comment-1", {
        anchor: {
          kind: "slides-slide",
          target: "slide",
          deckId,
          slideId: secondSlideId,
          slideIndex: 1,
          slideTitle: "Appendix",
        },
        body: "Review appendix.",
      }),
    ];
    const onRouteStateChange = vi.fn();

    render({
      routeState: { commentId: "comment-1" },
      onRouteStateChange,
    });
    await settle();

    expect(select("Slides comment status").value).toBe("all");
    expect(input("Slide title").value).toBe("Appendix");
    expect(container.querySelector('li[aria-current="true"]')?.textContent).toContain(
      "Review appendix.",
    );
    expect(onRouteStateChange).not.toHaveBeenCalled();
  });

  it("shows a clearable notice for unavailable route-linked Slides comments", async () => {
    comments = [];
    const onRouteStateChange = vi.fn();

    render({
      routeState: { commentId: "missing-comment" },
      onRouteStateChange,
    });
    await settle();

    expect(container.textContent).toContain(
      "Linked Slides comment is unavailable or no longer visible.",
    );
    await clickButton("Clear link");
    await settle();

    expect(onRouteStateChange).toHaveBeenCalledWith({ commentId: null });
  });

  it("shows a cross-slide animation timeline and jumps to animated slides", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "title",
        title: "Opening build",
        shapes: [
          {
            id: "shape-open",
            kind: "text",
            x: 10,
            y: 18,
            width: 38,
            height: 12,
            text: "Opening reveal",
            tone: "accent",
            animation: { type: "fly", motionPath: "up", order: 1, durationMs: 700 },
          },
        ],
      }),
      slide(secondSlideId, 1, {
        layout: "title",
        title: "Closing build",
        shapes: [
          {
            id: "shape-close",
            kind: "text",
            x: 12,
            y: 26,
            width: 40,
            height: 12,
            text: "Closing exit",
            tone: "dark",
            exitAnimation: { type: "zoom", order: 2, durationMs: 900, easing: "easeInOut" },
          },
        ],
      }),
    ];

    render();
    await settle();

    const timeline = table("Deck animation timeline");
    expect(timeline.textContent).toContain("Slide 1");
    expect(timeline.textContent).toContain("Opening build");
    expect(timeline.textContent).toContain("Opening reveal");
    expect(timeline.textContent).toContain("Entrance · Fly up");
    expect(timeline.textContent).toContain("700ms / Standard");
    expect(timeline.textContent).toContain("Slide 2");
    expect(timeline.textContent).toContain("Closing build");
    expect(timeline.textContent).toContain("Closing exit");
    expect(timeline.textContent).toContain("Exit · Zoom");
    expect(timeline.textContent).toContain("900ms / Ease in/out");

    expect(input("Slide title").value).toBe("Opening build");
    await clickButtonByLabel("Open slide 2 animation exit Closing exit");
    expect(input("Slide title").value).toBe("Closing build");
  });

  it("applies deck-wide media playback actions to persisted video assets", async () => {
    slides = [
      slide(
        firstSlideId,
        0,
        {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "video-1",
              kind: "media",
              x: 10,
              y: 16,
              width: 34,
              height: 20,
              text: "",
              tone: "accent",
              mediaUrl: "https://example.test/launch.mp4",
              mediaType: "video",
              mediaTitle: "Launch clip",
              mediaStartSeconds: 3,
              mediaEndSeconds: 18,
              mediaAutoplay: true,
              mediaLoop: true,
            },
            {
              id: "audio-1",
              kind: "media",
              x: 48,
              y: 16,
              width: 28,
              height: 12,
              text: "",
              tone: "accent",
              mediaUrl: "https://example.test/team.mp3",
              mediaType: "audio",
              mediaTitle: "Team soundtrack",
            },
          ],
        },
        {
          speakerNotes: "Opening notes",
        },
      ),
      slide(secondSlideId, 1, {
        layout: "title",
        title: "Appendix",
        subtitle: "Reference",
        shapes: [
          {
            id: "video-2",
            kind: "media",
            x: 12,
            y: 18,
            width: 36,
            height: 22,
            text: "",
            tone: "accent",
            mediaUrl: "https://example.test/closing.mp4",
            mediaType: "video",
            mediaTitle: "Closing clip",
            mediaStartSeconds: 4,
            mediaEndSeconds: 22,
            mediaAutoplay: true,
            mediaLoop: true,
          },
        ],
      }),
    ];

    render();
    await settle();

    const deckMedia = table("Deck media assets");
    expect(deckMedia.textContent).toContain("Launch clip");
    expect(deckMedia.textContent).toContain("Team soundtrack");
    expect(deckMedia.textContent).toContain("Closing clip");

    await clickButton("Mute all video");
    await settle();
    expect(slideUpdateBodies()).toHaveLength(2);
    expect(latestUpdatedShape(firstSlideId, "video-1")).toMatchObject({ mediaMuted: true });
    expect(latestUpdatedShape(secondSlideId, "video-2")).toMatchObject({ mediaMuted: true });
    expect(latestUpdatedShape(firstSlideId, "audio-1")).not.toHaveProperty("mediaMuted");

    await changeCheckbox("Deck media Launch clip muted", false);
    await settle();
    expect(slideUpdateBodies()).toHaveLength(3);
    expect(latestUpdatedShape(firstSlideId, "video-1")).not.toHaveProperty("mediaMuted");

    await clickButton("Disable autoplay");
    await settle();
    expect(slideUpdateBodies()).toHaveLength(5);
    expect(latestUpdatedShape(firstSlideId, "video-1")).not.toHaveProperty("mediaAutoplay");
    expect(latestUpdatedShape(secondSlideId, "video-2")).not.toHaveProperty("mediaAutoplay");

    await clickButton("Disable loop");
    await settle();
    expect(slideUpdateBodies()).toHaveLength(7);
    expect(latestUpdatedShape(firstSlideId, "video-1")).not.toHaveProperty("mediaLoop");
    expect(latestUpdatedShape(secondSlideId, "video-2")).not.toHaveProperty("mediaLoop");

    await clickButton("Reset trims");
    await settle();
    expect(slideUpdateBodies()).toHaveLength(9);
    expect(latestUpdatedShape(firstSlideId, "video-1")).not.toHaveProperty("mediaStartSeconds");
    expect(latestUpdatedShape(firstSlideId, "video-1")).not.toHaveProperty("mediaEndSeconds");
    expect(latestUpdatedShape(secondSlideId, "video-2")).not.toHaveProperty("mediaStartSeconds");
    expect(latestUpdatedShape(secondSlideId, "video-2")).not.toHaveProperty("mediaEndSeconds");
  });

  it("audits and filters deck-wide media readiness", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "bullets",
        title: "Launch story",
        items: ["Positioning", "Demo"],
        shapes: [
          {
            id: "video-ready",
            kind: "media",
            x: 10,
            y: 16,
            width: 34,
            height: 20,
            text: "",
            tone: "accent",
            mediaUrl: "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
            mediaPosterUrl: "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
            mediaType: "video",
            mediaTitle: "Ready clip",
          },
          {
            id: "video-external",
            kind: "media",
            x: 48,
            y: 16,
            width: 28,
            height: 18,
            text: "",
            tone: "accent",
            mediaUrl: "https://example.test/external.mp4",
            mediaType: "video",
            mediaTitle: "External clip",
            mediaAutoplay: true,
          },
          {
            id: "video-missing",
            kind: "media",
            x: 12,
            y: 44,
            width: 30,
            height: 18,
            text: "",
            tone: "accent",
            mediaType: "video",
            mediaTitle: "Missing clip",
          },
        ],
      }),
      slide(secondSlideId, 1, {
        layout: "title",
        title: "Appendix",
        subtitle: "Reference",
        shapes: [
          {
            id: "audio-external",
            kind: "media",
            x: 12,
            y: 18,
            width: 36,
            height: 12,
            text: "",
            tone: "accent",
            mediaUrl: "https://example.test/external.mp4",
            mediaType: "audio",
            mediaTitle: "Team soundtrack",
          },
        ],
      }),
    ];

    render();
    await settle();

    expect(container.querySelector('[aria-label="Deck media readiness"]')?.textContent).toContain(
      "Ready 1/4",
    );
    expect(container.querySelector('[aria-label="Deck media readiness"]')?.textContent).toContain(
      "Needs attention 3",
    );
    expect(container.querySelector('[aria-label="Deck media readiness"]')?.textContent).toContain(
      "External 2",
    );
    expect(container.querySelector('[aria-label="Deck media readiness"]')?.textContent).toContain(
      "Missing poster 2",
    );
    expect(container.querySelector('[aria-label="Deck media readiness"]')?.textContent).toContain(
      "Duplicates 2",
    );
    expect(
      container.querySelector('[aria-label="Deck media export readiness"]')?.textContent,
    ).toContain("Export blockers 3");
    expect(
      container.querySelector('[aria-label="Deck media export readiness"]')?.textContent,
    ).toContain("Export warnings 3");
    expect(container.textContent).toContain("Resolve 3 media export blockers before export.");
    for (const label of ["PPTX", "PDF", "SVG ZIP"]) {
      const exportButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.includes(label) === true,
      );
      expect(exportButton?.disabled).toBe(true);
      expect(exportButton?.title).toBe("Resolve 3 media export blockers before export.");
    }
    const exportCallsBeforeBlockedExport = toolCalls.filter(
      (call) => call.url === "/api/tools/slides.export",
    ).length;
    const blockedExportCommands = platformHost
      .getCommandPaletteItems()
      .filter((item) => item.label.startsWith("Export deck as "));
    expect(blockedExportCommands.map((item) => item.label)).toEqual([
      "Export deck as PPTX",
      "Export deck as PDF",
      "Export deck as SVG ZIP",
    ]);
    expect(blockedExportCommands.map((item) => item.disabledReason)).toEqual([
      "Resolve 3 media export blockers before export.",
      "Resolve 3 media export blockers before export.",
      "Resolve 3 media export blockers before export.",
    ]);
    await act(async () => {
      await Promise.resolve(blockedExportCommands[0]?.run());
    });
    await settle();
    expect(toolCalls.filter((call) => call.url === "/api/tools/slides.export")).toHaveLength(
      exportCallsBeforeBlockedExport,
    );
    await clickButton("PPTX");
    await settle();
    expect(toolCalls.filter((call) => call.url === "/api/tools/slides.export")).toHaveLength(
      exportCallsBeforeBlockedExport,
    );
    expect(table("Deck media assets").textContent).toContain("Ready clip");
    expect(table("Deck media assets").textContent).toContain("Ready");
    expect(table("Deck media assets").textContent).toContain("External source, Missing poster");
    expect(table("Deck media assets").textContent).toContain("Missing source, Missing poster");
    expect(table("Deck media assets").textContent).toContain("Duplicate source");

    await changeSelect("Deck media filter", "needs-attention");
    expect(table("Deck media assets").textContent).not.toContain("Ready clip");
    expect(table("Deck media assets").textContent).toContain("External clip");
    expect(table("Deck media assets").textContent).toContain("Missing clip");
    expect(table("Deck media assets").textContent).toContain("Team soundtrack");

    await changeSelect("Deck media filter", "external");
    expect(table("Deck media assets").textContent).toContain("External clip");
    expect(table("Deck media assets").textContent).toContain("Team soundtrack");
    expect(table("Deck media assets").textContent).not.toContain("Missing clip");

    await changeSelect("Deck media filter", "missing-poster");
    expect(table("Deck media assets").textContent).toContain("External clip");
    expect(table("Deck media assets").textContent).toContain("Missing clip");
    expect(table("Deck media assets").textContent).not.toContain("Team soundtrack");

    await changeSelect("Deck media filter", "duplicate");
    expect(table("Deck media assets").textContent).toContain("External clip");
    expect(table("Deck media assets").textContent).toContain("Team soundtrack");
    expect(table("Deck media assets").textContent).not.toContain("Missing clip");

    await changeSelect("Deck media filter", "audio");
    expect(table("Deck media assets").textContent).toContain("Team soundtrack");
    expect(table("Deck media assets").textContent).not.toContain("External clip");

    await clickButtonByLabel("Open slide 2 media asset Team soundtrack");
    expect(input("Slide title").value).toBe("Appendix");
    expect(select("Slide shape").value).toBe("audio-external");

    await changeSelect("Bulk deck video source", "88888888-8888-4888-8888-888888888888");
    await clickButton("Replace 2 blocked video sources");
    await settle();
    expect(latestUpdatedShape(firstSlideId, "video-external")).toMatchObject({
      mediaUrl: "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
      mediaType: "video",
      mediaTitle: "External clip",
    });
    expect(latestUpdatedShape(firstSlideId, "video-missing")).toMatchObject({
      mediaUrl: "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
      mediaType: "video",
      mediaTitle: "Missing clip",
    });

    await changeSelect("Bulk deck audio source", "99999999-9999-4999-8999-999999999999");
    await clickButton("Replace 1 blocked audio source");
    await settle();
    expect(latestUpdatedShape(secondSlideId, "audio-external")).toMatchObject({
      mediaUrl: "/api/drive/objects/99999999-9999-4999-8999-999999999999/content",
      mediaType: "audio",
      mediaTitle: "Team soundtrack",
    });
    expect(
      container.querySelector('[aria-label="Deck media export readiness"]')?.textContent,
    ).toContain("Export blockers 0");
    for (const label of ["PPTX", "PDF", "SVG ZIP"]) {
      const exportButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.includes(label) === true,
      );
      expect(exportButton?.disabled).toBe(false);
    }
  });

  it("resolves duplicate deck media sources with same-type Drive assets", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "bullets",
        title: "Launch story",
        items: ["Positioning", "Demo"],
        shapes: [
          {
            id: "video-intro",
            kind: "media",
            x: 10,
            y: 16,
            width: 34,
            height: 20,
            text: "",
            tone: "accent",
            mediaUrl: "https://example.test/shared.mp4",
            mediaPosterUrl: "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
            mediaType: "video",
            mediaTitle: "Intro clip",
          },
          {
            id: "video-outro",
            kind: "media",
            x: 48,
            y: 16,
            width: 28,
            height: 18,
            text: "",
            tone: "accent",
            mediaUrl: "https://example.test/shared.mp4",
            mediaPosterUrl: "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
            mediaType: "video",
            mediaTitle: "Outro clip",
          },
        ],
      }),
    ];

    render();
    await settle();

    expect(container.querySelector('[aria-label="Deck media readiness"]')?.textContent).toContain(
      "Duplicates 2",
    );
    expect(select("Resolve duplicate deck media source Outro clip").textContent).toContain(
      "Product_demo_clip.mp4",
    );
    expect(select("Resolve duplicate deck media source Outro clip").textContent).not.toContain(
      "Founder_update.mp3",
    );
    expect(select("Duplicate deck video source").textContent).toContain("Product_demo_clip.mp4");
    expect(select("Duplicate deck video source").textContent).not.toContain("Founder_update.mp3");

    await changeSelect("Duplicate deck video source", "88888888-8888-4888-8888-888888888888");
    await clickButton("Replace 1 duplicate video source");
    await settle();

    expect(latestUpdatedShape(firstSlideId, "video-intro")).toMatchObject({
      mediaUrl: "https://example.test/shared.mp4",
      mediaType: "video",
      mediaTitle: "Intro clip",
    });
    expect(latestUpdatedShape(firstSlideId, "video-outro")).toMatchObject({
      mediaUrl: "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
      mediaType: "video",
      mediaTitle: "Outro clip",
    });
    expect(container.querySelector('[aria-label="Deck media readiness"]')?.textContent).toContain(
      "Duplicates 0",
    );
  });

  it("replaces deck-wide media sources and poster art from Drive", async () => {
    slides = [
      slide(firstSlideId, 0, {
        layout: "bullets",
        title: "Launch story",
        items: ["Positioning", "Demo"],
        shapes: [
          {
            id: "video-external",
            kind: "media",
            x: 48,
            y: 16,
            width: 28,
            height: 18,
            text: "",
            tone: "accent",
            mediaUrl: "https://example.test/external.mp4",
            mediaType: "video",
            mediaTitle: "External clip",
          },
          {
            id: "video-missing",
            kind: "media",
            x: 12,
            y: 44,
            width: 30,
            height: 18,
            text: "",
            tone: "accent",
            mediaType: "video",
            mediaTitle: "Missing clip",
          },
          {
            id: "audio-external",
            kind: "media",
            x: 10,
            y: 68,
            width: 34,
            height: 10,
            text: "",
            tone: "accent",
            mediaUrl: "https://example.test/soundtrack.mp3",
            mediaType: "audio",
            mediaTitle: "Team soundtrack",
          },
        ],
      }),
    ];

    render();
    await settle();

    expect(select("Replace deck media source External clip").textContent).toContain(
      "Product_demo_clip.mp4",
    );
    expect(select("Replace deck media source External clip").textContent).toContain(
      "Founder_update.mp3",
    );
    expect(select("Replace deck media source External clip").textContent).not.toContain(
      "Roadmap_hero.png",
    );
    expect(select("Replace deck media poster External clip").textContent).toContain(
      "Roadmap_hero.png",
    );
    expect(select("Replace deck media poster External clip").textContent).not.toContain(
      "Product_demo_clip.mp4",
    );

    await changeSelect(
      "Replace deck media source External clip",
      "88888888-8888-4888-8888-888888888888",
    );
    await settle();
    expect(latestUpdatedShape(firstSlideId, "video-external")).toMatchObject({
      mediaUrl: "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
      mediaType: "video",
      mediaTitle: "External clip",
    });

    await changeSelect(
      "Replace deck media poster External clip",
      "77777777-7777-4777-8777-777777777777",
    );
    await settle();
    expect(latestUpdatedShape(firstSlideId, "video-external")).toMatchObject({
      mediaPosterUrl: "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
    });

    await changeSelect(
      "Replace deck media source Missing clip",
      "99999999-9999-4999-8999-999999999999",
    );
    await settle();
    expect(latestUpdatedShape(firstSlideId, "video-missing")).toMatchObject({
      mediaUrl: "/api/drive/objects/99999999-9999-4999-8999-999999999999/content",
      mediaType: "audio",
      mediaTitle: "Missing clip",
    });

    await changeSelect(
      "Replace deck media source Team soundtrack",
      "88888888-8888-4888-8888-888888888888",
    );
    await settle();
    expect(latestUpdatedShape(firstSlideId, "audio-external")).toMatchObject({
      mediaUrl: "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
      mediaType: "video",
      mediaTitle: "Team soundtrack",
    });
  });

  it("picks Drive image and media assets for freeform slide shapes", async () => {
    render();
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/drive.list",
      body: {
        folderId: null,
        includeTrashed: false,
        limit: 100,
        acrossFolders: true,
      },
    });

    await clickButton("Image");
    await settle();
    expect(select("Drive image asset").textContent).toContain("Roadmap_hero.png");
    expect(select("Drive image asset").textContent).not.toContain("Board_packet.pdf");
    await changeInput("Shape image alt text", "");
    await changeSelect("Drive image asset", "77777777-7777-4777-8777-777777777777");
    await settle();

    const imageShape = shapeByLabel("Image Roadmap hero");
    expect(imageShape.querySelector("img")?.getAttribute("src")).toBe(
      "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
    );
    expect(imageShape.querySelector("img")?.getAttribute("alt")).toBe("Roadmap hero");

    await clickButtonByLabel("Add media shape");
    await settle();
    expect(select("Drive media asset").textContent).toContain("Product_demo_clip.mp4");
    expect(select("Drive media asset").textContent).toContain("Founder_update.mp3");
    expect(select("Drive media asset").textContent).not.toContain("Roadmap_hero.png");
    expect(select("Drive media asset").textContent).not.toContain("Board_packet.pdf");
    await changeInput("Shape media title", "");
    await changeSelect("Drive media asset", "88888888-8888-4888-8888-888888888888");
    await settle();
    await changeSelect("Drive poster image", "77777777-7777-4777-8777-777777777777");
    await settle();

    const mediaShape = shapeByLabel("Media Product demo clip");
    const editorVideo = mediaShape.querySelector<HTMLVideoElement>("video");
    expect(editorVideo?.getAttribute("src")).toBe(
      "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
    );
    expect(editorVideo?.getAttribute("poster")).toBe(
      "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
    );
    expect(select("Shape media type").value).toBe("video");
    const mediaAssetsTable = container.querySelector('[aria-label="Slide media assets"]');
    expect(mediaAssetsTable?.textContent).toContain("Product demo clip");
    expect(mediaAssetsTable?.textContent).toContain("Drive");
    expect(mediaAssetsTable?.textContent).toContain("Controls");
    expect(container.querySelector('[aria-label="Deck media assets"]')).toBeNull();
    await changeSelect("Slide shape", "shape-1");
    expect(select("Shape kind").value).toBe("image");
    await clickButtonByLabel("Select media asset Product demo clip");
    expect(select("Slide shape").value).toBe("shape-2");
    expect(select("Shape kind").value).toBe("media");
    expect(shapeByLabel("Media Product demo clip").getAttribute("aria-pressed")).toBe("true");

    await clickButton("Save slide");
    await settle();

    const deckMediaAssetsTable = container.querySelector('[aria-label="Deck media assets"]');
    expect(deckMediaAssetsTable?.textContent).toContain("1");
    expect(deckMediaAssetsTable?.textContent).toContain("Product demo clip");
    expect(deckMediaAssetsTable?.textContent).toContain("Drive");
    expect(deckMediaAssetsTable?.textContent).toContain("Controls");
    await clickButton("Appendix");
    expect(input("Slide title").value).toBe("Appendix");
    await clickButtonByLabel("Open slide 1 media asset Product demo clip");
    expect(input("Slide title").value).toBe("Launch story");
    expect(select("Slide shape").value).toBe("shape-2");
    expect(shapeByLabel("Media Product demo clip").getAttribute("aria-pressed")).toBe("true");

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "shape-1",
              kind: "image",
              x: 52,
              y: 16,
              width: 32,
              height: 24,
              text: "",
              tone: "accent",
              imageUrl: "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
              imageAlt: "Roadmap hero",
            },
            {
              id: "shape-2",
              kind: "media",
              x: 46,
              y: 42,
              width: 34,
              height: 20,
              text: "",
              tone: "accent",
              mediaUrl: "/api/drive/objects/88888888-8888-4888-8888-888888888888/content",
              mediaType: "video",
              mediaTitle: "Product demo clip",
              mediaPosterUrl: "/api/drive/objects/77777777-7777-4777-8777-777777777777/content",
            },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });
    expect(toolCalls.some((call) => call.url === "/api/tools/drive.upload")).toBe(false);
    expect(toolCalls.some((call) => call.url === "/api/tools/drive.finalize")).toBe(false);
  });

  it("duplicates a native slide after its source slide", async () => {
    render();
    await settle();

    await clickButtonByLabel("Duplicate Launch story");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.create",
      body: {
        deckId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
        },
        speakerNotes: "Opening notes",
        position: 1,
      },
    });
    expect(slides.map((candidate) => candidate.content.title)).toEqual([
      "Launch story",
      "Launch story",
      "Appendix",
    ]);
    expect(input("Slide title").value).toBe("Launch story");
  });

  it("persists slide transitions and applies them in presentation mode", async () => {
    render();
    await settle();

    expect(select("Slide transition").value).toBe("none");
    await changeSelect("Slide transition", "slide");
    await changeInput("Transition duration", "720");
    await changeSelect("Transition direction", "left");
    const callsBeforePreview = toolCalls.length;
    await clickButton("Preview transition");
    await settle();

    const editorSlide = container.querySelector<HTMLElement>('[aria-label="Slide preview"]');
    expect(editorSlide?.style.animationName).toBe("helix-slide-transition-left");
    expect(editorSlide?.style.animationDuration).toBe("720ms");
    expect(toolCalls).toHaveLength(callsBeforePreview);

    await clickButton("Preview transition");
    await settle();
    const replayedEditorSlide = container.querySelector<HTMLElement>(
      '[aria-label="Slide preview"]',
    );
    expect(replayedEditorSlide).not.toBe(editorSlide);
    expect(replayedEditorSlide?.style.animationName).toBe("helix-slide-transition-left");
    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          transition: {
            type: "slide",
            direction: "left",
            durationMs: 720,
          },
        },
        speakerNotes: "Opening notes",
      },
    });

    await clickButton("Present");
    const presentSlide = dialog("Presentation mode").querySelector<HTMLElement>(
      '[aria-label="Slide preview"]',
    );
    expect(presentSlide?.style.animationName).toBe("helix-slide-transition-left");
    expect(presentSlide?.style.animationDuration).toBe("720ms");
    await pressDocumentKey("Escape");
  });

  it("connects to Slides sync and sends slide saves over the collaboration channel", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    slides = slides.map((candidate) =>
      candidate.id === secondSlideId
        ? {
            ...candidate,
            content: {
              ...candidate.content,
              shapes: [
                {
                  id: "shape-remote",
                  kind: "text",
                  x: 16,
                  y: 20,
                  width: 36,
                  height: 12,
                  text: "Remote focus",
                  tone: "dark",
                },
              ],
            },
          }
        : candidate,
    );
    render();
    await settle();

    const socket = MockWebSocket.instances.at(-1);
    expect(socket?.url).toBe(`ws://localhost:3000/sync/slides/${deckId}?protocol=slides-sync`);

    act(() => {
      socket?.open();
      socket?.receive({
        type: "ready",
        protocol: "slides-sync",
        deckId,
        revision: 0,
        deck: deck(),
        slides,
        awareness: [
          {
            actorId: "44444444-4444-4444-8444-444444444444",
            displayName: "Grace Hopper",
            selectedSlideId: secondSlideId,
            selectedShapeId: "shape-remote",
            mode: "editing",
            updatedAt: "2026-05-20T12:01:00.000Z",
          },
        ],
      });
    });
    await settle();

    // Live status pill replaces the previous "Live collaboration connected" header text.
    expect(container.querySelector('[role="status"][aria-label="Live"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Active collaborators"]')).not.toBeNull();
    expect(container.textContent).toContain("GH");
    expect(
      container.querySelector('[aria-label="Active collaborators"] span')?.getAttribute("title"),
    ).toBe("Grace Hopper is editing on slide 2, Remote focus");
    expect(container.querySelector('[aria-label="Grace Hopper selected Remote focus"]')).toBeNull();
    await clickButton("Appendix");
    expect(
      container.querySelector('[aria-label="Grace Hopper selected Remote focus"]'),
    ).not.toBeNull();
    await clickButton("Launch story");
    expect(
      socket?.sent.some(
        (frame) =>
          isRecord(frame) &&
          frame.type === "awareness" &&
          frame.selectedSlideId === firstSlideId &&
          frame.selectedShapeId === null &&
          frame.mode === "editing",
      ),
    ).toBe(true);

    await changeInput("Slide title", "Realtime story");
    await clickButton("Save slide");
    await settle();

    const sent = socket?.sent.at(-1) as
      | {
          readonly type?: unknown;
          readonly operationId?: unknown;
          readonly operation?: unknown;
        }
      | undefined;
    expect(typeof sent?.operationId).toBe("string");
    expect(sent).toMatchObject({
      type: "operation",
      operation: {
        kind: "update-slide",
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Realtime story",
          items: ["Positioning", "Demo"],
        },
        speakerNotes: "Opening notes",
      },
    });

    await changeSelect("Deck theme", "meadow");
    const themeFrame = socket?.sent.at(-1) as Record<string, unknown> | undefined;
    expect(typeof themeFrame?.operationId).toBe("string");
    expect(themeFrame).toMatchObject({
      type: "operation",
      baseRevision: 0,
      operation: {
        kind: "update-deck",
        metadata: { audience: "board", theme: "meadow" },
      },
    });

    await clickButtonByLabel("Duplicate Launch story");
    const duplicateFrame = socket?.sent.at(-1) as Record<string, unknown> | undefined;
    expect(typeof duplicateFrame?.operationId).toBe("string");
    expect(duplicateFrame).toMatchObject({
      type: "operation",
      baseRevision: 0,
      operation: {
        kind: "create-slide",
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
        },
        speakerNotes: "Opening notes",
        position: 1,
      },
    });

    await clickButtonByLabel("Move Launch story down");
    const reorderFrame = socket?.sent.at(-1) as Record<string, unknown> | undefined;
    expect(typeof reorderFrame?.operationId).toBe("string");
    expect(reorderFrame).toMatchObject({
      type: "operation",
      baseRevision: 0,
      operation: {
        kind: "reorder-slides",
        slideIds: [secondSlideId, firstSlideId],
      },
    });

    await clickButtonByLabel("Delete Launch story");
    const deleteFrame = socket?.sent.at(-1) as Record<string, unknown> | undefined;
    expect(typeof deleteFrame?.operationId).toBe("string");
    expect(deleteFrame).toMatchObject({
      type: "operation",
      baseRevision: 0,
      operation: {
        kind: "delete-slide",
        slideId: firstSlideId,
      },
    });

    await clickButton("Add slide");
    const createFrame = socket?.sent.at(-1) as
      | {
          readonly operationId?: unknown;
          readonly operation?: unknown;
        }
      | undefined;
    expect(typeof createFrame?.operationId).toBe("string");
    expect(createFrame).toMatchObject({
      operation: {
        kind: "create-slide",
        content: {
          layout: "bullets",
          title: "Key points",
          items: ["First point"],
        },
        speakerNotes: "",
      },
    });

    const createdSlide = slide("44444444-4444-4444-8444-444444444444", 2, {
      layout: "bullets",
      title: "Created together",
      items: ["Next"],
    });
    act(() => {
      socket?.receive({
        type: "operation",
        protocol: "slides-sync",
        deckId,
        operationId: createFrame?.operationId,
        revision: 1,
        operation: {
          kind: "create-slide",
          content: {
            layout: "bullets",
            title: "Key points",
            items: ["First point"],
          },
          speakerNotes: "",
        },
        deck: { ...deck(), slideCount: 3 },
        slides: [...slides, createdSlide],
      });
    });
    await settle();

    expect(input("Slide title").value).toBe("Created together");

    expect(
      toolCalls.some((call) =>
        [
          "/api/tools/slides.slide.update",
          "/api/tools/slides.deck.update",
          "/api/tools/slides.slide.reorder",
          "/api/tools/slides.slide.delete",
          "/api/tools/slides.slide.create",
        ].includes(call.url),
      ),
    ).toBe(false);
  });

  it("surfaces Slides realtime save errors instead of leaving the editor looking live", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    render();
    await settle();

    const socket = MockWebSocket.instances.at(-1);
    act(() => {
      socket?.open();
      socket?.receive({
        type: "ready",
        protocol: "slides-sync",
        deckId,
        revision: 0,
        deck: deck(),
        slides,
      });
      socket?.receive({
        type: "error",
        error: 'column "revision" does not exist',
      });
    });
    await settle();

    expect(container.querySelector('[role="status"][aria-label="Save failed"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Slides realtime save failed: column "revision" does not exist.',
    );
  });

  it("falls back to REST slide saves when realtime send fails", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    render();
    await settle();

    const socket = MockWebSocket.instances.at(-1);
    act(() => {
      socket?.open();
      socket?.receive({
        type: "ready",
        protocol: "slides-sync",
        deckId,
        revision: 0,
        deck: deck(),
        slides,
      });
    });
    await settle();

    if (socket !== undefined) {
      socket.throwOnSend = true;
    }
    await changeInput("Slide title", "REST fallback story");
    await clickButton("Save slide");
    await settle();

    expect(socket?.closed).toBe(true);
    expect(container.querySelector('[role="status"][aria-label="Save failed"]')).not.toBeNull();
    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "REST fallback story",
          items: ["Positioning", "Demo"],
        },
        speakerNotes: "Opening notes",
      },
    });
  });

  it("exports a native deck as PPTX, PDF, and image series from the editor header", async () => {
    const createObjectUrl = vi.fn(() => "blob:slides-export");
    const revokeObjectUrl = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });

    render();
    await settle();

    await clickButton("PPTX");
    await settle();
    await clickButton("PDF");
    await settle();
    await clickButton("SVG ZIP");
    await settle();

    expect(
      toolCalls.filter((call) => call.url === "/api/tools/slides.export").map((call) => call.body),
    ).toEqual([
      { deckId, format: "pptx" },
      { deckId, format: "pdf" },
      { deckId, format: "svg-series" },
    ]);
    expect(createObjectUrl).toHaveBeenCalledTimes(3);
    expect(anchorClick).toHaveBeenCalledTimes(3);
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:slides-export");
  });

  it("lists and restores deck versions from the side panel", async () => {
    render();
    await settle();

    await clickSidePanelTab("Versions");
    expect(container.textContent).toContain("Version history");
    expect(container.textContent).toContain("Version 4");
    expect(container.textContent).toContain("1 slide");

    await clickButton("Restore");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.version.restore",
      body: { deckId, versionId: deckVersionId },
    });
    expect(container.textContent).toContain("Restored deck title");
  });

  it("registers presentation command palette actions", async () => {
    const createObjectUrl = vi.fn(() => "blob:slides-command-export");
    const revokeObjectUrl = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });

    render();
    await settle();

    const commands = platformHost.getCommandPaletteItems();
    expect(commands.map((item) => item.label)).toEqual(
      expect.arrayContaining([
        "Add slide",
        "Duplicate current slide",
        "Present deck",
        "Export deck as PPTX",
        "Export deck as PDF",
        "Export deck as SVG ZIP",
      ]),
    );

    await act(async () => {
      await Promise.resolve(commands.find((item) => item.label === "Add slide")?.run());
    });
    await settle();
    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.create",
      body: {
        deckId,
        content: { layout: "bullets", title: "Key points", items: ["First point"] },
        speakerNotes: "",
      },
    });

    await act(async () => {
      await Promise.resolve(commands.find((item) => item.label === "Present deck")?.run());
    });
    expect(dialog("Presentation mode").textContent).toContain("Slide 3 of 3");
    await pressDocumentKey("Escape");

    await act(async () => {
      await Promise.resolve(commands.find((item) => item.label === "Export deck as PDF")?.run());
    });
    await settle();
    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.export",
      body: { deckId, format: "pdf" },
    });
    expect(createObjectUrl).toHaveBeenCalled();
    expect(anchorClick).toHaveBeenCalled();
  });

  it("adds embedded media shapes and enables playback in presentation mode", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    render();
    await settle();

    await clickButtonByLabel("Add media shape");
    expect(select("Shape kind").value).toBe("media");
    await changeInput("Shape media URL", "https://example.test/product-demo.mp4");
    await changeInput("Shape media title", "Product walkthrough");
    await changeSelect("Shape media type", "video");
    await changeInput("Shape media poster URL", "https://example.test/product-poster.png");
    await changeInput("Shape media caption URL", "https://example.test/product-captions.vtt");
    await changeInput("Shape media caption label", "English captions");
    await changeInput("Shape media trim start", "3");
    await changeInput("Shape media trim end", "19");
    await changeCheckbox("Shape media autoplay", true);
    await changeCheckbox("Shape media loop", true);
    await changeCheckbox("Shape media muted", true);
    await changeInput("Shape x", "14");
    await changeInput("Shape y", "52");
    await changeInput("Shape width", "44");
    await changeInput("Shape height", "28");

    const mediaShape = shapeByLabel("Media Product walkthrough");
    const editorVideo = mediaShape.querySelector<HTMLVideoElement>("video");
    expect(editorVideo?.getAttribute("src")).toBe("https://example.test/product-demo.mp4#t=3,19");
    expect(editorVideo?.getAttribute("poster")).toBe("https://example.test/product-poster.png");
    expect(editorVideo?.querySelector("track")?.getAttribute("src")).toBe(
      "https://example.test/product-captions.vtt",
    );
    expect(editorVideo?.querySelector("track")?.getAttribute("kind")).toBe("captions");
    expect(editorVideo?.querySelector("track")?.getAttribute("srclang")).toBe("en");
    expect(editorVideo?.querySelector("track")?.getAttribute("label")).toBe("English captions");
    expect(editorVideo?.controls).toBe(false);
    expect(editorVideo?.autoplay).toBe(false);
    expect(editorVideo?.loop).toBe(true);
    expect(editorVideo?.muted).toBe(true);

    const callsBeforePreview = toolCalls.length;
    await clickButton("Preview trim");
    await settle();
    expect(editorVideo?.currentTime).toBe(3);
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Previewing trim 3-19s.");
    expect(toolCalls).toHaveLength(callsBeforePreview);
    await act(async () => {
      if (editorVideo === null) {
        throw new Error("Expected editor video.");
      }
      editorVideo.currentTime = 19.25;
      editorVideo.dispatchEvent(new Event("timeupdate"));
      await Promise.resolve();
    });
    expect(editorVideo?.currentTime).toBe(19);
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Trim preview ended at 19s.");

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "shape-1",
              kind: "media",
              x: 14,
              y: 52,
              width: 44,
              height: 28,
              text: "",
              tone: "accent",
              mediaUrl: "https://example.test/product-demo.mp4",
              mediaType: "video",
              mediaTitle: "Product walkthrough",
              mediaPosterUrl: "https://example.test/product-poster.png",
              mediaCaptionUrl: "https://example.test/product-captions.vtt",
              mediaCaptionLabel: "English captions",
              mediaStartSeconds: 3,
              mediaEndSeconds: 19,
              mediaAutoplay: true,
              mediaLoop: true,
              mediaMuted: true,
            },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });

    const callsBeforePresent = toolCalls.length;
    await clickButton("Present");
    const presenterVideo = dialog("Presentation mode").querySelector<HTMLVideoElement>(
      'video[aria-label="Video Product walkthrough"]',
    );
    expect(presenterVideo?.controls).toBe(true);
    expect(presenterVideo?.getAttribute("src")).toBe(
      "https://example.test/product-demo.mp4#t=3,19",
    );
    expect(presenterVideo?.getAttribute("poster")).toBe("https://example.test/product-poster.png");
    expect(presenterVideo?.querySelector("track")?.getAttribute("src")).toBe(
      "https://example.test/product-captions.vtt",
    );
    expect(presenterVideo?.querySelector("track")?.getAttribute("kind")).toBe("captions");
    expect(presenterVideo?.querySelector("track")?.getAttribute("srclang")).toBe("en");
    expect(presenterVideo?.querySelector("track")?.getAttribute("label")).toBe("English captions");
    expect(presenterVideo?.autoplay).toBe(true);
    expect(presenterVideo?.loop).toBe(true);
    expect(presenterVideo?.muted).toBe(true);
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Plays 0",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Pauses 0",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Completed 0",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Seeks 0",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Errors 0",
    );
    await act(async () => {
      presenterVideo?.dispatchEvent(new Event("play", { bubbles: true }));
      presenterVideo?.dispatchEvent(new Event("pause", { bubbles: true }));
      presenterVideo?.dispatchEvent(new Event("seeked", { bubbles: true }));
      presenterVideo?.dispatchEvent(new Event("ended", { bubbles: true }));
      presenterVideo?.dispatchEvent(new Event("error", { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Slide 1 · Product walkthrough",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Plays 1",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Pauses 1",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Completed 1",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Seeks 1",
    );
    expect(container.querySelector('[aria-label="Playback analytics"]')?.textContent).toContain(
      "Errors 1",
    );
    expect(toolCalls).toHaveLength(callsBeforePresent);
    await clickElement(presenterVideo);
    expect(dialog("Presentation mode").textContent).toContain("Slide 1 of 2");
    await clickElement(
      dialog("Presentation mode").querySelector('[aria-label="Media Product walkthrough"]'),
    );
    expect(dialog("Presentation mode").textContent).toContain("Slide 1 of 2");
    await clickElement(presentationStage());
    expect(dialog("Presentation mode").textContent).toContain("Slide 2 of 2");
    await pressDocumentKey("ArrowLeft");
    await presenterVideo?.play();
    expect(playSpy).toHaveBeenCalledTimes(2);
    expect(toolCalls).toHaveLength(callsBeforePresent);

    playSpy.mockRestore();
    pauseSpy.mockRestore();
  });

  it("uploads audio media shapes and enables audio playback in presentation mode", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));

    render();
    await settle();

    await clickButtonByLabel("Add media shape");
    await changeInput("Shape media title", "");
    await uploadFile(
      "Upload shape media",
      new File(["mp3"], "Founder_update.mp3", { type: "audio/mpeg" }),
    );
    await settle();
    digestSpy.mockRestore();
    await changeInput("Shape media caption URL", "https://example.test/founder-captions.vtt");
    await changeInput("Shape media caption label", "Audio captions");

    expect(toolCalls).toContainEqual({
      url: "/api/tools/drive.upload",
      body: {
        name: "Founder_update.mp3",
        folderId: null,
        mimeType: "audio/mpeg",
        byteSize: 3,
        sha256: "0".repeat(64),
        metadata: { source: "web-shell" },
      },
    });
    expect(toolCalls).toContainEqual({
      url: "/api/tools/drive.finalize",
      body: {
        objectId: "55555555-5555-4555-8555-555555555555",
        byteSize: 3,
        sha256: "0".repeat(64),
        mimeType: "audio/mpeg",
        storageKey: "drive/555/Roadmap_photo.png",
        contentBase64: "bXAz",
        metadata: { source: "web-shell" },
      },
    });

    const audioShape = shapeByLabel("Media Founder update");
    const editorAudio = audioShape.querySelector<HTMLAudioElement>("audio");
    expect(editorAudio?.getAttribute("src")).toBe(
      "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
    );
    expect(editorAudio?.querySelector("track")?.getAttribute("src")).toBe(
      "https://example.test/founder-captions.vtt",
    );
    expect(editorAudio?.querySelector("track")?.getAttribute("label")).toBe("Audio captions");
    expect(editorAudio?.controls).toBe(false);

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Positioning", "Demo"],
          shapes: [
            {
              id: "shape-1",
              kind: "media",
              x: 46,
              y: 42,
              width: 34,
              height: 20,
              text: "",
              tone: "accent",
              mediaUrl: "/api/drive/objects/55555555-5555-4555-8555-555555555555/content",
              mediaType: "audio",
              mediaTitle: "Founder update",
              mediaCaptionUrl: "https://example.test/founder-captions.vtt",
              mediaCaptionLabel: "Audio captions",
            },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });

    const callsBeforePresent = toolCalls.length;
    await clickButton("Present");
    const presenterAudio = dialog("Presentation mode").querySelector<HTMLAudioElement>(
      'audio[aria-label="Audio Founder update"]',
    );
    expect(presenterAudio?.controls).toBe(true);
    expect(presenterAudio?.querySelector("track")?.getAttribute("src")).toBe(
      "https://example.test/founder-captions.vtt",
    );
    expect(presenterAudio?.querySelector("track")?.getAttribute("label")).toBe("Audio captions");
    await clickElement(presenterAudio);
    expect(dialog("Presentation mode").textContent).toContain("Slide 1 of 2");
    await clickElement(
      dialog("Presentation mode").querySelector('[aria-label="Media Founder update"]'),
    );
    expect(dialog("Presentation mode").textContent).toContain("Slide 1 of 2");
    await clickElement(presentationStage());
    expect(dialog("Presentation mode").textContent).toContain("Slide 2 of 2");
    await pressDocumentKey("ArrowLeft");
    await presenterAudio?.play();
    expect(playSpy).toHaveBeenCalledTimes(1);
    expect(toolCalls).toHaveLength(callsBeforePresent);

    playSpy.mockRestore();
  });

  it("reveals multiple animated shapes by build order and rewinds before changing slides", async () => {
    slides = [
      slide(
        firstSlideId,
        0,
        {
          layout: "title",
          title: "Build order",
          shapes: [
            {
              id: "shape-base",
              kind: "rectangle",
              x: 8,
              y: 12,
              width: 84,
              height: 66,
              text: "Backdrop",
              tone: "light",
            },
            {
              id: "shape-late",
              kind: "text",
              x: 18,
              y: 32,
              width: 26,
              height: 12,
              text: "Second reveal",
              tone: "dark",
              animation: { type: "fade", order: 2 },
            },
            {
              id: "shape-first",
              kind: "text",
              x: 18,
              y: 18,
              width: 24,
              height: 12,
              text: "First reveal",
              tone: "accent",
              animation: { type: "zoom", order: 0 },
            },
          ],
        },
        { speakerNotes: "Build notes" },
      ),
      slide(secondSlideId, 1, {
        layout: "title",
        title: "Appendix",
        subtitle: "Reference",
      }),
    ];

    render();
    await settle();

    const callsBeforePresent = toolCalls.length;
    await clickButton("Present");
    expect(dialog("Presentation mode").textContent).toContain("Build 0 of 2");
    expect(dialog("Presentation mode").textContent).toContain("Backdrop");
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box First reveal"]'),
    ).toBeNull();
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box Second reveal"]'),
    ).toBeNull();

    await clickButton("Next");
    expect(dialog("Presentation mode").textContent).toContain("Build 1 of 2");
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box First reveal"]'),
    ).not.toBeNull();
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box Second reveal"]'),
    ).toBeNull();

    await clickButton("Next");
    expect(dialog("Presentation mode").textContent).toContain("Build 2 of 2");
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box Second reveal"]'),
    ).not.toBeNull();

    await clickButton("Previous");
    expect(dialog("Presentation mode").textContent).toContain("Build 1 of 2");
    expect(dialog("Presentation mode").textContent).toContain("Slide 1 of 2");
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box First reveal"]'),
    ).not.toBeNull();
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box Second reveal"]'),
    ).toBeNull();

    await clickButton("Previous");
    expect(dialog("Presentation mode").textContent).toContain("Build 0 of 2");
    expect(dialog("Presentation mode").textContent).toContain("Slide 1 of 2");
    expect(
      dialog("Presentation mode").querySelector('[aria-label="Text box First reveal"]'),
    ).toBeNull();
    expect(toolCalls).toHaveLength(callsBeforePresent);
  });

  it("suggests and applies a local layout recommendation", async () => {
    render();
    await settle();

    await changeTextarea("Slide bullets", "42% - Expansion\n8 - Regions");
    const callsBeforeSuggestion = toolCalls.length;
    await clickButton("Suggest layout");

    expect(container.textContent).toContain("Suggested: Stats");
    expect(container.textContent).toContain("structured metric values");

    await changeTextarea("Slide bullets", "Revenue grew 42%");
    expect(container.textContent).not.toContain("Suggested: Stats");
    await clickButton("Suggest layout");
    expect(container.textContent).toContain("Suggested: Bullets");
    expect(container.textContent).not.toContain("structured metric values");

    await changeTextarea("Slide bullets", "42% - Expansion\n8 - Regions");
    expect(container.textContent).not.toContain("Suggested:");
    await clickButton("Suggest layout");

    await clickButton("Apply layout");

    expect(select("Slide layout").value).toBe("stats");
    expect(textarea("Slide stats").value).toBe(
      "42% | Expansion | Suggested\n8 | Regions | Suggested",
    );
    expect(toolCalls).toHaveLength(callsBeforeSuggestion);

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "stats",
          title: "Launch story",
          stats: [
            { value: "42%", label: "Expansion", note: "Suggested" },
            { value: "8", label: "Regions", note: "Suggested" },
          ],
        },
        speakerNotes: "Opening notes",
      },
    });
  });

  it("rewrites slide bullets and drafts speaker notes without calling tools", async () => {
    render();
    await settle();

    await changeTextarea("Slide bullets", "Positioning\nDemo");
    const callsBeforeAssist = toolCalls.length;
    await clickButton("Rewrite bullets");

    expect(textarea("Slide bullets").value).toBe(
      "Clarify positioning for launch story.\nShow demo for launch story.",
    );

    await clickButton("Draft notes");
    expect(textarea("Speaker notes").value).toBe(
      "Lead with Launch story. Emphasize Clarify positioning for launch story. and Show demo for launch story., then close with the next step.",
    );
    expect(toolCalls).toHaveLength(callsBeforeAssist);

    await clickButton("Save slide");
    await settle();

    expect(toolCalls).toContainEqual({
      url: "/api/tools/slides.slide.update",
      body: {
        slideId: firstSlideId,
        content: {
          layout: "bullets",
          title: "Launch story",
          items: ["Clarify positioning for launch story.", "Show demo for launch story."],
        },
        speakerNotes:
          "Lead with Launch story. Emphasize Clarify positioning for launch story. and Show demo for launch story., then close with the next step.",
      },
    });
  });

  it("shows live captions in presentation mode when browser speech recognition is available", async () => {
    MockSpeechRecognition.instances = [];
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: MockSpeechRecognition,
    });

    render();
    await settle();

    await clickButton("Present");
    await clickButton("Start captions");

    const recognition = MockSpeechRecognition.instances[0];
    expect(recognition).toBeDefined();
    expect(recognition?.continuous).toBe(true);
    expect(recognition?.interimResults).toBe(true);
    expect(recognition?.lang).toBe("en-US");
    expect(dialog("Presentation mode").textContent).toContain("Stop captions");
    expect(liveCaptions().textContent).toContain("Listening");
    expect(liveCaptions().style.bottom).toBe("28px");

    await act(async () => {
      recognition?.emit(["Revenue is up"], { isFinal: false });
      await Promise.resolve();
    });

    expect(liveCaptions().textContent).toContain("Revenue is up");
    await changeSelect("Caption position", "top");
    await changeSelect("Caption size", "large");
    await changeInput("Caption speaker", "Maya Chen");
    expect(liveCaptions().style.top).toBe("28px");
    expect(liveCaptions().style.bottom).toBe("");
    expect(liveCaptions().textContent).toContain("Live captions - Maya Chen");
    expect(liveCaptionText().style.fontSize).toBe("var(--text-title-sm)");
    expect(
      container.querySelector<HTMLAnchorElement>('a[aria-label="Download caption transcript"]'),
    ).toBeNull();

    await act(async () => {
      recognition?.emit(["Revenue is up", "and churn is down"], { isFinal: true });
      await Promise.resolve();
    });

    expect(liveCaptions().textContent).toContain("Revenue is up and churn is down");
    const transcriptDownload = captionTranscriptDownload();
    expect(transcriptDownload.download).toBe("board-narrative-captions.txt");
    expect(decodeURIComponent(transcriptDownload.href)).toContain(
      "Board narrative live captions\n\nSlide 1 (Maya Chen): Revenue is up and churn is down",
    );
    expect(container.textContent).toContain("Save transcript to Drive");

    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save transcript to Drive");
    await settle();
    digestSpy.mockRestore();

    const transcriptText =
      "Board narrative live captions\n\nSlide 1 (Maya Chen): Revenue is up and churn is down";
    const transcriptBytes = new TextEncoder().encode(transcriptText).byteLength;
    expect(container.textContent).toContain("Transcript saved.");
    expect(toolCallBody("/api/tools/drive.upload")).toMatchObject({
      name: "board-narrative-captions.txt",
      folderId: null,
      mimeType: "text/plain;charset=utf-8",
      byteSize: transcriptBytes,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    const finalizeBody = toolCallBody("/api/tools/drive.finalize");
    expect(finalizeBody).toMatchObject({
      objectId: "55555555-5555-4555-8555-555555555555",
      byteSize: transcriptBytes,
      sha256: "0".repeat(64),
      mimeType: "text/plain;charset=utf-8",
      metadata: { source: "web-shell" },
    });
    expect(typeof finalizeBody.contentBase64).toBe("string");

    await clickButton("Save transcript to library");
    expect(container.textContent).toContain("Transcript saved to library.");
    expect(container.textContent).toContain("Transcript library");
    const transcriptLibrary = JSON.parse(
      window.localStorage.getItem("helix.slides.captionTranscripts.v1") ?? "[]",
    ) as unknown;
    expect(Array.isArray(transcriptLibrary)).toBe(true);
    const transcriptEntries: readonly unknown[] = Array.isArray(transcriptLibrary)
      ? transcriptLibrary
      : [];
    expect(transcriptEntries).toHaveLength(1);
    const transcriptEntry = transcriptEntries[0];
    if (!isRecord(transcriptEntry)) {
      throw new Error("Expected transcript library entry.");
    }
    expect(transcriptEntry.deckTitle).toBe("Board narrative");
    expect(transcriptEntry.filename).toMatch(/^board-narrative-captions-\d{4}-\d{2}-\d{2}\.txt$/u);
    expect(transcriptEntry.lines).toEqual(["Slide 1 (Maya Chen): Revenue is up and churn is down"]);
    const savedTranscriptDownload = container.querySelector<HTMLAnchorElement>(
      'a[aria-label^="Download saved caption transcript"]',
    );
    expect(savedTranscriptDownload?.download).toMatch(/^board-narrative-captions-/u);
    expect(decodeURIComponent(savedTranscriptDownload?.href ?? "")).toContain(
      "Board narrative live captions\n\nSlide 1 (Maya Chen): Revenue is up and churn is down",
    );

    await clickButton("Stop captions");

    expect(recognition?.stopped).toBe(true);
    expect(container.querySelector('[aria-label="Live captions"]')).toBeNull();
    expect(captionTranscriptDownload().textContent).toContain("Download transcript");
  });

  it("shows a live-caption fallback when speech recognition is unavailable", async () => {
    render();
    await settle();

    const callsBeforePresent = toolCalls.length;
    await clickButton("Present");
    await clickButton("Start captions");

    expect(liveCaptions().textContent).toContain("Live captions are unavailable in this browser.");
    expect(toolCalls).toHaveLength(callsBeforePresent);
  });

  it("records presentation mode with browser screen capture and exposes a download", async () => {
    MockSpeechRecognition.instances = [];
    const stream = new MockMediaStream();
    const getDisplayMedia = vi.fn().mockResolvedValue(stream);
    const createObjectUrl = vi
      .fn()
      .mockReturnValueOnce("blob:recording-1")
      .mockReturnValue("blob:recording-package-1");
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: MockSpeechRecognition,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl,
    });

    render();
    await settle();

    const callsBeforePresent = toolCalls.length;
    await clickButton("Present");
    await clickButton("Start captions");
    const recognition = MockSpeechRecognition.instances[0];
    await act(async () => {
      recognition?.emit(["Recording does not stop captions"]);
      await Promise.resolve();
    });
    await clickButton("Start recording");

    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: true });
    const recorder = MockMediaRecorder.instances[0];
    expect(recorder).toBeDefined();
    expect(recorder?.state).toBe("recording");
    expect(presentationRecording().textContent).toContain("Recording presentation.");

    await act(async () => {
      recorder?.emitChunk(new Blob(["webm"], { type: "video/webm" }));
      await Promise.resolve();
    });
    await clickButton("Stop recording");
    await settle();

    expect(recorder?.state).toBe("inactive");
    expect(stream.videoTrack.stopped).toBe(true);
    expect(stream.audioTrack.stopped).toBe(true);
    expect(createObjectUrl).toHaveBeenCalledTimes(2);
    const download = presentationRecording().querySelector<HTMLAnchorElement>(
      'a[download="board-narrative-presentation.webm"]',
    );
    expect(download?.href).toBe("blob:recording-1");
    expect(download?.textContent).toContain("Download recording");
    const reviewPlayback = recordingReviewPlayback();
    expect(reviewPlayback.src).toBe("blob:recording-1");
    expect(reviewPlayback.controls).toBe(true);
    const captionReview = recordingCaptionReview();
    expect(captionReview.textContent).toContain("Slide 1");
    expect(captionReview.textContent).toContain("Presenter");
    expect(captionReview.textContent).toContain("Recording does not stop captions");
    const packageDownload = recordingPackageDownload();
    expect(packageDownload.href).toBe("blob:recording-package-1");
    expect(packageDownload.download).toBe("board-narrative-recording-package.zip");
    const packageBlob: unknown = createObjectUrl.mock.calls[1]?.[0];
    expect(packageBlob).toBeInstanceOf(Blob);
    expect((packageBlob as Blob).type).toBe("application/zip");
    const packageText = new TextDecoder().decode(await (packageBlob as Blob).arrayBuffer());
    expect(packageText).toContain("board-narrative-presentation.webm");
    expect(packageText).toContain("board-narrative-captions.txt");
    expect(packageText).toContain("board-narrative-recording-sync.json");
    expect(packageText).toContain("Presenter");
    expect(packageText).toContain("Recording does not stop captions");
    expect(recognition?.stopped).toBe(false);
    expect(liveCaptions().textContent).toContain("Recording does not stop captions");
    expect(toolCalls).toHaveLength(callsBeforePresent);

    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
    await clickButton("Save to Drive");
    await settle();
    digestSpy.mockRestore();
    expect(presentationRecording().textContent).toContain("Saved to Drive.");
    const uploadBody = toolCallBody("/api/tools/drive.upload");
    expect(uploadBody).toMatchObject({
      name: "board-narrative-recording-package.zip",
      folderId: null,
      mimeType: "application/zip",
      byteSize: (packageBlob as Blob).size,
      sha256: "0".repeat(64),
      metadata: { source: "web-shell" },
    });
    const finalizeBody = toolCallBody("/api/tools/drive.finalize");
    expect(finalizeBody).toMatchObject({
      objectId: "55555555-5555-4555-8555-555555555555",
      byteSize: (packageBlob as Blob).size,
      sha256: "0".repeat(64),
      mimeType: "application/zip",
      metadata: { source: "web-shell" },
    });
    expect(typeof finalizeBody.contentBase64).toBe("string");

    await clickButton("Exit");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:recording-1");
  });

  it("shows a recording fallback when screen recording is unavailable", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });

    render();
    await settle();

    const callsBeforePresent = toolCalls.length;
    await clickButton("Present");
    await clickButton("Start recording");

    expect(presentationRecording().textContent).toContain(
      "Recording is unavailable in this browser.",
    );
    expect(toolCalls).toHaveLength(callsBeforePresent);
  });

  it("stops active presentation recording when presentation mode closes", async () => {
    const stream = new MockMediaStream();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);

    render();
    await settle();

    await clickButton("Present");
    await clickButton("Start recording");
    const recorder = MockMediaRecorder.instances[0];
    expect(recorder?.state).toBe("recording");

    await pressDocumentKey("Escape");

    expect(recorder?.state).toBe("inactive");
    expect(stream.videoTrack.stopped).toBe(true);
    expect(stream.audioTrack.stopped).toBe(true);
    expect(container.querySelector('[role="dialog"][aria-label="Presentation mode"]')).toBeNull();
  });

  it("stops live captions when presentation mode closes", async () => {
    MockSpeechRecognition.instances = [];
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: MockSpeechRecognition,
    });

    render();
    await settle();

    await clickButton("Present");
    await clickButton("Start captions");

    const recognition = MockSpeechRecognition.instances[0];
    expect(recognition).toBeDefined();

    await pressDocumentKey("Escape");

    expect(recognition?.stopped).toBe(true);
    expect(container.querySelector('[role="dialog"][aria-label="Presentation mode"]')).toBeNull();
  });
});

class MockSpeechRecognition {
  static instances: MockSpeechRecognition[] = [];

  continuous = false;
  interimResults = false;
  lang = "";
  stopped = false;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onresult:
    | ((event: {
        readonly resultIndex: number;
        readonly results: {
          readonly length: number;
          readonly [index: number]: {
            readonly isFinal?: boolean;
            readonly 0: { readonly transcript: string };
          };
        };
      }) => void)
    | null = null;

  constructor() {
    MockSpeechRecognition.instances.push(this);
  }

  start(): void {
    this.onstart?.();
  }

  stop(): void {
    this.stopped = true;
    this.onend?.();
  }

  emit(
    transcripts: readonly string[],
    options: { readonly isFinal?: boolean } = { isFinal: true },
  ): void {
    const results = Object.assign(
      transcripts.map((transcript) => ({
        isFinal: options.isFinal ?? true,
        0: { transcript },
      })),
      { length: transcripts.length },
    );
    this.onresult?.({ resultIndex: 0, results });
  }
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }

  readonly stream: MediaStream;
  readonly mimeType = "video/webm;codecs=vp9,opus";
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(stream: MediaStream) {
    this.stream = stream;
    MockMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.onstop?.();
  }

  emitChunk(data: Blob): void {
    this.ondataavailable?.({ data } as BlobEvent);
  }
}

class MockMediaStreamTrack {
  static instances: MockMediaStreamTrack[] = [];

  stopped = false;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor() {
    MockMediaStreamTrack.instances.push(this);
  }

  stop(): void {
    this.stopped = true;
  }

  addEventListener(type: string, listener: () => void): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...current, listener]);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  closed = false;
  throwOnSend = false;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.throwOnSend) {
      throw new Error("socket send failed");
    }
    if (typeof data === "string") {
      this.sent.push(JSON.parse(data));
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  receive(message: unknown): void {
    this.emit("message", new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class MockMediaStream {
  readonly videoTrack = new MockMediaStreamTrack();
  readonly audioTrack = new MockMediaStreamTrack();

  getVideoTracks(): MediaStreamTrack[] {
    return [this.videoTrack as unknown as MediaStreamTrack];
  }

  getTracks(): MediaStreamTrack[] {
    return [
      this.videoTrack as unknown as MediaStreamTrack,
      this.audioTrack as unknown as MediaStreamTrack,
    ];
  }
}

function render(props: Partial<NativePresentationEditorProps> = {}) {
  act(() => {
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
        <QueryClientProvider client={queryClient}>
          <NativePresentationEditor deckId={deckId} onBack={() => undefined} {...props} />
        </QueryClientProvider>
      </WebPlatformProvider>,
    );
  });
}

function remountFreshEditor(props: Partial<NativePresentationEditorProps> = {}) {
  act(() => {
    root.unmount();
  });
  queryClient.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  platformHost = createWebPlatformHost({
    queryClient,
    getColorMode: () => "system",
  });
  root = createRoot(container);
  render(props);
}

function deck() {
  return {
    id: deckId,
    title: "Board narrative",
    ownerActorId: null,
    createdByActorId: null,
    slideCount: slides.length,
    metadata: deckMetadata,
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function slide(
  id: string,
  position: number,
  content: SlidesApiSlide["content"],
  overrides: Partial<SlidesApiSlide> = {},
): SlidesApiSlide {
  return {
    id,
    deckId,
    position,
    layout: content.layout,
    content,
    speakerNotes: "",
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
    ...overrides,
  };
}

function comment(
  id: string,
  overrides: Partial<SlidesDriveComment> & { readonly anchor: Record<string, unknown> },
): SlidesDriveComment {
  const { anchor, ...rest } = overrides;
  return {
    id,
    objectId: deckId,
    parentCommentId: null,
    actorId: "actor-1",
    anchor,
    body: "Comment",
    status: "open",
    metadata: {},
    resolvedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: null,
    ...rest,
  };
}

function driveFile(input: {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
}) {
  return {
    id: input.id,
    type: "file",
    name: input.name,
    folderId: null,
    ownerActorId: "actor-1",
    mimeType: input.mimeType,
    byteSize: 1024,
    sha256: null,
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function changeInput(label: string, value: string): Promise<void> {
  const target = input(label);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function changeTextarea(label: string, value: string): Promise<void> {
  const target = textarea(label);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
}

async function changeSelect(label: string, value: string): Promise<void> {
  const target = select(label);
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (valueSetter !== undefined) {
      Reflect.apply(valueSetter, target, [value]);
    }
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });
}

async function changeCheckbox(label: string, checked: boolean): Promise<void> {
  const target = input(label);
  if (target.checked === checked) {
    return;
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
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
    await Promise.resolve();
  });
}

function input(label: string): HTMLInputElement {
  const target = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing input: ${label}`);
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

function select(label: string): HTMLSelectElement {
  const target = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing select: ${label}`);
  }
  return target;
}

function table(label: string): HTMLTableElement {
  const target = container.querySelector<HTMLTableElement>(`table[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing table: ${label}`);
  }
  return target;
}

function dialog(label: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing dialog: ${label}`);
  }
  return target;
}

function nextSlidePreview(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Next slide preview"]');
  if (target === null) {
    throw new Error("Missing next slide preview");
  }
  return target;
}

function liveCaptions(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Live captions"]');
  if (target === null) {
    throw new Error("Missing live captions");
  }
  return target;
}

function liveCaptionText(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Live caption text"]');
  if (target === null) {
    throw new Error("Missing live caption text");
  }
  return target;
}

function captionTranscriptDownload(): HTMLAnchorElement {
  const target = container.querySelector<HTMLAnchorElement>(
    'a[aria-label="Download caption transcript"]',
  );
  if (target === null) {
    throw new Error("Missing caption transcript download");
  }
  return target;
}

function presentationRecording(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Presentation recording"]');
  if (target === null) {
    throw new Error("Missing presentation recording status");
  }
  return target;
}

function recordingPackageDownload(): HTMLAnchorElement {
  const target = container.querySelector<HTMLAnchorElement>(
    'a[aria-label="Download recording package"]',
  );
  if (target === null) {
    throw new Error("Missing recording package download");
  }
  return target;
}

function recordingReviewPlayback(): HTMLVideoElement {
  const target = container.querySelector<HTMLVideoElement>(
    'video[aria-label="Recording review playback"]',
  );
  if (target === null) {
    throw new Error("Missing recording review playback");
  }
  return target;
}

function recordingCaptionReview(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Recording caption review"]');
  if (target === null) {
    throw new Error("Missing recording caption review");
  }
  return target;
}

function toolCallBody(url: string): Record<string, unknown> {
  const call = toolCalls.find((candidate) => candidate.url === url);
  if (call === undefined || !isRecord(call.body)) {
    throw new Error(`Missing tool call body: ${url}`);
  }
  return call.body;
}

function latestToolCallBody(url: string): Record<string, unknown> {
  const call = [...toolCalls].reverse().find((candidate) => candidate.url === url);
  if (call === undefined || !isRecord(call.body)) {
    throw new Error(`Missing latest tool call body: ${url}`);
  }
  return call.body;
}

function slideUpdateBodies(): Array<{
  readonly slideId: string;
  readonly content: SlidesApiSlide["content"];
}> {
  return toolCalls
    .filter((candidate) => candidate.url === "/api/tools/slides.slide.update")
    .map(
      (candidate) =>
        candidate.body as {
          readonly slideId: string;
          readonly content: SlidesApiSlide["content"];
        },
    );
}

function latestUpdatedShape(slideId: string, shapeId: string): SlideShape {
  const update = [...slideUpdateBodies()]
    .reverse()
    .find((candidate) => candidate.slideId === slideId);
  const shape = update?.content.shapes?.find((candidate) => candidate.id === shapeId);
  if (shape === undefined) {
    throw new Error(`Missing updated shape: ${slideId}/${shapeId}`);
  }
  return shape;
}

function presentationStage(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Presentation stage"]');
  if (target === null) {
    throw new Error("Missing presentation stage");
  }
  return target;
}

function shapeLayer(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Freeform slide shapes"]');
  if (target === null) {
    throw new Error("Missing freeform slide shape layer");
  }
  return target;
}

function slidePreview(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[aria-label="Slide preview"]');
  if (target === null) {
    throw new Error("Missing slide preview");
  }
  return target;
}

function slidesEditorFrame(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[data-slides-editor-frame="true"]');
  if (target === null) {
    throw new Error("Missing slides editor frame");
  }
  return target;
}

function canvasWrap(): HTMLElement {
  const target = container.querySelector<HTMLElement>('[data-slides-canvas-wrap="true"]');
  if (target === null) {
    throw new Error("Missing slides canvas wrap");
  }
  return target;
}

function shapeByLabel(label: string): HTMLElement {
  const target = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing shape element: ${label}`);
  }
  return target;
}

function shapeCount(label: string): number {
  return container.querySelectorAll(`[aria-label="${label}"]`).length;
}

function connectorSvgLine(): SVGLineElement {
  const target = shapeByLabel("Connector").querySelector<SVGLineElement>("line");
  if (target === null) {
    throw new Error("Missing connector line");
  }
  return target;
}

function setElementRect(
  element: HTMLElement,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
): void {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  Object.defineProperty(element, "getBoundingClientRect", {
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

async function dragElement(
  element: HTMLElement,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        clientX: from.x,
        clientY: from.y,
        button: 0,
        buttons: 1,
      }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    document.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: to.x,
        clientY: to.y,
        buttons: 1,
      }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    document.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        clientX: to.x,
        clientY: to.y,
        button: 0,
        buttons: 0,
      }),
    );
    await Promise.resolve();
  });
}

async function keyDownElement(
  element: HTMLElement,
  key: string,
  options: {
    readonly shiftKey?: boolean;
    readonly altKey?: boolean;
    readonly ctrlKey?: boolean;
  } = {},
): Promise<void> {
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key,
        shiftKey: options.shiftKey ?? false,
        altKey: options.altKey ?? false,
        ctrlKey: options.ctrlKey ?? false,
      }),
    );
    await Promise.resolve();
  });
}

async function dropFileOnSlide(
  element: HTMLElement,
  file: File,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  const dataTransfer = {
    dropEffect: "none",
    items: {
      length: 1,
      0: {
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      },
    },
    files: {
      length: 1,
      0: file,
      item: (index: number) => (index === 0 ? file : null),
    },
  } as unknown as DataTransfer;
  await act(async () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    Object.defineProperty(event, "clientX", { value: point.x });
    Object.defineProperty(event, "clientY", { value: point.y });
    element.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function dropTextOnSlide(
  element: HTMLElement,
  text: string,
  point: { readonly x: number; readonly y: number },
  type = "text/plain",
): Promise<void> {
  const dataTransfer = {
    dropEffect: "none",
    types: [type],
    getData: (requestedType: string) => (requestedType === type ? text : ""),
    items: { length: 0 },
    files: { length: 0, item: () => null },
  } as unknown as DataTransfer;
  await act(async () => {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    Object.defineProperty(event, "clientX", { value: point.x });
    Object.defineProperty(event, "clientY", { value: point.y });
    element.dispatchEvent(event);
    await Promise.resolve();
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

async function clickSidePanelTab(label: string): Promise<void> {
  const sidePanel = container.querySelector<HTMLElement>('[data-testid="editor-side-panel"]');
  const target = Array.from(sidePanel?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).find(
    (tab) => tab.getAttribute("aria-label") === label || tab.textContent?.trim() === label,
  );
  if (target === undefined) {
    throw new Error(`Missing side-panel tab: ${label}`);
  }
  await act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    target.click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function clickButtonByLabel(label: string): Promise<void> {
  const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (target === null) {
    throw new Error(`Missing button: ${label}`);
  }
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

function clickAppMenu(menuId: string): void {
  const target = container.querySelector<HTMLButtonElement>(`button[data-menu-id="${menuId}"]`);
  if (target === null) {
    throw new Error(`Missing app menu: ${menuId}`);
  }
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function clickAppBarShare(): void {
  const target =
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Share" && button.dataset.menuId !== "share",
    ) ?? null;
  if (target === null) {
    throw new Error("Missing app-bar Share button");
  }
  act(() => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

function clickOpenMenuItem(label: string): void {
  const target =
    Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']")).find((node) =>
      node.textContent?.includes(label),
    ) ?? null;
  if (target === null) {
    throw new Error(
      `Missing open menu item: ${label}. Found: ${JSON.stringify(
        Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']")).map((node) =>
          node.textContent?.trim(),
        ),
      )}`,
    );
  }
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

async function clickElement(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) {
    throw new Error("Missing element to click");
  }
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

async function pressDocumentKey(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
    await Promise.resolve();
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
  // The slide editor's side panel now hosts the inspector tabs and only lazily
  // mounts a tab's content the first time it is activated. To keep these
  // tests source-stable (they look up fields by aria-label across the whole
  // container), eagerly click each inspector tab so the field markup is in
  // the DOM, then return to the Comments tab where the original tests left
  // the panel.
  await ensureInspectorTabsMounted();
}

async function ensureInspectorTabsMounted(): Promise<void> {
  // The slide editor's side panel hosts the inspector tabs and only lazily
  // mounts each tab's content the first time it is activated. Eagerly click
  // every tab so that subsequent `container.querySelector` lookups by
  // aria-label find the inspector fields regardless of which tab the editor
  // happens to leave active. Radix Tabs.Trigger needs mousedown+mouseup+click
  // to actually flip the active tab in JSDOM.
  const sidePanel = container.querySelector<HTMLElement>('[data-testid="editor-side-panel"]');
  if (sidePanel === null) return;
  const triggers = Array.from(sidePanel.querySelectorAll<HTMLElement>('[role="tab"]'));
  if (triggers.length === 0) return;
  for (const trigger of triggers) {
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      trigger.click();
      await Promise.resolve();
    });
    for (let index = 0; index < 3; index += 1) {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
    }
  }
}
