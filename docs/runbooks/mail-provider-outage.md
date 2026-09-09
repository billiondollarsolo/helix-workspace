# Mail provider outage or queue backlog

Owner: Mail on-call. Coordinate with the approved mail provider for external
acceptance failures.

## Detection

- Confirm Mail receive/send p95, provider failure, outbox depth, and oldest-age
  signals.
- Record provider status, incident start, `resource_id`, and trace query.
- Distinguish inbound acceptance, outbound submission, webhook ingestion, and
  local worker failures.

## Containment

- Preserve queued mail and freeze Mail deployments.
- Stop aggressive retries and cap new bulk/automation sends if provider
  throttling or rejection is increasing.
- Keep interactive status truthful; do not report queued mail as delivered.

## Diagnosis

- Compare provider status and response-class aggregates with local dependency,
  worker, and outbox metrics.
- Validate credentials and network reachability through approved secret-safe
  checks; never print credentials, recipients, subjects, or bodies.
- Trace sampled opaque message resource IDs across enqueue, submission, and
  provider-event stages.

## Recovery

- Restore provider connectivity or activate the preapproved alternate route.
- Resume one worker cohort and drain oldest-first at a rate accepted by the
  provider.
- Reconcile provider acknowledgements before retrying ambiguous submissions.

## Verification

- Confirm receive/send latency, failure rate, queue depth, and oldest age stay
  healthy for 30 minutes.
- Send controlled synthetic inbound and outbound messages and verify accepted,
  searchable, and delivery-event states.
- Confirm audit records exist and no duplicate submissions occurred.

## Rollback

- Return traffic to the prior provider route if failover degrades reputation or
  delivery.
- Pause consumers and restore the last known-good Mail worker configuration;
  preserve all queued records.

## Post-incident evidence

- Retain provider incident references, alert graphs, route/config versions,
  trace and resource IDs, queue reconciliation totals, and synthetic results.
- Redact addresses, message content, credentials, and provider tokens.
