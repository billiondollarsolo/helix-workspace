import { useCallback, useState } from "react";
import { Icons } from "@/components/icons";

export type DocumentSurfaceView = "grid" | "list";

const STORAGE_KEY = "helix.documentSurface.view";

function isDocumentSurfaceView(value: string | null): value is DocumentSurfaceView {
  return value === "grid" || value === "list";
}

function readStoredView(defaultView: DocumentSurfaceView): DocumentSurfaceView {
  if (typeof window === "undefined") {
    return defaultView;
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isDocumentSurfaceView(stored) ? stored : defaultView;
  } catch {
    return defaultView;
  }
}

function storeView(view: DocumentSurfaceView): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, view);
  } catch {
    // Preference persistence is best-effort.
  }
}

export function useDocumentSurfaceViewPreference(
  defaultView: DocumentSurfaceView = "grid",
): readonly [DocumentSurfaceView, (view: DocumentSurfaceView) => void] {
  const [view, setViewState] = useState<DocumentSurfaceView>(() => readStoredView(defaultView));

  const setView = useCallback((next: DocumentSurfaceView) => {
    setViewState(next);
    storeView(next);
  }, []);

  return [view, setView] as const;
}

export function DocumentSurfaceViewToggle({
  view,
  onViewChange,
}: {
  readonly view: DocumentSurfaceView;
  readonly onViewChange: (view: DocumentSurfaceView) => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Card view"
        aria-pressed={view === "grid"}
        className={`btn sm ${view === "grid" ? "primary" : ""}`}
        onClick={() => onViewChange("grid")}
      >
        <Icons.Grid />
      </button>
      <button
        type="button"
        aria-label="List view"
        aria-pressed={view === "list"}
        className={`btn sm ${view === "list" ? "primary" : ""}`}
        onClick={() => onViewChange("list")}
      >
        <Icons.List />
      </button>
    </>
  );
}
