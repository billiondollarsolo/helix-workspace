import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

export type ColorMode = "light" | "dark" | "system";
export type ResolvedColorMode = "light" | "dark";

export interface ColorModeApi {
  mode: ColorMode;
  resolvedMode: ResolvedColorMode;
  setMode: (mode: ColorMode) => void;
  toggle: () => void;
}

const storageKey = "helix-color-mode";

function isColorMode(value: string | null): value is ColorMode {
  return value === "light" || value === "dark" || value === "system";
}

function getStoredMode(): ColorMode {
  if (typeof localStorage === "undefined") {
    return "system";
  }

  const stored = localStorage.getItem(storageKey);
  return isColorMode(stored) ? stored : "system";
}

function resolveMode(mode: ColorMode): ResolvedColorMode {
  if (mode !== "system") {
    return mode;
  }

  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyMode(mode: ColorMode) {
  const resolved = resolveMode(mode);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("light", resolved === "light");
  document.documentElement.dataset.colorMode = mode;
}

const ColorModeContext = createContext<ColorModeApi | null>(null);

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ColorMode>(() => getStoredMode());
  const [resolvedMode, setResolvedMode] = useState<ResolvedColorMode>(() => resolveMode(getStoredMode()));

  const setMode = useCallback((nextMode: ColorMode) => {
    localStorage.setItem(storageKey, nextMode);
    applyMode(nextMode);
    setModeState(nextMode);
    setResolvedMode(resolveMode(nextMode));
  }, []);

  useEffect(() => {
    applyMode(mode);

    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return undefined;
    }

    const handleChange = () => {
      if (mode === "system") {
        applyMode(mode);
        setResolvedMode(resolveMode(mode));
      }
    };

    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode(resolveMode(mode) === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  const value = useMemo<ColorModeApi>(
    () => ({ mode, resolvedMode, setMode, toggle }),
    [mode, resolvedMode, setMode, toggle]
  );

  return <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>;
}

export function useColorMode() {
  const value = useContext(ColorModeContext);
  if (!value) {
    throw new Error("useColorMode must be used inside ColorModeProvider.");
  }
  return value;
}

export const colorModeStorageKey = storageKey;
