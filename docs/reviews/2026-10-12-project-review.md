# Project review and PR triage — 2026-10-12

What this repo does: Helix provides a self-hosted communication and file-storage
workspace, including its browser app, API, CLI, SDK contracts, and infrastructure.
This review assumes the approved 1.0 load: one organization with 5–50 trusted users
on the Business security tier.

Reviewed main at `b1b389a52cce15782c717e773cded991b77f2cb7`, the four open PR diffs,
and their available GitHub checks. PR status is a snapshot, not a merge approval.
The review concentrates on onboarding, deployment, dependency maintenance,
documentation, and verification gates; it is not a full security audit.

## Must fix

1. **The documented single-tenant invitation flow is missing.**
   - **What this is:** An invite-only pilot needs a way for an administrator to add
     people who can sign in.
   - **Problem:** `apps/helix/src/platform/auth/admin-users.ts` has directory,
     suspension, restoration, and MFA-reset routes, but no account-create or invite
     route. The current Admin Users UI also has no create/invite action. The pilot
     installation guide previously told operators to use those invitations.
     The existing `/api/signup/onboarding-invites` API does issue invitations,
     but its acceptance route requires a signed-in actor and does not create
     password credentials for a new user.
   - **Fix:** Rework the missing creation and invitation portion of
     [PR #15](https://github.com/billiondollarsolo/helix-workspace/pull/15) on current
     main. Preserve current tenant isolation, identity membership, admin MFA, audit,
     and suspension safeguards. Prove invite → acceptance → sign-in and denied
     cross-tenant/non-admin requests with the runtime database role.
   - **If we skip it:** Operators reach an onboarding dead end. Do not close #15 as
     fully implemented. The installation guide now calls out this gap.

2. **Three dependency image scans block production readiness.**
   - **What this is:** Production image jobs scan the exact container contents.
   - **Problem:** The [main image run](https://github.com/billiondollarsolo/helix-workspace/actions/runs/38201564266)
     fails for RustFS, Cerbos, and CloudNativePG PostgreSQL. Downloaded Trivy JSON
     reports contain 2, 1, and 64 high/critical package findings respectively;
     these are package findings, not counts of distinct vulnerabilities. RustFS
     flags OpenSSL packages; Cerbos flags its embedded go-git dependency.
   - **Fix:** Review the artifacts, rebuild or update affected image contents, and
     collect fresh scans for the resulting digests. Some findings have no listed
     fix; handle those through the existing vulnerability disposition policy.
     The Compose update in #25 does not change these three affected images.
   - **If we skip it:** The existing production image gate remains red. A green
     application dependency audit alone cannot establish image readiness.

3. **Main's validation gates are red for identifiable reasons.**
   - **What this is:** CI is the evidence needed to distinguish a safe change from
     a broken release candidate.
   - **Problem:** The [main quality run](https://github.com/billiondollarsolo/helix-workspace/actions/runs/38201564269)
     fails contracts coverage: lines 73.23% against 74%, functions 65.38% against
     68%, and statements 72.16% against 73%. The live smoke gets HTTP 403 from
     `app.passwords.list`: its tool permission is `profile.read`, which the smoke's
     default scope list omits. Supply-chain policy matches the public AWS example
     access key in `apps/helix/src/platform/drive/s3/sigv4.test.ts` as a credential.
     The [performance test](https://github.com/billiondollarsolo/helix-workspace/actions/runs/38201564256)
     expects “Sign in to Helix”, while the current login panel renders “Sign in”.
   - **Fix:** Add meaningful contracts tests for uncovered behavior; reconcile the
     smoke token's scopes with the app-password policy; narrowly recognize the
     exact published AWS test vector without exempting arbitrary credentials; and
     update the performance journey to the current staged sign-in flow. Rerun
     each gate without reducing its security or coverage requirements.
   - **If we skip it:** New PR failures remain hard to attribute, and missing test
     reports are mistaken for independent failures when they follow an earlier
     package failure. These are separate from #55's contracts build break.

## Should fix

4. **Bulk dependency upgrades combine incompatible migrations.**
   - **What this is:** Dependabot grouped every npm version change into one PR.
   - **Problem:** [PR #55](https://github.com/billiondollarsolo/helix-workspace/pull/55)
     updates 74 dependencies, including Zod 3 → 4, TypeScript 5 → 7, Vitest 4 → 5,
     ioredis 5 → 6, and React Table 8 → 9. Its
     [quality run](https://github.com/billiondollarsolo/helix-workspace/actions/runs/38195320550)
     fails building `packages/contracts/src/chat.ts:254` and `http.ts:24` after the
     Zod change. Later test/report failures are downstream of that build failure.
   - **Fix:** Replace the bulk PR with routine updates plus separately reviewed
     major migrations. This cleanup restricts the group to minor/patch updates;
     major updates remain eligible as individual PRs. Removed two Dependabot
     directory entries pointing to deleted LibreOffice integrations.
   - **If we skip it:** A routine maintenance PR requires several unrelated API
     migrations, and bots continue targeting removed product surfaces.

5. **Documentation had no clear entry path and contained obsolete instructions.**
   - **What this is:** README readers need product context and a reproducible local
     setup; operators need deeper reference material.
   - **Problem:** The old README concentrated on launch disclosures, omitted
     infrastructure/migration/seed steps, and provided no documentation index.
     Troubleshooting still named removed `--drive-docs-calendar-*` smoke flags.
   - **Fix:** Added a product-led README, local quick start, documentation index,
     and development guide. Kept detailed disclosures in the canonical scope and
     updated the launch checker to enforce them there while still rejecting
     prohibited README claims and a missing scope link. Updated obsolete smoke
     instructions and corrected the pilot onboarding claim.
   - **If we skip it:** Readers follow incomplete startup steps or commands that
     no longer exist. These documentation issues are addressed by this change.

## Open PR decisions

| PR                                                                                                | Current evidence                                                                                                                                                                                                       | Recommendation                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#55 — 74 npm updates](https://github.com/billiondollarsolo/helix-workspace/pull/55)              | Mergeable but failing; contracts compilation breaks after major upgrades.                                                                                                                                              | **Close and replace the bulk PR.** Preserve needed dependency updates in smaller PRs; do not discard security maintenance. The new grouping policy supports this split.                                                  |
| [#15 — admin invite/create/suspend](https://github.com/billiondollarsolo/helix-workspace/pull/15) | Conflicts with main. Main already has suspension/restoration; account creation and invitation remain missing. The PR's old suspension path reuses offboarding, which should not replace current reversible suspension. | **Keep the work, replace or rebase the PR.** Port only the missing onboarding flows onto current auth code. Close the old PR only when its replacement is tracked.                                                       |
| [#25 — 10 Compose image updates](https://github.com/billiondollarsolo/helix-workspace/pull/25)    | Mergeable; its recorded E2E and both mode suites pass. `production-compose.test.mjs:198` still expects the old Redis digest; RustFS/Cerbos scans also fail.                                                            | **Keep and resolve.** Review the Redis/image inventory together, update the corresponding contract after review, refresh against main, and rerun. Do not treat updating an expected digest as vulnerability remediation. |
| [#13 — 9 GitHub Actions updates](https://github.com/billiondollarsolo/helix-workspace/pull/13)    | Mergeable, but displayed checks are from September 16. They include unresolved workspace imports and test failures from that older tree. Some version comments no longer match their new action pins.                  | **Keep and refresh.** Rebase/regenerate against current workflows, reconcile action pins and comments, then obtain current checks. Old red checks do not show that today's action updates are unnecessary.               |

**Nothing is proven safe to discard outright as wholly duplicated.** #55 is the
best candidate to close as a batch; #15 contains required work even though part of
its implementation is superseded. No PRs were merged, closed, or commented on by
this review.

## Suggested follow-up order

1. Restore trustworthy main checks: contracts coverage, the AWS fixture detector,
   smoke authorization, and the login performance journey.
2. Repair and rescan the three blocked production dependency images.
3. Deliver single-tenant create/invite onboarding using current auth safeguards.
4. Refresh #13 and #25; replace #55 with smaller dependency updates.
5. Collect the real deployment evidence required by the [release checklist](../release/checklist.md).

Verdict: the documentation and dependency configuration are cleaner; main still
has concrete onboarding and release-validation blockers. Passing local unit tests
cannot substitute for the failed image, coverage, and live checks.

Not checked: every application path, production infrastructure, real mail delivery,
Jitsi media, a fresh Docker/demo installation, or a complete security/scale audit.

## Local verification of this cleanup

Final commands used Node.js 24.18.0 and pnpm 11.18.0. An initial pass used the
host's Node.js 24.15.0; the pinned rerun reused Turbo results for unchanged
build/type/lint tasks and executed tests again.

| Check                                                          | Result                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm format:check`                                            | Passed                                                                     |
| `pnpm typecheck`                                               | Passed, 13 tasks                                                           |
| `pnpm lint`                                                    | Passed, 8 tasks                                                            |
| `pnpm build`                                                   | Passed, 8 tasks                                                            |
| `pnpm quality:boundaries`                                      | Passed                                                                     |
| `pnpm quality:launch-docs` and `pnpm quality:launch-docs:test` | Passed; 6 tests                                                            |
| Changed Markdown local link targets                            | Passed, 7 documents                                                        |
| Quick-start shell syntax and Compose service inventory         | Passed; no live installation attempted                                     |
| Dependabot YAML, grouping, and monitored directories           | Passed                                                                     |
| `pnpm test`                                                    | Failed on the existing profile-photo test in the complete suite; see below |

`apps/web/src/components/shell/settings-profile.test.tsx:100` expects “Add photo”
after removal but sees “Change photo”. This happened in both full runs, while the
isolated three-test file passed. Treat it as an unresolved suite/timing regression,
not proof that the production UI is broken or that the suite is clean. Application
and web test code were not modified by this cleanup.

The backend passed 3,598 tests and skipped 347 tests requiring additional live
services. Browser E2E/accessibility suites were not rerun because this change does
not modify web application code; the existing GitHub performance failure was
inspected. Production scans and the full clean-install/demo path still need their
own live verification.

## Follow-up on `fix/workspace-readiness-and-local-demo`

This branch applies #13 and #25 on current main and resolves the items below.

| Item                                   | Status                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts coverage (must fix 3)        | Fixed. Account and contacts schema tests raise lines to 94.36%, functions to 92.3%, and statements to 92.7%.                                                                         |
| Smoke `profile.read` scope             | Fixed in `live-auth-smoke.sh`'s default scope list.                                                                                                                                  |
| AWS test vector in secret scan         | Fixed. Only the published SigV4 vector in `sigv4.test.ts` is exempt; the self-test proves other keys in that file and the same key elsewhere still fail.                             |
| Login performance journey              | Fixed for the staged sign-in (“Sign in” heading, then **Next**).                                                                                                                     |
| RustFS and Cerbos image findings       | Fixed locally: RustFS 1.0.1 and the rebuilt Cerbos (go-git v6.0.0-alpha.5) report 0 High/Critical findings in Trivy; so does Redis 8.10.2. CI must confirm on the pushed digests.    |
| CloudNativePG PostgreSQL findings      | **Open.** The pinned 18.6-minimal-trixie digest is current; all 64 High/Critical package findings have no released fix. This needs a disposition decision or a different base image. |
| Single-tenant create/invite onboarding | **Open.** Still required; #15 stays open until it is replaced.                                                                                                                       |
| Local quick start                      | Fixed: `HELIX_DEFAULT_ORG_ID` must name the demo tenant, and `RUSTFS_ENDPOINT` must use `127.0.0.1`, which the outbound request guard accepts.                                       |
| Web suite                              | Profile-photo, compose-focus, and admin suspend/restore tests now wait for the UI; the full web suite passed twice (1,270 tests).                                                    |
