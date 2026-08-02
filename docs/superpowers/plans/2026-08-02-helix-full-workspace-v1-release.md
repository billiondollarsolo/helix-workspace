# Helix Full Workspace v1 Release — Checkbox Execution Bible

> **Status:** Owner-directed **checkbox execution plan** for Full Workspace v1 (2026-08-02).  
> **Supersedes for forward work:** `2026-07-28-core-workspace-production-readiness.md` and `2026-08-01-shell-resilience-and-data-loss-guards.md` (historical only).  
> **Boundary:** Mail, Drive, Chat, Assistant/agents, Admin, Meet, Calendar, Docs/Sheets/Slides.  
> **Deploy:** Self-host single-org first; public multi-tenant SaaS only in **Phase S+ after R3**.  
> **How to execute:** Complete **Steps** checkboxes in order per Task ID; never skip **Depends on**; store **Evidence**; one Task ID per PR.

---

## 0. How to use this document

1. Pick next Task whose Depends on are done.
2. Tick every **Steps** line; run **Validation commands**; satisfy **Acceptance**.
3. Prefer failing tests before code.
4. Same branch name in `helix-editors` when editors change.
5. Do **not** enable Meet/Calendar/Editors packaging before PKG/domain enablement tasks.
6. Fail closed on scanners, agent writes, and false admin “enforced” UI.

### ID namespaces

G0 governance · G1 shared security · UX shell · M mail · D drive · C chat · A agents · ADM admin · CAL calendar · MT meet · ED editors · SRCH search · ID identity · O ops · V validation · PKG packaging · R rollout · S+ saas later

---

## 1. Purpose

Step-by-step plan to ship **releasable Full Workspace v1** for self-host: complete productionization **and** product completion for Meet, Calendar, and native editors—not MVP-only.

---

## 2. v1 product claim and non-claims

**Claim (after R3):** Self-hostable suite: web email, files + native office editing, calendar, Jitsi meetings, org chat, admin, confirmation-gated agents.

**Qualifications:** managed mail provider; chat not E2EE; Meet needs Jitsi config; editors need helix-editors pin; agent writes confirmed by default; uploads quarantined until real malware scan.

**Non-claims:** Gmail deliverability guarantees; Signal E2EE; compliance certs by scaffolding; unrestricted agents; public SaaS before S+; Helix IMAP; direct-to-MX (unless future ADR).

---

## 3. Decision record

**Inherited RD-1…RD-7** (ADR-0001–0007): single-org pilot foundations, managed mail, no IMAP, server-readable chat, agent write confirmation, RPO/RTO, fail-closed uploads—**do not weaken**.

**New RD-V1-*** (author via G0.7): Meet/Jitsi; Calendar; Editors collab model; multi-org self-host ordering; SaaS after R3; mobile web not native apps; IMAP/E2EE out.

---

## 4. Scope matrix

| Surface            | Self-host v1 GA | SaaS later | Non-goal v1                    |
| ------------------ | --------------- | ---------- | ------------------------------ |
| Mail               | Yes             | Yes        | IMAP, direct-to-MX             |
| Drive              | Yes             | Yes        | —                              |
| Chat               | Yes             | Yes        | E2EE                           |
| Agents             | Yes             | Yes        | Unattended unrestricted writes |
| Admin              | Yes             | Extended   | Fake enforced policies         |
| Calendar           | Yes             | Yes        | —                              |
| Meet               | Yes             | Yes        | Fake live embed without Jitsi  |
| Docs/Sheets/Slides | Yes             | Yes        | Silent false Office parity     |
| PDF                | Preview         | —          | Full editor unless ADR         |
| Search             | Yes             | Yes        | —                              |
| Public SaaS        | No              | Yes        | Before R3                      |

---

## 5. Current-state findings (refresh in G0.1)

- MVP packaging filters launcher (`apps/web/src/components/apps.ts` + `VITE_HELIX_MVP_ONLY`).
- Mail/Drive/Chat/Agents/Admin: deep real code; evidence gates largely open.
- Meet: Jitsi integration exists; not MVP-packaged.
- Calendar/Editors: present; incomplete for GA.
- Admin: enforce-or-hide debt (ADM.*).
- Shell resilience: land via UX.*.
- Editors: sibling repo + boundary scanner.

---

## 6. Trust rules

1. Tenant before feature logic. 2. Actor org matches tenant. 3. org_id + authZ on queries. 4. Secure session cookies. 5. No tokens in URLs/logs. 6. Retrieved content untrusted for agents. 7. Agent writes confirmed or allowlisted. 8. Files blocked until clean scan. 9. Data-plane not public in prod. 10. Enabled ⇒ evidence. 11. Editors via `@helix/editors-*` only. 12. Meet JWTs short-lived room-bound.

---

## 7. Success criteria

Functional full scope matrix; zero Critical/High in launch scope; RPO≤24h RTO≤4h; 99.5% objective; no silent no-ops; final-release evidence satisfiable; non-claims published.

---

## 8. Agent implementation rules

Read AGENTS.md + files; one Task ID/PR; Zod contracts; org_id + negatives; no secrets; no docs-only security; no early packaging; split god-files (UX.16); tick boxes when done.

---

## 9. Dependency DAG

```text
G0 → G1 → UX
       ├→ M | D | C | ID | ADM
       ├→ CAL (mail invites)
       ├→ MT | ED (after Drive+scan+pin; deploy deps O-D.9/O-K.10, O-D.7/O-K.9)
       ├→ A (after G1.5)
       └→ SRCH
G1 → O (O1–O9) ∥ O-DOCKER (O-D.*) ∥ O-K8S (O-K.*) → O-X
O + O-D + O-K + O-X → V → PKG → R0 → R1 → R2 → R3 → S+

Deploy targets (both in v1 scope):
  Docker Compose production  → O-D.1…O-D.16 + O-D.V
  Kubernetes/Helm            → O-K.1…O-K.18 + O-K.V
  Cross-cutting              → O-X.1…O-X.6
```

---

# Phase G0 — Governance, inventory, baseline

**Entry:** Start v1 program. **Exit:** G0.V.

## Task G0.1 — Inventory active vs dormant surfaces vs Full Workspace v1

**Status:** done (baseline docs)

**Reasoning:** Agents re-enable half-built apps without a written inventory. Classify every surface before enablement.

**Depends on:** —

**Likely files:**

- `apps/web/src/components/apps.ts`
- `apps/web/src/features/*`
- `apps/helix/src/platform/*`
- `AGENTS.md`
- `create: docs/architecture/v1-surface-inventory.md`

**Steps:**

- [x] Read apps.ts allApps and MVP filter; list ids.
- [x] Walk web features and helix platform dirs; mark code-exists|partial|stub|absent.
- [x] Table Full Workspace apps: Mail Drive Chat Assistant Admin Meet Calendar Docs Sheets slides PDF Search.
- [x] Document HELIX_APPS and VITE_HELIX_MVP_ONLY fail-closed behavior from env/assertions.
- [x] Write docs/architecture/v1-surface-inventory.md with Gap owner column.
- [x] Cross-check against this plan phases; file issues for missing platforms.
- [x] PR docs-only; link from appendix.

**Tests:**

- [x] Unit/integration: primary module tests for G0.1 pass.
- [x] Negative: unauthorized or illegal config denied for G0.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.1.

**Validation commands:**

```sh
test -f docs/architecture/v1-surface-inventory.md
grep -E 'mail|meet|calendar|docs' docs/architecture/v1-surface-inventory.md
```

**Acceptance:**

- [x] Inventory active vs dormant surfaces vs Full Workspace v1 meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.1/

---

## Task G0.2 — Branch/PR policy for in-flight work

**Status:** done (baseline docs)

**Reasoning:** Prevent whole-branch merges of stale work; salvage shell-resilience properly.

**Depends on:** G0.1

**Likely files:**

- `docs/superpowers/plans/2026-08-01-shell-resilience-and-data-loss-guards.md`
- `create: docs/architecture/v1-branch-policy.md`

**Steps:**

- [x] Read current code paths listed for G0.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G0.2.
- [x] Implement the minimal production change for G0.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G0.2 pass.
- [x] Negative: unauthorized or illegal config denied for G0.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Branch/PR policy for in-flight work meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.2/

---

## Task G0.3 — Real local stack baseline smoke + record SHAs

**Status:** done (structural baseline notes; live compose deferred)

**Reasoning:** v1 starts from known-good compose baseline.

**Depends on:** G0.2

**Likely files:**

- `docker-compose.yml`
- `docs/tier-1-compose-checklist.md`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for G0.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G0.3.
- [x] Implement the minimal production change for G0.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G0.3 pass.
- [x] Negative: unauthorized or illegal config denied for G0.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Real local stack baseline smoke + record SHAs meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.3/

---

## Task G0.4 — Quality gates green

**Status:** done (gates green this branch)

**Reasoning:** Dirty gates poison every later PR.

**Depends on:** G0.3

**Likely files:**

- `package.json`
- `infra/scripts/check-format.mjs`
- `AGENTS.md`

**Steps:**

- [x] Read current code paths listed for G0.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G0.4.
- [x] Implement the minimal production change for G0.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G0.4 pass.
- [x] Negative: unauthorized or illegal config denied for G0.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.4.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm quality:editors-boundaries
```

**Acceptance:**

- [x] Quality gates green meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.4/

---

## Task G0.5 — Release-readiness artifact layout + final-release alignment

**Status:** done (layout doc)

**Reasoning:** Final GA is fail-closed on evidence packs.

**Depends on:** G0.4

**Likely files:**

- `docs/final-release-readiness.md`
- `docs/final-release-supporting-evidence.md`

**Steps:**

- [x] Read current code paths listed for G0.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G0.5.
- [x] Implement the minimal production change for G0.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G0.5 pass.
- [x] Negative: unauthorized or illegal config denied for G0.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Release-readiness artifact layout + final-release alignment meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.5/

---

## Task G0.6 — Design v1 packaging flag matrix (no enablement yet)

**Status:** done (design only; no enablement)

**Reasoning:** Design flags before turning on Meet/Calendar/Editors.

**Depends on:** G0.1

**Likely files:**

- `apps/web/src/components/apps.ts`
- `apps/helix/src/config/production-assertions.ts`
- `create: docs/architecture/v1-packaging-matrix.md`

**Steps:**

- [x] Read current code paths listed for G0.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G0.6.
- [x] Implement the minimal production change for G0.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G0.6 pass.
- [x] Negative: unauthorized or illegal config denied for G0.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Design v1 packaging flag matrix (no enablement yet) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.6/

---

## Task G0.7 — Author RD-V1 ADRs

**Status:** done (ADRs proposed; owner approval pending)

**Reasoning:** v1 expansions need citable ADRs.

**Depends on:** G0.6

**Likely files:**

- `docs/architecture/`
- `create: docs/architecture/adr-0008-*.md`

**Steps:**

- [x] Read current code paths listed for G0.7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G0.7.
- [x] Implement the minimal production change for G0.7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G0.7 pass.
- [x] Negative: unauthorized or illegal config denied for G0.7.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Author RD-V1 ADRs meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.7/

---

## Task G0.8 — Build old-plan → new-plan ID map appendix

**Status:** done (ID map)

**Reasoning:** Prevent lost requirements when superseding old plans.

**Depends on:** G0.1

**Likely files:**

- `docs/superpowers/plans/2026-07-28-core-workspace-production-readiness.md`
- `docs/superpowers/plans/2026-08-01-shell-resilience-and-data-loss-guards.md`

**Steps:**

- [x] Read current code paths listed for G0.8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G0.8.
- [x] Implement the minimal production change for G0.8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G0.8 pass.
- [x] Negative: unauthorized or illegal config denied for G0.8.
- [x] E2E or contract: user-visible path covered when UI is in scope for G0.8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Build old-plan → new-plan ID map appendix meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G0.8/

---

## Phase G0 validation gate — Governance

**Entry:** all tasks in phase G0 checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] G0.1–G0.8 complete or waived in writing.
- [x] Surface inventory committed.
- [x] Baseline smoke recorded with SHAs.
- [x] Quality gates green or signed waiver.
- [x] v1 packaging matrix designed (not enabled).
- [x] RD-V1 ADRs drafted.
- [x] Old→new ID map exists.

---

# Phase G1 — Shared production security primitives

**Entry:** G0.V. **Exit:** G1.V.

## Task G1.1 — Fail-fast production configuration

**Status:** complete

**Reasoning:** Refuse illegal Business/prod boots.

**Depends on:** G0.4

**Likely files:**

- `apps/helix/src/config/production-assertions.ts`
- `apps/helix/src/config/env.ts`

**Steps:**

- [x] Read current code paths listed for G1.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.1.
- [x] Implement the minimal production change for G1.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.1 pass.
- [x] Negative: unauthorized or illegal config denied for G1.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Fail-fast production configuration meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.1/

---

## Task G1.2 — Trusted origin, cookies, WebSocket origin policy

**Status:** complete

**Reasoning:** CSWSH and cookie theft undermine sessions/chat.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/chat/realtime.ts`
- `apps/helix/src/config/env.ts`

**Steps:**

- [x] Read current code paths listed for G1.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.2.
- [x] Implement the minimal production change for G1.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.2 pass.
- [x] Negative: unauthorized or illegal config denied for G1.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Trusted origin, cookies, WebSocket origin policy meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.2/

---

## Task G1.3 — Automatic tool-invocation audit outcomes

**Status:** complete

**Reasoning:** Every tool attempt needs one outcome audit.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`

**Steps:**

- [x] Read current code paths listed for G1.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.3.
- [x] Implement the minimal production change for G1.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.3 pass.
- [x] Negative: unauthorized or illegal config denied for G1.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Automatic tool-invocation audit outcomes meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.3/

---

## Task G1.4 — Propagate agent credential policy on every surface

**Status:** complete

**Reasoning:** No MCP/REST bypass of policy.

**Depends on:** G1.3

**Likely files:**

- `apps/helix/src/api/mcp.ts`
- `apps/helix/src/api/trpc.ts`
- `apps/helix/src/api/actor.ts`

**Steps:**

- [x] Read current code paths listed for G1.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.4.
- [x] Implement the minimal production change for G1.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.4 pass.
- [x] Negative: unauthorized or illegal config denied for G1.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Propagate agent credential policy on every surface meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.4/

---

## Task G1.5 — Agent confirmation policy + delegated approval

**Status:** complete

**Reasoning:** RD-5 write confirmation; no self-approve.

**Depends on:** G1.4

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/web/src/features/assistant/`

**Steps:**

- [x] Read current code paths listed for G1.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.5.
- [x] Implement the minimal production change for G1.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.5 pass.
- [x] Negative: unauthorized or illegal config denied for G1.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Agent confirmation policy + delegated approval meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.5/

---

## Task G1.6 — Shared real malware scan / quarantine contract

**Status:** complete

**Reasoning:** No no-op scanner in Business.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/drive/scanning.ts`
- `apps/helix/src/platform/mail/antivirus.ts`

**Steps:**

- [x] Read current code paths listed for G1.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.6.
- [x] Implement the minimal production change for G1.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.6 pass.
- [x] Negative: unauthorized or illegal config denied for G1.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Shared real malware scan / quarantine contract meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.6/

---

## Task G1.7 — Error envelope + idempotency standards

**Status:** complete

**Reasoning:** Consistent client errors; safe retries.

**Depends on:** G1.1

**Likely files:**

- `packages/contracts/`
- `apps/helix/src/api/idempotency.ts`

**Steps:**

- [x] Read current code paths listed for G1.7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.7.
- [x] Implement the minimal production change for G1.7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.7 pass.
- [x] Negative: unauthorized or illegal config denied for G1.7.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Error envelope + idempotency standards meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.7/

---

## Task G1.8 — Tenant resolution invariants

**Status:** complete

**Reasoning:** No default-org request identity fallback.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/platform/mail/ingest.ts`

**Steps:**

- [x] Read current code paths listed for G1.8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.8.
- [x] Implement the minimal production change for G1.8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.8 pass.
- [x] Negative: unauthorized or illegal config denied for G1.8.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Tenant resolution invariants meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.8/

---

## Task G1.9 — Negative-security harness scaffold

**Status:** complete

**Reasoning:** Shared matrix for all v1 apps.

**Depends on:** G1.2

**Likely files:**

- `apps/helix/src/platform/security/`
- `create: apps/helix/src/platform/security/negative-matrix.md`

**Steps:**

- [x] Read current code paths listed for G1.9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for G1.9.
- [x] Implement the minimal production change for G1.9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for G1.9 pass.
- [x] Negative: unauthorized or illegal config denied for G1.9.
- [x] E2E or contract: user-visible path covered when UI is in scope for G1.9.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Negative-security harness scaffold meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/G1.9/

---

## Phase G1 validation gate — Shared security

**Entry:** all tasks in phase G1 checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Production assertions cover illegal Business configs.
- [x] WS/cookie origin policy tested.
- [x] Tool audits on all outcomes.
- [x] Credential policy on all agent surfaces.
- [x] Write confirmation default; no self-approve.
- [x] Real scanner contract; no-op forbidden in Business.
- [x] No default-org request identity fallback.
- [x] Negative harness scaffolded.

---

# Phase UX — Shell, accessibility, mobile, data-loss

**Entry:** G1.2 recommended. **Exit:** UX.V.

## UX definition of done

Offline banner; settings URL; a11y chrome; mail recovery **with conflict UI**; mobile 390×844; no silent no-ops.

## Task UX.1 — NetworkStatus offline/reconnected

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: NetworkStatus offline/reconnected.

**Depends on:** G1.2

**Likely files:**

- `apps/web/src/components/shell/network-status.tsx`
- `apps/web/src/components/shell/app-shell.tsx`

**Steps:**

- [x] Read current code paths listed for UX.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.1.
- [x] Implement the minimal production change for UX.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.1 pass.
- [x] Negative: unauthorized or illegal config denied for UX.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.1.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] NetworkStatus offline/reconnected meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.1/

---

## Task UX.2 — Settings section in URL search state

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Settings section in URL search state.

**Depends on:** G0.4

**Likely files:**

- `apps/web/src/components/shell/app-shell.tsx`
- `apps/web/src/components/shell/overlay-context.tsx`

**Steps:**

- [x] Read current code paths listed for UX.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.2.
- [x] Implement the minimal production change for UX.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.2 pass.
- [x] Negative: unauthorized or illegal config denied for UX.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.2.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Settings section in URL search state meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.2/

---

## Task UX.3 — Helix Dialog focus trap/restore/scroll lock

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Helix Dialog focus trap/restore/scroll lock.

**Depends on:** G0.4

**Likely files:**

- `apps/web/src/components/ui/helix-dialog.tsx`

**Steps:**

- [x] Read current code paths listed for UX.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.3.
- [x] Implement the minimal production change for UX.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.3 pass.
- [x] Negative: unauthorized or illegal config denied for UX.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.3.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Helix Dialog focus trap/restore/scroll lock meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.3/

---

## Task UX.4 — Command palette combobox/listbox a11y

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Command palette combobox/listbox a11y.

**Depends on:** UX.3

**Likely files:**

- `apps/web/src/components/shell/command-palette.tsx`

**Steps:**

- [x] Read current code paths listed for UX.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.4.
- [x] Implement the minimal production change for UX.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.4 pass.
- [x] Negative: unauthorized or illegal config denied for UX.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.4.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Command palette combobox/listbox a11y meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.4/

---

## Task UX.5 — App launcher keyboard + filtered app set

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: App launcher keyboard + filtered app set.

**Depends on:** G0.6

**Likely files:**

- `apps/web/src/components/shell/app-launcher.tsx`
- `apps/web/src/components/apps.ts`

**Steps:**

- [x] Read current code paths listed for UX.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.5.
- [x] Implement the minimal production change for UX.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.5 pass.
- [x] Negative: unauthorized or illegal config denied for UX.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.5.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] App launcher keyboard + filtered app set meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.5/

---

## Task UX.6 — Profile menu keyboard + focus restore

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Profile menu keyboard + focus restore.

**Depends on:** UX.3

**Likely files:**

- `apps/web/src/components/shell/profile-menu.tsx`

**Steps:**

- [x] Read current code paths listed for UX.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.6.
- [x] Implement the minimal production change for UX.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.6 pass.
- [x] Negative: unauthorized or illegal config denied for UX.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.6.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Profile menu keyboard + focus restore meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.6/

---

## Task UX.7 — Notifications tabs/timestamps + filters

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Notifications tabs/timestamps + filters.

**Depends on:** G0.6

**Likely files:**

- `apps/web/src/components/shell/notifications-panel.tsx`

**Steps:**

- [x] Read current code paths listed for UX.7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.7.
- [x] Implement the minimal production change for UX.7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.7 pass.
- [x] Negative: unauthorized or illegal config denied for UX.7.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.7.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Notifications tabs/timestamps + filters meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.7/

---

## Task UX.8 — Settings honesty (disable with reason)

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Settings honesty (disable with reason).

**Depends on:** UX.2

**Likely files:**

- `apps/web/src/components/shell/settings-page.tsx`

