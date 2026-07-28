# Drive live evidence

`node infra/scripts/drive-live-evidence-smoke.mjs` emits a truthful static `not_run` report when
live dependencies are unavailable. It never converts unit-test coverage into production evidence.

The strict report contract requires exactly these cases:

- clean browser upload, clean scan, download, and SHA-256 comparison;
- EICAR quarantine and denial on every retrieval surface;
- multipart upload with provider SSE/KMS metadata;
- a synthetic 1 GiB stream with bounded process-memory evidence;
- WebDAV PUT quarantine and retrieval denial;
- public-link download followed by immediate revoke denial;
- restart recovery between upload/finalize/scan;
- backup/restore preservation of bytes, versions, sizes, and hashes.

An external live harness writes a JSON report with `schemaVersion: 2`, `mode: "live"`, an overall
`status: "passed"`, canonical start/completion timestamps, and a `durationMs` equal to the elapsed
wall-clock time. It must contain one entry per required case. Every passing entry requires matching
timestamps/duration, case-specific measured metrics, and at least one structured evidence
reference:

```json
{
  "source": "browser",
  "ref": "drive/clean-upload/browser-trace",
  "observedAt": "2026-07-28T20:00:01.000Z"
}
```

Sources are restricted to `api`, `backup`, `browser`, `clamav`, `database`, `metric`,
`object_store`, `process`, `restore`, and `webdav`; references are content-free identifiers, not
URLs. Sensitive field names are rejected recursively. Required metrics are:

Legacy schema-version 1 reports did not carry enough live/timing/measurement data and are
intentionally rejected by the release gate.

| Case                 | Required metrics                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `clean_upload_hash`  | positive `uploadBytes`, nonnegative `scanLatencyMs`, `hashMatched: true`                                            |
| `eicar_denied`       | positive equal `retrievalSurfacesChecked`/`deniedSurfaces`, nonnegative `scanLatencyMs`                             |
| `multipart_sse`      | positive `uploadBytes`, at least two parts, `serverSideEncryptionVerified: true`                                    |
| `gib_bounded_memory` | at least 1 GiB uploaded, RSS growth and bound, `withinMemoryBound: true`; measured growth must not exceed the bound |
| `webdav_quarantine`  | positive equal checked/denied surface counts, `lockCycleVerified: true`                                             |
| `share_revoke`       | nonnegative `revokeLatencyMs`, revoke denial and expiration both verified                                           |
| `restart_recovery`   | positive restart count, nonnegative `recoveryMs`, `hashMatched: true`                                               |
| `backup_restore`     | positive restored-file/version counts and `hashMatched: true`                                                       |

Validate it with:

```sh
node infra/scripts/drive-live-evidence-smoke.mjs /path/to/report.json --require-pass
```

The command exits non-zero for missing/duplicate cases, invalid or mismatched statuses/timings,
unmeasured or unevidenced passes, sensitive fields, or any case that is not `pass` under
`--require-pass`.

Require the same report during release-manifest creation:

```sh
pnpm quality:release-readiness-manifest -- \
  --evidence-dir "$evidence_dir" \
  --drive-live-evidence drive-live-evidence.json \
  <application and web image digest options>
```

The manifest records only each case's status, elapsed time, and allowlisted metrics. Evidence
references and any deployment-specific identifiers remain in the hashed artifact, not the
manifest.
