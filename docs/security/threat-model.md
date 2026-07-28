# Helix Threat Model

**Status:** consolidated implementation and launch-target reference. **Last reviewed:** 2026-07-28.

This document consolidates the threat table from **PRD §14.6** with the controls
that are _actually implemented_ in the codebase as of this review. It is the
single place to cross-check "what the PRD promises" against "what the code
enforces". Where a PRD-stated control is declared-but-not-enforced, this is
called out explicitly — see [§4 Gaps](#4-known-gaps-declared-not-enforced).

The Helix tier model (PRD §14) layers controls:

- **Tier 1 — Standard:** single-node Docker Compose. Baseline controls only.
- **Tier 2 — Hardened:** multi-replica, the v1 enterprise bar.
- **Tier 3 — Regulated:** SIEM, immutable audit, short token lifetimes.
- **Tier 4 — Sovereign:** air-gapped, FIPS, dual-control. Explicitly post-v1
  scaffolding (PRD open-question #9).

### Approved Business-pilot security profile

The first production target is one organization with 5–50 trusted users on the `business` tier.
The code must preserve tenant-safe internals, but public multi-tenant SaaS is not an approved launch
claim.

- Production outbound Internet mail requires a supported managed outbound email provider; Helix
  does not operate direct-to-MX outbound delivery for the pilot.
- Mail is web/API-first and does not include a Helix-hosted IMAP server.
- Chat is protected by TLS, organization and room authorization, retention, audited administrative
  access, and deployment-attested storage encryption. Chat is **not end-to-end encrypted**;
  authorized server administrators can technically access stored messages.
- Agent reads may execute when authorized. Every agent write requires authenticated human
  confirmation by default unless an explicit, audited automation policy bounds the exact action,
  resource, target, time window, and rate.
- Untrusted uploads remain unavailable until integrity checks and a real malware scanner return a
  clean verdict. Scanner errors and timeouts remain quarantined.
- Pilot engineering objectives are 99.5% monthly availability, RPO ≤ 24 hours, and RTO ≤ 4 hours;
  they are not a contractual SLA.

See the [accepted architecture decision records](../architecture/README.md).

---

## 1. Trust boundaries

| Boundary               | Description                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Untrusted → API        | External HTTP/MCP clients and inbound SMTP reach the Fastify edge. User and agent requests require authentication and authorization. Inbound SMTP is intentionally unauthenticated Internet input and must pass recipient routing, size/rate, authentication-evidence, spam, and malware policy before delivery. |
| Agent → Tools          | AI agents and OAuth clients invoke tools via REST/MCP/tRPC. Existing scope, visibility, authorization, and classification gates apply, but the approved all-agent-write confirmation policy is still a launch gap listed in §4.                                                                                  |
| App → Data plane       | Postgres, Redis, NATS, and object storage. Production must expose them only on private networks; development Compose currently publishes some ports and is not production evidence.                                                                                                                              |
| App → AI providers     | Outbound LLM/embedding calls. The point at which org data can leave the trust boundary — gated by classification.                                                                                                                                                                                                |
| Inbound webhooks → App | Third-party webhook senders (GitHub, Linear, Stripe, generic). Signature-verified before processing.                                                                                                                                                                                                             |

---

## 2. Threat table (PRD §14.6) mapped to implemented controls

Legend: ✅ implemented & enforced · 🟡 partial / declared-only · ⬜ post-v1.

| Threat                | PRD Tier 1 mitigation           | Implemented control (evidence)                                                                                                                                                                                                                                                                                        | Status                       |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Credential stuffing   | Rate limit + TOTP               | OAuth/credential endpoints rate-limited (`platform/limits/`, `auth/oauth.ts`, `auth/credentials.ts`); TOTP via better-auth (`auth/better-auth.ts`). MFA-required-for-admins is **not** enforced.                                                                                                                      | 🟡                           |
| Inbound mail spoof    | SPF/DKIM/DMARC                  | SMTP receive path scores SPF/DKIM/DMARC; results feed classification derivation.                                                                                                                                                                                                                                      | ✅ (T1)                      |
| Outbound abuse        | Per-user quotas                 | Per-user/agent quotas via the rate limiter (`platform/limits/`); agent credential `rate_limit_overrides` (`auth/credential-overrides.ts`).                                                                                                                                                                            | ✅ (T1)                      |
| Stored XSS in mail    | DOMPurify + iframe sandbox      | Mail HTML sanitized; rendered in sandboxed iframe in the web client. Strict CSP / per-render nonces are Tier 2+.                                                                                                                                                                                                      | ✅ (T1)                      |
| File upload exploit   | MIME sniff                      | Drive performs MIME sniffing, but its scanner factory can still resolve to a no-op adapter. Business launch requires real streaming malware scanning and fail-closed quarantine on every retrieval surface.                                                                                                           | 🟡                           |
| SSRF via "fetch URL"  | Block RFC1918                   | Outbound fetch blocks RFC1918 ranges; per-plugin egress allowlists are Tier 2+.                                                                                                                                                                                                                                       | ✅ (T1)                      |
| Secrets in logs       | Pino redact paths               | Structured logging with redaction paths configured.                                                                                                                                                                                                                                                                   | ✅ (T1)                      |
| Cross-actor data leak | Cerbos on every op              | Real Cerbos PDP integration: every tool invocation is authorized through `permissions/tool-access.ts` (`CerbosToolAccessPolicy`). Classification gating adds a second gate (`ai/classification/gating.ts`, `policy.ts`).                                                                                              | ✅                           |
| Insider DB tamper     | (none meaningful at T1)         | Hash-chained audit log: each record links to its predecessor via `prevHash`/`thisHash` (`audit/hash.ts`); offline verifier detects breaks (`audit/verifier.ts`). Immutable S3 Object-Lock shipping (`audit/immutable-s3.ts`) and WORM-Postgres (`audit/immutable-postgres.ts`) for Tier 2/3.                          | ✅ (T2 hash chain)           |
| Provider exfil via AI | Classification + rate           | Resource classification + classification-gated routing decides whether a request may reach a cloud provider (`ai/classification/`, `ai/routing.ts`). AI cost limiting (`ai/costs/redis-limiter.ts`). PII redaction is Tier 2+.                                                                                        | ✅ (gating) / 🟡 (redaction) |
| Agent compromise      | Confirmation on destructive ops | Destructive and external actions use confirmation paths, but ordinary agent writes are not yet universally queued and credential policy is not consistently propagated to every invocation surface. The accepted pilot policy requires confirmation for every agent write unless a bounded automation policy matches. | 🟡                           |
| Supply chain          | `pnpm audit`                    | `pnpm audit` in CI. Signed-plugin verification, SBOM, air-gapped registry are Tier 2+/Tier 4.                                                                                                                                                                                                                         | ✅ (T1) / ⬜                 |

---

## 3. Implemented control inventory

These are the security mechanisms that exist as running, tested code today.

### 3.1 Authorization — Cerbos policies

`platform/permissions/tool-access.ts` integrates a real Cerbos PDP. Every tool
invocation (REST, MCP, tRPC) is checked: the principal, action, resource type,
resource id, and decision are evaluated against policy. Permission checks emit
`permission.check` OTel spans. This is the primary cross-actor isolation
control.

### 3.2 Scope catalog & composition

`platform/permissions/scope-catalog.ts` defines the OAuth scope catalog used to
gate tool access. Tools declare required scopes; the access policy checks them
before authorization proceeds. _Composite-scope enforcement_ (e.g.
`mail.external` required in addition to `mail.send`) is tracked as a known gap —
see §4.

### 3.3 Rate limiting

`platform/limits/` provides both an in-memory limiter and a Redis-backed
limiter using an atomic Lua script, so limits hold across replicas. Applied to
auth endpoints and per-user/per-agent tool quotas. AI cost limiting has its own
Redis-backed limiter (`platform/ai/costs/redis-limiter.ts`).

### 3.4 Classification gating

`platform/ai/classification/` tags resources with a sensitivity classification
(stored in Postgres via `0017_resource_classifications.sql`) and gates AI
routing: a restricted-classification request will not be routed to a cloud
provider when policy forbids it (`gating.ts`, `policy.ts`, `service.ts`).

### 3.5 Audit hash chain

`platform/audit/hash.ts` computes a per-record hash that chains to the previous
record's hash. `platform/audit/verifier.ts` is an offline verifier that walks
the chain and reports `prev_hash_mismatch` / `this_hash_mismatch` breaks,
detecting insider tampering. `audit/immutable-s3.ts` ships records to S3 Object
Lock; `audit/immutable-postgres.ts` and `audit/siem-syslog.ts` provide WORM and
SIEM destinations.

### 3.6 Signature verification

`platform/webhooks/signatures.ts` verifies inbound webhook signatures
(GitHub/Linear/Stripe/generic) using HMAC with `crypto.timingSafeEqual`,
preventing forged webhook delivery and timing side-channels. Outbound webhooks
are likewise signed.

### 3.7 Agent credential model

Migration `0018_agent_credential_model.sql` and `auth/credential-overrides.ts`
model per-credential `ip_allowlist`, `allowed_hours`, `confirmation_override`,
and `rate_limit_overrides`, plus `cert_fingerprint` for future mTLS credentials.
OAuth access tokens are persisted and revocable (`0001_oauth_credentials_store.sql`).
These modeled controls are not proof of consistent enforcement: policy propagation
across REST, MCP, tRPC, Assistant, and pending execution remains a launch requirement.

### 3.8 Chat confidentiality model

Chat messages are stored server-side so authorized search, retention, export,
moderation, bots, and scoped agent workflows can operate. TLS and deployment
storage encryption protect transport and media, while organization and room
authorization restrict application access. This is not E2EE: authorized server
administrators can technically access stored message content.

---

## 4. Known gaps (declared, not enforced)

These are PRD-stated controls that are **not** yet enforced in code. They are
documented here so the threat model does not overstate coverage. They are
tracked in `docs/prd-alignment-plan-2026-05-21.md`.

| Gap                                                                                                                                                                                        | PRD ref     | Plan item                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------ |
| MFA required for admins is not enforced anywhere in auth code.                                                                                                                             | §14.6, §9.2 | P2-1                                       |
| OAuth composite-scope enforcement (`mail.external` etc.) is defined in the catalog but never checked.                                                                                      | §9.4        | P0-3                                       |
| Internal mTLS, at-rest encryption, IP allowlists, egress allowlists are tier-engine _defaults_ with no enforcement path.                                                                   | §14         | P2-1                                       |
| Drive can resolve malware scanning to a no-op adapter; Business fail-closed quarantine is not yet enforced across every read/share/index/attachment surface.                               | RD-7        | Production-readiness tasks 1.6, D1–D2      |
| Ordinary agent writes are not universally pending, and credential policy is not consistently propagated through every invocation surface.                                                  | RD-5        | Production-readiness tasks 1.3–1.5, A3–A5  |
| Production outbound and inbound mail boot paths still have default-organization coupling; the pilot requires provider-backed outbound delivery and tenant-safe recipient/provider routing. | RD-1, RD-2  | Production-readiness tasks M1–M4           |
| Production storage encryption, private data-plane networking, backup integrity, and restore RPO/RTO require deployment evidence; tier labels alone do not prove them.                      | RD-4, RD-6  | Production-readiness tasks 1.1, D3, O2, O4 |
| AI PII redaction (Tier 2+) is specified but not implemented.                                                                                                                               | §14.6       | P0-6                                       |
| SIEM/WORM audit destinations exist as code but are not wired as default Tier 3 sinks end-to-end.                                                                                           | §14.6       | P2-2                                       |
| Signed-plugin verification, SBOM, air-gapped registry.                                                                                                                                     | §14.6       | P2-9 / Tier 4                              |

---

## 5. Maintenance

When adding or changing a security control:

1. Update the relevant row in §2 and the inventory in §3.
2. If a PRD-stated control remains unenforced, keep it listed in §4 — do not
   silently drop it.
3. Re-confirm the "Last reviewed" date at the top.