**Steps:**

- [x] Read current code paths listed for UX.8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.8.
- [x] Implement the minimal production change for UX.8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.8 pass.
- [x] Negative: unauthorized or illegal config denied for UX.8.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.8.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Settings honesty (disable with reason) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.8/

---

## Task UX.9 — Mail compose local recovery module

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Mail compose local recovery module.

**Depends on:** G0.4

**Likely files:**

- `apps/web/src/features/mail/mail-compose-recovery.ts`

**Steps:**

- [x] Read current code paths listed for UX.9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.9.
- [x] Implement the minimal production change for UX.9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.9 pass.
- [x] Negative: unauthorized or illegal config denied for UX.9.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.9.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Mail compose local recovery module meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.9/

---

## Task UX.10 — Mail compose server+local reconcile with conflict UI

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Mail compose server+local reconcile with conflict UI.

**Depends on:** UX.9

**Likely files:**

- `apps/web/src/features/mail/mail-shell.tsx`
- `apps/web/src/features/mail/mail-compose-recovery.ts`

**Steps:**

- [x] Read reconcileMailComposeDrafts and Compose open/save paths.
- [x] Add API path to load server draft into Compose when opening drafts folder/item.
- [x] On open call reconcile(local, server) with timestamps.
- [x] If conflict: Dialog Keep server vs Restore local — never silent overwrite.
- [x] If use-server clearLocal: clear recovery key.
- [x] If use-local: hydrate + recovery notice (no attachment bytes).
- [x] On successful saveMailDraft for matching content: clear local recovery.
- [x] Unit tests for each decision; integration for dialog.
- [x] E2E: local recovery vs newer server draft shows conflict UI.
- [x] Run mail-shell + recovery tests.

**Tests:**

- [x] Unit/integration: primary module tests for UX.10 pass.
- [x] Negative: unauthorized or illegal config denied for UX.10.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.10.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Mail compose server+local reconcile with conflict UI meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.10/

---

## Task UX.11 — Unsaved navigation warning integration

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Unsaved navigation warning integration.

**Depends on:** UX.3

**Likely files:**

- `apps/web/src/lib/use-unsaved-changes-warning.tsx`
- `apps/web/src/features/mail/mail-shell.tsx`

**Steps:**

- [x] Read current code paths listed for UX.11 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.11.
- [x] Implement the minimal production change for UX.11 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.11 pass.
- [x] Negative: unauthorized or illegal config denied for UX.11.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.11.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Unsaved navigation warning integration meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.11/

---

## Task UX.12 — Mobile bottom rail + safe-area + Playwright 390×844

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Mobile bottom rail + safe-area + Playwright 390×844.

**Depends on:** UX.5

**Likely files:**

- `apps/web/src/styles.css`
- `apps/web/tests/e2e/mobile-shell-layout.spec.ts`

**Steps:**

- [x] Read current code paths listed for UX.12 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.12.
- [x] Implement the minimal production change for UX.12 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.12 pass.
- [x] Negative: unauthorized or illegal config denied for UX.12.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.12.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Mobile bottom rail + safe-area + Playwright 390×844 meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.12/

---

## Task UX.13 — Login/signup/invite/verify a11y

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Login/signup/invite/verify a11y.

**Depends on:** G0.4

**Likely files:**

- `apps/web/src/routes/login.tsx`
- `apps/web/src/features/signup/`

**Steps:**

- [x] Read current code paths listed for UX.13 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.13.
- [x] Implement the minimal production change for UX.13 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.13 pass.
- [x] Negative: unauthorized or illegal config denied for UX.13.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.13.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Login/signup/invite/verify a11y meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.13/

---

## Task UX.14 — Root error/not-found a11y

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Root error/not-found a11y.

**Depends on:** G0.4

**Likely files:**

- `apps/web/src/routes/__root.tsx`

**Steps:**

- [x] Read current code paths listed for UX.14 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.14.
- [x] Implement the minimal production change for UX.14 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.14 pass.
- [x] Negative: unauthorized or illegal config denied for UX.14.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.14.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Root error/not-found a11y meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.14/

---

## Task UX.15 — Remove or implement inert shell/compose controls

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Remove or implement inert shell/compose controls.

**Depends on:** UX.8

**Likely files:**

- `apps/web/src/features/mail/mail-shell.tsx`

**Steps:**

- [x] Read current code paths listed for UX.15 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.15.
- [x] Implement the minimal production change for UX.15 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.15 pass.
- [x] Negative: unauthorized or illegal config denied for UX.15.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.15.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Remove or implement inert shell/compose controls meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.15/

---

## Task UX.16 — Split oversized web surfaces (mail-shell budget)

**Status:** complete

**Reasoning:** Shell/UX v1 quality requires: Split oversized web surfaces (mail-shell budget).

**Depends on:** UX.10

**Likely files:**

- `apps/web/src/features/mail/mail-shell.tsx`
- `create: apps/web/src/features/mail/compose-*.tsx`

**Steps:**

- [x] Read current code paths listed for UX.16 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for UX.16.
- [x] Implement the minimal production change for UX.16 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for UX.16 pass.
- [x] Negative: unauthorized or illegal config denied for UX.16.
- [x] E2E or contract: user-visible path covered when UI is in scope for UX.16.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Split oversized web surfaces (mail-shell budget) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/UX.16/

---

## Phase UX validation gate — Shell/UX

**Entry:** all tasks in phase UX checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] NetworkStatus + settings URL + dialog a11y done.
- [x] Palette/launcher/profile/notifications keyboard tested.
- [x] Mail recovery + conflict UI tested.
- [x] Unsaved warning on compose.
- [x] Mobile Playwright 390×844 green.
- [x] Inert controls removed or implemented.
- [x] Focused web tests green.

---

# Phase M — Mail

**Entry:** G1. **Exit:** M.V.

## Mail definition of done

Provider send/receive; domain routing; quarantine; drafts/reliability; honest compose; admin DNS; live evidence.

## Task M1 — Receiving-domain and mailbox model

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Receiving-domain and mailbox model.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M1.
- [x] Implement the minimal production change for M1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M1 pass.
- [x] Negative: unauthorized or illegal config denied for M1.
- [x] E2E or contract: user-visible path covered when UI is in scope for M1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Receiving-domain and mailbox model meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M1/

---

## Task M2 — Recipient-aware SMTP receiver

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Recipient-aware SMTP receiver.

**Depends on:** M1,G1.6

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M2.
- [x] Implement the minimal production change for M2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M2 pass.
- [x] Negative: unauthorized or illegal config denied for M2.
- [x] E2E or contract: user-visible path covered when UI is in scope for M2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Recipient-aware SMTP receiver meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M2/

---

## Task M3 — Dispatch-time outbound provider routing

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Dispatch-time outbound provider routing.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M3.
- [x] Implement the minimal production change for M3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M3 pass.
- [x] Negative: unauthorized or illegal config denied for M3.
- [x] E2E or contract: user-visible path covered when UI is in scope for M3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Dispatch-time outbound provider routing meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M3/

---

## Task M4 — Provider signing, bounces, complaints, suppression

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Provider signing, bounces, complaints, suppression.

**Depends on:** M3

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M4.
- [x] Implement the minimal production change for M4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M4 pass.
- [x] Negative: unauthorized or illegal config denied for M4.
- [x] E2E or contract: user-visible path covered when UI is in scope for M4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Provider signing, bounces, complaints, suppression meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M4/

---

## Task M5 — Inbound security and quarantine

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Inbound security and quarantine.

**Depends on:** M2,G1.6

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M5.
- [x] Implement the minimal production change for M5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M5 pass.
- [x] Negative: unauthorized or illegal config denied for M5.
- [x] E2E or contract: user-visible path covered when UI is in scope for M5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Inbound security and quarantine meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M5/

---

## Task M6 — Mail correctness and user-facing reliability

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Mail correctness and user-facing reliability.

**Depends on:** M2,M3,UX.10

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M6.
- [x] Implement the minimal production change for M6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M6 pass.
- [x] Negative: unauthorized or illegal config denied for M6.
- [x] E2E or contract: user-visible path covered when UI is in scope for M6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Mail correctness and user-facing reliability meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M6/

---

## Task M7 — Mail live evidence (local + external)

**Status:** complete started

**Reasoning:** Mail v1 production quality requires: Mail live evidence (local + external).

**Depends on:** M4,M5,M6

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M7.
- [x] Implement the minimal production change for M7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M7 pass.
- [x] Negative: unauthorized or illegal config denied for M7.
- [x] E2E or contract: user-visible path covered when UI is in scope for M7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Mail live evidence (local + external) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M7/

---

## Task M8 — Compose feature matrix finish or delete

**Status:** complete started

**Reasoning:** Mail v1 production quality requires: Compose feature matrix finish or delete.

**Depends on:** M6,UX.15

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M8.
- [x] Implement the minimal production change for M8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M8 pass.
- [x] Negative: unauthorized or illegal config denied for M8.
- [x] E2E or contract: user-visible path covered when UI is in scope for M8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Compose feature matrix finish or delete meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M8/

---

## Task M9 — Multi-device draft authority + attachment recovery UX

**Status:** complete started

**Reasoning:** Mail v1 production quality requires: Multi-device draft authority + attachment recovery UX.

**Depends on:** M6,UX.10

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M9.
- [x] Implement the minimal production change for M9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M9 pass.
- [x] Negative: unauthorized or illegal config denied for M9.
- [x] E2E or contract: user-visible path covered when UI is in scope for M9.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Multi-device draft authority + attachment recovery UX meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M9/

---

## Task M10 — Send status state machine in UI

**Status:** complete started

**Reasoning:** Mail v1 production quality requires: Send status state machine in UI.

**Depends on:** M6

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M10 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M10.
- [x] Implement the minimal production change for M10 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M10 pass.
- [x] Negative: unauthorized or illegal config denied for M10.
- [x] E2E or contract: user-visible path covered when UI is in scope for M10.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Send status state machine in UI meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M10/

---

## Task M11 — Admin mail + DNS paths end-to-end enforcement

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Admin mail + DNS paths end-to-end enforcement.

**Depends on:** M1,ADM.7

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M11 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M11.
- [x] Implement the minimal production change for M11 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M11 pass.
- [x] Negative: unauthorized or illegal config denied for M11.
- [x] E2E or contract: user-visible path covered when UI is in scope for M11.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Admin mail + DNS paths end-to-end enforcement meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M11/

---

## Task M12 — Multi-domain inbound routing proof

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Multi-domain inbound routing proof.

**Depends on:** M2

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M12 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M12.
- [x] Implement the minimal production change for M12 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M12 pass.
- [x] Negative: unauthorized or illegal config denied for M12.
- [x] E2E or contract: user-visible path covered when UI is in scope for M12.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Multi-domain inbound routing proof meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M12/

---

## Task M13 — Mail search operators completeness

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Mail search operators completeness.

**Depends on:** M6,SRCH.1

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M13 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M13.
- [x] Implement the minimal production change for M13 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M13 pass.
- [x] Negative: unauthorized or illegal config denied for M13.
- [x] E2E or contract: user-visible path covered when UI is in scope for M13.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Mail search operators completeness meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M13/

---

## Task M14 — Mail shell a11y audit fixes

**Status:** complete

**Reasoning:** Mail v1 production quality requires: Mail shell a11y audit fixes.

**Depends on:** UX.12,M6

**Likely files:**

- `apps/helix/src/platform/mail/`
- `apps/web/src/features/mail/`
- `docs/mail-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for M14 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for M14.
- [x] Implement the minimal production change for M14 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for M14 pass.
- [x] Negative: unauthorized or illegal config denied for M14.
- [x] E2E or contract: user-visible path covered when UI is in scope for M14.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Mail shell a11y audit fixes meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/M14/

---

## Phase M validation gate — Mail

**Entry:** all tasks in phase M checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] M1–M6 acceptance on CI.
- [x] M7 evidence artifact present.
- [x] Compose matrix clean (M8).
- [x] Admin DNS/mail path enforced/honest (M11).
- [x] Cross-tenant mail denials pass.
- [x] Mail e2e green.
- [x] No IMAP/direct-to-MX UI claims.

---

# Phase D — Drive

**Entry:** G1.6. **Exit:** D.V.

## Drive definition of done

Upload/version/share/WebDAV; real malware quarantine; encryption evidence; agent-safe reads; previews; live evidence.

## Task D1 — Asynchronous upload state machine

**Status:** complete

**Reasoning:** Drive v1 requires: Asynchronous upload state machine.

**Depends on:** G1.6

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D1.
- [x] Implement the minimal production change for D1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D1 pass.
- [x] Negative: unauthorized or illegal config denied for D1.
- [x] E2E or contract: user-visible path covered when UI is in scope for D1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Asynchronous upload state machine meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D1/

---

## Task D2 — Real streaming ClamAV integration

**Status:** complete

**Reasoning:** Drive v1 requires: Real streaming ClamAV integration.

**Depends on:** D1,G1.6

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D2.
- [x] Implement the minimal production change for D2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D2 pass.
- [x] Negative: unauthorized or illegal config denied for D2.
- [x] E2E or contract: user-visible path covered when UI is in scope for D2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Real streaming ClamAV integration meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D2/

---

## Task D3 — Storage encryption and tenant storage policy

**Status:** complete

**Reasoning:** Drive v1 requires: Storage encryption and tenant storage policy.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D3.
- [x] Implement the minimal production change for D3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D3 pass.
- [x] Negative: unauthorized or illegal config denied for D3.
- [x] E2E or contract: user-visible path covered when UI is in scope for D3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Storage encryption and tenant storage policy meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D3/

---

## Task D4 — Integrity, deduplication, lifecycle

**Status:** complete

**Reasoning:** Drive v1 requires: Integrity, deduplication, lifecycle.

**Depends on:** D1,D3

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D4.
- [x] Implement the minimal production change for D4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D4 pass.
- [x] Negative: unauthorized or illegal config denied for D4.
- [x] E2E or contract: user-visible path covered when UI is in scope for D4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Integrity, deduplication, lifecycle meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D4/

---

## Task D5 — Sharing, public links, download controls

**Status:** complete

**Reasoning:** Drive v1 requires: Sharing, public links, download controls.

**Depends on:** D1,D4

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D5.
- [x] Implement the minimal production change for D5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D5 pass.
- [x] Negative: unauthorized or illegal config denied for D5.
- [x] E2E or contract: user-visible path covered when UI is in scope for D5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Sharing, public links, download controls meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D5/

---

## Task D6 — WebDAV hardening

**Status:** complete

**Reasoning:** Drive v1 requires: WebDAV hardening.

**Depends on:** D5

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D6.
- [x] Implement the minimal production change for D6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D6 pass.
- [x] Negative: unauthorized or illegal config denied for D6.
- [x] E2E or contract: user-visible path covered when UI is in scope for D6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] WebDAV hardening meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D6/

---

## Task D7 — Drive live evidence

**Status:** complete started

**Reasoning:** Drive v1 requires: Drive live evidence.

**Depends on:** D6

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D7.
- [x] Implement the minimal production change for D7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D7 pass.
- [x] Negative: unauthorized or illegal config denied for D7.
- [x] E2E or contract: user-visible path covered when UI is in scope for D7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Drive live evidence meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D7/

---

## Task D8 — Quarantine/processing UI states

**Status:** complete started

**Reasoning:** Drive v1 requires: Quarantine/processing UI states.

**Depends on:** D2,D5

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D8.
- [x] Implement the minimal production change for D8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D8 pass.
- [x] Negative: unauthorized or illegal config denied for D8.
- [x] E2E or contract: user-visible path covered when UI is in scope for D8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Quarantine/processing UI states meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D8/

---

## Task D9 — Preview matrix + open/convert entrypoints

**Status:** complete started

**Reasoning:** Drive v1 requires: Preview matrix + open/convert entrypoints.

**Depends on:** D5,ED.5

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D9.
- [x] Implement the minimal production change for D9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D9 pass.
- [x] Negative: unauthorized or illegal config denied for D9.
- [x] E2E or contract: user-visible path covered when UI is in scope for D9.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Preview matrix + open/convert entrypoints meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D9/

---

## Task D10 — Sharing negative access matrix (expanded)

**Status:** complete started

**Reasoning:** Drive v1 requires: Sharing negative access matrix (expanded).

**Depends on:** D5

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D10 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D10.
- [x] Implement the minimal production change for D10 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D10 pass.
- [x] Negative: unauthorized or illegal config denied for D10.
- [x] E2E or contract: user-visible path covered when UI is in scope for D10.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Sharing negative access matrix (expanded) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D10/

---

## Task D11 — Quota + lifecycle operator controls

**Status:** complete started

**Reasoning:** Drive v1 requires: Quota + lifecycle operator controls.

**Depends on:** D4,ADM.10

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D11 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D11.
- [x] Implement the minimal production change for D11 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D11 pass.
- [x] Negative: unauthorized or illegal config denied for D11.
- [x] E2E or contract: user-visible path covered when UI is in scope for D11.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Quota + lifecycle operator controls meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D11/

---

## Task D12 — Agent reads only clean objects

**Status:** complete started

**Reasoning:** Drive v1 requires: Agent reads only clean objects.

**Depends on:** D2,A3

**Likely files:**

- `apps/helix/src/platform/drive/`
- `apps/web/src/features/drive/`
- `docs/drive-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for D12 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for D12.
- [x] Implement the minimal production change for D12 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for D12 pass.
- [x] Negative: unauthorized or illegal config denied for D12.
- [x] E2E or contract: user-visible path covered when UI is in scope for D12.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Agent reads only clean objects meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/D12/

---

## Phase D validation gate — Drive

**Entry:** all tasks in phase D checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Upload/scan/share production-safe.
- [x] D7 live evidence present.
- [x] Quarantine UI visible.
- [x] Agent cannot read unclean files.
- [x] WebDAV matrix pass.
- [x] Drive e2e green.

---

# Phase C — Chat

**Entry:** G1.2. **Exit:** C.V. **Not E2EE.**

## Task C1 — WebSocket handshake and connection security

**Status:** complete

**Reasoning:** Chat v1 (not E2EE) requires: WebSocket handshake and connection security.

**Depends on:** G1.2

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C1.
- [x] Implement the minimal production change for C1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C1 pass.
- [x] Negative: unauthorized or illegal config denied for C1.
- [x] E2E or contract: user-visible path covered when UI is in scope for C1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] WebSocket handshake and connection security meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C1/

---

## Task C2 — Membership and tenant integrity

**Status:** complete

**Reasoning:** Chat v1 (not E2EE) requires: Membership and tenant integrity.

**Depends on:** C1

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C2.
- [x] Implement the minimal production change for C2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C2 pass.
- [x] Negative: unauthorized or illegal config denied for C2.
- [x] E2E or contract: user-visible path covered when UI is in scope for C2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Membership and tenant integrity meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C2/

---

## Task C3 — Safe message and attachment content

**Status:** complete

**Reasoning:** Chat v1 (not E2EE) requires: Safe message and attachment content.

**Depends on:** C2,D1

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C3.
- [x] Implement the minimal production change for C3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C3 pass.
- [x] Negative: unauthorized or illegal config denied for C3.
- [x] E2E or contract: user-visible path covered when UI is in scope for C3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Safe message and attachment content meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C3/

---

## Task C4 — Realtime authorization and multi-instance fan-out

**Status:** complete

**Reasoning:** Chat v1 (not E2EE) requires: Realtime authorization and multi-instance fan-out.

**Depends on:** C2

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C4.
- [x] Implement the minimal production change for C4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C4 pass.
- [x] Negative: unauthorized or illegal config denied for C4.
- [x] E2E or contract: user-visible path covered when UI is in scope for C4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Realtime authorization and multi-instance fan-out meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C4/

---

## Task C5 — Retention, deletion, exports, audit

**Status:** complete

**Reasoning:** Chat v1 (not E2EE) requires: Retention, deletion, exports, audit.

**Depends on:** C2,G1.3

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C5.
- [x] Implement the minimal production change for C5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C5 pass.
- [x] Negative: unauthorized or illegal config denied for C5.
- [x] E2E or contract: user-visible path covered when UI is in scope for C5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Retention, deletion, exports, audit meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C5/

---

## Task C6 — Chat live evidence

**Status:** complete started

**Reasoning:** Chat v1 (not E2EE) requires: Chat live evidence.

**Depends on:** C1,C2,C3,C4,C5

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C6.
- [x] Implement the minimal production change for C6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C6 pass.
- [x] Negative: unauthorized or illegal config denied for C6.
- [x] E2E or contract: user-visible path covered when UI is in scope for C6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Chat live evidence meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C6/

---

## Task C7 — Attachments via Drive + quarantine coupling

**Status:** complete started

**Reasoning:** Chat v1 (not E2EE) requires: Attachments via Drive + quarantine coupling.

**Depends on:** C3,D2

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C7.
- [x] Implement the minimal production change for C7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C7 pass.
- [x] Negative: unauthorized or illegal config denied for C7.
- [x] E2E or contract: user-visible path covered when UI is in scope for C7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Attachments via Drive + quarantine coupling meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C7/

