import { appendFileSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");
const FORMAT_CHECK = resolve(REPO_ROOT, "node_modules/prettier/bin/prettier.cjs");
const HELM_CHECK = resolve(SCRIPT_DIR, "validate-helm.sh");
const HELM_CHART = resolve(REPO_ROOT, "infra/helm/helix");
const temporaryDirectories = [];
function temporaryDirectory(prefix) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
function runFormatCheck(root, ...files) {
  return spawnSync(process.execPath, [FORMAT_CHECK, "--check", ...files], {
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
    expect(result.stderr).toContain("Code style issues found");
    expect(result.stderr).toContain("bad.ts");
  });
  it.each(["@helix/editors", "@tiptap/core", "yjs", "onlyoffice", "documentserver", "xlsx"])(
    "rejects retired editor imports: %s",
    (dependency) => {
      const root = temporaryDirectory("helix-editor-boundary-");
      mkdirSync(resolve(root, "apps/example"), { recursive: true });
      writeFileSync(resolve(root, "apps/example/index.ts"), `import "${dependency}";\n`);
      const result = spawnSync(
        process.execPath,
        [resolve(SCRIPT_DIR, "verify-workspace-boundaries.mjs")],
        {
          encoding: "utf8",
          env: { ...process.env, HELIX_WORKSPACE_DIR: root },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(dependency);
    },
  );
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
