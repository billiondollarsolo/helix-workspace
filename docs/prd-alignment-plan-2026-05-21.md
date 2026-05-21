# Helix Workspace — PRD Alignment & Enterprise-Readiness Plan

**Date:** 2026-05-21
**Method:** Five parallel read-only audits cross-referencing PRD.md (3,102 lines, ~90 roadmap
tasks across 11 phases) against the actual codebase — platform foundation, AI layer, feature
plugins, API/CLI/MCP surfaces, and security/observability/HA. Every finding below is backed by
file evidence captured in the audits.

---

## 1. Executive summary

Helix is **substantially built and, where code exists, generally enterprise-grade in
implementation quality** — Postgres-backed stores (not mocks), transactional outbox with
`FOR UPDATE SKIP LOCKED`, an atomic Redis Lua rate limiter, HMAC `timingSafeEqual` signatures,
real Cerbos PDP integration, a hash-chained audit log with an offline verifier and S3 Object-Lock
shipping, OTel instrumentation, a complete Helm chart, 0 accessibility violations across 84
route/theme/viewport checks, and 231 passing unit tests.

**But it is not yet PRD-aligned, feature-complete, or enterprise-ready**, for three systemic
reasons:

1. **The plugin architecture — the PRD's central premise — is not real.** Every
   `plugins/com.helix.*/index.js` is `export default {}`. All functionality lives in the
   `apps/helix` monolith. The plugin loader/lifecycle/migration-runner are built and tested but
   **never exercised by a single real plugin**.
2. **Several stated controls are declared but not enforced** — OAuth scope composition, tier
   hardening (mTLS, encryption-at-rest, MFA), confirmation notifications, leader election for
   singleton workers. These are correctness/security gaps, not cosmetic.
3. **"Enterprise-grade" table stakes are missing** — API versioning, idempotency keys, the
   Authorization Code OAuth flow, argon2id hashing, real E2E tests, real backup/PITR, and
   genuine Tier 2/3/4 hardening (most of which is Helm/config scaffolding, not running code).

**Verdict by phase:**

| Phase | Area | Verdict |
|---|---|---|
| −1 | Platform foundation | 🟢 Largely real and strong (monolith form) |
| 0 | Core platform plugins | 🟡 Functionally delivered, but as a monolith not plugins |
| 1 | AI foundation | 🟡 Routing/memory/provenance real; providers are stubs, cloud auth broken |
| 2–8 | Feature plugins | 🟡 Backend tools complete; packaging fictional; no real E2E; UI demo-data leaks |
| 9 | Hardening | 🟡 Tier 1 real; Tier 2 partial; Tier 3/4 mostly scaffolding |

---

## 2. The headline finding — the plugin architecture is not exercised

PRD §4 makes plugins the core architectural premise: loadable modules with lifecycle hooks,
namespaced migrations, and capability contributions. Reality:

- Every `plugins/com.helix.*/index.js` is literally `export default {}`. The
  `com.helix.vector-*` manifests even declare a `main: index.js` file that does not exist.
- `apps/helix/src/server.ts` **never loads the `plugins/` directory as code**. It only
  *discovers manifests* (`platform/plugins/tools.ts`) to populate the admin catalog UI.
- `pnpm-workspace.yaml` excludes `plugins/*`.
- `apps/web` does not use `sdk-web/plugin-loader.ts` either — it calls
  `registerPlatformShellContributions` directly.

The loader, `InProcessPluginRuntime`, lifecycle hooks, the namespaced migration runner, and the
capability registries are all **implemented and unit-tested** — they are simply never run against
a real plugin. Everything works today because it is wired directly into the monolith.

**This single fact is why ~60 roadmap tasks are rated 🟡 Partial instead of ✅ Done.** Two
strategic options (decision required — see §9):

- **A. Realize the architecture** — extract `apps/helix/src/platform/*` modules and the AI
  providers into genuine plugin packages, wire `InProcessPluginRuntime` at startup, run
  namespaced migrations. Large effort; makes the PRD true.
- **B. Amend the PRD** — accept an in-process modular monolith as the v1 shape; keep the plugin
  SDK for third-party/external plugins only; downgrade TASK-100–119 packaging expectations.

