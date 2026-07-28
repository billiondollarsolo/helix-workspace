# Helix Workspace Security Threat Model

**Status:** source-grounded Business MVP security reference. **Last reviewed:** 2026-07-28.

This document describes the security properties implemented in `helix-workspace`, the controls
that still depend on deployment evidence, and the remaining release blockers. It is not itself a
production attestation. A control is not considered live merely because its implementation,
configuration schema, test, or evidence harness exists.

## Overview

Helix is being productionized as a deliberately smaller, self-hostable workspace for:

- web and API email through a managed outbound provider;
- shared file storage, organization, versions, sharing, download, and WebDAV;
- authenticated organization Chat; and
- least-privilege, approval-gated AI and agent workflows.

The initial launch profile is one organization with 5–50 trusted users on the `business` security
tier. Internal APIs, stores, queues, and authorization checks remain tenant-aware, and a
cross-organization access defect remains security-significant even though public multi-tenant SaaS
is deferred.

### Normative launch boundaries

- Production outbound Internet mail uses a supported managed outbound email provider.
- Helix does not operate direct-to-MX delivery.
- Mail is available through the Helix web UI and supported APIs. It does not include a
  Helix-hosted IMAP server.
- Drive is file storage and management for this MVP. Native Docs, Sheets, and Slides editing is
  not a launch feature.
- Chat is protected by TLS, tenant and room authorization, retention, audit, and
  deployment-attested storage encryption. Chat is **not end-to-end encrypted**. Authorized server
  administrators can technically access stored messages.
- Authorized agent reads may execute immediately. Every agent write requires authenticated human
  confirmation by default unless an explicit, audited automation policy exactly bounds the action,
  resource, target, time window or expiry, and rate.
- Untrusted Business uploads remain unavailable until integrity checks and a real malware scanner
  return a clean verdict. Infection and scanner failures remain quarantined; timeout, unsupported
  input, and exhausted retries also remain quarantined.
- The pilot objectives are 99.5% monthly availability, an RPO of no more than 24 hours, and an RTO
  of no more than 4 hours. They are engineering targets, not a contractual SLA.

The production image sets `VITE_HELIX_MVP_ONLY=true`, disables Docs, Calendar, Meet, and Editors in
the runtime configuration, and disables editor migrations. The sibling `helix-editors` checkout is
used only as a reviewed build-time package-contract input. Existing editor source and routes in the
development repository do not make native editing part of the Business MVP.

### Evidence vocabulary

| Term                   | Meaning                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Implemented            | A deterministic enforcement path exists in product code and has focused automated tests.                                           |
| Static deployment gate | Compose, image, configuration, or evidence-contract validation exists but has not demonstrated the final deployed environment.     |
| Live evidence          | A retained, reviewed artifact from the intended production-like services proves that the control operated at runtime.              |
| Release blocker        | The Business pilot must not be represented as production-ready until the required live evidence or operational observation exists. |

## Threat Model, Trust Boundaries, and Assumptions

### Security assets

The primary assets are:

- user identities, sessions, OAuth credentials, agent credentials, app passwords, MFA assurance,
  and provider secrets;
- organization membership, roles, room membership, tool scopes, feature flags, credential policy,
  and automation policy;
- mail bodies, headers, attachments, recipient metadata, drafts, outbound queues, provider events,
  and suppression state;
- Drive object bytes, encryption metadata, versions, share grants, public-link secrets, scan state,
  and content hashes;
- Chat messages, attachments, presence, retention policy, exports, and administrative access;
- assistant prompts, retrieved context, memory, tool results, classification, and provenance;
- audit records, hash-chain material, immutable-shipping checkpoints, metrics, backups, manifests,
  recovery keys, and release evidence; and
- application images, source revisions, SBOMs, provenance attestations, and CI credentials.

### Actors and attacker capabilities

- **Unauthenticated Internet attackers** can send SMTP traffic, call public HTTP endpoints, attempt
  WebSocket handshakes, submit provider-webhook-shaped payloads, and guess public share links.
