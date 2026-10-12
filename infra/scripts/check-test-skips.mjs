#!/usr/bin/env node
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// These exact tests run in a separate job with the full dependency stack: the
// real-service contracts in e2e.yml, the demo seed in quality-gates.yml
// (backend-live-demo-data).
const allowed = new Map([
  [
    "/platform/ops/real-services.integration.test.ts",
    new Set([
      "mandatory real-service contracts uses Redis and NATS instead of process-local substitutes",
      "mandatory real-service contracts uses live search, antivirus, and policy allow/deny paths",
    ]),
  ],
  [
    "/db/demo-seed/seed.integration.test.ts",
    new Set(["demo seed seeds the small preset on a fresh database and passes its own validation"]),
  ],
]);

function allowedSkip(fileName, testName) {
  for (const [suffix, names] of allowed) {
    if (fileName.endsWith(suffix) && names.has(testName)) return true;
  }
  return false;
}

export function checkTestSkips(report) {
  assert.ok(Array.isArray(report.testResults), "Missing Vitest test results");
  let skipped = 0;
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (!["pending", "skipped", "todo", "disabled"].includes(test.status)) continue;
      skipped += 1;
      const name = test.fullName.trim();
      assert.ok(allowedSkip(file.name, name), `Unexpected skipped test: ${file.name}: ${name}`);
    }
  }
  assert.equal(
    skipped,
    (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    "Skipped test total does not match individual results",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = globSync("{apps,packages}/*/vitest-results.json");
  for (const required of ["apps/helix/vitest-results.json", "apps/web/vitest-results.json"]) {
    assert.ok(paths.includes(required), `Missing test report: ${required}`);
  }
  for (const path of paths) checkTestSkips(JSON.parse(readFileSync(path, "utf8")));
  process.stdout.write(`Verified skipped-test allowlist in ${paths.length} reports.\n`);
}
