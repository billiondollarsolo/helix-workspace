# Final release supporting artifacts

`--final-release` is a promotion gate, not a test-report collector. It refuses to create a final
manifest unless the eight exact-build live reports and every artifact below are present, strictly
valid, and bound to the same workspace revision, editor revision, application image, and web image.
The local checkouts must be clean and resolve to those exact revisions, but local branches, tags,
or remotes are never accepted as proof of protected GitHub state. A separately trusted verifier
must observe the protected remote branches and release tags, sign that observation, and place it in
the packet. The protected previous-editor SHA independently determines whether editor gates are
required. Preflight mode is unchanged.

All artifacts are JSON objects. Unknown or missing fields fail validation. Every timestamp is
canonical ISO-8601 UTC, such as `2026-07-28T20:00:00.000Z`. Every artifact digest is
`sha256:<64 lowercase hex characters>`. Each artifact includes the canonical
`helix.release-evidence-binding.v1` object described in
[Final release-readiness evidence](final-release-readiness.md).

Never put resolved configuration, customer content, filenames, addresses, URLs with credentials,
provider payloads, access material, or private signing material in these files. Secret-like field
names and recognizable secret-like values fail validation. Safe evidence filenames use only ASCII
letters, digits, `.`, `_`, `-`, and `/`; unsafe names fail before manifest creation.

References to detailed evidence are objects containing exact `path`, byte-level `sha256`, and
artifact `schema`. The path and digest must identify the same retained snapshot file, and one
artifact can be reused to satisfy unrelated proofs. Copying byte-identical content to a second path
is also reuse and fails validation. A matching schema string is not sufficient: the verifier parses
retained JSON and validates its security meaning against its summary. Command reports must name the
exact command/revision/completion and exit successfully; scans must cover the declared digest/time
with zero High/Critical results; SBOMs must be non-empty SPDX JSON reports for the declared digest;
finding dispositions must match their outer finding; and review, rollout, and business artifacts
must themselves be passed or approved as applicable. The security review includes a passed
sensitive-data scan whose scope is `repository-and-release-packet` and whose retained result has
zero matches.

The retained rollback, soak, threat-model, runbook, limitations, rollout, independent-review,
cost-model, and risk-mitigation documents each contain the exact release binding plus a `role`
field. Accepted values are `migration-rollback-plan`, `production-slo-soak-report`,
`production-threat-model`, `production-runbook-index`, `production-mvp-limitations`,
`rollout-observations`, `rollout-exit-review`, `independent-security-review`,
`production-cost-model`, and `accepted-risk-mitigation`, respectively. Rollout and independent
review documents also bind `phase` to `dogfood` or `private-pilot`; risk mitigations bind `riskId`
to the exact outer accepted risk. Reusing a valid document for another release, phase, role, or
risk therefore fails even when its status and schema are otherwise valid.

## Required schemas

### `helix.final-release.full-gates.v1`

This proves V6 and the engineering portions of R0. It contains:

- `status: "passed"`, `implementationTasksComplete: true`, and
  `reviewedPullRequestsMerged: true`;
- `workspace.revision` equal to the release binding workspace SHA;
- one result for every workspace command listed in plan Task V6, including the five explicit
  release smoke commands;
- for each result: the exact command, `status: "passed"`, an ordered time window, and the
  path/hash/schema reference of its retained command report;
- `editors.revision` equal to the bound editor SHA; if `editors.changed` is true, all five editor
  gates are required, otherwise `commands` must be empty.

No command can be omitted, duplicated, renamed, or supplemented. A report saying “all tests passed”
without the individual exact command records is insufficient.

### `helix.final-release.migration-status.v1`

This proves the schema actually deployed:

- `status: "deployed"` and `migrationHead` exactly equal to the repository migration head;
- deployment/environment digest and deployment timestamp;
- exactly one migrator, advisory locking enabled, and a completion timestamp;
- an approved rollback plan with accountable owner, approval timestamp, and retained-artifact
  path/hash/schema reference.

It is not enough that migrations passed in CI. Generate this after the separate production
migration job completes against the promoted environment.

### `helix.final-release.production-config.v1`

