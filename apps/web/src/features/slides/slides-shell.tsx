/* SlidesShell — the Slides surface entry point.
   Holds the selected deck id and switches between the list and editor views,
   wrapped in the shared SurfaceFrame chrome. */

import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import {
  NativePresentationEditor,
  type NativePresentationEditorRouteState,
} from "./native-presentation-editor";
import { SlidesList } from "./slides-list";
import type { SlideDeck } from "./seed";

export interface SlidesViewRouteState {
  readonly deckId: string | null;
  readonly commentId: string | null;
}

export interface SlidesShellProps {
  /** Open straight into the editor for this deck id (used by Drive). */
  readonly initialDeckId?: string;
  readonly routeState?: SlidesViewRouteState;
  readonly onRouteStateChange?: (state: SlidesViewRouteState) => void;
}

export function SlidesShell({
  initialDeckId,
  routeState,
  onRouteStateChange,
}: SlidesShellProps = {}) {
  const [deckId, setDeckId] = useState<string | null>(routeState?.deckId ?? initialDeckId ?? null);
  const [search, setSearch] = useState("");
  const router = useRouter();
  const routeDeckId = routeState?.deckId;
  const routeCommentId = routeState?.commentId ?? null;

  useEffect(() => {
    if (initialDeckId !== undefined) {
      setDeckId(initialDeckId);
    }
  }, [initialDeckId]);

  useEffect(() => {
    if (routeDeckId !== undefined) {
      setDeckId(routeDeckId);
    }
  }, [routeDeckId]);

  function handleOpenDeck(deck: Pick<SlideDeck, "id" | "openMode">) {
    if (deck.openMode === "office") {
      void router.navigate({ to: "/edit/$objectId", params: { objectId: deck.id } });
      return;
    }
    setDeckId(deck.id);
    onRouteStateChange?.({ deckId: deck.id, commentId: null });
  }

  function handleBackToList() {
    setDeckId(null);
    onRouteStateChange?.({ deckId: null, commentId: null });
  }

  function handleEditorRouteStateChange(nextState: NativePresentationEditorRouteState) {
    onRouteStateChange?.({ deckId, commentId: nextState.commentId });
  }

  if (deckId !== null) {
    return (
      <SurfaceFrame
        title="Slides"
        icon={<Icons.Image />}
        searchPlaceholder="Search presentations"
        searchValue={search}
        onSearchChange={setSearch}
      >
        <NativePresentationEditor
          deckId={deckId}
          routeState={{ commentId: routeCommentId }}
          onRouteStateChange={handleEditorRouteStateChange}
          onBack={handleBackToList}
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
      onSearchChange={setSearch}
    >
      <SlidesList onOpen={handleOpenDeck} query={search} />
    </SurfaceFrame>
  );
}