- **Authenticated users** can supply message bodies, filenames, file bytes, Markdown, resource IDs,
  recipients, and search input. A user can be malicious or have a stolen session.
- **Agents and OAuth clients** can propose tool calls and retrieve data within their visible scopes.
  Retrieved Mail, Drive, Chat, memory, and tool output are attacker-controlled data, not authority.
- **Organization administrators** are privileged but remain subject to tenant boundaries, admin
  MFA, confirmation, audit, and release-operating procedures.
- **Infrastructure operators** control TLS termination, encryption at rest, secrets, backup
  destinations, audit destinations, DNS, mail-provider configuration, and evidence collection.
  False attestations or unsafe deployment changes can invalidate application guarantees.
- **Developers and CI** control source, dependencies, paired repository revisions, build contexts,
  workflows, and published images. A compromised dependency, action, build runner, or signing
  identity can cross the supply-chain boundary.

### Trust boundaries

| Boundary                                | Required property and current implementation                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser/client → Caddy → Helix          | Caddy terminates public TLS and proxies only documented paths. Helix parses an exact trusted-origin allowlist, rejects untrusted credentialed HTTP requests and WebSocket origins, prefers secure session cookies for browser sockets, and redacts credential-bearing headers.                                                                                                                                              |
| Authenticator → admin API               | Business admin routes require a short-lived HMAC-SHA256 MFA assertion. The assertion is bound to the independently authenticated actor and organization and to the configured issuer, audience, and `amr=mfa`; malformed, future, expired, overlong, tampered, cross-actor, and cross-organization assertions fail closed. The unsigned `X-Helix-Mfa-Verified` header has no authority and is stripped by production Caddy. |
| Actor/agent → tool registry             | The server resolves one `ToolInvocationPrincipal` containing actor, credential identity, and credential policy for REST, MCP, tRPC, Assistant, and pending execution. The registry applies visibility, tenant, scope composition, authorization, classification, feature, rate, operational-control, confirmation, and audit decisions outside the model.                                                                   |
| Internet SMTP → Mail                    | Recipient identity is resolved through verified receiving domains and mailboxes before persistence. Input is size/rate bounded, authenticated and scanned, deduplicated, and partitioned into tenant-safe copies. Business scanner failure or malware results in durable quarantine rather than delivery.                                                                                                                   |
| Helix → managed mail provider           | Outbound transport is selected per organization and sending domain at dispatch time. Provider secrets are resolved at use time. Signed raw-body provider events are replay-bounded, idempotent, tenant-matched, and can drive bounce/complaint suppression.                                                                                                                                                                 |
| Upload → Drive quarantine → active file | Upload/finalize/scan state is explicit. Size and SHA-256 are verified from stored bytes, and a bounded streaming clamd client supplies content-free scan evidence. Only `active` files can appear in list/search/indexing or be downloaded, previewed, shared, attached, served through WebDAV, or read by agents.                                                                                                          |
| Chat client → room → realtime bus       | HTTP and WebSocket paths require actor/organization and room membership. Bus subjects contain organization and room identity, event payload scope is checked, and production NATS credentials/TLS constrain the application namespace. Presence and fan-out must not reveal non-members.                                                                                                                                    |
| Helix → AI provider                     | Server-derived effective classification is the maximum of input, conversation, memory, retrieved sources, and tool results. Cross-organization context is dropped; retrieved content is structured, bounded, marked untrusted, and cannot change deterministic tool policy. Provider routing and cost limits apply before data leaves Helix.                                                                                |
| Helix → data plane                      | The production Compose contract keeps Postgres, Redis, NATS, Meilisearch, RustFS, Cerbos, and scanners on an internal network with no published host ports. Postgres requires TLS and SCRAM with separate application/migration roles; Redis disables plaintext and uses TLS plus ACL authentication; NATS uses mTLS, an application user, and subject permissions.                                                         |
| Runtime → audit/backup destinations     | Tool outcomes and domain events enter the hash-chained audit store. Production enables the append-only Postgres audit destination; immutable S3 Object Lock and SIEM syslog destinations are configurable. Backup manifests cryptographically bind database and object snapshots, encryption/key-custody metadata, retention, off-host location, object versions, and checksums.                                            |
| Source/CI → production image            | The production Dockerfile uses digest-pinned base images, multi-stage builds, non-root final users, minimized payloads, and read-only runtime checks. CI builds both images, emits SPDX SBOMs, blocks High/Critical Trivy findings, publishes commit-addressed images on `main`, and creates signed provenance and SBOM attestations for the pushed digests.                                                                |