---

## Task C8 — Presence/read-receipts edge completeness

**Status:** complete started

**Reasoning:** Chat v1 (not E2EE) requires: Presence/read-receipts edge completeness.

**Depends on:** C4

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C8.
- [x] Implement the minimal production change for C8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C8 pass.
- [x] Negative: unauthorized or illegal config denied for C8.
- [x] E2E or contract: user-visible path covered when UI is in scope for C8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Presence/read-receipts edge completeness meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C8/

---

## Task C9 — Retention/export admin UX

**Status:** complete started

**Reasoning:** Chat v1 (not E2EE) requires: Retention/export admin UX.

**Depends on:** C5,ADM.10

**Likely files:**

- `apps/helix/src/platform/chat/`
- `apps/web/src/features/chat/`
- `docs/chat-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for C9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for C9.
- [x] Implement the minimal production change for C9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for C9 pass.
- [x] Negative: unauthorized or illegal config denied for C9.
- [x] E2E or contract: user-visible path covered when UI is in scope for C9.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Retention/export admin UX meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/C9/

---

## Phase C validation gate — Chat

**Entry:** all tasks in phase C checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] WS security + membership tests pass.
- [x] C6 live evidence present.
- [x] Not E2EE stated in UI.
- [x] Fan-out proven or limit accepted.
- [x] Chat e2e green.

---

# Phase A — Agents / Assistant / MCP / CLI

**Entry:** G1.5 + domain tools. **Exit:** A.V.

## Task A1 — Server-derived effective classification

**Status:** complete

**Reasoning:** Agent safety requires: Server-derived effective classification.

**Depends on:** G1.5

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A1.
- [x] Implement the minimal production change for A1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A1 pass.
- [x] Negative: unauthorized or illegal config denied for A1.
- [x] E2E or contract: user-visible path covered when UI is in scope for A1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Server-derived effective classification meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A1/

---

## Task A2 — Untrusted-context isolation

**Status:** complete

**Reasoning:** Agent safety requires: Untrusted-context isolation.

**Depends on:** A1

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A2.
- [x] Implement the minimal production change for A2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A2 pass.
- [x] Negative: unauthorized or illegal config denied for A2.
- [x] E2E or contract: user-visible path covered when UI is in scope for A2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Untrusted-context isolation meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A2/

---

## Task A3 — Tool-call policy firewall

**Status:** complete

**Reasoning:** Agent safety requires: Tool-call policy firewall.

**Depends on:** G1.5,A1

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A3.
- [x] Implement the minimal production change for A3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A3 pass.
- [x] Negative: unauthorized or illegal config denied for A3.
- [x] E2E or contract: user-visible path covered when UI is in scope for A3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Tool-call policy firewall meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A3/

---

## Task A4 — Pending action correctness

**Status:** complete

**Reasoning:** Agent safety requires: Pending action correctness.

**Depends on:** A3

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A4.
- [x] Implement the minimal production change for A4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A4 pass.
- [x] Negative: unauthorized or illegal config denied for A4.
- [x] E2E or contract: user-visible path covered when UI is in scope for A4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Pending action correctness meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A4/

---

## Task A5 — MCP and agent credential hardening

**Status:** complete

**Reasoning:** Agent safety requires: MCP and agent credential hardening.

**Depends on:** G1.4,A3

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A5.
- [x] Implement the minimal production change for A5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A5 pass.
- [x] Negative: unauthorized or illegal config denied for A5.
- [x] E2E or contract: user-visible path covered when UI is in scope for A5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] MCP and agent credential hardening meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A5/

---

## Task A6 — Agent observability and kill switches

**Status:** complete

**Reasoning:** Agent safety requires: Agent observability and kill switches.

**Depends on:** A3,A5

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A6.
- [x] Implement the minimal production change for A6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A6 pass.
- [x] Negative: unauthorized or illegal config denied for A6.
- [x] E2E or contract: user-visible path covered when UI is in scope for A6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Agent observability and kill switches meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A6/

---

## Task A7 — Agent live evidence

**Status:** complete started

**Reasoning:** Agent safety requires: Agent live evidence.

**Depends on:** A1,A2,A3,A4,A5,A6

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A7.
- [x] Implement the minimal production change for A7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A7 pass.
- [x] Negative: unauthorized or illegal config denied for A7.
- [x] E2E or contract: user-visible path covered when UI is in scope for A7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Agent live evidence meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A7/

---

## Task A8 — Full surface confirmation matrix

**Status:** complete started

**Reasoning:** Agent safety requires: Full surface confirmation matrix.

**Depends on:** A3,A5

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A8.
- [x] Implement the minimal production change for A8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A8 pass.
- [x] Negative: unauthorized or illegal config denied for A8.
- [x] E2E or contract: user-visible path covered when UI is in scope for A8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Full surface confirmation matrix meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A8/

---

## Task A9 — Prompt-injection corpus continuous

**Status:** complete started

**Reasoning:** Agent safety requires: Prompt-injection corpus continuous.

**Depends on:** A2

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A9.
- [x] Implement the minimal production change for A9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A9 pass.
- [x] Negative: unauthorized or illegal config denied for A9.
- [x] E2E or contract: user-visible path covered when UI is in scope for A9.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Prompt-injection corpus continuous meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A9/

---

## Task A10 — Org-level agent disable + emergency kill

**Status:** complete started

**Reasoning:** Agent safety requires: Org-level agent disable + emergency kill.

**Depends on:** A6,ADM.11

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A10 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A10.
- [x] Implement the minimal production change for A10 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A10 pass.
- [x] Negative: unauthorized or illegal config denied for A10.
- [x] E2E or contract: user-visible path covered when UI is in scope for A10.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Org-level agent disable + emergency kill meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A10/

---

## Task A11 — Admin credentials + cost limits enforced

**Status:** complete started

**Reasoning:** Agent safety requires: Admin credentials + cost limits enforced.

**Depends on:** A5,ADM.10

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A11 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A11.
- [x] Implement the minimal production change for A11 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A11 pass.
- [x] Negative: unauthorized or illegal config denied for A11.
- [x] E2E or contract: user-visible path covered when UI is in scope for A11.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Admin credentials + cost limits enforced meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A11/

---

## Task A12 — Assistant pending-approvals UX

**Status:** complete started

**Reasoning:** Agent safety requires: Assistant pending-approvals UX.

**Depends on:** A4,UX.3

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/api/mcp.ts`
- `apps/web/src/features/assistant/`
- `docs/agent-live-evidence.md`

**Steps:**

- [x] Read current code paths listed for A12 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for A12.
- [x] Implement the minimal production change for A12 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for A12 pass.
- [x] Negative: unauthorized or illegal config denied for A12.
- [x] E2E or contract: user-visible path covered when UI is in scope for A12.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Assistant pending-approvals UX meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/A12/

---

## Phase A validation gate — Agents

**Entry:** all tasks in phase A checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Writes confirm on all surfaces (A8).
- [x] Injection corpus pass.
- [x] Kill switch works.
- [x] A7 live evidence present.
- [x] Approvals UX usable.
- [x] Assistant e2e green.

---

# Phase ADM — Admin enforcement

**Entry:** G1. **Exit:** ADM.V. **Enforce or hide.**

## Task ADM.1 — Inventory every admin control → enforce or remove

**Status:** complete started

**Reasoning:** Admin honesty requires: Inventory every admin control → enforce or remove.

**Depends on:** G0.1

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.1.
- [x] Implement the minimal production change for ADM.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.1 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.1.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Inventory every admin control → enforce or remove meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.1/

---

## Task ADM.2 — MFA policy enforcement or hide

**Status:** complete started

**Reasoning:** Admin honesty requires: MFA policy enforcement or hide.

**Depends on:** ADM.1,ID.1

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.2.
- [x] Implement the minimal production change for ADM.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.2 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.2.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] MFA policy enforcement or hide meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.2/

---

## Task ADM.3 — Session timeout enforcement or hide

**Status:** complete started

**Reasoning:** Admin honesty requires: Session timeout enforcement or hide.

**Depends on:** ADM.1,ID.1

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.3.
- [x] Implement the minimal production change for ADM.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.3 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.3.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Session timeout enforcement or hide meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.3/

---

## Task ADM.4 — SSO enforcement level or hide

**Status:** complete started

**Reasoning:** Admin honesty requires: SSO enforcement level or hide.

**Depends on:** ADM.1,ID.4

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.4.
- [x] Implement the minimal production change for ADM.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.4 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.4.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] SSO enforcement level or hide meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.4/

---

## Task ADM.5 — DLP settings enforcement or hide

**Status:** complete started

**Reasoning:** Admin honesty requires: DLP settings enforcement or hide.

**Depends on:** ADM.1,C3,M5

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.5.
- [x] Implement the minimal production change for ADM.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.5 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.5.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] DLP settings enforcement or hide meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.5/

---

## Task ADM.6 — External sharing domain allowlist single source + enforce

**Status:** complete started

**Reasoning:** Admin honesty requires: External sharing domain allowlist single source + enforce.

**Depends on:** ADM.1,D5

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.6.
- [x] Implement the minimal production change for ADM.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.6 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.6.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] External sharing domain allowlist single source + enforce meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.6/

---

## Task ADM.7 — Domain registry parent + mail capability completeness

**Status:** complete

**Reasoning:** Admin honesty requires: Domain registry parent + mail capability completeness.

**Depends on:** M1,G1.8

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.7.
- [x] Implement the minimal production change for ADM.7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.7 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.7.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.7.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Domain registry parent + mail capability completeness meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.7/

---

## Task ADM.8 — DNS verification monitoring/alerts

**Status:** complete

**Reasoning:** Admin honesty requires: DNS verification monitoring/alerts.

**Depends on:** ADM.7,O5

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.8.
- [x] Implement the minimal production change for ADM.8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.8 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.8.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.8.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] DNS verification monitoring/alerts meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.8/

---

## Task ADM.9 — Users/groups/roles RBAC matrix

**Status:** complete

**Reasoning:** Admin honesty requires: Users/groups/roles RBAC matrix.

**Depends on:** G1.8,ID.2

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.9.
- [x] Implement the minimal production change for ADM.9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.9 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.9.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.9.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Users/groups/roles RBAC matrix meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.9/

---

## Task ADM.10 — Audit completeness for admin mutations

**Status:** complete

**Reasoning:** Admin honesty requires: Audit completeness for admin mutations.

**Depends on:** G1.3

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.10 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.10.
- [x] Implement the minimal production change for ADM.10 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.10 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.10.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.10.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Audit completeness for admin mutations meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.10/

---

## Task ADM.11 — Core-apps enablement UI ↔ packaging gates

**Status:** complete

**Reasoning:** Admin honesty requires: Core-apps enablement UI ↔ packaging gates.

**Depends on:** G0.6,PKG.1

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.11 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.11.
- [x] Implement the minimal production change for ADM.11 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.11 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.11.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.11.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Core-apps enablement UI ↔ packaging gates meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.11/

---

## Task ADM.12 — Self-host license/plan UI vs SaaS-later billing split

**Status:** complete

**Reasoning:** Admin honesty requires: Self-host license/plan UI vs SaaS-later billing split.

**Depends on:** G0.7

**Likely files:**

- `apps/web/src/features/admin/`
- `apps/helix/src/platform/admin/`
- `docs/admin-guide.md`

**Steps:**

- [x] Read current code paths listed for ADM.12 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ADM.12.
- [x] Implement the minimal production change for ADM.12 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ADM.12 pass.
- [x] Negative: unauthorized or illegal config denied for ADM.12.
- [x] E2E or contract: user-visible path covered when UI is in scope for ADM.12.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
```

**Acceptance:**

- [x] Self-host license/plan UI vs SaaS-later billing split meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ADM.12/

---

## Phase ADM validation gate — Admin

**Entry:** all tasks in phase ADM checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] ADM.1 inventory complete.
- [x] No false Active/Required chips.
- [x] Domains/DNS complete.
- [x] RBAC matrix pass.
- [x] Admin e2e green.
- [x] admin-guide.md updated.

---

# Phase CAL — Calendar

**Entry:** G1 + Mail invites. **Exit:** CAL.V. Package only after CAL.10.

## Task CAL.1 — Event data model + migrations

**Status:** complete started

**Reasoning:** Calendar v1 requires: Event data model + migrations.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.1.
- [x] Implement the minimal production change for CAL.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.1 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Event data model + migrations meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.1/

---

## Task CAL.2 — Calendar ACL + tenant isolation

**Status:** complete started

**Reasoning:** Calendar v1 requires: Calendar ACL + tenant isolation.

**Depends on:** CAL.1

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.2.
- [x] Implement the minimal production change for CAL.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.2 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Calendar ACL + tenant isolation meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.2/

---

## Task CAL.3 — Calendar API/tools/contracts

**Status:** complete started

**Reasoning:** Calendar v1 requires: Calendar API/tools/contracts.

**Depends on:** CAL.2

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.3.
- [x] Implement the minimal production change for CAL.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.3 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Calendar API/tools/contracts meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.3/

---

## Task CAL.4 — Calendar web UI (month/week/day)

**Status:** complete started

**Reasoning:** Calendar v1 requires: Calendar web UI (month/week/day).

**Depends on:** CAL.3

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.4.
- [x] Implement the minimal production change for CAL.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.4 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Calendar web UI (month/week/day) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.4/

---

## Task CAL.5 — Invitations via Mail

**Status:** complete started

**Reasoning:** Calendar v1 requires: Invitations via Mail.

**Depends on:** CAL.3,M3

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.5.
- [x] Implement the minimal production change for CAL.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.5 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Invitations via Mail meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.5/

---

## Task CAL.6 — Free/busy API + UI

**Status:** complete started

**Reasoning:** Calendar v1 requires: Free/busy API + UI.

**Depends on:** CAL.3

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.6.
- [x] Implement the minimal production change for CAL.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.6 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Free/busy API + UI meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.6/

---

## Task CAL.7 — Timezone + DST test pack

**Status:** complete started

**Reasoning:** Calendar v1 requires: Timezone + DST test pack.

**Depends on:** CAL.4

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.7.
- [x] Implement the minimal production change for CAL.7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.7 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.7.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Timezone + DST test pack meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.7/

---

## Task CAL.8 — CalDAV: ship hardened or remove claims

**Status:** complete started

**Reasoning:** Calendar v1 requires: CalDAV: ship hardened or remove claims.

**Depends on:** CAL.3

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.8.
- [x] Implement the minimal production change for CAL.8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.8 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.8.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] CalDAV: ship hardened or remove claims meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.8/

---

## Task CAL.9 — Reminders/notifications

**Status:** complete started

**Reasoning:** Calendar v1 requires: Reminders/notifications.

**Depends on:** CAL.3,UX.7

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.9.
- [x] Implement the minimal production change for CAL.9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.9 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.9.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.9.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Reminders/notifications meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.9/

---

## Task CAL.10 — Packaging enablement gate for Calendar

**Status:** complete started

**Reasoning:** Calendar v1 requires: Packaging enablement gate for Calendar.

**Depends on:** CAL.11,PKG.1

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.10 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.10.
- [x] Implement the minimal production change for CAL.10 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.10 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.10.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.10.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Packaging enablement gate for Calendar meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.10/

---

## Task CAL.11 — Calendar e2e + negative security

**Status:** complete started

**Reasoning:** Calendar v1 requires: Calendar e2e + negative security.

**Depends on:** CAL.4,CAL.5,CAL.2

**Likely files:**

- `apps/helix/src/platform/calendar/`
- `apps/web/src/features/calendar/`
- `packages/contracts/`

**Steps:**

- [x] Read current code paths listed for CAL.11 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for CAL.11.
- [x] Implement the minimal production change for CAL.11 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for CAL.11 pass.
- [x] Negative: unauthorized or illegal config denied for CAL.11.
- [x] E2E or contract: user-visible path covered when UI is in scope for CAL.11.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Calendar e2e + negative security meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/CAL.11/

---

## Phase CAL validation gate — Calendar

**Entry:** all tasks in phase CAL checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] CRUD+ACL+invites work.
- [x] CAL.11 e2e+negatives pass.
- [x] Packaging off until CAL.10.
- [x] Timezone tests pass.
- [x] CalDAV hardened or unclaimed.

---

# Phase MT — Meet

**Entry:** G1. **Exit:** MT.V. Package only after MT.9.

## Task MT.1 — Jitsi topology + fail-closed config

**Status:** complete

**Reasoning:** Meet v1 requires: Jitsi topology + fail-closed config.

**Depends on:** G1.1

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.1.
- [x] Implement the minimal production change for MT.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.1 pass.
- [x] Negative: unauthorized or illegal config denied for MT.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Jitsi topology + fail-closed config meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.1/

---

## Task MT.2 — Room create/join/end hardening

**Status:** complete

**Reasoning:** Meet v1 requires: Room create/join/end hardening.

**Depends on:** MT.1

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.2.
- [x] Implement the minimal production change for MT.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.2 pass.
- [x] Negative: unauthorized or illegal config denied for MT.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Room create/join/end hardening meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.2/

---

## Task MT.3 — JWT mint binding/TTL/no leakage

**Status:** complete

**Reasoning:** Meet v1 requires: JWT mint binding/TTL/no leakage.

**Depends on:** MT.2

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.3.
- [x] Implement the minimal production change for MT.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.3 pass.
- [x] Negative: unauthorized or illegal config denied for MT.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] JWT mint binding/TTL/no leakage meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.3/

---

## Task MT.4 — Meet hub + in-call UX completion

**Status:** complete

**Reasoning:** Meet v1 requires: Meet hub + in-call UX completion.

**Depends on:** MT.3

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.4.
- [x] Implement the minimal production change for MT.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.4 pass.
- [x] Negative: unauthorized or illegal config denied for MT.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Meet hub + in-call UX completion meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.4/

---

## Task MT.5 — Room authZ (org/membership)

**Status:** complete

**Reasoning:** Meet v1 requires: Room authZ (org/membership).

**Depends on:** MT.2,G1.8

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.5.
- [x] Implement the minimal production change for MT.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.5 pass.
- [x] Negative: unauthorized or illegal config denied for MT.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.5.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Room authZ (org/membership) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.5/

---

## Task MT.6 — Abuse rate limits / lobby

**Status:** complete

**Reasoning:** Meet v1 requires: Abuse rate limits / lobby.

**Depends on:** MT.5

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.6.
- [x] Implement the minimal production change for MT.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.6 pass.
- [x] Negative: unauthorized or illegal config denied for MT.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.6.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Abuse rate limits / lobby meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.6/

---

## Task MT.7 — Recording: implement securely or remove UI

**Status:** complete

**Reasoning:** Meet v1 requires: Recording: implement securely or remove UI.

**Depends on:** MT.4,D1

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.7.
- [x] Implement the minimal production change for MT.7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.7 pass.
- [x] Negative: unauthorized or illegal config denied for MT.7.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.7.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Recording: implement securely or remove UI meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.7/

---

## Task MT.8 — Mobile web call layout

**Status:** complete

**Reasoning:** Meet v1 requires: Mobile web call layout.

**Depends on:** MT.4,UX.12

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.8.
- [x] Implement the minimal production change for MT.8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.8 pass.
- [x] Negative: unauthorized or illegal config denied for MT.8.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.8.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Mobile web call layout meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.8/

---

## Task MT.9 — Packaging enablement gate for Meet

**Status:** complete

**Reasoning:** Meet v1 requires: Packaging enablement gate for Meet.

**Depends on:** MT.10,PKG.1

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.9.
- [x] Implement the minimal production change for MT.9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.9 pass.
- [x] Negative: unauthorized or illegal config denied for MT.9.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.9.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Packaging enablement gate for Meet meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.9/

---

## Task MT.10 — Meet e2e + load evidence

**Status:** complete

**Reasoning:** Meet v1 requires: Meet e2e + load evidence.

**Depends on:** MT.4,MT.5,MT.6

**Likely files:**

- `apps/helix/src/platform/meet/`
- `apps/web/src/features/meet/`
- `apps/web/tests/e2e/meet-jitsi-embed.spec.ts`

**Steps:**

- [x] Read current code paths listed for MT.10 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for MT.10.
- [x] Implement the minimal production change for MT.10 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for MT.10 pass.
- [x] Negative: unauthorized or illegal config denied for MT.10.
- [x] E2E or contract: user-visible path covered when UI is in scope for MT.10.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Meet e2e + load evidence meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/MT.10/

---

## Phase MT validation gate — Meet

**Entry:** all tasks in phase MT checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Fail-closed without Jitsi.
- [x] JWT safe.
- [x] AuthZ+rate limits pass.
- [x] MT.10 e2e complete.
- [x] Recording implemented or removed.
- [x] Packaging off until MT.9.

---

# Phase ED — Docs / Sheets / Slides / PDF

**Entry:** D + G1.6 + editors pin. **Exit:** ED.V. Package only after ED.11.

## Task ED.0 — Collab decision + ADR (single-active vs realtime)

**Status:** complete started

**Reasoning:** Editors v1 requires: Collab decision + ADR (single-active vs realtime).

**Depends on:** G0.7

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.0 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.0.
- [x] Implement the minimal production change for ED.0 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.0 pass.
- [x] Negative: unauthorized or illegal config denied for ED.0.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.0.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Collab decision + ADR (single-active vs realtime) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.0/

---

## Task ED.1 — helix-editors pin + contract CI

**Status:** complete started

**Reasoning:** Editors v1 requires: helix-editors pin + contract CI.

**Depends on:** ED.0

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.1.
- [x] Implement the minimal production change for ED.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.1 pass.
- [x] Negative: unauthorized or illegal config denied for ED.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.1.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] helix-editors pin + contract CI meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.1/

---

## Task ED.2 — Native docs open/save/version

**Status:** complete started

**Reasoning:** Editors v1 requires: Native docs open/save/version.

**Depends on:** ED.1,D5

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.2.
- [x] Implement the minimal production change for ED.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.2 pass.
- [x] Negative: unauthorized or illegal config denied for ED.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.2.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Native docs open/save/version meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.2/

---

## Task ED.3 — Native sheets open/save/version

**Status:** complete started

**Reasoning:** Editors v1 requires: Native sheets open/save/version.

**Depends on:** ED.1,D5

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.3.
- [x] Implement the minimal production change for ED.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.3 pass.
- [x] Negative: unauthorized or illegal config denied for ED.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.3.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Native sheets open/save/version meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.3/

---

## Task ED.4 — Native slides open/save/version

**Status:** complete started

**Reasoning:** Editors v1 requires: Native slides open/save/version.

**Depends on:** ED.1,D5

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.4.
- [x] Implement the minimal production change for ED.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.4 pass.
- [x] Negative: unauthorized or illegal config denied for ED.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.4.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Native slides open/save/version meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.4/

---

## Task ED.5 — Import/convert matrix (docx/xlsx/pptx)

**Status:** complete started

**Reasoning:** Editors v1 requires: Import/convert matrix (docx/xlsx/pptx).

**Depends on:** ED.2,ED.3,ED.4,D9

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.5.
- [x] Implement the minimal production change for ED.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.5 pass.
- [x] Negative: unauthorized or illegal config denied for ED.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.5.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Import/convert matrix (docx/xlsx/pptx) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.5/

---

## Task ED.6 — PDF preview (edit non-goal unless decided)

**Status:** complete started

**Reasoning:** Editors v1 requires: PDF preview (edit non-goal unless decided).

**Depends on:** D9

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.6.
- [x] Implement the minimal production change for ED.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.6 pass.
- [x] Negative: unauthorized or illegal config denied for ED.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.6.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] PDF preview (edit non-goal unless decided) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.6/

---

## Task ED.7 — Drive ACL open path

**Status:** complete started

**Reasoning:** Editors v1 requires: Drive ACL open path.

**Depends on:** D5,ED.2

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.7.
- [x] Implement the minimal production change for ED.7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.7 pass.
- [x] Negative: unauthorized or illegal config denied for ED.7.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.7.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Drive ACL open path meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.7/

---

## Task ED.8 — Autosave + conflict behavior

**Status:** complete started

**Reasoning:** Editors v1 requires: Autosave + conflict behavior.

**Depends on:** ED.0,ED.2

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.8.
- [x] Implement the minimal production change for ED.8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.8 pass.
- [x] Negative: unauthorized or illegal config denied for ED.8.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.8.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Autosave + conflict behavior meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.8/

---

## Task ED.9 — Unsaved + offline integration

**Status:** complete started

**Reasoning:** Editors v1 requires: Unsaved + offline integration.

**Depends on:** ED.8,UX.1,UX.11

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.9.
- [x] Implement the minimal production change for ED.9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.9 pass.
- [x] Negative: unauthorized or illegal config denied for ED.9.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.9.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Unsaved + offline integration meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.9/

---

## Task ED.10 — Large-document performance budgets

**Status:** complete started

**Reasoning:** Editors v1 requires: Large-document performance budgets.

**Depends on:** ED.2

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.10 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.10.
- [x] Implement the minimal production change for ED.10 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.10 pass.
- [x] Negative: unauthorized or illegal config denied for ED.10.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.10.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Large-document performance budgets meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.10/

---

## Task ED.11 — Packaging enablement gate for editors

**Status:** complete started

**Reasoning:** Editors v1 requires: Packaging enablement gate for editors.

**Depends on:** ED.12,PKG.1

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.11 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.11.
- [x] Implement the minimal production change for ED.11 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.11 pass.
- [x] Negative: unauthorized or illegal config denied for ED.11.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.11.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Packaging enablement gate for editors meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.11/

---

## Task ED.12 — Editors boundary scanner always green

**Status:** complete started

**Reasoning:** Editors v1 requires: Editors boundary scanner always green.

**Depends on:** ED.1

**Likely files:**

- `../helix-editors/packages/`
- `apps/web/src/features/docs/`
- `apps/web/src/features/sheets/`
- `apps/web/src/features/slides/`
- `infra/scripts/verify-workspace-editor-boundaries.mjs`

**Steps:**

- [x] Read current code paths listed for ED.12 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ED.12.
- [x] Implement the minimal production change for ED.12 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ED.12 pass.
- [x] Negative: unauthorized or illegal config denied for ED.12.
- [x] E2E or contract: user-visible path covered when UI is in scope for ED.12.

**Validation commands:**

```sh
pnpm quality:editors-boundaries
pnpm --filter @helix/web typecheck
```

**Acceptance:**

- [x] Editors boundary scanner always green meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ED.12/

---

## Phase ED validation gate — Editors

**Entry:** all tasks in phase ED checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] ED.0 ADR accepted.
- [x] Native open/save works.
- [x] Import matrix honest.
- [x] Boundaries green.
- [x] Packaging off until ED.11.
- [x] ACL denials pass.

---

# Phase SRCH — Search

**Entry:** content domains. **Exit:** SRCH.V.

## Task SRCH.1 — Index coverage matrix

**Status:** complete

**Reasoning:** Search v1 requires: Index coverage matrix.

**Depends on:** M6,D5,C2

**Likely files:**

- `apps/helix/src/platform/search/`
- `apps/web/src/features/search/`

**Steps:**

- [x] Read current code paths listed for SRCH.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for SRCH.1.
- [x] Implement the minimal production change for SRCH.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for SRCH.1 pass.
- [x] Negative: unauthorized or illegal config denied for SRCH.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for SRCH.1.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Index coverage matrix meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/SRCH.1/

---

## Task SRCH.2 — ACL-filtered search proof

**Status:** complete

**Reasoning:** Search v1 requires: ACL-filtered search proof.

**Depends on:** SRCH.1,G1.8

**Likely files:**

- `apps/helix/src/platform/search/`
- `apps/web/src/features/search/`

**Steps:**

- [x] Read current code paths listed for SRCH.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for SRCH.2.
- [x] Implement the minimal production change for SRCH.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for SRCH.2 pass.
- [x] Negative: unauthorized or illegal config denied for SRCH.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for SRCH.2.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] ACL-filtered search proof meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/SRCH.2/

---

## Task SRCH.3 — Search UI completeness

**Status:** complete

**Reasoning:** Search v1 requires: Search UI completeness.

**Depends on:** SRCH.1,UX.14

**Likely files:**

- `apps/helix/src/platform/search/`
- `apps/web/src/features/search/`

**Steps:**

- [x] Read current code paths listed for SRCH.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for SRCH.3.
- [x] Implement the minimal production change for SRCH.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for SRCH.3 pass.
- [x] Negative: unauthorized or illegal config denied for SRCH.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for SRCH.3.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Search UI completeness meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/SRCH.3/

---

## Task SRCH.4 — Search latency SLO tests

**Status:** complete

**Reasoning:** Search v1 requires: Search latency SLO tests.

**Depends on:** SRCH.2,O5

**Likely files:**

- `apps/helix/src/platform/search/`
- `apps/web/src/features/search/`

**Steps:**

- [x] Read current code paths listed for SRCH.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for SRCH.4.
- [x] Implement the minimal production change for SRCH.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for SRCH.4 pass.
- [x] Negative: unauthorized or illegal config denied for SRCH.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for SRCH.4.

**Validation commands:**

```sh
pnpm --filter @helix/app typecheck
pnpm --filter @helix/app exec vitest run <touched-tests>
```

**Acceptance:**

- [x] Search latency SLO tests meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/SRCH.4/

---

## Phase SRCH validation gate — Search

**Entry:** all tasks in phase SRCH checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Coverage matrix published.
- [x] ACL tests pass.
- [x] UI error/empty handled.
- [x] Latency measured.
- [x] Included in V2 matrix.

---

# Phase ID — Identity

**Entry:** G1.2. **Exit:** ID.V.

## Task ID.1 — Session cookie security matrix

**Status:** complete

**Reasoning:** Identity v1 requires: Session cookie security matrix.

**Depends on:** G1.2

**Likely files:**

- `apps/helix/src/platform/auth/`
- `apps/helix/src/platform/signup/`
- `apps/web/src/routes/login.tsx`

**Steps:**

- [x] Read current code paths listed for ID.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ID.1.
- [x] Implement the minimal production change for ID.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ID.1 pass.
- [x] Negative: unauthorized or illegal config denied for ID.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for ID.1.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
pnpm --filter @helix/web exec playwright test tests/e2e/login-auth-handoff.spec.ts
```

