/* SlidesEditor — the Slides surface editor view.
   Toolbar + deck title row + 190px thumbnail strip + centered 16:9 canvas +
   toggleable speaker-notes panel. Ported from the handoff (app-slides.jsx),
   wired to the Slides backend (`slides.deck.get` + `slides.slide.*`).

   A backend deck (UUID id) loads its slides live; layout changes, content
   edits, speaker notes, slide create / delete and thumbnail reordering all
   persist through the slide tools and invalidate the deck-detail query. A
   seed deck id (e.g. `s1`) renders the typed handoff seed read-only. */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar } from "@/components/ui/avatar";
import { Icons } from "@/components/icons";
import {
  createSlidesSlide,
  deleteSlidesSlide,
  reorderSlidesSlides,
  updateSlidesDeck,
  updateSlidesSlide,
  type SlidesApiSlide,
} from "./api";
import { slideFromApi } from "./mapping";
import {
  isBackendSlidesDeckId,
  slidesDeckDetailQueryOptions,
  slidesQueryKeys,
} from "./queries";
import { Slide } from "./slide-canvas";
import { SlideThumb } from "./slide-thumb";
import {
  DECKS,
  SLIDES,
  SLIDE_LAYOUT_OPTIONS,
  SPEAKER_NOTES,
  emptySlideContent,
  slideToContent,
  type SlideContent,
  type SlideDeck,
  type SlideLayout,
} from "./seed";

interface SlidesEditorProps {
  /** Id of the deck being edited (a backend UUID or a seed id like `s1`). */
  readonly deckId: string;
  /** Return to the list view. */
  readonly onBack: () => void;
}

const COLLABORATORS = ["Mira Okafor", "Owen Hart"] as const;

/** Stable fallback when a deck id is not present in the seed. */
const FALLBACK_DECK: SlideDeck = DECKS[0] ?? {
  id: "deck",
  title: "Untitled deck",
  owner: "Alex Park",
  modified: "just now",
  slides: SLIDES.length,
  shared: 0,
};

const dividerStyle = {
  width: 1,
  height: 18,
  margin: "0 4px",
  background: "var(--border)",
} as const;

const addSlideButtonStyle: CSSProperties = {
  width: "100%",
  padding: "8px 0",
  marginTop: 4,
  border: "1px dashed var(--border-2)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--text-3)",
  fontSize: 11,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  cursor: "pointer",
};

/** Replace the layout of a content body, preserving the shared `title`. */
function recastContent(content: SlideContent, layout: SlideLayout): SlideContent {
  if (content.layout === layout) {
    return content;
  }
  const fresh = emptySlideContent(layout);
  return { ...fresh, title: content.title };
}

