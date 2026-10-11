import { useEffect, useRef } from "react";
import type { ShortcutIdIn, ShortcutScope } from "./catalog";
import { shortcutRegistry, type ShortcutHandler } from "./registry";

/** Handlers keyed by catalog id. `undefined` leaves a shortcut unregistered,
    so a component can wire a key only while its action is available. */
export type ShortcutBindings<S extends ShortcutScope> = Partial<
  Record<ShortcutIdIn<S>, ShortcutHandler | undefined>
>;

/**
 * Register shortcut handlers for `scope` while the calling component is
 * mounted. Handlers may change on every render; the registration only changes
 * when the set of bound ids does.
 *
 *   useShortcuts("drive", { "drive.new-folder": () => createFolder() });
 */
export function useShortcuts<S extends ShortcutScope>(scope: S, bindings: ShortcutBindings<S>) {
  const bindingsRef = useRef(bindings);
  useEffect(() => {
    bindingsRef.current = bindings;
  });
  const boundIds = (Object.keys(bindings) as ShortcutIdIn<S>[])
    .filter((id) => bindings[id] !== undefined)
    .sort()
    .join(",");

  useEffect(() => {
    if (boundIds === "") {
      return;
    }
    const ids = boundIds.split(",") as ShortcutIdIn<S>[];
    return shortcutRegistry.register(
      ids.map((id) => ({
        id,
        handler: (event) => {
          const handler = bindingsRef.current[id];
          return handler === undefined ? false : handler(event);
        },
      })),
    );
  }, [scope, boundIds]);
}