This is deliberately configuration-value-free but policy-explicit. It requires production
environment, `status: "passed"`, `resolved: true`, `unresolvedCount: 0`,
`prohibitedValuesDetected: false`, and `mvpOnly: true`. It also requires:

- single-tenant mode and the `business` security tier;
- core apps exactly `mail`, `drive`, `chat`, and `assistant`;
- web surfaces exactly Mail, Drive, Chat, Assistant, and Admin;
- Calendar, Docs, Sheets, Slides, Meet, and Editors disabled;
- MVP-only web packaging, disabled editor migrations/native editors/file editing, enabled Mail and
  Drive file storage, server-readable secure Chat, and write confirmation by default for agents.
- the exact ten-name active production image inventory, with immutable OCI digests for the
  application, web edge, PostgreSQL, Redis, NATS, Meilisearch, RustFS, Cerbos, SpamAssassin, and
  ClamAV. Application/web digests must equal the promoted release binding;
- distinct retained `helix.evidence.github-sigstore-image-provenance.v1` artifacts for the
  application and web images.

`sourceCount` must be positive. `configurationSha256` hashes a deterministic, redacted
representation of that effective configuration. Do not embed configuration keys or values.

Each application/web provenance artifact wraps a Sigstore bundle v0.3 and declares the exact
registry subject name and OCI digest. The verifier works offline from the retained bundle and its
protected trust configuration. It requires:

- a leaf certificate directly issued by the pinned Fulcio issuing certificate;
- the exact trusted workflow URI in the certificate SAN;
- GitHub OIDC certificate extensions for
  `https://token.actions.githubusercontent.com`, the exact workspace SHA, trusted workspace
  repository, and protected branch ref;
- one cryptographically valid DSSE signature over an in-toto v1 statement;
- one Rekor `dsse` v0.0.1 entry under the protected log identity, with a valid signed-entry
  timestamp, body binding, RFC 6962 inclusion proof, and signed checkpoint;
- one statement subject equal to the configured registry subject and promoted digest;
- predicate type
  `https://helix.billiondollarsolo.com/attestations/paired-source/v1` with exactly:

```json
{
  "schemaVersion": 1,
  "workspace": {
    "repository": "https://github.com/<trusted-workspace-owner/repository>",
    "sha": "<promoted-workspace-sha>"
  },
  "editors": {
    "repository": "https://github.com/<trusted-editors-owner/repository>",
    "sha": "<promoted-editors-sha>"
  }
}
```

The in-toto subject name is the pushed registry subject, not a local image alias. Rekor
verification is offline and pins the log public key, its SHA-256 log ID, and checkpoint origin in
protected verifier configuration. The verifier checks that the canonical Rekor body hashes the
exact retained envelope and payload and binds the exact DSSE signature and leaf certificate. It
then verifies the signed-entry timestamp, Merkle inclusion proof, and checkpoint signature. The
authenticated Rekor `integratedTime`—not the unsigned artifact `generatedAt` wrapper—is used for
24-hour freshness and Fulcio certificate-validity checks. A wrapper digest, unsigned workflow
output, unverified/backdated log entry, generic provenance predicate, matching image label, or
certificate for another workflow/repository/ref does not satisfy this gate.

### `helix.final-release.slo-soak.v1`

This records a real, continuous soak window of at least 24 hours with 5–50 users and at least 100
browser/WebSocket sessions. The declared duration and actual timestamps must both meet 24 hours.
The profile must include representative Mail, Drive objects through 1 GiB, concurrent MCP reads,
and pending agent writes. The retained soak report records p99/error rate, process-memory growth,
event-loop lag, DB-pool pressure, Redis/NATS backlog, queue age, and scan concurrency. The report
must pass:

- availability at least 99.5%;
- ordinary API read p95 at most 500 ms;
- ordinary metadata-write p95 at most 750 ms;
- Chat accepted-to-visible p95 at most 2 seconds;
- Mail provider acceptance p95 at most 60 seconds;
- no unbounded memory growth and zero stuck jobs.

The 30-minute C6 load report does not substitute for this temporal gate.

