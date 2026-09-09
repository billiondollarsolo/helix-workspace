import { readdir, readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const violations = [];
const ignoredDirectories = new Set([
  ".git",
  ".turbo",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "test-corpus",
]);
const immutableImage = /@sha256:[a-f0-9]{64}$/u;
const variableImageDigest = /@sha256:\$\{[A-Z0-9_]+:\?[^}]+\}$/u;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const files = await walk(root);
const lockfile = await readFile(new URL("pnpm-lock.yaml", root), "utf8");

for (const file of files.filter((file) => basename(file.pathname) === "package.json")) {
  const manifest = JSON.parse(await readFile(file, "utf8"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (isImmutablePackageSpecifier(specifier, lockfile)) continue;
      violations.push(`${display(file)} ${section}.${name} uses mutable specifier ${specifier}`);
    }
  }
}

for (const file of files.filter((file) =>
  /(?:^|\/)(?:docker-compose\.ya?ml|compose\.ya?ml)$/u.test(file.pathname),
)) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/^\s*image:\s*([^\s#]+).*$/gmu)) {
    const image = unquote(match[1]);
    if (immutableImage.test(image) || variableImageDigest.test(image)) continue;
    const service =
      source
        .slice(0, match.index)
        .split(/^  [\w-]+:\s*$/mu)
        .at(-1) +
      match[0] +
      source.slice(match.index + match[0].length).split(/^  [\w-]+:\s*$/mu)[0];
    // Local build outputs have no registry digest; never pull a same-named image.
    if (
      display(file) === "docker-compose.yml" &&
      image.startsWith("helix/") &&
      service.includes("    pull_policy: never") &&
      (image === "helix/helix:local" || service.includes("    build:"))
    )
      continue;
    violations.push(`${display(file)} uses mutable image ${image}`);
  }
}

for (const file of files.filter((file) => basename(file.pathname).startsWith("Dockerfile"))) {
  const source = await readFile(file, "utf8");
  const references = [
    ...[...source.matchAll(/^#\s*syntax=(\S+)/gmu)].map((match) => match[1]),
    ...[...source.matchAll(/^ARG\s+[A-Z0-9_]*BASE=(\S+)/gmu)].map((match) => match[1]),
    ...[...source.matchAll(/^FROM\s+(\S+)/gmu)]
      .map((match) => match[1])
      .filter((image) => !image.startsWith("${")),
  ];
  for (const image of references) {
    if (image !== "scratch" && !immutableImage.test(image))
      violations.push(`${display(file)} uses mutable image ${image}`);
  }
}

for (const path of [
  "package.json",
  "infra/scripts/alertmanager-signup-routing-smoke.mjs",
  "infra/scripts/alertmanager-tenant-storage-routing-smoke.mjs",
  "infra/scripts/validate-k6.sh",
]) {
  const source = await readFile(new URL(path, root), "utf8");
  for (const match of source.matchAll(
    /\b(?:(?:ghcr\.io\/[a-z0-9._/-]+|(?:grafana|prom)\/[a-z0-9._/-]+):[0-9A-Za-z._-]+|caddy:[0-9][0-9A-Za-z._-]*)(?:@sha256:[a-f0-9]{64})?/gu,
  )) {
    if (!immutableImage.test(match[0])) violations.push(`${path} uses mutable image ${match[0]}`);
  }
}

await requireMarkers(".npmrc", ["save-exact=true"]);
await requireMarkers("infra/helm/helix/templates/_helpers.tpl", [
  'required "image.digest or fips.imageDigest must be an approved sha256 digest"',
  'regexMatch "^sha256:[a-f0-9]{64}$"',
  'fail "selected image digest cannot be a placeholder"',
]);
await requireMarkers("infra/helm/helix/templates/image-verification-job.yaml", [
  "helm.sh/hook: pre-install,pre-upgrade",
  "cosign/cosign:v3.0.6@sha256:",
  "- verify",
  "- spdxjson",
  "- slsaprovenance",
  "imageVerification.publicKeySecret.name is required",
]);
await requireMarkers(".github/dependabot.yml", [
  "package-ecosystem: npm",
  "package-ecosystem: github-actions",
  "package-ecosystem: docker-compose",
  "package-ecosystem: docker",
]);

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Deployable artifacts use exact package versions and approved image digests.\n",
  );
}

function isImmutablePackageSpecifier(specifier, lockSource) {
  if (typeof specifier !== "string") return false;
  if (/^(?:workspace:|file:|link:)/u.test(specifier)) return true;
  if (exactVersion.test(specifier)) return true;
  if (/^npm:[^@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(specifier)) return true;
  if (!/^https:\/\//u.test(specifier)) return false;
  if (/#sha512-[0-9A-Za-z+/]+={0,2}$/u.test(specifier)) return true;

  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^  [^\\n]*${escaped}:\\n    resolution: \\{[^\\n}]*integrity: sha512-`,
    "mu",
  ).test(lockSource);
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      if (entry.isSymbolicLink()) return [];
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
      const file = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      return entry.isDirectory() ? walk(file) : [file];
    }),
  );
  return nested.flat();
}

async function requireMarkers(path, markers) {
  const source = await readFile(new URL(path, root), "utf8");
  for (const marker of markers) {
    if (!source.includes(marker)) violations.push(`${path} is missing ${marker}`);
  }
}

function display(file) {
  return relative(new URL(root).pathname, file.pathname);
}

function unquote(value) {
  return value.replace(/^["']|["']$/gu, "");
}
