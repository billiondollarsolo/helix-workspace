import { useSyncExternalStore } from "react";

/** Matches the `@media (max-width: 760px)` shell breakpoint in styles.css. */
const MOBILE_LAYOUT_QUERY = "(max-width: 760px)";

function mediaQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(MOBILE_LAYOUT_QUERY)
    : null;
}

/** True when the shell uses its phone layout (bottom bar, drawer navigation). */
export function useMobileLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = mediaQuery();
      query?.addEventListener("change", onChange);
      return () => query?.removeEventListener("change", onChange);
    },
    () => mediaQuery()?.matches ?? false,
    () => false,
  );
}
