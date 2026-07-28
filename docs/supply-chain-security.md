# Production supply-chain security

Helix gates the lockfile and the exact production images before release. Native editor
implementation is outside this control's scope; the production image workflow only builds the
existing paired package contract needed by the workspace.

## Dependency advisories

`pnpm quality:production-dependency-audit` uses the repository-pinned `pnpm@9.15.9` to materialize
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
findings before publication. Main-branch images are pushed by immutable commit tag. GitHub then
creates Sigstore-backed provenance and SBOM attestations for each exact registry digest. The raw
SBOMs and signed attestation bundles are retained together as the workflow's supply-chain evidence
artifact. Any failed scan, push, or attestation keeps the workflow red.
