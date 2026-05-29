import { describe, expect, it } from "vitest";
import type { DriveStore } from "../drive/store.js";
import type { DriveCommentListItem } from "../drive/types.js";
import { createToolRegistry } from "../tool-registry.js";
import { InMemorySlidesStore } from "./store.js";
import { createSlidesToolDefinitions, registerSlides, registerSlidesTools } from "./tools.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

const invokeContext = {
  actor: {
    id: actorId,
    orgId,
    type: "user" as const,
    scopes: ["slides.read", "slides.write"],
  },
};

interface ToolOutput {
  readonly [key: string]: unknown;
}

function output(result: { ok: boolean; output?: unknown }): ToolOutput {
  if (!result.ok) {
    throw new Error("Expected a successful tool invocation.");
  }
  return result.output as ToolOutput;
}

async function pptxFixture(input: {
  readonly slides: readonly (readonly string[])[];
  readonly notes?: readonly string[];
}): Promise<Buffer> {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  input.slides.forEach((lines, index) => {
    zip.file(`ppt/slides/slide${String(index + 1)}.xml`, pptxTextXml(lines));
    const note = input.notes?.[index];
    if (note !== undefined) {
      zip.file(`ppt/notesSlides/notesSlide${String(index + 1)}.xml`, pptxTextXml([note]));
    }
  });
  return zip.generateAsync({ type: "nodebuffer" });
}

