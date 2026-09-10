#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(process.env.HELIX_WORKSPACE_DIR ?? join(scriptDir, "../.."));

const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const skippedDirectories = new Set(["dist", "node_modules", ".turbo", "coverage", ".git"]);
// Real ESM/CJS import statements only — not JSDoc `import("…")` type refs.
const importPattern =
  /(?:^|[^@\w])(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|(?:^|[^@\w])(?:import|require)\(\s*["']([^"']+)["']\s*\)/gmu;

const violations = await collectTierViolations();
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Workspace dependency boundaries passed.");
}

async function collectTierViolations() {
  return [
    ...(await collectImportViolations(
      "apps",
      (_file, specifier) =>
        /(?:^@helix\/editors|^@tiptap\/|^yjs$|onlyoffice|documentserver|^xlsx$)/iu.test(specifier),
      "editors and spreadsheet conversion are outside the storage product",
    )),
    ...(await collectImportViolations(
      "apps/web",
      (file, specifier) =>
        specifier === "@helix/app" ||
        specifier.startsWith("@helix/app/") ||
        (specifier.startsWith(".") && resolvesInto(file, specifier, "apps/helix")),
      "web must not import API app",
    )),
    ...(await collectImportViolations(
      "packages",
      (_file, specifier) =>
        /(?:^@helix\/editors|^@tiptap\/|^yjs$|onlyoffice|documentserver|^xlsx$)/iu.test(specifier),
      "native editor integrations are outside the product",
    )),
    ...(await collectImportViolations(
      "packages",
      (file, specifier) => specifier.startsWith(".") && resolvesInto(file, specifier, "apps/"),
      "packages must not import apps/*",
    )),
  ];
}

/**
 * Reports every non-test source file under `rootRelative` whose import specifiers
 * fail `violates`. Tests are exempt: they may reach across tiers to exercise them.
 * @returns {Promise<string[]>}
 */
async function collectImportViolations(rootRelative, violates, reason) {
  /** @type {string[]} */
  const violations = [];
  await walk(join(workspaceRoot, rootRelative), async (file) => {
    if (file.includes(".test.") || file.includes(".spec.")) return;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;
      if (violates(file, specifier)) {
        violations.push(`- ${relative(workspaceRoot, file)} imports ${specifier} (${reason})`);
      }
    }
  });
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
