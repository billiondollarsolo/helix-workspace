# Helix Elite MVP — Enterprise Production Plan (No Native File Editing)

> **Status:** Active execution bible. **Engineering productionization advanced on `origin/main`
> (2026-08-03, tip `cd3d537`)** — unit/packaging/agent/mail/chat/search residuals closed with
> shipped tests. **Final production GO not claimed:** live E11 packet + calendar dogfood/pilot
> (E12) remain residual-owned per `docs/architecture/mvp-r3-structural-decision.md`.
>
> **Date:** 2026-08-03

> **Product boundary:** Mail · Drive (files + previews) · Chat · Assistant/agents · Admin · Shell · Search  
> **Deploy:** Single-organization self-host first (Business tier pilot, 5–50 users).  
> **Supersedes for this track:** `2026-07-28-core-workspace-production-readiness.md` (keep as historical
> reasoning) and shell-resilience notes in `2026-08-01-shell-resilience-and-data-loss-guards.md`.  
> **Does not replace:** `2026-08-02-helix-full-workspace-v1-release.md` for Calendar/Meet/Editors —
> that train stays **deferred** until this MVP plan reaches R3 GO.  
> **How to execute:** One Task ID per PR; tick every Step; run Validation; store Evidence; never skip
> Depends on; never enable Full Workspace packaging as a shortcut.

---

## 0. How to use this document

1. **Pick the next ready Task** whose Depends on are complete and whose phase Entry is satisfied.
2. **Read** `AGENTS.md`, the listed **Likely files**, and nearby tests **before** editing.
3. **Prefer failing tests first** against shipped entry points (no reimplemented policy in tests).
4. **Tick Steps** only when true; run **Validation commands**; satisfy **Acceptance**.
5. **Store Evidence** under `artifacts/release-readiness/<YYYY-MM-DD>/<git-sha>/E*/` (CI artifact;
   do not commit secrets or customer data).
6. **PR rules:** one Task ID (or tightly coupled pair) per PR; conventional commit
   `feat|fix|test|docs|chore(<area>): … [E#.#]`; merge to `origin/main` before claiming phase exit.
7. **Fail closed:** no silent no-ops, no fake “enforced” admin UI, no no-op malware scanner on
   Business, no agent write without confirmation or bounded automation, no editors in MVP packaging.
8. **Goal harness:** A goal may claim completion only when the Verification appendix for the chosen
   phase(s) is green **and** commits are ancestors of `origin/main`.

### 0.1 ID namespaces

| Prefix  | Domain                                                       |
| ------- | ------------------------------------------------------------ |
| **E0**  | Governance, inventory, baseline, product claims              |
| **E1**  | Shared security, tenancy, packaging fail-closed              |
| **E2**  | Shell, navigation, a11y, resilience, UX crispness            |
| **E3**  | Mail (API + UI + ops)                                        |
| **E4**  | Drive files (storage, preview, share, scan) — **no editors** |
| **E5**  | Chat                                                         |
| **E6**  | Assistant / agents / tool surfaces                           |
| **E7**  | Admin + identity (honest SSO)                                |
| **E8**  | Search                                                       |
| **E9**  | Cross-surface API parity (REST / MCP / OpenAPI / tRPC / CLI) |
| **E10** | Ops: Compose, Helm, secrets, backup/restore, observability   |
| **E11** | Live evidence gates + security validation                    |
| **E12** | Dogfood, pilot, R3 go/no-go                                  |
| **EX**  | Explicit non-goals / deferred Full Workspace                 |

### 0.2 Quality bar (“crispy clean”)

Every in-scope surface must satisfy **all** of:

| Layer           | Bar                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| **API**         | Zod contracts; authZ + org_id; idempotency where retries exist; actionable errors; no 500s for expected denials |
| **Policy**      | Fail-closed; cross-tenant negatives; agent writes gated; files unavailable until clean scan (Business)          |
| **UI**          | Semantic HTML; labelled forms; visible focus; keyboard paths; empty/error/loading states; no dead controls      |
| **UX**          | URL state for shareable views; optimistic where safe; offline honesty; reduced-motion; mobile web usable        |
| **Integration** | Tool → UI → API same semantics; admin control that claims enforcement **does** enforce                          |
| **Evidence**    | Unit/integration + focused e2e where user-visible; live gate when gate is E11                                   |
| **Docs**        | Operator runbook + accurate marketing claim; non-claims explicit                                                |

---

## 1. Purpose

Helix already has deep real implementations for Mail, Drive, Chat, Assistant, Admin, Search, and
agent tool governance (including A10 emergency kill self-unlock and A12 pending-approvals). The
remaining program is **not** greenfield product invention. It is an **elite productionization and
product-completion** program that must:

1. Close residual functional, security, and honesty gaps on the **MVP surfaces only**.
2. Make every operator- and user-visible path **crisp**: no silent no-ops, no stub buttons that look
   live, no “enforced” labels without runtime enforcement.
3. Prove behavior against **real services** and digest-bound images for the final release packet.
4. Constrain agents so untrusted workspace content cannot silently cause visible mutations.
5. Produce an auditable path from **internal dogfood → private pilot → signed production decision**.

This document is implementation-oriented. Line numbers and migration numbers may drift; agents must
re-read target files at execution time.

---

## 2. Product claim and non-claims

### 2.1 Claim (only after E12 / R3 GO)

> A self-hostable workspace for **web email**, **shared file storage with previews**,
> **authenticated organization chat**, **admin operations**, and **confirmation-gated AI/agent
> workflows**.

### 2.2 Qualifications (must appear in admin guide + marketing)

| Topic              | Qualification                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Mail               | Managed outbound provider (SES / Postmark / Mailgun / managed SMTP). Not direct-to-MX.         |
| Mail clients       | Web + REST/MCP/CLI. **No Helix-hosted IMAP.**                                                  |
| Chat               | TLS + org/room ACL + audited admin access. **Not end-to-end encrypted.**                       |
| Drive              | Files, folders, versions, shares, previews, WebDAV. **No native Docs/Sheets/Slides editing.**  |
| Agents             | Reads when authorized; **writes require human confirmation** unless bounded automation policy. |
| Identity           | Single organization pilot (Business). Public multi-tenant SaaS deferred.                       |
| Recovery           | RPO ≤ 24h, RTO ≤ 4h, 99.5% monthly **objective** (not contractual SLA).                        |
| Encryption at rest | Depends on documented volume/KMS/object SSE deployment attestation.                            |

### 2.3 Non-claims (must not be implied by UI or docs)

- Gmail-class global deliverability guarantees
- Signal-style E2EE chat
- SOC 2 / HIPAA / FedRAMP / ISO certificates solely from scaffolding
- Unattended agents with unrestricted workspace scopes
- Public multi-tenant SaaS readiness
- Native Office collaborative editing
- Helix IMAP / direct-to-MX outbound
- Multi-region active-active HA

### 2.4 Positioning (honest market frame)

Without file editing, Helix is **not** “full Google Workspace.” It is:

> **Self-hosted org productivity: Gmail-like mail + Drive-as-files + Chat + Admin + safe agents.**

Credibility comes from **mail you trust, files you control, chat people use, admin operators accept,
and agents that ask before they act** — not from checkbox parity with Calendar/Meet/Docs.

---

## 3. Normative decisions (do not weaken)

Preserve ADRs and RD-1…RD-7:

| ID       | Decision                                                          | ADR / source                 |
| -------- | ----------------------------------------------------------------- | ---------------------------- |
| RD-1     | Single-org Business pilot 5–50 users; tenant-safe internals       | ADR-0001                     |
| RD-2     | Managed outbound mail provider only                               | ADR-0002                     |
| RD-3     | Web/API mail clients; no IMAP for pilot                           | ADR-0003                     |
| RD-4     | Server-readable org chat; not E2EE                                | ADR-0004                     |
| RD-5     | Agent writes confirmation-gated; narrow automation allowlist only | ADR-0005                     |
| RD-6     | 99.5% / RPO 24h / RTO 4h pilot objectives                         | ADR-0006                     |
| RD-7     | Untrusted uploads fail-closed until real malware clean            | ADR-0007                     |
| RD-MVP-1 | **Editors off** in production MVP packaging; previews only        | This plan + packaging matrix |
| RD-MVP-2 | **Calendar/Meet off** until Full Workspace train after R3         | ADR-0008/0009 deferred       |
| RD-MVP-3 | Public SaaS only after R3 + S+                                    | ADR-0012                     |
| RD-MVP-4 | Mobile **web** required; native apps out                          | ADR-0013                     |