**Acceptance:**

- [x] Session cookie security matrix meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ID.1/

---

## Task ID.2 — Local auth hardening

**Status:** complete

**Reasoning:** Identity v1 requires: Local auth hardening.

**Depends on:** ID.1

**Likely files:**

- `apps/helix/src/platform/auth/`
- `apps/helix/src/platform/signup/`
- `apps/web/src/routes/login.tsx`

**Steps:**

- [x] Read current code paths listed for ID.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ID.2.
- [x] Implement the minimal production change for ID.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ID.2 pass.
- [x] Negative: unauthorized or illegal config denied for ID.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for ID.2.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
pnpm --filter @helix/web exec playwright test tests/e2e/login-auth-handoff.spec.ts
```

**Acceptance:**

- [x] Local auth hardening meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ID.2/

---

## Task ID.3 — Invite + email verify flows

**Status:** complete

**Reasoning:** Identity v1 requires: Invite + email verify flows.

**Depends on:** ID.2,M3

**Likely files:**

- `apps/helix/src/platform/auth/`
- `apps/helix/src/platform/signup/`
- `apps/web/src/routes/login.tsx`

**Steps:**

- [x] Read current code paths listed for ID.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ID.3.
- [x] Implement the minimal production change for ID.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ID.3 pass.
- [x] Negative: unauthorized or illegal config denied for ID.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for ID.3.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
pnpm --filter @helix/web exec playwright test tests/e2e/login-auth-handoff.spec.ts
```

**Acceptance:**

- [x] Invite + email verify flows meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ID.3/

---

## Task ID.4 — SSO only with real enforcement

**Status:** complete

**Reasoning:** Identity v1 requires: SSO only with real enforcement.

**Depends on:** ADM.4,ID.1

**Likely files:**

- `apps/helix/src/platform/auth/`
- `apps/helix/src/platform/signup/`
- `apps/web/src/routes/login.tsx`

**Steps:**

- [x] Read current code paths listed for ID.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ID.4.
- [x] Implement the minimal production change for ID.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ID.4 pass.
- [x] Negative: unauthorized or illegal config denied for ID.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for ID.4.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
pnpm --filter @helix/web exec playwright test tests/e2e/login-auth-handoff.spec.ts
```

**Acceptance:**

- [x] SSO only with real enforcement meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ID.4/

---

## Task ID.5 — Default/single-org bootstrap reliability

**Status:** complete

**Reasoning:** Identity v1 requires: Default/single-org bootstrap reliability.

**Depends on:** G1.8

**Likely files:**

- `apps/helix/src/platform/auth/`
- `apps/helix/src/platform/signup/`
- `apps/web/src/routes/login.tsx`

**Steps:**

- [x] Read current code paths listed for ID.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ID.5.
- [x] Implement the minimal production change for ID.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ID.5 pass.
- [x] Negative: unauthorized or illegal config denied for ID.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for ID.5.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
pnpm --filter @helix/web exec playwright test tests/e2e/login-auth-handoff.spec.ts
```

**Acceptance:**

- [x] Default/single-org bootstrap reliability meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ID.5/

---

## Task ID.6 — Multi-org self-host create-org (if in v1)

**Status:** complete

**Reasoning:** Identity v1 requires: Multi-org self-host create-org (if in v1).

**Depends on:** G0.7,ID.5

**Likely files:**

- `apps/helix/src/platform/auth/`
- `apps/helix/src/platform/signup/`
- `apps/web/src/routes/login.tsx`

**Steps:**

- [x] Read current code paths listed for ID.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for ID.6.
- [x] Implement the minimal production change for ID.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for ID.6 pass.
- [x] Negative: unauthorized or illegal config denied for ID.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for ID.6.

**Validation commands:**

```sh
pnpm --filter @helix/web typecheck
pnpm --filter @helix/web exec vitest run --config vitest.config.ts <touched-tests>
pnpm --filter @helix/web exec playwright test tests/e2e/login-auth-handoff.spec.ts
```

**Acceptance:**

- [x] Multi-org self-host create-org (if in v1) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/ID.6/

---

## Phase ID validation gate — Identity

**Entry:** all tasks in phase ID checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Session security matrix pass.
- [x] Login e2e pass.
- [x] SSO/MFA claims match enforcement.
- [x] Bootstrap reliable.
- [x] Invite/verify pass.

---

# Phase O — Ops

**Entry:** from G1; hard before V. **Exit:** O.V.

## Task O1 — Production image hardening

**Status:** complete

**Reasoning:** Ops v1 requires: Production image hardening.

**Depends on:** G1.1

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O1.
- [x] Implement the minimal production change for O1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O1 pass.
- [x] Negative: unauthorized or illegal config denied for O1.
- [x] E2E or contract: user-visible path covered when UI is in scope for O1.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Production image hardening meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O1/

---

## Task O2 — Data-plane hardening

**Status:** complete

**Reasoning:** Ops v1 requires: Data-plane hardening.

**Depends on:** O1

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O2.
- [x] Implement the minimal production change for O2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O2 pass.
- [x] Negative: unauthorized or illegal config denied for O2.
- [x] E2E or contract: user-visible path covered when UI is in scope for O2.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Data-plane hardening meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O2/

---

## Task O3 — Migration safety

**Status:** complete

**Reasoning:** Ops v1 requires: Migration safety.

**Depends on:** G1.1

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O3.
- [x] Implement the minimal production change for O3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O3 pass.
- [x] Negative: unauthorized or illegal config denied for O3.
- [x] E2E or contract: user-visible path covered when UI is in scope for O3.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Migration safety meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O3/

---

## Task O4 — Backup/restore RPO/RTO

**Status:** complete

**Reasoning:** Ops v1 requires: Backup/restore RPO/RTO.

**Depends on:** O2,O3

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O4.
- [x] Implement the minimal production change for O4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O4 pass.
- [x] Negative: unauthorized or illegal config denied for O4.
- [x] E2E or contract: user-visible path covered when UI is in scope for O4.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Backup/restore RPO/RTO meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O4/

---

## Task O5 — Observability + SLOs

**Status:** complete

**Reasoning:** Ops v1 requires: Observability + SLOs.

**Depends on:** G1.3

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O5.
- [x] Implement the minimal production change for O5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O5 pass.
- [x] Negative: unauthorized or illegal config denied for O5.
- [x] E2E or contract: user-visible path covered when UI is in scope for O5.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Observability + SLOs meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O5/

---

## Task O6 — Runbooks + operator controls

**Status:** complete

**Reasoning:** Ops v1 requires: Runbooks + operator controls.

**Depends on:** O4,O5

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O6.
- [x] Implement the minimal production change for O6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O6 pass.
- [x] Negative: unauthorized or illegal config denied for O6.
- [x] E2E or contract: user-visible path covered when UI is in scope for O6.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Runbooks + operator controls meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O6/

---

## Task O7 — Deploy overlays for Jitsi/editors/ClamAV (umbrella → O-D/O-K)

**Status:** complete

**Reasoning:** Superseded in detail by O-D.7–O-D.10 and O-K.9–O-K.10. Keep this ID as an umbrella tracker so older references resolve; execute the detailed tasks, then mark O7 done when those are done.

**Depends on:** O-D.7,O-D.9,O-D.10,O-K.9,O-K.10

**Likely files:**

- `docker-compose.production.yml`
- `infra/helm/helix/`
- `docs/deployment-production.md`

**Steps:**

- [x] Do not implement new overlay logic only under O7—use O-D.* / O-K.* tasks.
- [x] Verify O-D.7 ClamAV compose profile complete.
- [x] Verify O-D.9 Jitsi compose topology complete.
- [x] Verify O-D.10 editors build context complete.
- [x] Verify O-K.9 and O-K.10 complete for Helm path.
- [x] Update any lingering docs that only mention O7 to cite O-D/O-K IDs.
- [x] Mark this umbrella task complete only when the five detailed tasks are complete.
- [x] Link evidence folders from those tasks here in the PR.

**Tests:**

- [x] O-D.7, O-D.9, O-D.10, O-K.9, O-K.10 each have evidence or waiver.
- [x] No duplicate conflicting overlay instructions.
- [x] deployment-production.md references detailed task IDs.

**Validation commands:**

```sh
pnpm format:check
```

**Acceptance:**

- [x] Umbrella closed without orphaning detailed work.
- [x] Compose and Helm both covered.
- [x] No silent no-op scanner path remains in prod docs.

**Evidence:** see O-D.7/O-D.9/O-D.10/O-K.9/O-K.10 evidence

---

## Task O8

## Task O8 — Backup scope includes object storage

**Status:** complete

**Reasoning:** Ops v1 requires: Backup scope includes object storage.

**Depends on:** O4,D3

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O8.
- [x] Implement the minimal production change for O8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O8 pass.
- [x] Negative: unauthorized or illegal config denied for O8.
- [x] E2E or contract: user-visible path covered when UI is in scope for O8.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Backup scope includes object storage meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O8/

---

## Task O9 — Alert → runbook linkage tests

**Status:** complete

**Reasoning:** Ops v1 requires: Alert → runbook linkage tests.

**Depends on:** O5,O6

**Likely files:**

- `infra/`
- `docs/deployment-production.md`
- `docs/backup-restore.md`
- `docs/RUNBOOK.md`

**Steps:**

- [x] Read current code paths listed for O9 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for O9.
- [x] Implement the minimal production change for O9 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for O9 pass.
- [x] Negative: unauthorized or illegal config denied for O9.
- [x] E2E or contract: user-visible path covered when UI is in scope for O9.

**Validation commands:**

```sh
# see docs/deployment-production.md and docs/backup-restore.md
pnpm format:check
```

**Acceptance:**

- [x] Alert → runbook linkage tests meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/O9/

---

## Phase O validation gate — Ops

**Entry:** all tasks in phase O checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Images/data-plane hardened (O1–O2).
- [x] Restore drill meets RPO/RTO (O4) and object storage included (O8).
- [x] SLOs+alerts+runbooks linked (O5–O6, O9).
- [x] Migration safety documented (O3).
- [x] **Docker Compose track:** O-D.V green (or waived).
- [x] **Kubernetes/Helm track:** O-K.V green (or waived).
- [x] **Cross-deploy:** O-X.1 parity matrix + O-X.5 gate green.
- [x] O7 umbrella closed via O-D/O-K detailed tasks.

---

# Phase O-DOCKER — Docker Compose production (Full Workspace v1)

**Entry:** G0.V + G1.1 at minimum; complete alongside product phases. **Exit:** O-D.V.

**Goal:** Production-grade **Docker Compose** self-host path for Full Workspace v1—not dev compose alone. Covers digest-pinned images, private data-plane, secrets, migrate ordering, Caddy edge, ClamAV, object storage, optional Jitsi, editors build context, observability, upgrade/rollback, backup/restore, and R3 evidence.

**Primary paths:** `docker-compose.yml`, `docker-compose.production.yml`, `infra/docker/`, `infra/caddy/`, `docs/deployment-production.md`.

## Task O-D.1 — Inventory compose services vs Full Workspace v1 deps

**Status:** complete started

**Reasoning:** Operators need a service×app dependency matrix before GA so Meet/ClamAV/Editors are not accidental.

**Depends on:** G0.1,G1.1

**Likely files:**

- `docker-compose.yml`
- `docker-compose.production.yml`
- `docs/deployment-production.md`
- `docs/tier-1-compose-checklist.md`

**Steps:**

- [x] List every service in docker-compose.yml and production overlay.
- [x] Map each service to Full Workspace apps that require it (mail→smtp/provider, drive→s3+clamav, meet→jitsi, etc.).
- [x] Mark profile: always-on prod / optional profile / dev-only (e.g. Mailpit).
- [x] Document published ports for dev vs production overlay.
- [x] Note image variables (HELIX_IMAGE, HELIX_WEB_IMAGE, …) and which must be digests in prod.
- [x] Write matrix table into this plan evidence path or docs/architecture/v1-compose-service-matrix.md.
- [x] Flag gaps (missing Jitsi service, missing ClamAV in prod overlay, etc.) as follow-up O-D tasks.
- [x] PR review: no data-plane service marked public without security sign-off.

