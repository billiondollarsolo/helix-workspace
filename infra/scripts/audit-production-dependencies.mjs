#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  auditProductionDependencies();
}

function auditProductionDependencies() {
  const exceptions = JSON.parse(
    readFileSync(
      new URL("../../security/dependency-audit-exceptions.json", import.meta.url),
      "utf8",
    ),
  );
  const audit = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  if (audit.error) throw audit.error;

  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    process.stderr.write(audit.stderr || audit.stdout);
    throw new Error("pnpm audit did not return JSON");
  }

  const result = classifyAdvisories(report, exceptions, new Date().toISOString().slice(0, 10));
  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(
    `Production dependency audit: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate, ${counts.low ?? 0} low.`,
  );
  for (const item of result.accepted) console.log(`Accepted time-bounded exception: ${item}`);
  for (const item of result.blocking) console.error(`Blocking advisory: ${item}`);
  if (result.blocking.length > 0) process.exitCode = 1;
}

function classifyAdvisories(report, exceptions, today) {
  const exceptionByAdvisory = new Map(exceptions.map((entry) => [entry.advisory, entry]));
  const blocking = [];
  const accepted = [];

  for (const advisory of Object.values(report.advisories ?? {})) {
    if (advisory.severity !== "critical" && advisory.severity !== "high") continue;
    const id = advisory.url?.split("/").at(-1);
    const exception = exceptionByAdvisory.get(id);
    if (exception !== undefined && exception.expires >= today) {
      accepted.push(`${id} (${exception.dependency}; expires ${exception.expires})`);
    } else {
      blocking.push(`${id ?? advisory.module_name}: ${advisory.title}`);
    }
  }
  return { accepted, blocking };
}

function selfTest() {
  const report = {
    advisories: {
      1: {
        severity: "critical",
        module_name: "seeded-critical",
        title: "Seeded critical dependency",
        url: "https://github.com/advisories/GHSA-seed-crit",
      },
      2: {
        severity: "high",
        module_name: "seeded-expired",
        title: "Seeded expired exception",
        url: "https://github.com/advisories/GHSA-seed-old",
      },
      3: {
        severity: "high",
        module_name: "seeded-accepted",
        title: "Seeded accepted exception",
        url: "https://github.com/advisories/GHSA-seed-ok",
      },
    },
  };
  const result = classifyAdvisories(
    report,
    [
      { advisory: "GHSA-seed-old", dependency: "seeded-expired", expires: "2025-01-01" },
      { advisory: "GHSA-seed-ok", dependency: "seeded-accepted", expires: "2099-01-01" },
    ],
    "2026-09-02",
  );
  assert.deepEqual(result.blocking, [
    "GHSA-seed-crit: Seeded critical dependency",
    "GHSA-seed-old: Seeded expired exception",
  ]);
  assert.deepEqual(result.accepted, ["GHSA-seed-ok (seeded-accepted; expires 2099-01-01)"]);
  console.log("Dependency audit policy self-test passed.");
}
