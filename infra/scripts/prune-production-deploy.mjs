#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

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
  return manifest;
}

function dependencyRequirements(manifest) {
  const requirements = new Map();
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    requirements.set(name, { optional: false });
  }
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    requirements.set(name, { optional: true });
  }
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional === true) continue;
    if (!requirements.has(name)) requirements.set(name, { optional: false });
  }
  return requirements;
}

function dependencyDirectory(packageRoot) {
  let path = dirname(packageRoot);
  if (basename(path).startsWith("@")) path = dirname(path);
  return path;
}

function resolveDependency(packageRoot, name) {
  const candidates = [
    join(packageRoot, "node_modules", name),
    join(dependencyDirectory(packageRoot), name),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function virtualStoreEntry(virtualStore, target) {
  const relativeToStore = relative(virtualStore, target);
  if (
    relativeToStore.length === 0 ||
    relativeToStore === ".." ||
    relativeToStore.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  return relativeToStore.split(sep)[0];
}

/**
 * Walks the deployed tree without following symlinks, handing every symlink to
 * `onSymlink`. Descending through a link would leave the virtual store and could
 * revisit entries, so links are reported and never traversed.
 */
function forEachSymlink(root, onSymlink) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) {
    onSymlink(root);
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(root)) forEachSymlink(join(root, entry), onSymlink);
}

function removeLinksToUnreachableEntries(root, virtualStore, reachableStoreEntries) {
  let removedLinks = 0;
  forEachSymlink(root, (path) => {
    const entry = virtualStoreEntry(virtualStore, realpathSync(path));
    if (entry !== undefined && !reachableStoreEntries.has(entry)) {
      rmSync(path, { force: true });
      removedLinks += 1;
    }
  });
  return removedLinks;
}

function assertNoDanglingSymlinks(root) {
  forEachSymlink(root, (path) => {
    try {
      realpathSync(path);
    } catch {
      throw new Error(`Pruned production deployment contains a dangling symlink: ${path}`);
    }
  });
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
    const manifest = readPackageManifest(packageRoot);

    const entry = virtualStoreEntry(virtualStore, packageRoot);
    if (entry !== undefined) reachableStoreEntries.add(entry);

    for (const [name, requirement] of dependencyRequirements(manifest)) {
      const dependency = resolveDependency(packageRoot, name);
      if (dependency === undefined) {
        if (requirement.optional) continue;
        throw new Error(`Required production dependency ${name} is missing for ${manifest.name}`);
      }
      visit(dependency);
    }
  }

  for (const [name, requirement] of dependencyRequirements(rootManifest)) {
    const dependency = join(nodeModules, name);
    if (!existsSync(dependency)) {
      if (requirement.optional) continue;
      throw new Error(`Required production dependency ${name} is missing for @helix/app`);
    }
    visit(dependency);
  }
  if (visitedPackages.size === 0 || reachableStoreEntries.size === 0) {
    throw new Error("Production dependency graph is empty; refusing to prune");
  }

  const removedLinks = removeLinksToUnreachableEntries(
    nodeModules,
    virtualStore,
    reachableStoreEntries,
  );
  let removedEntries = 0;
  for (const entry of readdirSync(virtualStore, { withFileTypes: true })) {
    if (!entry.isDirectory() || reachableStoreEntries.has(entry.name)) continue;
    rmSync(join(virtualStore, entry.name), { recursive: true, force: true });
    removedEntries += 1;
  }
  rmSync(join(virtualStore, "lock.yaml"), { force: true });
  for (const path of [
    join(root, "pnpm-lock.yaml"),
    join(root, "pnpm-workspace.yaml"),
    join(nodeModules, ".modules.yaml"),
    join(nodeModules, ".package-map.json"),
    join(nodeModules, ".pnpm-workspace-state-v1.json"),
  ]) {
    rmSync(path, { force: true });
  }

  assertNoDanglingSymlinks(nodeModules);
  return {
    reachablePackages: visitedPackages.size,
    reachableStoreEntries: reachableStoreEntries.size,
    removedEntries,
    removedLinks,
  };
}

function main() {
  const [deployRoot, ...extra] = process.argv.slice(2);
  if (deployRoot === undefined || extra.length > 0) {
    throw new Error("Usage: prune-production-deploy.mjs <production-deploy-root>");
  }
  const result = pruneProductionDeploy(deployRoot);
  process.stdout.write(
    `Pruned production deploy: retained ${result.reachablePackages} packages in ${result.reachableStoreEntries} virtual-store entries; removed ${result.removedEntries} unreachable entries and ${result.removedLinks} links\n`,
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
