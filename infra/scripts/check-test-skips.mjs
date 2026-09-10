#!/usr/bin/env node
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// These exact two contracts run in e2e.yml with the full dependency stack.
const allowed = new Set([
  "mandatory real-service contracts uses Redis and NATS instead of process-local substitutes",
  "mandatory real-service contracts uses live search, antivirus, and policy allow/deny paths",
]);

export function checkTestSkips(report) {
  assert.ok(Array.isArray(report.testResults), "Missing Vitest test results");
  let skipped = 0;
  for (const file of report.testResults) {
    for (const test of file.assertionResults) {
      if (!["pending", "skipped", "todo", "disabled"].includes(test.status)) continue;
      skipped += 1;
      const name = test.fullName.trim();
      assert.ok(
        file.name.endsWith("/platform/ops/real-services.integration.test.ts") && allowed.has(name),
        `Unexpected skipped test: ${file.name}: ${name}`,
      );
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
