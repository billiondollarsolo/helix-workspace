# Repository security gate

`pnpm quality:supply-chain` is the local form of the required
`security-supply-chain` check. It rejects mutable actions and deployable artifacts,
committed private keys/provider credentials, new high or critical production
advisories, expired advisory exceptions, unused or multiply-versioned direct
dependencies, non-exact dependency declarations, stale notices, unapproved
licenses, and missing scan/signature/provenance steps. The GitHub workflow adds
CodeQL, Trivy dependency/license/secret/IaC scans, an SPDX SBOM, and scheduled
full-image scanning. Update the generated notice inventory with
`node infra/scripts/verify-dependency-policy.mjs --write-notices` after an
approved dependency change.

Apply the checked-in main-branch policy once with a fine-grained token that has
repository Administration write permission:

```sh
GITHUB_REPOSITORY=owner/repository \
GITHUB_TOKEN='<administration token>' \
pnpm security:protect-main
```

The API response is intentionally not persisted because it can contain repository
metadata. Re-run the command after changing `branch-protection.json`; the PUT is
idempotent.
