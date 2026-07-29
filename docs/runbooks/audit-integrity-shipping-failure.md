# Audit integrity or shipping failure

Owner: security and platform on-call. A hash-chain mismatch is P1.

## Detection

- Confirm hash failure, stale verification, shipping failure, lag, or backlog
  alerts.
- Record destination/job aliases, opaque resource IDs, last successful
  verification/shipment, and incident start.
- Determine whether local append, verification, or immutable export is
  affected.

## Containment

- Freeze audit schema, retention, exporter, and destructive maintenance
  changes.
- Preserve database snapshots, immutable destination state, exporter queues,
  and clock/time-source evidence.
- Restrict affected administrative operations if they cannot produce durable
  audit evidence.

## Diagnosis

- Verify the chain from the last trusted checkpoint and identify the first
  failing opaque record ID.
- Compare source counts, destination acknowledgements, ordering, checkpoints,
  credentials, clock, and recent deploy/migration events.
- Never rewrite source audit rows or include event payloads/secrets in general
  incident records.

## Recovery

- Restore exporter connectivity/credentials or revert the failing verifier.
- Replay from the last acknowledged immutable checkpoint using idempotent
  shipment.
- For a chain mismatch, restore only through the approved forensic/recovery
  process with security sign-off.

## Verification

- Run full chain verification from a trusted anchor.
- Confirm source/destination counts and checkpoints agree and shipping lag
  remains healthy for 30 minutes.
- Generate a controlled audit event and verify append, hash, shipment, and
  immutable retention.

## Rollback

- Stop replay/export if ordering, duplication, or integrity checks regress.
- Restore the prior exporter/verifier version and retain the preserved source
  and destination evidence.

## Post-incident evidence

- Preserve alerts, checkpoints, verification output, aggregate counts, opaque
  failing IDs, immutable destination receipts, version/config changes, and
  approvals.
- Record chain scope and evidence custody without copying sensitive payloads.
