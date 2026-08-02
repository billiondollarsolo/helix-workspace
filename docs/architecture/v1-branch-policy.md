# Full Workspace v1 branch and PR policy

**Date:** 2026-08-02  
**Task:** G0.2

## Rules

1. **Base all new work on current `main`.** Do not merge `agent/top-10-greenfield-improvements` wholesale.
2. **One plan Task ID per PR** (or a tightly coupled pair named in Depends on).
3. **Same branch name** in `helix-workspace` and `helix-editors` when both change.
4. **No force-push to `main`.** Prefer GitHub PR merge.
5. **Failing tests first** for behavior changes; capture evidence under `artifacts/release-readiness/` (gitignored) when required.
6. **Packaging flags** (`HELIX_APPS`, `VITE_HELIX_MVP_ONLY`, Meet/Editors enables) only change under PKG.* / domain enablement tasks after evidence.

## In-flight branch dispositions (as of 2026-08-02)

| Branch                                                   | Disposition                      | Notes                                                                                     |
| -------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| `main`                                                   | source of truth                  | production MVP fail-closed                                                                |
| `agent/top-10-greenfield-improvements`                   | **archive / do not merge whole** | Stale WIP; salvage only via UX.* re-implement on main                                     |
| `agent/shell-resilience-data-loss-guards`                | **salvage via UX.\***            | Offline banner, recovery, a11y, mobile; re-land on main-based branch, not merge tip as-is |
| `docs/helix-full-workspace-v1-release`                   | **docs source**                  | Hosts v1 bible; merge docs to main via PR                                                 |
| `agent/v1-g0-baseline`                                   | **active**                       | G0 inventory/ADR/packaging baseline                                                       |
| `origin/agent/core-workspace-production-readiness`       | historical / merged work         | PR #3 lineage                                                                             |
| `origin/ui-overhaul`, `feat/elite-cross-drive-mail-chat` | review before use                | Not default base                                                                          |

## PR description must include

```md
## Plan task

- Task ID:
- User-visible outcome:
- Security boundary changed: yes/no
```

## Forbidden

- Enabling Meet/Calendar/Editors to “make the demo look complete” without PKG/domain gates.
- Copying `helix-editors` source into this repo.
- Committing secrets, production credentials, or raw customer data.
