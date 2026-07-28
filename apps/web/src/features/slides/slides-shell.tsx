/* SlidesShell — the Slides surface entry point.
   Holds the selected deck id and switches between the list and editor views,
   wrapped in the shared SurfaceFrame chrome. */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { useEditorsAlpha } from "@/features/apps/editors-alpha";
import {
  NativePresentationEditor,
  type NativePresentationEditorRouteState,
} from "./native-presentation-editor";
import { slidesDeckDetailQueryOptions } from "./queries";
import { SlidesList } from "./slides-list";
import type { SlideDeck } from "./seed";
import { UniversalEditorRouter } from "@/features/_open/ui/UniversalEditorRouter";

export interface SlidesViewRouteState {
  readonly deckId: string | null;
  readonly commentId: string | null;
  readonly openMode: SlideDeck["openMode"] | null;
  readonly searchQuery: string;
}

export interface SlidesShellProps {
  /** Open straight into the editor for this deck id (used by Drive). */
  readonly initialDeckId?: string;
  readonly initialSearchQuery?: string;
  readonly routeState?: SlidesViewRouteState;
  readonly onRouteStateChange?: (state: SlidesViewRouteState) => void;
  readonly onSearchQueryChange?: (query: string) => void;
}

export function SlidesShell({
  initialDeckId,
  initialSearchQuery = "",
  routeState,
  onRouteStateChange,
  onSearchQueryChange,
}: SlidesShellProps = {}) {
  const [deckId, setDeckId] = useState<string | null>(routeState?.deckId ?? initialDeckId ?? null);
  const [deckOpenMode, setDeckOpenMode] = useState<SlideDeck["openMode"] | null>(
    routeState?.openMode ?? null,
  );
  const [search, setSearch] = useState(routeState?.searchQuery ?? initialSearchQuery);
  const routeDeckId = routeState?.deckId;
  const routeCommentId = routeState?.commentId ?? null;
  const routeOpenMode = routeState?.openMode ?? null;
  const routeSearchQuery = routeState?.searchQuery;
  const editorsAlpha = useEditorsAlpha();

  useEffect(() => {
    if (initialDeckId !== undefined) {
      setDeckId(initialDeckId);
    }
  }, [initialDeckId]);

  useEffect(() => {
    if (routeDeckId !== undefined) {
      setDeckId(routeDeckId);
      setDeckOpenMode(routeOpenMode);
    }
  }, [routeDeckId, routeOpenMode]);

  useEffect(() => {
    if (routeSearchQuery !== undefined) {
      setSearch(routeSearchQuery);
      return;
    }
    setSearch(initialSearchQuery);
  }, [initialSearchQuery, routeSearchQuery]);

  function handleOpenDeck(deck: Pick<SlideDeck, "id" | "openMode">) {
    setDeckId(deck.id);
    setDeckOpenMode(deck.openMode ?? null);
    onRouteStateChange?.({
      deckId: deck.id,
      commentId: null,
      openMode: deck.openMode ?? null,
      searchQuery: search,
    });
  }

  function handleBackToList() {
    setDeckId(null);
    setDeckOpenMode(null);
    onRouteStateChange?.({ deckId: null, commentId: null, openMode: null, searchQuery: search });
  }

  function handleEditorRouteStateChange(nextState: NativePresentationEditorRouteState) {
    onRouteStateChange?.({
      deckId,
      commentId: nextState.commentId,
      openMode: deckOpenMode,
      searchQuery: search,
    });
  }

  function handleSearchChange(nextSearch: string) {
    setSearch(nextSearch);
    onSearchQueryChange?.(nextSearch);
  }

  if (deckId !== null) {
    return (
      <SurfaceFrame
        title="Slides"
        icon={<Icons.Image />}
        searchPlaceholder="Search presentations"
        searchValue={search}
        onSearchChange={handleSearchChange}
      >
        <SlidesEditorSurface
          deckId={deckId}
          openMode={deckOpenMode}
          editorsEnabled={editorsAlpha.enabled}
          routeCommentId={routeCommentId}
          handleOpenDeck={(nextDeckId) => handleOpenDeck({ id: nextDeckId, openMode: "native" })}
          handleEditorRouteStateChange={handleEditorRouteStateChange}
          handleBackToList={handleBackToList}
        />
      </SurfaceFrame>
    );
  }

  return (
    <SurfaceFrame
      title="Slides"
      icon={<Icons.Image />}
      searchPlaceholder="Search presentations"
      searchValue={search}
      onSearchChange={handleSearchChange}
    >
      <SlidesList onOpen={handleOpenDeck} query={search} editorsEnabled={editorsAlpha.enabled} />
    </SurfaceFrame>
  );
}

/** Routes a deck id either to the native presentation editor (when
 *  slides.get returns a native deck) or to the universal-loader fallback
 *  (when the id refers to a raw .pptx / .odp Drive upload). */
function SlidesEditorSurface({
  deckId,
  openMode,
  editorsEnabled,
  routeCommentId,
  handleOpenDeck,
  handleEditorRouteStateChange,
  handleBackToList,
}: {
  readonly deckId: string;
  readonly openMode: SlideDeck["openMode"] | null;
  readonly editorsEnabled: boolean;
  readonly routeCommentId: string | null;
  readonly handleOpenDeck: (deckId: string) => void;
  readonly handleEditorRouteStateChange: (s: NativePresentationEditorRouteState) => void;
  readonly handleBackToList: () => void;
}) {
  const shouldTryNative = openMode !== "office" && editorsEnabled;
  const nativeQuery = useQuery(slidesDeckDetailQueryOptions(deckId, { enabled: shouldTryNative }));
  const nativeFetch = shouldTryNative
    ? nativeQuery
    : { isLoading: false, isError: false, isSuccess: true, data: null };
  return (
    <UniversalEditorRouter
      objectId={deckId}
      surface="slides"
      nativeEditingEnabled={editorsEnabled}
      nativeFetch={nativeFetch}
      renderNative={() => (
        <NativePresentationEditor
          deckId={deckId}
          routeState={{ commentId: routeCommentId }}
          onRouteStateChange={handleEditorRouteStateChange}
          onBack={handleBackToList}
          onOpenDeck={handleOpenDeck}
        />
      )}
    />
  );
}
