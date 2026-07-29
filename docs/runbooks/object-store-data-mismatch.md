# Object-store outage or data mismatch

Owner: Drive and platform on-call. Escalate any integrity mismatch as P1.

## Detection

- Confirm object-store dependency, Drive upload failure, or integrity-mismatch
  alerts.
- Record the bucket/service alias, opaque object resource IDs, and first known
  mismatch time.
- Determine whether reads, writes, or metadata consistency are affected.

## Containment

- Freeze destructive lifecycle actions and affected writes.
- Put impacted objects or the Drive service into read-only/unavailable mode;
  never serve bytes whose integrity is uncertain.
- Preserve versions, replicas, audit logs, and provider evidence.

## Diagnosis

- Compare database metadata, version records, object headers, checksums, and
  provider replication/versioning state using opaque IDs.
- Check credentials, endpoint/DNS, clock, encryption-key availability, recent
  migrations, and lifecycle jobs.
- Do not log filenames, object keys, content, or secret material.

## Recovery

- Restore service connectivity or fail over through the approved storage
  procedure.
- Recover affected versions from a verified replica/backup and update metadata
  only through the reconciliation workflow.
- Re-enable writes in a small cohort after checksum comparisons pass.

## Verification

- Hash-compare a representative corpus, including versions and range reads.
- Verify upload/download policy, quarantine state, database references, audit
  events, and object-store health for 30 minutes.
- Confirm no orphaned, cross-tenant, or silently substituted objects.

## Rollback

- Stop reconciliation and disable the recovered route if any checksum or
  authorization check fails.
- Return to the preserved version/replica and keep affected resources
  unavailable pending review.

## Post-incident evidence

- Preserve provider events, alert graphs, opaque IDs, checksum comparison
  totals, reconciliation manifests, approvals, and verification results.
- Record RPO/RTO impact without including names, keys, or object contents.
