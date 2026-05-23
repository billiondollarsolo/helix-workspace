/* SlidesShell — the Slides surface entry point.
   Holds the selected deck id and switches between the list and editor views,
   wrapped in the shared SurfaceFrame chrome. */

import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { SlidesList } from "./slides-list";

export interface SlidesShellProps {
  /** Open straight into the editor for this deck id (used by Drive). */
  readonly initialDeckId?: string;
}

export function SlidesShell({ initialDeckId }: SlidesShellProps = {}) {
  const [deckId, setDeckId] = useState<string | null>(initialDeckId ?? null);
  const [search, setSearch] = useState("");
  const router = useRouter();

  useEffect(() => {
    if (initialDeckId !== undefined) {
      setDeckId(initialDeckId);
    }
  }, [initialDeckId]);

  // Phase 5 of the OnlyOffice migration: opening a deck now navigates to
  // the OnlyOffice editor (`/edit/:objectId`). The legacy in-page
  // SlidesEditor is no longer rendered.
  useEffect(() => {
    if (deckId !== null) {
      void router.navigate({ to: "/edit/$objectId", params: { objectId: deckId } });
      setDeckId(null);
    }
  }, [deckId, router]);

  return (
    <SurfaceFrame
      title="Slides"
      icon={<Icons.Image />}
      searchPlaceholder="Search presentations"
      searchValue={search}
      onSearchChange={setSearch}
    >
      <SlidesList onOpen={setDeckId} query={search} />
    </SurfaceFrame>
  );
}
