# ADR-0006: Business-pilot availability and recovery targets

- **Status:** Accepted
- **Date:** 2026-07-28
- **Plan decision:** RD-6

## Context

The initial one-organization deployment needs measurable reliability targets without presenting a
single-region pilot as highly available or offering an unsupported contractual SLA. Recovery
targets determine backup frequency, off-host retention, restoration automation, monitoring, and
release evidence.

RPO is the maximum acceptable window of data loss measured backward from an incident. RTO is the
maximum target time to restore the service after recovery begins.

## Decision

For the Business pilot:

- target **99.5% monthly availability**;
- require an **RPO of no more than 24 hours**; and
- require an **RTO of no more than 4 hours**.

These are engineering objectives and pilot release gates, not a contractual SLA or a claim of
high availability. Encrypted database backups and object-store recovery points must be tied
together by a manifest. A full restore into a disposable environment must demonstrate the RTO and
sampled data integrity.

## Alternatives considered

- **99.9%, one-hour RPO, two-hour RTO:** deferred because it requires continuous recovery,
  replicated storage, stronger redundancy, and a staffed operational model not yet proven.
- **Best effort with no target:** rejected because it gives neither operators nor pilot users a
  meaningful recovery expectation.
- **Database-only recovery:** rejected because file bytes, metadata, queues, audit state, and search
  reconstruction must be consistent.

## Consequences

- Missing, stale, unencrypted, or untested backups block the pilot.
- Monitoring must report availability and backup age; alerts must link to recovery runbooks.
- Restore drills must record timestamps, recovery points, hashes, and reconciliation of database
  and object state.
- Documentation must avoid stronger availability or data-loss guarantees unless a later ADR and
  evidence support them.

## Reversal triggers

Raise or contractually guarantee the targets only after architecture, staffing, monitoring,
replication, restore automation, load/failure tests, and incident history demonstrate the stronger
service level. Lowering a target also requires owner review because it changes pilot risk.
