# Final release-readiness evidence

The ordinary release-readiness manifest remains a developer and operator preflight: it validates
only the evidence explicitly supplied. A production promotion must add `--final-release`. That
mode is fail-closed and requires the eight live service gates plus the V6 and R0–R3 supporting
artifacts. Passing service tests alone cannot produce a final manifest.

| Gate                | Manifest option               | Required result                                                                 |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| M7 Mail             | `--mail-live-evidence`        | Local scenarios plus provider sandbox, Gmail, and Microsoft 365 all passed      |
| D7 Drive            | `--drive-live-evidence`       | All eight live storage cases passed                                             |
| C6 Chat             | `--chat-live-evidence`        | All scenarios passed at the 50-user/100-socket/30-minute release profile        |
| A7 Agent            | `--agent-live-evidence`       | All eight live agent scenarios passed                                           |
| O2 data plane       | `--data-plane-live-evidence`  | All eight TLS/authentication/authorization/rotation scenarios passed            |
| O4 restore          | `--restore-drill-evidence`    | Every restore scenario passed with RPO at most 24 hours and RTO at most 4 hours |
| V4 failure/recovery | `--failure-recovery-evidence` | Every disposable fault scenario and recovery assertion passed                   |
| V5 DAST             | `--dast-evidence`             | Bound ZAP scan passed; no High/Critical and all Medium/Low risks dispositioned  |

Static, `not_run`, running, failed, partially passed, or missing reports cannot satisfy final mode.

Final mode additionally requires:

| Requirement                | Manifest option                         | Fail-closed proof                                                          |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| V6/R0 engineering          | `--full-gates-evidence`                 | Exact revision and complete mandatory command set passed                   |
| Deployed schema            | `--migration-status-evidence`           | Repository migration head deployed by one locked migrator                  |
| Resolved production config | `--production-config-evidence`          | Digest-only, resolved production config with MVP mode enforced             |
| SLO and soak               | `--slo-soak-evidence`                   | Objectives passed over a real window of at least 24 hours                  |
| V5 security review         | `--security-review-evidence`            | Scans/SBOM/manual review passed; every finding safely dispositioned        |
| R1/R2/support readiness    | `--support-readiness-evidence`          | Owners, runbooks, dogfood, pilot, and safe incident history                |
| Cost, limits, risks        | `--business-readiness-evidence`         | Cost model, approved MVP limits, and owned/unexpired accepted risks        |
| Protected remote Git state | `--protected-repository-state-evidence` | Trusted signed observation binds both protected branches/tags to both SHAs |
| R3 decision                | `--production-decision-evidence`        | Signed exact-packet `go` or owned, unexpired `conditional_go` decision     |
| Protected trust            | protected verifier configuration        | Decision/state keys and GitHub/Sigstore identities match pinned values     |

See [Final release supporting artifacts](final-release-supporting-evidence.md) for exact schemas
and the safe production procedure.

## Bind every live run to the promoted build

Before executing any evidence runner, resolve both exact clean repository revisions and immutable
OCI digests of the application and web images that are deployed in the test environment:

```sh
export HELIX_RELEASE_WORKSPACE_SHA="$(git rev-parse HEAD)"
export HELIX_RELEASE_EDITORS_SHA="$(git -C ../helix-editors rev-parse HEAD)"
export HELIX_RELEASE_APPLICATION_IMAGE_DIGEST="sha256:<64 lowercase hex characters>"
export HELIX_RELEASE_WEB_IMAGE_DIGEST="sha256:<64 lowercase hex characters>"
```

Set all four variables together. Supplying only part of the binding fails before evidence is
written. The Mail, Agent, Chat, data-plane, restore, failure/recovery, and DAST CLIs add this canonical
object to generated reports:

```json
{
  "releaseBinding": {
    "schema": "helix.release-evidence-binding.v1",
    "workspaceSha": "<40 lowercase hex characters>",
    "editorsSha": "<40 lowercase hex characters>",
    "applicationImageDigest": "sha256:<64 lowercase hex characters>",
    "webImageDigest": "sha256:<64 lowercase hex characters>"
  }
}
```

The Drive harness is deployment-specific. Have it emit the same object, or run its completed
report through the Drive validator with the four environment variables set and redirect the
validated JSON to the release packet. Do not overwrite the source report until the redirected
output passes validation.

The binding contract has exactly five fields. Unknown, missing, malformed, or secret-like fields
are rejected. If a report already contains a binding, a runner refuses to replace it with different
values.

This binding is a consistency control, not a signature and not proof that an operator deployed the
claimed digests. Final mode separately verifies retained GitHub/Sigstore provenance for the
application and web digests and a signed observation of authoritative protected Git refs.

## Build the final manifest

Store all reports beneath the evidence directory, then run:

