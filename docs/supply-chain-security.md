# Production supply-chain security

Helix gates the lockfile and the exact production images before release. Native editor
implementation is outside this control's scope; the production image workflow only builds the
existing paired package contract needed by the workspace.

## Dependency advisories

`pnpm quality:production-dependency-audit` uses the repository-pinned `pnpm@11.18.0` to materialize
the same `@helix/app` production deployment used by the API image, inventories only dependency
versions reachable from that deployment, and evaluates them against the registry audit for the
committed lockfile. This prevents optional framework peers and test-only tools that are absent from
the runtime from being misreported as shipped dependencies. The gate fails closed on:

- every critical advisory;
- every unapproved high advisory;
- registry errors, malformed reports, and command failures;
- an exception that has expired, changed package/version, or is no longer observed.

Exceptions live in `infra/security/pnpm-audit-exceptions.json`. Each exception must identify one
GHSA and package, enumerate exact allowed versions, name an owner, explain the risk decision, and
expire. No exceptions are currently approved. The production dependency overrides force every
reachable `brace-expansion` path to `5.0.8`; older 1.x and 2.x backports address a different
advisory and are not accepted for the unbounded-expansion-length vulnerability. The lockfile
applies narrow compatibility patches to legacy `minimatch@3.1.5` and `minimatch@5.1.9` consumers
so they can call the fixed package's CommonJS export. Every audit run exercises both patched
consumers and verifies that `brace-expansion@5.0.8` bounds adversarial output.

Run the same gate locally:

```sh
pnpm quality:production-dependency-audit
```

## Committed-secret scanning

The Supply Chain Security workflow scans complete Git history with the official Gitleaks 8.30.0
container pinned by its immutable multi-platform digest. A new finding fails every pull request,
main push, manual run, and scheduled run.

`.gitleaksignore` contains exact commit/path/rule/line fingerprints for the 36 reviewed historical
findings; it contains no detector-wide or path-wide exclusions. Thirty-one are synthetic values in
tests or generated formatting baselines. Five are self-signed `meet.localhost` development fixture
keys introduced in commit `b7758ad`. Meet is disabled in the production MVP, and the production
runtime images do not copy `infra/meet`. Changing any baselined content produces a different
fingerprint and fails the scan. A suspected real credential must still be revoked before any
history remediation; never add a fingerprint merely to make CI green.

## Image evidence

The Production Image Security workflow builds the reviewed API and storage-only web runtime,
validates their runtime contracts, generates SPDX JSON SBOMs, and blocks high/critical container
findings before publication. The two application images and all eight dependency images must
complete their scans and SBOM inventory before any image is published. Successful scan jobs export
the exact locally reviewed images as checksummed Docker image archives; the aggregate
publication job verifies the workflow revision, archive checksum, and loaded image ID before
pushing those same bits by immutable commit tag. It never rebuilds an image. Only the application,
web, PostgreSQL, NATS, Meilisearch, Cerbos, and SpamAssassin images are published; digest-pinned
Redis, RustFS, and ClamAV remain pull-and-scan inventory. GitHub then creates Sigstore-backed
provenance and SBOM attestations for each exact registry digest. The raw SBOMs and signed
attestation bundles are retained together as workflow supply-chain evidence. Because the
application and web builds consume the paired `helix-editors` checkout, their candidate artifacts
also bind its resolved commit SHA. Their pushed digests receive an additional signed paired-source
predicate containing the exact `helix-workspace` and `helix-editors` repository URLs and commit
SHAs. CI wraps each raw paired-source Sigstore bundle in the exact
`helix.evidence.github-sigstore-image-provenance.v1` application/web evidence schema, using the
bundle's transparency-log integrated time, registry subject, and pushed digest, and retains the
wrapper with its SHA-256 checksum. Any failed scan, source-binding check, push, evidence wrapping,
or attestation keeps the workflow red.

Syft's raw SPDX output is retained as immutable scan evidence, but it is not promoted directly.
After each Helix-built image has its pushed registry digest, CI derives a separate strict SPDX 2.3
document that preserves the discovered package inventory and adds one `CONTAINER` package binding
the exact repository subject and digest. The normalized document has a single `documentDescribes`
root, unique SPDX identifiers, supported `creationInfo` fields, and a SHA-256 sidecar; that exact
file is used for the SBOM attestation. The pull-only Redis, RustFS, and ClamAV documents are
normalized the same way against their checked-in Docker Hub subjects and pinned digests before
evidence upload.