If a task would weaken an RD, **stop** and open an ADR amendment; do not “temporarily” disable.

---

## 4. Scope matrix

| Surface                        | In elite MVP | Notes                                                               |
| ------------------------------ | ------------ | ------------------------------------------------------------------- |
| Mail                           | **Yes**      | Full productionization                                              |
| Drive (files)                  | **Yes**      | Storage, ACL, share links, versions, previews, WebDAV, scan         |
| Chat                           | **Yes**      | Rooms/DMs, realtime, retention, export                              |
| Assistant / agents             | **Yes**      | Orchestrator, tools, MCP, pending approvals, kill, cost limits      |
| Admin                          | **Yes**      | Users, domains/DNS, policies, mail/drive/chat admin, agent controls |
| Shell / search / notifications | **Yes**      | Cohesion chrome                                                     |
| Open / media preview           | **Yes**      | Preview/download only; no native edit import in MVP                 |
| Calendar                       | **No**       | Deferred EX.*                                                       |
| Meet                           | **No**       | Deferred EX.*                                                       |
| Docs / Sheets / Slides         | **No**       | Deferred EX.*; packaging fail-closed                                |
| PDF editor                     | **No**       | Preview only                                                        |
| Public SaaS                    | **No**       | After R3                                                            |

---

## 5. Current-state snapshot (2026-08-03)

Refresh under E0.1 if more than ~2 weeks old.