### `helix.final-release.security-review.v1`

The threat model, repository scan, dependency audit, release-packet sensitive-data scan, and manual
boundary review must each have a passed status, completion time, and unique retained artifact
reference.

Container scans and SBOMs are required for the exact default production image inventory:
`application`, `web`, `postgres`, `redis`, `nats`, `meilisearch`, `rustfs`, `cerbos`,
`spamassassin`, and `clamav`. Application and web digests must equal the promoted release binding;
every other image must use an immutable OCI digest, and each image’s scan and SBOM must cover the
same digest declared by the resolved production-config artifact. This prevents scanning a clean
substitute image while deploying another digest. Optional Drive preview, editor, observability,
Jitsi, and Mailpit profiles are disabled for this MVP and are not part of this exact inventory.
Enabling any profile requires a new policy revision and corresponding scan/SBOM entries before
promotion.

Each discovered launch-scope finding has a hashed identifier, severity, disposition, owner,
expiry, and disposition-artifact digest. Critical and High findings may only be `resolved` or
`false_positive`. Only Medium and Low findings may be `accepted`, and each acceptance must have an
expiry later than manifest generation. An empty findings array means the scans discovered none; it
must not be used to hide findings recorded by the referenced scans.

The retained repository, dependency, and manual-review artifacts independently report severity
counts and must contain zero Critical/High findings. Every retained container scan independently
names its scanner and exact image digest and must contain zero Critical/High vulnerabilities.
Every retained SBOM summary must name the fixed production image subject and same digest, use
`spdx-json`, contain at least one package, and include a unique path/hash/schema reference to the
actual retained SPDX document. `documentSha256` must equal that reference digest. The referenced
document must parse as SPDX 2.3 JSON (`SPDX-2.3`, `CC0-1.0`, and
`SPDXRef-DOCUMENT`), have a credential-free HTTPS namespace and valid creation identity, and
describe exactly one container-image package. Its document name, described-package name,
`versionInfo`, and SHA-256 checksum must bind the exact fixed registry subject and production image
digest; its package count and unique SPDX identifiers must agree with the summary. Omitting,
copying, or substituting an SPDX document from another image fails promotion. These checks prevent
a safe outer summary from referring to a contradictory or absent SBOM.

### `helix.final-release.support-readiness.v1`

This requires named support and incident owners, an assigned human monitoring rotation, artifact
references for the runbook index and user-facing limitations, at least 14 real days of passed
dogfood, and then at least 28 real days of passed private pilot. Each phase has distinct
observation and exit-review artifacts. The pilot additionally requires an independent-security-
review artifact and cannot begin before dogfood completes. The incident-history window must cover
both complete rollout periods, records total incidents,
and must have zero open Sev-1/Sev-2, data loss, cross-tenant access, malware bypass, silent Mail
loss, or unapproved agent-write events.

### `helix.final-release.business-readiness.v1`

The artifact records currency, monthly and per-user estimates, and the retained cost-model digest.
Limits must exactly preserve the approved MVP boundary:

- one organization and 5–50 users;
- managed outbound provider and no direct MX;
- no regulated-data representation;
- agent writes confirmed by default;
- native editors disabled.

Every risk is `closed` or explicitly `accepted`. Accepted risks require an accountable owner,
unexpired deadline, concise non-sensitive summary, and mitigation-artifact digest.

### `helix.final-release.protected-repository-state.v1`

This is fresh, independently signed evidence of the remote protected Git state. It contains the
exact trusted repository identity, protected branch name and observed branch SHA, configured
release tag and observed tag SHA for both `workspace` and `editors`. All four observed SHAs must
equal the promoted release binding. `observedAt` must be no more than one hour old and no later than
`generatedAt`.

The artifact is signed with Ed25519 over canonical JSON, omitting only `signature.value`. The
verifier pins, in protected configuration, the observer public-key path, its DER-SPKI SHA-256
fingerprint, and the exact signer identity. The observation producer must query the authoritative
GitHub protected refs using credentials and policy inaccessible to release-evidence producers.
Do not generate this artifact from a local clone, accept a local `main` branch/tag, or infer
protection from a repository name. Local Git state is useful only to ensure the bytes being
validated are clean and match the signed revisions.