Until this is decided, treat everything below as work on the *monolith as it stands*.

---

## 3. Work plan

Items are grouped by priority. **P0** = correctness, security, or enterprise blocker. **P1** =
feature-completeness & three-surface alignment. **P2** = hardening scaffolding → real, and polish.

---

## P0 — Correctness, security & enterprise blockers

### P0-1 Leader-gate all singleton workers
**Problem:** `pg_try_advisory_lock` protects only `AuditVerifierWorker`. The outbox poller,
outbound-webhook worker, mail worker, and enrichment/indexer workers start unconditionally on
every replica (`server.ts:842`). On any multi-replica deploy (Tier 2+) this **double-sends mail,
double-delivers webhooks, double-processes events**. PRD §16.2 names the outbox poller as the
canonical singleton.
**Do:** Route every singleton worker through `LeaderElection`. Consolidate the two divergent
implementations (`leader/election.ts` vs `leader-election.ts`) into one, add tests.

### P0-2 Implement graceful shutdown
**Problem:** The `onClose` drain logic exists but **nothing calls `server.close()`** — there is
no `process.on('SIGTERM'/'SIGINT')` handler. Under k8s/Compose stop, the process is killed
mid-flight. `terminationGracePeriodSeconds` and a `preStop` hook are absent from
`infra/helm/.../deployment.yaml`.
**Do:** Add SIGTERM/SIGINT handlers that invoke the drain; add `terminationGracePeriodSeconds: 60`
+ `preStop`; implement the PRD §16.3 steps 4–5 (Yjs "host shutting down", chat "reconnect
required").

### P0-3 Enforce OAuth scope composition
**Problem:** `mail.external` (and similar composite scopes) are defined in the catalog but
**never checked**. `mail.send` carries `permission: "mail.send"` only — an agent with just
`mail.send` can email external recipients. PRD §9.4 states Cerbos enforces these compositions.
**Do:** Implement scope-composition enforcement (tool declares required composite scopes;
policy checks all of them). Make `CerbosToolAccessPolicy` the default and encode compositions,
or enforce in `ScopeToolAccessPolicy`.

### P0-4 Complete the confirmation flow
**Problem:** (a) `onPendingActionCreated` is unwired in `server.ts:599` — **owners are never
notified** of pending approvals; the flow is silently poll-only. (b) **No timeout auto-deny** —
`expiresAt` is set (hardcoded 15 min, PRD says configurable 10) but nothing transitions
`pending → expired`.
**Do:** Wire the notification callback (notification + optional webhook). Add a worker (leader-
gated) that expires stale `pending_actions`. Make the timeout configurable per tier.

### P0-5 Fix cloud AI provider authentication
**Problem:** Vertex SA auth is **functionally broken** — `vertexBearerToken` signs a JWT and
uses it directly as the bearer token, skipping the OAuth2 exchange at `tokenUri`; real Vertex
rejects this. Bedrock supports only static credentials (no IAM role / instance profile / AWS
profile, contra PRD §8.2.3). The `server.ts` provider builders don't even wire the SA
`clientEmail`/`privateKey` path.
**Do:** Implement the Vertex token exchange; add Bedrock IAM-role/profile credential resolution;
wire all credential paths through config; add signing/auth unit tests.

### P0-6 Persist classification; add derivation
**Problem:** Resource classification tagging is `InMemoryResourceClassificationStore` only — no
DB table, lost on restart. None of the PRD §8.4 derivation rules (mail-label-derived,
folder-derived, heuristic PII) exist. Two inconsistent provider-tag vocabularies coexist between
`ai/classification/gating.ts` and `ai/routing.ts`.
**Do:** Add a Postgres `resource_classifications` table + store; implement the three derivation
mechanisms; reconcile the tag vocabularies into one.

### P0-7 Make AI cost limiting durable
**Problem:** `costs/` ships only `InMemoryAICostLimiter` — budgets reset on restart and are not
shared across instances (the agent rate-limiter, by contrast, has a Redis variant). No admin
surface to view/set per-user AI cost limits (TASK-217's "limit" half).
**Do:** Add a Redis/Postgres-backed AI cost limiter; expose admin API + UI for per-user limits;
send the 80%-warning notification (currently `warningReached` is computed and discarded).

### P0-8 Remove demo/sample data from production UI
**Problem:** `drive-shell.tsx` embeds `sampleDriveFiles`/`sampleDriveFolders` and falls back to
them whenever the live query is empty — demo content surfaces to real users. `calendar-shell.tsx`
`weekDays` is a hardcoded fixed May-2026 array, so calendar navigation is cosmetic only.
**Do:** Delete the Drive sample-data fallback (show a real empty state). Make the Calendar grid
compute its date window from the active date so week/month/day navigation is functional.

### P0-9 Upgrade auth hardening
**Problem:** Client-secret hashing uses `scrypt`; PRD §9.2 mandates **argon2id**. No token
revocation/introspection endpoint.
**Do:** Switch credential hashing to argon2id (with migration path); add token
revocation/introspection.

---

## P1 — Feature completeness & three-surface alignment

### P1-1 Real end-to-end tests
**Problem:** PRD E2E tasks (308/406/506/607/707/905) are satisfied only by store-backed
integration tests using in-memory fakes. The only real Playwright feature spec is
`meet-jitsi-embed`. Mail "E2E" never exercises real SMTP send→receive.
**Do:** Add real Playwright browser specs per feature; add a real SMTP send→receive integration
for mail; gate them in CI.

### P1-2 CLI three-surface parity
**Problem:** Mail CLI exposes only `send/reply/list/search`; `mail.label.apply`, `archive`,
`delete`, `snooze`, `filter.*` exist on backend + UI but have no CLI subcommands. `helix logout`
is missing. Completion scripts are hand-written, not generated from OpenAPI (PRD §9.8).
**Do:** Add the missing mail CLI subcommands and `logout`; generate completion from OpenAPI;
audit every feature's tools for backend/CLI/UI parity.

### P1-3 tRPC as a true per-tool projection
**Problem:** tRPC exposes one generic `tools.invoke({toolId, input})`, not a typed procedure per
tool — violating PRD §13.1 "one source, three surfaces" and breaking end-to-end typing for the
SPA.
**Do:** Generate a typed tRPC procedure per registered tool from the same tool registry the REST
and MCP surfaces use.

### P1-4 Complete the MCP surface
**Problem:** `prompts/list` is missing; no streaming/SSE (`/mcp` is plain POST JSON-RPC despite
PRD §9.5); protocol version pinned to old `2024-11-05`; `serverInfo.version: "0.0.0"`.
**Do:** Add `prompts/list`, SSE/streaming for long-running calls, update the protocol version,
set a real server version.

### P1-5 Authorization Code OAuth flow
**Problem:** Only client-credentials exists. `/oauth/authorize`, PKCE, and a consent screen are
absent — PRD §13.6 requires them for click-through MCP clients.
**Do:** Implement `/oauth/authorize` with PKCE and a consent screen.

### P1-6 Single canonical scope catalog
**Problem:** Scopes live in a hand-maintained array (`auth/tools.ts`) merged ad-hoc with tool
permissions; the OpenAPI scope list is derived separately. Three views can drift, and the
catalog already diverges from PRD §9.4 (`chat.write` added, `tools` renamed, extra scopes).
**Do:** Define one canonical scope catalog module; derive the OpenAPI list, the credential UI,
and enforcement from it; reconcile with PRD §9.4.

### P1-7 Expand the agent credential model
**Problem:** Only `oauth_client` is modeled. No `api_key`, no `mtls_cert`/`cert_fingerprint`, no
`ip_allowlist`, `allowed_hours`, per-credential `confirmation_override` or
`rate_limit_overrides` (all in PRD §9.2).
**Do:** Extend `agent_credentials` schema + enforcement for the missing credential types and
per-credential policy fields.

### P1-8 AI response streaming
**Problem:** Both OpenAI- and Anthropic-compatible providers hardcode non-streaming requests;
the router's stream-collection path is dead code. The assistant cannot stream.
**Do:** Implement streaming in both providers; wire streaming through the router to the
assistant UI.

### P1-9 Missing feature pieces
- **Drive `auto-tag` enrichment** — no `drive/ai/enrichments.ts` (PRD §12.3); mail/chat/docs all
  have one.
- **Chat read receipts** (TASK-404) — not evidenced as distinct from typing/presence.
- **Docs suggestion-mode editing** (TASK-604) — not evidenced as distinct from plain comments.
- **Enrichment handlers** — only mail/chat/docs registered; drive/calendar absent.

### P1-10 API enterprise basics
**Problem:** No `Idempotency-Key` support (mutating calls like `mail.send` are not idempotent);
no API versioning (`/v1/`, `api-version`); `version: "0.0.0"` everywhere; no `/openapi.yaml`;
no per-endpoint examples; flat OpenAPI tags instead of per-plugin grouping; no unified error
envelope with `traceId`.
**Do:** Add idempotency-key handling for mutating tools; introduce API versioning; add
`/openapi.yaml`, examples, per-plugin tags; standardize the error envelope.

---

## P2 — Hardening scaffolding → real, and polish

### P2-1 Make tier hardening enforced, not declared
The tier engine *declares* defaults but no code enforces: internal mTLS (only an example
Caddyfile + static linter), at-rest encryption (LUKS/TDE/SSE — config metadata only), **MFA
required for admins** (not enforced anywhere in auth code), IP allowlists, network egress.
**Do:** For each tier control, add an enforcement or verification path (e.g. MFA enforcement in
auth; a startup check that fails closed if a required Tier-2+ control is unverified).

### P2-2 SIEM audit destination
No `audit-siem-syslog` plugin exists — only a Helm `siem-configmap.yaml` with metadata. Tier 3
mandates "immutable S3 + SIEM". `audit-immutable-postgres` (WORM) is also absent.
**Do:** Implement a SIEM syslog/CEF-LEEF audit shipper and a WORM-Postgres destination.

### P2-3 Real backup / PITR / object backup
Backup is Postgres logical dump only. WAL/PITR and RustFS/S3 object backup are "placeholder
metadata"; KMS/HSM/WORM/cross-region are documented only. Tier 3 (15 min) and Tier 4 (5 min) RPO
targets are **unachievable as built**.
**Do:** Implement continuous WAL archiving/PITR and object-store backup; wire KMS for backup
encryption; measure RPO/RTO against §16.6.

### P2-4 Config hot-reload + real YAML
`subscribeToConfigHotReload` is implemented and tested but never wired in `server.ts`. The YAML
parser is hand-rolled and brittle.
**Do:** Wire hot-reload at startup; replace the hand-rolled parser with a real YAML library.

### P2-5 Schedule the CI restore drill nightly
`restore-drill.yml` has no `schedule:` cron and drills a freshly-created backup, not the prior
day's (PRD §2.3/§16.5 mandate nightly).
**Do:** Add the nightly cron; restore the prior day's backup.

### P2-6 Complete OTel coverage
Custom spans exist for LLM/tool/permission; missing for `mcp.*`, `smtp.*`, `yjs.sync`, `job.*`.
WebSocket handshakes don't extract `traceparent` from the upgrade request.
**Do:** Add the missing spans; extract trace context at the WS handshake; synthesize job traces.

### P2-7 Webhook custom-template renderer
`webhooks/formats/template.ts` is a `{{token}}` substitution only — PRD §TASK-115 specifies
Liquid/Handlebars (loops, conditionals, filters).
**Do:** Replace with a real Liquid or Handlebars renderer (sandboxed).

### P2-8 Helm + autoscaling polish
HPA is CPU-only; PRD §16.1 specifies CPU + WebSocket-connection metrics. Chart (v0.9.0) is not
published to a Helm repo.
**Do:** Add a custom WS-connections metric to the HPA; publish the chart in the release pipeline.

### P2-9 Tier 4 / FIPS scaffolding
FIPS crypto adapters do not exist as interfaces or code (only readiness Zod schemas). STIG images
are Helm placeholders. NIST 800-53 doc is a 36-line mapping. *Correctly scoped as scaffolding per
TASK-A02 and open-question #9 — track as a deliberate post-v1 item, not a silent gap.*

### P2-10 Tech-debt cleanup
- Duplicate migration prefix `0001_` (`oauth_credentials_store` + `outbox_trace_context`).
- Two leader-election implementations (see P0-1).
- `pnpm-workspace.yaml` excludes `plugins/*`.
- `vector-*` manifests reference a non-existent `index.js`.
- Thin AI test coverage: 4 tests for 4 providers (happy path only); no pgvector test; 1
  embedding test.
- No consolidated threat-model doc (§14.6).

---

## 4. Recommended sequencing

1. **Decide the plugin-architecture question (§9)** — it determines whether ~60 tasks are
   "done" or "to do". Everything else assumes the monolith.
2. **P0 batch — correctness & security** (P0-1…P0-9). These are bugs and unenforced controls,
   not features. Ship before any enterprise pilot. Estimate: the leader-gating, graceful
   shutdown, confirmation flow, and scope enforcement are each small-to-medium; cloud-provider
   auth and classification persistence are medium.
3. **P1 batch — feature completeness & alignment** (P1-1…P1-10). Brings the three surfaces into
   parity and closes the spec gaps. Real E2E (P1-1) should land early so the rest is regression-
   safe.
4. **P2 batch — hardening made real** (P2-1…P2-10). Required before claiming Tier 2/3
   readiness; Tier 4/FIPS stays explicitly post-v1.

---

## 5. Open questions for human review

1. **Plugin architecture (§2): ✅ RESOLVED — confirmed hybrid model.** The headline finding
   is closed by adopting an explicit two-part architecture, now implemented:
   - **Core apps** (mail, chat, drive, docs, calendar, meet, assistant) are **toggleable
     modules of the Helix platform** — *not* plugins and *not* per-user containers. They ship
     in one deployable, are multi-tenant, and scale by horizontal replicas. Each core app is
     registered conditionally on an org-admin global `enabled` flag (`config.modules[appId]`),
     and on a role-based boot switch (`HELIX_ROLE` / `HELIX_APPS`) so the same image can run a
     subset of apps as its own k8s Deployment + HPA. A disabled app is not registered or
     served at all; the web shell shows only enabled apps and renders a clean "app disabled"
     state for the rest.
   - **Add-on plugins** are **external connectors only** — integrations into other systems
     (MCP-style tools, inbound/outbound webhooks). The plugin SDK / loader / `InProcessPlugin
     Runtime` is reserved for these and is now genuinely invoked at startup: a connector
     runtime discovers `/plugins`, loads `category: "connector"` plugins, and runs their
     `register` hook. The Slack outbound-webhook connector ships realized as proof of the
     path. The manifest model separates the two with a `category` field
     (`core-app` vs `connector`).
   This makes the PRD true without extracting the seven core apps into plugin packages, and
   keeps the in-process modular monolith as the v1 shape. See PRD §4.
2. **Tier 3/4 timeline:** PRD open-question #9 already parks the Sovereign tier. Confirm Tier 2
   is the v1 enterprise bar and Tier 3 SIEM/SPIRE/TDE is a fast-follow.
3. **E2E infrastructure:** is a real backend (Postgres/Redis/NATS/SMTP) available in CI for true
   E2E, or do we run a docker-compose service stack per CI run?
4. **Multi-replica target for v1:** if v1 ships single-replica only, P0-1/P0-2 are still
   required for k8s correctness but the urgency profile changes.

---

*Generated from a five-agent parallel audit on 2026-05-21. Every claim is traceable to file
evidence in the audit transcripts; `docs/prd-validation-gap-matrix.md` remains the
running task-level status map and should be reconciled against this plan.*

---

## 6. Implementation status — 2026-05-21

This plan was executed in waves of parallel subagents (each on a disjoint file set, verified
before the next wave), followed by an integration-wiring pass and a final cleanup.

**P0 — Correctness, security & enterprise blockers: ✅ 9/9 complete.**
- P0-1 leader-gated singleton workers (consolidated leader election, `SingletonWorkerSupervisor`)
- P0-2 graceful shutdown (SIGTERM/SIGINT drain, Helm `terminationGracePeriodSeconds`+`preStop`,
  Yjs/chat shutdown-broadcast frames)
- P0-3 OAuth scope-composition enforcement (`mail.external`/`calendar.external` now checked)
- P0-4 confirmation flow completed (notification-on-create, leader-gated expiry worker,
  per-tier timeout)
- P0-5 cloud AI provider auth fixed (Vertex OAuth2 token exchange, Bedrock IAM/profile/IMDSv2)
- P0-6 classification persisted (`resource_classifications` table) + derivation rules
- P0-7 durable AI cost limiting (Redis-backed) + admin API/UI + 80% warning
- P0-8 demo data removed from Drive UI; Calendar grid date-driven
- P0-9 argon2id hashing (scrypt back-compat + rehash); OAuth revoke/introspect

**P1 — Feature completeness & three-surface alignment: ✅ 10/10 complete.**
- P1-1 real Playwright E2E specs (mocked + live) + SMTP send→receive test + CI job
- P1-2 CLI parity (mail label/archive/delete/snooze/filter, `logout`, drift-tested completion)
- P1-3 tRPC per-tool typed projection
- P1-4 MCP `prompts/*` + SSE streaming + protocol bump
- P1-5 Authorization Code OAuth + PKCE + consent screen
- P1-6 single canonical scope catalog reconciled with PRD §9.4
- P1-7 expanded agent credential model (`api_key`, `mtls_cert`, IP-allowlist, allowed-hours)
- P1-8 AI response streaming (provider → router → orchestrator → UI SSE)
- P1-9 drive auto-tag enrichment, chat read receipts, docs suggestion-mode
- P1-10 API versioning (`/v1`, `api-version`), `Idempotency-Key`, `/openapi.yaml`, error envelope

**P2 — Hardening made real & tech-debt: ✅ 9/10 complete; P2-9 deferred by design.**
- P2-1 tier enforcement (admin-MFA gate, startup readiness check, explicit unverifiable warnings)
- P2-2 SIEM (CEF/LEEF syslog) + WORM-Postgres audit destinations, wired + leader-gated
- P2-3 real WAL/PITR + object-store backup + KMS envelope encryption
- P2-4 config hot-reload wired; hand-rolled YAML parser replaced with the `yaml` library
- P2-5 nightly restore drill now drills the prior day's backup
- P2-6 OTel spans for `mcp`/`smtp`/`yjs`/`job` + WS-handshake trace extraction; WS metric gauge
- P2-7 webhook templates → real sandboxed Liquid engine
- P2-8 Helm HPA scales on CPU+memory+WebSocket connections; chart-publish workflow
- P2-9 Tier-4 / FIPS — **intentionally deferred** (the plan scopes it as post-v1 scaffolding;
  see §9 open-question #1 and PRD open-question #9 — a human decision, not silently skipped)
- P2-10 tech-debt: +55 AI tests, threat-model doc, vector manifests fixed; the duplicate
  migration prefix and `plugins/*` workspace change were assessed and **deferred as unsafe**
  (migrations tracked by filename + non-idempotent SQL; plugin dirs have no `package.json`)

**Plus** an integration-wiring pass connecting credential auth, the assistant SSE endpoint,
drive enrichments, classification consumption, and SIEM destinations into `server.ts`.

**Validation:** continuous per-wave and final — `apps/helix` **786 tests** + typecheck + lint
+ build ✓; `apps/web` **255 tests** + typecheck + lint + build ✓; infra validators
(helm / restore-drill / caddy-hardening) ✓. Test count grew 231→786 (helix) and 231→255 (web).

**Still open (require human decision, not implementation gaps):**
1. ~~The plugin-architecture question~~ — **RESOLVED** (see §5 #1). The confirmed model is now
   implemented: core apps are toggleable platform modules (org-admin enablement + role-based
   boot), and the plugin SDK/loader is reserved for external connectors, which are now
   genuinely loaded at startup with one realized connector shipped as proof.
2. P2-9 Tier-4 / FIPS adapters & STIG images — deliberate post-v1 scaffolding.
3. MFA verification currently trusts an `x-helix-mfa-verified` header from the auth boundary;
   enabling BetterAuth's `twoFactor` plugin would replace it with a session AAL signal.
