import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { it, expect } from "vitest";

it("runs the lifecycle reporter against the deployed Prosody Lua runtime", () => {
  const output = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "lua",
      "-v",
      `${resolve("infra/meet/prosody")}:/tests:ro`,
      "jitsi/prosody:stable-11031@sha256:926c508c0d9198bf9d0b6adb88ce9092461e9a79e2895fb57fe4ef5f44ff3523",
      "/tests/lifecycle.test.lua",
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  expect(output).toContain("restart passed");
}, 190_000);
