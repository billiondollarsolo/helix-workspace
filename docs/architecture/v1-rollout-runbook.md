# Full Workspace v1 rollout runbook (Phase R)

**Date:** 2026-08-02  
**Scope:** R0–R3 operator steps after Validation (V) and Packaging (PKG) gates.

## Preconditions

1. Phase V validation harnesses green (mail/drive/chat/agent live evidence or documented env block).
2. Negative security matrix executed for tenant isolation.
3. Packaging profile decision recorded:
   - MVP: `HELIX_WORKSPACE_PROFILE=mvp` (default), `HELIX_APPS=mail,drive,chat,assistant`
   - Full Workspace: `HELIX_WORKSPACE_PROFILE=full` only after domain gates + Meet/Jitsi + ClamAV + editors pin
4. HA RPO/RTO targets understood (`docs/architecture/ha-rpo-rto.md`).

## R0 — Staging promote

- [ ] Promote images by digest (never `:latest` in production assertions).
- [ ] Apply Helm values tier (`values-business.yaml` or compose production).
- [ ] Smoke `/readyz` and auth login.

## R1 — Canary / pilot cohort

- [ ] Enable Full Workspace profile only for pilot org if domain evidence complete.
- [ ] Watch error budgets, mail outbound, drive scan queue, chat WS.

## R2 — Expand

- [ ] Expand cohort; keep rollback to MVP allowlist documented.
- [ ] Re-run failure-recovery runner and restore drill smoke.

## R3 — GA exit

- [ ] Evidence pack under `artifacts/release-readiness/<date>/<sha>/`
- [ ] Final-release artifacts script completed
- [ ] Only then start Phase S+ (public SaaS) per ADR-0012

## Rollback

Set `HELIX_WORKSPACE_PROFILE=mvp`, `HELIX_APPS=mail,drive,chat,assistant`,
`HELIX_EDITORS_MIGRATIONS_ENABLED=false`, modules calendar/meet/docs/editors disabled,
`VITE_HELIX_MVP_ONLY=true`. Redeploy previous digests.
