# MVP R3 structural decision (engineering gates)

**Date:** 2026-08-03  
**Audience:** Release owners, implementers, pilot sponsors  
**Normative plan:** [`docs/superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md`](../superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md)  
**Final claim path:** [`docs/final-release-readiness.md`](../final-release-readiness.md)  
**Product claims:** [`docs/product-claims-mvp.md`](../product-claims-mvp.md)

## Decision

| Field                            | Value                                                      |
| -------------------------------- | ---------------------------------------------------------- |
| Decision class                   | **Structural / engineering progress**                      |
| Production GO                    | **Not claimed**                                            |
| Conditional GO (signed, timed)   | **Not issued**                                             |
| No-GO for final production claim | **Yes**, until live + dogfood/pilot + soak residuals close |

### What advanced (may be treated as engineering gates / unit productionization)

- MVP packaging fail-closed posture is encoded in production Compose and AGENTS.md (Mail, Drive, Chat, Assistant; Cal/Meet/Editors off).
- Production Compose structure: digest-required images, secret-file mounts, data-plane ports unpublished, edge-only Caddy + inbound SMTP publish set, Meet credentials reset.
- Pilot install path documented: [`docs/runbooks/pilot-install-zero-to-mail.md`](../runbooks/pilot-install-zero-to-mail.md).
- Search/reindex unit surface productionized further: Meilisearch client/indexer/tools tests green; admin reindex **cross-org denial** and **actor-org default scope** enforced in `apps/helix/src/platform/search/admin-routes.ts` with tests.
- Live evidence CLIs exist with static contract validation modes (mail, drive, chat, agent, data-plane) — **static ≠ live GO**.

### What is explicitly not claimed

- Calendar-time **internal dogfood** (E12.1) completion.
- **Private pilot** (E12.2) completion or sponsor sign-off.
- **24h soak** / SLO sample (E11.SOAK).
- **Live** M7 Mail, D7 Drive, C6 Chat, A7 Agent, O2 data-plane, O4 restore, V4 failure/recovery, V5 DAST green JSON in a release packet.
- Final `--final-release` readiness manifest GO.
- Full Workspace enablement (Cal/Meet/Editors) — remains deferred after true R3.

## Conditional residual ownership

Residuals are **owned**, not silently waived:

| Residual cluster                                             | Primary owner                     | Exit                                                               |
| ------------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------ |
| Live evidence packet (E11.M/D/C/A, O2, O4, V4, V5, V6, SOAK) | Domain eng + ops + security       | Bound green JSON + full gates on release SHA                       |
| Dogfood + pilot calendar work (E12.1–E12.2)                  | Product + pilot sponsor + support | Notes + sponsor feedback; no open P0                               |
| Signed R3 decision artifact                                  | Release authority                 | `go` or owned unexpired `conditional_go` per final-release schemas |
| Format/docs gate nits (e.g. claims formatting if still open) | Docs/eng                          | Clean mandatory gates on release SHA                               |

## Relationship to final release mode

Per `docs/final-release-readiness.md`, ordinary manifests may validate supplied evidence only. **Production promotion** requires fail-closed `--final-release` with live gates and supporting R0–R3 artifacts. This structural decision **does not** satisfy that mode.

## Summary sentence (for phase ledgers)

**Engineering gates and unit productionization advanced; calendar-time dogfood / 24h soak / live M7–D7 (and peer live gates) not claimed GO; residual ownership is conditional and explicit.**