### Invariants

1. Tenant identity is resolved before business logic, and actor, resource, recipient, provider,
   room, pending action, audit, and queue operations must agree on organization.
2. A caller-controlled resource ID, organization ID, mailbox, provider path, bus event, or share
   token never widens authorization.
3. Browser cookies and reusable credentials do not appear in URLs, logs, analytics, error details,
   or evidence artifacts.
4. A Business admin request cannot rely on a client-controlled MFA boolean; it requires a valid
   signed assertion for the authenticated actor and organization.
5. Agent reads execute only after deterministic visibility, scope, tenant, resource, credential,
   rate, and classification checks.
6. Every agent write queues for human confirmation unless a non-self-modifiable automation rule
   exactly bounds tool, action, resources, recipients/targets, active period, expiry, and rate.
7. An agent cannot approve its own action. Approval preserves the original requesting principal,
   canonical input hash, policy version, organization, credential state, and exactly-once claim.
8. Every tool attempt receives one content-free registry audit outcome. Business-critical pending,
   destructive, external, credential, permission, and policy changes fail closed if that outcome
   cannot be persisted.
9. Untrusted file bytes are unavailable until stored size/hash verification and a real clean clamd
   verdict. Every retrieval and projection surface applies the same active-state invariant.
10. Mail provider events require valid signatures, bounded timestamps, idempotency, and a matching
    organization/provider/outbound record before they can mutate delivery or suppression state.
11. Chat organization and membership checks apply to list, search, subscribe, send, presence,
    receipts, reactions, pins, attachments, retention, and export paths.
12. Production data-plane services are not publicly exposed. TLS/authentication configuration is
    necessary but does not substitute for live connection, denial, and certificate-rotation
    evidence.
13. Encryption-at-rest flags are operator attestations, not encryption primitives. They may be set
    only after the deployment proves encrypted Postgres storage, object-store SSE, and encrypted
    backups with recoverable key custody.
14. Static tests, mocked integrations, and `not_run` evidence can never be promoted to a live pass.

### Assumptions and exclusions

- The pilot trusts a small organization and its infrastructure administrators, but not arbitrary
  browser input, file content, email, agent output, provider events, or resource identifiers.
- The managed mail provider is responsible for Internet reputation and launch DKIM signing. Helix
  remains responsible for correct provider selection, event authentication, suppression, and
  tenant isolation.
- Server-readable Chat is intentional. A database or sufficiently privileged administrator can
  access message plaintext; this is not an E2EE design.
- Public multi-tenant SaaS, native editor implementation, Helix-hosted IMAP, direct-to-MX delivery,
  E2EE, regulated certification, and untrusted/public in-process plugins are outside the launch
  scope.
- Only reviewed, deployment-trusted bundled connectors may run in-process. Enabling an arbitrary
  plugin creates a code-execution trust boundary that this MVP does not claim to secure. Manifest
  signature metadata and bundle-digest matching are not a substitute for cryptographic publisher
  verification.

## Attack Surface, Mitigations, and Attacker Stories

### Authentication, sessions, origins, and admin MFA

`platform/security/origin-policy.ts` rejects wildcard/reflected origins and credentialed requests
from an untrusted origin. Chat applies the same policy before WebSocket authentication. Browser
sockets use the authenticated session path; cookie-free service clients retain a bounded bearer
handshake. Logger redaction covers authorization, cookies, WebSocket protocol credentials, and the
MFA assertion.

