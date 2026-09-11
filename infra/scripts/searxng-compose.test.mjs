import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const settings = readFileSync(new URL("../searxng/settings.yml", import.meta.url), "utf8");
const resolveCompose = (profile, port = "28461") =>
  JSON.parse(
    execFileSync(
      "docker",
      [
        "compose",
        "--env-file",
        "/dev/null",
        "-f",
        "docker-compose.yml",
        ...(profile ? ["--profile", "web-search"] : []),
        "config",
        "--format",
        "json",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, COMPOSE_PROFILES: "", SEARXNG_PORT: port },
      },
    ),
  );

describe("optional local SearXNG", () => {
  it("is absent by default and never a required Helix dependency", () => {
    const config = resolveCompose(false);
    expect(config.services.searxng).toBeUndefined();
    expect(config.services.helix.depends_on).not.toHaveProperty("searxng");
  });

  it("renders the pinned, loopback-only service with a configurable port and persistent cache", () => {
    const config = resolveCompose(true, "39861");
    const service = config.services.searxng;
    expect(service.image).toBe(
      "searxng/searxng:2026.9.10-931fd9787@sha256:2fb0fa85096fe6df5c3ab98ecb4d6e0ee2ef66b8fb96ce6fce0f75b51c4bd90a",
    );
    expect(service.ports).toEqual([
      expect.objectContaining({ host_ip: "127.0.0.1", published: "39861", target: 8080 }),
    ]);
    expect(service.volumes).toEqual([
      expect.objectContaining({ target: "/etc/searxng/settings.yml", read_only: true }),
      expect.objectContaining({
        type: "volume",
        source: "searxng-data",
        target: "/var/cache/searxng",
      }),
    ]);
    expect(service.environment.FORCE_OWNERSHIP).toBe("false");
    expect(service.healthcheck.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "-O",
      "/dev/null",
      "http://127.0.0.1:8080/healthz",
    ]);
    expect(service.restart).toBe("unless-stopped");
    expect(service.depends_on).toBeUndefined();
  });

  it("enables API JSON output using upstream engines without public-instance features", () => {
    expect(settings).toMatch(/^use_default_settings: true$/m);
    expect(settings).toMatch(/search:\s+formats:\s+- html\s+- json/m);
    expect(settings).toMatch(/limiter: false/);
    expect(settings).toMatch(/public_instance: false/);
    expect(settings).toMatch(/image_proxy: false/);
    expect(settings).not.toMatch(/secret_key:/);
  });
});
