#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const workspaceRoot = resolve(
  process.env.HELIX_WORKSPACE_DIR ?? new URL("../..", import.meta.url).pathname,
);
const editorsRoot = resolve(
  process.env.HELIX_EDITORS_DIR ?? join(workspaceRoot, "..", "helix-editors"),
);
const editorsPackagesRoot = join(editorsRoot, "packages");
const thisScript = resolve(new URL("", import.meta.url).pathname);

const allowedEditorPackages = new Set(["@helix/editors-core-app"]);
const sourceRoots = ["apps", "packages", "plugins", "infra"];
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const skippedDirectories = new Set(["dist", "node_modules", ".turbo", "coverage"]);

const importPattern =
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']|\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu;
const stringLiteralPattern = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/gu;

const violations = [];
const violationKeys = new Set();

for (const root of sourceRoots) {
  await scanPath(join(workspaceRoot, root));
}
await scanPackageManifest(join(workspaceRoot, "package.json"));
for (const root of sourceRoots) {
  await scanPackageManifests(join(workspaceRoot, root));
}

if (violations.length > 0) {
  console.error("helix-workspace editor-boundary violations found:");
  for (const violation of violations) {
    console.error(
      `- ${relative(workspaceRoot, violation.file)} references ${violation.specifier} (${violation.reason})`,
    );
  }
  console.error(
    "helix-workspace may depend on @helix/editors-core-app only; use SDK contracts instead of editor engine internals or sibling package paths.",
  );
  process.exitCode = 1;
}

async function scanPath(path) {
  const resolvedPath = resolve(path);
  if (resolvedPath === thisScript) {
    return;
  }

  let info;
  try {
    info = await stat(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (info.isDirectory()) {
    for (const entry of await readdir(resolvedPath)) {
      if (skippedDirectories.has(entry)) {
        continue;
      }
      await scanPath(join(resolvedPath, entry));
    }
    return;
  }

  if (!info.isFile() || !sourceExtensions.has(extensionOf(resolvedPath))) {
    return;
  }

  const source = await readFile(resolvedPath, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier === undefined) {
      continue;
    }
    const reason = boundaryViolationReason(resolvedPath, specifier);
    if (reason !== null) {
      addViolation({ file: resolvedPath, specifier, reason });
    }
  }
  for (const match of source.matchAll(stringLiteralPattern)) {
    const literal = match[2];
    if (literal === undefined) {
      continue;
    }
    const reason = editorPathViolationReason(resolvedPath, literal);
    if (reason !== null) {
      addViolation({
        file: resolvedPath,
        specifier: literal,
        reason: "string literal crosses into helix-editors/packages",
      });
    }
  }
}

async function scanPackageManifests(root) {
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (!info.isDirectory()) {
    return;
  }

  for (const entry of await readdir(root)) {
    if (skippedDirectories.has(entry)) {
      continue;
    }
    const path = join(root, entry);
    if (entry === "package.json") {
      await scanPackageManifest(path);
      continue;
    }
    const relativePath = relative(workspaceRoot, path);
    await scanPackageManifests(path);
  }
}

async function scanPackageManifest(path) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const dependencyField of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = manifest[dependencyField];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== "string") {
        continue;
      }
      const packageReason = editorPackageViolationReason(name);
      if (packageReason !== null) {
        addViolation({
          file: path,
          specifier: `${dependencyField}.${name}`,
          reason: packageReason,
        });
      }
      const pathReason = editorPathViolationReason(path, specifier);
      if (pathReason !== null) {
        addViolation({
          file: path,
          specifier: `${dependencyField}.${name}=${specifier}`,
          reason: pathReason,
        });
      }
    }
  }
}

function addViolation(violation) {
  const key = `${violation.file}\0${violation.specifier}`;
  if (violationKeys.has(key)) {
    return;
  }
  violationKeys.add(key);
  violations.push(violation);
}

function boundaryViolationReason(file, specifier) {
  return editorPackageViolationReason(specifier) ?? editorPathViolationReason(file, specifier);
}

function editorPackageViolationReason(specifier) {
  if (!specifier.startsWith("@helix/editors-")) {
    return null;
  }
  return allowedEditorPackages.has(specifier)
    ? null
    : "direct dependency on editor package internals";
}

function editorPathViolationReason(file, specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  if (normalized.includes("helix-editors/packages/")) {
    return "specifier crosses into helix-editors/packages";
  }

  const resolved = specifier.startsWith(".")
    ? resolve(file, "..", specifier)
    : isAbsolute(specifier)
      ? resolve(specifier)
      : null;
  if (resolved !== null && isWithin(editorsPackagesRoot, resolved)) {
    return "relative or absolute reference resolves into helix-editors/packages";
  }
  return null;
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function extensionOf(path) {
  const index = path.lastIndexOf(".");
  return index === -1 || path.includes(`${sep}node_modules${sep}`) ? "" : path.slice(index);
}
