# Outbox or worker backlog

Owner: platform on-call with the owning feature team.

## Detection

- Confirm queue depth, oldest-item age, and worker failure-rate alerts.
- Record the affected worker alias, opaque resource ID, and incident window.
- Determine whether producers are healthy, slow, retrying, or fully stopped.

## Containment

- Freeze worker deployments and preserve the durable queue.
- Throttle nonessential producers when growth threatens capacity.
- Pause only the failing consumer class when retries amplify provider load;
  never delete or manually mark queued work complete.

## Diagnosis

- Inspect worker error categories, retry counts, dependency health, and the
  alert's trace query.
- Compare queue ingress and completion rates and identify the oldest safe
  retryable cohort.
- Check recent schema, credential, network, and provider changes.

## Recovery

- Correct the dependency or worker fault and restart a single consumer.
- Drain in bounded batches with normal idempotency and retry controls.
- Scale consumers only after downstream health and completion rate are stable.

## Verification

- Confirm failures stop, queue depth decreases monotonically, and oldest age
  returns below threshold.
- Sample completed resource IDs and verify their expected audit/outbox states.
- Confirm no duplicate external effects were produced.

## Rollback

- Stop the recovered consumer if failures, duplicates, or downstream pressure
  return.
- Revert the worker release or configuration and leave records durable for the
  next controlled attempt.

## Post-incident evidence

- Capture alert history, queue-rate graphs, worker version, dependency events,
  sampled opaque IDs, reconciliation counts, and verification results.
- Document the retry or capacity correction and its owner.
