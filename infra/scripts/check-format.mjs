#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import console from "node:console";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import * as prettier from "prettier";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "../..");
const ROOT_DIR = resolve(process.env.HELIX_FORMAT_ROOT ?? DEFAULT_ROOT);
const BASELINE_PATH = resolve(
  process.env.HELIX_FORMAT_BASELINE ?? resolve(ROOT_DIR, ".prettier-baseline.json"),
);
const IGNORE_PATH = resolve(
  process.env.HELIX_FORMAT_IGNORE ?? resolve(ROOT_DIR, ".prettierignore"),
);

function normalizePath(filePath) {
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(ROOT_DIR, filePath);
  const relativePath = relative(ROOT_DIR, absolutePath);

  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Format target escapes the repository root: ${filePath}`);
  }

  return relativePath.split(sep).join("/");
}

function repositoryFiles() {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard", "-z", "--", "."], {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Unable to enumerate repository files: ${result.stderr.trim()}`);
  }

  return result.stdout.split("\0").filter(Boolean).map(normalizePath);
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    return {};
  }

  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.files === null ||
    typeof parsed.files !== "object" ||
    Array.isArray(parsed.files)
  ) {
    throw new Error(`${relative(ROOT_DIR, BASELINE_PATH)} must contain a "files" object.`);
  }

  const entries = Object.entries(parsed.files);
  const paths = entries.map(([filePath]) => filePath);
  const sortedPaths = [...paths].sort();
  if (paths.some((filePath, index) => filePath !== sortedPaths[index])) {
    throw new Error(`${relative(ROOT_DIR, BASELINE_PATH)} file paths must be sorted.`);
  }

  for (const [filePath, digest] of entries) {
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Invalid SHA-256 baseline digest for ${filePath}.`);
    }
  }

  return parsed.files;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function checkFile(filePath, baseline) {
  const absolutePath = resolve(ROOT_DIR, filePath);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    return { state: "skipped" };
  }

  const fileInfo = await prettier.getFileInfo(absolutePath, {
    ignorePath: existsSync(IGNORE_PATH) ? IGNORE_PATH : undefined,
    withNodeModules: false,
  });
  if (fileInfo.ignored || fileInfo.inferredParser === null) {
    return { state: "skipped" };
  }

  const content = readFileSync(absolutePath, "utf8");
  const options = {
    ...(await prettier.resolveConfig(absolutePath, { editorconfig: true })),
    filepath: absolutePath,
  };
  const formatted = await prettier.check(content, options);

  if (formatted) {
    return { state: "formatted" };
  }

  const reviewedDigest = baseline[filePath];
  if (reviewedDigest !== undefined && reviewedDigest === sha256(content)) {
    return { state: "legacy" };
  }

  return {
    state: reviewedDigest === undefined ? "unformatted" : "changed-unformatted",
  };
}

async function main() {
  const requestedFiles = process.argv.slice(2);
  const files = [
    ...new Set(
      (requestedFiles.length > 0 ? requestedFiles.map(normalizePath) : repositoryFiles()).sort(),
    ),
  ];
  const baseline = loadBaseline();
  const failures = [];
  const legacy = [];
  let checkedCount = 0;

  for (const filePath of files) {
    const result = await checkFile(filePath, baseline);
    if (result.state === "skipped") {
      continue;
    }

    checkedCount += 1;
    if (result.state === "legacy") {
      legacy.push(filePath);
    } else if (result.state === "unformatted" || result.state === "changed-unformatted") {
      failures.push({
        filePath,
        changedBaseline: result.state === "changed-unformatted",
      });
    }
  }

  if (failures.length > 0) {
    console.error(`Formatting issues found in ${failures.length} file(s):`);
    for (const failure of failures) {
      const suffix = failure.changedBaseline
        ? " (changed since the reviewed formatting baseline)"
        : "";
      console.error(`  ${failure.filePath}${suffix}`);
    }
    console.error("Run `pnpm exec prettier --write <file...>` on the listed files.");
    process.exitCode = 1;
    return;
  }

  console.log(`Formatting check passed for ${checkedCount} file(s).`);
  if (legacy.length > 0) {
    console.log(
      `${legacy.length} unchanged legacy file(s) remain pinned by exact SHA-256 in .prettier-baseline.json.`,
    );
  }
}

await main();
