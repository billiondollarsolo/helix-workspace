# Release-readiness evidence layout (G0.5)

**Date:** 2026-08-02

Aligned with `docs/final-release-readiness.md` and v1 bible appendix §17.

```text
artifacts/release-readiness/<YYYY-MM-DD>/<git-sha>/
  baseline-smoke.md
  gates.txt
  inventory.md                    # copy or link of G0.1
  packaging-matrix.md             # G0.6
  deploy/
    compose/                      # O-D.*
    helm/                         # O-K.*
    cross/                        # O-X.*
  mail/ drive/ chat/ agent/ meet/
  validation/
  rollout/
```

- Directory is **gitignored** (CI artifact / local only); do not commit customer data.
- Bind `HELIX_RELEASE_WORKSPACE_SHA` and editors SHA for final-release mode.
- Final-release flags (mail-live-evidence, drive-live-evidence, …) map to M7, D7, C6, A7, O-D.16, O-K.18, V6, R3 in the v1 bible.