### `helix.final-release.production-decision.v1`

The R3 decision is `go`, `conditional_go`, or `no_go`. A final promotion refuses `no_go`. `go`
requires no conditions. `conditional_go` requires at least one condition, and each condition needs
an ID, concise summary, owner, and expiry later than manifest generation.

The decision includes `evidenceSetSha256`, calculated over the exact paths and byte-level SHA-256
digests of every snapshotted release-packet file except the decision itself. Therefore changing a
live report, supporting report, referenced artifact, or additional required file invalidates the
decision. The decision is signed with Ed25519 over canonical JSON with object keys recursively
sorted. Only `signature.value` is omitted from the signed payload; algorithm, signer identity, and
signer fingerprint are signed.

The signature object contains:

- `algorithm: "Ed25519"`;
- an accountable `signer`;
- the SHA-256 fingerprint of the signer’s DER-encoded SPKI public key;
- the base64 signature.

The verifier supplies both the public-key file and its independently pinned fingerprint through
protected `HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY` and
`HELIX_RELEASE_TRUSTED_DECISION_SIGNER_FINGERPRINT` configuration. Final mode has no CLI override.
Do not derive either trusted value from the decision artifact. Keep the private key outside the
repository, evidence directory, logs, command line, application runtime, and evidence-producer
environment.

### Freshness and verifier time

Final mode uses the verifier wall clock and rejects `--timestamp`. Live evidence must be no more
than seven days old and cannot be future-dated. Full gates, deployed migration, and resolved
production configuration must be no more than 24 hours old. SLO/soak, security, support, and
business reports must be no more than seven days old. The signed protected-repository observation
must be no more than one hour old. The signed production decision must be no more than 24 hours
old. Accepted findings, risks, and conditional-go conditions must be unexpired at verifier time.
Freshly wrapping stale results does not help: V6 command completions and migration
deployment/completion are also limited to 24 hours; the soak completion, security check
completions, private-pilot completion, and incident-history completion are checked against their
seven-day windows independently of report generation.

### Trust-anchor deployment and rotation

1. Provision the decision and protected-state observer public keys read-only on the promotion
   verifier; do not mount them in ordinary evidence-producer jobs.
2. Pin each lowercase SHA-256 DER-SPKI fingerprint and exact signer identity in separately
   protected verifier configuration.
3. Pin the Fulcio issuing certificate, GitHub workspace/editor repository identities, exact
   workflow identity, registry subject names, protected branch, Rekor public key, Rekor SHA-256 log
   ID, and Rekor checkpoint origin in the same protected configuration. Do not read any trust
   value from the packet.
4. Restrict changes to all trust values through the protected-environment review/audit policy.
5. To rotate a key or issuer, stage the new complete trust tuple in a reviewed verifier change,
   exercise a signed non-production packet, then activate the tuple atomically.
6. Re-sign any not-yet-promoted decision or protected-state observation with the active key. Never
   accept a fingerprint passed by an evidence producer or copy it from an evidence file.
7. Remove old trust material after its overlap window and retain the rotation audit record with
   release evidence.

## Safe assembly order

1. Resolve the clean repository SHAs and immutable image digests.
2. Publish application/web images and retain their Sigstore bundles with the exact paired-source
   predicate.
3. Deploy those exact images and run the migration job.
4. Produce the eight live reports, seven ordinary non-decision supporting reports, and every
   referenced artifact from real systems.
5. Have the independent protected-state observer query GitHub and sign the fresh branch/tag
   observation.
6. Sensitive-data scan and review the complete staged packet, then hash every file except the
   decision, record the R3 decision, and sign it offline.
7. Run the final manifest command in the protected verifier environment with every pinned trust
   value.
8. Retain the manifest, complete snapshotted packet, provenance, trust-rotation state, and
   signature-verification output as one immutable promotion packet.

Do not regenerate timestamps, copy a report from another revision, edit a digest, or re-sign an
unreviewed packet to make validation pass. Correct the underlying deployment or evidence and
repeat the affected gates.
