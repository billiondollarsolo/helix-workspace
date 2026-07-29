# Final release-readiness evidence

The ordinary release-readiness manifest remains a developer and operator preflight: it validates
only the evidence explicitly supplied. A production promotion must add `--final-release`. That
mode is fail-closed and requires all eight live gates from the production-readiness plan:

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
claimed digests. Retain image provenance attestations and deployment records alongside the packet.

## Build the final manifest

Store all reports beneath the evidence directory, then run:

```sh
evidence_dir="artifacts/release-readiness/$(date +%F)/$(git rev-parse HEAD)"

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
  --application-image-digest "$HELIX_RELEASE_APPLICATION_IMAGE_DIGEST" \
  --web-image-digest "$HELIX_RELEASE_WEB_IMAGE_DIGEST" \
  --output "$evidence_dir/release-readiness-manifest.json"
```

The command independently reads both clean repository Git SHAs and compares them and both supplied
image digests with every report. Any mismatch blocks promotion. The resulting schema-version 5
manifest records `release.mode: "final"`, all required gate IDs, repository revisions, immutable
image digests, evidence-file hashes, and redacted timing/count summaries.

Do not regenerate or edit a report to repair a mismatch. Deploy the intended images from the
intended revision and rerun the affected live evidence.

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
eight live reports exist.
