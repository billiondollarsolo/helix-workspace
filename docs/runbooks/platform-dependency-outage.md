# Platform or dependency outage

Owner: platform on-call. Applies to HTTP, authorization, Postgres, Redis, NATS,
and object-store health alerts.

## Detection

- Confirm the alert is active and record its start time, `resource_id`, and
  `trace_query`.
- Compare HTTP availability, p95 latency, error rate, and dependency health on
  `Helix Workspace Operations`.
- Declare P1 when writes may be lost, authorization is unavailable, or multiple
  user-facing services are impaired.

## Containment

- Freeze deployments and configuration changes.
- Remove an unhealthy instance from service or fail over through the approved
  managed-service procedure.
- Put affected write paths into their supported unavailable/read-only mode;
  never bypass authorization or durable persistence.

## Diagnosis

- Correlate traces using the alert query and opaque resource ID.
- Check application readiness and dependency health from inside the same
  network boundary as the application.
- Compare saturation, connection-pool, timeout, recent deploy, and provider
  event timelines without copying request content into the incident record.

## Recovery

- Restore the failed dependency or route to a verified healthy replica.
- Re-enable application instances gradually and drain durable queues in bounded
  batches.
- Reconcile accepted writes and enqueue any idempotent repairs.

## Verification

- Confirm readiness, HTTP availability, latency, error rate, auth decisions,
  and dependency metrics remain healthy for 30 minutes.
- Exercise one authorized read and one reversible write per affected service.
- Verify audit events and outbox delivery for the checks.

## Rollback

- Revert the failover, routing, or release change if recovery regresses health.
- Return to the last known-good version; retain read-only mode until data
  reconciliation passes.

## Post-incident evidence

- Preserve alert transitions, dashboard snapshots, deployment/provider events,
  trace IDs, resource IDs, reconciliation totals, and the verification record.
- Record impact, root cause, owners, follow-ups, and alert/runbook corrections
  with no secrets or user content.