```sh
evidence_dir="artifacts/release-readiness/$(date +%F)/$(git rev-parse HEAD)"
manifest_path="${evidence_dir}.release-readiness-manifest.json"

export HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY=/run/helix-release/trusted-decision-signer.pem
export HELIX_RELEASE_TRUSTED_DECISION_SIGNER_FINGERPRINT=sha256:<trusted-spki-digest>
export HELIX_RELEASE_TRUSTED_GIT_STATE_PUBLIC_KEY=/run/helix-release/trusted-git-state-observer.pem
export HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER_FINGERPRINT=sha256:<trusted-spki-digest>
export HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER=<trusted-observer-identity>
export HELIX_RELEASE_TRUSTED_FULCIO_ISSUER_CERTIFICATE=/run/helix-release/fulcio-issuer.pem
export HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY=/run/helix-release/rekor-public-key.pem
export HELIX_RELEASE_TRUSTED_REKOR_LOG_ID=sha256:<trusted-rekor-spki-digest>
export HELIX_RELEASE_TRUSTED_REKOR_CHECKPOINT_ORIGIN='rekor.sigstore.dev - <trusted-tree-id>'
export HELIX_RELEASE_TRUSTED_GITHUB_REPOSITORY=billiondollarsolo/helix-workspace
export HELIX_RELEASE_TRUSTED_EDITORS_REPOSITORY=billiondollarsolo/helix-editors
export HELIX_RELEASE_TRUSTED_GITHUB_WORKFLOW_IDENTITY=https://github.com/billiondollarsolo/helix-workspace/.github/workflows/production-image-security.yml@refs/heads/main
export HELIX_RELEASE_TRUSTED_APPLICATION_SUBJECT=ghcr.io/billiondollarsolo/helix-workspace
export HELIX_RELEASE_TRUSTED_WEB_SUBJECT=ghcr.io/billiondollarsolo/helix-workspace-web
export HELIX_RELEASE_PREVIOUS_EDITORS_SHA=<previous-release-editor-sha>
export HELIX_RELEASE_REQUIRED_BRANCH=main
export HELIX_RELEASE_WORKSPACE_TAG=<protected-workspace-release-tag>
export HELIX_RELEASE_EDITORS_TAG=<protected-editor-release-tag>

pnpm quality:release-readiness-manifest -- \
  --final-release \
  --evidence-dir "$evidence_dir" \
  --mail-live-evidence mail-live-evidence.json \
  --drive-live-evidence drive-live-evidence.json \
  --chat-live-evidence chat-live-evidence.json \
  --agent-live-evidence agent-live-evidence.json \
  --data-plane-live-evidence data-plane-live-evidence.json \
  --restore-drill-evidence restore-drill-evidence.json \
  --failure-recovery-evidence failure-recovery-evidence.json \
  --dast-evidence dast-evidence.json \
  --full-gates-evidence full-gates-evidence.json \
  --migration-status-evidence migration-status-evidence.json \
  --production-config-evidence production-config-evidence.json \
  --slo-soak-evidence slo-soak-evidence.json \
  --security-review-evidence security-review-evidence.json \
  --support-readiness-evidence support-readiness-evidence.json \
  --business-readiness-evidence business-readiness-evidence.json \
  --protected-repository-state-evidence protected-repository-state-evidence.json \
  --production-decision-evidence production-decision-evidence.json \
  --application-image-digest "$HELIX_RELEASE_APPLICATION_IMAGE_DIGEST" \
  --web-image-digest "$HELIX_RELEASE_WEB_IMAGE_DIGEST" \
  --output "$manifest_path"
```

Final mode deliberately has no public-key, signer-fingerprint, trusted identity, issuer, or
timestamp CLI override. The promotion verifier supplies all trust anchors from protected
configuration and uses its own wall clock. Evidence producers must not be able to modify those
settings. `--timestamp` remains available only to deterministic preflight automation.

The command independently reads both clean repository Git SHAs and compares them and both supplied
image digests with every report. Any mismatch blocks promotion. It also verifies the application
and web DSSE signatures offline, validates their Fulcio/GitHub identities, cryptographically
verifies the Rekor body, signed-entry timestamp, inclusion proof, and checkpoint under protected
log trust, and requires the signed paired-source predicate to bind the exact workspace and editor
revisions. Rekor's authenticated integration time controls provenance freshness and certificate
validity; an evidence author cannot backdate the unsigned wrapper. The resulting schema-version 6
manifest records `release.mode: "final"`, all required gate IDs, repository revisions, immutable
image digests, evidence-file hashes, redacted timing/count summaries, signed protected-state
observation, and the verified R3 decision.

Do not regenerate or edit a report to repair a mismatch. Deploy the intended images from the
intended revision and rerun the affected live evidence.

The final verifier requires a separately trusted Ed25519-signed observation that both SHAs are the
exact authoritative tips of the configured protected release branch and the exact commits named by
their protected release tags. The observation must name the exact pinned GitHub repositories and
be no more than one hour old. Local branch names, tags, and remotes do not satisfy this control.
The previous editor release SHA determines whether editor gates are mandatory; an evidence author
cannot skip them by setting `editors.changed: false`.

The manifest output must be outside the source evidence directory and must not already exist.
Creation follows filesystem aliases before enforcing that boundary and refuses symbolic-link or
hard-link output targets, so output publication cannot overwrite evidence that was just validated.
Keep the evidence directory quiescent for the complete verifier run; symbolic links and non-file
entries are prohibited.

Evidence is read into an immutable in-process snapshot. Hashing, JSON validation, signed-packet
verification, and manifest inventory generation all use those same bytes, then the verifier
re-reads the source tree and fails if any path, length, or digest changed during validation. The R3
decision covers every file in that snapshot except the decision itself, including additional
`--require-evidence` files and digest-referenced artifacts. Referenced JSON is semantically
validated: the exact command/revision/completion, scan severity counts, image digest, SBOM
format/package count, sensitive-data match count, finding disposition, and passed/approved state
must agree with the outer summaries. Each SBOM summary must also retain and hash its unique actual
SPDX 2.3 JSON document, whose described container package binds the fixed registry subject and
exact digest.

## Contract CI versus production evidence

Run the complete contract suite locally with:

```sh
pnpm quality:release-evidence-contract:test
```

The root script deliberately runs the JavaScript suites with their correct test runners: the
Vitest evidence/manifest suites run together, followed by the Drive contract under Node's built-in
test runner. Quality CI invokes this command on pull requests and `main`.

CI contract tests prove that the validators fail closed; they do not fabricate live evidence.
Actual final-release manifest creation remains an explicit promotion-stage operation after all
eight live reports and all nine supporting artifacts exist.
