/* The plugin-facing color mode, backed by the appearance store — the single
   source of truth for theme. Handed to `WebPlatformProvider` in main.tsx. */

import type { ColorModeApi } from "@helix/sdk-web";
import { useMemo } from "react";
import { setAppearance, useAppearance, useResolvedTheme } from "@/components/settings-store";

export function useColorMode(): ColorModeApi {
  const mode = useAppearance((state) => state.theme);
  const resolvedMode = useResolvedTheme();
  return useMemo(
    () => ({ mode, resolvedMode, setMode: (next) => setAppearance("theme", next) }),
    [mode, resolvedMode],
  );
}