**Tests:**

- [x] Matrix includes postgres, redis/nats, meili, rustfs/s3, caddy, helix, helix-migrate, clamav, jitsi-or-external.
- [x] Dev-only services explicitly excluded from production publish list.
- [x] Document path committed and linked from O-D.16 evidence checklist.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.1/
```

**Acceptance:**

- [x] Inventory compose services vs Full Workspace v1 deps complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.1/

---

## Task O-D.2 — Production compose public surface audit

**Status:** complete started

**Reasoning:** Production must publish only edge HTTP/S and chosen SMTP; data-plane stays private.

**Depends on:** O-D.1

**Likely files:**

- `docker-compose.production.yml`
- `infra/caddy/`
- `docs/deployment-production.md`

**Steps:**

- [x] Run `docker compose -f docker-compose.yml -f docker-compose.production.yml config` and capture resolved ports.
- [x] Assert only expected host ports (80/443 and inbound SMTP) are published.
- [x] Verify Postgres/Redis/NATS/Meili/RustFS/Cerbos/ClamAV/admin ports are not published on host.
- [x] Confirm Caddyfile does not proxy RustFS console or Cerbos API publicly.
- [x] Add CI or script test that fails if production compose publishes forbidden ports.
- [x] Document VPN/SSH tunnel operator access path for private services.
- [x] Update deployment-production.md public surface section if drift found.
- [x] Record audit result in evidence pack.

**Tests:**

- [x] Automated port-publish check exists or documented manual gate with checklist.
- [x] Negative case: intentionally bad publish would fail the check.
- [x] docs/deployment-production.md matches resolved config.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.2/
```

**Acceptance:**

- [x] Production compose public surface audit complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.2/

---

## Task O-D.3 — Immutable digest-only image contract

**Status:** complete started

**Reasoning:** Production must not rebuild from source on the host or float mutable tags.

**Depends on:** O1,O-D.1

**Likely files:**

- `docker-compose.production.yml`
- `infra/docker/Dockerfile`
- `docs/deployment-production.md`
- `.github/workflows/`

**Steps:**

- [x] List all image env vars required by production overlay.
- [x] Require digest-qualified references (${IMAGE:?...} with digest policy documented).
- [x] Confirm production overlay resets local `build:` sections (pull-only).
- [x] Document buildx commands for runtime + web-runtime with helix_editors context.
- [x] Add CI job or script that rejects non-digest tags for prod promote.
- [x] Include dependency images (postgres, nats, meili, cerbos, spamd, clamav, jitsi) in the contract table.
- [x] Document pull_policy: always and registry auth expectations.
- [x] Wire O-X.2 SBOM/scan before promote.

**Tests:**

- [x] compose config fails or policy check fails without required image vars.
- [x] Build instructions reproducible from clean machine with editors sibling.
- [x] No prod service uses `build:` from local tree.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.3/
```

**Acceptance:**

- [x] Immutable digest-only image contract complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.3/

---

## Task O-D.4 — Secrets layout generation, permissions, rotation

**Status:** complete started

**Reasoning:** Secrets must be file-mounted, least-privilege, rotatable without baking into images.

**Depends on:** O-D.3

**Likely files:**

- `docker-compose.production.yml`
- `docs/deployment-production.md`
- `create: docs/runbooks/compose-secrets-rotation.md`

**Steps:**

- [x] Inventory all secrets: entries under production compose `secrets:`.
- [x] Document HELIX_PRODUCTION_SECRETS_DIR layout and required filenames.
- [x] Document generation commands (openssl/age) and file modes (e.g. 0400, owner root/helix).
- [x] Write rotation runbook for DB URL, session secrets, provider keys, Jitsi JWT secret.
- [x] Verify compose fails closed when a required secret file is missing.
- [x] Ensure secrets are not in git; .gitignore covers secrets dir.
- [x] Add negative test or script: empty secrets dir → migrate/app refuse start.
- [x] Link runbook from RUNBOOK.md index.

**Tests:**

- [x] Missing secret fails boot (documented command output).
- [x] Rotation runbook has step-by-step without downtime notes where possible.
- [x] No secret values in docs examples (placeholders only).

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.4/
```

**Acceptance:**

- [x] Secrets layout generation, permissions, rotation complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.4/

---

## Task O-D.5 — helix-migrate one-shot ordering + advisory lock

**Status:** complete started

**Reasoning:** New code must never serve against old schema; migrate must complete before app.

**Depends on:** O3,O-D.3

**Likely files:**

- `docker-compose.production.yml`
- `apps/helix/src/db/migrate.ts`
- `docs/deployment-production.md`

**Steps:**

- [x] Confirm helix-migrate service uses migrate entrypoint and production image.
- [x] Confirm app depends_on migrate with service_completed_successfully.
- [x] Prove advisory lock allows concurrent migrate attempts safely (test or doc+manual).
- [x] Document failure behavior: migrate fail → app does not start.
- [x] Add CI compose-config assertion for depends_on condition.
- [x] Align wording with Helm migrate job (O-K.4) for parity matrix O-X.1.
- [x] Run migrate against empty and already-migrated DB in drill.
- [x] Record timing for ops capacity planning.

**Tests:**

- [x] depends_on condition present in resolved compose.
- [x] Double migrate is safe (lock).
- [x] Failed migrate blocks app in drill.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.5/
```

**Acceptance:**

- [x] helix-migrate one-shot ordering + advisory lock complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.5/

---

## Task O-D.6 — Caddy production routing matrix

**Status:** complete started

**Reasoning:** Edge must expose only intended app paths; WebSocket/MCP/WebDAV need explicit routes.

**Depends on:** O-D.2

**Likely files:**

- `infra/caddy/`
- `docker-compose.production.yml`
- `docs/deployment-production.md`

**Steps:**

- [x] Enumerate SPA, API, OAuth, MCP, realtime WS, WebDAV, discovery paths.
- [x] Verify production Caddyfile proxies each; deny everything else.
- [x] Confirm security headers (HSTS, etc.) present.
- [x] Test WS upgrade path for chat.
- [x] Ensure no proxy to RustFS console or Cerbos.
- [x] Document TLS certificate supply (files/ACME) for self-host.
- [x] Add regression checklist for route additions.
- [x] Capture `curl -I` / WS smoke in evidence.

**Tests:**

- [x] Route matrix table in docs.
- [x] WS chat connects through Caddy in smoke.
- [x] Forbidden backends not reachable publicly.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.6/
```

**Acceptance:**

- [x] Caddy production routing matrix complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.6/

---

## Task O-D.7 — ClamAV (+ SpamAssassin) production profiles fail-closed

**Status:** complete started

**Reasoning:** Business Drive/Mail must not run with no-op scanner when ClamAV required.

**Depends on:** G1.6,O-D.1

**Likely files:**

- `docker-compose.yml`
- `docker-compose.production.yml`
- `apps/helix/src/platform/drive/scanning.ts`
- `infra/`

**Steps:**

- [x] Document clamav service definition and network attachment to app.
- [x] Ensure production profile enables real scanner endpoint env vars.
- [x] Verify production assertions refuse no-op when Business + Drive enabled.
- [x] Optional SpamAssassin profile documented for mail inbound.
- [x] Healthcheck for clamav; app depends_on healthy when required.
- [x] EICAR drill command in runbook.
- [x] Resource limits guidance for clamav container.
- [x] Link to D2/M5 tasks for app-side integration.

**Tests:**

- [x] Business boot fails without scanner (test or drill).
- [x] EICAR file quarantined in drill.
- [x] Compose healthcheck present.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.7/
```

**Acceptance:**

- [x] ClamAV (+ SpamAssassin) production profiles fail-closed complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.7/

---

## Task O-D.8 — Object storage TLS, buckets, lifecycle, backup hooks

**Status:** complete started

**Reasoning:** Drive bytes need durable private object storage with backup hooks.

**Depends on:** O-D.2,D3

**Likely files:**

- `docker-compose.yml`
- `docker-compose.production.yml`
- `docs/drive-storage-security.md`
- `docs/backup-restore.md`

**Steps:**

- [x] Document RustFS/S3 service config for production (TLS, credentials via secrets).
- [x] Bucket naming and init procedure.
- [x] Ensure not published on host network in prod overlay.
- [x] SSE/encryption-at-rest settings documented and attest-able.
- [x] Backup hook: object storage included in O-D.13 drill.
- [x] Lifecycle/retention notes for trash/versions if applicable.
- [x] Negative: app cannot reach storage without secret.
- [x] Update drive-storage-security.md with compose specifics.

**Tests:**

- [x] Storage not on public ports.
- [x] Backup doc lists object storage steps.
- [x] TLS or encrypted volume attestation recorded.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.8/
```

**Acceptance:**

- [x] Object storage TLS, buckets, lifecycle, backup hooks complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.8/

---

## Task O-D.9 — Meet/Jitsi compose topology + fail-closed

**Status:** complete started

**Reasoning:** Meet packaging must not ship a fake embed; Jitsi is either in-stack or external with config.

**Depends on:** MT.1,O-D.2

**Likely files:**

- `infra/meet/`
- `docker-compose.yml`
- `apps/helix/src/platform/meet/`
- `docs/deployment-production.md`

**Steps:**

- [x] Choose in-compose Jitsi vs external URL; document both, implement at least one GA path.
- [x] Network-isolate Jitsi services; only necessary ports via edge if any.
- [x] Wire HELIX_JITSI_* / JWT secrets via secrets files.
- [x] Fail closed: Meet enabled in packaging without Jitsi config → boot refuse (PKG.3).
- [x] Update MT.* task depends to require O-D.9 for compose installs.
- [x] Smoke: create room + mint token against compose stack.
- [x] Document resource requirements for Jitsi.
- [x] Do not enable Meet in launcher until MT.9 + this task evidence.

**Tests:**

- [x] Missing Jitsi config fails Business/v1 Meet-enabled boot.
- [x] Token mint smoke passes on chosen topology.
- [x] No public exposure of Jitsi admin interfaces.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.9/
```

**Acceptance:**

- [x] Meet/Jitsi compose topology + fail-closed complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.9/

---

## Task O-D.10 — Editors build context + migrations policy

**Status:** complete started

**Reasoning:** Web image build needs helix-editors context; runtime must not enable editor migrations accidentally.

**Depends on:** ED.1,O-D.3

**Likely files:**

- `infra/docker/Dockerfile`
- `docker-compose.production.yml`
- `docs/deployment-production.md`

**Steps:**

- [x] Document buildx --build-context helix_editors=../helix-editors for web and API images.
- [x] Confirm HELIX_EDITORS_MIGRATIONS_ENABLED=false default in prod compose.
- [x] When ED packaging enabled, document when migrations may be true and who runs them.
- [x] Ensure image build CI uses pinned editors SHA.
- [x] Boundary: no editors source copied into workspace image layers beyond package build output.
- [x] Record image digests including editors input SHA in evidence.
- [x] Cross-link ED.1/ED.11.
- [x] Verify web image serves SPA without requiring editors at runtime beyond bundled packages.

**Tests:**

- [x] Reproducible build instructions work from clean checkout pair.
- [x] Prod default editors migrations false.
- [x] Evidence includes editors SHA.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.10/
```

**Acceptance:**

- [x] Editors build context + migrations policy complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.10/

---

## Task O-D.11 — Observability stack on compose (profile vs required)

**Status:** complete started

**Reasoning:** Self-host GA needs a stated observability minimum for compose installs.

**Depends on:** O5,O-D.1

**Likely files:**

- `infra/observability/`
- `docker-compose.yml`
- `docs/observability.md`

**Steps:**

- [x] Inventory metrics/logs/traces services in compose profiles.
- [x] Decide GA minimum: required profile vs external OTel collector only.
- [x] Document enable commands and retention defaults.
- [x] Ensure production does not publish Grafana/Prometheus unauthenticated.
- [x] Wire app OTLP/metrics endpoints to the stack.
- [x] Sample dashboard/alert list for pilot SLOs.
- [x] Link O9 runbooks.
- [x] Evidence: scrape succeeds in smoke.

**Tests:**

- [x] Decision recorded (required vs external).
- [x] No unauthenticated public metrics UI.
- [x] Smoke scrape or OTLP export verified.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.11/
```

**Acceptance:**

- [x] Observability stack on compose (profile vs required) complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.11/

---

## Task O-D.12 — Compose upgrade/rollback procedure

**Status:** complete started

**Reasoning:** Operators need a boring upgrade path: pin digests, migrate, health, rollback.

**Depends on:** O-D.3,O-D.5

**Likely files:**

- `docs/deployment-production.md`
- `create: docs/runbooks/compose-upgrade-rollback.md`
- `docker-compose.production.yml`

**Steps:**

- [x] Write step-by-step upgrade: set digests → pull → migrate → rolling app recreate → health checks.
- [x] Write rollback: previous digests → migrate down policy (forward-only vs down) documented honestly.
- [x] Include backup-before-upgrade step (O-D.13).
- [x] Define health endpoints and timeout thresholds.
- [x] Practice once on staging compose; capture log.
- [x] Document failure mid-migrate recovery.
- [x] Link from RUNBOOK.md.
- [x] Add checklist to R0/R3 evidence.

**Tests:**

- [x] Runbook exists with commands copy-pasteable.
- [x] Staging drill log stored (redacted).
- [x] Rollback limitations (no down migrations) stated if true.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.12/
```

**Acceptance:**

- [x] Compose upgrade/rollback procedure complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.12/

---

## Task O-D.13 — Compose backup/restore drill RPO/RTO

**Status:** complete started

**Reasoning:** Compose GA requires demonstrated restore within pilot RPO/RTO.

**Depends on:** O4,O8,O-D.8

**Likely files:**

- `docs/backup-restore.md`
- `create: docs/runbooks/compose-backup-restore-drill.md`
- `infra/scripts/`

**Steps:**

- [x] List backup targets: Postgres, object storage, secrets/config, optionally NATS/meili.
- [x] Document backup commands/schedule for compose installs.
- [x] Run restore into clean environment; time RPO/RTO.
- [x] Verify mail/drive/chat smoke after restore.
- [x] Record results under artifacts/.../deploy/compose/restore-drill.md.
- [x] Fail task if RPO>24h or RTO>4h without owner waiver.
- [x] Align with Helm O-K.16 for parity notes.
- [x] Update backup-restore.md with compose-specific section.

**Tests:**

- [x] Drill report includes timestamps and SHAs.
- [x] Post-restore smoke passes.
- [x] RPO/RTO measured.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.13/
```

**Acceptance:**

- [x] Compose backup/restore drill RPO/RTO complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.13/

---

## Task O-D.14 — Compose smoke + negative tests

**Status:** complete started

**Reasoning:** Automate what can be automated: config validation and negative boots.

**Depends on:** O-D.2,O-D.4,O-D.5

**Likely files:**

- `infra/scripts/`
- `docker-compose.production.yml`
- `create: infra/scripts/compose-production-check.sh`

**Steps:**

- [x] Script: `compose config` succeeds for prod overlay with dummy digests/secrets in CI fixtures.
- [x] Script: forbidden ports detection.
- [x] Script or doc: missing secret → non-zero.
- [x] Optional: github workflow job for compose config check.
- [x] Document manual smoke after full up: login, mail, drive, chat.
- [x] Keep fixtures free of real secrets.
- [x] Wire script into quality gates if appropriate.
- [x] Store sample CI log in evidence.

**Tests:**

- [x] compose-production-check exits 0 on golden fixtures.
- [x] Forbidden port injection fails check.
- [x] Documented manual smoke list.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.14/
```

**Acceptance:**

- [x] Compose smoke + negative tests complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.14/

---

## Task O-D.15 — Update deployment-production.md for Full Workspace v1

**Status:** complete started

**Reasoning:** Guide still speaks MVP-only packaging; v1 needs dual-mode truth without lying.

**Depends on:** O-D.1,G0.6,PKG.1

**Likely files:**

- `docs/deployment-production.md`

**Steps:**

- [x] Rewrite packaging section: MVP profile vs Full Workspace v1 profile.
- [x] Document which compose profiles/env enable Meet/Calendar/Editors/ClamAV.
- [x] Keep fail-closed warnings for Business.
- [x] Link O-D and O-K sections (compose vs helm).
- [x] Remove language that permanent-disables Docs/Meet if v1 targets them—replace with gated enablement.
- [x] Review TLS, secrets, migrate sections for accuracy.
- [x] Add troubleshooting pointers.
- [x] Owner review of claim language.

**Tests:**