`platform/auth/mfa.ts`, `server.ts`, production assertions, and the Caddy configuration implement
the Business admin-MFA gate. HMAC verification uses a timing-safe comparison; exact claim shape,
issuer, audience, actor, organization, assurance method, issue time, expiry, and maximum
five-minute lifetime are enforced. Production requires a dedicated secret of at least 32 bytes.

The remaining boundary is operational: Helix does not provide native MFA enrollment or challenge.
A trusted upstream authenticator must complete the factor challenge and produce the signed
assertion over TLS. Deploying and live-testing that producer is a release blocker; the verifier
alone is not evidence that users actually completed MFA.

### Tenant isolation and authorization

Organization identity is carried through Mail, Drive, Chat, search, OAuth, MCP resources, pending
actions, audit, and queues. Tools declare scopes and conditional composite scopes;
`platform/permissions/tool-access.ts` computes all scopes required for the parsed call, including
`mail.external` in addition to the base send scope when applicable. Cerbos-backed tool
authorization and domain-specific resource checks add independent gates.

Cross-organization ID guessing, mailbox routing, provider events, share links, room operations,
resource URIs, approvals, and search projections are high-value attacker stories. In-memory tests
and the negative-security matrix cover these paths, but the final real-Postgres tenant matrix is
still required before pilot release.

### Agents and AI

The shared principal builder propagates credential identity and policy to REST, MCP, tRPC,
Assistant, and pending execution. Credential authentication checks revocation, expiry, IP
allowlists, allowed hours, and certificate fingerprint when configured. The registry applies
composite scopes, rate overrides, per-organization agent-write switches, exact per-tool switches,
and global read-only mode.

For an agent, every non-read side effect defaults to `queue-confirmation`.
`platform/tools/automation-policy.ts` allows unattended execution only when a complete rule exactly
matches the tool ID, declared action, concrete resource set, recipients, targets, active window,
expiry, and per-minute/per-day limits. Credential or policy administration cannot self-allow.
Pending actions store a safe preview, canonical input hash, requesting principal, approver policy,
and policy snapshot; approval re-checks identity, organization, credential state, scopes,
visibility, authorization, rate, and input integrity and executes as the requester.

`platform/tool-registry.ts` records denied, pending, executed, failed, and cancelled invocation
outcomes without raw input, output, prompts, message bodies, addresses, filenames, or credentials.
The Assistant derives the maximum classification across all context, rejects cross-tenant
retrieval, bounds and labels untrusted sources, and keeps tool authorization outside model text.
Prompt injection can propose an action but cannot grant scope, confirmation, or automation
authority.

PII-aware classification heuristics exist, but the configured `redactPIIBeforeSend` policy is not
implemented as a deterministic transformation before provider transmission. Provider routing can
block a classification, but allowed cloud-provider requests may still contain PII. This remains a
privacy gap and must be resolved or explicitly accepted with provider/data-handling constraints.

### Mail

Verified receiving domains and mailbox mappings replace Business default-organization routing.
SMTP `RCPT TO` resolution distinguishes permanent unknown-recipient failures from temporary store
failures, and accepted messages are parsed/scanned once then partitioned into isolated
organization copies without cross-tenant envelope-recipient leakage. Deduplication binds
organization, normalized message identity/envelope, and a cryptographic raw-message digest.

Inbound SPF/DKIM/DMARC evidence informs spam/quarantine policy but a user-controlled `From` header
is never treated as identity. SpamAssassin, the shared clamd client, active-content attachment
policy, HTML sanitization, sandboxed rendering, and blocked remote images constrain mail content.
Business malware, scanner outages, and unsafe active attachments enter durable quarantine rather
than mailboxes.

Outbound dispatch resolves a verified sending-domain provider, organization default, or permitted
managed environment fallback for each queued record. Secret values are resolved at call time and
are not cached. Signed Mailgun-compatible raw-body events enforce timestamp/replay windows,
idempotency, provider/organization matching, and bounce/complaint suppression.

