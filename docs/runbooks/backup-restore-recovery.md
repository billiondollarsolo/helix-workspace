# Backup restore and total deployment recovery

Owner: incident commander with platform, security, and each data-service owner.
Target the pilot objectives of RPO no more than 24 hours and RTO no more than
four hours.

## Detection

- Confirm stale/missing backup or restore-drill alerts, or declare recovery
  after verified data loss or total deployment failure.
- Record last successful backup, last successful restore drill, incident start,
  and affected service/resource aliases.
- Establish the required recovery point before changing the failed environment.

## Containment

- Stop writes, lifecycle deletion, queue consumers, and replication paths that
  could propagate corruption.
- Preserve database/object versions, WAL, backup catalogs, audit destinations,
  encryption-key access, and provider evidence.
- Establish an isolated recovery environment; do not restore over production.

## Diagnosis

- Inventory Postgres, object storage/versions, outbox, audit chain, search,
  Redis, NATS, configuration, and secret dependencies.
- Select the newest backup and point-in-time target that are complete,
  decryptable, immutable, and earlier than corruption.
- Validate manifests and checksums without exposing object names or secret
  material.

## Recovery

- Follow [the primary backup/restore procedure](../RUNBOOK.md#restore) to restore
  Postgres and object storage into the isolated environment.
- Apply migrations only for the restored application version, rebuild derived
  search/index/cache state, and keep external-send consumers paused.
- Reconcile objects, versions, outbox, audit chain, and pending external effects;
  then perform a controlled cutover.

## Verification

- Run readiness/auth checks, full audit-chain verification, object/version
  checksum sampling, queue reconciliation, search checks, and representative
  Mail/Drive/Chat/agent flows.
- Measure actual recovery point and recovery time and compare them with the
  objectives.
- Keep external effects paused until duplicate/loss reconciliation passes.

## Rollback

- Abort cutover and return traffic to the preserved environment if integrity,
  authorization, or critical-path checks fail.
- If cutover already occurred, stop writes and recover again from the preserved
  source using a corrected point/version; never destroy either evidence set.

## Post-incident evidence

- Preserve incident timeline, backup IDs/manifests, point-in-time target,
  checksum/count comparisons, audit verification, queue reconciliation,
  readiness tests, cutover approvals, and measured RPO/RTO.
- Record every unmet objective with an owner and due date; keep keys, secrets,
  filenames, and user content out of the evidence bundle.
