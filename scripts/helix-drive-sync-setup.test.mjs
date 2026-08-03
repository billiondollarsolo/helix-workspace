import { describe, expect, it } from "vitest";
import {
  buildMirrorCommand,
  buildMirrorResyncCommand,
  buildMountCommand,
  buildRcloneCreateArgs,
  defaultLocalPath,
  helixHomeDir,
  normalizeDavUrl,
  parseMode,
  REMOTE_NAME,
} from "./helix-drive-sync-setup.mjs";

describe("helix-drive-sync-setup", () => {
  it("normalizes Helix base URL to WebDAV files root", () => {
    expect(normalizeDavUrl("https://helix.example.com")).toBe(
      "https://helix.example.com/dav/files/",
    );
    expect(normalizeDavUrl("https://helix.example.com/")).toBe(
      "https://helix.example.com/dav/files/",
    );
    expect(normalizeDavUrl("https://helix.example.com/dav/files")).toBe(
      "https://helix.example.com/dav/files/",
    );
    expect(normalizeDavUrl("https://helix.example.com/dav/files/")).toBe(
      "https://helix.example.com/dav/files/",
    );
    expect(normalizeDavUrl("helix.example.com")).toBe("https://helix.example.com/dav/files/");
    expect(() => normalizeDavUrl("")).toThrow(/required/i);
  });

  it("parses mirror vs mount modes from short answers", () => {
    expect(parseMode("1")).toBe("mirror");
    expect(parseMode("mirror")).toBe("mirror");
    expect(parseMode("2")).toBe("mount");
    expect(parseMode("mount")).toBe("mount");
    expect(() => parseMode("nope")).toThrow(/mode/i);
  });

  it("defaults local paths by mode and OS", () => {
    expect(defaultLocalPath("mirror", "/home/u", "linux")).toBe("/home/u/HelixDrive");
    expect(defaultLocalPath("mount", "/home/u", "linux")).toBe("/home/u/HelixMount");
    expect(defaultLocalPath("mount", "C:\\Users\\u", "win32")).toBe("X:");
  });

  it("builds rclone config create args for WebDAV", () => {
    const args = buildRcloneCreateArgs({
      url: "https://h.example/dav/files/",
      user: "a@b.com",
      obscuredPass: "obscured",
    });
    expect(args[0]).toBe("config");
    expect(args).toContain(REMOTE_NAME);
    expect(args).toContain("webdav");
    expect(args).toContain("url=https://h.example/dav/files/");
    expect(args).toContain("user=a@b.com");
    expect(args).toContain("pass=obscured");
  });

  it("builds mirror and mount command shapes", () => {
    const mirror = buildMirrorCommand("/data/HelixDrive");
    expect(mirror.args[0]).toBe("bisync");
    expect(mirror.args).toContain("/data/HelixDrive");
    expect(mirror.args).toContain("helix:");

    const resync = buildMirrorResyncCommand("/data/HelixDrive");
    expect(resync.args).toContain("--resync");

    const mount = buildMountCommand("/mnt/helix", "helix", "linux");
    expect(mount.args[0]).toBe("mount");
    expect(mount.args).toContain("--vfs-cache-mode");
    expect(mount.args).toContain("full");

    const win = buildMountCommand("X:", "helix", "win32");
    expect(win.args).toContain("--network-mode");
  });

  it("places helpers under ~/.helix/drive-sync", () => {
    expect(helixHomeDir("/home/sam")).toBe("/home/sam/.helix/drive-sync");
  });
});
