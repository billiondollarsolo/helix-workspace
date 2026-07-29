import { describe, expect, it, vi } from "vitest";
import {
  assertImageMetadata,
  parseArgs,
  validateProductionImages,
} from "./validate-production-images.mjs";

const digest = `sha256:${"a".repeat(64)}`;

function metadata({ entrypoint, command, health }) {
  return {
    Id: digest,
    Config: {
      User: "10001:10001",
      Entrypoint: entrypoint,
      ...(command === undefined ? {} : { Cmd: command }),
      Healthcheck: { Test: ["CMD-SHELL", health] },
    },
    RootFS: { Layers: [digest] },
  };
}

describe("production image validation", () => {
  it("parses explicit image references over environment defaults", () => {
    expect(
      parseArgs(
        [
          "--application-image",
          "registry.example/helix@app",
          "--web-image",
          "registry.example/web@edge",
        ],
        {
          HELIX_IMAGE: "environment-app",
          HELIX_WEB_IMAGE: "environment-web",
        },
      ),
    ).toEqual({
      applicationImage: "registry.example/helix@app",
      webImage: "registry.example/web@edge",
      help: false,
    });
  });

  it("accepts the required non-root metadata and executes read-only payload checks", () => {
    const app = metadata({
      entrypoint: ["node", "dist/index.js"],
      health: "fetch('http://127.0.0.1:3000/healthz')",
    });
    const web = metadata({
      entrypoint: ["caddy"],
      command: ["run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
      health: "wget http://127.0.0.1/healthz",
    });
    const run = vi.fn((command, args) => {
      if (args[0] === "image" && args[2] === "app:test") {
        return JSON.stringify([app]);
      }
      if (args[0] === "image" && args[2] === "web:test") {
        return JSON.stringify([web]);
      }
      return "";
    });

    validateProductionImages({ applicationImage: "app:test", webImage: "web:test" }, run);

    const containerRuns = run.mock.calls.filter(([, args]) => args[0] === "run");
    expect(containerRuns).toHaveLength(2);
    for (const [, args] of containerRuns) {
      expect(args).toContain("--read-only");
      expect(args).toContain("none");
      expect(args).toContain("--rm");
    }
  });

  it.each([
    [
      "root user",
      {
        ...metadata({
          entrypoint: ["node", "dist/index.js"],
          health: "127.0.0.1:3000/healthz",
        }),
        Config: {
          ...metadata({
            entrypoint: ["node", "dist/index.js"],
            health: "127.0.0.1:3000/healthz",
          }).Config,
          User: "0",
        },
      },
      "UID/GID",
    ],
    [
      "wrong entrypoint",
      metadata({
        entrypoint: ["sh"],
        health: "127.0.0.1:3000/healthz",
      }),
      "entrypoint",
    ],
    [
      "missing health check",
      metadata({
        entrypoint: ["node", "dist/index.js"],
        health: "unrelated",
      }),
      "health check",
    ],
  ])("rejects %s", (_case, candidate, expected) => {
    expect(() =>
      assertImageMetadata(candidate, {
        name: "application",
        expectedEntrypoint: ["node", "dist/index.js"],
        requiredHealthFragment: "127.0.0.1:3000/healthz",
      }),
    ).toThrow(expected);
  });

  it.each([
    [
      "the executable is incorrectly placed in Cmd",
      metadata({
        entrypoint: null,
        command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        health: "127.0.0.1/healthz",
      }),
      "entrypoint",
    ],
    [
      "the subcommand is incorrectly placed in Entrypoint",
      metadata({
        entrypoint: ["caddy", "run"],
        command: ["--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
        health: "127.0.0.1/healthz",
      }),
      "entrypoint",
    ],
    [
      "the Caddy configuration command is incomplete",
      metadata({
        entrypoint: ["caddy"],
        command: ["run", "--config", "/tmp/untrusted.Caddyfile"],
        health: "127.0.0.1/healthz",
      }),
      "command",
    ],
  ])("rejects web metadata when %s", (_case, candidate, expected) => {
    expect(() =>
      assertImageMetadata(candidate, {
        name: "web",
        expectedEntrypoint: ["caddy"],
        expectedCommandPrefix: [
          "run",
          "--config",
          "/etc/caddy/Caddyfile",
          "--adapter",
          "caddyfile",
        ],
        requiredHealthFragment: "127.0.0.1/healthz",
      }),
    ).toThrow(expected);
  });
});
