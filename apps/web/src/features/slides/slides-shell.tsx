/* SlidesShell — the Slides surface entry point.
   Holds the selected deck id and switches between the list and editor views,
   wrapped in the shared SurfaceFrame chrome. */

import { useEffect, useState } from "react";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { SlidesList } from "./slides-list";
import { SlidesEditor } from "./slides-editor";

export interface SlidesShellProps {
  /** Open straight into the editor for this deck id (used by Drive). */
  readonly initialDeckId?: string;
}

export function SlidesShell({ initialDeckId }: SlidesShellProps = {}) {
  const [deckId, setDeckId] = useState<string | null>(initialDeckId ?? null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (initialDeckId !== undefined) {
      setDeckId(initialDeckId);
    }
  }, [initialDeckId]);

  return (
    <SurfaceFrame
      title="Slides"
      icon={<Icons.Image />}
      searchPlaceholder="Search presentations"
      searchValue={deckId ? undefined : search}
      onSearchChange={deckId ? undefined : setSearch}
    >
      {deckId ? (
        <SlidesEditor deckId={deckId} onBack={() => setDeckId(null)} />
      ) : (
        <SlidesList onOpen={setDeckId} query={search} />
      )}
    </SurfaceFrame>
  );
}
