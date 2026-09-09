# Node filesystem low space

## Detection

`HelixNodeFilesystemLowSpace` fires when a persistent, non-ephemeral filesystem reports less than
10 percent available capacity for 10 minutes. Confirm the affected `instance` and `mountpoint`
through node-exporter; do not infer a customer or tenant from filesystem paths.

## Containment

- Pause nonessential imports, previews, reindexing, and backup staging on the affected node.
- Keep Mail, Drive, Chat, audit, and backup retention controls enabled.
- If writes may exhaust the volume before capacity can be restored, drain the application replica
  and fail over to a healthy node. Do not delete database, object, audit, or backup files manually.

## Diagnosis

- Compare available bytes, inode availability, and recent growth for the affected mount.
- Check PostgreSQL WAL, container logs, object-store versions, scan quarantine, temporary upload
  parts, and backup staging against their documented lifecycle policies.
- Confirm that the alert is not measuring an ephemeral container overlay or read-only image layer.
- Correlate worker failures and dependency health using the alert's content-free `resource_id` and
  `trace_query`.

## Recovery

- Expand the underlying encrypted volume or attach an approved replacement volume.
- Run only documented lifecycle/garbage-collection jobs for expired temporary data.
- Resume drained services gradually and confirm database, object-store, scanner, queue, and audit
  health before restoring normal ingestion.

## Verification

- Available capacity remains above 20 percent for at least 15 minutes.
- `HelixNodeFilesystemLowSpace` resolves and does not immediately refire.
- Mail dispatch, Drive upload/scan/download, Chat persistence, audit append, and backup checks pass.
- No acknowledged operation was lost or duplicated while the node was constrained.

## Rollback

If a capacity expansion or migration introduces filesystem or encryption errors, drain the node,
restore the prior mount mapping, and recover through the backup/restore runbook. Never roll back by
deleting unclassified files from a production data directory.

## Post-incident evidence

Record the alert interval, opaque node identifier, minimum free-byte ratio, containment and
recovery timestamps, capacity action, integrity checks, and assigned follow-ups. Do not record
filenames, object keys, message content, credentials, or tenant names.
