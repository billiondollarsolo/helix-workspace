# Product SLO and error-budget runbook

This runbook owns the 30-day product SLO gate. The numeric policy is
`infra/observability/slo/product-slos.json`; do not copy thresholds into application code. A missing
Prometheus series, missing periodic check, exhausted error budget, or stale/failed monthly workflow is
a release failure, not an implicit pass.

## Signals and owners

| Objective                                                          | Source                                                                                                         | Owner               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| Mail, Chat, Drive, Calendar, Meet, Search availability and API p95 | `helix_tool_invocations_total`, `helix_tool_invocation_duration_seconds`                                       | owning product team |
| Auth availability and API p95                                      | 5xx-only auth-route HTTP counters and latency histogram                                                        | Identity            |
| Mail queue and external delivery                                   | outbound worker timestamps and external IMAP receipt from `mail-deliverability-smoke.mjs`                      | Mail                |
| File durability/integrity                                          | signed backup inventory plus restored DB/object SHA-256 proof from the restore drill                           | Storage             |
| Search freshness                                                   | `helix_search_projection_lag_seconds`                                                                          | Search              |
| Chat fanout/replay                                                 | live WebSocket fanout and durable event replay checks                                                          | Realtime            |
| Meet join/healthy media                                            | signed lifecycle join histogram and bounded media-quality counters; HA evidence remains a release prerequisite | Realtime Media      |
| RPO/RTO                                                            | independent backup/PITR restore-drill timings                                                                  | Storage SRE         |
| Policy propagation                                                 | live config change followed by authorization checks from every serving role                                    | Identity/Platform   |

Tool errors are a deliberately conservative availability numerator because the current tool metric does
not separate operator failures from user-invalid requests. Auth availability counts only 5xx responses.
Do not relabel either SLI until the underlying instrumentation can make that distinction.

## Tier objectives

All tiers use a rolling 30-day window. Exact per-product API p95 values are in the policy file.

| Tier       | Product availability | Auth availability | Search freshness | Meet join p95 | Healthy media | RPO / RTO |
| ---------- | -------------------: | ----------------: | ---------------: | ------------: | ------------: | --------: |
| Personal   |                99.5% |             99.9% |             300s |           10s |           98% |  24h / 4h |
| Business   |                99.9% |            99.95% |             120s |            5s |           99% |   4h / 2h |
| Enterprise |               99.95% |            99.99% |              60s |            4s |         99.5% |   1h / 1h |
| Sovereign  |               99.95% |            99.99% |              60s |            4s |         99.5% | 15m / 30m |

Availability budget is `1 - objective`; budget consumed is `(1 - observed) / budget`. Runtime alerts use
the strictest supported tier: 14.4x over both 5m and 1h pages quickly, while 6x over both 30m and 6h
warns on a sustained burn. Search freshness and Meet healthy-media alerts also use strictest-tier targets.

## Periodic evidence contract

The evidence collector publishes one access-controlled JSON document per month. `sources` must contain
immutable CI run or artifact references; the report refuses an empty list or a different period. Arrays
contain measured seconds, and check objects contain actual passed/total counts.

```json
{
  "schemaVersion": 1,
  "period": "2026-08",
  "sources": ["https://ci.example/runs/immutable-id"],
  "samples": {
    "mailQueueSeconds": [],
    "mailDeliverySeconds": [],
    "driveIntegrityChecks": { "passed": 0, "total": 0 },
    "chatFanoutSeconds": [],
    "chatReplayChecks": { "passed": 0, "total": 0 },
    "rpoSeconds": [],
    "rtoSeconds": [],
    "policyPropagationSeconds": []
  }
}
```

Only populate this document from the live gates listed above. Zero samples fail closed. The scheduled
`Product SLO Report` workflow queries the recording rules, evaluates this evidence, retains the report,
and exits nonzero on every missed or absent objective. Helm publication checks the most recent completed
report and refuses a failed report or one older than 35 days.

## Triage

1. Open the alert and current monthly report. Confirm whether the miss is runtime telemetry, periodic
   evidence, or missing data. Missing data is an observability incident; do not waive it.
2. Page the owner in the table. For a fast burn, freeze rollouts and roll back the latest correlated
   release. For a slow burn, stop unrelated risk and prepare remediation before the budget is exhausted.
3. Split by region, deployment, product/tool, and status. Do not add tenant or user identity labels.
4. Follow the product-specific recovery: drain unhealthy Meet bridges, pause broken indexers/outbound
   workers, fail storage writes closed on checksum mismatch, or roll back auth/policy configuration.
5. Re-run the real capability gate and the report. A green unit/static test is not recovery evidence.

Mail incidents additionally follow [`mail-deliverability.md`](mail-deliverability.md) for postmaster,
abuse, external authentication seed, and operator-controlled provider failover evidence.

Local wiring validation is safe and does not claim a live burn test:

```sh
pnpm quality:product-slos
bash infra/scripts/validate-helm.sh
```

For an operator-authorized report:

```sh
HELIX_SLO_TIER=enterprise \
HELIX_SLO_PERIOD=2026-08 \
HELIX_SLO_PROMETHEUS_URL=https://prometheus.example \
HELIX_SLO_EVIDENCE=/secure/evidence/2026-08.json \
HELIX_SLO_REPORT_OUTPUT=/secure/reports/2026-08.json \
node infra/scripts/product-slo-report.mjs
```

The Prometheus token is optional for mTLS/front-proxy deployments and otherwise belongs only in
`HELIX_SLO_PROMETHEUS_TOKEN`; never place it in the report or repository.

The local Grafana stack provisions `Helix Product SLOs` from
`infra/observability/grafana/dashboards/product-slos.json` for runtime triage.

`Helix Capability Health` exposes the producer-level signals behind those objectives. For
`HelixOperationalFailure`, isolate the `capability` and `operation`; for
`HelixMailDeliveryFailure`, inspect the durable outbound/dead-letter queue before replay; for
`HelixSearchReconciliationDrift`, stop unsafe search promotion until consecutive reconciliations report
zero `drift_objects`. Keep labels bounded to the documented capability, operation, status, and measure
values; use traces for tenant or object-level diagnosis.
