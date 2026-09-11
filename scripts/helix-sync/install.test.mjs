import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptsDir = fileURLToPath(new URL("./", import.meta.url));
const installSh = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
const helixSyncSh = readFileSync(new URL("./helix-sync.sh", import.meta.url), "utf8");
const installPs1 = readFileSync(new URL("./install.ps1", import.meta.url), "utf8");

describe("Helix Sync installers", () => {
  it("do not require Node or pnpm", () => {
    expect(installSh).not.toMatch(/\bpnpm helix:drive-sync\b/);
    expect(installSh).not.toMatch(/\b(?:npx|npm install|corepack)\b/);
    expect(installPs1).not.toMatch(/\bpnpm helix:drive-sync\b/);
    expect(helixSyncSh).toContain("rclone");
  });

  it("download a pinned rclone build per OS/arch", () => {
    expect(installSh).toContain("downloads.rclone.org");
    expect(installSh).toContain("osx");
    expect(installSh).toContain("linux");
    expect(installSh).toContain("arm64");
    expect(installPs1).toContain("windows-");
    expect(installPs1).toContain("amd64");
    expect(installPs1).toContain("ARM64");
  });

  it("installs helix-sync into ~/.helix/drive-sync/bin", () => {
    expect(installSh).toContain(".helix/drive-sync");
    expect(installSh).toContain("helix-sync");
    expect(installPs1).toContain("Helix\\drive-sync");
  });

  it("copies helix-sync without downloading rclone when skip is set", () => {
    const home = mkdtempSync(join(tmpdir(), "helix-sync-"));
    try {
      execFileSync("bash", [join(scriptsDir, "install.sh")], {
        env: {
          ...process.env,
          HOME: home,
          HELIX_SYNC_HOME: join(home, ".helix/drive-sync"),
          HELIX_SYNC_LOCAL_BIN: join(home, ".local/bin"),
          HELIX_SYNC_SKIP_RCLONE: "1",
          HELIX_SYNC_SCRIPT_BASE: new URL("./", import.meta.url).href.replace(/\/$/u, ""),
        },
        stdio: "pipe",
      });
      expect(existsSync(join(home, ".helix/drive-sync/bin/helix-sync"))).toBe(true);
      expect(existsSync(join(home, ".local/bin/helix-sync"))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
