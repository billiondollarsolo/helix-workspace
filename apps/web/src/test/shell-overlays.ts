import { vi } from "vitest";
import type { ShellOverlayApi } from "@/components/shell/overlay-context";

/** A `ShellOverlayContext` value whose triggers are all mocks. */
export function shellOverlaysForTest(): ShellOverlayApi {
  return {
    openNotifications: vi.fn(),
    openPalette: vi.fn(),
    openSettings: vi.fn(),
    openQuickSettings: vi.fn(),
    openShortcuts: vi.fn(),
    openAbout: vi.fn(),
  };
}