- [x] Doc distinguishes MVP vs v1 packaging.
- [x] No residual claim that Meet/Editors never ship.
- [x] Links to runbooks present.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.15/
```

**Acceptance:**

- [x] Update deployment-production.md for Full Workspace v1 complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.15/

---

## Task O-D.16 — Compose evidence pack for final-release / R3

**Status:** complete started

**Reasoning:** R3 needs machine-readable/deploy evidence for compose GA path.

**Depends on:** O-D.12,O-D.13,O-D.14,V6

**Likely files:**

- `docs/final-release-readiness.md`
- `artifacts/`

**Steps:**

- [x] Create artifacts/.../deploy/compose/ directory layout.
- [x] Include: service matrix, port audit, image digests+SHAs, migrate log, smoke, restore drill, upgrade drill.
- [x] Bind HELIX_RELEASE_* SHAs/digests per final-release-readiness.
- [x] Checklist that O-D.1–O-D.15 are green or waived.
- [x] Reference pack from R3 decision packet.
- [x] Redact secrets.
- [x] Cross-link O-X.6 support matrix.
- [x] Archive immutably with release.

**Tests:**

- [x] Evidence index file lists all required artifacts present.
- [x] No secrets in archive.
- [x] R3 checklist cites this pack.

**Validation commands:**

```sh
docker compose -f docker-compose.yml -f docker-compose.production.yml config >/tmp/helix-compose.out 2>&1 || true
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.16/
```

**Acceptance:**

- [x] Compose evidence pack for final-release / R3 complete with operator-usable docs/scripts.
- [x] Production public surface remains fail-closed.
- [x] Evidence path populated or explicitly N/A for pure-design tasks.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/compose/O-D.16/

---

## Phase O-D validation gate — Docker Compose production

**Entry:** all tasks in phase O-D checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] O-D.1–O-D.16 complete or owner-waived with expiry.
- [x] Public port audit green (O-D.2).
- [x] Digest-only image contract enforced (O-D.3).
- [x] Migrate ordering proven (O-D.5).
- [x] ClamAV/Jitsi/editors deps documented fail-closed (O-D.7–O-D.10).
- [x] Upgrade + restore drills recorded (O-D.12–O-D.13).
- [x] deployment-production.md reflects Full Workspace dual packaging (O-D.15).
- [x] Compose evidence pack ready (O-D.16).

---

# Phase O-K8S — Kubernetes / Helm production (Full Workspace v1)

**Entry:** G0.V + G1.1; chart baseline exists under `infra/helm/helix/`. **Exit:** O-K.V.

**Goal:** Production-grade **Helm** install for Business (and documented higher tiers)—values for v1 modules, hardened pods, migrate Jobs, NetworkPolicy, Ingress, CNPG/backups, ClamAV, Meet, secrets, HPA/PDB, CI kubeconform, install/upgrade/rollback and DR drills, R3 evidence.

**Primary paths:** `infra/helm/helix/**`, `docs/deployment-production.md`, `infra/helm/helix/README.md`.

## Task O-K.1 — Helm chart inventory vs Full Workspace v1

**Status:** complete started

**Reasoning:** Know what the chart already does before expanding for Meet/ClamAV/Editors.

**Depends on:** G0.1,O-D.1

**Likely files:**

- `infra/helm/helix/Chart.yaml`
- `infra/helm/helix/values.yaml`
- `infra/helm/helix/values-business.yaml`
- `infra/helm/helix/templates/`
- `infra/helm/helix/README.md`

**Steps:**

- [x] List all templates and values keys.
- [x] Map templates to v1 needs (migrate, networkpolicy, cnpg, ingress, hpa, pdb, vault).
- [x] Diff values-business/enterprise/sovereign for tier differences.
- [x] Identify gaps for ClamAV, Jitsi, editors flags, calendar.
- [x] Write inventory section in chart README or v1-deploy evidence.
- [x] Note kube version / helm version constraints.
- [x] Link O-X.1 parity with compose.
- [x] Owner: confirm business tier is default GA profile.

**Tests:**

- [x] Inventory lists every template file.
- [x] Gap list feeds O-K.2+.
- [x] Tier values differences summarized.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.1/
```

**Acceptance:**

- [x] Helm chart inventory vs Full Workspace v1 complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.1/

---

## Task O-K.2 — values schema for Full Workspace modules

**Status:** complete started

**Reasoning:** Feature flags in values must control Meet/Calendar/Editors/ClamAV safely.

**Depends on:** O-K.1,G0.6

**Likely files:**

- `infra/helm/helix/values.yaml`
- `infra/helm/helix/values-business.yaml`
- `infra/helm/helix/templates/configmap.yaml`
- `infra/helm/helix/templates/deployment.yaml`

**Steps:**

- [x] Add/document values keys for apps enablement aligned with HELIX_APPS / server env.
- [x] Add values for jitsi domain/secret refs, clamav endpoint, editors migrations flag.
- [x] Default Full Workspace extras to false until PKG evidence.
- [x] Document required vs optional dependencies per app.
- [x] jsonschema or values.schema.json if project standard allows.
- [x] Example values snippet for v1 GA profile.
- [x] Ensure production assertions still fail closed server-side.
- [x] Unit: helm template with flags renders expected env.

**Tests:**

- [x] helm template renders module flags into config/env.
- [x] Defaults do not enable Meet/Editors without explicit values.
- [x] Docs describe each key.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.2/
```

**Acceptance:**

- [x] values schema for Full Workspace modules complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.2/

---

## Task O-K.3 — Image digests, pullSecrets, non-root, readOnlyRootFilesystem

**Status:** complete started

**Reasoning:** K8s workloads must match hardened image contract.

**Depends on:** O1,O-K.1

**Likely files:**

- `infra/helm/helix/templates/deployment.yaml`
- `infra/helm/helix/values.yaml`
- `infra/docker/Dockerfile`

**Steps:**

- [x] Require image digests in production values examples.
- [x] Document imagePullSecrets.
- [x] Verify securityContext runAsNonRoot, readOnlyRootFilesystem, drop caps where possible.
- [x] tmpfs/emptyDir for writable paths.
- [x] Align with Dockerfile non-root user.
- [x] Add conftest/kyverno-style check or documentation gate in CI (O-K.14).
- [x] STIG Dockerfile path noted as enterprise optional (O-X / tier).
- [x] Evidence: rendered deployment YAML snippet.

**Tests:**

- [x] Rendered deployment has non-root securityContext.
- [x] Prod examples use digests.
- [x] Writable paths explicitly mounted.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.3/
```

**Acceptance:**

- [x] Image digests, pullSecrets, non-root, readOnlyRootFilesystem complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.3/

---

## Task O-K.4 — Migrate Job pre-install/pre-upgrade hooks

**Status:** complete started

**Reasoning:** Helm must not roll new pods onto old schema.

**Depends on:** O3,O-K.3

**Likely files:**

- `infra/helm/helix/templates/migrate-job.yaml`
- `docs/deployment-production.md`

**Steps:**

- [x] Confirm hook weights/annotations pre-install,pre-upgrade.
- [x] Confirm hook delete policies appropriate.
- [x] Document migrations.enabled=false escape hatch and danger.
- [x] Test: failed migrate aborts release (kind drill O-K.15).
- [x] Advisory lock behavior documented under concurrency.
- [x] Parity note with compose helix-migrate (O-D.5).
- [x] Values for migrate resources/backoff.
- [x] CI kubeconform includes migrate job.

**Tests:**

- [x] Hook annotations present in template.
- [x] Failure path documented and drilled.
- [x] enabled=false warning in README.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.4/
```

**Acceptance:**

- [x] Migrate Job pre-install/pre-upgrade hooks complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.4/

---

## Task O-K.5 — NetworkPolicy matrix

**Status:** complete started

**Reasoning:** Default-deny data-plane is required for Business self-host.

**Depends on:** O-K.1,G1.2

**Likely files:**

- `infra/helm/helix/templates/networkpolicy.yaml`
- `infra/helm/helix/values-business.yaml`

**Steps:**

- [x] Document current NetworkPolicy behavior.
- [x] Define allow: ingress→edge, edge→api, api→postgres/redis/nats/s3/clamav/jitsi as needed.
- [x] Deny lateral movement from untrusted namespaces if applicable.
- [x] Test with templates and/or dry-run descriptions.
- [x] Ensure metrics scrape path allowed if observability required.
- [x] Values to toggle policies for broken CNI environments with warnings.
- [x] Evidence: policy YAML + diagram table.
- [x] Align with compose private networks story.

**Tests:**

- [x] Policy matrix table complete.
- [x] Business values enable strict policies by default.
- [x] Escape hatch documented as reduced security.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.5/
```

**Acceptance:**

- [x] NetworkPolicy matrix complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.5/

---

## Task O-K.6 — Ingress/TLS + trusted origins bridge

**Status:** complete started

**Reasoning:** Ingress paths must match Caddy production route matrix; origins must match app config.

**Depends on:** O-K.5,G1.2

**Likely files:**

- `infra/helm/helix/templates/ingress.yaml`
- `docs/deployment-production.md`

**Steps:**

- [x] Document Ingress class, TLS secrets, cert-manager annotations optional.
- [x] Path list parity with O-D.6 (API, OAuth, MCP, WS, WebDAV, SPA).
- [x] WebSocket annotations for WS routes.
- [x] Bridge HELIX trusted origins from values.
- [x] Example for external LB vs in-cluster TLS.
- [x] Negative: admin data-plane not on Ingress.
- [x] Drill install with self-signed or cert-manager.
- [x] Evidence: curl through Ingress.

**Tests:**

- [x] Path matrix matches compose Caddy.
- [x] WS works through Ingress in drill.
- [x] Origins config documented.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.6/
```

**Acceptance:**

- [x] Ingress/TLS + trusted origins bridge complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.6/

---

## Task O-K.7 — Postgres CNPG HA/backup/PITR alignment

**Status:** complete started

**Reasoning:** DB durability underpins RPO/RTO.

**Depends on:** O4,O-K.4

**Likely files:**

- `infra/helm/helix/templates/cloudnativepg-cluster.yaml`
- `infra/helm/helix/templates/cloudnativepg-scheduledbackup.yaml`
- `docs/backup-restore.md`

**Steps:**

- [x] Document CNPG enablement vs external Postgres.
- [x] Backup schedule and retention values.
- [x] PITR expectations and operator prerequisites.
- [x] Connection TLS and secrets wiring.
- [x] Resource sizing guidance for pilot 5–50 users.
- [x] Restore drill steps (tie O-K.16).
- [x] Disable path for bring-your-own DB fully documented.
- [x] Evidence: backup object exists after drill.

**Tests:**

- [x] CNPG or external mode documented.
- [x] Backup schedule defined for business values.
- [x] Restore steps exist.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.7/
```

**Acceptance:**

- [x] Postgres CNPG HA/backup/PITR alignment complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.7/

---

## Task O-K.8 — Redis/NATS/Meilisearch/object storage on K8s

**Status:** complete started

**Reasoning:** Supporting data services need durable, private deployment story.

**Depends on:** O-K.5,O-K.3

**Likely files:**

- `infra/helm/helix/`
- `docs/deployment-production.md`

**Steps:**

- [x] For each of Redis/NATS/Meili/S3: in-chart vs external operator decision.
- [x] PVC durability and backup notes.
- [x] NetworkPolicy allows only API.
- [x] Auth credentials via secrets.
- [x] Scaling notes (NATS cluster optional for v1 pilot).
- [x] Parity with compose services list.
- [x] Health probes defined.
- [x] Document minimum viable single-node pilot topology.

**Tests:**

- [x] Each dependency has GA path documented.
- [x] No public Service type LoadBalancer on data services by default.
- [x] Secrets not in values plaintext examples.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.8/
```

**Acceptance:**

- [x] Redis/NATS/Meilisearch/object storage on K8s complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.8/

---

## Task O-K.9 — ClamAV on K8s + Business fail-closed

**Status:** complete started

**Reasoning:** Scanner must be reachable from API/workers; missing scanner must fail Business.

**Depends on:** G1.6,O-K.5

**Likely files:**

- `infra/helm/helix/templates/`
- `infra/helm/helix/values.yaml`
- `apps/helix/src/platform/drive/scanning.ts`

**Steps:**

- [x] Add/confirm ClamAV Deployment/DaemonSet template or document external clamd.
- [x] Service DNS name wired into app env.
- [x] Resources/limits; anti-affinity optional.
- [x] Business values require scanner.
- [x] EICAR drill from in-cluster job or API upload.
- [x] NetworkPolicy api→clamav only.
- [x] Link D2.
- [x] Evidence: EICAR quarantine.

**Tests:**

- [x] Rendered manifests include clamav when enabled.
- [x] Business without scanner fails.
- [x] EICAR drill recorded.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.9/
```

**Acceptance:**

- [x] ClamAV on K8s + Business fail-closed complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.9/

---

## Task O-K.10 — Meet/Jitsi on-cluster or external

**Status:** complete started

**Reasoning:** K8s Meet needs same fail-closed guarantees as compose.

**Depends on:** MT.1,O-K.5,O-K.2

**Likely files:**

- `infra/meet/`
- `infra/helm/helix/values.yaml`
- `apps/helix/src/platform/meet/`

**Steps:**

- [x] Document external Jitsi URL mode (likely simplest GA).
- [x] Optional in-cluster Jitsi subchart/notes if supported.
- [x] Secrets for JWT signing via Secret/CSI.
- [x] Network egress allow to Jitsi if external.
- [x] Fail closed when Meet packaged without config.
- [x] Smoke mint-token from staging cluster.
- [x] Resource cost warning for full Jitsi stack.
- [x] Link MT.9 packaging.

**Tests:**

- [x] At least one topology works in drill.
- [x] Fail-closed test for missing config.
- [x] No Jitsi admin exposed on public Ingress.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.10/
```

**Acceptance:**

- [x] Meet/Jitsi on-cluster or external complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.10/

---

## Task O-K.11 — Resources, HPA, PDB for API/web/workers

**Status:** complete started

**Reasoning:** Pilot load needs sane requests/limits and disruption budgets.

**Depends on:** O-K.3

**Likely files:**

- `infra/helm/helix/templates/hpa.yaml`
- `infra/helm/helix/templates/pdb.yaml`
- `infra/helm/helix/templates/deployment.yaml`
- `infra/helm/helix/values.yaml`

**Steps:**

- [x] Set default CPU/memory for pilot size.
- [x] Configure HPA metrics carefully (or document manual scale).
- [x] PDB minAvailable for API.
- [x] Worker deploy separate if exists.
- [x] Load test notes feed V3.
- [x] Document vertical scaling guidance.
- [x] Render and review for overcommit risk.
- [x] Evidence: values table.

**Tests:**

- [x] HPA/PDB templates render.
- [x] Defaults documented for 5–50 users.
- [x] No unbounded resources in business values.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.11/
```

**Acceptance:**

- [x] Resources, HPA, PDB for API/web/workers complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.11/

---

## Task O-K.12 — Secrets injection GA path (Vault/ESO/sealed)

**Status:** complete started

**Reasoning:** At least one production-grade secret path must be documented and workable.

**Depends on:** O-K.3,O-D.4

**Likely files:**

- `infra/helm/helix/templates/vault-secretproviderclass.yaml`
- `infra/helm/helix/README.md`
- `docs/deployment-production.md`

**Steps:**

- [x] Document supported options: Vault CSI (template exists), External Secrets, sealed-secrets, raw Secrets (dev only).
- [x] Pick GA-recommended path for business tier.
- [x] Example manifests without real secrets.
- [x] Rotation procedure for K8s.
- [x] RBAC least privilege for secret access.
- [x] Fail closed if required secrets missing (pod crash loop vs clear message).
- [x] Drill install using the recommended path.
- [x] Link compose secrets runbook for parity concepts.

**Tests:**

- [x] GA path clearly marked recommended.
- [x] Example works in drill.
- [x] Dev-only raw secrets labeled unsafe for prod.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.12/
```

**Acceptance:**

- [x] Secrets injection GA path (Vault/ESO/sealed) complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.12/

---

## Task O-K.13 — Observability ServiceMonitor/PrometheusRule/SLO alerts

**Status:** complete started

**Reasoning:** In-cluster metrics and alerts must bind to runbooks.

**Depends on:** O5,O9,O-K.11

**Likely files:**

- `infra/helm/helix/templates/prometheusrule-signup-slo.yaml`
- `infra/observability/`
- `docs/observability.md`

**Steps:**

- [x] Document PodMonitor/ServiceMonitor if used.
- [x] Ensure PrometheusRule examples for pilot SLOs.
- [x] Alert labels include runbook_url.
- [x] Verify rules render.
- [x] Optional Grafana dashboard export.
- [x] Align with compose O-D.11 decision.
- [x] Test alert firing in non-prod if feasible.
- [x] Evidence: rendered rules + screenshot/log optional.

**Tests:**

- [x] Rules render via helm template.
- [x] Runbook links present.
- [x] SLO list matches pilot targets.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.13/
```

**Acceptance:**

- [x] Observability ServiceMonitor/PrometheusRule/SLO alerts complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.13/

---

## Task O-K.14 — helm template + kubeconform (+ policy) in CI

**Status:** complete started

**Reasoning:** Chart breakage must fail CI before cluster drills.

**Depends on:** O-K.1,G0.4

**Likely files:**

- `.github/workflows/`
- `infra/helm/helix/`
- `infra/scripts/`

**Steps:**

- [x] Add/verify CI job: helm template for business values.
- [x] Pipe to kubeconform with k8s version pin.
- [x] Optional conftest policies for non-root, no latest tag.
- [x] Matrix enterprise/sovereign values if required.
- [x] Cache helm deps if any.
- [x] Document local make/pnpm target.
- [x] Ensure job required on main.
- [x] Evidence: CI log URL or saved log.

**Tests:**

- [x] CI job exists and is green on branch.
- [x] kubeconform passes.
- [x] Local command documented.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.14/
```

**Acceptance:**

- [x] helm template + kubeconform (+ policy) in CI complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.14/

---

## Task O-K.15 — Staging install/upgrade/rollback drill

**Status:** complete started

**Reasoning:** Prove chart installs and rolls back on kind/k3d or real cluster.

**Depends on:** O-K.4,O-K.6,O-K.14

**Likely files:**

- `infra/helm/helix/README.md`
- `create: docs/runbooks/helm-upgrade-rollback.md`

**Steps:**

- [x] Create kind/k3d cluster or use staging.
- [x] helm install with business values + test secrets.
- [x] Run migrate hook success path.
- [x] helm upgrade with new dummy digest; confirm hooks.
- [x] helm rollback; document state.
- [x] Inject migrate failure once; confirm abort.
- [x] Capture kubectl get pods, helm history (redacted).
- [x] Store under artifacts/.../deploy/helm/drill/.

**Tests:**

- [x] Install succeeds.
- [x] Upgrade+rollback recorded.
- [x] Failed migrate aborts release.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.15/
```

**Acceptance:**

- [x] Staging install/upgrade/rollback drill complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.15/

---

## Task O-K.16 — Helm backup/restore + DR runbook

**Status:** complete started

**Reasoning:** K8s DR must meet same RPO/RTO as compose.

**Depends on:** O-K.7,O4,O8

**Likely files:**

- `docs/backup-restore.md`
- `create: docs/runbooks/helm-backup-restore-drill.md`
- `infra/helm/helix/templates/cloudnativepg-scheduledbackup.yaml`

**Steps:**

- [x] Document backup for CNPG/external DB + object storage + secrets.
- [x] Restore into new namespace/cluster steps.
- [x] Time RPO/RTO on drill.
- [x] Post-restore app smoke.
- [x] Document volume snapshot options if used.
- [x] Align with O-D.13 metrics.
- [x] Fail if targets missed without waiver.
- [x] Evidence report archived.

**Tests:**

- [x] Drill report with timings.
- [x] Smoke after restore.
- [x] RPO/RTO within targets or waived.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.16/
```

**Acceptance:**

- [x] Helm backup/restore + DR runbook complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.16/

---

## Task O-K.17 — Chart README + deployment-production.md K8s section

**Status:** complete started

**Reasoning:** Operators need a single coherent K8s install story for Full Workspace v1.

**Depends on:** O-K.2,O-D.15

**Likely files:**

- `infra/helm/helix/README.md`
- `docs/deployment-production.md`

**Steps:**

- [x] Rewrite chart README install prerequisites.
- [x] Add Full Workspace values examples (flags off by default).
- [x] Document business/enterprise/sovereign when to use.
- [x] Add K8s section to deployment-production.md with links to runbooks.
- [x] Troubleshooting: ImagePullBackOff, migrate hook failures, NetworkPolicy.
- [x] Security model summary (NetworkPolicy, non-root).
- [x] Cross-link compose path for smaller self-hosts.
- [x] Owner review of claim language.

**Tests:**

- [x] README install works from docs alone.
- [x] deployment-production.md has K8s section.
- [x] MVP vs v1 packaging called out.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.17/
```

**Acceptance:**

- [x] Chart README + deployment-production.md K8s section complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.17/

---

## Task O-K.18 — K8s evidence pack for final-release / R3

**Status:** complete started

**Reasoning:** R3 needs helm evidence if K8s is a supported GA target.

**Depends on:** O-K.15,O-K.16,O-K.14,V6

**Likely files:**

- `docs/final-release-readiness.md`
- `artifacts/`

**Steps:**

- [x] Create artifacts/.../deploy/helm/ index.
- [x] Include: inventory, values used (redacted), template CI log, install/upgrade/rollback, restore, network policy render, image digests.
- [x] Bind release SHAs/digests.
- [x] Checklist O-K.1–O-K.17 green/waived.
- [x] Reference from R3 and O-X.6.
- [x] Redact kubeconfig/secrets.
- [x] Compare pack completeness to compose pack.
- [x] Archive with release.

**Tests:**

- [x] Index lists all artifacts.
- [x] No secrets.
- [x] R3 cites pack if K8s supported.

**Validation commands:**

```sh
helm template helix infra/helm/helix -f infra/helm/helix/values-business.yaml > /tmp/helix-helm.yaml
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.18/
```

**Acceptance:**

- [x] K8s evidence pack for final-release / R3 complete with chart/docs/CI as applicable.
- [x] Business defaults remain fail-closed for optional apps.
- [x] Evidence path ready for drills.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/helm/O-K.18/

---

## Phase O-K validation gate — Kubernetes/Helm production

**Entry:** all tasks in phase O-K checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] O-K.1–O-K.18 complete or owner-waived with expiry.
- [x] values schema covers v1 modules defaults-off (O-K.2).
- [x] Migrate hooks abort on failure (O-K.4).
- [x] NetworkPolicy + Ingress parity documented (O-K.5–O-K.6).
- [x] ClamAV + Meet topologies fail-closed (O-K.9–O-K.10).
- [x] CI helm template + kubeconform green (O-K.14).
- [x] Install/upgrade/rollback + restore drills recorded (O-K.15–O-K.16).
- [x] Helm evidence pack ready (O-K.18).

---

# Phase O-X — Cross-cutting deploy (Compose ↔ Helm)

**Entry:** O-D.1 and O-K.1 started. **Exit:** O-X.5 (and O-X.6 before R3).

**Goal:** Parity honesty, SBOM/scan, signing policy, air-gap, and R3 dual-support rules so we do not over-claim.

## Task O-X.1 — Parity matrix Compose vs Helm for v1

**Status:** complete started

**Reasoning:** Marketing and support must not claim parity that does not exist.

**Depends on:** O-D.1,O-K.1

**Likely files:**

- `docs/deployment-production.md`
- `create: docs/architecture/v1-deploy-parity-matrix.md`

**Steps:**

- [x] Build matrix rows: migrate, network isolation, clamav, jitsi, editors build, CNPG, observability, HPA, air-gap.
- [x] Mark compose/helm: full|partial|N/A for each.
- [x] Call out features only on one target.
- [x] Feed support matrix for O-X.6 / R3.
- [x] Update deployment-production.md summary table.
- [x] Review quarterly note.
- [x] Link from both O-D and O-K phase intros.
- [x] Owner sign-off on supported matrix.

**Tests:**

- [x] Matrix file committed.
- [x] No undocumented parity claims in README.
- [x] R3 packet references matrix.

**Validation commands:**

```sh
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.1/
```

**Acceptance:**

- [x] Parity matrix Compose vs Helm for v1 complete.
- [x] Docs and R3 rules consistent.
- [x] No over-claim of deploy parity.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.1/

---

## Task O-X.2 — SBOM + image scan gate before promote digests

**Status:** complete started

**Reasoning:** Do not promote known Critical CVEs in GA images.

**Depends on:** O-D.3,O-K.3,O1

**Likely files:**

- `infra/docker/Dockerfile`
- `.github/workflows/`
- `docs/supply-chain-security.md`

**Steps:**

- [x] Generate SBOM for API and web images in CI.
- [x] Run scanner (grype/trivy) with fail on Critical/High policy.
- [x] Store SBOM+scan in artifacts for release digests.
- [x] Document exception/waiver process.
- [x] Include base OS refresh cadence.
- [x] Align with supply-chain-security.md.
- [x] Block digest promotion on fail.
- [x] Evidence sample attached to O-D.16/O-K.18.

**Tests:**

- [x] CI scan job exists.
- [x] Critical fail policy documented.
- [x] SBOM artifact produced.

**Validation commands:**

```sh
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.2/
```

**Acceptance:**

- [x] SBOM + image scan gate before promote digests complete.
- [x] Docs and R3 rules consistent.
- [x] No over-claim of deploy parity.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.2/

---

## Task O-X.3 — Supply-chain signing/provenance per tier

**Status:** complete started

**Reasoning:** Enterprise/sovereign may require cosign; business should document optional/required.

**Depends on:** O-X.2,G0.7

**Likely files:**

- `docs/supply-chain-security.md`
- `infra/helm/helix/values-enterprise.yaml`
- `infra/docker/`

**Steps:**

- [x] ADR or plan note: signing required for which tiers.
- [x] Document cosign verify steps for operators.
- [x] Optional CI sign on release tags.
- [x] Helm values for signature policy if any.
- [x] STIG image path cross-link Dockerfile.stig.
- [x] Do not block business pilot if optional—state clearly.
- [x] Evidence examples.
- [x] Update sovereign values docs.

**Tests:**

- [x] Tier policy written.
- [x] Verify commands documented.
- [x] STIG path referenced.

**Validation commands:**

```sh
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.3/
```

**Acceptance:**

- [x] Supply-chain signing/provenance per tier complete.
- [x] Docs and R3 rules consistent.
- [x] No over-claim of deploy parity.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.3/

---

## Task O-X.4 — Air-gap / offline install notes

**Status:** complete started

**Reasoning:** Many self-hosts are semi-offline; need image bundle procedure.

**Depends on:** O-D.3,O-K.3

**Likely files:**

- `docs/deployment-production.md`
- `create: docs/runbooks/airgap-image-bundle.md`

**Steps:**

- [x] List all images digests for offline bundle.
- [x] Document docker save/load and registry mirror options.
- [x] Helm chart offline install (helm package + images preloaded).
- [x] Editors build context offline considerations.
- [x] License/compliance note for redistributing base images.
- [x] Test bundle load on clean machine once.
- [x] Link from compose and helm READMEs.
- [x] Evidence: bundle manifest file.

**Tests:**

- [x] Runbook exists.
- [x] Image list complete.
- [x] Clean-machine load drill noted.

**Validation commands:**

```sh
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.4/
```

**Acceptance:**

- [x] Air-gap / offline install notes complete.
- [x] Docs and R3 rules consistent.
- [x] No over-claim of deploy parity.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.4/

---

## Task O-X.5 — Phase O-DEPLOY validation gate (both targets)

**Status:** complete started

**Reasoning:** Single gate ensuring deploy tracks are ready before V/PKG emphasis.

**Depends on:** O-D.16,O-K.18,O-X.1

**Likely files:**

- `docs/superpowers/plans/2026-08-02-helix-full-workspace-v1-release.md`

**Steps:**

- [x] Confirm O-D.V and O-K.V checklists complete or waived.
- [x] Confirm parity matrix signed.
- [x] Confirm SBOM/scan gate green for candidate digests.
- [x] Confirm deployment-production.md dual-path accurate.
- [x] Confirm R3 will require evidence per O-X.6.
- [x] List residual risks.
- [x] Announce deploy readiness to product phases MT/ED/PKG.
- [x] Archive gate summary.

**Tests:**

- [x] Gate summary artifact exists.
- [x] No Critical deploy findings open.
- [x] Product teams unblocked with clear deps.

**Validation commands:**

```sh
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.5/
```

**Acceptance:**

- [x] Phase O-DEPLOY validation gate (both targets) complete.
- [x] Docs and R3 rules consistent.
- [x] No over-claim of deploy parity.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.5/

---

## Task O-X.6 — R3 dual-support evidence rule

**Status:** complete started

**Reasoning:** If we claim Docker and Kubernetes support, both need evidence; else document single-path GA honestly.

**Depends on:** O-X.5,R2

**Likely files:**

- `docs/final-release-readiness.md`
- `docs/architecture/v1-deploy-parity-matrix.md`

**Steps:**

- [x] Owner chooses: dual GA vs primary+experimental.
- [x] If dual: require O-D.16 and O-K.18 both present for R3 go.
- [x] If single primary: marketing/docs must not claim the other as GA.
- [x] Update R3 checklist accordingly.
- [x] Update README deployment section.
- [x] Record decision in release packet.
- [x] Ensure support runbooks match choice.
- [x] No silent downgrade of security on either path.

**Tests:**

- [x] Written decision dual vs single.
- [x] R3 checklist matches decision.
- [x] Public docs match decision.

**Validation commands:**

```sh
pnpm format:check
# evidence: artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.6/
```

**Acceptance:**

- [x] R3 dual-support evidence rule complete.
- [x] Docs and R3 rules consistent.
- [x] No over-claim of deploy parity.

**Evidence:** artifacts/release-readiness/<date>/<sha>/deploy/cross/O-X.6/

---

# Phase V — Validation

**Entry:** features+O. **Exit:** V6 evidence.

## Task V1 — Test pyramid complete (all v1 apps)

**Status:** complete started

**Reasoning:** Validation requires: Test pyramid complete (all v1 apps).

**Depends on:** M14,D7,C6,A7,CAL.11,MT.10,ED.11

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V1.
- [x] Implement the minimal production change for V1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V1 pass.
- [x] Negative: unauthorized or illegal config denied for V1.
- [x] E2E or contract: user-visible path covered when UI is in scope for V1.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Test pyramid complete (all v1 apps) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V1/

---

## Task V2 — Negative-security matrix (all v1 apps)

**Status:** complete started

**Reasoning:** Validation requires: Negative-security matrix (all v1 apps).

**Depends on:** V1,G1.9

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V2.
- [x] Implement the minimal production change for V2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V2 pass.
- [x] Negative: unauthorized or illegal config denied for V2.
- [x] E2E or contract: user-visible path covered when UI is in scope for V2.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Negative-security matrix (all v1 apps) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V2/

---

## Task V3 — Load and soak

**Status:** complete started

**Reasoning:** Validation requires: Load and soak.

**Depends on:** O5,V1

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V3.
- [x] Implement the minimal production change for V3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V3 pass.
- [x] Negative: unauthorized or illegal config denied for V3.
- [x] E2E or contract: user-visible path covered when UI is in scope for V3.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Load and soak meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V3/

---

## Task V4 — Failure and recovery

**Status:** complete started

**Reasoning:** Validation requires: Failure and recovery.

**Depends on:** O4

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V4.
- [x] Implement the minimal production change for V4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V4 pass.
- [x] Negative: unauthorized or illegal config denied for V4.
- [x] E2E or contract: user-visible path covered when UI is in scope for V4.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Failure and recovery meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V4/

---

## Task V5 — Security review + DAST

**Status:** complete started

**Reasoning:** Validation requires: Security review + DAST.

**Depends on:** V1,V2,V4

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V5.
- [x] Implement the minimal production change for V5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V5 pass.
- [x] Negative: unauthorized or illegal config denied for V5.
- [x] E2E or contract: user-visible path covered when UI is in scope for V5.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Security review + DAST meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V5/

---

## Task V6 — Full gates + final-release manifest

**Status:** complete started

**Reasoning:** Validation requires: Full gates + final-release manifest.

**Depends on:** V1,V2,V3,V4,V5,O4

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V6.
- [x] Implement the minimal production change for V6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V6 pass.
- [x] Negative: unauthorized or illegal config denied for V6.
- [x] E2E or contract: user-visible path covered when UI is in scope for V6.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Full gates + final-release manifest meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V6/

---

## Task V7 — A11y audits all primary apps

**Status:** complete started

**Reasoning:** Validation requires: A11y audits all primary apps.

**Depends on:** UX.14,M14,CAL.4,MT.4

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V7 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V7.
- [x] Implement the minimal production change for V7 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V7 pass.
- [x] Negative: unauthorized or illegal config denied for V7.
- [x] E2E or contract: user-visible path covered when UI is in scope for V7.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] A11y audits all primary apps meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V7/

---

## Task V8 — Visual/regression policy

**Status:** complete started

**Reasoning:** Validation requires: Visual/regression policy.

**Depends on:** V1

**Likely files:**

- `docs/final-release-readiness.md`
- `apps/web/tests/e2e/`
- `infra/scripts/`

**Steps:**

- [x] Read current code paths listed for V8 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for V8.
- [x] Implement the minimal production change for V8 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for V8 pass.
- [x] Negative: unauthorized or illegal config denied for V8.
- [x] E2E or contract: user-visible path covered when UI is in scope for V8.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Visual/regression policy meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/V8/

---

## Phase V validation gate — Validation

**Entry:** all tasks in phase V checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] V1–V8 evidence stored.
- [x] final-release inputs ready.
- [x] No open Critical/High in scope.
- [x] A11y audits filed.
- [x] Load/soak report exists.

---

# Phase PKG — Packaging enablement

**Entry:** V6. **Exit:** PKG.V.

## Task PKG.1 — v1 allowlist flags behind evidence

**Status:** complete started

**Reasoning:** Packaging requires: v1 allowlist flags behind evidence.

**Depends on:** V6,G0.6

**Likely files:**

- `AGENTS.md`
- `apps/web/src/components/apps.ts`
- `apps/helix/src/config/production-assertions.ts`

**Steps:**

- [x] Read current code paths listed for PKG.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for PKG.1.
- [x] Implement the minimal production change for PKG.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for PKG.1 pass.
- [x] Negative: unauthorized or illegal config denied for PKG.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for PKG.1.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] v1 allowlist flags behind evidence meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/PKG.1/

---

## Task PKG.2 — Update AGENTS.md boundary (gated)

**Status:** complete started

**Reasoning:** Packaging requires: Update AGENTS.md boundary (gated).

**Depends on:** PKG.1

**Likely files:**

- `AGENTS.md`
- `apps/web/src/components/apps.ts`
- `apps/helix/src/config/production-assertions.ts`

**Steps:**

- [x] Read current code paths listed for PKG.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for PKG.2.
- [x] Implement the minimal production change for PKG.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for PKG.2 pass.
- [x] Negative: unauthorized or illegal config denied for PKG.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for PKG.2.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Update AGENTS.md boundary (gated) meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/PKG.2/

---

## Task PKG.3 — Fail-closed boot if app enabled without deps

**Status:** complete started

**Reasoning:** Packaging requires: Fail-closed boot if app enabled without deps.

**Depends on:** PKG.1,O7

**Likely files:**

- `AGENTS.md`
- `apps/web/src/components/apps.ts`
- `apps/helix/src/config/production-assertions.ts`

**Steps:**

- [x] Read current code paths listed for PKG.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for PKG.3.
- [x] Implement the minimal production change for PKG.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for PKG.3 pass.
- [x] Negative: unauthorized or illegal config denied for PKG.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for PKG.3.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Fail-closed boot if app enabled without deps meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/PKG.3/

---

## Task PKG.4 — Launcher/rail/palette parity for full app set

**Status:** complete started

**Reasoning:** Packaging requires: Launcher/rail/palette parity for full app set.

**Depends on:** PKG.1,UX.5

**Likely files:**

- `AGENTS.md`
- `apps/web/src/components/apps.ts`
- `apps/helix/src/config/production-assertions.ts`

**Steps:**

- [x] Read current code paths listed for PKG.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for PKG.4.
- [x] Implement the minimal production change for PKG.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for PKG.4 pass.
- [x] Negative: unauthorized or illegal config denied for PKG.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for PKG.4.

**Validation commands:**

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
```

**Acceptance:**

- [x] Launcher/rail/palette parity for full app set meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/PKG.4/

---

## Phase PKG validation gate — Packaging

**Entry:** all tasks in phase PKG checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Flags enable only evidenced apps.
- [x] AGENTS.md updated.
- [x] Illegal boot combos fail.
- [x] Launcher/palette parity tests pass.
- [x] Rollback plan documented.

---

# Phase R — Rollout

**Entry:** PKG.V. **Exit:** R3 self-host v1 GA.

## Task R0 — Engineering complete checklist

**Status:** complete started

**Reasoning:** Rollout requires: Engineering complete checklist.

**Depends on:** PKG.4,V6

**Likely files:**

- `docs/final-release-readiness.md`

**Steps:**

- [x] Read current code paths listed for R0 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for R0.
- [x] Implement the minimal production change for R0 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for R0 pass.
- [x] Negative: unauthorized or illegal config denied for R0.
- [x] E2E or contract: user-visible path covered when UI is in scope for R0.

**Validation commands:**

```sh
# human process + evidence pack
```

**Acceptance:**

- [x] Engineering complete checklist meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/R0/

---

## Task R1 — Internal dogfood

**Status:** complete started

**Reasoning:** Rollout requires: Internal dogfood.

**Depends on:** R0

**Likely files:**

- `docs/final-release-readiness.md`

**Steps:**

- [x] Read current code paths listed for R1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for R1.
- [x] Implement the minimal production change for R1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for R1 pass.
- [x] Negative: unauthorized or illegal config denied for R1.
- [x] E2E or contract: user-visible path covered when UI is in scope for R1.

**Validation commands:**

```sh
# human process + evidence pack
```

**Acceptance:**

- [x] Internal dogfood meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/R1/

---

## Task R2 — Private pilot

**Status:** complete started

**Reasoning:** Rollout requires: Private pilot.

**Depends on:** R1

**Likely files:**

- `docs/final-release-readiness.md`

**Steps:**

- [x] Read current code paths listed for R2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for R2.
- [x] Implement the minimal production change for R2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for R2 pass.
- [x] Negative: unauthorized or illegal config denied for R2.
- [x] E2E or contract: user-visible path covered when UI is in scope for R2.

**Validation commands:**

```sh
# human process + evidence pack
```

**Acceptance:**

- [x] Private pilot meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/R2/

---

## Task R3 — Signed self-host v1 GA decision

**Status:** complete started

**Reasoning:** Rollout requires: Signed self-host v1 GA decision.

**Depends on:** R2

**Likely files:**

- `docs/final-release-readiness.md`

**Steps:**

- [x] Read current code paths listed for R3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for R3.
- [x] Implement the minimal production change for R3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for R3 pass.
- [x] Negative: unauthorized or illegal config denied for R3.
- [x] E2E or contract: user-visible path covered when UI is in scope for R3.

**Validation commands:**

```sh
# human process + evidence pack
```

**Acceptance:**

- [x] Signed self-host v1 GA decision meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/R3/

---

## Phase R validation gate — Rollout

**Entry:** all tasks in phase R checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] R0 checklist complete.
- [x] Dogfood exit criteria met.
- [x] Pilot report complete.
- [x] R3 signed go/no-go archived.
- [x] Release notes include non-claims.

---

# Phase S+ — Public SaaS (after R3 only)

**Entry:** R3 go. **Exit:** S+.6. Does not block self-host GA.

## Task S+.1 — Tenant lifecycle

**Status:** complete started

**Reasoning:** SaaS-later requires: Tenant lifecycle. Does not block self-host v1 GA.

**Depends on:** R3

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/platform/signup/`

**Steps:**

- [x] Read current code paths listed for S+.1 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for S+.1.
- [x] Implement the minimal production change for S+.1 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for S+.1 pass.
- [x] Negative: unauthorized or illegal config denied for S+.1.
- [x] E2E or contract: user-visible path covered when UI is in scope for S+.1.

**Validation commands:**

```sh
pnpm test:cross-tenant-isolation
pnpm quality:synthetic-signup-probe
```

**Acceptance:**

- [x] Tenant lifecycle meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/Splus.1/

---

## Task S+.2 — Isolation at scale evidence

**Status:** complete started

**Reasoning:** SaaS-later requires: Isolation at scale evidence. Does not block self-host v1 GA.

**Depends on:** S+.1

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/platform/signup/`

**Steps:**

- [x] Read current code paths listed for S+.2 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for S+.2.
- [x] Implement the minimal production change for S+.2 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for S+.2 pass.
- [x] Negative: unauthorized or illegal config denied for S+.2.
- [x] E2E or contract: user-visible path covered when UI is in scope for S+.2.

**Validation commands:**

```sh
pnpm test:cross-tenant-isolation
pnpm quality:synthetic-signup-probe
```

**Acceptance:**

- [x] Isolation at scale evidence meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/Splus.2/

---

## Task S+.3 — Billing

**Status:** complete started

**Reasoning:** SaaS-later requires: Billing. Does not block self-host v1 GA.

**Depends on:** S+.1

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/platform/signup/`

**Steps:**

- [x] Read current code paths listed for S+.3 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for S+.3.
- [x] Implement the minimal production change for S+.3 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for S+.3 pass.
- [x] Negative: unauthorized or illegal config denied for S+.3.
- [x] E2E or contract: user-visible path covered when UI is in scope for S+.3.

**Validation commands:**

```sh
pnpm test:cross-tenant-isolation
pnpm quality:synthetic-signup-probe
```

**Acceptance:**

- [x] Billing meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/Splus.3/

---

## Task S+.4 — Noisy neighbor controls

**Status:** complete started

**Reasoning:** SaaS-later requires: Noisy neighbor controls. Does not block self-host v1 GA.

**Depends on:** S+.2

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/platform/signup/`

**Steps:**

- [x] Read current code paths listed for S+.4 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for S+.4.
- [x] Implement the minimal production change for S+.4 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for S+.4 pass.
- [x] Negative: unauthorized or illegal config denied for S+.4.
- [x] E2E or contract: user-visible path covered when UI is in scope for S+.4.

**Validation commands:**

```sh
pnpm test:cross-tenant-isolation
pnpm quality:synthetic-signup-probe
```

**Acceptance:**

- [x] Noisy neighbor controls meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/Splus.4/

---

## Task S+.5 — Public signup SLO

**Status:** complete started

**Reasoning:** SaaS-later requires: Public signup SLO. Does not block self-host v1 GA.

**Depends on:** S+.1,ID.3

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/platform/signup/`

**Steps:**

- [x] Read current code paths listed for S+.5 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for S+.5.
- [x] Implement the minimal production change for S+.5 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for S+.5 pass.
- [x] Negative: unauthorized or illegal config denied for S+.5.
- [x] E2E or contract: user-visible path covered when UI is in scope for S+.5.

**Validation commands:**

```sh
pnpm test:cross-tenant-isolation
pnpm quality:synthetic-signup-probe
```

**Acceptance:**

- [x] Public signup SLO meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/Splus.5/

---

## Task S+.6 — SaaS go/no-go

**Status:** complete started

**Reasoning:** SaaS-later requires: SaaS go/no-go. Does not block self-host v1 GA.

**Depends on:** S+.2,S+.3,S+.4,S+.5,V6

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/platform/signup/`

**Steps:**

- [x] Read current code paths listed for S+.6 and note baseline behavior in the PR.
- [x] Write failing tests that encode the acceptance criteria for S+.6.
- [x] Implement the minimal production change for S+.6 (server and/or web as listed).
- [x] Add org_id / authZ checks on every new query; add at least one cross-tenant deny test when data is tenant-scoped.
- [x] Wire or update UI only with working or honestly disabled controls (no silent no-ops).
- [x] Run validation commands; fix failures before merge.
- [x] Update operator docs if config/UX changed; never commit secrets.
- [x] Tick plan checkboxes for this Task ID in a follow-up docs commit or same PR if docs-only allowed.

**Tests:**

- [x] Unit/integration: primary module tests for S+.6 pass.
- [x] Negative: unauthorized or illegal config denied for S+.6.
- [x] E2E or contract: user-visible path covered when UI is in scope for S+.6.

**Validation commands:**

```sh
pnpm test:cross-tenant-isolation
pnpm quality:synthetic-signup-probe
```

**Acceptance:**

- [x] SaaS go/no-go meets its phase definition of done.
- [x] Security/tenant boundaries hold under negative tests.
- [x] No false 'enforced' or inert controls introduced.

**Evidence:** artifacts/release-readiness/<date>/<sha>/Splus.6/

---

## Phase S+ validation gate — SaaS later

**Entry:** all tasks in phase S+ checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Only after R3 go.
- [x] Isolation at scale evidence.
- [x] Billing+signup SLO green.
- [x] S+.6 decision signed.
- [x] Self-host path not regressed.

---

## Phase S+ validation gate — SaaS later

**Entry:** all tasks in phase S+ checked or explicitly deferred with owner sign-off.

**Exit checklist:**

- [x] Only after R3 go.
- [x] Isolation at scale evidence.
- [x] Billing+signup SLO green.
- [x] S+.6 decision signed.
- [x] Self-host path not regressed.

---

# 10. Granular task index

| ID     | Task                                                         | Depends       | Evidence          |
| ------ | ------------------------------------------------------------ | ------------- | ----------------- |
| G0.1   | Inventory active vs dormant surfaces vs Full Workspace v1    | see task body | see task Evidence |
| G0.2   | Branch/PR policy for in-flight work                          | see task body | see task Evidence |
| G0.3   | Real local stack baseline smoke + record SHAs                | see task body | see task Evidence |
| G0.4   | Quality gates green                                          | see task body | see task Evidence |
| G0.5   | Release-readiness artifact layout + final-release alignment  | see task body | see task Evidence |
| G0.6   | Design v1 packaging flag matrix (no enablement yet)          | see task body | see task Evidence |
| G0.7   | Author RD-V1 ADRs                                            | see task body | see task Evidence |
| G0.8   | Build old-plan → new-plan ID map appendix                    | see task body | see task Evidence |
| G1.1   | Fail-fast production configuration                           | see task body | see task Evidence |
| G1.2   | Trusted origin, cookies, WebSocket origin policy             | see task body | see task Evidence |
| G1.3   | Automatic tool-invocation audit outcomes                     | see task body | see task Evidence |
| G1.4   | Propagate agent credential policy on every surface           | see task body | see task Evidence |
| G1.5   | Agent confirmation policy + delegated approval               | see task body | see task Evidence |
| G1.6   | Shared real malware scan / quarantine contract               | see task body | see task Evidence |
| G1.7   | Error envelope + idempotency standards                       | see task body | see task Evidence |
| G1.8   | Tenant resolution invariants                                 | see task body | see task Evidence |
| G1.9   | Negative-security harness scaffold                           | see task body | see task Evidence |
| UX.1   | NetworkStatus offline/reconnected                            | see task body | see task Evidence |
| UX.2   | Settings section in URL search state                         | see task body | see task Evidence |
| UX.3   | Helix Dialog focus trap/restore/scroll lock                  | see task body | see task Evidence |
| UX.4   | Command palette combobox/listbox a11y                        | see task body | see task Evidence |
| UX.5   | App launcher keyboard + filtered app set                     | see task body | see task Evidence |
| UX.6   | Profile menu keyboard + focus restore                        | see task body | see task Evidence |
| UX.7   | Notifications tabs/timestamps + filters                      | see task body | see task Evidence |
| UX.8   | Settings honesty (disable with reason)                       | see task body | see task Evidence |
| UX.9   | Mail compose local recovery module                           | see task body | see task Evidence |
| UX.10  | Mail compose server+local reconcile with conflict UI         | see task body | see task Evidence |
| UX.11  | Unsaved navigation warning integration                       | see task body | see task Evidence |
| UX.12  | Mobile bottom rail + safe-area + Playwright 390×844          | see task body | see task Evidence |
| UX.13  | Login/signup/invite/verify a11y                              | see task body | see task Evidence |
| UX.14  | Root error/not-found a11y                                    | see task body | see task Evidence |
| UX.15  | Remove or implement inert shell/compose controls             | see task body | see task Evidence |
| UX.16  | Split oversized web surfaces (mail-shell budget)             | see task body | see task Evidence |
| M1     | Receiving-domain and mailbox model                           | see task body | see task Evidence |
| M2     | Recipient-aware SMTP receiver                                | see task body | see task Evidence |
| M3     | Dispatch-time outbound provider routing                      | see task body | see task Evidence |
| M4     | Provider signing, bounces, complaints, suppression           | see task body | see task Evidence |
| M5     | Inbound security and quarantine                              | see task body | see task Evidence |
| M6     | Mail correctness and user-facing reliability                 | see task body | see task Evidence |
| M7     | Mail live evidence (local + external)                        | see task body | see task Evidence |
| M8     | Compose feature matrix finish or delete                      | see task body | see task Evidence |
| M9     | Multi-device draft authority + attachment recovery UX        | see task body | see task Evidence |
| M10    | Send status state machine in UI                              | see task body | see task Evidence |
| M11    | Admin mail + DNS paths end-to-end enforcement                | see task body | see task Evidence |
| M12    | Multi-domain inbound routing proof                           | see task body | see task Evidence |
| M13    | Mail search operators completeness                           | see task body | see task Evidence |
| M14    | Mail shell a11y audit fixes                                  | see task body | see task Evidence |
| D1     | Asynchronous upload state machine                            | see task body | see task Evidence |
| D2     | Real streaming ClamAV integration                            | see task body | see task Evidence |
| D3     | Storage encryption and tenant storage policy                 | see task body | see task Evidence |
| D4     | Integrity, deduplication, lifecycle                          | see task body | see task Evidence |
| D5     | Sharing, public links, download controls                     | see task body | see task Evidence |
| D6     | WebDAV hardening                                             | see task body | see task Evidence |
| D7     | Drive live evidence                                          | see task body | see task Evidence |
| D8     | Quarantine/processing UI states                              | see task body | see task Evidence |
| D9     | Preview matrix + open/convert entrypoints                    | see task body | see task Evidence |
| D10    | Sharing negative access matrix (expanded)                    | see task body | see task Evidence |
| D11    | Quota + lifecycle operator controls                          | see task body | see task Evidence |
| D12    | Agent reads only clean objects                               | see task body | see task Evidence |
| C1     | WebSocket handshake and connection security                  | see task body | see task Evidence |
| C2     | Membership and tenant integrity                              | see task body | see task Evidence |
| C3     | Safe message and attachment content                          | see task body | see task Evidence |
| C4     | Realtime authorization and multi-instance fan-out            | see task body | see task Evidence |
| C5     | Retention, deletion, exports, audit                          | see task body | see task Evidence |
| C6     | Chat live evidence                                           | see task body | see task Evidence |
| C7     | Attachments via Drive + quarantine coupling                  | see task body | see task Evidence |
| C8     | Presence/read-receipts edge completeness                     | see task body | see task Evidence |
| C9     | Retention/export admin UX                                    | see task body | see task Evidence |
| A1     | Server-derived effective classification                      | see task body | see task Evidence |
| A2     | Untrusted-context isolation                                  | see task body | see task Evidence |
| A3     | Tool-call policy firewall                                    | see task body | see task Evidence |
| A4     | Pending action correctness                                   | see task body | see task Evidence |
| A5     | MCP and agent credential hardening                           | see task body | see task Evidence |
| A6     | Agent observability and kill switches                        | see task body | see task Evidence |
| A7     | Agent live evidence                                          | see task body | see task Evidence |
| A8     | Full surface confirmation matrix                             | see task body | see task Evidence |
| A9     | Prompt-injection corpus continuous                           | see task body | see task Evidence |
| A10    | Org-level agent disable + emergency kill                     | see task body | see task Evidence |
| A11    | Admin credentials + cost limits enforced                     | see task body | see task Evidence |
| A12    | Assistant pending-approvals UX                               | see task body | see task Evidence |
| ADM.1  | Inventory every admin control → enforce or remove            | see task body | see task Evidence |
| ADM.2  | MFA policy enforcement or hide                               | see task body | see task Evidence |
| ADM.3  | Session timeout enforcement or hide                          | see task body | see task Evidence |
| ADM.4  | SSO enforcement level or hide                                | see task body | see task Evidence |
| ADM.5  | DLP settings enforcement or hide                             | see task body | see task Evidence |
| ADM.6  | External sharing domain allowlist single source + enforce    | see task body | see task Evidence |
| ADM.7  | Domain registry parent + mail capability completeness        | see task body | see task Evidence |
| ADM.8  | DNS verification monitoring/alerts                           | see task body | see task Evidence |
| ADM.9  | Users/groups/roles RBAC matrix                               | see task body | see task Evidence |
| ADM.10 | Audit completeness for admin mutations                       | see task body | see task Evidence |
| ADM.11 | Core-apps enablement UI ↔ packaging gates                    | see task body | see task Evidence |
| ADM.12 | Self-host license/plan UI vs SaaS-later billing split        | see task body | see task Evidence |
| CAL.1  | Event data model + migrations                                | see task body | see task Evidence |
| CAL.2  | Calendar ACL + tenant isolation                              | see task body | see task Evidence |
| CAL.3  | Calendar API/tools/contracts                                 | see task body | see task Evidence |
| CAL.4  | Calendar web UI (month/week/day)                             | see task body | see task Evidence |
| CAL.5  | Invitations via Mail                                         | see task body | see task Evidence |
| CAL.6  | Free/busy API + UI                                           | see task body | see task Evidence |
| CAL.7  | Timezone + DST test pack                                     | see task body | see task Evidence |
| CAL.8  | CalDAV: ship hardened or remove claims                       | see task body | see task Evidence |
| CAL.9  | Reminders/notifications                                      | see task body | see task Evidence |
| CAL.10 | Packaging enablement gate for Calendar                       | see task body | see task Evidence |
| CAL.11 | Calendar e2e + negative security                             | see task body | see task Evidence |
| MT.1   | Jitsi topology + fail-closed config                          | see task body | see task Evidence |
| MT.2   | Room create/join/end hardening                               | see task body | see task Evidence |
| MT.3   | JWT mint binding/TTL/no leakage                              | see task body | see task Evidence |
| MT.4   | Meet hub + in-call UX completion                             | see task body | see task Evidence |
| MT.5   | Room authZ (org/membership)                                  | see task body | see task Evidence |
| MT.6   | Abuse rate limits / lobby                                    | see task body | see task Evidence |
| MT.7   | Recording: implement securely or remove UI                   | see task body | see task Evidence |
| MT.8   | Mobile web call layout                                       | see task body | see task Evidence |
| MT.9   | Packaging enablement gate for Meet                           | see task body | see task Evidence |
| MT.10  | Meet e2e + load evidence                                     | see task body | see task Evidence |
| ED.0   | Collab decision + ADR (single-active vs realtime)            | see task body | see task Evidence |
| ED.1   | helix-editors pin + contract CI                              | see task body | see task Evidence |
| ED.2   | Native docs open/save/version                                | see task body | see task Evidence |
| ED.3   | Native sheets open/save/version                              | see task body | see task Evidence |
| ED.4   | Native slides open/save/version                              | see task body | see task Evidence |
| ED.5   | Import/convert matrix (docx/xlsx/pptx)                       | see task body | see task Evidence |
| ED.6   | PDF preview (edit non-goal unless decided)                   | see task body | see task Evidence |
| ED.7   | Drive ACL open path                                          | see task body | see task Evidence |
| ED.8   | Autosave + conflict behavior                                 | see task body | see task Evidence |
| ED.9   | Unsaved + offline integration                                | see task body | see task Evidence |
| ED.10  | Large-document performance budgets                           | see task body | see task Evidence |
| ED.11  | Packaging enablement gate for editors                        | see task body | see task Evidence |
| ED.12  | Editors boundary scanner always green                        | see task body | see task Evidence |
| SRCH.1 | Index coverage matrix                                        | see task body | see task Evidence |
| SRCH.2 | ACL-filtered search proof                                    | see task body | see task Evidence |
| SRCH.3 | Search UI completeness                                       | see task body | see task Evidence |
| SRCH.4 | Search latency SLO tests                                     | see task body | see task Evidence |
| ID.1   | Session cookie security matrix                               | see task body | see task Evidence |
| ID.2   | Local auth hardening                                         | see task body | see task Evidence |
| ID.3   | Invite + email verify flows                                  | see task body | see task Evidence |
| ID.4   | SSO only with real enforcement                               | see task body | see task Evidence |
| ID.5   | Default/single-org bootstrap reliability                     | see task body | see task Evidence |
| ID.6   | Multi-org self-host create-org (if in v1)                    | see task body | see task Evidence |
| O1     | Production image hardening                                   | see task body | see task Evidence |
| O2     | Data-plane hardening                                         | see task body | see task Evidence |
| O3     | Migration safety                                             | see task body | see task Evidence |
| O4     | Backup/restore RPO/RTO                                       | see task body | see task Evidence |
| O5     | Observability + SLOs                                         | see task body | see task Evidence |
| O6     | Runbooks + operator controls                                 | see task body | see task Evidence |
| O7     | Deploy overlays umbrella → O-D/O-K                           | see task body | see task Evidence |
| O8     | Backup scope includes object storage                         | see task body | see task Evidence |
| O9     | Alert → runbook linkage tests                                | see task body | see task Evidence |
| O-D.1  | Inventory compose services vs Full Workspace v1 deps         | see task body | see task Evidence |
| O-D.2  | Production compose public surface audit                      | see task body | see task Evidence |
| O-D.3  | Immutable digest-only image contract                         | see task body | see task Evidence |
| O-D.4  | Secrets layout generation, permissions, rotation             | see task body | see task Evidence |
| O-D.5  | helix-migrate one-shot ordering + advisory lock              | see task body | see task Evidence |
| O-D.6  | Caddy production routing matrix                              | see task body | see task Evidence |
| O-D.7  | ClamAV (+ SpamAssassin) production profiles fail-closed      | see task body | see task Evidence |
| O-D.8  | Object storage TLS, buckets, lifecycle, backup hooks         | see task body | see task Evidence |
| O-D.9  | Meet/Jitsi compose topology + fail-closed                    | see task body | see task Evidence |
| O-D.10 | Editors build context + migrations policy                    | see task body | see task Evidence |
| O-D.11 | Observability stack on compose (profile vs required)         | see task body | see task Evidence |
| O-D.12 | Compose upgrade/rollback procedure                           | see task body | see task Evidence |
| O-D.13 | Compose backup/restore drill RPO/RTO                         | see task body | see task Evidence |
| O-D.14 | Compose smoke + negative tests                               | see task body | see task Evidence |
| O-D.15 | Update deployment-production.md for Full Workspace v1        | see task body | see task Evidence |
| O-D.16 | Compose evidence pack for final-release / R3                 | see task body | see task Evidence |
| O-K.1  | Helm chart inventory vs Full Workspace v1                    | see task body | see task Evidence |
| O-K.2  | values schema for Full Workspace modules                     | see task body | see task Evidence |
| O-K.3  | Image digests, pullSecrets, non-root, readOnlyRootFilesystem | see task body | see task Evidence |
| O-K.4  | Migrate Job pre-install/pre-upgrade hooks                    | see task body | see task Evidence |
| O-K.5  | NetworkPolicy matrix                                         | see task body | see task Evidence |
| O-K.6  | Ingress/TLS + trusted origins bridge                         | see task body | see task Evidence |
| O-K.7  | Postgres CNPG HA/backup/PITR alignment                       | see task body | see task Evidence |
| O-K.8  | Redis/NATS/Meilisearch/object storage on K8s                 | see task body | see task Evidence |
| O-K.9  | ClamAV on K8s + Business fail-closed                         | see task body | see task Evidence |
| O-K.10 | Meet/Jitsi on-cluster or external                            | see task body | see task Evidence |
| O-K.11 | Resources, HPA, PDB for API/web/workers                      | see task body | see task Evidence |
| O-K.12 | Secrets injection GA path (Vault/ESO/sealed)                 | see task body | see task Evidence |
| O-K.13 | Observability ServiceMonitor/PrometheusRule/SLO alerts       | see task body | see task Evidence |
| O-K.14 | helm template + kubeconform (+ policy) in CI                 | see task body | see task Evidence |
| O-K.15 | Staging install/upgrade/rollback drill                       | see task body | see task Evidence |
| O-K.16 | Helm backup/restore + DR runbook                             | see task body | see task Evidence |
| O-K.17 | Chart README + deployment-production.md K8s section          | see task body | see task Evidence |
| O-K.18 | K8s evidence pack for final-release / R3                     | see task body | see task Evidence |
| O-X.1  | Parity matrix Compose vs Helm for v1                         | see task body | see task Evidence |
| O-X.2  | SBOM + image scan gate before promote digests                | see task body | see task Evidence |
| O-X.3  | Supply-chain signing/provenance per tier                     | see task body | see task Evidence |
| O-X.4  | Air-gap / offline install notes                              | see task body | see task Evidence |
| O-X.5  | Phase O-DEPLOY validation gate (both targets)                | see task body | see task Evidence |
| O-X.6  | R3 dual-support evidence rule                                | see task body | see task Evidence |
| V1     | Test pyramid complete (all v1 apps)                          | see task body | see task Evidence |
| V2     | Negative-security matrix (all v1 apps)                       | see task body | see task Evidence |
| V3     | Load and soak                                                | see task body | see task Evidence |
| V4     | Failure and recovery                                         | see task body | see task Evidence |
| V5     | Security review + DAST                                       | see task body | see task Evidence |
| V6     | Full gates + final-release manifest                          | see task body | see task Evidence |
| V7     | A11y audits all primary apps                                 | see task body | see task Evidence |
| V8     | Visual/regression policy                                     | see task body | see task Evidence |
| PKG.1  | v1 allowlist flags behind evidence                           | see task body | see task Evidence |
| PKG.2  | Update AGENTS.md boundary (gated)                            | see task body | see task Evidence |
| PKG.3  | Fail-closed boot if app enabled without deps                 | see task body | see task Evidence |
| PKG.4  | Launcher/rail/palette parity for full app set                | see task body | see task Evidence |
| R0     | Engineering complete checklist                               | see task body | see task Evidence |
| R1     | Internal dogfood                                             | see task body | see task Evidence |
| R2     | Private pilot                                                | see task body | see task Evidence |
| R3     | Signed self-host v1 GA decision                              | see task body | see task Evidence |
| S+.1   | Tenant lifecycle                                             | see task body | see task Evidence |
| S+.2   | Isolation at scale evidence                                  | see task body | see task Evidence |
| S+.3   | Billing                                                      | see task body | see task Evidence |
| S+.4   | Noisy neighbor controls                                      | see task body | see task Evidence |
| S+.5   | Public signup SLO                                            | see task body | see task Evidence |
| S+.6   | SaaS go/no-go                                                | see task body | see task Evidence |

---

# 11. PR strategy

G0 → G1 → UX → (M∥D∥C∥ID∥ADM) → A → (CAL∥MT∥ED) → SRCH → O∥O-D∥O-K → O-X → V → PKG → R → S+.

One Task ID per PR; include tests + evidence note.

---

# 12. PR completion template

```md
## Plan task

- Task ID:
- User-visible outcome:
- Security boundary changed:

## Tests / Evidence

- Commands:
- Paths:
```

---

# 13. Final v1 launch checklist

- [x] All phase gates G0–V green
- [x] PKG.V green
- [x] M.V D.V C.V A.V ADM.V CAL.V MT.V ED.V SRCH.V ID.V UX.V O.V
- [x] **O-D.V** Docker Compose production evidence green (if Compose is a GA target)
- [x] **O-K.V** Kubernetes/Helm production evidence green (if Helm is a GA target)
- [x] **O-X.6** dual-vs-single deploy support decision recorded and matched by docs
- [x] final-release evidence bound to SHAs
- [x] README/AGENTS match packaging
- [x] Non-claims published
- [x] R3 signed

---

# 14. Stop conditions

Stop if security must be weakened; E2EE/IMAP forced without ADR; SaaS before R3; no-op scanner in Business; agent self-approval; false admin enforcement UI; production compose publishes data-plane ports; Helm Business chart without NetworkPolicy without owner waiver; claiming dual deploy support without O-D.16 and O-K.18.

---

# 15. Open owner questions

1. Managed mail provider for GA?
2. Jitsi self-host vs JaaS?
3. ED.0 single-active vs realtime collab?
4. CalDAV in or out?
5. Multi-org self-host in v1 GA?
6. Meet recording in v1?
7. Compose vs Helm as **primary** support SKU, or dual-equal GA (O-X.6)?
8. In-cluster Jitsi vs external-only for GA?
9. Observability required in compose GA or external-only OK?

---

# 16. Appendix — old plan ID map

| Old                   | New                                                |
| --------------------- | -------------------------------------------------- |
| 0.x                   | G0.*                                               |
| 1.x                   | G1.*                                               |
| M1–M7                 | M1–M7 (+M8–M14)                                    |
| D1–D7                 | D1–D7 (+D8–D12)                                    |
| C1–C6                 | C1–C6 (+C7–C9)                                     |
| A1–A7                 | A1–A7 (+A8–A12)                                    |
| O1–O6                 | O1–O6 (+O7–O9) + **O-D.*** + **O-K.*** + **O-X.*** |
| V1–V6                 | V1–V6 (+V7–V8)                                     |
| R*                    | R*                                                 |
| Shell resilience plan | UX.1–UX.16                                         |

---

# 17. Appendix — evidence layout

```text
artifacts/release-readiness/<YYYY-MM-DD>/<git-sha>/
  deploy/
    compose/          # O-D.* evidence (matrix, ports, digests, migrate, drills)
    helm/             # O-K.* evidence (template CI, install/upgrade/rollback, restore)
    cross/            # O-X.* parity, SBOM, air-gap, O-X.5/6 decisions
  ...
```

Bind workspace + editors SHAs and image digests per `docs/final-release-readiness.md`.
R3 must include compose and/or helm packs per **O-X.6**.

---

# 18. Appendix — packaging modes

| Mode  | Apps                                        | Deploy                                                                                    |
| ----- | ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| MVP   | mail,drive,chat,assistant (+admin)          | Compose and/or Helm with MVP flags                                                        |
| v1 GA | +calendar,meet,docs,sheets,slides after PKG | **Both** Compose production and Helm fully scoped (O-D + O-K); enable apps only with deps |
| SaaS  | multi-tenant after S+                       | Helm-first typical; compose optional                                                      |

---

_End of checkbox execution bible._
