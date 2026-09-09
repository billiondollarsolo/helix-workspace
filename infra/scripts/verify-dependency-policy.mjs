#!/usr/bin/env node

import assert from "node:assert/strict";
import * as prettier from "prettier";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const policy = JSON.parse(readFileSync(resolve(root, "security/license-policy.json"), "utf8"));
const manifests = ["package.json", ...manifestFiles("apps"), ...manifestFiles("packages")];

const errors = [];
const versions = new Map();
for (const file of manifests) {
  const manifest = JSON.parse(readFileSync(resolve(root, file), "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (!isExactSpecifier(specifier)) {
        errors.push(`${file}: ${section}.${name} must be exact (found ${specifier})`);
      }
      if (specifier.startsWith("workspace:") || specifier.startsWith("file:")) continue;
      const uses = versions.get(name) ?? new Map();
      const locations = uses.get(specifier) ?? [];
      locations.push(`${file}:${section}`);
      uses.set(specifier, locations);
      versions.set(name, uses);
    }
  }
}
for (const [name, uses] of versions) {
  if (uses.size > 1) {
    errors.push(
      `${name} has multiple direct versions: ${[...uses].map(([version, files]) => `${version} (${files.join(", ")})`).join("; ")}`,
    );
  }
}

const result = spawnSync("pnpm", ["licenses", "list", "--prod", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || "pnpm licenses failed");
const licenses = JSON.parse(result.stdout);
const allowed = new Set(policy.allowed);
for (const license of Object.keys(licenses)) {
  if (license !== "Unknown" && !allowed.has(license)) {
    errors.push(`production license is not allowlisted: ${license}`);
  }
}
for (const item of licenses.Unknown ?? []) {
  if (policy.licenseOverrides[item.name] !== undefined) continue;
  if (!Object.keys(policy.unknownPackages).some((pattern) => matches(pattern, item.name))) {
    errors.push(`production package has unknown license: ${item.name}`);
  }
}

const noticesFile = resolve(root, "THIRD_PARTY_NOTICES.md");
const notices = await prettier.format(renderNotices(licenses), {
  ...(await prettier.resolveConfig(noticesFile)),
  filepath: noticesFile,
});
if (process.argv.includes("--write-notices")) {
  writeFileSync(noticesFile, notices);
} else if (readFileSync(noticesFile, "utf8") !== notices) {
  errors.push("THIRD_PARTY_NOTICES.md is stale; run this script with --write-notices");
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  console.log(
    `Dependency policy passed for ${manifests.length} manifests and ${packageCount(licenses)} production packages.`,
  );
}

function manifestFiles(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${directory}/${entry.name}/package.json`)
    .filter((file) => {
      try {
        readFileSync(resolve(root, file));
        return true;
      } catch {
        return false;
      }
    });
}

function isExactSpecifier(specifier) {
  return (
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specifier) ||
    /^npm:(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specifier) ||
    /^workspace:(?:\*|\d+\.\d+\.\d+)$/.test(specifier) ||
    specifier.startsWith("file:") ||
    (/^https:\/\//.test(specifier) && /#sha512-/.test(specifier))
  );
}

if (process.argv.includes("--self-test")) {
  assert.equal(isExactSpecifier("npm:zod@3.25.76"), true);
  assert.equal(isExactSpecifier("npm:@scope/package@1.2.3"), true);
  assert.equal(isExactSpecifier("npm:zod@^3.25.76"), false);
  assert.equal(isExactSpecifier("npm:zod@latest"), false);
}

function matches(pattern, value) {
  if (!pattern.endsWith("*")) return pattern === value;
  return value.startsWith(pattern.slice(0, -1));
}

function packageCount(report) {
  return Object.values(report).reduce((total, entries) => total + entries.length, 0);
}

function renderNotices(report) {
  const entries = Object.entries(report)
    .flatMap(([license, packages]) =>
      packages
        .filter((item) => license !== "Unknown" || policy.licenseOverrides[item.name] !== undefined)
        .map((item) => ({
          license: policy.licenseOverrides[item.name]?.license ?? license,
          name: item.name,
          version: (item.versions ?? []).filter(Boolean).join(", ") || "private workspace package",
          homepage: policy.licenseOverrides[item.name]?.source ?? item.homepage,
        })),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.license.localeCompare(right.license),
    );
  const rows = entries.map(
    ({ license, name, version, homepage }) =>
      `| ${escapeCell(name)} | ${escapeCell(version)} | ${escapeCell(license)} | ${homepage ? `[source](${homepage})` : "—"} |`,
  );
  return [
    "# Third-party notices",
    "",
    "Generated from the locked production dependency graph. Package source distributions contain the authoritative license text.",
    "",
    "Includes caniuse-lite browser compatibility data by Ben Briggs and contributors, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See the package source and bundled license for attribution details.",
    "",
    "| Package | Version | License | Project |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function escapeCell(value) {
  return String(value).replaceAll("|", "\\|");
}
