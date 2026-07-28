# Drive scanner outage or quarantine backlog

Owner: Drive and security on-call.

## Detection

- Confirm scanner availability, queue depth, p95 latency, verdict rate, and
  quarantined-byte alerts.
- Record scanner/queue resource IDs and the oldest affected upload time.
- Determine whether uploads remain safely quarantined.

## Containment

- Enforce fail-closed quarantine for every unscanned, failed, timed-out, or
  unsupported upload.
- Disable download, preview, sharing, attachment, indexing, WebDAV, and agent
  reads for the affected cohort.
- Throttle new uploads if quarantine storage or queue capacity is threatened.

## Diagnosis

- Check scanner process health, signatures, limits, network, queue workers, and
  object-store availability.
- Correlate opaque file resource IDs with upload, scan, and quarantine audit
  events without exposing filenames or object keys.
- Compare ingress and scan-completion rates to estimate drain time.

## Recovery

- Restore a scanner with current signatures and validate its fail-closed
  response mapping.
- Re-scan oldest-first in bounded batches and release only explicit clean
  verdicts through normal policy.
- Scale workers only while scanner and object-store saturation remain healthy.

## Verification

- Confirm availability, p95 latency, queue depth, and oldest age remain healthy
  for 30 minutes.
- Exercise clean, malware-test, timeout, and unsupported uploads and verify
  their exact access states.
- Confirm quarantined bytes are not exposed and releases are audited.

## Rollback

- Stop queue draining if invalid releases, scanner errors, or storage pressure
  appears.
- Return to the last known-good scanner configuration and quarantine every
  uncertain result.

## Post-incident evidence

- Capture alert history, scanner/signature versions, queue and byte graphs,
  opaque IDs, state-transition audits, test results, and capacity changes.
- Keep sample contents and filenames out of general incident records.
