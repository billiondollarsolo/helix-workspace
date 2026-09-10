# Helix 1.0 release checklist

The [implementation status](implementation-status.md) records source changes and focused checks; this checklist governs release promotion.

- [ ] Confirm [1.0 scope](1.0-scope.md), dependency licenses, release owners,
      accepted risks, and the candidate entries in [CHANGELOG](../../CHANGELOG.md).
- [ ] Run the required source, live PostgreSQL/RLS/storage, Playwright, accessibility,
      security, and image gates on one clean workspace commit. CI must reject
      unexpected test skips and changes to the generated route tree.
- [ ] Create the next annotated candidate tag, starting with
      `git tag -a v1.0.0-rc.1 -m 'Helix 1.0 release candidate 1'`; push it only
      after review. Dispatch **Release candidate and final evidence** on that
      tag. It builds/scans both images and creates a draft with SPDX SBOMs.
- [ ] Deploy the exact signed image digests published by the existing
      [production image workflow](../../.github/workflows/production-image-security.yml)
      on `main`. Candidate rebuilds are checks; they do not replace those digests.
      Run the [eight live evidence gates](../final-release-readiness.md), the
      [supporting evidence procedure](../final-release-supporting-evidence.md),
      and the required soak. Bind every artifact to the workspace SHA and both
      deployed OCI digests.
- [ ] Configure the protected `release` environment: pinned decision/Git-state
      public keys and fingerprints, Fulcio/Rekor trust, and the GA tag signer's
      armored public key and fingerprint. The workflow lists the exact variable
      names; trust material must come from verifier configuration, never the packet.
- [ ] Upload the complete retained packet as
      `helix-release-evidence-<workspace SHA>` in a repository Actions run. Use
      the canonical JSON filenames in the final-readiness procedure and retain
      every referenced supporting artifact. Preserve the source run ID.
- [ ] Move the approved changelog entries into `1.0.0` with the release date and
      repeat gates if this changes the bound commit. Create the signed GA tag:
      `git tag -s v1.0.0 -m 'Helix Workspace 1.0.0'`. Obtain the signed protected
      Git-state observation and R3 decision for the exact final packet.
- [ ] Dispatch the release workflow on `v1.0.0` with the evidence run ID and
      both deployed digests. It verifies the tag and runs
      `release-readiness-manifest --final-release`; missing or failed evidence
      blocks the final draft. RC drafts never imply final readiness.
- [ ] Review the draft, manifest, SBOMs, and rollback/restore plan, then publish
      the release and perform the approved production rollout. Record the owner,
      deployment digest, smoke results, and rollback decision in the release packet.