export function SlidesEditor({ deckId, onBack }: SlidesEditorProps) {
  const queryClient = useQueryClient();
  const isBackend = isBackendSlidesDeckId(deckId);
  const deckQuery = useQuery(slidesDeckDetailQueryOptions(deckId));

  const [current, setCurrent] = useState(0);
  const [showNotes, setShowNotes] = useState(true);
  /** Local speaker-notes draft, keyed by slide id; flushed to the backend on blur. */
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  /** Last failed slide mutation, surfaced as an inline alert. */
  const [actionError, setActionError] = useState<string | null>(null);

  const clearError = () => setActionError(null);

  const seedDeck = useMemo<SlideDeck>(
    () => DECKS.find((entry) => entry.id === deckId) ?? FALLBACK_DECK,
    [deckId],
  );

  const backendSlides = deckQuery.data?.slides;
  const deckTitle = isBackend ? (deckQuery.data?.deck.title ?? "Untitled deck") : seedDeck.title;

  /** The renderable slide list — live backend rows, or the seed fallback. */
  const slides = useMemo(() => {
    if (isBackend) {
      return (backendSlides ?? []).map(slideFromApi);
    }
    return SLIDES;
  }, [isBackend, backendSlides]);

  // Keep the selected index inside bounds as slides are added / removed.
  useEffect(() => {
    setCurrent((index) => {
      if (slides.length === 0) {
        return 0;
      }
      return Math.min(index, slides.length - 1);
    });
  }, [slides.length]);

  const slide = slides[current] ?? slides[0];

  const renameMutation = useMutation({
    mutationFn: (title: string) => updateSlidesDeck({ deckId, title }),
    onMutate: clearError,
    onError: () => setActionError("Could not rename this deck. Please try again."),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckDetail(deckId) }),
        queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckLists }),
      ]);
    },
  });

  const createSlideMutation = useMutation({
    mutationFn: (input: { readonly content: SlideContent; readonly position?: number }) =>
      createSlidesSlide({ deckId, content: input.content, ...(input.position === undefined ? {} : { position: input.position }) }),
    onMutate: clearError,
    onError: () => setActionError("Could not add a slide. Please try again."),
    onSuccess: async () => {
      await invalidateDeck();
    },
  });

  const updateSlideMutation = useMutation({
    mutationFn: (input: {
      readonly slideId: string;
      readonly content?: SlideContent;
      readonly speakerNotes?: string;
    }) => updateSlidesSlide(input),
    onMutate: clearError,
    onError: () => setActionError("A slide change could not be saved. Please try again."),
    onSuccess: async () => {
      await invalidateDeck();
    },
  });

  const deleteSlideMutation = useMutation({
    mutationFn: (slideId: string) => deleteSlidesSlide({ slideId }),
    onMutate: clearError,
    onError: () => setActionError("Could not delete that slide. Please try again."),
    onSuccess: async () => {
      await invalidateDeck();
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (slideIds: readonly string[]) => reorderSlidesSlides({ deckId, slideIds }),
    onMutate: clearError,
    onError: () => setActionError("Could not reorder slides. Please try again."),
    onSuccess: async () => {
      await invalidateDeck();
    },
  });

  async function invalidateDeck() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckDetail(deckId) }),
      queryClient.invalidateQueries({ queryKey: slidesQueryKeys.deckLists }),
    ]);
  }

  const mutating =
    createSlideMutation.isPending ||
    updateSlideMutation.isPending ||
    deleteSlideMutation.isPending ||
    reorderMutation.isPending;

  function handleLayoutChange(layout: SlideLayout) {
    if (!isBackend || slide === undefined || typeof slide.id !== "string") {
      return;
    }
    updateSlideMutation.mutate({
      slideId: slide.id,
      content: recastContent(slideToContent(slide), layout),
    });
  }

  function handleAddSlide() {
    if (!isBackend) {
      return;
    }
    createSlideMutation.mutate({ content: emptySlideContent("bullets") });
  }

  function handleDeleteSlide() {
    if (!isBackend || slide === undefined || typeof slide.id !== "string") {
      return;
    }
    deleteSlideMutation.mutate(slide.id);
  }

  function handleMove(from: number, direction: -1 | 1) {
    if (!isBackend || backendSlides === undefined) {
      return;
    }
    const to = from + direction;
    if (to < 0 || to >= backendSlides.length) {
      return;
    }
    const order = backendSlides.map((entry: SlidesApiSlide) => entry.id);
    const moved = order[from];
    if (moved === undefined) {
      return;
    }
    order.splice(from, 1);
    order.splice(to, 0, moved);
    setCurrent(to);
    reorderMutation.mutate(order);
  }

  function flushNotes(slideId: string) {
    const draft = noteDrafts[slideId];
    if (!isBackend || draft === undefined) {
      return;
    }
    const persisted =
      backendSlides?.find((entry: SlidesApiSlide) => entry.id === slideId)?.speakerNotes ?? "";
    if (draft !== persisted) {
      updateSlideMutation.mutate({ slideId, speakerNotes: draft });
    }
  }

  const persistedNote =
    slide !== undefined && typeof slide.id === "string"
      ? (backendSlides?.find((entry: SlidesApiSlide) => entry.id === slide.id)?.speakerNotes ?? "")
      : slide !== undefined && typeof slide.id === "number"
        ? (SPEAKER_NOTES[slide.id] ?? "")
        : "";
  const noteValue =
    slide !== undefined && typeof slide.id === "string"
      ? (noteDrafts[slide.id] ?? persistedNote)
      : persistedNote;

  const layoutValue: SlideLayout = slide?.layout ?? "title";

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        minWidth: 0,
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 4,
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          aria-label="Back to presentations"
        >
          <Icons.ArrowLeft />
        </button>
        <span style={dividerStyle} />
        <select
          aria-label="Slide layout"
          className="select"
          style={{ width: 110, height: 26, fontSize: 12 }}
          value={layoutValue}
          disabled={!isBackend || slide === undefined || mutating}
          onChange={(event) => handleLayoutChange(event.target.value as SlideLayout)}
        >
          {SLIDE_LAYOUT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" aria-label="Bold">
          <Icons.Bold />
        </button>
        <button type="button" className="icon-btn" aria-label="Italic">
          <Icons.Italic />
        </button>
        <button type="button" className="icon-btn" aria-label="Insert image">
          <Icons.Image />
        </button>
        <button type="button" className="icon-btn" aria-label="List">
          <Icons.List />
        </button>
        <button type="button" className="icon-btn" aria-label="Insert link">
          <Icons.Link />
        </button>
        <span style={dividerStyle} />
        <button
          type="button"
          className="icon-btn"
          aria-label="Delete slide"
          onClick={handleDeleteSlide}
          disabled={!isBackend || slide === undefined || slides.length === 0 || mutating}
        >
          <Icons.Trash />
        </button>
        <button type="button" className="btn sm">
          <Icons.Sparkles /> AI design
        </button>
        <span
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span style={{ display: "flex", marginRight: 8 }}>
            {COLLABORATORS.map((person, index) => (
              <span
                key={person}
                style={{
                  marginLeft: index === 0 ? 0 : -6,
                  border: "2px solid var(--surface)",
                  borderRadius: 999,
                }}
              >
                <Avatar name={person} size={22} />
              </span>
            ))}
          </span>
          <button
            type="button"
            className="btn sm"
            onClick={() => setShowNotes((value) => !value)}
            aria-pressed={showNotes}
          >
            <Icons.Doc /> Notes
          </button>
          <button type="button" className="btn sm">
            <Icons.Video /> Present
          </button>
          <button type="button" className="btn sm primary">
            <Icons.Users /> Share
          </button>
        </span>
      </div>

      {/* Deck title */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        <Icons.Image />
        {isBackend ? (
          <input
            aria-label="Deck title"
            defaultValue={deckTitle}
            key={deckTitle}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next.length > 0 && next !== deckTitle) {
                renameMutation.mutate(next);
              }
            }}
            style={{
              fontSize: 13,
              fontWeight: 600,
              border: "1px solid transparent",
              background: "transparent",
              color: "var(--text)",
              padding: "2px 4px",
              borderRadius: 4,
              minWidth: 0,
              font: "inherit",
            }}
          />
        ) : (
          <span style={{ fontSize: 13, fontWeight: 600 }}>{deckTitle}</span>
        )}
        <span className="chip">{mutating ? "Saving…" : "Saved"}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-3)" }}>
          {slides.length === 0
            ? "No slides"
            : `Slide ${String(current + 1)} of ${String(slides.length)}`}
        </span>
      </div>

      {actionError !== null ? (
        <div
          role="alert"
          style={{
            padding: "6px 16px",
            fontSize: 12,
            color: "var(--danger)",
            background: "var(--danger-soft)",
          }}
        >
          {actionError}
        </div>
      ) : null}

      {/* Body */}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Thumbnail strip */}
        <aside
          style={{
            width: 190,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            background: "var(--surface)",
            overflowY: "auto",
            padding: 6,
          }}
          aria-label="Slide thumbnails"
        >
          {isBackend && deckQuery.isPending ? (
            <div style={{ padding: 12, fontSize: 11, color: "var(--text-3)" }}>
              Loading slides…
            </div>
          ) : null}
          {isBackend && deckQuery.isError ? (
            <div style={{ padding: 12, fontSize: 11, color: "var(--danger)" }}>
              Could not load this deck.
            </div>
          ) : null}
          {!deckQuery.isPending && slides.length === 0 ? (
            <div style={{ padding: 12, fontSize: 11, color: "var(--text-3)" }}>
              This deck has no slides yet.
            </div>
          ) : null}
          {slides.map((entry, index) => (
            <SlideThumb
              key={entry.id}
              slide={entry}
              index={index}
              active={index === current}
              onSelect={() => setCurrent(index)}
              {...(isBackend
                ? {
                    onMoveUp: index > 0 ? () => handleMove(index, -1) : undefined,
                    onMoveDown:
                      index < slides.length - 1 ? () => handleMove(index, 1) : undefined,
                  }
                : {})}
            />
          ))}
          {isBackend ? (
            <button
              type="button"
              style={addSlideButtonStyle}
              onClick={handleAddSlide}
              disabled={mutating}
            >
              <Icons.Plus /> {createSlideMutation.isPending ? "Adding…" : "Add slide"}
            </button>
          ) : null}
        </aside>

        {/* Canvas + notes */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: "var(--bg)",
          }}
        >
          <div
            style={{
              flex: 1,
              padding: 24,
              display: "grid",
              placeItems: "center",
              overflow: "auto",
            }}
          >
            {slide ? (
              <div
                style={{
                  width: "100%",
                  maxWidth: 960,
                  aspectRatio: "16 / 9",
                  boxShadow: "var(--shadow-md)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  overflow: "hidden",
                }}
              >
                <Slide slide={slide} />
              </div>
            ) : (
              <div style={{ color: "var(--text-3)", fontSize: 13 }}>
                {isBackend
                  ? "Add a slide to start building this deck."
                  : "No slides in this deck."}
              </div>
            )}
          </div>
          {showNotes ? (
            <div
              style={{
                borderTop: "1px solid var(--border)",
                background: "var(--surface)",
                padding: "10px 16px",
                flexShrink: 0,
                maxHeight: 120,
              }}
            >
              <label
                htmlFor="slide-speaker-notes"
                style={{
                  display: "block",
                  fontSize: 10,
                  fontWeight: 600,
                  color: "var(--text-3)",
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                  marginBottom: 6,
                }}
              >
                Speaker notes
              </label>
              <textarea
                id="slide-speaker-notes"
                placeholder="Add speaker notes for this slide…"
                value={noteValue}
                disabled={slide === undefined || (!isBackend && typeof slide.id === "number")}
                onChange={(event) => {
                  if (slide !== undefined && typeof slide.id === "string") {
                    const { value } = event.target;
                    setNoteDrafts((prev) => ({ ...prev, [slide.id as string]: value }));
                  }
                }}
                onBlur={() => {
                  if (slide !== undefined && typeof slide.id === "string") {
                    flushNotes(slide.id);
                  }
                }}
                style={{
                  width: "100%",
                  height: 60,
                  fontSize: 12,
                  lineHeight: 1.5,
                  border: "none",
                  background: "transparent",
                  outline: "none",
                  resize: "none",
                  fontFamily: "inherit",
                  color: "var(--text)",
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
