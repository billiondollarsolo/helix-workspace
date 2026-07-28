# Chat, NATS, or Redis outage

Owner: Chat and platform on-call.

## Detection

- Confirm active-socket telemetry, publish p95, reconnect, rejected-frame, and
  dependency alerts.
- Record affected service/dependency aliases, resource IDs, and incident start.
- Separate client connectivity, NATS fan-out, Redis presence/rate limiting, and
  database persistence symptoms.

## Containment

- Freeze Chat deployments and remove unhealthy instances from service.
- Preserve durable message writes and clearly degrade realtime/presence
  features; never bypass room authorization or rate limits.
- Apply bounded reconnect backoff to prevent a retry storm.

## Diagnosis

- Compare socket counts, reconnects, rejected frames, publish latency, NATS
  consumer/stream health, Redis health, and database commits.
- Correlate trace/resource IDs across authorization, persistence, publish, and
  delivery without copying message content.
- Check recent deploys, credentials, network policy, saturation, and cluster
  leadership changes.

## Recovery

- Restore the failed dependency or fail over through its approved procedure.
- Reintroduce instances gradually and replay only durable, idempotent work.
- Relax reconnect controls in stages after publish latency stabilizes.

## Verification

- Confirm socket telemetry, publish latency, reconnects, rejected frames, and
  dependency health remain normal for 30 minutes.
- Exercise authorized and unauthorized room joins plus multi-instance message
  delivery.
- Verify persistence, ordering expectations, and audit events.

## Rollback

- Remove the recovered dependency/instance if fan-out, authorization, or
  persistence regresses.
- Restore the previous release/configuration and keep realtime features
  degraded rather than risking unauthorized delivery.

## Post-incident evidence

- Capture alert graphs, cluster/provider events, version/config changes, opaque
  trace/resource IDs, reconnect controls, and synthetic results.
- Exclude chat content and personal data from incident evidence.