function pptxTextXml(lines: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">',
    ...lines.map((line) => `<a:t>${escapeXml(line)}</a:t>`),
    "</p:sld>",
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

class FakeDriveCommentReader {
  comments: readonly DriveCommentListItem[] = [];
  readonly listedComments: Parameters<NonNullable<DriveStore["listComments"]>>[0][] = [];

  async listComments(
    input: Parameters<NonNullable<DriveStore["listComments"]>>[0],
  ): Promise<readonly DriveCommentListItem[]> {
    this.listedComments.push(input);
    return this.comments;
  }
}

function driveComment(
  id: string,
  input: Partial<DriveCommentListItem> & {
    readonly objectId: string;
    readonly actorId: string;
    readonly anchor: DriveCommentListItem["anchor"];
    readonly body: string;
  },
): DriveCommentListItem {
  return {
    id,
    orgId,
    objectId: input.objectId,
    parentCommentId: input.parentCommentId ?? null,
    actorId: input.actorId,
    anchor: input.anchor,
    body: input.body,
    status: input.status ?? "open",
    metadata: input.metadata ?? {},
    resolvedAt: input.resolvedAt ?? null,
    createdAt: input.createdAt ?? new Date("2026-05-20T12:00:00.000Z"),
    updatedAt: input.updatedAt ?? null,
    ...(input.author === undefined ? {} : { author: input.author }),
  };
}

describe("slides tool definitions", () => {
  it("registers the full deck and slide tool surface with correct scopes", () => {
    const tools = createSlidesToolDefinitions({ store: new InMemorySlidesStore() });
    const byId = new Map(tools.map((tool) => [tool.id, tool]));
    expect([...byId.keys()].sort()).toEqual(
      [
        "slides.deck.create",
        "slides.deck.copy",
        "slides.deck.delete",
        "slides.export",
        "slides.import-pptx",
        "slides.deck.get",
        "slides.deck.list",
        "slides.deck.update",
        "slides.slide.create",
        "slides.slide.delete",
        "slides.slide.reorder",
        "slides.slide.update",
        "slides.version.list",
        "slides.version.restore",
      ].sort(),
    );
    expect(byId.get("slides.deck.list")?.permission).toBe("slides.read");
    expect(byId.get("slides.deck.get")?.permission).toBe("slides.read");
    expect(byId.get("slides.version.list")?.permission).toBe("slides.read");
    expect(byId.get("slides.version.restore")?.permission).toBe("slides.write");
    expect(byId.get("slides.export")?.permission).toBe("slides.read");
    expect(byId.get("slides.export")?.sideEffects).toBe("read");
    expect(byId.get("slides.import-pptx")?.permission).toBe("slides.write");
    expect(byId.get("slides.import-pptx")?.sideEffects).toBe("write");
    expect(byId.get("slides.deck.create")?.permission).toBe("slides.write");
    expect(byId.get("slides.deck.copy")?.sideEffects).toBe("write");
    expect(byId.get("slides.deck.delete")?.sideEffects).toBe("destructive");
    expect(byId.get("slides.slide.delete")?.sideEffects).toBe("destructive");
  });

  it("exposes registerSlides as an alias of registerSlidesTools", () => {
    expect(registerSlides).toBe(registerSlidesTools);
  });
});

describe("slides tools end-to-end", () => {
  it("copies a deck with slide content and metadata", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });

    const deck = output(
      await registry.invoke("slides.deck.create", { title: "Launch deck" }, invokeContext),
    );
    const deckId = deck.id as string;
    const slide = output(
      await registry.invoke(
        "slides.slide.create",
        {
          deckId,
          content: { layout: "title", title: "Hello", bg: "accent", shapes: [] },
          speakerNotes: "Presenter note",
        },
        invokeContext,
      ),
    );

    const copied = output(
      await registry.invoke(
        "slides.deck.copy",
        { deckId, title: "Launch deck (Copy)", metadata: { createdFrom: "test.copy" } },
        invokeContext,
      ),
    );

    expect(copied.deck).toMatchObject({
      title: "Launch deck (Copy)",
      metadata: { createdFrom: "test.copy", copiedFromDeckId: deckId },
    });
    expect(copied.slides).toEqual([
      expect.objectContaining({
        deckId: (copied.deck as { readonly id: string }).id,
        content: expect.objectContaining({ title: "Hello" }),
        speakerNotes: "Presenter note",
      }),
    ]);
    expect((copied.slides as readonly { readonly id: string }[])[0]?.id).not.toBe(slide.id);
  });

  it("creates a deck, adds typed-layout slides, gets, and lists", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });

    const deck = output(
      await registry.invoke("slides.deck.create", { title: "Launch deck" }, invokeContext),
    );
    expect(deck.title).toBe("Launch deck");
    const deckId = deck.id as string;

    const title = output(
      await registry.invoke(
        "slides.slide.create",
        {
          deckId,
          content: {
            layout: "title",
            title: "Hello",
            bg: "accent",
            transition: { type: "slide", direction: "right", durationMs: 480 },
            shapes: [
              {
                id: "shape-1",
                kind: "text",
                x: 12,
                y: 16,
                width: 34,
                height: 12,
                text: "Launch",
                tone: "light",
                animation: { type: "fade", order: 1, durationMs: 900, easing: "easeInOut" },
                exitAnimation: { type: "zoom", order: 2, durationMs: 480, easing: "easeIn" },
              },
              {
                id: "shape-2",
                kind: "connector",
                x: 46,
                y: 34,
                width: 24,
                height: 18,
                tone: "dark",
                connectorDirection: "down",
                connectorArrow: "both",
              },
              {
                id: "shape-3",
                kind: "image",
                x: 54,
                y: 18,
                width: 28,
                height: 24,
                text: "",
                tone: "accent",
                imageUrl: "https://example.test/launch.png",
                imageAlt: "Launch mockup",
                imageFit: "contain",
                imageMask: "circle",
              },
              {
                id: "shape-4",
                kind: "media",
                x: 12,
                y: 62,
                width: 44,
                height: 24,
                text: "",
                tone: "dark",
                mediaUrl: "https://example.test/launch-demo.mp4",
                mediaType: "video",
                mediaTitle: "Launch demo",
                mediaPosterUrl: "https://example.test/launch-poster.png",
                mediaCaptionUrl: "https://example.test/launch-captions.vtt",
                mediaCaptionLabel: "English captions",
                mediaStartSeconds: 4,
                mediaEndSeconds: 24,
                mediaAutoplay: true,
                mediaLoop: true,
                mediaMuted: true,
              },
            ],
          },
          speakerNotes: "warm welcome",
        },
        invokeContext,
      ),
    );
    expect(title.layout).toBe("title");
    expect(title.position).toBe(0);
    expect((title.content as ToolOutput).transition).toEqual({
      type: "slide",
      direction: "right",
      durationMs: 480,
    });
    expect((title.content as ToolOutput).shapes).toEqual([
      {
        id: "shape-1",
        kind: "text",
        x: 12,
        y: 16,
        width: 34,
        height: 12,
        text: "Launch",
        tone: "light",
        animation: { type: "fade", order: 1, durationMs: 900, easing: "easeInOut" },
        exitAnimation: { type: "zoom", order: 2, durationMs: 480, easing: "easeIn" },
      },
      {
        id: "shape-2",
        kind: "connector",
        x: 46,
        y: 34,
        width: 24,
        height: 18,
        tone: "dark",
        connectorDirection: "down",
        connectorArrow: "both",
      },
      {
        id: "shape-3",
        kind: "image",
        x: 54,
        y: 18,
        width: 28,
        height: 24,
        text: "",
        tone: "accent",
        imageUrl: "https://example.test/launch.png",
        imageAlt: "Launch mockup",
        imageFit: "contain",
        imageMask: "circle",
      },
      {
        id: "shape-4",
        kind: "media",
        x: 12,
        y: 62,
        width: 44,
        height: 24,
        text: "",
        tone: "dark",
        mediaUrl: "https://example.test/launch-demo.mp4",
        mediaType: "video",
        mediaTitle: "Launch demo",
        mediaPosterUrl: "https://example.test/launch-poster.png",
        mediaCaptionUrl: "https://example.test/launch-captions.vtt",
        mediaCaptionLabel: "English captions",
        mediaStartSeconds: 4,
        mediaEndSeconds: 24,
        mediaAutoplay: true,
        mediaLoop: true,
        mediaMuted: true,
      },
    ]);

    await registry.invoke(
      "slides.slide.create",
      {
        deckId,
        content: { layout: "stats", title: "Numbers", stats: [{ value: "9", label: "x" }] },
      },
      invokeContext,
    );

    const fetched = output(await registry.invoke("slides.deck.get", { deckId }, invokeContext));
    expect((fetched.slides as unknown[]).length).toBe(2);
    expect((fetched.deck as ToolOutput).slideCount).toBe(2);

    const listed = output(await registry.invoke("slides.deck.list", {}, invokeContext));
    expect(listed.total).toBe(1);
  });

  it("exports a native deck as a PPTX payload", async () => {
    const registry = createToolRegistry();
    const driveStore = new FakeDriveCommentReader();
    registerSlides(registry, { store: new InMemorySlidesStore(), driveStore });

    const deckId = output(
      await registry.invoke("slides.deck.create", { title: "Board narrative" }, invokeContext),
    ).id as string;
    const strategySlide = output(
      await registry.invoke(
        "slides.slide.create",
        {
          deckId,
          content: {
            layout: "split",
            title: "Strategy",
            left: "Focus on the native editor surface.",
            rightKind: "list",
            rightContent: ["Slides export", "Shape fidelity"],
            shapes: [
              {
                id: "shape-1",
                kind: "rectangle",
                x: 62,
                y: 18,
                width: 22,
                height: 14,
                text: "Native",
                tone: "accent",
              },
            ],
          },
          speakerNotes: "Export speaker context.",
        },
        invokeContext,
      ),
    );
    const appendixSlide = output(
      await registry.invoke(
        "slides.slide.create",
        {
          deckId,
          content: {
            layout: "bullets",
            title: "Appendix",
            items: ["Follow-up"],
          },
        },
        invokeContext,
      ),
    );
    const strategySlideId = strategySlide.id as string;
    const appendixSlideId = appendixSlide.id as string;
    driveStore.comments = [
      driveComment("77777777-7777-4777-8777-777777777777", {
        objectId: deckId,
        actorId,
        anchor: { kind: "slides-shape", slideId: strategySlideId, shapeLabel: "Native" },
        body: "Tighten this claim.",
        status: "open",
        author: { id: actorId, displayName: "Avery Reviewer", email: "avery@example.com" },
      }),
      driveComment("88888888-8888-4888-8888-888888888888", {
        objectId: deckId,
        parentCommentId: "77777777-7777-4777-8777-777777777777",
        actorId: "99999999-9999-4999-8999-999999999999",
        anchor: { kind: "slides-shape", slideId: strategySlideId, shapeLabel: "Native" },
        body: "Updated the wording.",
        status: "open",
        author: { id: "99999999-9999-4999-8999-999999999999", displayName: "Maya Chen" },
      }),
      driveComment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        objectId: deckId,
        actorId,
        anchor: { kind: "slides-slide", slideId: appendixSlideId },
        body: "Check appendix owner.",
        status: "resolved",
        author: { id: actorId, displayName: "Avery Reviewer", email: "avery@example.com" },
      }),
    ];

    const exported = output(
      await registry.invoke("slides.export", { deckId, format: "pptx" }, invokeContext),
    );

    expect(exported.deckId).toBe(deckId);
    expect(exported.format).toBe("pptx");
    expect(exported.filename).toBe("board-narrative.pptx");
    expect(exported.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(exported.byteSize).toBeGreaterThan(1_000);
    const pptx = Buffer.from(exported.contentBase64 as string, "base64");
    expect(pptx.subarray(0, 2).toString("utf8")).toBe("PK");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(pptx);
    const slide1Xml = (await zip.file("ppt/slides/slide1.xml")?.async("string")) ?? "";
    const slide2Xml = (await zip.file("ppt/slides/slide2.xml")?.async("string")) ?? "";
    expect(driveStore.listedComments).toEqual([
      { orgId, actorId, objectId: deckId, status: "all" },
    ]);
    expect(slide1Xml).toContain("Review comments:");
    expect(slide1Xml).toContain("[open] Avery Reviewer (Native): Tighten this claim.");
    expect(slide1Xml).toContain("Reply: Maya Chen: Updated the wording.");
    expect(slide1Xml).not.toContain("Check appendix owner.");
    expect(slide2Xml).toContain("[resolved] Avery Reviewer: Check appendix owner.");
    expect(slide2Xml).not.toContain("Tighten this claim.");
    expect(exported.metadata).toMatchObject({
      generatedBy: "helix.slides.export.pptx",
      slideCount: 2,
      commentCount: 3,
    });
  });

  it("imports a PPTX payload as native text-first slides", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const pptx = await pptxFixture({
      slides: [
        ["Board narrative", "Q2 strategy", "Customer proof"],
        ["Risks", "Migration scope", "Support readiness"],
      ],
      notes: ["Open with the customer outcome.", "Call out follow-up owners."],
    });

    const imported = output(
      await registry.invoke(
        "slides.import-pptx",
        {
          filename: "Board narrative.pptx",
          folderId: null,
          contentBase64: pptx.toString("base64"),
          metadata: { source: "test" },
        },
        invokeContext,
      ),
    );

    expect(imported.title).toBe("Board narrative");
    expect(imported.import).toMatchObject({
      sourceFormat: "pptx",
      slideCount: 2,
      fidelity: "first-pass-text",
    });
    const slides = imported.slides as ToolOutput[];
    expect(slides).toHaveLength(2);
    expect(slides[0]?.content).toMatchObject({
      layout: "bullets",
      title: "Board narrative",
      items: ["Q2 strategy", "Customer proof"],
    });
    expect(slides[0]?.speakerNotes).toBe("Open with the customer outcome.");
    expect(slides[1]?.content).toMatchObject({
      layout: "bullets",
      title: "Risks",
      items: ["Migration scope", "Support readiness"],
    });

    const deckId = imported.id as string;
    const fetched = output(await registry.invoke("slides.deck.get", { deckId }, invokeContext));
    expect((fetched.deck as ToolOutput).metadata).toMatchObject({
      originalFormat: "pptx",
      import: { slideCount: 2 },
    });
  });

  it("preserves PPTX-family source extensions during import", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const pptm = await pptxFixture({
      slides: [["Macro deck", "Revenue bridge"]],
    });

    const imported = output(
      await registry.invoke(
        "slides.import-pptx",
        {
          filename: "Macro deck.pptm",
          folderId: null,
          contentBase64: pptm.toString("base64"),
          metadata: { importedFromFormat: "pptm" },
        },
        invokeContext,
      ),
    );

    expect(imported.title).toBe("Macro deck");
    expect(imported.import).toMatchObject({
      sourceFormat: "pptm",
      slideCount: 1,
      fidelity: "first-pass-text",
    });

    const deckId = imported.id as string;
    const fetched = output(await registry.invoke("slides.deck.get", { deckId }, invokeContext));
    expect((fetched.deck as ToolOutput).metadata).toMatchObject({
      importedFromFormat: "pptm",
      originalFormat: "pptm",
      import: { sourceFormat: "pptm", slideCount: 1 },
    });
  });

  it("exports native PPTX connector lines and embedded data-uri image assets", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const pngDataUri =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    const deckId = output(
      await registry.invoke("slides.deck.create", { title: "Asset fidelity" }, invokeContext),
    ).id as string;
    await registry.invoke(
      "slides.slide.create",
      {
        deckId,
        content: {
          layout: "bullets",
          title: "Native assets",
          items: ["Export real shapes"],
          shapes: [
            {
              id: "connector-1",
              kind: "connector",
              x: 10,
              y: 20,
              width: 30,
              height: 20,
              tone: "dark",
              connectorDirection: "down",
              connectorArrow: "both",
            },
            {
              id: "image-1",
              kind: "image",
              x: 48,
              y: 18,
              width: 20,
              height: 22,
              tone: "accent",
              imageUrl: pngDataUri,
              imageAlt: "Embedded launch mockup",
              imageFit: "contain",
              imageMask: "rounded",
            },
            {
              id: "media-1",
              kind: "media",
              x: 70,
              y: 44,
              width: 20,
              height: 20,
              tone: "dark",
              mediaType: "video",
              mediaUrl: "https://example.test/demo.mp4",
              mediaTitle: "Demo poster",
              mediaPosterUrl: pngDataUri,
            },
          ],
        },
        speakerNotes: "",
      },
      invokeContext,
    );

    const exported = output(
      await registry.invoke("slides.export", { deckId, format: "pptx" }, invokeContext),
    );
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(Buffer.from(exported.contentBase64 as string, "base64"));
    const slideXml = (await zip.file("ppt/slides/slide1.xml")?.async("string")) ?? "";
    const slideRels = (await zip.file("ppt/slides/_rels/slide1.xml.rels")?.async("string")) ?? "";
    const mediaEntries = Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/"));

    expect(slideXml).toContain('prst="line"');
    expect(slideXml).toContain('<a:headEnd type="triangle"/>');
    expect(slideXml).toContain('<a:tailEnd type="triangle"/>');
    expect(slideXml).not.toContain("Connector");
    expect(slideXml).toContain("<p:pic>");
    expect(slideXml).toContain("Embedded launch mockup");
    expect(slideXml).toContain("Demo poster");
    expect(slideRels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image"',
    );
    expect(mediaEntries.length).toBeGreaterThanOrEqual(2);
  });

  it("exports a native deck as PDF and SVG image-series payloads", async () => {
    const registry = createToolRegistry();
    const driveStore = new FakeDriveCommentReader();
    registerSlides(registry, { store: new InMemorySlidesStore(), driveStore });

    const deckId = output(
      await registry.invoke("slides.deck.create", { title: "Launch review" }, invokeContext),
    ).id as string;
    const readoutSlide = output(
      await registry.invoke(
        "slides.slide.create",
        {
          deckId,
          content: {
            layout: "bullets",
            title: "Readout",
            items: ["Scope", "Risks", "Next steps"],
            shapes: [
              {
                id: "shape-1",
                kind: "text",
                x: 58,
                y: 22,
                width: 24,
                height: 14,
                text: "Export",
                tone: "light",
              },
              {
                id: "shape-2",
                kind: "image",
                x: 12,
                y: 18,
                width: 28,
                height: 24,
                imageUrl: "https://example.test/export.png",
                imageAlt: "Export mockup",
                imageFit: "cover",
                imageMask: "circle",
              },
            ],
          },
        },
        invokeContext,
      ),
    );
    const readoutSlideId = readoutSlide.id as string;
    driveStore.comments = [
      driveComment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
        objectId: deckId,
        actorId,
        anchor: { kind: "slides-slide", slideId: readoutSlideId },
        body: "Carry this review note into exported files.",
        status: "open",
        author: { id: actorId, displayName: "Avery Reviewer" },
      }),
    ];

    const pdf = output(
      await registry.invoke("slides.export", { deckId, format: "pdf" }, invokeContext),
    );
    expect(pdf.deckId).toBe(deckId);
    expect(pdf.format).toBe("pdf");
    expect(pdf.filename).toBe("launch-review.pdf");
    expect(pdf.mimeType).toBe("application/pdf");
    expect(
      Buffer.from(pdf.contentBase64 as string, "base64")
        .subarray(0, 4)
        .toString("utf8"),
    ).toBe("%PDF");
    expect(Buffer.from(pdf.contentBase64 as string, "base64").toString("latin1")).toContain(
      "Carry this review note into exported files.",
    );
    expect(pdf.metadata).toMatchObject({
      generatedBy: "helix.slides.export.pdf",
      slideCount: 1,
      commentCount: 1,
    });

    const images = output(
      await registry.invoke("slides.export", { deckId, format: "svg-series" }, invokeContext),
    );
    expect(images.deckId).toBe(deckId);
    expect(images.format).toBe("svg-series");
    expect(images.filename).toBe("launch-review-svg-series.zip");
    expect(images.mimeType).toBe("application/zip");
    const zip = Buffer.from(images.contentBase64 as string, "base64");
    expect(zip.subarray(0, 2).toString("utf8")).toBe("PK");
    expect(zip.toString("utf8")).toContain("slide-001.svg");
    expect(zip.toString("utf8")).toContain("manifest.json");
    expect(zip.toString("utf8")).toContain("clipPath");
    expect(zip.toString("utf8")).toContain("image-mask-shape-2");
    expect(zip.toString("utf8")).toContain("Carry this review note into exported files.");
    expect(zip.toString("utf8")).toContain('"commentCount": 1');
    expect(images.metadata).toMatchObject({
      generatedBy: "helix.slides.export.svg-series",
      slideCount: 1,
      commentCount: 1,
      imageFormat: "svg",
    });
  });

  it("updates and reorders slides, then deletes a slide and the deck", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const deckId = output(
      await registry.invoke(
        "slides.deck.create",
        { title: "Deck", metadata: { audience: "board" } },
        invokeContext,
      ),
    ).id as string;

    const renamedDeck = output(
      await registry.invoke("slides.deck.update", { deckId, title: "Deck v2" }, invokeContext),
    );
    expect(renamedDeck.title).toBe("Deck v2");
    expect(renamedDeck.metadata).toMatchObject({ audience: "board" });

    const themedDeck = output(
      await registry.invoke(
        "slides.deck.update",
        { deckId, metadata: { audience: "board", theme: "meadow" } },
        invokeContext,
      ),
    );
    expect(themedDeck.metadata).toEqual({ audience: "board", theme: "meadow" });

    const a = output(
      await registry.invoke(
        "slides.slide.create",
        { deckId, content: { layout: "agenda", title: "Agenda", items: ["A"] } },
        invokeContext,
      ),
    ).id as string;
    const b = output(
      await registry.invoke(
        "slides.slide.create",
        { deckId, content: { layout: "bullets", title: "Bullets", items: ["B"] } },
        invokeContext,
      ),
    ).id as string;

    const updated = output(
      await registry.invoke(
        "slides.slide.update",
        { slideId: a, speakerNotes: "revised" },
        invokeContext,
      ),
    );
    expect(updated.speakerNotes).toBe("revised");

    const reordered = output(
      await registry.invoke("slides.slide.reorder", { deckId, slideIds: [b, a] }, invokeContext),
    );
    expect((reordered.slides as ToolOutput[]).map((slide) => slide.id)).toEqual([b, a]);

    const deletedSlide = output(
      await registry.invoke("slides.slide.delete", { slideId: a }, invokeContext),
    );
    expect(deletedSlide.deleted).toBe(true);

    const deletedDeck = output(
      await registry.invoke("slides.deck.delete", { deckId }, invokeContext),
    );
    expect(deletedDeck.deleted).toBe(true);
  });

  it("rejects malformed layout content via the discriminated-union schema", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const deckId = output(
      await registry.invoke("slides.deck.create", { title: "Deck" }, invokeContext),
    ).id as string;

    // `stats` layout requires a `stats` array; supplying `items` is invalid.
    const result = await registry.invoke(
      "slides.slide.create",
      { deckId, content: { layout: "stats", title: "Bad", items: ["x"] } },
      invokeContext,
    );
    expect(result.ok).toBe(false);

    const invalidTrim = await registry.invoke(
      "slides.slide.create",
      {
        deckId,
        content: {
          layout: "bullets",
          title: "Bad media",
          items: ["x"],
          shapes: [
            {
              id: "shape-1",
              kind: "media",
              x: 10,
              y: 10,
              width: 30,
              height: 20,
              mediaUrl: "https://example.test/video.mp4",
              mediaType: "video",
              mediaStartSeconds: 20,
              mediaEndSeconds: 10,
            },
          ],
        },
      },
      invokeContext,
    );
    expect(invalidTrim.ok).toBe(false);

    const invalidExitAnimation = await registry.invoke(
      "slides.slide.create",
      {
        deckId,
        content: {
          layout: "bullets",
          title: "Bad exit animation",
          items: ["x"],
          shapes: [
            {
              id: "shape-1",
              kind: "text",
              x: 10,
              y: 10,
              width: 30,
              height: 20,
              text: "Leaving",
              exitAnimation: { type: "fly", motionPath: "diagonal" },
            },
          ],
        },
      },
      invokeContext,
    );
    expect(invalidExitAnimation.ok).toBe(false);
  });

  it("fails to get an unknown deck", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const result = await registry.invoke(
      "slides.deck.get",
      { deckId: "33333333-3333-4333-8333-333333333333" },
      invokeContext,
    );
    expect(result.ok).toBe(false);
  });

  it("denies callers lacking slides scopes", async () => {
    const registry = createToolRegistry();
    registerSlides(registry, { store: new InMemorySlidesStore() });
    const result = await registry.invoke(
      "slides.deck.create",
      { title: "Deck" },
      { actor: { id: actorId, orgId, type: "user" as const, scopes: ["docs.read"] } },
    );
    expect(result.ok).toBe(false);
  });
});