The code and local evidence harness do not prove Internet deliverability. A retained provider
sandbox run plus controlled Gmail and Microsoft 365 evidence for SPF, DKIM, DMARC, acceptance,
placement, bounce, complaint, and suppression is still required. No local Mailpit result may be
represented as external evidence.

### Drive file storage

Drive implements a durable upload state machine, tenant-scoped content-addressed storage,
transactional version/quota behavior, lifecycle cleanup, hashed public-link tokens, download
disposition protections, scoped WebDAV, and object encryption policy. Finalize verifies stored
byte size and SHA-256 rather than trusting only client declarations.

`platform/security/scanning/clamd-client.ts` implements bounded streaming clamd `INSTREAM`;
`platform/drive/scan-worker.ts` leases idempotent scan jobs and activates only a real clean verdict.
Business startup rejects the no-op scanner. Infection, unsupported content, scanner errors, missing
scan evidence, byte-count mismatch, timeout, or retry exhaustion never becomes active.

The active-state predicate is enforced at the storage/query boundary and reused by browser routes,
preview/download, direct shares, public links, search/indexing, WebDAV, Mail attachments, Chat
attachments, and agent tools. This prevents a second route from bypassing quarantine.

Production requires SSE-S3 or SSE-KMS upload/copy metadata and an encryption-at-rest attestation,
but the final storage provider must still prove that encryption and tenant key selection operated
as configured. D7 remains a live release gate: clean and EICAR upload behavior across every
surface, multipart and bounded-memory upload, WebDAV, share revocation, dependency restart, and
backup/restore hash comparison need retained evidence.

### Chat

Chat applies exact-origin checks before accepting browser sockets, authenticates the initial
principal, limits authentication grace, connections, frames, and rates, and closes slow consumers.
Room authorization is centralized across REST, tools, WebSocket subscription, sending, presence,
and related operations. Organization-aware subjects and payload validation prevent a forged NATS
event from crossing a tenant or room boundary.

Message content is constrained to plain text or a small sanitized Markdown profile. Raw HTML,
unsafe URL schemes, embeds, and server-side unfurls are disabled. Attachments are authorized and
must remain in Drive's active scan state at send and read time. Retention workers apply
organization/room policy with legal-hold and tombstone behavior; exports and administrative
operations require explicit authorization, rate limits, confirmation, and content-free audit.

The realtime, retention, and fan-out implementations do not establish that a deployment has two
distinct replicas or survives dependency restarts. C6/V3 live evidence must still prove WSS,
non-member denials, cross-replica NATS fan-out, app/Redis/NATS restart identity changes, clean and
EICAR attachment behavior, token-log absence, and the 50-user/100-socket/30-minute load profile.
The separate 24-hour soak has not been satisfied by that shorter load contract.

### Data plane, encryption, audit, and recovery

The production Compose overlay and startup assertions implement private data-plane networking,
file-backed secret handling, Postgres TLS/SCRAM and least-privilege roles, Redis TLS/ACL
authentication, NATS mTLS/user/subject restrictions, private Meilisearch/RustFS/Cerbos/scanner
ports, and a separate one-shot migrator. These are concrete deployment controls, not universal
workload identity: Compose does not provide service identity/mTLS for every internal dependency or
a default-deny application egress policy. Business Helm egress policy also requires
environment-specific allowlist configuration and cluster enforcement.

The primary audit store is hash-chained. Registry outcomes and domain events can be shipped by
leader-gated workers to append-only Postgres, S3 Object Lock, and SIEM syslog destinations.
Production Compose enables the Postgres WORM sink, but it remains in the database failure domain.
External immutable S3 and SIEM are opt-in and need destination-specific retention, access-control,
failure, and ingestion evidence before they can support an immutability or monitoring claim.

The backup contract requires Business backups to include database and object versions, encryption,
non-secret key-custody reference, an off-host `s3://` destination, replication, versioning, at
least 30 days of retention, checksums, and a recovery-set digest. The strict restore contract
requires an isolated database and object bucket, database/object/version/outbound-queue/audit
consistency, sampled object hashes, search reindex, RPO, and RTO observations. These contracts and
scripts are implemented, but a strict off-host disposable restore has not yet supplied final
release evidence for RPO ≤ 24 hours and RTO ≤ 4 hours.

