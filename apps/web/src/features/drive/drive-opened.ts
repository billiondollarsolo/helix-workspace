/* "Last opened by me" for the Drive sort menu. Drive has no server-side open
   history, so this browser remembers when the viewer opened, downloaded or
   inspected an item. It is a per-viewer convenience: losing it only changes
   that one sort order. */
import { useCallback, useState } from "react";

const STORAGE_PREFIX = "helix.drive.opened.v1:";
const MAX_ENTRIES = 500;

function storageKey(actorId: string | null): string {
  return `${STORAGE_PREFIX}${actorId ?? "anonymous"}`;
}

function readDriveOpenedAt(actorId: string | null): Map<string, number> {
  try {
    const raw = globalThis.localStorage.getItem(storageKey(actorId));
    if (raw === null) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number",
      ),
    );
  } catch {
    return new Map();
  }
}

function writeDriveOpenedAt(actorId: string | null, openedAt: ReadonlyMap<string, number>) {
  const newest = [...openedAt].sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
  try {
    globalThis.localStorage.setItem(
      storageKey(actorId),
      JSON.stringify(Object.fromEntries(newest)),
    );
  } catch {
    // Storage can be full or blocked; the sort simply forgets.
  }
}

/** The viewer's open times and a recorder to call when they open an item. */
export function useDriveOpenedAt(actorId: string | null) {
  const [state, setState] = useState(() => ({ actorId, openedAt: readDriveOpenedAt(actorId) }));
  const current = state.actorId === actorId ? state.openedAt : readDriveOpenedAt(actorId);
  if (state.actorId !== actorId) {
    setState({ actorId, openedAt: current });
  }
  const recordOpened = useCallback((id: string) => {
    setState((previous) => {
      const next = new Map(previous.openedAt);
      next.set(id, Date.now());
      writeDriveOpenedAt(previous.actorId, next);
      return { actorId: previous.actorId, openedAt: next };
    });
  }, []);
  return [current, recordOpened] as const;
}
