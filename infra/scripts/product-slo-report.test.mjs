import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateEvidence, evaluateRuntime, percentile } from "./product-slo-report.mjs";
const policy = JSON.parse(
  await readFile(new URL("../observability/slo/product-slos.json", import.meta.url), "utf8"),
).tiers.business;
test("percentile uses the nearest-rank result", () => {
  assert.equal(percentile([1, 3, 2, 4, 5], 0.8), 4);
  assert.equal(percentile([]), undefined);
});
test("runtime evaluation consumes real Prometheus vector shapes and fails missing series", () => {
  const sample = (value, labels = {}) => ({ metric: labels, value: [1, String(value)] });
  const vectors = {
    productAvailability: ["mail", "chat", "drive", "calendar", "meet", "search"].map((product) =>
      sample(1, { product }),
    ),
    productLatency: ["mail", "chat", "drive", "calendar", "meet", "search"].map((product) =>
      sample(0.1, { product }),
    ),
    authAvailability: [sample(1)],
    authLatency: [sample(0.1)],
    searchFreshness: [sample(1)],
    meetJoin: [sample(1)],
    meetHealthy: [sample(1)],
  };
  assert.ok(evaluateRuntime(vectors, policy).every((row) => row.status === "pass"));
  vectors.productAvailability = vectors.productAvailability.filter(
    (item) => item.metric.product !== "drive",
  );
  assert.equal(
    evaluateRuntime(vectors, policy).find((row) => row.id === "drive.availability")?.status,
    "fail",
  );
});
test("periodic evidence is measured against tier objectives and fails stale/missing provenance", () => {
  const evidence = {
    schemaVersion: 1,
    period: "2026-08",
    sources: ["https://ci.example.test/runs/123"],
    samples: {
      mailQueueSeconds: [1],
      mailDeliverySeconds: [2],
      driveIntegrityChecks: { passed: 10, total: 10 },
      chatFanoutSeconds: [0.1],
      chatReplayChecks: { passed: 10, total: 10 },
      rpoSeconds: [60],
      rtoSeconds: [120],
      policyPropagationSeconds: [1],
    },
  };
  assert.ok(evaluateEvidence(evidence, policy, "2026-08").every((row) => row.status === "pass"));
  assert.equal(evaluateEvidence(evidence, policy, "2026-07")[0]?.status, "fail");
  evidence.samples.chatReplayChecks.passed = 9;
  assert.equal(
    evaluateEvidence(evidence, policy, "2026-08").find(
      (row) => row.id === "chat.replay.success_ratio",
    )?.status,
    "fail",
  );
});
