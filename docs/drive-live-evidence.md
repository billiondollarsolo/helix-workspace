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

An external live harness writes a JSON report with `schemaVersion: 1`, one entry per required case,
and non-empty evidence references for every `pass`. Validate it with:

```sh
node infra/scripts/drive-live-evidence-smoke.mjs /path/to/report.json --require-pass
```

The command exits non-zero for missing/duplicate cases, invalid statuses, unevidenced passes, or
any case that is not `pass` under `--require-pass`.
