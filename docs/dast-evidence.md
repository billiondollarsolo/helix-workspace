# V5 DAST evidence

V5 uses the official OWASP ZAP stable container pinned to:

```text
ghcr.io/zaproxy/zaproxy:stable@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2
```

Run it only against a disposable environment that you own or are explicitly authorized to test.
The runner requires an explicit `--confirm-disposable-target` acknowledgement. It accepts an
origin-only HTTPS URL, or HTTP/HTTPS on an explicit loopback hostname. URL userinfo, query strings,
fragments, non-root paths, and plaintext non-loopback targets are rejected so credentials and
secret-bearing URLs cannot enter process arguments or evidence.

Set the canonical release binding described in
[final-release-readiness.md](final-release-readiness.md), deploy those exact images to the
disposable target, then run:

```sh
pnpm quality:dast-evidence -- \
  --target https://disposable.example.test \
  --confirm-disposable-target \
  --timeout-seconds 900 \
  --dispositions artifacts/dast-dispositions.json \
  --output artifacts/dast-evidence.json
```

The timeout must be between 60 and 1,800 seconds. The host process hard-kills a scan that exceeds
the bound. Docker exit codes other than documented ZAP results `0`, `1`, or `2`, a timeout, a
missing report, an oversized report, or invalid JSON produce failed evidence and a nonzero runner
exit. CI runs only `pnpm quality:dast-contract:test`; it never scans a target.

The published evidence contains only:

- the immutable scanner image;
- a SHA-256 hash of the target origin and whether it was HTTPS or loopback;
- bounded execution status and timing;
- sanitized alert reference, name, severity, and count;
- Medium/Low dispositions; and
- the canonical repository/image release binding.

Raw ZAP request/response data, URLs, instances, cookies, authorization values, and bodies remain in
a random temporary bind mount that is deleted after parsing. The final evidence file is written
atomically with mode `0600`.

## Finding policy

Any High or Critical-equivalent finding fails V5. It must be resolved and the exact bound release
rescanned; a disposition cannot turn it into a pass.

Every Medium and Low finding requires one matching disposition before a report can pass. Supply a
JSON array:

```json
[
  {
    "alertRef": "10020",
    "severity": "medium",
    "decision": "mitigated",
    "owner": "Security Engineering",
    "deadline": "2026-08-15",
    "rationale": "Compensating response-header policy was verified at the edge."
  }
]
```

`decision` must be `accepted`, `mitigated`, or `false_positive`. The owner, deadline, and bounded
rationale are mandatory, alert references must uniquely match the sanitized ZAP findings, and
unknown or secret-like fields are rejected. A deadline earlier than the scan-completion calendar
date is invalid, so an expired acceptance cannot satisfy a later release. Review accepted risks at
each release and rerun the scan when mitigation changes the promoted image.

Validate an existing report without scanning:

```sh
pnpm quality:dast-evidence -- --validate artifacts/dast-evidence.json --require-pass
```

`--require-pass` rejects static, `not_run`, failed, incomplete, unbound, or differently bound
evidence.
