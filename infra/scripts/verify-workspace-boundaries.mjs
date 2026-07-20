#!/usr/bin/env node
/**
 * Config-driven workspace boundary scanner (cross-cutting Phase 4.3).
 *
 * Seams:
 *  - tier (hard): apps/web may not import the API app; packages/* may not
 *    import apps/* via relative paths
 *  - editors (soft by default): reuses verify-workspace-editor-boundaries.mjs.
 *    Pre-existing native-editor package wiring currently fails this check;
 *    set HELIX_BOUNDARIES_STRICT_EDITORS=1 to fail the aggregate on editors.
 *
 * Exit non-zero on hard-seam violations. Editors remains independently
 * runnable via `quality:editors-boundaries` for CI back-compat.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(process.env.HELIX_WORKSPACE_DIR ?? join(scriptDir, "../.."));
const strictEditors = process.env.HELIX_BOUNDARIES_STRICT_EDITORS === "1";

const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const skippedDirectories = new Set(["dist", "node_modules", ".turbo", "coverage", ".git"]);
// Real ESM/CJS import statements only — not JSDoc `import("…")` type refs.
const importPattern =
  /(?:^|[^@\w])(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|(?:^|[^@\w])(?:import|require)\(\s*["']([^"']+)["']\s*\)/gmu;

/** @type {{ id: string, hard: boolean, run: () => Promise<string[]> }[]} */
const seams = [
  {
    id: "tier",
    hard: true,
    run: async () => collectTierViolations(),
  },
  {
    id: "editors",
    hard: strictEditors,
    run: async () => {
      const editorScript = join(scriptDir, "verify-workspace-editor-boundaries.mjs");
      const result = spawnSync(process.execPath, [editorScript], {
        cwd: workspaceRoot,
        encoding: "utf8",
        env: process.env,
      });
      if (result.status === 0) {
        return [];
      }
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      return output
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line);
    },
  },
];

/** @type {{ seam: string, hard: boolean, line: string }[]} */
const allViolations = [];
for (const seam of seams) {
  const found = await seam.run();
  for (const line of found) {
    allViolations.push({ seam: seam.id, hard: seam.hard, line });
  }
}

const hard = allViolations.filter((v) => v.hard);
const soft = allViolations.filter((v) => !v.hard);

if (soft.length > 0) {
  console.warn("helix-workspace boundary warnings (soft seams):");
  for (const { seam, line } of soft) {
    console.warn(`[${seam}] ${line}`);
  }
}

if (hard.length > 0) {
  console.error("helix-workspace boundary violations found:");
  for (const { seam, line } of hard) {
    console.error(`[${seam}] ${line}`);
  }
  process.exitCode = 1;
} else if (soft.length === 0) {
  console.log("helix-workspace boundaries: ok (tier + editors)");
} else {
  console.log(
    `helix-workspace boundaries: tier ok; ${String(soft.length)} soft editor warning(s) (set HELIX_BOUNDARIES_STRICT_EDITORS=1 to fail)`,
  );
}

async function collectTierViolations() {
  /** @type {string[]} */
  const violations = [];
  await walk(join(workspaceRoot, "apps/web"), async (file) => {
    if (file.includes(".test.") || file.includes(".spec.")) return;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;
      if (
        specifier === "@helix/app" ||
        specifier.startsWith("@helix/app/") ||
        (specifier.startsWith(".") && resolvesInto(file, specifier, "apps/helix"))
      ) {
        violations.push(
          `- ${relative(workspaceRoot, file)} imports ${specifier} (web must not import API app)`,
        );
      }
    }
  });

  for (const pkgRoot of ["packages"]) {
    await walk(join(workspaceRoot, pkgRoot), async (file) => {
      if (file.includes(".test.") || file.includes(".spec.")) return;
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined) continue;
        if (specifier.startsWith(".") && resolvesInto(file, specifier, "apps/")) {
          violations.push(
            `- ${relative(workspaceRoot, file)} imports ${specifier} (packages must not import apps/*)`,
          );
        }
      }
    });
  }

  return violations;
}

function resolvesInto(importerFile, specifier, marker) {
  if (!specifier.startsWith(".")) return false;
  const dir = dirname(importerFile);
  const parts = dir.split("/").filter(Boolean);
  for (const segment of specifier.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const resolved = `/${parts.join("/")}`;
  return resolved.includes(`/${marker}`) || resolved.includes(marker);
}

async function walk(path, onFile) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) {
      if (skippedDirectories.has(entry)) continue;
      await walk(join(path, entry), onFile);
    }
    return;
  }
  if (!info.isFile()) return;
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".")) : "";
  if (!sourceExtensions.has(ext)) return;
  await onFile(path);
}
