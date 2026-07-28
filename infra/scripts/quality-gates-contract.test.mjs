import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const FORMAT_CHECK = resolve(SCRIPT_DIR, "check-format.mjs");
const HELM_CHECK = resolve(SCRIPT_DIR, "validate-helm.sh");
const HELM_CHART = resolve(REPO_ROOT, "infra/helm/helix");
const temporaryDirectories = [];

function temporaryDirectory(prefix) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function runFormatCheck(root, ...files) {
  return spawnSync(process.execPath, [FORMAT_CHECK, ...files], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HELIX_FORMAT_ROOT: root,
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("quality-gate contract", () => {
  it("rejects a deliberately misformatted TypeScript file", () => {
    const root = temporaryDirectory("helix-format-negative-");
    writeFileSync(resolve(root, ".prettierignore"), "");
    writeFileSync(resolve(root, "bad.ts"), "export const value={answer:42}\n");

    const result = runFormatCheck(root, "bad.ts");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Formatting issues found in 1 file(s)");
    expect(result.stderr).toContain("bad.ts");
  });

  it("uses self-contained exact legacy hashes without Git history", () => {
    const root = temporaryDirectory("helix-format-baseline-");
    const legacy = "export const value={answer:42}\n";
    const digest = createHash("sha256").update(legacy).digest("hex");
    writeFileSync(resolve(root, ".prettierignore"), "");
    writeFileSync(resolve(root, "legacy.ts"), legacy);
    writeFileSync(
      resolve(root, ".prettier-baseline.json"),
      `${JSON.stringify({ files: { "legacy.ts": digest } })}\n`,
    );

    const unchanged = runFormatCheck(root, "legacy.ts");
    expect(unchanged.status).toBe(0);
    expect(unchanged.stdout).toContain("1 unchanged legacy file(s)");

    appendFileSync(resolve(root, "legacy.ts"), "export const changed=true\n");
    const changed = runFormatCheck(root, "legacy.ts");
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("changed since the reviewed formatting baseline");
  });

  it("rejects an invalid raw Helm template", () => {
    const helmAvailable = spawnSync("helm", ["version", "--short"], {
      encoding: "utf8",
    });
    expect(helmAvailable.status, "Helm must be installed for the quality contract test").toBe(0);

    const root = temporaryDirectory("helix-helm-negative-");
    const chart = resolve(root, "helix");
    mkdirSync(chart, { recursive: true });
    cpSync(HELM_CHART, chart, { recursive: true });
    appendFileSync(resolve(chart, "templates/deployment.yaml"), "\n{{- if }}\n");

    const result = spawnSync("bash", [HELM_CHECK], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HELIX_HELM_CHART_DIR: chart,
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/parse error|unexpected|failed/i);
  });
});
