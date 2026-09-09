#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("../../", import.meta.url);
const policyUrl = new URL("infra/observability/slo/product-slos.json", root);
const products = ["mail", "chat", "drive", "calendar", "meet", "search"];

export function percentile(values, quantile = 0.95) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  return sorted.length ? sorted[Math.ceil(sorted.length * quantile) - 1] : undefined;
}

export function evaluateEvidence(evidence, objectives, period) {
  const rows = [];
  const add = (id, observed, target, operator) => {
    const valid = Number.isFinite(observed);
    rows.push({
      id,
      source: "periodic-gates",
      observed: valid ? observed : null,
      target,
      operator,
      status:
        valid && (operator === ">=" ? observed >= target : observed <= target) ? "pass" : "fail",
    });
  };
  if (
    evidence?.schemaVersion !== 1 ||
    evidence?.period !== period ||
    !Array.isArray(evidence?.sources) ||
    evidence.sources.length === 0
  ) {
    return [
      {
        id: "periodic-evidence",
        source: "periodic-gates",
        observed: null,
        target: "current signed/immutable run references",
        operator: "present",
        status: "fail",
      },
    ];
  }
  const samples = evidence.samples ?? {};
  add(
    "mail.queue.p95_seconds",
    percentile(samples.mailQueueSeconds ?? []),
    objectives.mail.queueP95Seconds,
    "<=",
  );
  add(
    "mail.delivery.p95_seconds",
    percentile(samples.mailDeliverySeconds ?? []),
    objectives.mail.deliveryP95Seconds,
    "<=",
  );
  add(
    "drive.integrity.ratio",
    ratio(samples.driveIntegrityChecks),
    objectives.drive.verifiedIntegrity,
    ">=",
  );
  add(
    "chat.fanout.p95_seconds",
    percentile(samples.chatFanoutSeconds ?? []),
    objectives.chat.fanoutP95Seconds,
    "<=",
  );
  add(
    "chat.replay.success_ratio",
    ratio(samples.chatReplayChecks),
    objectives.chat.replaySuccessRatio,
    ">=",
  );
  add("recovery.rpo_seconds", maximum(samples.rpoSeconds), objectives.recovery.rpoSeconds, "<=");
  add("recovery.rto_seconds", maximum(samples.rtoSeconds), objectives.recovery.rtoSeconds, "<=");
  add(
    "policy.propagation.p95_seconds",
    percentile(samples.policyPropagationSeconds ?? []),
    objectives.policy.propagationP95Seconds,
    "<=",
  );
  return rows;
}

export function evaluateRuntime(vectors, objectives) {
  const rows = [];
  for (const product of products) {
    addRuntime(
      rows,
      `${product}.availability`,
      vectorValue(vectors.productAvailability, "product", product),
      objectives.availability[product],
      ">=",
    );
    addRuntime(
      rows,
      `${product}.api_p95_seconds`,
      vectorValue(vectors.productLatency, "product", product),
      objectives.apiP95Seconds[product],
      "<=",
    );
  }
  addRuntime(
    rows,
    "auth.availability",
    scalarValue(vectors.authAvailability),
    objectives.availability.auth,
    ">=",
  );
  addRuntime(
    rows,
    "auth.api_p95_seconds",
    scalarValue(vectors.authLatency),
    objectives.apiP95Seconds.auth,
    "<=",
  );
  addRuntime(
    rows,
    "search.freshness_seconds",
    scalarValue(vectors.searchFreshness),
    objectives.search.freshnessSeconds,
    "<=",
  );
  addRuntime(
    rows,
    "meet.join_p95_seconds",
    scalarValue(vectors.meetJoin),
    objectives.meet.joinP95Seconds,
    "<=",
  );
  addRuntime(
    rows,
    "meet.healthy_media_ratio",
    scalarValue(vectors.meetHealthy),
    objectives.meet.healthyMediaRatio,
    ">=",
  );
  return rows;
}

function addRuntime(rows, id, observed, target, operator) {
  const valid = Number.isFinite(observed);
  const row = {
    id,
    source: "prometheus-30d",
    observed: valid ? observed : null,
    target,
    operator,
    status:
      valid && (operator === ">=" ? observed >= target : observed <= target) ? "pass" : "fail",
  };
  if (id.endsWith(".availability") && valid) {
    row.errorBudgetConsumed = Math.max(0, (1 - observed) / (1 - target));
  }
  rows.push(row);
}

function ratio(value) {
  const passed = Number(value?.passed);
  const total = Number(value?.total);
  return Number.isFinite(passed) && Number.isFinite(total) && total > 0
    ? passed / total
    : undefined;
}

function maximum(values) {
  const valid = Array.isArray(values) ? values.filter(Number.isFinite) : [];
  return valid.length ? Math.max(...valid) : undefined;
}

function vectorValue(result, label, value) {
  const sample = result?.find((item) => item.metric?.[label] === value);
  return sample ? Number(sample.value?.[1]) : undefined;
}

function scalarValue(result) {
  return result?.length === 1 ? Number(result[0].value?.[1]) : undefined;
}