| Area                 | Honest state                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------- |
| Packaging            | MVP fail-closed on `main` (`HELIX_APPS`, `VITE_HELIX_MVP_ONLY`, editors migrations false)   |
| A10 kill             | Self-unlock for `admin.agent_controls.set` **merged** (PR #11); pure + registry tests green |
| A12 approvals        | Pending-approvals UI + unit tests present; **Playwright does not click Approve/Deny**       |
| Mail/Drive/Chat      | Deep code + unit suites; **live evidence files missing** from final packet                  |
| Drive ClamAV         | Real client exists; Business must **inject + prove** non-no-op scanner                      |
| SSO/SAML             | Admin UI can store config; **runtime ACS incomplete** — must hide or ship                   |
| E2E Playwright       | Mostly **smoke** for mail/drive/chat/assistant — not elite depth                            |
| Final release        | Structural R3 with `allowMissingLive`; **not** final GO                                     |
| Full Workspace bible | Exists; **do not execute CAL/MT/ED** under this plan                                        |

Key paths:

- Backend: `apps/helix/src/platform/{mail,drive,chat,assistant,admin,search,tools,ai,auth}/`
- API: `apps/helix/src/api/{mcp,openapi,trpc,asyncapi,scopes,actor}.ts`
- Web: `apps/web/src/features/{mail,drive,chat,assistant,admin,search}/`, `components/shell/`
- Packaging: `apps/helix/src/config/workspace-packaging.ts`, `apps/web/src/packaging/`
- Ops: `docker-compose.production.yml`, `infra/helm/helix/`, `infra/scripts/*`, `docs/final-release-readiness.md`

---

## 6. Trust-boundary rules (invariant)

1. Resolve **tenant before** feature logic; actor `orgId` must match tenant.
2. Every org-scoped query includes `org_id` **and** authorization.
3. Secure session cookies; **no tokens in URLs**, query strings, logs, or error bodies.
4. Retrieved workspace content is **untrusted data**, never authority to change tool policy.
5. Agent **non-read** tools: confirmation or matched automation policy — never self-approval.
6. Business files **unavailable** until integrity + real malware clean (RD-7).
7. Production **data-plane ports** not published on the public host network.
8. A control is “enabled” only when **enforcement path + test + (for gates) live evidence** exist.
9. MVP packaging never silently enables editors/calendar/meet.
10. Admin UI: **enforce or hide** — never decorative “Protected” without runtime.

---

## 7. Success criteria (program exit)

### 7.1 Functional

- [ ] Users send/receive Internet mail via configured provider/domain.
- [ ] Drafts, undo-send, bounces, complaints, suppression, labels, filters behave deterministically.
- [ ] Users upload/organize/version/share/download/WebDAV files; previews work for common types.
- [ ] Quarantined/malware files cannot download/preview/share/attach/index/agent-read.
- [ ] Two users exchange realtime chat; reconnect after restart without silent loss.
- [ ] Assistant can read allowed context; writes queue for human approve/deny.
- [ ] Admin can manage users, domains/DNS, agent kill, cost limits, audit export.
- [ ] Unified search returns mail + chat + drive hits for authorized actor only.

### 7.2 Security

- [ ] Zero open Critical/High in launch scope.
- [ ] Production boot rejects dev secrets / illegal `HELIX_APPS` / no-op Business scanner.
- [ ] Cross-tenant negatives for Mail, Drive, Chat, Search, MCP, pending actions.
- [ ] Every agent tool attempt has an audit outcome (no secret/body leakage).
- [ ] Kill + clear kill works without process restart (A10 self-unlock regression suite green).

### 7.3 Reliability / performance (pilot load)

- [ ] Availability objective 99.5% measured over soak window.
- [ ] API p95 ≤ 500 ms ordinary reads; ≤ 750 ms ordinary metadata writes.
- [ ] Chat accepted→visible p95 ≤ 2 s.
- [ ] Mail provider acceptance p95 ≤ 60 s after undo window.
- [ ] 1 GiB Drive upload does not require 1 GiB app-process buffer for scan.
- [ ] Restore drill RPO ≤ 24h, RTO ≤ 4h.

### 7.4 UX / enterprise polish

- [ ] No active control that does nothing.
- [ ] Empty, loading, error, offline, and permission-denied states are intentional and actionable.
- [ ] Mobile web usable for mail/chat/drive list+detail+compose/send.
- [ ] A11y: keyboard paths, focus, labels; focused audit green on MVP route list.
- [ ] Playwright **depth** (not only smoke) on critical paths listed in E2/E3–E7.

### 7.5 Evidence

Machine-readable packet under `artifacts/release-readiness/<date>/<sha>/` satisfying
`docs/final-release-readiness.md` final mode (or explicit conditional GO with owned expiry).

---

## 8. Agent implementation rules

1. Read `AGENTS.md` + target files; preserve unrelated work.
2. Same branch name in `helix-editors` **only if** that repo must change (prefer not for this plan).
3. Never hand-edit `apps/web/src/routeTree.gen.ts` or commit build output/secrets.
4. New external shapes → Zod in `@helix/contracts`.
5. New org queries → explicit `org_id` + cross-tenant negative test.
6. Mutations → authZ, idempotency where needed, audit, failure-path test.
7. Prefer files near ≤400 lines; split god-files rather than endless append.
8. Do not “finish” security with docs-only or UI labels.
9. Do not enable no-op security adapters in production profiles.
10. Conventional commits; narrow tests while iterating; phase-boundary full gates.
11. UI: hide or disable-with-reason; never ship broken “Save” that no-ops.
12. Product copy must match RD non-claims (no IMAP badge, no E2EE claim, no Edit Doc in MVP).

---

## 9. Dependency DAG

```text
E0 Governance / baseline
  └─► E1 Shared security + packaging
        ├─► E2 Shell / UX (∥ with domains after E1)
        ├─► E3 Mail  ─────────┐
        ├─► E4 Drive ─────────┼─► E6 Agents (needs side-effect contracts from E3–E5)
        ├─► E5 Chat  ─────────┘
        ├─► E7 Admin / identity (∥ E3 mail domains; honest SSO)
        ├─► E8 Search (after E3–E5 indexers stable)
        └─► E9 API parity (after E3–E6 tools stable)
              └─► E10 Ops (Compose + Helm + backup)
                    └─► E11 Live evidence + DAST + soak
                          └─► E12 Dogfood → pilot → R3
EX.* deferred forever under this plan (Calendar/Meet/Editors/SaaS)
```

**Parallelism:** After E1, E2/E3/E4/E5/E7 may proceed in parallel with integration contracts frozen.
E6 waits for write side-effects and classification rules from E3–E5. E11 waits for E10 deploy path.

---

## 10. Evidence layout

```text
artifacts/release-readiness/<YYYY-MM-DD>/<git-sha>/
  binding.json                 # workspaceSha, editorsSha, image digests
  E0/ … E12/
  mail-live-evidence.json      # M7 / E11.M
  drive-live-evidence.json     # D7 / E11.D
  chat-live-evidence.json      # C6 / E11.C
  agent-live-evidence.json     # A7 / E11.A
  data-plane-live-evidence.json
  restore-drill-evidence.json
  failure-recovery-evidence.json
  dast-evidence.json
  full-gates.json
  r3-go-no-go.json
```

Bind every live run to image digests per `docs/final-release-readiness.md`.

---

# Phase E0 — Governance, inventory, claims honesty

**Entry:** Owner accepts this plan as the MVP elite track.  
**Exit:** E0.V complete; product claims doc published; clean baseline SHA recorded.

---

## Task E0.1 — Refresh MVP surface inventory against `main`

**Reasoning:** Agents re-enable half-built apps without a written inventory. Packaging truth must
match code on current `main`.

**Depends on:** —

**Likely files:**

- `docs/architecture/v1-surface-inventory.md`
- `apps/web/src/components/apps.ts`
- `apps/web/src/packaging/mvp-packaging.ts`
- `apps/helix/src/config/workspace-packaging.ts`
- `apps/helix/src/config/production-assertions.ts`
- `AGENTS.md`

**Steps:**

- [ ] Checkout clean `origin/main`; record SHA.
- [ ] Re-walk launcher apps, web features, platform modules; mark code-exists | partial | stub.
- [ ] Confirm MVP allowlist exact string and Full Workspace remain gated.
- [ ] Update `v1-surface-inventory.md` Gap owner column for residual elite-MVP items (link Task IDs).
- [ ] List every admin section: live | hide | incomplete-with-banner.
- [ ] PR docs-only if inventory drifts.

**Tests:**

- [ ] Existing packaging unit tests still pass (`mvp-packaging`, `production-assertions`).

**Validation commands:**

```sh
pnpm --filter @helix/app exec vitest run src/config
pnpm --filter @helix/web exec vitest run src/packaging src/components/mvp-boundary
```

**Acceptance:** Inventory SHA-dated; no surface claimed “GA” without Task ID ownership.

**Evidence:** `E0/inventory.md` + SHA.

---

## Task E0.2 — Product claims & non-claims publication

**Reasoning:** Enterprise buyers and pilots fail on overclaim. Claims must be one page, linked from
README and admin guide.

**Depends on:** E0.1

**Likely files:**

- `docs/admin-guide.md`
- `README.md`
- `docs/architecture/adr-0001-*.md` … `adr-0007-*.md`
- create: `docs/product-claims-mvp.md`

**Steps:**

- [ ] Write `docs/product-claims-mvp.md` with §2 claim, qualifications, non-claims.
- [ ] Grep UI/docs for IMAP, E2EE, “edit document”, SOC2 certified language; fix or qualify.
- [ ] Ensure Mail settings never imply Helix IMAP.
- [ ] Ensure Drive open path never offers “Edit in Docs” under MVP flag.
- [ ] Link claims from README “What Helix is / is not”.

**Tests:**

- [ ] Grep CI or unit test that MVP packaging build excludes editor route modules (existing).
- [ ] Snapshot or string test for forbidden marketing phrases in help copy if centralized.

**Validation:**

```sh
rg -n "IMAP|end-to-end encrypted|SOC 2 certified|edit in Docs" apps/web/src docs --glob '!**/node_modules/**' | head
```

**Acceptance:** Zero unqualified forbidden claims in MVP UI strings; claims doc merged.

**Evidence:** `E0/product-claims.md`.

---

## Task E0.3 — Baseline gates on clean main

**Reasoning:** Elite work must start from a green, reproducible baseline.

**Depends on:** E0.1

**Likely files:** root `package.json`, turbo config.

**Steps:**

- [ ] `git status` clean on `main` matching `origin/main`.
- [ ] Run format, typecheck, lint, test, build, editors-boundaries.
- [ ] Capture logs under evidence (not commit logs with secrets).

**Validation:**

```sh
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm quality:editors-boundaries:test && pnpm quality:editors-boundaries
```

**Acceptance:** All exit 0 on recorded SHA.

**Evidence:** `E0/baseline-gates.log`.

---

## Task E0.V — Phase E0 exit

**Depends on:** E0.1, E0.2, E0.3

**Steps:**

- [ ] Checklist: inventory, claims, baseline green, DAG still accurate.
- [ ] Open umbrella tracking issue or note in plan appendix with SHA.

**Acceptance:** Phase E1 may start.

---

# Phase E1 — Shared security & packaging fail-closed

**Entry:** E0.V  
**Exit:** Production boot cannot lie about MVP mode, secrets, scanner, or agent kill env.

---

## Task E1.1 — Production assertions completeness audit

**Reasoning:** Production must refuse illegal config at boot, not at first user complaint.

**Depends on:** E0.V

**Likely files:**

- `apps/helix/src/config/production-assertions.ts`
- `apps/helix/src/config/workspace-packaging.ts`
- `apps/helix/src/config/*.test.ts`

**Steps:**

- [ ] Enumerate every production assertion; map to test case.
- [ ] Add missing negatives: wrong `HELIX_APPS`, missing disabled modules, editors migrations true,
      global secrets defaults, data-plane publish flags if asserted.
- [ ] Ensure error messages are operator-actionable (what to set).

**Tests:**

- [ ] Table-driven unit tests for each illegal combo → throw/reject.
- [ ] Legal MVP config accepts.

**Validation:**

```sh
pnpm --filter @helix/app exec vitest run src/config
```

**Acceptance:** 100% of documented illegal combos covered by tests.

**Evidence:** `E1/production-assertions.log`.

---

## Task E1.2 — Request tenant identity on all mutating paths

**Reasoning:** Tenant mismatch is the classic multi-tenant/self-host footgun; G1 work may be partial.

**Depends on:** E1.1

**Likely files:**

- `apps/helix/src/platform/tenancy/`
- `apps/helix/src/server.ts`
- API route registration
- `apps/helix/src/platform/security/`

**Steps:**

- [ ] Inventory HTTP/WS/MCP/tRPC entrypoints; ensure tenant resolution middleware runs first.
- [ ] Negative tests: actor.orgId ≠ tenant → 403.
- [ ] Fix any path that uses “default org” without explicit resolution for multi-mailbox edge cases
      (mail inbound still may pin receiving domain → org).

**Tests:**

- [ ] Integration negatives per channel (REST sample, MCP sample, WS chat frame).

**Acceptance:** No mutating entrypoint without tenant+actor check; tests green.

**Evidence:** `E1/tenant-identity.log`.

---

## Task E1.3 — Web MVP packaging e2e hard guarantees

**Reasoning:** Unit packaging tests pass; elite needs browser-level proof of rail + redirects.

**Depends on:** E1.1

**Likely files:**

- `apps/web/tests/e2e/`
- `apps/web/src/packaging/`
- `apps/web/src/components/apps.ts`

**Steps:**

- [ ] Playwright: with MVP build, launcher shows only mail, drive, chat, assistant, admin.
- [ ] Deep-link `/docs`, `/sheets`, `/slides`, `/calendar`, `/meet` → redirect or 404 per product rule.
- [ ] Bundle boundary still fails build if editor packages imported in MVP graph.

**Tests:**

- [ ] New e2e `mvp-packaging.spec.ts`.
- [ ] Existing `mvp-packaging.test.ts` remains green.

**Acceptance:** e2e green in CI job that builds with `VITE_HELIX_MVP_ONLY=true`.

**Evidence:** `E1/mvp-packaging-e2e.log`.

---

## Task E1.4 — Audit completeness contract for tool invocations

**Reasoning:** Enterprise forensics require every tool attempt → outcome audit without content leak.

**Depends on:** E1.2

**Likely files:**

- `apps/helix/src/platform/tool-registry.ts`
- `apps/helix/src/platform/audit*`
- `apps/helix/src/platform/tools/`

**Steps:**

- [ ] Ensure registry `completeInvocation` always audits success, deny, fail, pending.
- [ ] Redact secrets, bodies, tokens from audit payloads.
- [ ] Test: denied operational control, confirmation queue, handler throw all audited.

**Acceptance:** Property-style or exhaustive status tests pass; sample audit rows redacted.

**Evidence:** `E1/tool-audit.log`.

---

## Task E1.V — Phase E1 exit

**Depends on:** E1.1–E1.4

**Validation:** config + tenancy + packaging e2e + audit suites exit 0; merged to main.

---

# Phase E2 — Shell, UX crispness, a11y, resilience

**Entry:** E1.V (E2.1 may start after E1.1)  
**Exit:** Shell is elite daily-driver chrome for MVP apps only.

---

## Task E2.1 — Shell information architecture & dead chrome removal

**Reasoning:** Side panels and settings stubs destroy enterprise trust.

**Depends on:** E1.1

**Likely files:**

- `apps/web/src/components/shell/`
- `apps/web/src/components/shell/side-panel.tsx`
- `apps/web/src/components/shell/settings-page.tsx`

**Steps:**

- [ ] Confirm MVP hides side mini-panels entirely.
- [ ] Settings: every control either works or is hidden/disabled with specific reason string.
- [ ] Remove or gate any “being rebuilt” placeholders on MVP routes.
- [ ] Command palette: only MVP actions; disabled items show reason.

**Tests:**

- [ ] Unit tests for palette filtering under MVP flag.
- [ ] Settings page test: no enabled control without handler.

**Acceptance:** Manual walkthrough checklist in evidence; zero dead enabled buttons on shell.

**Evidence:** `E2/shell-ia.md` + screenshots optional.

---

## Task E2.2 — Network, offline, unsaved changes

**Reasoning:** Data-loss and silent offline are deal-breakers for mail/chat.

**Depends on:** E2.1

**Likely files:**

- `apps/web/src/components/shell/network-status.tsx`
- `apps/web/src/lib/use-unsaved-changes-warning.tsx`
- mail compose recovery modules
- chat offline notices

**Steps:**

- [ ] Offline banner polite live region; reconnect refresh policy documented.
- [ ] Unsaved compose / chat draft / admin forms use shared warning where appropriate.
- [ ] Mail compose recovery conflict UI verified.
- [ ] Chat does not show fake rooms when offline.

**Tests:**

- [ ] Existing unit tests + add missing offline transitions.
- [ ] Playwright: toggle offline (where feasible) shows banner.

**Acceptance:** Documented behavior matrix per app for offline.

**Evidence:** `E2/offline-matrix.md`.

---

## Task E2.3 — Accessibility MVP route matrix

**Reasoning:** Enterprise procurement often requires a11y diligence; keep matrix honest.

**Depends on:** E2.1

**Likely files:**

- `apps/web/quality-gates.routes.json`
- `apps/web/scripts/accessibility-audit.mjs`
- `docs/accessibility.md`

**Steps:**

- [ ] Trim a11y route list to **MVP-only** paths (drop Docs/Calendar/Meet unless full profile).
- [ ] Fix critical axe issues on mail, drive, chat, assistant, admin overview, login.
- [ ] Keyboard: rail, main skip link, dialogs, compose, share dialog, approvals panel.

**Validation:**

```sh
pnpm --filter @helix/web exec node scripts/accessibility-audit.mjs
```

**Acceptance:** No Critical axe on MVP list; skip-link works; focus visible.

**Evidence:** `E2/a11y-report.json`.

---

## Task E2.4 — Mobile web usability pass

**Reasoning:** ADR-0013: mobile web required; native out.

**Depends on:** E2.1

**Likely files:**

- shell layout, mail/chat/drive shells
- `apps/web/tests/e2e/mobile-shell-layout.spec.ts`

**Steps:**

- [ ] Define breakpoints; ensure list/detail patterns usable at 390px width.
- [ ] Compose, send, open thread, open file preview, send chat message on mobile viewport.
- [ ] Expand Playwright mobile specs beyond rail-only.

**Acceptance:** Checklist signed in evidence; e2e green on mobile project.

**Evidence:** `E2/mobile-checklist.md`.

---

## Task E2.5 — Playwright depth harness for shell

**Reasoning:** Elite requires more than unit chrome tests.

**Depends on:** E2.2, E2.3

**Steps:**

- [ ] e2e: command palette open/search/navigate.
- [ ] e2e: notifications open/mark-read if API available in test env.
- [ ] e2e: deep-link mail folder + drive folder + chat room preserves URL state.

**Acceptance:** Specs stable in CI (retries only for known flake with ticket).

**Evidence:** `E2/shell-e2e.log`.

---

## Task E2.V — Phase E2 exit

**Depends on:** E2.1–E2.5

**Acceptance:** Shell UX bar from §0.2 met for chrome; merged.

---

# Phase E3 — Mail (enterprise communication core)

**Entry:** E1.V  
**Exit:** Mail is pilot-credible: provider path, DNS admin, bounce/complaint, UI depth, negatives.

---

## Task E3.1 — Outbound provider production path audit

**Reasoning:** RD-2: managed provider is the delivery plane.

**Depends on:** E1.V

**Likely files:**

- `apps/helix/src/platform/mail/providers.ts`
- `apps/helix/src/platform/mail/outbound.ts`
- `apps/helix/src/platform/mail/admin-routes.ts`
- web `features/admin/mail-admin.tsx`

**Steps:**

- [ ] Verify SES/Postmark/Mailgun/SMTP adapters: config validation, secrets, error mapping.
- [ ] Queue, undo-send window, retry, dead-letter behavior documented + tested.
- [ ] Per-org provider resolution (not only default org) for pilot multi-domain if applicable.
- [ ] Admin UI shows provider health without leaking secrets.

**Tests:**

- [ ] Unit provider mocks; integration outbound queue.
- [ ] Negative: missing provider config → clear error.

**Acceptance:** At least one provider path fully tested; others schema-validated.

**Evidence:** `E3/outbound-providers.md`.

---

## Task E3.2 — Inbound SMTP, auth, spam, AV

**Reasoning:** Inbound without authn/spam/AV is an abuse magnet.

**Depends on:** E3.1

**Likely files:**

- `apps/helix/src/platform/mail/ingest.ts`
- quarantine, SpamAssassin, ClamAV mail paths
- receiving domain ownership

**Steps:**

- [ ] SPF/DKIM/DMARC evaluation paths tested.
- [ ] Malware/spam quarantine UX + admin release/delete audited.
- [ ] Recipient → org resolution; unauthorized relay denied.
- [ ] Rate limits and size limits enforced with 4xx.

**Tests:**

- [ ] smtp-receiver + quarantine + negative-security suites expanded as needed.

**Acceptance:** Unauthorized/malicious inbound cannot land in user inbox as clean.

**Evidence:** `E3/inbound-security.log`.

---

## Task E3.3 — Bounce, complaint, suppression webhooks

**Reasoning:** Deliverability ops without feedback loops is flying blind.

**Depends on:** E3.1

**Likely files:**

- mail provider webhook handlers
- suppression store
- runbooks `docs/runbooks/mail-bounce-complaint-spike.md`

**Steps:**

- [ ] HMAC/signature verify fail-closed.
- [ ] Bounce/complaint update suppression; future sends blocked with reason.
- [ ] Admin visibility of suppressions; audit trail.
- [ ] Runbook steps match real API paths.

**Tests:**

- [ ] Webhook unit tests with valid/invalid signatures.
- [ ] Send to suppressed address denied.

**Acceptance:** End-to-end test with fixture webhooks green.

**Evidence:** `E3/feedback-loops.log`.

---

## Task E3.4 — Domain / DNS admin excellence

**Reasoning:** Operators live or die on MX/SPF/DKIM/DMARC clarity.

**Depends on:** E3.1

**Likely files:**

- `apps/helix/src/platform/admin/` domains
- `apps/web/src/features/admin/sections/domains.tsx`
- DNS verify against real DNS (existing feat)

**Steps:**

- [ ] Each DNS record row: expected value, observed value, pass/fail, copy button, next action.
- [ ] No false green checks.
- [ ] Domain verify e2e remains green; extend for DKIM selector mistakes.

**Tests:**

- [ ] API contract tests + Playwright domains capabilities.

**Acceptance:** New admin can verify a domain using UI alone (dogfood script).

**Evidence:** `E3/dns-admin.md`.

---

## Task E3.5 — Mail web UI depth (compose, lists, recovery)

**Reasoning:** Unit shells are strong; e2e is smoke-only — elite needs depth.

**Depends on:** E2.V (or E2.1+E2.2), E3.1

**Likely files:**

- `apps/web/src/features/mail/*`
- `apps/web/tests/e2e/mail-feature.spec.ts`

**Steps:**

- [ ] Playwright: compose, save draft, send (or mock provider), undo if configured.
- [ ] Reply/forward; folder/label navigation; search query in URL.
- [ ] Attachment add/remove; error toasts actionable.
- [ ] Empty inbox and permission errors are polished.
- [ ] Keyboard: focus list → thread → compose.

**Acceptance:** Depth e2e green; no console errors on happy path.

**Evidence:** `E3/mail-ui-e2e.log`.

---

## Task E3.6 — Mail tools & agent surface honesty

**Reasoning:** Agents must use same policy as humans for mail.send etc.

**Depends on:** E3.1, E1.4

**Likely files:**

- mail tools registration
- policy firewall
- confirmation requirements

**Steps:**

- [ ] Inventory all `mail.*` tools: permission, sideEffects, confirmation.
- [ ] Agent `mail.send` → pending confirmation by default.
- [ ] Negative: agent cannot send to suppressed or external without scopes.

**Tests:**

- [ ] Tool-registry + policy tests for mail tools matrix.

**Acceptance:** Matrix doc in evidence; all tools tested for deny paths.

**Evidence:** `E3/mail-tools-matrix.md`.

---

## Task E3.7 — Mail search projection

**Reasoning:** ILIKE-only search is not enterprise; Meilisearch projection must be the product path.

**Depends on:** E3.2, E8.1 (may land stubs first)

**Likely files:**

- `apps/helix/src/platform/mail/search/`
- web mail search UI

**Steps:**

- [ ] Index on ingest/outbound finalize; reindex job.
- [ ] UI search uses same API as global search filters for mail type.
- [ ] AuthZ: no hits from other mailboxes.

**Tests:**

- [ ] Indexer unit + authZ search negatives.

**Acceptance:** Search returns known seeded messages only for owner.

**Evidence:** `E3/mail-search.log`.

---

## Task E3.V — Phase E3 exit

**Depends on:** E3.1–E3.7

**Validation:** mail unit/integration + UI e2e depth; runbooks linked; claims still honest.

---

# Phase E4 — Drive files (no editors)

**Entry:** E1.V  
**Exit:** Drive is a trustworthy file system with previews, shares, and Business scan fail-closed.

---

## Task E4.1 — Upload, finalize, integrity, multipart

**Reasoning:** Integrity and size bounds are core trust.

**Depends on:** E1.V

**Likely files:**

- `apps/helix/src/platform/drive/` store, routes, tools
- presign + finalize

**Steps:**

- [ ] SHA-256 verify on finalize; mismatch quarantines/fails closed.
- [ ] Multipart large upload path; memory bound ≤ fixed buffer (not full object).
- [ ] Quotas enforced with clear errors.
- [ ] Versions immutable; restore creates new version.

**Tests:**

- [ ] store/integrity/multipart tests; 1 GiB memory-bound test if harness supports.

**Acceptance:** No path loads entire large object into Node heap for scan/finalize.

**Evidence:** `E4/integrity.log`.

---

## Task E4.2 — Business malware scanner injection (RD-7)

**Reasoning:** No-op scanner must not satisfy Business production.

**Depends on:** E4.1, E1.1

**Likely files:**

- `apps/helix/src/platform/drive/scanning.ts`
- `apps/helix/src/platform/security/scanning/`
- server boot wiring
- `assertDriveMalwareScannerReady`

**Steps:**

- [ ] Wire real ClamAV client in production Business compose/helm.
- [ ] Fail boot if Business + no-op scanner.
- [ ] Quarantine states: pending, clean, infected, error; UI badges.
- [ ] Agents cannot read quarantined objects (`agent-clean-reads` invariants).
- [ ] Admin retry/remove audited.

**Tests:**

- [ ] Unit disposition matrix; integration with mock clamd.
- [ ] Negative: download/share/preview denied for non-clean.

**Acceptance:** Production Business config refuses no-op; unit matrix complete.

**Evidence:** `E4/scanner-wiring.md`.

---

## Task E4.3 — Share links, ACLs, WebDAV

**Reasoning:** Sharing is the external trust boundary for files.

**Depends on:** E4.1, E4.2

**Likely files:**

- drive access/share/link tools
- WebDAV routes
- web share dialog

**Steps:**

- [ ] Internal ACL share + external link create/list/revoke with expiry.
- [ ] Revoke immediate effect.
- [ ] WebDAV auth via app password scopes; path traversal negatives.
- [ ] Multi-node lock strategy documented (DB/Redis not process-local) if multi-replica.

**Tests:**

- [ ] share-link + webdav-security + ACL negatives.

**Acceptance:** Revoked link 404/403; WebDAV cannot escape root.

**Evidence:** `E4/sharing.log`.

---

## Task E4.4 — Previews & open path (no edit)

**Reasoning:** Previews sell Drive without editors; edit CTAs destroy honesty.

**Depends on:** E4.1

**Likely files:**

- `apps/helix/src/platform/drive/preview.ts`
- `apps/web/src/routes/_shell/open/`
- `apps/web/src/features/_open/`
- MVP converter stubs

**Steps:**

- [ ] Office/PDF/image preview paths; fail soft with download fallback.
- [ ] MVP: “create editable copy” remains fail-closed with clear copy.
- [ ] No UI string promises native co-editing.
- [ ] Thumbnail generation errors don’t break listing.

**Tests:**

- [ ] Preview unit tests; Playwright open→preview for sample fixture types.
- [ ] MVP packaging: converter reject.

**Acceptance:** Preview works offline-of-editors; messaging honest.

**Evidence:** `E4/previews.log`.

---

## Task E4.5 — Drive web UI depth

**Reasoning:** e2e is list smoke only.

**Depends on:** E2.V, E4.3

**Likely files:**

- `apps/web/src/features/drive/*`
- e2e drive specs

**Steps:**

- [ ] Playwright: folder navigate, upload (or mocked finalize), star, trash, restore.
- [ ] Share dialog ACL + link revoke.
- [ ] Scope filters (my drive / shared) in URL.
- [ ] Empty folder & quota exceeded UI.

**Acceptance:** Depth e2e green.

**Evidence:** `E4/drive-ui-e2e.log`.

---

## Task E4.6 — Drive tools matrix for agents

**Depends on:** E4.2, E1.4

**Steps:**

- [ ] All `drive.*` tools: sideEffects, confirmation, clean-read gates.
- [ ] Agent cannot share or download non-clean.
- [ ] Destructive tools higher confirmation / admin scope as designed.

**Acceptance:** Matrix + tests.

**Evidence:** `E4/drive-tools-matrix.md`.

---

## Task E4.V — Phase E4 exit

**Depends on:** E4.1–E4.6

---

# Phase E5 — Chat

**Entry:** E1.V  
**Exit:** Chat is secure org chat with reliable realtime and compliance hooks.

---

## Task E5.1 — Authorization & tenant isolation

**Reasoning:** Chat leaks are catastrophic for enterprise trust.

**Depends on:** E1.2

**Likely files:**

- `apps/helix/src/platform/chat/`
- authorization tests

**Steps:**

- [ ] Room membership checks on list/send/history/search/WS subscribe.
- [ ] Cross-org and non-member negatives for every API.
- [ ] Export/legal hold admin-only.

**Tests:**

- [ ] Expand `authorization.test.ts` / `negative-security.test.ts` gaps.

**Acceptance:** No unauthorized read path; tests enumerate endpoints.

**Evidence:** `E5/authz-matrix.md`.

---

## Task E5.2 — Realtime reliability (WS + NATS)

**Reasoning:** Flaky chat kills adoption.

**Depends on:** E5.1

**Likely files:**

- `apps/helix/src/platform/chat/realtime.ts`
- NATS security
- web `use-chat-realtime.ts`

**Steps:**

- [ ] Auth on WS upgrade; origin policy; no bearer in query string.
- [ ] Reconnect backfill / cursor semantics documented + tested.
- [ ] Typing/presence rate limits.
- [ ] Dual-replica fan-out design notes for E11 live profile.

**Tests:**

- [ ] realtime unit/integration; client reconnect unit tests.

**Acceptance:** Restart simulation recovers messages within RTO of chat subsystem.

**Evidence:** `E5/realtime.md`.

---

## Task E5.3 — Attachments parity with Drive scan

**Reasoning:** Chat must not become malware bypass.

**Depends on:** E4.2, E5.1

**Steps:**

- [ ] Chat attachments stored as Drive objects or equivalent scan pipeline.
- [ ] Non-clean attachments never rendered/downloadable.
- [ ] Agent tools cannot fetch non-clean attachment bytes.

**Tests:**

- [ ] Integration attachment quarantine.

**Acceptance:** RD-7 holds for chat attachments.

**Evidence:** `E5/attachments-scan.log`.

---

## Task E5.4 — Retention, legal hold, export

**Reasoning:** Enterprise buyers ask for retention before E2EE.

**Depends on:** E5.1

**Likely files:**

- retention worker, compliance store
- admin chat section

**Steps:**

- [ ] Org retention policy applies; legal hold freezes delete.
- [ ] Export produces auditable archive for authorized admin.
- [ ] UI admin controls match enforcement.

**Tests:**

- [ ] store-compliance tests.

**Acceptance:** Hold prevents purge; export requires admin scope.

**Evidence:** `E5/compliance.log`.

---

## Task E5.5 — Chat web UI depth

**Depends on:** E2.V, E5.2

**Steps:**

- [ ] Playwright: create room/DM, send message, react, thread reply if exposed.
- [ ] Offline banner; reconnect.
- [ ] Member invite/remove permissions.

**Acceptance:** Depth e2e green.

**Evidence:** `E5/chat-ui-e2e.log`.

---

## Task E5.6 — Chat tools matrix for agents

**Depends on:** E5.1, E1.4

**Steps:**

- [ ] `chat.send` and mutations → confirmation for agents.
- [ ] Reads list/search authorized only.

**Acceptance:** Matrix + tests.

**Evidence:** `E5/chat-tools-matrix.md`.

---

## Task E5.V — Phase E5 exit

**Depends on:** E5.1–E5.6

---

# Phase E6 — Assistant, agents, tool governance

**Entry:** E1.4 + E3.6 + E4.6 + E5.6 (tool matrices)  
**Exit:** Agents are the safe differentiator: confirmations, kill, cost, injection resistance.

---

## Task E6.1 — Policy firewall completeness (RD-5)

**Reasoning:** Ordinary `write` tools must not bypass confirmation.

**Depends on:** E1.4

**Likely files:**

- `apps/helix/src/platform/tools/policy-firewall.ts`
- `tool-registry.ts`
- automation policy

**Steps:**

- [ ] Matrix: every non-read sideEffect for agents → queue-confirmation unless automation match.
- [ ] Automation policy: tool + resource bounds + expiry + rate; no credential-wide “never”.
- [ ] Self-modification of policy denied.
- [ ] Untrusted context blocks high-risk tools.

**Tests:**

- [ ] policy-firewall + v2-negative-security expanded.

**Acceptance:** No agent write path executes without pending or automation match.

**Evidence:** `E6/policy-matrix.md`.

---

## Task E6.2 — Pending approvals UX + e2e

**Reasoning:** A12 UI exists; Approve/Deny not e2e’d — enterprise must trust the loop.

**Depends on:** E6.1, E2.V

**Likely files:**

- `apps/web/src/features/assistant/pending-approvals.tsx`
- `tool-decisions.ts`
- assistant e2e

**Steps:**

- [ ] Approve executes once; Deny cancels; double-approve safe.
- [ ] Detail view shows tool, summary args (redacted), requester.
- [ ] Playwright clicks Approve and Deny with mock/live backend.
- [ ] Empty state and error state polished.

**Acceptance:** e2e approve path green; unit tests remain.

**Evidence:** `E6/approvals-e2e.log`.

---

## Task E6.3 — Emergency kill & cost limits operator path

**Reasoning:** A10 self-unlock fixed; operator UI + live path must be proven.

**Depends on:** E6.1

**Likely files:**

- `agent-operational-controls*.ts`
- `apps/web/src/features/admin/agent-controls.tsx`
- AI cost limits admin

**Steps:**

- [ ] Admin UI: engage kill, clear kill, org disable — all call live API.
- [ ] Component tests + Playwright for agent-controls section.
- [ ] Cost limit exceeded → 429 with clear UI.
- [ ] Regression: clear kill without restart (registry test stays).

**Acceptance:** Operator can kill and recover in UI; tests green.

**Evidence:** `E6/kill-cost.log`.

---

## Task E6.4 — Credential scopes, IP/hours, revocation

**Reasoning:** Agent credentials are enterprise IAM.

**Depends on:** E6.1

**Likely files:**

- credentials store, OAuth agent credentials
- admin agent-credentials UI

**Steps:**

- [ ] Enforce IP allowlist and hours if fields exist in policy.
- [ ] Revoke credential invalidates immediately across MCP/REST.
- [ ] Create credential UX shows scopes plain-language.

**Tests:**

- [ ] Revoke + IP deny integration tests.

**Acceptance:** Revoked credential cannot invoke tools.

**Evidence:** `E6/credentials.log`.

---

## Task E6.5 — Prompt injection & classification

**Reasoning:** Retrieved mail/drive/chat content must not become new authority.

**Depends on:** E6.1, E3–E5 tools

**Likely files:**

- assistant orchestrator, context policy, classification

**Steps:**

- [ ] Classification derived from highest sensitivity of retrieved sources when available.
- [ ] Injection fixtures from agent-live-evidence scenarios covered in unit/integration.
- [ ] System prompt isolation; tool policy not mutable by content.

**Tests:**

- [ ] orchestrator-policy + live-evidence-aligned fixtures.

**Acceptance:** Injection corpus cannot force unapproved send/share.

**Evidence:** `E6/injection.log`.

---

## Task E6.6 — Assistant UI polish

**Depends on:** E6.2

**Steps:**

- [ ] Streaming errors recoverable; stop generation.
- [ ] Conversation pin/rename/delete if APIs exist — else hide.
- [ ] Quick prompts MVP-only (mail/drive/chat).
- [ ] Mobile usable.

**Acceptance:** Assistant surface checklist + tests.

**Evidence:** `E6/assistant-ui.md`.

---

## Task E6.V — Phase E6 exit

**Depends on:** E6.1–E6.6

---

# Phase E7 — Admin & identity (honest enterprise)

**Entry:** E1.V  
**Exit:** Admin is operator-complete for pilot; incomplete SSO is hidden or fully shipped.

---

## Task E7.1 — Enforce-or-hide pass across admin console

**Reasoning:** Decorative security UI is worse than missing features.

**Depends on:** E1.1, E2.1

**Likely files:**

- `apps/web/src/features/admin/**`
- backend admin routes

**Steps:**

- [ ] Inventory every control in every section.
- [ ] Classify: enforced | disabled-with-reason | remove from MVP nav.
- [ ] Fix mismatches (label says enforced, API no-ops).
- [ ] Billing remains gated unless hosted flag.

**Acceptance:** Zero deceptive controls; inventory table in evidence.

**Evidence:** `E7/enforce-or-hide.md`.

---

## Task E7.2 — Users, groups, offboarding

**Reasoning:** Offboarding is a security control.

**Depends on:** E7.1

**Likely files:**

- admin users, groups APIs/UI
- auth admin-users

**Steps:**

- [ ] Invite, suspend, delete/deactivate, role assign.
- [ ] Offboard: session revoke, app password revoke, agent credential revoke, share cleanup policy.
- [ ] Groups membership authZ for mail/drive/chat where applicable.
- [ ] Tests for groups section (currently thin).

**Acceptance:** Offboard runbook + automated tests for revoke cascade.

**Evidence:** `E7/offboarding.md`.

---

## Task E7.3 — SSO/SAML/SCIM honesty gate

**Reasoning:** Incomplete ACS is an enterprise footgun.

**Depends on:** E7.1

**Likely files:**

- identity-management UI
- saml/scim routes

**Steps:**

- [ ] If ACS not production-ready: hide SSO enablement; show “not available in this release”.
- [ ] If shipping: full AuthnRequest/ACS, cert rotation, negative tests, e2e with mock IdP.
- [ ] SCIM: ship minimal CRUD or return clear 501 and hide write UI.
- [ ] MFA: enroll TOTP for pilot **or** remove advertised methods.

**Acceptance:** No UI path that stores SSO “enabled” without runtime auth.

**Evidence:** `E7/identity-honesty.md`.

---

## Task E7.4 — Audit log export & retention display

**Depends on:** E7.1

**Steps:**

- [ ] Admin audit search filters; export CSV/JSON for authorized admin.
- [ ] Retention display matches backend policy.
- [ ] No secret material in export.

**Acceptance:** e2e or integration export test.

**Evidence:** `E7/audit-export.log`.

---

## Task E7.5 — Domain + mail/drive/chat admin cross-links

**Depends on:** E3.4, E4.2, E5.4, E7.1

**Steps:**

- [ ] Admin overview health cards link to real section data.
- [ ] Service status matches probes.
- [ ] Agent controls + cost limits discoverable from overview.

**Acceptance:** Overview never shows fake green.

**Evidence:** `E7/overview.md`.

---

## Task E7.V — Phase E7 exit

**Depends on:** E7.1–E7.5

---

# Phase E8 — Search

**Entry:** E3.7 started; E4/E5 indexers available  
**Exit:** Unified search is the find surface for MVP.

---

## Task E8.1 — Meilisearch index pipeline reliability

**Depends on:** E1.V

**Likely files:**

- `apps/helix/src/platform/search/`
- domain indexers mail/drive/chat

**Steps:**

- [ ] Event indexer durability; reindex admin tool.
- [ ] Failures visible in admin/services.
- [ ] Org isolation in index filters.

**Tests:**

- [ ] meilisearch + reindex + authZ tests.

**Acceptance:** Reindex rebuilds org corpus; cross-org empty.

**Evidence:** `E8/indexer.log`.

---

## Task E8.2 — Unified search UI

**Depends on:** E8.1, E2.1

**Likely files:**

- `apps/web/src/features/search/`
- command palette search

**Steps:**

- [ ] Results grouped by type; keyboard navigate; open target route.
- [ ] Empty and error states.
- [ ] Debounce + cancel in-flight.

**Acceptance:** Unit + light e2e.

**Evidence:** `E8/search-ui.log`.

---

## Task E8.V — Phase E8 exit

**Depends on:** E8.1, E8.2

---

# Phase E9 — Cross-surface API parity

**Entry:** E3–E6 tool matrices  
**Exit:** MCP/REST/OpenAPI/CLI/tRPC expose consistent, documented MVP tools.

---

## Task E9.1 — Tool surface inventory & projection

**Depends on:** E3.6, E4.6, E5.6, E6.1

**Likely files:**

- `apps/helix/src/api/tool-projection.ts`
- `tool-surface-policy.ts`
- openapi/mcp generation

**Steps:**

- [ ] Single inventory of tools available on each channel.
- [ ] No channel exposes extra dangerous tools without policy.
- [ ] OpenAPI examples valid; MCP list tools matches registry visibility.

**Tests:**

- [ ] projection + openapi + mcp tests.

**Acceptance:** Diff inventory checked into evidence (not necessarily source).

**Evidence:** `E9/tool-channels.md`.

---

## Task E9.2 — Error envelope & idempotency consistency

**Depends on:** E9.1

**Likely files:**

- `api-error.ts`, `error-envelope.ts`, `idempotency.ts`

**Steps:**

- [ ] Stable error codes for authZ, validation, rate limit, operational kill.
- [ ] Idempotency keys on send/upload finalize/agent approve.
- [ ] Clients (web) map codes to user strings.

**Acceptance:** Contract tests green.

**Evidence:** `E9/errors-idempotency.log`.

---

## Task E9.3 — CLI critical path smoke

**Depends on:** E9.1

**Likely files:**

- `packages/cli/`
- core-cli plugin

**Steps:**

- [ ] CLI auth, list tools, invoke read tool, show pending.
- [ ] Document in admin guide.

**Acceptance:** Scripted smoke exit 0 against local stack.

**Evidence:** `E9/cli-smoke.log`.

---

## Task E9.V — Phase E9 exit

**Depends on:** E9.1–E9.3

---

# Phase E10 — Operations (Compose, Helm, backup, observability)

**Entry:** E1.V; domains E3–E7 substantially done  
**Exit:** Install → backup → restore is a boring, documented path.

---

## Task E10.1 — Production Compose hardening

**Depends on:** E1.1

**Likely files:**

- `docker-compose.production.yml`
- `infra/caddy/Caddyfile.production`
- `docs/tier-1-compose-checklist.md`
- `docs/deployment-production.md`

**Steps:**

- [ ] No published data-plane ports on public interfaces.
- [ ] No default dev secrets; required env documented.
- [ ] MVP env template: exact `HELIX_APPS`, scanners, `VITE_HELIX_MVP_ONLY` build args.
- [ ] Healthchecks and depends_on correct.
- [ ] One-command pilot install script or documented 15-step max path.

**Acceptance:** `docker compose -f docker-compose.production.yml config` validates; checklist complete.

**Evidence:** `E10/compose.md`.

---

## Task E10.2 — Helm Business values parity

**Depends on:** E10.1

**Likely files:**

- `infra/helm/helix/`
- `docs/architecture/compose-helm-parity.md`

**Steps:**

- [ ] values-business matches compose security posture.
- [ ] Network policies / non-root / resource limits sensible.
- [ ] Secrets via sealed/SOPS pattern documented (not committed).

**Acceptance:** Helm template dry-run; parity doc updated.

**Evidence:** `E10/helm.md`.

---

## Task E10.3 — Backup & restore drill automation

**Depends on:** E10.1

**Likely files:**

- `infra/scripts/backup.sh`, `restore.sh`, `restore-drill.sh`
- `docs/backup-restore.md`
- ADR-0006

**Steps:**

- [ ] Automated drill records RPO/RTO timings to JSON.
- [ ] Postgres + object store + (if needed) search reindex order documented.
- [ ] Failure of drill fails CI job for release branch.

**Acceptance:** Drill meets RPO≤24h RTO≤4h on pilot-sized dataset.

**Evidence:** `E10/restore-drill.json`.

---

## Task E10.4 — Observability & alerts for pilot

**Depends on:** E10.1

**Likely files:**

- Grafana dashboards plugin
- OTEL plugin
- runbooks

**Steps:**

- [ ] Dashboards: mail queue, drive scan, chat WS, agent denials, error rate.
- [ ] Alert rules for provider outage, scan backlog, disk, 5xx rate.
- [ ] Link runbooks from alert annotations.

**Acceptance:** Dashboards load on observability profile; alert list in evidence.

**Evidence:** `E10/observability.md`.

---

## Task E10.5 — Pilot install runbook (zero to mail)

**Depends on:** E10.1, E3.4, E7.2

**Steps:**

- [ ] Single runbook: DNS → compose up → first admin → domain verify → send test mail →
      create room → upload file → agent credential → kill switch demo.
- [ ] Timebox target ≤ 1 working day for skilled operator.
- [ ] Capture unknowns as issues, not silent steps.

**Acceptance:** External (or blind) operator dry-run notes in evidence.

**Evidence:** `E10/pilot-install-runbook.md` (canonical under `docs/` if promoted).

---

## Task E10.V — Phase E10 exit

**Depends on:** E10.1–E10.5

---

# Phase E11 — Live evidence & security validation

**Entry:** E10.V + functional phases E3–E9 substantially complete  
**Exit:** Final-release live gates producible for a digest-bound build.

---

## Task E11.M — Mail live evidence (M7)

**Depends on:** E3.V, E10.1

**Steps:**

- [ ] Run `infra/scripts/mail-live-evidence-smoke.mjs` (and provider sandbox as required).
- [ ] Bind release digests.
- [ ] Optional Gmail/M365 external only if credentials available; else record limitation.

**Acceptance:** JSON report pass for required scenarios.

**Evidence:** `mail-live-evidence.json`.

---

## Task E11.D — Drive live evidence (D7)

**Depends on:** E4.V, E10.1

**Steps:**

- [ ] Eight live cases including EICAR/quarantine, share revoke, large upload memory bound.
- [ ] Real ClamAV in environment.

**Acceptance:** All required cases pass.

**Evidence:** `drive-live-evidence.json`.

---

## Task E11.C — Chat live evidence (C6)

**Depends on:** E5.V, E10.1

**Steps:**

- [ ] Dual-replica / NATS restart profile as documented.
- [ ] 50-user/100-socket/30-min or scaled pilot-equivalent with justification.

**Acceptance:** Report pass.

**Evidence:** `chat-live-evidence.json`.

---

## Task E11.A — Agent live evidence (A7)

**Depends on:** E6.V, E10.1

**Steps:**

- [ ] Eight scenarios: scopes, forbidden URIs, injection fixtures, approval, revoke, kill.
- [ ] Include clear-kill after engage (self-unlock).

**Acceptance:** Report pass.

**Evidence:** `agent-live-evidence.json`.

---

## Task E11.O2 — Data-plane live evidence

**Depends on:** E10.1

**Steps:**

- [ ] TLS, authn/z, rotation scenarios per script.

**Evidence:** `data-plane-live-evidence.json`.

---

## Task E11.O4 — Restore drill evidence

**Depends on:** E10.3

**Evidence:** `restore-drill-evidence.json` with RPO/RTO.

---

## Task E11.V4 — Failure/recovery evidence

**Depends on:** E10.V

**Steps:**

- [ ] Disposable fault scenarios (NATS/Redis/DB/provider) per runner.

**Evidence:** `failure-recovery-evidence.json`.

---

## Task E11.V5 — DAST + security review

**Depends on:** E10.V

**Steps:**

- [ ] ZAP (or bound scanner) against staging; disposition Medium/Low.
- [ ] Zero High/Critical open.
- [ ] SBOM/supply-chain notes current.

**Evidence:** `dast-evidence.json` + security review note.

---

## Task E11.V6 — Full engineering gates on release SHA

**Depends on:** all product phases

**Validation:**

```sh
pnpm format:check && pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm quality:editors-boundaries
```

**Evidence:** `full-gates.json` / logs.

---

## Task E11.SOAK — 24h soak + SLO sample

**Depends on:** E11.M/D/C smoke green

**Steps:**

- [ ] 24h soak on pilot-like load; record availability and p95.
- [ ] Compare to §7.3 objectives.

**Evidence:** `slo-soak.json`.

---

## Task E11.V — Phase E11 exit

**Depends on:** E11.M, E11.D, E11.C, E11.A, E11.O2, E11.O4, E11.V4, E11.V5, E11.V6, E11.SOAK

**Steps:**

- [ ] Assemble release-readiness manifest; no `allowMissingLive` for final claim.

---

# Phase E12 — Dogfood, pilot, production decision

**Entry:** E11.V  
**Exit:** Signed R3 GO or conditional GO with owned expiry.

---

## Task E12.1 — Internal dogfood (2 weeks)

**Depends on:** E11.V (or partial with risk accept)

**Steps:**

- [ ] Run org mail/chat/drive/assistant daily.
- [ ] File issues by severity; P0/P1 block pilot.
- [ ] Weekly notes in evidence.

**Acceptance:** No open P0; P1 plan exists.

**Evidence:** `E12/dogfood-notes.md`.

---

## Task E12.2 — Private pilot (5–50 users)

**Depends on:** E12.1

**Steps:**

- [ ] Onboard pilot admin via install runbook.
- [ ] Support channel + severity SLAs.
- [ ] Collect deliverability and UX friction.
- [ ] Incident history clean enough for R3.

**Acceptance:** Pilot sponsor written feedback in evidence.

**Evidence:** `E12/pilot-feedback.md`.

---

## Task E12.3 — R3 go / no-go packet

**Depends on:** E12.2, E11.V

**Likely files:**

- `infra/scripts/r3-go-no-go.mjs`
- `docs/final-release-readiness.md`

**Steps:**

- [ ] Fill business readiness, support readiness, accepted risks.
- [ ] Protected git state observation if required by final mode.
- [ ] Decision: go | conditional_go | no_go with owners.

**Acceptance:** Manifest validates; decision recorded.

**Evidence:** `r3-go-no-go.json`.

---

## Task E12.V — Program exit

**Depends on:** E12.3 = go or owned conditional_go

**Steps:**

- [ ] Tag release; publish claims page; freeze packaging defaults.
- [ ] Explicitly **do not** enable Full Workspace without new program.

---

# Phase EX — Explicit non-goals (do not execute under this plan)

| ID   | Item                                       | When allowed                         |
| ---- | ------------------------------------------ | ------------------------------------ |
| EX.1 | Native Docs/Sheets/Slides / collab editing | After R3 + Full Workspace bible ED.* |
| EX.2 | Calendar product GA                        | Full Workspace CAL.*                 |
| EX.3 | Meet/Jitsi product GA                      | Full Workspace MT.* + O-D/O-K Jitsi  |
| EX.4 | Helix-hosted IMAP                          | Separate ADR                         |
| EX.5 | Direct-to-MX outbound                      | Separate ADR                         |
| EX.6 | E2EE chat                                  | Separate protocol plan               |
| EX.7 | Public multi-tenant SaaS                   | ADR-0012 S+ after R3                 |
| EX.8 | Mobile native apps                         | After mobile web elite               |
| EX.9 | Compliance certifications                  | External audit program               |

Any PR that enables EX.* packaging without a new owner decision is **out of scope and rejectable**.

---

# Appendix A — Per-surface crispness checklist (copy into PR)

Use for every user-visible change:

- [ ] API contract Zod’d; errors actionable
- [ ] AuthZ + org_id + negative test
- [ ] Loading / empty / error / offline treated
- [ ] No dead control
- [ ] Keyboard + label + focus
- [ ] URL state if shareable
- [ ] Agent tool impact considered (confirm?)
- [ ] Audit/metrics if mutation
- [ ] Docs/runbook if operator-facing
- [ ] MVP packaging unaffected (or updated tests)

---

# Appendix B — Suggested PR sequencing (first 20)

1. E0.1 inventory refresh
2. E0.2 claims doc
3. E0.3 baseline gates
4. E1.1 production assertions
5. E1.3 MVP packaging e2e
6. E1.4 tool audit completeness
7. E2.1 dead chrome
8. E2.3 a11y matrix trim
9. E4.2 scanner wiring (Business)
10. E6.1 policy firewall matrix
11. E6.2 approvals e2e
12. E6.3 kill UI e2e
13. E3.4 DNS admin polish
14. E3.5 mail UI depth e2e
15. E4.5 drive UI depth e2e
16. E5.5 chat UI depth e2e
17. E7.1 enforce-or-hide
18. E7.3 SSO honesty
19. E10.1 compose hardening
20. E10.5 pilot install runbook

Then remaining domain depth → E8/E9 → E11 live packet → E12.

---

# Appendix C — Verification plan (for goal harnesses)

When a goal claims “elite MVP phase complete,” verify:

1. **Scope:** No Full Workspace enablement; `HELIX_APPS` still MVP allowlist on production paths.
2. **Tests:** Focused vitest/e2e for tasks claimed; logs under evidence path.
3. **Gates:** `format:check`, `typecheck`, `lint` exit 0 after code changes.
4. **Main:** Commits are ancestors of `origin/main`.
5. **Honesty:** No new deceptive admin control; claims doc still accurate.
6. **Agents:** Registry self-unlock + policy confirmation tests still green.
7. **Drive:** Business scanner assertion tests still green.
8. **Live (only for E11/E12 goals):** Required JSON evidence present and pass.

---

# Appendix D — Relationship to other plans

| Document                                              | Role                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| This plan                                             | **Active** elite MVP enterprise track (no editors)     |
| `2026-07-28-core-workspace-production-readiness.md`   | Historical RD detail; content absorbed/superseded here |
| `2026-08-01-shell-resilience-and-data-loss-guards.md` | Shell detail; execute via E2.*                         |
| `2026-08-02-helix-full-workspace-v1-release.md`       | **Later** Full Workspace (Cal/Meet/Editors) after E12  |
| `docs/final-release-readiness.md`                     | Evidence schema law                                    |
| ADRs 0001–0007, 0012–0013                             | Normative decisions                                    |

---

# Appendix E — Definition of done (single sentence)

**Helix MVP is done when a non-founding operator can install it, verify a domain, run mail + files +
chat + gated agents for a real pilot org for a month, restore from backup once, kill agents in one
click, and never encounter a control that lies — with a signed evidence packet to prove it.**

---

_End of plan. Execute from E0; do not skip to live marketing claims._
