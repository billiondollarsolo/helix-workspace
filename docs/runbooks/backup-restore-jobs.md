# Backup Restore Jobs

The Admin API never restores a backup in the request process. It records an isolated restore job
with the configured approval requirement and lets the leader-elected restore worker execute it
under a database lease.

## Access and approval

- Grant `admin.backups.restore` only to recovery operators. `admin.config.write` and
  `admin.config.*` cannot request, approve, inspect, or cancel restores.
- Mutating restore requests require recent MFA when the workspace's sensitive-action MFA setting
  is enabled.
- New jobs require one other recovery administrator's approval when second-admin approval is on,
  or zero approvals when it is off. The requester cannot approve their own job.
- Each job retains its creation-time `requiredApprovals` count. Older jobs requiring two distinct
  approvers still require both; changing policy does not release an existing pending job.
- Request, approval, cancellation, execution start, completion, and failure are appended directly to
  the hash-chained activity audit. If the execution-start audit cannot be written, restore does not run.

Choose these controls in [Admin → Policies](account-offboarding-and-admin-safeguards.md#choose-administrator-safeguards).
They do not remove restore permissions or isolated-target restrictions.

## Request a restore

Choose a new database and new object bucket. The API only accepts database names beginning
`helix_restore_` and buckets beginning `helix-restore-`. The worker never passes
`--allow-drop-target`, so an expired lease or retry cannot drop an existing partial or completed
target.

```sh
helix restore \
  --from backup-20260903T120000Z \
  --target-db helix_restore_incident_20260903 \
  --target-bucket helix-restore-incident-20260903 \
  --idempotency-key incident-20260903
```

Keep the idempotency key stable when retrying the request. A repeated key returns the same job; using
that key with different backup or target parameters is rejected.

## Inspect, approve, or cancel

Use a recovery-admin session with any currently required MFA step-up for mutations.
Inspect `requiredApprovals` before submitting approvals. The second approval below is only
needed for an existing job that requires two:

```sh
curl -H "Authorization: Bearer $HELIX_RECOVERY_TOKEN" \
  "$HELIX_BASE_URL/api/admin/restores/$JOB_ID"

curl -X POST -H "Authorization: Bearer $HELIX_APPROVER_ONE_TOKEN" \
  "$HELIX_BASE_URL/api/admin/restores/$JOB_ID/approvals"
curl -X POST -H "Authorization: Bearer $HELIX_APPROVER_TWO_TOKEN" \
  "$HELIX_BASE_URL/api/admin/restores/$JOB_ID/approvals"

curl -X POST -H "Authorization: Bearer $HELIX_RECOVERY_TOKEN" \
  "$HELIX_BASE_URL/api/admin/restores/$JOB_ID/cancel"
```

Cancellation is immediate while approval is pending or the job is queued. During execution it is a
durable cancellation request; the worker aborts the restore process and records `cancelled`. A
`processing` job with an expired lease is reclaimable after a worker restart. Because targets are
isolated and never dropped, ambiguous partial work fails visibly instead of being overwritten.

Do not route the restored bucket or database into production from this job. Validate the isolated
result first and use the separately controlled promotion procedure.