### Images and software supply chain

`infra/docker/Dockerfile` pins base images by digest, uses reviewed build contexts, produces
non-root application and web images, and keeps source, VCS metadata, dependency caches, and native
editor enablement out of the final runtime payloads. `validate-production-images.mjs` inspects and
runs both images with a read-only filesystem and no network.

The production-image workflow generates SPDX SBOMs, runs fail-closed High/Critical Trivy scans,
publishes only commit-addressed images from `main`, and attaches signed GitHub build-provenance and
SBOM attestations to the exact pushed digests. This describes workflow enforcement, not a claim
that the current revision's images passed remotely. The final release packet must retain the
reviewed main-run digests, scans, SBOMs, and attestation bundles. Production dependency-advisory
and full-history secret-scan gates remain pending validation and must not be inferred from the
container scan.

Public or untrusted plugins are not a Business MVP feature. If that boundary changes, in-process
plugin execution, cryptographic publisher verification, migration authority, filesystem/network
access, and rollback require a separate threat model and release gate.

### Implementation versus release evidence

| Surface          | Implemented/static enforcement                                                                                                                                      | Live evidence still required                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Admin MFA        | Signed, actor/org-bound, issuer/audience-bound, short-lived assertion verification; Business startup and route gate                                                 | Deploy and test the trusted upstream MFA challenge/assertion producer                                                             |
| Agent workflows  | Shared principal/policy propagation, composite scopes, IP/hours checks, all-write confirmation, bounded automation, durable approval, audit outcomes, kill switches | A7 OAuth/MCP/human-approval/revocation/prompt-injection trace against the deployed stack                                          |
| Mail             | Tenant-aware receiving domains, recipient partitioning, per-org provider routing, signed provider events, suppression, Business quarantine                          | M7 provider sandbox plus Gmail/Microsoft 365 and production-domain evidence                                                       |
| Drive            | Stored hash/size verification, streaming clamd, fail-closed state machine, active-only availability across every surface, lifecycle and sharing controls            | D7 real scanner/object-store/WebDAV/restart/restore evidence                                                                      |
| Chat             | Origin/session policy, room membership, safe rendering, organization-aware fan-out, retention/export/audit                                                          | C6 two-replica WSS/NATS/restart/load evidence and later 24-hour soak                                                              |
| Data plane       | Private Compose network; Postgres TLS/roles; Redis TLS/ACL; NATS mTLS/user/subjects; static/live evidence harness                                                   | Retained final O2 evidence from the intended production-like deployment and certificate-rotation/restart proof                    |
| Backup/restore   | Encrypted, checksummed, off-host/versioned manifest and strict isolated restore contract                                                                            | O4 live off-host restore demonstrating database/object consistency and RPO/RTO                                                    |
| Failure recovery | Nine-scenario strict runner and release-manifest gate                                                                                                               | V4 disposable live run with user behavior, no-duplicate, alert, and recovery proof                                                |
| Images           | Hardened runtime contract, SPDX/Trivy workflow, digest publication, signed provenance/SBOM logic                                                                    | Green remote main-run artifacts for the exact release revisions                                                                   |
| Rollout          | Runbooks, SLOs, alerts, and evidence schemas                                                                                                                        | 24-hour soak, at least two weeks of dogfood, at least four weeks of private pilot, and an explicit go/conditional-go/no-go review |

## Severity Calibration

Severity is based on realistic impact in the self-hosted Business deployment, including the
tenant-safe architecture even though the first pilot has one organization.

### Critical

- Unauthenticated remote code execution in the Internet-facing API, SMTP parser, preview/scanner
  integration, WebSocket handling, or production image.
- Authentication or authorization bypass granting organization-admin control, arbitrary secret
  access, or unrestricted cross-organization Mail/Drive/Chat access.
- A systemic agent-policy bypass that lets untrusted retrieved content execute arbitrary
  destructive or external actions without confirmation or a matching automation policy.