async function query(prometheusUrl, token, expression) {
  const url = new URL("/api/v1/query", prometheusUrl);
  url.searchParams.set("query", expression);
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!response.ok)
    throw new Error(`Prometheus query failed (${response.status}) for ${expression}`);
  const body = await response.json();
  if (body.status !== "success" || body.data?.resultType !== "vector")
    throw new Error(`Prometheus returned an invalid vector for ${expression}`);
  return body.data.result;
}

async function loadRuntime(url, token) {
  const expressions = {
    productAvailability: "helix:slo_product_availability:ratio_30d",
    productLatency: "helix:slo_product_latency:p95_seconds_30d",
    authAvailability: "helix:slo_auth_availability:ratio_30d",
    authLatency: "helix:slo_auth_latency:p95_seconds_30d",
    searchFreshness: "helix:slo_search_freshness:seconds",
    meetJoin: "helix:slo_meet_join_latency:p95_seconds_30d",
    meetHealthy: "helix:slo_meet_healthy_media:ratio_30d",
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(expressions).map(async ([key, expression]) => [
        key,
        await query(url, token, expression),
      ]),
    ),
  );
}

function validatePolicy(policy) {
  if (policy.schemaVersion !== 1 || policy.windowDays !== 30)
    throw new Error("product SLO policy schema is unsupported");
  for (const [tier, objectives] of Object.entries(policy.tiers ?? {})) {
    for (const product of products) {
      if (
        !Number.isFinite(objectives.availability?.[product]) ||
        !Number.isFinite(objectives.apiP95Seconds?.[product])
      )
        throw new Error(`${tier} is missing ${product} API objectives`);
    }
    for (const path of [
      "mail.queueP95Seconds",
      "mail.deliveryP95Seconds",
      "drive.verifiedIntegrity",
      "search.freshnessSeconds",
      "chat.fanoutP95Seconds",
      "chat.replaySuccessRatio",
      "meet.joinP95Seconds",
      "meet.healthyMediaRatio",
      "recovery.rpoSeconds",
      "recovery.rtoSeconds",
      "policy.propagationP95Seconds",
    ]) {
      if (!Number.isFinite(path.split(".").reduce((value, key) => value?.[key], objectives)))
        throw new Error(`${tier} is missing ${path}`);
    }
  }
}

async function main() {
  const policy = JSON.parse(await readFile(policyUrl, "utf8"));
  validatePolicy(policy);
  if (process.argv.includes("--static")) {
    const rules = await readFile(
      new URL("infra/helm/helix/files/helix-product-slos.yml", root),
      "utf8",
    );
    const dashboard = await readFile(
      new URL("infra/observability/grafana/dashboards/product-slos.json", root),
      "utf8",
    );
    for (const name of [
      "helix:slo_product_availability:ratio_30d",
      "helix:slo_auth_availability:ratio_30d",
      "HelixProductAvailabilityFastBurn",
      "HelixAuthAvailabilitySlowBurn",
    ]) {
      if (!rules.includes(name)) throw new Error(`product SLO rule is missing ${name}`);
    }
    for (const name of [
      "helix:slo_product_availability:ratio_30d",
      "helix:slo_product_errors:ratio_5m",
      "helix:slo_product_latency:p95_seconds_30d",
      "helix:slo_search_freshness:seconds",
      "helix:slo_meet_healthy_media:ratio_30d",
    ]) {
      if (!dashboard.includes(name)) throw new Error(`product SLO dashboard is missing ${name}`);
    }
    JSON.parse(dashboard);
    process.stdout.write("product SLO policy, rules, and dashboard are valid\n");
    return;
  }

  const tier = requiredEnv("HELIX_SLO_TIER");
  const objectives = policy.tiers[tier];
  if (!objectives) throw new Error(`unknown HELIX_SLO_TIER: ${tier}`);
  const period = requiredEnv("HELIX_SLO_PERIOD");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(period)) throw new Error("HELIX_SLO_PERIOD must be YYYY-MM");
  const evidence = JSON.parse(await readFile(resolve(requiredEnv("HELIX_SLO_EVIDENCE")), "utf8"));
  const vectors = await loadRuntime(
    requiredEnv("HELIX_SLO_PROMETHEUS_URL"),
    process.env.HELIX_SLO_PROMETHEUS_TOKEN ?? "",
  );
  const rows = [
    ...evaluateRuntime(vectors, objectives),
    ...evaluateEvidence(evidence, objectives, period),
  ];
  const report = {
    schemaVersion: 1,
    period,
    tier,
    generatedAt: new Date().toISOString(),
    windowDays: policy.windowDays,
    releaseBlocked: rows.some((row) => row.status !== "pass"),
    rows,
    sources: evidence.sources,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.HELIX_SLO_REPORT_OUTPUT)
    await writeFile(resolve(process.env.HELIX_SLO_REPORT_OUTPUT), output, { mode: 0o600 });
  else process.stdout.write(output);
  if (report.releaseBlocked) process.exitCode = 1;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
