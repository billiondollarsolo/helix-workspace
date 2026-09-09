import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const github = new URL(".github/", root);

const files = await yamlFiles(github);
const violations = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)) {
    const action = match[1];
    const violation = mutableActionViolation(action);
    if (violation !== null) violations.push(`${display(file)} ${violation}`);
  }
}

for (const file of await sourceFiles(root)) {
  const source = await readFile(file, "utf8");
  violations.push(...secretViolations(display(file), source));
}

await requireMarkers(".github/workflows/security-supply-chain.yml", [
  "pnpm audit:prod",
  "github/codeql-action/analyze@",
  "aquasecurity/trivy-action@",
  "scanners: vuln,misconfig,secret,license",
  "severity: CRITICAL,HIGH",
  "ignore-unfixed: false",
  "exit-code: 1",
  "pnpm security:scan-history",
  "anchore/sbom-action@",
  "full-image-scan:",
]);
await requireMarkers(".github/workflows/helm-release.yml", [
  "actions/attest-build-provenance@",
  "subject-path: dist/*.tgz",
]);
await requireMarkers("security/branch-protection.json", [
  '"security-supply-chain"',
  '"strict": true',
  '"enforce_admins": true',
  '"required_conversation_resolution": true',
  '"allow_force_pushes": false',
  '"allow_deletions": false',
]);

if (process.argv.includes("--self-test")) selfTest();

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Supply-chain policy verified across ${String(files.length)} workflow files.\n`,
  );
}

async function yamlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = new URL(
        `${encodeURIComponent(entry.name)}${entry.isDirectory() ? "/" : ""}`,
        directory,
      );
      if (entry.isDirectory()) return yamlFiles(path);
      return /\.ya?ml$/u.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

async function requireMarkers(path, markers) {
  const source = await readFile(new URL(path, root), "utf8");
  violations.push(...missingMarkerViolations(path, source, markers));
}

function display(file) {
  return relative(new URL(root).pathname, file.pathname);
}

function mutableActionViolation(action) {
  if (action.startsWith("./")) return null;
  if (action.startsWith("docker://")) {
    return /@sha256:[a-f0-9]{64}$/u.test(action) ? null : `uses mutable container action ${action}`;
  }
  const revision = action.slice(action.lastIndexOf("@") + 1);
  return /^[a-f0-9]{40}$/u.test(revision) ? null : `uses mutable action ${action}`;
}

function missingMarkerViolations(path, source, markers) {
  return markers
    .filter((marker) => !source.includes(marker))
    .map((marker) => `${path} is missing ${marker}`);
}

function secretViolations(path, source) {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
    /\bAKIA[0-9A-Z]{16}\b/u,
    /\bghp_[0-9A-Za-z]{36}\b/u,
    /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/u,
  ];
  return patterns.some((pattern) => pattern.test(source))
    ? [`${path} contains a usable private key or provider credential`]
    : [];
}

async function sourceFiles(directory) {
  const ignored = new Set([".git", ".turbo", "coverage", "dist", "node_modules", "test-corpus"]);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      if (entry.isSymbolicLink() || (entry.isDirectory() && ignored.has(entry.name))) return [];
      const path = new URL(
        `${encodeURIComponent(entry.name)}${entry.isDirectory() ? "/" : ""}`,
        directory,
      );
      if (entry.isDirectory()) return sourceFiles(path);
      return /(?:^Dockerfile[^/]*|\.(?:c?js|mjs|json|md|sh|sql|ts|tsx|ya?ml))$/u.test(entry.name)
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

function selfTest() {
  const privateKey = ["-----BEGIN", " PRIVATE KEY-----"].join("");
  assert.equal(secretViolations("seeded-secret", privateKey).length, 1);
  assert.match(mutableActionViolation("actions/checkout@v4") ?? "", /mutable action/u);
  assert.equal(mutableActionViolation(`actions/checkout@${"1".repeat(40)}`), null);
  assert.equal(
    missingMarkerViolations("critical-image", "severity: HIGH", [
      "severity: CRITICAL,HIGH",
      "exit-code: 1",
    ]).length,
    2,
  );
  assert.equal(
    missingMarkerViolations("unsafe-manifest", "scanners: vuln,secret", ["misconfig"]).length,
    1,
  );
  assert.equal(
    missingMarkerViolations("unsigned-artifact", "helm package", [
      "actions/attest-build-provenance@",
    ]).length,
    1,
  );
  process.stdout.write("Seeded supply-chain failure self-test passed.\n");
}
