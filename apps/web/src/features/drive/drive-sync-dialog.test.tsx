// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveSyncControl, helixSyncInstallCommands, helixSyncPlatform } from "./drive-sync-dialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("DriveSyncControl", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("shows a curl|bash install from this Helix origin, not pnpm", () => {
    act(() => {
      root.render(<DriveSyncControl />);
    });
    act(() => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Desktop sync"))
        ?.click();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("curl -fsSL");
    expect(text).toContain("/v1/drive/sync/install.sh | bash");
    expect(text).toContain("irm");
    expect(text).toContain("install.ps1 | iex");
    expect(text).not.toContain("pnpm helix:drive-sync");
    expect(text).toContain("app password");
    expect(text).toContain("raw.githubusercontent.com");
  });

  it("builds origin-specific commands", () => {
    expect(helixSyncInstallCommands("https://helix.example")).toEqual({
      unix: "curl -fsSL https://helix.example/v1/drive/sync/install.sh | bash",
      windows: "irm https://helix.example/v1/drive/sync/install.ps1 | iex",
      unixDownload: "https://helix.example/v1/drive/sync/install.sh",
      windowsDownload: "https://helix.example/v1/drive/sync/install.ps1",
    });
    expect(helixSyncPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)")).toBe("mac");
    expect(helixSyncPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(helixSyncPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("linux");
  });
});
