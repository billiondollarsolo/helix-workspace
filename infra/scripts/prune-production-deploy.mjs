#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function packageDirectories(nodeModulesPath) {
  let entries;
  try {
    entries = readdirSync(nodeModulesPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const packages = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(nodeModulesPath, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scopedEntry of readdirSync(path, { withFileTypes: true })) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          packages.push(join(path, scopedEntry.name));
        }
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) packages.push(path);
  }
  return packages;
}

function readPackageManifest(packageRoot) {
  const path = join(packageRoot, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read deployed package manifest ${path}: ${detail}`);
  }
  if (
    typeof manifest.name !== "string" ||
    manifest.name.length === 0 ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0
  ) {
    throw new Error(`Deployed package manifest is missing name/version: ${path}`);
  }
}

function assertNoDanglingSymlinks(root) {
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      try {
        realpathSync(path);
      } catch {
        throw new Error(`Pruned production deployment contains a dangling symlink: ${path}`);
      }
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path)) visit(join(path, entry));
  }
  visit(root);
}

export function pruneProductionDeploy(deployRoot) {
  const root = realpathSync(resolve(deployRoot));
  if (root === resolve(root, sep) || root === REPO_ROOT) {
    throw new Error(`Refusing unsafe production deploy prune target: ${root}`);
  }
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (
    rootManifest.name !== "@helix/app" ||
    !existsSync(join(root, "dist/index.js")) ||
    !lstatSync(join(root, "dist/index.js")).isFile()
  ) {
    throw new Error(`Refusing non-Helix production deploy prune target: ${root}`);
  }

  const nodeModulesPath = join(root, "node_modules");
  const virtualStorePath = join(nodeModulesPath, ".pnpm");
  if (
    !lstatSync(nodeModulesPath).isDirectory() ||
    lstatSync(nodeModulesPath).isSymbolicLink() ||
    !lstatSync(virtualStorePath).isDirectory() ||
    lstatSync(virtualStorePath).isSymbolicLink()
  ) {
    throw new Error("Production deploy node_modules and virtual store must be real directories");
  }
  const nodeModules = realpathSync(nodeModulesPath);
  const virtualStore = realpathSync(virtualStorePath);
  if (
    dirname(nodeModules) !== root ||
    dirname(virtualStore) !== nodeModules ||
    basename(virtualStore) !== ".pnpm"
  ) {
    throw new Error("Production deploy virtual store escaped its reviewed target");
  }
  const visitedPackages = new Set();
  const reachableStoreEntries = new Set();

  function visit(candidate) {
    let packageRoot;
    try {
      const stat = lstatSync(candidate);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) return;
      packageRoot = realpathSync(candidate);
    } catch {
      return;
    }
    if (visitedPackages.has(packageRoot)) return;
    visitedPackages.add(packageRoot);
    readPackageManifest(packageRoot);

    const relativeToStore = relative(virtualStore, packageRoot);
    if (
      relativeToStore.length > 0 &&
      relativeToStore !== ".." &&
      !relativeToStore.startsWith(`..${sep}`)
    ) {
      reachableStoreEntries.add(relativeToStore.split(sep)[0]);
    }

    let dependencyDirectory = dirname(packageRoot);
    if (basename(dependencyDirectory).startsWith("@")) {
      dependencyDirectory = dirname(dependencyDirectory);
    }
    if (dependencyDirectory.includes(`${sep}node_modules${sep}.pnpm${sep}`)) {
      for (const dependency of packageDirectories(dependencyDirectory)) visit(dependency);
    }
    for (const dependency of packageDirectories(join(packageRoot, "node_modules"))) {
      visit(dependency);
    }
  }

  for (const dependency of packageDirectories(nodeModules)) visit(dependency);
  if (visitedPackages.size === 0 || reachableStoreEntries.size === 0) {
    throw new Error("Production dependency graph is empty; refusing to prune");
  }

  let removedEntries = 0;
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory() || reachableStoreEntries.has(entry.name)) continue;
    rmSync(join(virtualStore, entry.name), { recursive: true, force: true });
    removedEntries += 1;
  }
  rmSync(join(virtualStore, "lock.yaml"), { force: true });
  rmSync(join(nodeModules, ".modules.yaml"), { force: true });

  assertNoDanglingSymlinks(nodeModules);
  return {
    reachablePackages: visitedPackages.size,
    reachableStoreEntries: reachableStoreEntries.size,
    removedEntries,
  };
}

function main() {
  const [deployRoot, ...extra] = process.argv.slice(2);
  if (deployRoot === undefined || extra.length > 0) {
    throw new Error("Usage: prune-production-deploy.mjs <production-deploy-root>");
  }
  const result = pruneProductionDeploy(deployRoot);
  process.stdout.write(
    `Pruned production deploy: retained ${result.reachablePackages} packages in ${result.reachableStoreEntries} virtual-store entries; removed ${result.removedEntries} unreachable entries\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Production deploy pruning failed closed: ${detail}\n`);
    process.exitCode = 1;
  }
}