- A malware-state bypass that publishes arbitrary quarantined bytes across all Drive retrieval
  surfaces and enables code execution or broad compromise.
- A supply-chain compromise that can publish trusted production images or attestations for
  attacker-controlled code.

### High

- Forging or replaying MFA assurance for another actor/organization within the accepted window.
- Reading or mutating another organization's mail, files, rooms, pending actions, provider events,
  suppression records, backups, or audit records.
- Persistent stored XSS that steals sessions or performs privileged actions in the Helix origin.
- Bypassing Drive quarantine on any reachable download, preview, share, WebDAV, attachment,
  indexing, or agent-read path.
- Forging a managed-provider event to suppress recipients or alter another tenant's delivery state.
- Exfiltrating sensitive workspace content to an unauthorized AI provider through a classification
  or routing bypass.
- Loss or silent duplication of acknowledged outbound mail, approved agent actions, or durable
  Chat messages under ordinary restart behavior.

### Medium

- A scoped authorization, rate-limit, or retention bypass affecting a limited set of records
  without privilege escalation or broad tenant compromise.
- Exposure of non-secret metadata that materially aids user, mailbox, room, or object enumeration.
- SSRF constrained to low-value internal endpoints without credentials or code execution.
- Failure to redact PII before an otherwise authorized cloud-provider request when provider use
  and classification policy permit the request.
- Audit, alert, or external immutable-shipping failure that reduces detection or non-repudiation
  but does not itself permit the protected mutation to succeed.
- Availability defects that exceed pilot objectives without causing permanent data loss.

### Low

- Minor information disclosure limited to version/build metadata with no secret or tenant data.
- Localized denial of service that is rate-limited, quickly recoverable, and cannot exhaust a
  shared dependency.
- Security-documentation or operator-feedback defects that do not weaken an enforcement path.
- Issues confined to explicitly disabled development/editor surfaces with no production reachability.

An out-of-scope feature is not automatically low severity. If native editors, public plugins,
multi-tenant SaaS, IMAP, direct-to-MX delivery, or E2EE claims become reachable or advertised, their
security boundaries enter scope and must be assessed based on actual impact.

## Remaining Release Blockers and Accepted Limitations

The implementation is materially ahead of the previous version of this threat model, but the
Business pilot is not yet proven production-ready. The following remain:

1. Deploy and validate the trusted upstream MFA producer; Helix verifies assertions but does not
   enroll factors or perform the challenge.
2. Produce retained live M7, D7, C6, A7, O2, O4, and V4 evidence from production-like services.
3. Attest real Postgres/object/backup encryption and complete the strict off-host restore drill.
4. Implement deterministic AI PII redaction before provider transmission or formally accept and
   constrain the privacy risk.
5. Configure and prove an external immutable audit destination and SIEM where the operating profile
   requires them; Business Compose's Postgres WORM sink is not off-host assurance.
6. Add environment-enforced egress restrictions and workload identity/mTLS where required; the
   current private network and per-service TLS/authentication do not provide universal service
   identity.
7. Validate the production dependency-advisory and secret-scan gates, then retain the exact release
   image digests, SBOMs, Trivy results, and signed attestations from remote CI.
8. Complete the 24-hour soak, two-week internal dogfood, four-week private pilot, and explicit
   production decision.

Public multi-tenant SaaS, regulated-data claims, native editors, E2EE, IMAP, direct-to-MX
operation, and untrusted/public plugins require separate approval and evidence; they are not
shortcuts around these blockers.

## Maintenance

When a security control or launch boundary changes:

1. Update this model, the applicable ADR, deployment documentation, and release evidence contract.
2. Keep implementation evidence separate from live deployment evidence; never convert
   `static_validated`, mocked, skipped, or `not_run` output into a pass.
3. Add cross-organization and failure-path regression coverage for every new resource or mutation.
4. Re-run the repository security scan and record Critical/High disposition before pilot entry.
5. Do not remove a remaining gap because configuration or scaffolding exists; remove it only when
   the enforcement path and required evidence are both present.
