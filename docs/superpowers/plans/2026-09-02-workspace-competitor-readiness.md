# Helix Workspace: Standalone Workspace Competitor Readiness Plan

> **Date:** 2026-09-02  
> **Status:** Implementation in progress after owner authorization on 2026-09-02.  
> **Scope:** `helix-workspace`, with `helix-editors` treated as a separately owned dependency.  
> **Backlog size:** 226 consolidated work items: 50 P0 stop-ship, 131 P1, 43 P2, and 2 P3.  
> **Intent:** Build a secure, multi-tenant, multi-domain, self-hostable workspace that can credibly
> compete with Google Workspace across mail, files, chat, meetings, calendar, contacts, identity,
> administration, governance, migration, and operations—with less code and fewer bespoke systems.

## 1. Executive verdict

Helix is an unusually broad prototype with real implementations, not a mock application. Its
current test suite, type checks, lint, and build all pass. It has credible beginnings in Mail,
Drive, Chat, Meet, Calendar, Contacts, Docs/Sheets/Slides integration, search, audit, policy,
plugins, deployment, and backup.

It is nevertheless **not safe for a private multi-tenant pilot and not yet honest to market as a
Google Workspace competitor**. The reason is not missing polish. Several public request paths let a
caller assert identity, organization, scopes, MFA, or certificate identity; resource authorization
then contains independent failures that expose mail, files, calendars, meetings, and administrative
tools. Row-level security is not active in production transactions, multiple enterprise controls
are UI/configuration façades, uploads and previews cross dangerous trust boundaries, and backup
restore can be both incomplete and destructive.

The right response is not a large rewrite or more abstraction. It is a controlled contraction:

1. remove every spoofable or duplicate trust path;
2. establish one identity, membership, authorization, domain, event, and retention model;
3. enforce tenancy twice—centrally in application policy and structurally in PostgreSQL;
4. replace custom infrastructure/protocol code with mature components where it reduces risk;
5. delete advertised stubs and compatibility paths that have no greenfield customer to support;
6. make every remaining product claim executable as an integration or conformance test.

### Immediate release decision

No external or cross-tenant pilot should begin until every P0 item is closed and the Phase 0 gate
in section 16 passes. In particular, do not expose the current application or Compose profile to an
untrusted network.

## 2. How to read this plan

Each task has two labels:

- **Priority:** `P0` stops any pilot; `P1` blocks a secure private pilot; `P2` blocks credible
  enterprise GA; `P3` is elite-scale/parity work.
- **Evidence:** `P` is proven in current source; `G` is a competitor-grade capability gap; `D` is a
  product decision that must be made before implementation.

Every item states the smallest credible change and an observable exit condition. File references
are starting points, not permission to patch blindly; line numbers will drift.

This plan supersedes the narrower assumptions in
`docs/superpowers/plans/2026-07-28-core-workspace-production-readiness.md`. That plan intentionally
targeted one organization, managed outbound mail, no IMAP, and a smaller feature claim. Those were
reasonable pilot constraints but cannot define a standalone Workspace competitor.

## 3. Audit evidence and current baseline

The audit used three independent source reviews—communications, identity/security, and
Drive/operations—plus a whole-repository minimality review. Existing review documents were treated
as hypotheses and checked against current code rather than copied as truth.

Current verification on the audited commit:

| Check                            | Result                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm typecheck`                 | Passed, 8/8 tasks                                                                    |
| `pnpm lint`                      | Passed, 8/8 tasks                                                                    |
| `pnpm test`                      | Passed: 2,847 tests; 17 skipped                                                      |
| `pnpm build`                     | Passed, 8/8 tasks                                                                    |
| Production dependency audit      | Failed: 83 vulnerable paths / 76 advisories; 1 critical, 49 high, 30 moderate, 3 low |
| Git state after read-only checks | Clean                                                                                |

Scale and complexity signals:

- about 457,000 tracked lines and roughly 662 non-test TypeScript/TSX source files;
- 152 explicit platform HTTP route registrations;
- 69 incremental SQL migration files despite a greenfield product;
- 747 `as unknown as` occurrences, 249 raw `any` occurrences, and 21 lint-disable directives
  across source and tests (directional signals, not automatically defects);
- very large modules: native Sheets editor (11,025 lines), native Slides editor (8,860), PDF
  viewer (5,827), Sheets store (5,615), `server.ts` (4,970), Docs editor (4,387), Drive store
  (3,294), and several 2,000–3,000-line shells/stores;
- the initial web build is reasonable, but password-strength is an 819 kB raw chunk; PDF, DOCX,
  XLSX, and editor dependencies are also substantial and need explicit lazy-load budgets.

Passing unit tests are useful but do not disprove the findings: important suites use SQL fakes,
in-memory policy, or mocked S3, and several real-service suites skip when their corpus/database is
absent.

## 4. Competitive capability yardstick

This is a functional and assurance yardstick, not a request to clone Google's UI or architecture.
Official Workspace documentation establishes that a credible competitor needs, at minimum:

- secondary and alias domains with understood identity limitations and controlled primary-domain
  transitions ([Google multiple-domain guidance](https://support.google.com/a/answer/175747?hl=en-GB),
  [domain setup](https://support.google.com/a/answer/7502379?hl=en-AU));
- delegated administration with granular privileges rather than a single super-admin-shaped role
  ([admin privilege definitions](https://support.google.com/a/answer/1219251?hl=en-uk));
- shared drives with role-specific and inherited permissions
  ([shared-drive roles](https://support.google.com/a/users/answer/12380484?hl=en));
- retention, holds, search, and export across supported data through a Vault-like control plane
  ([Google Vault](https://support.google.com/vault/answer/2462365?hl=en-AU));
- Drive and Gmail DLP, context-aware access, and verified endpoint/device signals
  ([Drive DLP](https://support.google.com/a/answer/9655387?hl=en-na),
  [Gmail DLP](https://support.google.com/a/answer/15517856?hl=en-uk),
  [context-aware access](https://support.google.com/a/answer/12645308?hl=en-eu));
- governed spaces, message history, and meeting security/host controls
  ([Chat spaces](https://support.google.com/chat/answer/7659784?hl=en),
  [Meet security](https://support.google.com/meet/answer/9852160?hl=en));
- optional customer-controlled/client-side encryption for high-assurance customers
  ([Workspace client-side encryption](https://support.google.com/mail/answer/13317990?hl=en));
- documented migration paths for mail, calendar, contacts, and files
  ([Workspace migration service](https://support.google.com/a/answer/6003169?hl=en-GB)).

Helix does not need every long-tail Google feature to launch. It does need a complete and explicit
contract for the foundational cases above, accurate exclusions, and tests proving isolation and
policy enforcement.

## 5. Minimal target architecture

The following invariants are the shortest path to both capability and security:

```text
verified credential/session
          │
          ▼
global identity ── org membership ── assurance/device context
          │                  │
          └──────────┬───────┘
                     ▼
        one typed authorization decision
    (action, resource, tenant, principals, policy)
                     │
          ┌──────────┴───────────┐
          ▼                      ▼
 short app transaction     SET LOCAL tenant context
 + transactional outbox   + FORCE RLS/composite FKs
          │                      │
          └──────────┬───────────┘
                     ▼
 durable worker/state machine → object/search/mail/media provider
```

Design rules:

- One public authentication resolver. No identity, tenant, scope, MFA, or mTLS fact may come from
  an unverified client header.
- One global identity can have many organization memberships. Permissions attach to memberships,
  groups, OUs, resources, or service accounts—not free-form strings on a user row.
- One typed authorization evaluator is called by HTTP, tools, WebSockets, workers, protocols, and
  search. Exact actions replace `admin.*` and role-prefix shortcuts.
- Every tenant-owned relationship has a composite tenant foreign key; every tenant table has forced
  RLS; the application uses a non-owner, `NOBYPASSRLS` role with request-local context.
- One canonical domain aggregate owns normalized, globally exclusive claims and capability states
  for login, mail, aliases, custom hosts, and federation.
- External I/O never occurs inside a database transaction. SQL commits intent plus an outbox event;
  leased, idempotent workers perform storage, index, email, webhook, or media work.
- Content is immutable at ingestion. User-visible mutable state is a projection; revisions,
  retention, holds, evidence, and deletion operate on immutable records/blobs.
- Production-required dependencies have no in-memory/no-op fallback. A tier either has the real
  capability and becomes ready, or does not advertise it.
- Prefer established SMTP edge, S3 SDK, WebDAV/CalDAV/CardDAV parsers, MIME/vCard/ICS libraries,
  WebRTC/TURN components, and sandbox primitives to bespoke implementations.
- Split god files only at capability/security boundaries. Do not add repositories, factories,
  adapters, or interfaces merely to reduce file length.

## 6. Security and trust-boundary backlog (SEC-01–SEC-24)

- [x] **SEC-01 — Delete client-supplied actor/org/scope authentication.** `[P0][P]` Evidence:
      `apps/helix/src/api/actor.ts:50-107` and `server.ts:1378-1400` accept
      `x-helix-actor-id`, `x-helix-org-id`, and `x-helix-scopes`. **Minimum change:** identity comes only
      from a verified session or credential; ingress strips reserved headers. **Exit:** forged-header
      tests return 401 for REST, tRPC, tools, and WebSocket upgrades.
      **Complete:** production identity comes only from verified sessions or credentials; the shared
      root request guard and explicit REST, tRPC, tool, and WebSocket upgrade tests reject forged
      reserved identity headers with 401.

- [x] **SEC-02 — Replace header MFA with real session assurance.** `[P0][P]` Evidence:
      `platform/auth/mfa.ts:12-17,48-59` trusts `x-helix-mfa-verified` while two-factor support is absent.
      **Minimum change:** passkey/TOTP challenge state and a recent, audience-bound assurance timestamp
      live on the server session. **Exit:** a forged header never elevates assurance and privileged
      actions reject stale/no MFA.
      **Implemented:** forged MFA headers remain untrusted and MFA-required tiers fail closed. Better
      Auth's maintained TOTP and encrypted one-use recovery-code flow is enabled with a ten-minute
      challenge, no remembered-device bypass, and account-wide attempt lockout. A successful factor
      binds a timestamp and canonical issuer audience to the exact new/current server-side session;
      setup-time session rotation is taken from the trusted Set-Cookie response rather than stale body
      data. Admin authorization re-resolves that server session, active user membership, active tenant,
      enabled factor, audience, expiry, and a ten-minute freshness window on every request. Missing,
      stale, future-dated, wrong-audience, password-only, failed-factor, or header-only claims cannot
      elevate assurance. Focused migration, response-binding, resolver, policy, and Better Auth tests
      pass.

- [x] **SEC-03 — Authenticate mTLS from the verified peer certificate.** `[P0][P]` Evidence:
      `api/actor.ts:117-155,191-193` trusts a public fingerprint header. **Minimum change:** inspect the
      TLS peer or a signed assertion from an exact private proxy after header stripping. **Exit:** a
      known fingerprint without its private key cannot authenticate.
      **Implemented:** identity is derived from the authorized TLS peer certificate; public fingerprint
      headers are rejected, with spoofing regression coverage.

- [x] **SEC-04 — Close the unverified direct-signup takeover path.** `[P0][P]` Evidence:
      `auth/better-auth.ts:74-115,417-445` can link by email/create actors while generic routes are public;
      the verified flow is separate. **Minimum change:** one invite or verified-domain enrollment
      transaction creates a membership only after address proof. **Exit:** registering a victim or
      pre-provisioned email cannot claim an actor.
      **Implemented:** Better Auth email/password login remains available but its generic signup is
      disabled and verified email is mandatory. Session resolution now fails closed for unverified or
      unenrolled identities and may only link a verified Better Auth identity to an already-provisioned,
      active actor in the selected tenant; it never creates an actor as a login side effect. The
      verified signup path creates the credential/user/actor link in one locked transaction after token
      proof, and focused tests cover victim-email, unknown-user, and unverified-session rejection.

- [x] **SEC-05 — Enforce credential scope ceilings.** `[P0][P]` Evidence:
      `auth/tools.ts:58-89` lets an `admin.agents` holder issue arbitrary catalog scopes.
      **Minimum change:** a dedicated credential issuer can grant only an intersection of issuer,
      tenant, credential-type, and approval policy. **Exit:** a narrow issuer cannot mint admin, delete,
      or cross-product authority.
      **Implemented:** issuance intersects requested permissions with the issuer and credential-type
      ceilings; narrow issuers cannot mint administrator, destructive, or cross-product authority.

- [x] **SEC-06 — Remove Cerbos admin-prefix omnipotence.** `[P0][P]` Evidence:
      `permissions/tool-access.ts:237-243` maps any `admin.*` scope to admin and
      `infra/cerbos/policies/tool.yaml:17-22` grants every action. **Minimum change:** evaluate the exact
      typed permission/resource. **Exit:** `admin.audit` cannot send mail, delete Drive data, or issue
      credentials.
      **Implemented:** prefix-derived roles and the Cerbos administrator wildcard were removed; exact
      typed permissions are required and covered by negative cross-capability tests.

- [x] **SEC-07 — Restrict credentialed CORS and add mutation CSRF defense.** `[P0][P]` Evidence:
      `server.ts:2392` uses `origin: true, credentials: true`. **Minimum change:** exact deployment and
      verified custom origins, deny `null`, enforce Origin and CSRF tokens for ambient-cookie writes.
      **Exit:** an evil-origin browser cannot read or mutate authenticated state.
      **Implemented:** credentialed CORS uses one exact normalized origin set and rejects `null` and
      unconfigured origins. Every unsafe session-cookie request requires both a trusted Origin and a
      timing-safe match between a 256-bit Strict/Secure CSRF cookie and request header. The shared
      browser fetch wrapper bootstraps and attaches the token, including sign-in/out, with server and
      browser tests for missing, forged, originless, cross-origin, and valid requests.

- [x] **SEC-08 — Remove bearer tokens from query strings and WebSocket metadata.** `[P1][P]`
      Evidence: `api/actor.ts:195-235` accepts query tokens; Chat places a long-lived token in the WS
      subprotocol. **Minimum change:** Authorization headers for HTTP and short-lived single-use upgrade
      tickets/cookies for WS. **Exit:** URLs, referrers, handshake logs, and traces contain no bearer
      material.
      **Implemented:** request authentication accepts bearer credentials only from the Authorization
      header; every browser realtime client now relies on its protected same-site session cookie and
      never appends credentials to URLs or subprotocols. Chat rejects unauthenticated upgrades before
      accepting frames and no longer accepts token-bearing auth frames. The non-browser live smoke uses
      an Authorization upgrade header; repository scans and focused server, contract, browser, and
      static-smoke tests cover the leak regression.

- [x] **SEC-09 — Configure the exact trusted-proxy chain once.** `[P1][P]` Evidence: IP restrictions
      and SCIM audit use request/forwarded IP without an exact trusted-proxy policy. **Minimum change:**
      one normalized client-IP resolver trusts configured proxy addresses/hops only. **Exit:** spoofed
      forwarding headers are ignored while real client IP policy works behind ingress.
      **Implemented:** Fastify is the sole forwarding-header interpreter and trusts only explicitly
      configured literal IP/CIDR peers; hostnames, wildcards, hop counts, invalid prefixes, and `/0` are
      rejected. Credential policy, session issuance, tracing, signup, lifecycle, SCIM audit, SAML, and
      Better Auth consume Fastify-normalized address/origin data. Tests prove spoofed headers from an
      untrusted peer are ignored and a real client behind an allowlisted proxy is resolved correctly.

- [x] **SEC-10 — Apply complete browser security headers at app and edge.** `[P1][P]` Evidence:
      Caddy sets only a subset and the app is directly published. **Minimum change:** CSP including
      `frame-ancestors`, Permissions-Policy, HSTS, referrer, nosniff, COOP/COEP where compatible, and no
      production direct app port. **Exit:** automated header tests pass through every supported ingress.
      **Implemented:** application responses and both supported Caddy edges now emit HSTS in production,
      a narrow CSP with `frame-ancestors 'none'` and one deployment-owned Jitsi frame origin,
      Permissions-Policy, no-referrer, nosniff, DENY framing, COOP, CORP, and origin isolation. COEP is
      deliberately omitted because the approved Jitsi/editor resources are not uniformly CORP-aware.
      Caddy no longer forges health responses or exposes its admin endpoint; unit and CI-wired edge
      contract checks cover all headers, and production Helm exposes only internal ClusterIP app ports.

- [x] **SEC-11 — Make production cookies unconditionally secure.** `[P1][P]` Evidence:
      `better-auth.ts:366-372,530-545` derives Secure from a base URL that Compose defaults to HTTP.
      **Minimum change:** require canonical HTTPS external origin and set cookie security independently
      from internal proxy transport. **Exit:** production refuses HTTP origin and always emits Secure,
      HttpOnly, correctly scoped SameSite cookies.
      **Implemented:** production Better Auth configuration now requires an explicit canonical HTTPS
      external origin and refuses credentials, paths, queries, fragments, or HTTP. Both Better Auth and
      the manual session issuer emit the same host-only `__Secure-helix_session` cookie with Secure,
      HttpOnly, SameSite=Lax, and Path=/; development alone retains HTTP-compatible cookies. Focused
      configuration, issuance, and CSRF-cookie tests cover the policy independently of proxy transport.

- [x] **SEC-12 — Centralize secret references and enforce tenant paths.** `[P0][P]` Evidence:
      tenant-config and identity accept caller-supplied Vault paths. **Minimum change:** persist opaque
      handles and build `tenants/{authenticatedOrgId}/...` paths server-side with matching Vault policy.
      **Exit:** tenant A cannot store, read, or probe a tenant B secret path.
      **Implemented:** BYO storage and IdP APIs, UI, schema, and migrations now persist only canonical
      opaque handles; all former Vault-path fields and compatibility aliases were removed. The Vault
      reader alone derives `tenants/{authenticatedOrgId}/{fixedScope}/{handle}`, rejects unsafe runtime
      scope/segment values, and uses a shipped read-only policy limited to single-segment tenant scopes.
      Route, database-shape, resolver, and Vault tests reject cross-tenant paths and traversal.

- [x] **SEC-13 — Remove plaintext long-lived secrets from SQL.** `[P1][P]` Evidence: BetterAuth
      provider tokens, DKIM PEM, and arbitrary provider/IdP JSON are stored in database fields.
      **Minimum change:** prefer KMS/HSM/Vault references; otherwise tenant-scoped envelope encryption
      and redacted typed schemas. **Exit:** a database dump contains no directly usable signing key,
      refresh token, client secret, or storage credential.
      **Implemented:** Better Auth encrypts OAuth tokens and MFA material with versioned authenticated
      envelopes; tenant/purpose-bound AES-256-GCM envelopes protect DKIM and webhook signing secrets;
      mail, IdP, and BYO storage persist only strict public configuration plus opaque tenant Vault
      handles. Migration 0110 invalidates legacy plaintext rows, removes legacy secret columns, projects
      arbitrary JSON to typed public fields, redacts unsafe audit snapshots, and installs database
      constraints against credential re-entry. Focused runtime/migration tests pass (106 tests), the
      migration applies and reapplies against PostgreSQL, adversarial inserts fail, and a post-upgrade
      `pg_dump` contains none of the seeded raw tokens, credentials, signing keys, or inline secrets.

- [x] **SEC-14 — Make Vault access bounded, TLS-only, and renewable.** `[P1][P]` Evidence:
      `platform/secrets/vault.ts:58-115` uses unbounded fetch, permits HTTP, and caches an unrenewed token.
      **Minimum change:** workload identity or TLS/CA-verified client with deadlines and lease renewal.
      **Exit:** rotation, expiry, outage, TLS failure, and 403 recovery fail closed deterministically.
      **Implemented:** Vault requires HTTPS, bounds every read/login/renewal with an abort deadline,
      renews Kubernetes-auth leases, refreshes expired tokens, and performs one authenticated re-login on
      403; focused tests cover TLS policy, outage timeout, rotation recovery, and renewal.

- [x] **SEC-15 — Use one SSRF-safe outbound HTTP client.** `[P1][P]` Evidence: webhooks and BYO
      storage accept arbitrary endpoints and raw fetch/clients. **Minimum change:** HTTPS policy,
      per-hop DNS/IP validation, rebinding/redirect defense, special-range blocking, egress proxy,
      deadlines, size caps, and response redaction. **Exit:** metadata, loopback, RFC1918, IPv6-local,
      encoded-IP, DNS-rebinding, and redirect probes all fail.
      **Implemented:** one Undici-based outbound client now validates every DNS answer and redirect,
      pins the approved address at socket connection, requires HTTPS by default, and rejects private,
      metadata, reserved, encoded-IP, mixed-answer, downgrade, and rebinding targets. It applies total
      deadlines, streaming request/response caps, cross-origin credential stripping, origin-only
      redacted errors, and an explicitly validated/pinned egress proxy. Webhooks, BYO object storage,
      AI/vector providers, mail providers, signup vendor checks, and the isolated preview worker use the
      shared policy. Fifty-six adversarial policy probes plus affected integration suites pass.

- [x] **SEC-16 — Sandbox all untrusted content conversion.** `[P0][P]` Evidence: Office/PDF parsing
      runs in the API process; Chromium uses `--disable-web-security --no-sandbox`.
      **Minimum change:** isolated no-network workers with seccomp, CPU/memory/time/page/cell/archive
      limits and killability. **Exit:** malicious corpus and zip-bomb tests cannot compromise or exhaust
      API pods.
      **Implemented:** Drive previews and Docs/Sheets/Slides conversions now use a dedicated non-root,
      no-egress converter with RuntimeDefault seccomp, read-only filesystems, dropped capabilities,
      bounded tmpfs/CPU/memory/PIDs, digest-pinned images, strict input/output/page/cell/archive limits,
      bounded ZIP decompression against forged metadata, total deadlines, and process-group killability.
      Production fails closed without the worker; unsafe in-process parsers and Chromium no-sandbox paths
      were deleted. Focused malicious/resource tests pass, including archive-bomb and timeout cases.

- [x] **SEC-17 — Isolate active-content previews on a cookieless origin.** `[P0][P]` Evidence:
      `server.ts:2720-2886` serves uploaded HTML and unsanitized Mammoth HTML inline on the application
      origin. **Minimum change:** strict sanitizer plus opaque preview origin/sandbox CSP; force download
      for unsupported active MIME. **Exit:** preview content cannot read storage/cookies, navigate the
      parent, call authenticated APIs, or make unapproved network requests.
      **Implemented:** raw HTML, SVG, XML, MHTML, JavaScript, CSS, and WebAssembly are forced to
      attachment/octet-stream across authenticated content, preview, public-share, and WebDAV routes.
      Generated Office and placeholder HTML passes an allowlist sanitizer and is emitted only with an
      opaque-origin CSP sandbox denying scripts, same-origin, forms, navigation, frames, workers,
      objects, images, and network; focused adversarial tests cover event/script/API/navigation vectors.

- [x] **SEC-18 — Cryptographically verify plugin artifacts.** `[P0][P]` Evidence:
      `plugins/loader.ts:515-535,592-603` accepts nonempty/syntactically plausible Sigstore identity.
      **Minimum change:** verify artifact digest, certificate chain, identity allowlist, Rekor inclusion,
      freshness, and revocation. **Exit:** forged bundle, altered artifact, self-signed cert, and
      untrusted identity all fail installation.
      **Implemented:** Helix recomputes and catalog-pins the exact SHA-256 artifact digest, then uses
      maintained Sigstore verification for Fulcio identity/certificate trust, certificate-transparency
      evidence, and Rekor inclusion. A server-owned allowlist pins the exact HTTPS issuer plus email or
      URI identity; the signed catalog enforces issue/expiry, and local key/publisher revocation fails
      closed. Enterprise and sovereign startup require an operator-mounted trust file (with local TUF
      root/mirror support for sovereign installs). Focused tests reject altered digests, forged proof
      bundles, revoked publishers, and untrusted identities; Helm validation covers both strict tiers.

- [x] **SEC-19 — Derive plugin trust from a signed server catalog.** `[P0][P]` Evidence:
      `plugins/tools.ts:25-30,407-447` lets callers claim `official`, and omitted allowlist makes all
      official. **Minimum change:** remove source from input and default unknown artifacts to untrusted.
      **Exit:** no sideloaded plugin can bypass confirmation or claim first-party status.
      **Implemented:** tool, HTTP, and admin UI inputs no longer accept a source claim. Official status
      requires an exact ID/version/digest entry in a currently valid Ed25519-signed server catalog;
      every unknown artifact defaults to sideloaded/untrusted.

- [x] **SEC-20 — Execute plugins outside application authority.** `[P0][P]` Evidence:
      `plugins/loader.ts:234-264` dynamically imports arbitrary code in-process; manifest permissions
      are descriptive. **Minimum change:** worker/container/WASI isolation with capability-mediated
      APIs, scoped secrets/egress, quotas, and termination. **Exit:** malicious ungranted filesystem,
      environment, network, and process access is technically impossible.
      **Implemented:** executable connectors now run one-per-process under Node's deny-by-default
      permission model with no environment, no network, no child processes/native addons, no writable
      filesystem, and read access only to their already verified bundle. A restrictive module loader
      blocks built-ins and bundle escape while a narrow RPC surface permits only webhook format/render
      and source/verify capabilities; secrets reach only the exact verifier invocation and egress stays
      in the trusted SSRF-safe host. Requests/results are size-capped, V8 memory is capped, every action
      has a kill deadline, and app shutdown terminates all sandboxes. The former raw dynamic-import
      runtime, full-authority host API, executable code migrations, and their unused lifecycle helpers
      were deleted. Adversarial tests prove filesystem, environment, network, signal/process, and worker
      access denial plus runaway-code termination.

- [x] **SEC-21 — Prevent plugin path traversal and symlink escape.** `[P1][P]` Evidence: free-form
      plugin IDs and manifest main paths are joined/resolved without root containment.
      **Minimum change:** canonical ID grammar, `realpath` containment, reject absolute/`..`/escaping
      symlinks. **Exit:** traversal corpus cannot import or read outside the artifact directory.
      **Implemented:** plugin and connector loading enforce canonical dotted IDs, directory/manifest
      identity equality, resolved-root containment, and reject absolute, parent, internal-symlink, and
      root-symlink escapes before reading or importing code.

- [ ] **SEC-22 — Rotate and purge committed private keys.** `[P0][P]` Evidence: five valid PEM keys
      are tracked under `infra/meet/config`. **Minimum change:** rotate anything ever deployed, purge Git
      history with coordinated clone invalidation, generate dev keys locally, mount production secrets,
      and add scanning. **Exit:** old keys fail and current/history scans find no usable private key.
      **Progress:** the current tree no longer contains the generated Jitsi keys/configuration; Compose
      uses runtime-generated named volumes and loopback-only ports; static
      validation rejects keys in the config tree. CI now scans every blob in complete reachable Git
      history, validates PEM material cryptographically, and currently fails on the five historical
      keys as intended. A guarded mirror-only purge script, retired-key fingerprints, and the coordinated
      rotation/clone-invalidation runbook are in place. Executing that production rotation and destructive
      force-push window remains before this can be checked.

- [x] **SEC-23 — Eliminate known production secrets and public control planes.** `[P0][P]` Evidence:
      production-mode Compose supplies known credentials and publishes Caddy admin, databases, queues,
      search, storage, Cerbos, scanners, and observability. **Minimum change:** split dev-only Compose;
      enterprise deployment accepts external secrets and exposes only intentional HTTPS/SMTP/media
      ingress. **Exit:** production boot rejects placeholders and external port scan shows only the
      documented surface.
      **Implemented:** Compose is explicitly local-development-only and binds every published port to
      loopback. The production Helm path now requires one canonical HTTPS origin plus external
      Better Auth and database Secret references, rejects inline database credentials, and renders
      only `ClusterIP` services behind deny-by-default policies. Its validation gate rejects known
      development credentials, `NodePort`/`LoadBalancer` control planes, insecure origins, and missing
      secret references; application startup independently rejects all repository-known placeholder
      values before opening the service. SMTP and media ingress remain explicitly operator-managed
      gateways rather than accidental application-chart exposure.

- [x] **SEC-24 — Bound and stream request bodies.** `[P1][P]` Evidence: `server.ts:947-954` permits a
      global 128 MB JSON body, and several flows base64 whole files. **Minimum change:** small per-route
      limits plus direct/presigned streaming for content. **Exit:** oversized/slow requests do not cause
      proportional API or browser memory growth.
      **Progress:** both supported Caddy edges enforce bounded headers, route-class request sizes and
      finite request/upstream lifetimes, with live smoke coverage for oversized, slow and concurrent
      abusive requests. Fastify now caps ordinary bodies at 2 MB, request receipt at 30 seconds and
      WebSocket messages at 2 MB; OAuth, signup, SCIM, DAV and signed webhook endpoints apply smaller
      aggregate limits. Office imports and mail attachments now submit authorized Drive object IDs,
      browser uploads go directly to presigned storage, and server-side import reads stop at declared
      and observed byte ceilings. Focused tests prove rejection before persistence and bounded stream
      reads. Drive finalization now strictly rejects inline bytes: clients upload directly to the
      presigned storage URL and submit only immutable metadata. Focused verification passed 91 app
      request/import/API tests, 63 web API tests, the mail attachment test, 16 Drive tool tests, web and
      contracts typechecks, scoped lint, shell syntax validation, and a repository search for the
      removed finalization field.

## 7. Identity, tenancy, RBAC, directory, and domains (IAM-01–IAM-30)

- [x] **IAM-01 — Separate global identity from organization membership.** `[P1][P]` Evidence: an
      actor has one `orgId`, and linked email/actor resolution is global. **Minimum change:** canonical
      identity subjects plus many memberships, each with status, roles, OU, guest type, and lifecycle.
      **Exit:** one verified identity switches between two orgs with distinct, independently suspended
      authority.
      **Implemented:** canonical global subjects, immutable provider-subject links, and tenant-local
      memberships now separate authentication identity from product authority. Memberships carry
      lifecycle status, roles, OU, and guest type behind composite tenant constraints and forced RLS;
      every newly provisioned human actor receives one automatically. BetterAuth resolves the exact
      requested organization membership, and a live constrained-role test proves one verified subject
      can enter two organizations with different scopes while suspension of one leaves the other active.

- [x] **IAM-02 — Make identity linking transactional and unique.** `[P1][P]` Evidence:
      `auth/better-auth.ts:74-119,152-163,211-294` splits lookup/link writes and ignores zero-row races.
      **Minimum change:** unique `(provider, subject)` and serializable activation transaction.
      **Exit:** concurrent first logins create exactly one subject link and membership.
      **Implemented:** one database activation function owns provider linking and membership selection,
      with provider/email transaction locks and unique provider, subject/org, and actor bindings. The
      BetterAuth store runs it in a retrying serializable transaction (or the already-open request
      transaction); the migration deletes the obsolete single-actor `user.actor_id` column and runtime,
      seed, verification, MFA, and SCIM paths use memberships instead. Authentication
      fails closed for suspended subjects/memberships. A real concurrent first-login test through the
      `NOBYPASSRLS` app role creates exactly one link and returns the same tenant actor to both callers.

- [x] **IAM-03 — Run every request/job under real PostgreSQL tenant context.** `[P0][P]` Evidence:
      `withTenantPostgresContext` has no production caller. **Minimum change:** request and job units use
      short transactions with `SET LOCAL helix.org_id`. **Exit:** deliberately omitted org filters still
      cannot cross tenants.
      **Complete:** the shared PostgreSQL client now binds request work to a transaction-local tenant
      context, adds authenticated actor context, and gives workers the same explicit tenant transaction
      primitive. Live app/worker-role tests prove unfiltered queries cannot see another tenant and no
      context exposes no tenant rows.

- [x] **IAM-04 — Use a non-owner `NOBYPASSRLS` application role.** `[P0][P]` Evidence: Compose uses
      the database owner and RLS is only enabled, not forced. **Minimum change:** separate migration,
      app, read-only, and worker roles; `FORCE ROW LEVEL SECURITY`. **Exit:** app/worker roles cannot
      disable or bypass tenant policy.
      **Complete:** migrations and deployment contracts separate the migration owner from constrained
      app, worker, and read-only roles. Runtime boot rejects unsafe identities; live tests prove app and
      worker cannot own tenant tables, assume the owner, disable RLS, or bypass forced policies.

- [x] **IAM-05 — Fix or delete the backwards per-tenant role model.** `[P0][P]` Evidence:
      `tenancy/postgres-roles.ts:51-79` grants the app role to the role it expects to assume.
      **Minimum change:** preferably one constrained app role plus tenant GUC; otherwise correct role
      membership. **Exit:** integration tests prove entry into restricted context and no return to owner.
      **Complete:** the backwards per-tenant role machinery is deleted. A live PostgreSQL test proves a
      direct `NOBYPASSRLS` app login enters transaction-local tenant RLS context, cannot write another
      tenant, cannot retain the GUC after commit, and cannot assume or return to a tenant-table owner.

- [x] **IAM-06 — Protect every tenant table with schema CI.** `[P0][P]` Evidence: migration 0033
      covered only tables existing then; many later org tables lack RLS. **Minimum change:** each schema
      migration defines ENABLE/FORCE/policies; CI enumerates all `org_id` tables. **Exit:** any uncovered
      table fails CI and live cross-tenant tests.
      **Complete:** the canonical migration forces one tenant policy onto every existing `org_id` table,
      including editor tables, and production/CI catalog checks discover future uncovered tables. The
      live two-tenant gate passes and deliberately fails after creating an uncovered tenant table.

- [x] **IAM-07 — Add composite tenant foreign keys everywhere.** `[P1][P]` Evidence: actors,
      objects, permissions, messages, folders, grantors, and group/OU relations reference IDs without
      org coupling. **Minimum change:** unique `(org_id,id)` targets and composite FKs/cycle checks.
      **Exit:** direct SQL cannot create any cross-tenant relationship.
      **Complete:** platform migration 0111 catalog-upgrades every tenant-owned FK, adds missing
      tenant-scoped actor references, validates polymorphic permission targets, and rejects Drive folder
      cycles; post-editor migration 0112 closes the four editor FKs created after platform migrations.
      A fresh PostgreSQL 17 run applied all 105 migrations, and the focused migration command passes 22 tests:
      catalog assertions report zero unscoped tenant FKs and zero unbound UUID actor references, while
      direct SQL rejects cross-tenant actor, object, message, attachment, permission, folder, grantor,
      group/OU, and hierarchy-cycle writes.

- [x] **IAM-08 — Replace string scopes with a closed permission catalog.** `[P1][P]` Evidence:
      actor `string[]` scopes and prefix gates allow implicit authority. **Minimum change:** versioned
      typed actions with explicit implication rules and schema validation. **Exit:** unknown permissions
      fail closed and a generated matrix covers every action.
      **Implemented:** one versioned literal permission catalog now drives issuance, OpenAPI, protocol
      scopes, runtime schemas, and authorization. Stored session, OAuth, API-key, and certificate scope
      arrays lose all authority if any value is unknown; local and Cerbos policies reject unknown
      actions before evaluation, and OpenAPI rejects uncatalogued tool permissions. The stale
      `chat.write` alias is removed from seeds, smoke tests, E2E, and capability metadata. A generated
      allow/deny matrix exercises every catalog action, while the Cerbos shape test requires an exact
      action-specific tenant-bound rule for every tool permission.

- [x] **IAM-09 — Build one minimal role/binding model.** `[P1][G]` **Minimum change:** built-in and
      custom roles bind permissions to memberships/service accounts at org, OU, group, or resource
      scope; no inheritance by string prefix. **Exit:** default-deny and separation-of-duty matrix passes
      across two tenants.
      **Implemented:** migration 0114 stores tenant-owned built-in/custom roles, catalog-validated exact
      allow/deny permissions, and composite-FK bindings for active memberships or service accounts at
      structural org, OU, group, and exact resource scope. Session, OAuth, API-key, mTLS, REST, local-tool,
      and Cerbos authorization consume the same fail-closed snapshot; credential grants remain bounded by
      their issued scopes and any matching deny overrides direct or role grants. A fresh PostgreSQL 17
      replay applied all 105 platform migrations, and the live two-tenant catalog/FK/RLS rejection suite
      plus the default-deny, exact-scope, no-prefix-inheritance, and separation-of-duty matrix passed.

- [x] **IAM-10 — Add delegated administration boundaries.** `[P2][G]` **Minimum change:** support
      helpdesk, user, group, domain, security, audit, billing, retention, and service-specific admins,
      constrained by OU/group where appropriate. **Exit:** each delegate can perform only documented
      tasks and cannot self-escalate.
      **Implemented:** migration 0116 adds the nine exact built-in delegate roles, immutable parent-linked
      grants, explicit permission and structural scope ceilings, actor/tenant-bound security-definer grant
      and revoke functions, recursive revocation, and a tenant-isolated append-only grant/revoke log.
      Runtime IAM table writes are revoked; matching denies override direct and wildcard grants through the
      shared authorization path. User, group/OU, domain, identity/security, audit, billing, and mail admin
      surfaces consume that path, with group, OU, domain, and product operations carrying exact resource
      context. A fresh PostgreSQL 17 replay applied all 111 migrations; seven live adversarial tests rejected
      impersonation, permission escalation, cross-tenant principals, parent/peer/domain/product scope
      widening, parent/peer revocation, direct runtime writes, and audit mutation. The focused route and
      policy suite passed 112 tests, SDK and application typechecks passed, and focused lint was clean.

- [x] **IAM-11 — Enforce step-up, approval, and dual control for crown-jewel actions.** `[P1][G]`
      **Minimum change:** recent MFA plus optional second approver for domain transfer, key rotation,
      restore, tenant deletion, legal-hold release, plugin trust, and global credential issuance.
      **Exit:** stale sessions and self-approval are rejected with durable evidence.
      **Implemented:** one fail-closed Fastify pre-handler classifies crown-jewel operations and requires
      server-side recent MFA plus a distinct, equivalently authorized administrator before tenant
      deletion; domain release/primary takeover; IdP creation, mutation, deletion, or primary takeover;
      DKIM/webhook key rotation; retention-hold release; break-glass/privileged IAM grants; plugin trust;
      and global agent/app credential issuance. Approval is bound to tenant, requester, action, canonical
      URL/query/body SHA-256, and a short expiry, then atomically consumed once. Migration 0155 extends
      the existing durable `pending_actions` ledger with database-enforced distinct-actor and one-use
      state; request, rejection, approval, and consumption transitions append to the existing
      tamper-evident audit chain in the same transaction. Existing restore jobs retain their stricter
      recent-step-up plus two-other-approver workflow. Focused tests cover stale assurance, self-approval,
      permission/fingerprint binding, expiry, replay, evidence-write failure, route classification, and
      live PostgreSQL audit hashes; a fresh database replay applied all 143 migrations.

- [x] **IAM-12 — Implement passkeys, TOTP, recovery codes, and secure reset.** `[P1][G]`
      **Minimum change:** WebAuthn/passkeys preferred, TOTP fallback, hashed single-use recovery codes,
      audited administrator reset and protected break-glass. **Exit:** replay, cloning, recovery reuse,
      and reset abuse tests pass.
      **Implemented:** Better Auth's maintained WebAuthn plugin now provides discoverable passkey
      enrollment, authentication, listing, and revocation with required authenticator user verification,
      five-minute one-use challenges, globally unique credential IDs, and database-enforced monotonic
      counters for single-device clone/replay rejection. Maintained TOTP remains the fallback with a
      cross-challenge account lockout. User-visible recovery codes are generated at 80 bits, returned
      once, stored only as SHA-256 digests, and atomically consumed once; an encrypted random bridge
      preserves Better Auth's maintained second-factor/session protocol without storing the user code.
      Enrollment, recovery-code replacement, and factor revocation invalidate sibling sessions.
      Password-reset links are enumeration-safe, expire after 15 minutes, are consumed atomically, and
      revoke every session; production fails closed without reset-email delivery. Administrator MFA
      reset revokes passkeys, TOTP, recovery codes, and sessions, rejects self-reset, appends audit
      evidence, and is covered by the shared recent-MFA/distinct-approver crown-jewel gate. The inert
      security mock was replaced by working passkey/TOTP/recovery controls and login now completes
      passkey, TOTP, recovery, and password-reset flows. Focused UI/server/security suites passed 83
      tests; a fresh database applied all 145 migrations and live tests proved duplicate credential and
      counter replay rejection, recovery-code reuse rejection, session invalidation, reset-token reuse
      rejection, and reset-wide session revocation.

- [x] **IAM-13 — Enforce configured session policy.** `[P1][P]` Evidence: idle, reauth, and session
      limits are stored but runtime uses a fixed seven-day lifetime. **Minimum change:** org idle/absolute
      TTL, device inventory, concurrent cap, revoke-all, and revocation on password/role/status changes.
      **Exit:** policy changes and suspension invalidate active sessions within the declared bound.
      **Implemented:** migration 0121 adds a forced-RLS, composite-tenant session-access row and one
      security-definer policy gate consumed by the canonical Better Auth actor resolver on every
      session-authenticated request. Validated org policy now controls 1–90 day idle and absolute TTLs,
      a 1–50 session tenant-local concurrent cap serialized against login races, and a 1–1440 minute
      recent-authentication bound for admin API/tRPC actions. Better Auth keeps the sole device inventory
      and its maintained list-session, revoke-session, and revoke-all APIs; its non-refreshing 90-day
      envelope permits the org policy to choose the actual shorter lifetime. Password and global identity
      changes delete sessions, while membership, actor authority, IAM binding, and organization status
      triggers write irreversible tenant-local revocation tombstones, including for sessions that had not
      yet visited that tenant. Policy tightening is enforced on the next request, and suspension is
      effective immediately without revoking the same login's access to another organization. A fresh
      PostgreSQL 17 dependency replay through 0119 plus direct 0121 apply installed forced RLS, an
      app-only execution ACL, and all six revocation triggers. Five live adversarial tests cover idle and
      absolute expiry, immediate policy tightening, stale/admin reauth, simultaneous cap enforcement,
      cross-tenant actor substitution/RLS denial, tenant-isolated access, and password/role/suspension
      revocation; 27 focused tests and focused lint passed, and the coordinated full application
      typecheck was green immediately before the unrelated concurrent 0120 test edit.

- [x] **IAM-14 — Complete enterprise SAML and OIDC or hide them.** `[P1][P]` Evidence: SAML exposes
      metadata but no ACS/runtime; admin reports `runtime_pending`. **Minimum change:** signed requests
      and assertions, audience/recipient/InResponseTo/replay/clock validation, cert rollover, OIDC
      state/nonce/PKCE, discovery, domain routing, enforcement, and break-glass. **Exit:** IdP conformance
      and signature-wrapping/confused-deputy suites pass.
      **Complete:** the production path is OIDC-only through the maintained `@better-auth/sso` plugin;
      the bespoke metadata-only SAML route, SAML onboarding/configuration choices, and the fake
      `runtime_pending` test-login control were deleted. Migration 0159 atomically projects only an
      enabled primary tenant IdP with a verified identity/federation domain into Better Auth's runtime
      provider table. It stores no credential material: `private_key_jwt` keys are resolved from the
      tenant Vault scope by an exact organization/configuration/issuer/key-handle binding. Discovery
      origins are trusted only when derived from that verified projection; callback linking requires a
      verified email for an active, pre-provisioned member in the same tenant and JIT remains disabled.
      Better Auth validates the signed token issuer/audience and binds its one-use server-side
      transaction state to the authorization code with S256 PKCE; its maintained OIDC flow does not
      emit a redundant separate `nonce` query parameter. Local owner/admin login remains the recovery
      path. Focused tests cover projection removal/recreation, no stored secret, exact key binding,
      cross-tenant/unprovisioned rejection, official discovery plus state/PKCE initiation, and the web
      domain-discovery redirect. The live PostgreSQL suite passed 4/4, server suites passed 70/70, web
      suites passed 30/30, and web typecheck passed; application typecheck is blocked only by concurrent
      outbound HTTP/S3 DOM iterable changes outside IAM-14.

- [x] **IAM-15 — Implement SCIM Users and Groups end to end or remove it.** `[P1][P]` Evidence:
      mutations return 501. **Minimum change:** filter/pagination, CRUD/PATCH, unique external IDs, ETags,
      idempotency, group sync, deprovision hooks, session/token revocation, and data transfer. **Exit:** a
      standard SCIM conformance suite passes.
      **Complete:** tenant-scoped Users/Groups CRUD and PATCH now provide equality filtering,
      one-based pagination, durable external-ID uniqueness, retry idempotency, ETags/If-Match, and
      atomic group synchronization. Soft deprovisioning revokes sessions and every token/credential
      family, removes grants/memberships, cancels pending actions, and optionally transfers workspace
      ownership to a validated active same-tenant user. Focused protocol and forced-RLS PostgreSQL
      conformance tests cover stale validators, malformed input, cross-tenant injection/rollback,
      external-ID reuse, membership versioning, transfer, and revocation.

- [x] **IAM-16 — Make SCIM credentials and failures governable.** `[P2][P]` Evidence: one token has
      no expiry/overlap/scope/last-use and failed audit is swallowed due to invalid actor/org.
      **Minimum change:** multiple staged credentials, expiry/source policy/last use, and a valid system
      security principal. **Exit:** safe overlap rotation works and every failed request is queryable.
      **Complete:** tenant-scoped SCIM credentials now support independently scoped, expiring,
      source-restricted overlap and revocation; only Argon2 hashes persist, while last-use time/IP is
      updated atomically. Admin issuance reveals plaintext once, and every authentication failure emits
      a low-cardinality metric plus a queryable audit record owned by a valid system security principal.
      Focused unit/protocol and forced-RLS PostgreSQL tests cover overlap rotation, source/scope/expiry,
      last-use, tenant isolation, revocation, and durable failure visibility.

- [x] **IAM-17 — Make groups real cross-product principals.** `[P1][P]` Evidence: admin groups are
      disconnected from Drive, Chat, Calendar, Mail, and RBAC. **Minimum change:** one directory group
      resolver consumed by authorization, sharing, addressing, and policy—or remove the façade.
      **Exit:** membership changes propagate consistently within a measured SLA.
      **Complete:** migration 0161 makes the tenant-scoped `admin_group_members` directory the single
      source of truth. Groups can now hold IAM roles directly; authorization snapshots resolve active
      group membership at request time with deny precedence unchanged. One checked, owner-authorized
      group-resource grant primitive projects effective access into the native Drive, Chat, and
      Calendar access tables, while the existing governed Mail resolver expands mailing-list addresses
      from the same directory membership. Insert, removal, suspension filtering, grant update/revoke,
      and attempts to delete a derived row all converge transactionally, so propagation SLA is the
      committing database transaction rather than an asynchronous cache window. Same-tenant composite
      keys, forced RLS, exact actor context, closed product/role sets, active-member filtering, and
      owner checks reject confused-deputy and cross-tenant grants. A fresh PostgreSQL migration replay
      applied all 149 migrations; live tests prove Drive/Chat/Calendar/RBAC add-remove-readd behavior,
      derived-row repair, revocation, and cross-tenant rejection. The related group, Mail addressing,
      SCIM, RBAC, migration, and live suites passed 48 focused tests, with focused lint clean. The SCIM
      paths were also reduced by 17 unsafe double casts through native typed query generics.

- [x] **IAM-18 — Enforce same-tenant group membership.** `[P0][P]` Evidence:
      `admin/groups.ts:489-529,784-795` accepts arbitrary actor UUIDs. **Minimum change:** service check
      plus composite FK. **Exit:** API and direct SQL reject cross-tenant/deleted actors.
      **Complete:** API/store validation, active-actor filtering, and composite database constraints
      reject cross-tenant group, actor, parent-OU, and group-to-OU references. API and live PostgreSQL
      negative suites reject foreign, disabled, and deleted actors.

- [x] **IAM-19 — Repair OU hierarchy integrity.** `[P1][P]` Evidence: non-composite FKs permit
      cross-tenant references; reparenting prevents only self-parent and leaves descendant paths stale.
      **Minimum change:** `ltree`/closure table or transactional recursive cycle detection and subtree
      recalculation. **Exit:** cyclic/cross-tenant moves fail and all descendant paths update atomically.
      **Complete:** composite tenant-parent and self-parent constraints plus a recursive trigger
      serialize hierarchy writes and reject cyclic or cross-tenant changes. Reparent/rename
      recalculates the entire subtree inside the write transaction; API and live PostgreSQL tests
      prove rejection, rollback visibility, descendant-path publication, and non-leaf delete protection.

- [x] **IAM-20 — Govern service accounts, agents, API keys, and certificates separately.** `[P1][G]`
      **Minimum change:** non-human principals have owner, purpose, expiry, rotation, least privilege,
      usage inventory, and immediate disable; preserve real actor type. **Exit:** every retained
      credential type has issuance-to-revocation tests and accountable ownership.
      **Complete:** migration 0163 hardens the existing `agent_credentials` model instead of adding a
      parallel credential system: each record is tenant-bound to its unchanged `agent` or
      `service_account` actor, an accountable active-user owner, a bounded purpose/label, non-empty
      scopes, and a mandatory expiry of at most 366 days. One shared lifecycle now issues, inventories,
      rotates, and revokes OAuth client secrets, hashed API keys, and normalized SHA-256 mTLS
      certificate fingerprints; plaintext OAuth/API material is returned once and never stored or
      audited. Successful API-key and certificate authentication updates last-use inventory, while
      actor disable, expiry, rotation, or revocation invalidates access immediately; OAuth rotation and
      revoke also advance the existing client epoch. The mutation primitives require exact tenant/actor
      context and atomically append hash-chained `activity` plus a durable outbox event. Credential
      rotation is covered by the shared crown-jewel step-up/dual-approval gate, and linked OAuth-app
      revocation now uses the same governed path. A fresh PostgreSQL replay applied all 149 migrations
      through 0164 (then encountered the concurrent, unrelated 0165 Drive migration syntax blocker).
      The live suite proves all three issuance-to-rotation-to-revocation paths, last-use recording,
      accountable ownership, actor-type and cross-tenant rejection, and nine matching audit/outbox
      events; 72 focused unit/schema tests and two live PostgreSQL tests pass with focused lint clean.

- [x] **IAM-21 — Make app-password scope restrictive, never additive.** `[P1][P]` Evidence:
      `auth/app-passwords.ts:152-178,281-318` unions credential and ambient actor scopes.
      **Minimum change:** credential scopes intersect current membership and prohibit admin/service use.
      **Exit:** mail-only password cannot access Drive/admin even when owner is an admin.
      **Implemented:** app-password issuance now accepts only the canonical app-password catalog,
      authentication rechecks the user's current authority, rejects non-user principals and invalid
      persisted grants, and returns only the credential's scopes instead of unioning ambient access.
      The shared restriction also covers CalDAV; focused tests prove an admin owner's mail-only password
      cannot reach Drive/admin and loses access immediately when current authority is removed.

- [x] **IAM-22 — Finish OAuth production wiring and tenant binding.** `[P1][P]` Evidence: server
      omits the PostgreSQL client store/audit sink and does not compare client org with actor org.
      **Minimum change:** mandatory durable dependencies; distinguish signed global apps from installed
      tenant clients. **Exit:** PKCE works for persisted clients, every rejection audits, and tenant A
      client cannot obtain tenant B subject.
      **Implemented:** OAuth routes have no implicit in-memory client/code fallback and production wires
      the PostgreSQL client, token, and single-use PKCE-code stores plus the security audit sink. Every
      authorization rejection path calls that sink (with structured security logging for pre-tenant
      attempts and tamper-evident tenant audit records once identifiable). Authorization resolves only
      per-tenant client installations—global app catalog metadata is never an issuing client—and checks
      client status, exact redirect, client/user scopes, and actor organization before consent. Token
      exchange independently rejects any code whose organization differs from the installed client;
      focused tests cover durable-dependency fail-closed behavior and tenant-A/client-to-tenant-B denial.

- [x] **IAM-23 — Complete modern OAuth lifecycle.** `[P2][P]` **Minimum change:** server-bound consent
      nonce/CSRF, discovery, durable grants, refresh rotation/reuse detection, issuing-client-bound
      revocation/introspection, client/token revocation epochs, and admin install policy. **Exit:** field
      tampering, cross-client operations, and refresh replay fail.
      **Implemented:** authorization metadata discovery, signed server-bound consent fields, durable
      one-use consent nonces and grants, and tenant-admin install policy now gate authorization. The
      code exchange atomically persists an access token and fixed-lifetime refresh family; every refresh
      is rotated under a database row lock, and reuse revokes all refresh and access descendants in that
      family. Access/refresh lookup, introspection, and revocation are bound to the authenticated issuing
      client (including public clients without weakening confidential-client secret checks). Client
      revoke and explicit secret rotation increment a persisted epoch checked on every token use, while
      same-secret hash upgrades preserve the epoch. Focused tests reject consent-field/signature replay,
      cross-client lookup/revoke/refresh attempts, expanded refresh scopes, and concurrent refresh replay;
      a fresh PostgreSQL migration and real concurrent rotation smoke test pass.

- [x] **IAM-24 — Check active actor, membership, tenant, and issuer on every credential use.**
      `[P1][P]` Evidence: API-key/mTLS lookup and OAuth tokens omit some disabled/revoked state.
      **Minimum change:** one credential-validity query/evaluator. **Exit:** actor, membership, org,
      credential, or OAuth client suspension invalidates every relevant token immediately.
      **Implemented:** one `helix_credential_principal_is_active` database evaluator now binds the
      current actor-membership row to its tenant and requires both an enabled principal and active
      organization. OAuth clients, access and refresh lookup/rotation, API keys, mTLS certificates,
      app passwords, and BetterAuth actor resolution all use it at credential-use time; existing
      per-credential expiry, revocation, and OAuth client epochs remain fail-closed. Durable OAuth
      token hashes are additionally namespaced by the canonical issuer, mismatched-issuer writes are
      rejected before SQL, and the server supplies the same required issuer to discovery, issuance,
      persistence, lookup, introspection, rotation, and revocation. Focused SQL-shape, cross-issuer,
      crypto-equivalence, OAuth lifecycle, API-key/mTLS, app-password, and session tests pass.

- [x] **IAM-25 — Replace arbitrary tenant headers/Host inference with verified routing.** `[P1][P]`
      Evidence: `tenancy/context.ts:117-149` trusts `x-helix-tenant` and the first label of any Host.
      **Minimum change:** exact configured root hosts and canonical verified-domain mapping; private signed
      proxy assertions only. **Exit:** unknown hosts and forged headers cannot select a tenant.
      **Implemented:** multi-tenant resolution now accepts exactly one canonical tenant label beneath an
      explicit trusted root, or an exact globally unique domain whose ownership status is still verified.
      It has no arbitrary-host fallback. `x-helix-tenant` is ignored unless accompanied by a fresh
      HMAC-SHA-256 assertion bound to its tenant, method, URL, and Host; stale, tampered, short-key, IDN,
      user-info, nested-subdomain, local, IP, and unknown-host forms fail closed. Production reuses the
      domain store for routing, derives or accepts configured roots, validates the proxy secret, and the
      Helm chart exposes root-host configuration without placing the optional proxy secret in a ConfigMap.

- [x] **IAM-26 — Create one globally exclusive domain aggregate.** `[P1][P]` Evidence:
      `admin_domains` and `mail_sending_domains` are separate and unique only within an org.
      **Minimum change:** normalized global claim with pending/verified/quarantined/released state and
      capability flags for identity, mail, alias, custom host, and federation. **Exit:** a second org
      cannot claim a pending or verified domain and states cannot contradict.
      **Implemented:** `admin_domains` is now the sole ownership, identity, mail, alias, custom-host,
      federation, provider, and DKIM domain aggregate; the duplicate mail table and routes were deleted.
      Its normalized partial unique claim covers every non-released state globally. Database constraints
      enforce pending/verified/quarantined/released timestamps, verified-only capabilities, valid
      capability combinations, same-tenant provider/alias/DNS/DKIM references, and verified alias
      targets. Verification grants no capability by default; enabling the first secondary identity
      namespace selects its primary atomically. Release preserves audit history and imposes a seven-day
      cross-workspace acquisition cooldown. Fresh-chain migration and live two-workspace
      collision/lifecycle scenarios pass; a populated legacy upgrade preserves verified ownership and
      DKIM links while refusing to trust orphan or cross-tenant mail configuration.

- [x] **IAM-27 — Generate and verify server-owned DNS challenges.** `[P0][P]` Evidence: one mail
      route accepts `verified:true`; admin verification is unwired and lets callers supply expected DNS.
      **Minimum change:** unguessable expiring TXT challenge, asynchronous authoritative lookup, semantic
      record parsing, retry/expiry/audit. **Exit:** posting booleans or preexisting records never proves
      ownership.
      **Implemented:** domain registration creates a 256-bit server-owned TXT value with a 72-hour
      expiry. Verification queries the zone's authoritative name servers, compares semantic multi-value
      DNS answers, rate-limits retries, records attempts, supports audited challenge rotation, and fails
      closed on lookup errors. The caller-controlled mail verification route was deleted; arbitrary DNS
      configuration records cannot change domain ownership, and mail setup requires a verified claim.

- [x] **IAM-28 — Normalize domains with standards-aware validation.** `[P1][P]` Evidence: regexes
      admit malformed, ambiguous, and IP-like values. **Minimum change:** `domainToASCII`, label/public
      suffix/IP/confusable policy, normalized unique key. **Exit:** malformed/Unicode/public-suffix/
      trailing-dot corpus has deterministic outcomes.
      **Implemented:** ownership and mail domains pass through one `domainToASCII` canonicalizer with
      DNS label, IP, ICANN public-suffix, trailing-dot, and conservative IDN/confusable rejection policy,
      then persist lowercase behind a global normalized unique index. The rejection corpus covers IPs,
      empty/invalid labels, public suffixes, Unicode/punycode, and trailing dots.

- [x] **IAM-29 — Make primary-domain transitions safe.** `[P1][P]` Evidence: unverified domains can
      become primary; updates are nontransactional and no partial unique index guarantees one primary.
      **Minimum change:** verified-only atomic transition, exactly-one constraint, dependency checks,
      rename/alias plan, cooldown, rollback, and audit. **Exit:** concurrent updates leave one verified
      primary and dependent SSO/mail identities remain valid.
      **Implemented:** one database transition owns verified-only promotion, serializes concurrent
      requests with a tenant advisory lock, preserves exactly one eligible primary with a deferred
      constraint, rejects capability regressions, records the operator and endpoints, enforces a one-hour
      cooldown, and offers a dependency-checked 24-hour rollback. Re-verification failure or quarantine
      atomically disables the domain and its aliases and promotes a deterministic verified replacement.
      Primary changes do not rename principals, so SSO, mail, and ID-based shares remain stable; the
      documented migration sequence covers deliberate renames. Concurrent promotion, cooldown,
      rollback, SSO/mail continuity, and exactly-one assertions pass against PostgreSQL.

- [x] **IAM-30 — Define multi-domain identity and alias semantics.** `[P2][G]` **Minimum change:**
      document secondary-domain users vs domain aliases, login identifiers, rename behavior, group
      addresses, cross-domain policies, routing, suspended domains, acquisition/release, and collision
      handling. **Exit:** a multi-domain scenario suite covers two orgs, three domains, aliases, rename,
      SSO discovery, inbound/outbound mail, sharing, and deprovisioning.
      **Implemented:** secondary domains are independent identity namespaces; domain aliases preserve
      local parts and canonicalize to one verified secondary namespace. Login, public SSO discovery,
      inbound mailbox resolution, outbound sender authorization, member/group/explicit-alias creation,
      SCIM rename, custom-host routing, quarantine, and release now consume the same semantics. A deferred
      canonical-address guard rejects user/alias/group collisions, including alias-equivalent concurrent
      writes, and active membership is required at routing time. `docs/domain-identity.md` specifies
      cross-domain policy, rename, suspension, acquisition/release, and recovery behavior. The live
      two-workspace/three-domain suite covers automatic and explicit aliases, rename, SAML discovery,
      inbound/outbound mail, ID-stable sharing, deprovisioning, release cooldown, and reacquisition.

## 8. Mail backlog (MAIL-01–MAIL-28)

- [x] **MAIL-01 — Make every mailbox private by construction.** `[P0][P]` Evidence:
      `platform/mail/store.ts:814-850,920-972,1001-1085` filters list/search/get by org but not sender,
      recipient, mailbox owner, or delegate. **Minimum change:** immutable message plus per-recipient
      mailbox copies and one actor-aware visibility predicate backed by RLS. **Exit:** Alice cannot list,
      search, mutate, or fetch Bob's message by known UUID; an authorized delegate can.
      **Implemented:** canonical mail content is immutable and every recipient owns an independent
      delivery/state projection. Forced RLS composes one active-mailbox predicate through mail threads,
      messages, identities, raw sources, attachments, storage objects, drafts, labels, filters, vacation,
      and outbound rows without changing non-mail Chat/Meet semantics. Message attachments now carry
      tenant identity plus composite message/object foreign keys. Owners can grant a time-bounded
      `manager` binding through the permission ledger; delegate-capable tools accept an explicit target
      mailbox, and owner-only grant/list/revoke tools make the capability usable. Direct SMTP enters an
      exact tenant transaction before persistence. A live constrained-role suite proves Alice cannot
      list, search, mutate, self-grant, or fetch Bob's known UUIDs, while an authorized delegate can do
      all four and loses access immediately on revocation.

- [x] **MAIL-02 — Route inbound SMTP by verified recipient domain and mailbox.** `[P0][P]` Evidence:
      `mail/config.ts:71-82`, `server.ts:1812-1823`, and `mail/ingest.ts:99-117` inject one boot-time
      default org. **Minimum change:** resolve every `RCPT TO` through canonical domains/aliases to tenant
      and active mailbox before DATA. **Exit:** simultaneous delivery to two tenants never crosses or
      falls into a default tenant.
      **Implemented:** each SMTP envelope recipient resolves through a narrow verified-domain capability
      to an active primary mailbox or enabled alias before content persistence. Multi-tenant recipients
      split into tenant-bound deliveries, unknown recipients are rejected, and no default-organization
      fallback remains; focused concurrent routing tests prove isolation.

- [x] **MAIL-03 — Resolve outbound provider and credentials per queued message tenant.** `[P0][P]`
      Evidence: `server.ts:1744-1777` constructs one transport for the default org. **Minimum change:**
      dispatcher resolves/caches provider from `outbound.orgId`; global SMTP is optional fallback only.
      **Exit:** two tenants with different providers never use each other's credential, return-path, or
      DKIM identity.
      **Implemented:** dispatch resolves the transport, provider settings, and secret reference from the
      durable queued record's tenant on every send; tenant/provider mismatches fail closed. Tests with
      two simultaneous tenants prove credentials, return paths, and provider selection cannot cross.

- [x] **MAIL-04 — Derive and authorize the From identity.** `[P0][P]` Evidence:
      `mail/tools.ts:65-75,357-365,1005-1029` trusts caller `from`. **Minimum change:** allow only the
      membership's primary address, verified aliases, group/send-as grants, or audited delegation.
      **Exit:** a normal user cannot send as an executive, another tenant, or an external domain.
      **Implemented:** sender identity is limited to the actor's primary address or enabled actor-owned
      alias; spoofed local, foreign, and ambiguous identities fail before transport.

- [x] **MAIL-05 — Reject unknown/disabled recipients during SMTP envelope processing.** `[P1][P]`
      Evidence: the receiver has no RCPT validation and can persist ownerless mail. **Minimum change:**
      recipient callback checks domain, alias, mailbox state, quotas, and policy and returns correct
      250/450/550 results before DATA. **Exit:** invalid recipients do not consume body bandwidth or
      create content/search records.
      **Implemented:** RCPT validates verified routing domains, enabled mailboxes/aliases, policy, and
      effective pooled-storage quota before DATA. Active recipients receive 250; unknown, unverified,
      or disabled recipients receive permanent 550; quota and transient resolver failures receive a
      generic logged 450. SMTP integration proves rejected recipients never reach DATA or persistence.

- [x] **MAIL-06 — Model one message with independent mailbox copies.** `[P1][P]` Evidence: inbound
      delivery resolves only the first recipient. **Minimum change:** preserve envelope To/Cc/Bcc and
      create per-recipient unread/folder/label/delete state without copying raw MIME. **Exit:** multiple
      local recipients see independent state, and Bcc membership never leaks.
      **Implemented:** SMTP groups recipients by tenant and writes one canonical message/attachment set
      plus actor-scoped mailbox state, filters, SSE events, search documents, and reindex records for
      every local To/Cc/Bcc recipient. Bcc is delivery-only, envelope recipients are not persisted in
      visible metadata, and recipient state/search/deletion remains independent without raw duplication.

- [x] **MAIL-07 — Implement RFC threading and ingestion idempotency.** `[P1][P]` Evidence:
      Message-ID, In-Reply-To, and References are parsed but do not choose a thread. **Minimum change:**
      normalized Message-ID indexes, standards-aware reference resolution, provider delivery ID, and
      idempotent raw-message key. **Exit:** replies join the intended thread and redelivery creates no
      duplicate.
      **Implemented:** tenant-scoped unique RFC Message-ID, raw SHA-256, and provider-delivery keys
      resolve one canonical message under ordered transaction locks. In-Reply-To and nearest-first
      References deterministically select a thread only when every recipient already owns it;
      outbound queues persist and emit stable RFC headers. Per-message recipient delivery rows gate
      mailbox state, events, filters, vacation replies, spam routing, and raw-source access, so exact
      retries create no canonical copy or repeated side effect while later local recipients deliver once.

- [x] **MAIL-08 — Preserve immutable raw RFC822/MIME evidence.** `[P1][P]` Evidence: ingestion keeps
      a lossy selected-body projection. **Minimum change:** store bounded raw source with digest and
      parsed projection/version; preserve alternatives, inline parts, signatures, and headers.
      **Exit:** export can reproduce the received message byte-for-byte and reparsing is deterministic.
      **Implemented:** inbound ingest stores one 50 MiB-bounded, SHA-256-addressed RFC822 object per
      canonical message plus a safe hashed MIME projection pinned to its parser/version. Database
      triggers prevent evidence mutation; actor-scoped export verifies size, raw digest, projection
      digest, and deterministic reparse before returning the exact received bytes.

- [x] **MAIL-09 — Stream SMTP DATA to a bounded spool.** `[P1][P]` Evidence:
      `mail/ingest.ts:460-466` concatenates chunks without an effective size/client/time cap.
      **Minimum change:** streaming spool through scanner/parser with message, part, connection,
      recipient, and slow-loris limits. **Exit:** limit+1 returns 552 and abusive clients cannot exhaust
      memory or connection slots.
      **Implemented:** SMTP advertises and enforces a configurable message limit, streams DATA into a
      mode-0600 temporary disk spool while counting every byte, returns 552 at limit+1, and removes the
      spool on every success/failure path before bounded parsing and scanning. The receiver also caps
      concurrent clients, recipients per envelope, inactive sockets, total DATA time, MIME part count,
      individual attachment size, and HTML-to-text work. Focused live-SMTP tests prove oversized content
      never persists and excess recipients are rejected before DATA.

- [x] **MAIL-10 — Fail closed when mail scanning is unavailable.** `[P1][P]` Evidence: scanner
      exceptions are caught and delivery continues. **Minimum change:** tenant policy explicitly
      rejects, defers, or quarantines; secure tiers cannot deliver unscanned mail. **Exit:** ClamAV/spam
      outage never silently delivers under secure policy and raises an alert.
      **Implemented:** inbound ingest now resolves an explicit `deliver` or SMTP-temporary-`defer`
      policy per receiving tenant. Business tenants and every non-personal deployment fail before
      persistence with 451 when spamd or ClamAV is missing, times out, throws, or skips an oversized
      message; personal tenants intentionally retain best-effort delivery. Every configured-scanner
      outage invokes the structured error hook, wired to production logging for alerting. Focused
      tests cover unavailable, absent, and incomplete scanners under fail-closed policy.

- [x] **MAIL-11 — Build a true inaccessible mail quarantine.** `[P1][P]` Evidence: detected malware
      changes folder/classification while attachments remain stored and accessible. **Minimum change:**
      quarantined raw/parts cannot preview, download, search, attach, or enter AI; audited admin release
      rechecks policy. **Exit:** EICAR is inaccessible to the recipient through every API and UI.
      **Implemented:** infected SMTP input now stops before message, attachment-object, delivery,
      mailbox-state, search-event, or AI-event creation and stores only the exact raw bytes under an
      unguessable private quarantine key that has no generic object ID or content route. A forced-RLS
      quarantine ledger denies recipients and read-only database roles while allowing only the tenant
      mail service and scoped mail administrators. Admin listing exposes bounded metadata but never raw,
      body, subject, part, attachment, hash, or storage-key data. Release takes a reclaimable exclusive
      lease, re-resolves current recipients, re-runs fail-closed spam and antivirus policy over the
      immutable bytes, and only then creates the mailbox message; delete cannot race an active release.
      Release and delete require a reason, preserve resolution evidence, report physical deletion, allow
      idempotent retry when storage deletion fails, and emit hash-chained admin audit actions. Focused
      EICAR, unavailable-scanner, scope, response-leakage, search/source/attachment regression, and live
      PostgreSQL RLS/lease scenarios pass.

- [x] **MAIL-12 — Enforce SPF, DKIM, DMARC, ARC, and anti-phishing dispositions.** `[P1][P]`
      Evidence: inbound mail now evaluates mailauth's SPF/DKIM alignment and published DMARC `p`/`pct`
      evidence before mailbox persistence, tags valid ARC forwarding overrides, and applies durable
      tenant feature-flag allow/block and impersonation/lookalike/URL verdict policy. Reject, inaccessible
      raw quarantine, and stored-tag paths have focused boundary tests; published reject/quarantine/none,
      percentage sampling, aligned-authentication, and ARC-forwarding vectors document their outcomes.

- [x] **MAIL-13 — Put a mature Internet SMTP edge in front of the app.** `[P1][G]` Evidence: a
      digest-pinned Docker Mailserver Postfix + Rspamd edge now owns DNSBL/reputation, greylisting,
      Redis-backed rate/duplicate limits, bounded connections/recipients/messages, tarpitting, queueing,
      STARTTLS, invalid-recipient rejection, and abuse logs/reports while Helix retains tenant routing and
      mailbox projection. Submission services are disabled and outbound remains on a separate
      authenticated provider/IP reputation. Static Compose/Postfix/Rspamd and DNS prerequisite checks,
      a live trusted-TLS/relay/size/exact-retry/connection-pressure smoke, and mailbox idempotency tests
      cover the deployment contract without adding MTA behavior to Node.

- [x] **MAIL-14 — Sign outbound mail with tenant-owned, KMS-backed DKIM.** `[P1][P]` Evidence:
      migration `0158` invalidates legacy app-enveloped PEMs and permits only tenant/domain-bound KMS
      ciphertext plus a KMS key reference in SQL. RSA-2048 keys stage as `pending`; exact public-TXT
      verification atomically activates the replacement and retains the former selector as `retiring`
      until audited retirement. SMTP and SES unwrap only the active key at send time and apply it through
      Nodemailer; HTTP providers that cannot preserve the signature fail closed. Focused KMS-command,
      DNS/lifecycle/audit, crown-jewel, provider, migration, and real-message vectors pass, including a
      `mailauth` verification of an aligned RSA-2048 DKIM signature. The runbook documents scoped
      `kms:Encrypt`/`kms:Decrypt` permissions, encryption-context policy, rotation, continuity, and probe
      verification; database backups contain ciphertext and public material, never plaintext private keys.

- [x] **MAIL-15 — Add delivery, bounce, complaint, and suppression lifecycle.** `[P1][G]` Evidence:
      provider acceptance immediately becomes `sent`; no delivery-event model exists. **Minimum change:**
      signed provider webhooks/DSNs, delivered/deferred/bounced/complained states, suppression lists,
      feedback loops, retry class, and user/admin diagnostics. **Exit:** hard bounce changes status and
      prevents repeat sends according to policy.
      **Implemented:** migration `0119` replaces ambiguous `sent` with durable `accepted`, `delivered`,
      `deferred`, `bounced`, and `complained` states and adds tenant-composite event/suppression tables,
      consistent retry-class checks, deduplication, forced RLS, and least-privilege grants. Each provider
      has a separate Vault webhook-secret handle. One bounded ingestion route authenticates the exact
      request bytes with timestamped HMAC before parsing either normalized provider feedback or a signed
      DSN gateway event. Events bind to the exact tenant/provider/outbound handoff, transition status
      without allowing late transient events to overwrite terminal outcomes, preserve diagnostics for
      the existing user outbound view, and atomically suppress every hard-bounce or complaint address.
      Outbound creation checks active suppressions before creating a message/outbox row. Scope-gated
      admin endpoints list events and suppressions and permit only reasoned, audited removal.
      **Verified:** 46 focused mail tests pass, including missing/stale/tampered signature rejection,
      signed normalization, provider replay idempotence, admin access, audit, migration shape, and the
      durable dispatch regression suite; targeted lint passes. A clean PostgreSQL 17 migration through
      `0119` ended at `0119_mail_delivery_lifecycle.sql`, exposed all nine lifecycle states, and proved
      forced RLS on both new tables. A live store proof ingested the same hard bounce twice and observed
      `status=bounced`, one suppression, retained `550` diagnostics, a deduplicated replay, and rejection
      of a subsequent send to that address. MAIL-15 files have no TypeScript errors; the concurrent full
      app typecheck is presently blocked only by unrelated Drive-comment edits.

- [x] **MAIL-16 — Make outbound dispatch durable and recoverable.** `[P1][P]` Evidence: Core NATS is
      ephemeral and a worker crash can strand a row in `sending`. **Minimum change:** simplest choice is
      DB due-row leases plus transactional outbox; otherwise JetStream durable consumers. Add owner,
      lease expiry, idempotency, reclaim, and DLQ. **Exit:** kill injection at every handoff converges to
      one externally visible send.
      **Implemented:** migration `0117` gives each transactional outbound row a stable handoff UUID and
      fenced owner/token/expiry lease. One `FOR UPDATE SKIP LOCKED` claim atomically takes the earliest
      due or stale row and increments its persisted attempt; only the current lease token may complete,
      reschedule, or dead-letter it. Every provider adapter receives the same RFC Message-ID and
      idempotency header on recovery. Scoped admin endpoints list bounded DLQ metadata and replay only
      dead-lettered tenant rows with a required reason and audit event. **Verified:** focused kill tests
      cover crashes before provider handoff and after accepted handoff, prove stale-owner fencing and
      one externally visible delivery, and a live PostgreSQL 17 proof preserved the handoff key while
      reclaiming the lease. App typecheck, targeted lint, and focused mail suites pass.

- [x] **MAIL-17 — Choose one retry scheduler and delete the other.** `[P1][P]` Evidence:
      `next_attempt_at` is written but ignored while the handler sleeps/retries inline.
      **Minimum change:** durable due rows with exponential backoff/jitter and terminal classification;
      no process sleeps. **Exit:** retries survive restart, never run early, and cannot busy-loop.
      **Implemented:** the broker subscriber and inline retry loop are deleted. The database poller runs
      exactly one provider attempt per lease, persists equal-jitter exponential backoff with a positive
      lower bound, and classifies permanent HTTP/SMTP, configuration, payload, and attachment failures
      directly into the DLQ; transient failures stop at the persisted attempt cap. **Verified:** restart
      tests prove a retry is not claimable one millisecond early, becomes claimable exactly when due,
      survives a new worker instance, and reaches the bounded DLQ without a process sleep or hot loop.

- [x] **MAIL-18 — Make attachment ingestion a staged state machine.** `[P1][P]` Evidence: object I/O
      occurs around SQL transactions and same filenames share a key. **Minimum change:** immutable UUID/
      verified-hash keys, quarantine, atomic metadata promotion, outbox cleanup, and orphan reconciliation.
      **Exit:** fault injection creates neither ghost attachments nor permanent orphans, and equal names
      preserve distinct bytes.
      **Implemented:** inline inbound and outbound bytes now pass through one durable
      `pending_upload -> quarantined -> scanning -> clean -> attached` state machine before the message
      transaction receives an object ID. Keys contain a random stage UUID plus verified SHA-256, storage
      is read back for authoritative size/hash/MIME, antivirus is fail-closed, and a database trigger
      atomically permits and promotes only clean objects when the message link is inserted. Pending,
      scanning, and rejected objects are hidden from ordinary object/mail/search reads by RLS. A
      singleton reconciler leases expired non-attached stages through a narrow security-definer claim,
      retries failed deletes, tombstones cleaned metadata, and same-tenant I/O phases retain the
      least-privileged runtime role; explicit service mode is accepted only from an already actor-free
      same-org context. Duplicate inbound delivery and failed message transactions release their stages,
      while a crash at any phase leaves a durable expiry for reconciliation. **Verified:** 15 focused
      tests cover distinct equal-name bytes, scanner failure cleanup, injected delete failure/retry,
      staged-only store linking, missing-ingestor fail-closed behavior, migration contracts, and denial
      of implicit/cross-org service mode; ESLint and full app TypeScript checks pass. A clean PostgreSQL
      17 run applied all 116 migrations, proved pending object visibility `0`, rejected a pending message
      link, proved clean visibility `1` and atomic `attached` promotion, returned `0` for both cross-org
      stage/object reads under `helix_app`, and claimed the expired orphan through the durable cleanup
      function.

- [x] **MAIL-19 — Remove file path and URL attachment inputs.** `[P0][P]` Evidence: public mail tool
      accepts `path`, which Nodemailer can read/fetch. **Minimum change:** accept only authorized,
      scanned object IDs or bounded uploaded content. **Exit:** `/etc/passwd`, `file://`, metadata IPs,
      redirects, and cross-tenant Drive IDs are rejected before transport.
      **Implemented:** filesystem and URL attachment inputs are removed; attachments must be bounded
      content or an authorized Drive object.

- [x] **MAIL-20 — Stream browser compose uploads with aggregate quotas.** `[P1][P]` Evidence: Mail UI
      loads every attachment concurrently as base64. **Minimum change:** direct chunked uploads to staged
      objects, cancellation/resume, per-file/message/org quotas, and server-authoritative MIME/size.
      **Exit:** large selection uses bounded memory and above-policy content is rejected before send.
      **Implemented:** compose now sends `File`/`Blob.slice` bodies directly through the existing staged
      Drive upload protocol: single-part uploads never call `arrayBuffer`, large files use at most three
      concurrent bounded multipart slices, retryable parts retry, ETags are authoritative, and completed
      part state in local storage resumes the same file without re-uploading finished parts. Compose
      supplies an `AbortSignal`, exposes cancellation, aborts on discard/unmount, uploads selections
      sequentially, keeps each completed object in compose state, and trashes a removed attachment;
      abandoned pending uploads remain covered by the existing leased Drive sweeper. Shared contract
      limits cap attachments at 100 and 25 MiB per file/message; client preflight rejects the full
      selection before its first upload. The mail store independently authorizes every unique object in
      one query, requires Drive objects to be scan-promoted `ready`, replaces client MIME with the
      authoritative stored MIME, sums authoritative database byte sizes, and rejects violations before
      creating a thread/message/outbox row. Drive's existing finalizer streams and hashes stored bytes,
      checks declared size, sniffs effective MIME, and promotes only a clean scan. Org quota projection
      now counts pending/in-scan storage reservations under its existing `FOR UPDATE` org lock, while
      finalization charges only the reservation delta, closing concurrent prepare races without
      double-counting metering. **Verified:** 94 focused contract/server/browser tests pass, including
      no-buffer direct and multipart uploads, bounded concurrency, retry/resume/ETag validation,
      cancellation, pre-upload file/message rejection, local byte-field stripping, authoritative MIME,
      aggregate server rejection before message creation, and quota reservation/metering behavior.
      Focused ESLint, contracts/web/app TypeScript checks, and whitespace validation all pass.

- [x] **MAIL-21 — Render HTML mail safely and usefully.** `[P1][P]` Evidence: UI currently presents
      HTML as raw text. **Minimum change:** sanitizer plus isolated renderer, remote-image blocking/proxy,
      link warnings, tracking protection, plain-text/source toggle, and accessible quote trimming.
      **Exit:** a malicious corpus cannot execute/exfiltrate while normal newsletters remain readable.
      **Implemented:** the thread response boundary reuses the existing allowlist sanitizer, removes
      executable/form/embed markup, inline CSS and every image source, restricts links to explicit
      HTTP(S)/mailto destinations, and rewrites even those links to inert fragment targets before the
      browser receives them. Raw HTML is retained only for React-escaped source display, while the
      original MIME plain alternative is now preserved in message metadata for an accurate plain-text
      view. Sanitized newsletters render in a titled opaque-origin iframe with nonce-bound trusted
      bootstrap code, no `allow-same-origin`, and a CSP denying all network, images, forms, frames,
      media and objects. The isolated bootstrap collapses blockquotes and common Gmail quote blocks
      into accessible `details`/`summary` controls, reports bounded content height, and sends link
      intent through a per-render random channel. The parent accepts messages only from that exact
      iframe/window and channel, validates the URL again, and presents an in-app warning before an
      external `noopener noreferrer` link is available. Remote content stays blocked even if scripts
      fail, preventing tracking while headings, tables, lists, formatting and alt text remain readable.
      **Verified:** 67 focused server/browser tests pass, including a malicious HTML corpus, encoded
      and control-character URL attacks, no-network CSP/sandbox assertions, inert source/plain-text
      views, external-link confirmation, and plain-alternative persistence. Focused ESLint, complete
      app/web TypeScript checks, and whitespace validation pass. No schema migration was required.

- [x] **MAIL-22 — Use one typed draft contract and preserve staged attachments.** `[P1][P]`
      Evidence: UI autosaves `{envelope: ...}` while server expects top-level fields, and recovery drops
      attachments. **Minimum change:** shared generated contract, revision/idempotency token, staged object
      IDs, conflict handling, and TTL cleanup. **Exit:** crash/reload restores recipients, subject, body,
      thread, and attachments exactly.
      **Implemented:** the shared `@helix/contracts` schema is now the sole flat client/server draft
      shape; nested-envelope calls are rejected. Saves carry a per-attempt idempotency UUID and an
      optimistic revision, return replays without incrementing, and fail stale updates with HTTP 409.
      Draft rows retain validated owner-visible object IDs and extend clean staged-object expiry, while
      the existing singleton attachment worker now performs bounded, unscoped 30-day draft cleanup.
      Device crash recovery uses the same canonical recipient/body/attachment fields and restores the
      server draft ID/revision, so recipients, subject, body, thread identity and every object reference
      survive reload exactly. A fresh 125-migration database, live replay/stale-write/cleanup cases, 81
      focused contract/server/browser tests, full app/web typechecks, targeted ESLint and whitespace
      validation pass.

- [x] **MAIL-23 — Make mailbox state reversible and retention-backed.** `[P2][P]` Evidence:
      `coalesce` prevents clearing archive/delete/snooze, and the UI promises a 30-day purge with no
      worker. **Minimum change:** explicit operations/tri-state patch and hold-aware trash/retention
      lifecycle. **Exit:** archive/restore/unsnooze round trips and expired unheld content is fully purged.
      **Implemented:** `mail.unarchive`, `mail.restore`, and `mail.unsnooze` now drive explicit nullable
      state transitions through the store, and Archive, Snoozed, and Trash surfaces expose matching row
      and thread-view actions. Trash writes receive an authoritative 30-day purge deadline that is
      cleared on restore; active tenant/thread retention holds and in-flight outbound delivery block
      reclamation. A leader-gated, non-overlapping worker runs bounded `SKIP LOCKED` batches. Each batch
      first removes only the expired mailbox copy, then hard-deletes canonical messages/threads only
      after no other mailbox state or delivery remains. Final deletion preserves quarantine and
      suppression audit facts, keeps Drive-file attachments, and atomically queues only orphaned
      `mail_attachment`/`mail_source` keys in the existing durable leased object-deletion queue before
      removing metadata. Evidence: a
      fresh 127-migration replay; live hold, restore, archive/unarchive, snooze/unsnooze, two-mailbox
      isolation, final metadata purge, and exact object-queue assertions; 99 focused backend/web tests;
      full app/web typechecks; targeted ESLint; and whitespace validation all pass.

- [x] **MAIL-24 — Validate aliases, delegation, forwarding, and group addresses.** `[P1][P]`
      Evidence: alias target accepts arbitrary actor UUID. **Minimum change:** active same-org target,
      verified domain, uniqueness, loop detection, send-as vs receive semantics, delegated mailbox audit,
      and controlled external forwarding. **Exit:** cross-tenant/deleted targets and forwarding cycles
      fail; authorized delegation is explicit.
      **Implemented:** alias targets now require an active same-org member and a unique address on a
      verified mail-enabled domain, with separate receive and send-as modes enforced by inbound and
      outbound resolution. Mailing-list addresses expand once to a bounded, deduplicated set of active
      member mailboxes; the SMTP and quarantine paths preserve that multi-recipient resolution while
      the legacy singular resolver remains compatible. Mailbox delegation requires an explicit owner
      grant and records immutable grant/revoke evidence, including revocation after a delegate is
      disabled. Exact owned forwarding sources, active internal targets, deny-by-default/allowlisted
      external targets, and recursive cycle rejection are enforced at the database boundary. Evidence:
      a fresh 135-migration replay; 5 live database governance cases; 92 focused mail/contract tests;
      app and contract typechecks; targeted ESLint; and whitespace validation all pass.

- [x] **MAIL-25 — Scope indexing, enrichment, mutation, and AI to mailbox visibility.** `[P0][P]`
      Evidence: message-ID-only fetch/enrichment and ownerless inbound indexing can become org-visible;
      thread state accepts guessed IDs. **Minimum change:** every path takes org+actor and the canonical
      mailbox predicate; index authorized principal IDs/version. **Exit:** known foreign IDs leak no
      content, metadata, counts, snippets, or existence timing.
      **Implemented:** indexing, enrichment, mutations, and projections require tenant and mailbox
      ownership; guessed IDs and exact-text probes are covered by negative tests.

- [x] **MAIL-26 — Define client interoperability instead of accidental lock-in.** `[P2][G]`
      **Minimum change:** product decision for JMAP and authenticated SMTP submission first; add IMAP via
      a mature component only if target customers require it. Publish OAuth/app-password/revocation and
      client support. **Exit:** selected standards pass conformance and Apple Mail/Thunderbird/mobile
      scenario tests; unimplemented protocols are not advertised.
      **Implemented:** a separate bounded RFC 6409 submission listener accepts only implicit TLS with
      `PLAIN`/`LOGIN`, revalidates revocable `smtp` app passwords and current send authority, authorizes
      the envelope sender, and preserves the SMTP recipient envelope into the durable outbound queue.
      Real TLS protocol tests cover Apple Mail, Thunderbird, and mobile client profiles plus bad/revoked
      credentials, spoofed senders, attachments, hidden recipients, and lost external-send authority.
      The published support matrix explicitly defers JMAP/IMAP and the dormant `imap` issuance scope was
      removed, so unsupported incoming protocols are not advertised.

- [x] **MAIL-27 — Add user/admin mail operations expected of a primary system.** `[P2][G]`
      **Minimum change:** search operators, rules/filters, vacation response, signatures, scheduled send,
      undo send, blocked senders, allow/block/quarantine, shared mailbox/delegation, routing/catch-all,
      journaling, address rewrite, quotas, and trace tooling—implemented only behind real controls.
      **Exit:** each shipped control has UI/API behavior, audit, failure handling, and end-to-end tests.
      **Progress:** `from:`, `label:`, `has:attachment`, and `has:noattachment` are now parsed and
      applied inside the tenant/mailbox-scoped bounded SQL query instead of being advertised as literal
      text. Compose supports cancelable scheduled delivery up to 366 days using the existing durable
      outbound not-before queue. The routing-rules admin view is now reachable and uses the backend's
      validated `match`/`actionKind`/`action` contract instead of its former incompatible mock-only
      shape; create/update/delete failures are visible and 18 focused web contract/UI checks pass.
      Actor-scoped mail settings now persist a bounded plain/HTML signature, reply-signature policy,
      and normalized sender block list behind forced RLS. `mail.send` and `mail.reply` apply the
      sanitized signature server-side, so API/agent sends cannot bypass it; blocked senders route to
      Spam before user filters or vacation responses. The previously inert Settings controls now load,
      save, report failures, and manage the block list. The migration contract plus 45 focused backend
      and 12 web settings/API checks pass. The admin Operations view now exposes the existing durable
      dead-letter queue, per-message delivery trace, and tenant suppression list; authorized operators
      can replay a failed handoff or remove a suppression only with an explicit reason, with visible
      request failures and the backend's existing audit trail. Twenty focused web contract/UI checks,
      web typecheck, scoped lint, and diff validation pass.
      Inbound routing is now enforced in the SMTP delivery path: exact or explicit domain catch-all
      rules can redirect to a governed user/mailbox, drop, tag, or forward; sender, subject, and bounded
      header criteria are evaluated after one parse in priority order with stop-processing semantics.
      PostgreSQL validates tenant-owned verified domains, active targets, external-forward policy, and
      forward cycles. Forwarding uses a durable unique idempotency key and the shared DLP guard, while
      admin validation/UI now exposes every shipped criterion and action. Fifty-nine focused backend
      mail/routing checks, 20 web checks, both typechecks, scoped lint, the unsafe-cast gate, and diff
      validation pass. The delivery path now records inbound and outbound mail into an explicitly enabled
      tenant compliance journal after its canonical message, thread, attachment, and raw-source records
      exist. Runtime roles cannot mutate journal entries; per-tenant advisory locking produces a hash chain,
      retention and central legal holds block source deletion, the bounded purge skips held evidence, and
      tenant deletion reports retained journal blockers. The Operations API/UI configures retention and
      reports journal state behind RBAC and durable audit. A fresh PostgreSQL 17 database applied all 160
      migrations without skips, and live lifecycle checks prove capture, immutable runtime permissions,
      source-delete denial, expiry purge, and post-purge deletion; 63 focused backend and 20 web checks,
      both typechecks, scoped lint, the unsafe-cast gate, and diff validation pass.

- [ ] **MAIL-28 — Operate deliverability as a measurable product.** `[P2][G]` **Minimum change:**
      domain readiness checks for MX/SPF/DKIM/DMARC/PTR/TLS, reputation/bounce/complaint dashboards,
      queue latency and delivery SLOs, seed testing, postmaster/runbooks, and provider failover policy.
      **Exit:** a release packet proves aligned authentication, abuse response, queue recovery, and
      tenant-isolated metrics without promising Gmail-equivalent global reputation.
      **Progress:** the public readiness gate now verifies MX, forward-confirmed PTR, SPF, the active
      DKIM selector, DMARC, MTA-STS/TLS-RPT, and a trusted SMTP STARTTLS handshake. The external seed
      probe fails closed unless the receiving mailbox reports DMARC plus aligned DKIM or SPF, and its
      JSON is suitable for release evidence. The tenant-scoped admin health view now accepts the full
      durable delivery lifecycle and shows delivery, bounce, and complaint rates alongside the existing
      DMARC dashboard and mail queue/delivery SLO gate. `docs/runbooks/mail-deliverability.md` defines
      fail-closed packet contents, postmaster/abuse response, audited queue recovery, and conservative
      operator-controlled provider failover. MAIL-28 remains open until an operator runs the public
      DNS/TLS and Gmail/Microsoft seeds with real credentials and attaches that release-specific packet;
      static/unit evidence does not claim global reputation or inbox placement.

## 9. Drive, storage, preview, and search backlog (DRV-01–DRV-32)

- [x] **DRV-01 — Require write authority for upload completion and finalization.** `[P0][P]`
      Evidence: `drive/store.ts:618-648` uses a read-level `requireObjectAccess` gate.
      **Minimum change:** require editor/version-write, bind session to initiating actor/object, and
      reauthorize immediately before commit. **Exit:** a reader cannot create a version, replace bytes,
      consume quota, or mutate object metadata.
      **Implemented:** completion is bound to its initiating actor/object, requires editor authority,
      and reauthorizes inside the final transaction.

- [x] **DRV-02 — Add explicit folder `add_children` authorization.** `[P0][P]` Evidence:
      `drive/store.ts:523-527,948-952` requires only read access for upload/child-folder creation.
      **Minimum change:** typed contributor/editor capability honoring inheritance and shared-drive
      policy. **Exit:** readers fail; permitted contributors succeed without gaining delete/manage rights.
      **Implemented:** the closed folder action distinguishes read, contribute, edit, and manage;
      contributors can add children without receiving delete or administration authority.

- [x] **DRV-03 — Secure recursive folder trash.** `[P0][P]` Evidence:
      `drive/store.ts:991-1037` read-authorizes only the root then trashes every descendant.
      **Minimum change:** owner/editor delete decision for root and each inheritance boundary, with an
      atomic reject or documented safe subset. **Exit:** readers and editors facing protected children
      cannot destroy them.
      **Implemented:** recursive trash authorizes every affected folder/file and atomically rejects the
      operation when any descendant is protected.

- [x] **DRV-04 — Verify remote upload size and hash from storage bytes.** `[P0][P]` Evidence:
      presigned/multipart finalize trusts client values for quota, key, version, and audit.
      **Minimum change:** authoritative HEAD/checksum or server-side stream hash before promotion.
      **Exit:** falsified size/hash is quarantined/rejected and cannot evade quota or integrity records.
      **Implemented:** stored bytes are the authority for size and SHA-256 before quota, version, audit,
      deduplication, or promotion state changes.

- [x] **DRV-05 — Close known-hash dedup content capture.** `[P0][P]` Evidence: claimed SHA selects an
      existing tenant blob before attacker bytes are verified. **Minimum change:** verify staged bytes
      first; deduplicate only after ingestion and within the intended security boundary.
      **Exit:** knowing a private file digest cannot materialize that blob under another ACL.
      **Implemented:** staged bytes are verified first and only then deduplicated within the tenant;
      caller-selected blob keys are rejected.

- [x] **DRV-06 — Make quarantine durable and unreadable.** `[P0][P]` Evidence: infected status is
      written then thrown inside the same transaction, so it rolls back; reads check deletion only.
      **Minimum change:** quarantine namespace/state, independently committed verdict, clean-only
      promotion, deny all non-ready reads/share/preview/index/AI. **Exit:** EICAR remains durably blocked
      and is eventually removed.
      **Implemented:** verified malware is copied only into a private tenant quarantine prefix; the
      infected verdict, stripped derived metadata, and source/quarantine/preview deletion jobs commit
      before any byte deletion. Every Drive list/read/share/link/version/comment/PDF/WebDAV/search/MCP
      path and queued AI write now admits ready objects only, quarantine events remove stale search/RAG
      documents, and quarantined objects cannot be re-finalized or reverted to escape the state.
      Immediate deletion failures retain leased, tenant-RLS-scoped jobs that the existing bounded worker
      retries indefinitely—even when virus scans are disabled—while object-store lifecycle expiration is
      the orphan backstop. The EICAR adversarial test proves failed deletes remain blocked and all source,
      quarantine, and prior-preview bytes are eventually removed.

- [x] **DRV-07 — Ban no-op antivirus in production.** `[P0][P]` Evidence:
      `drive/scanning.ts:109-125` implements an explicit no-op. **Minimum change:** secure tiers fail
      readiness without a healthy scanner; add timeout, signature freshness, archive-bomb limits,
      retry/DLQ, and audited override. **Exit:** clean/infected/timeout/outage cases follow policy.
      **Implemented:** production and secure Drive tiers reject a missing/no-op scanner, while
      readiness verifies clamd PING and loaded-signature freshness through bounded TCP requests.
      Oversized and over-expanded, deeply nested, or excessive-entry archives fail closed; the
      bundled clamd also treats encrypted content and daemon-limit overruns as heuristic matches.
      Outages commit an unreadable `scan_pending` object and a tenant-RLS-scoped leased retry job;
      fixed attempts end in DLQ, client polling cannot consume attempts, scanner failures are logged,
      and scan-state transitions are hash-chain audited. An `admin.console.write` actor may reset one
      exact DLQ object only with an explicit reason and atomic Drive audit record; this schedules
      another real scan—never an AV bypass. Focused clean, EICAR, timeout, stale-signature, outage,
      recovery, DLQ, and override tests pass.

- [x] **DRV-08 — Move storage and scanning outside SQL transactions.** `[P1][P]` Evidence:
      resolve, presign, PUT/readback, AV, and preview work occur in long transactions.
      **Minimum change:** persisted upload state machine and transactional outbox/saga with short SQL
      commits and compensation. **Exit:** failure injection at each external boundary converges without
      long locks, orphan rows, or orphan bytes.
      **Implemented:** upload preparation, multipart provider calls, readback/hash/AV, content writes,
      conversion, preview publication, and byte deletion now run between short tenant-RLS database
      phases. A narrowly scoped executor explicitly leaves inherited request ALS before opening each
      fresh `SET LOCAL` transaction, while refusing tenant/actor switching and never exposing raw SQL.
      Durable `pending_upload`/`scan_processing`/`scan_pending`/`upload_expiring` leases and existing
      cleanup jobs make retries and compensation idempotent; failed final writes are removed or queued,
      expired staging rows/bytes are swept, and the clean/infected verdict commits atomically with its
      audit/outbox state. Boundary-injection tests assert resolver, storage, scanner, and converter calls
      never occur in a store SQL phase and that failed preview publication restores state without rows or
      bytes leaking.

- [x] **DRV-09 — Persist, bind, expire, and sweep multipart sessions.** `[P1][P]` Evidence: caller
      returns an unrecorded upload ID/all URLs; completion accepts arbitrary plan/parts; abort is unused.
      **Minimum change:** session records actor/object/key/size/parts/expiry/status, URLs are limited,
      completion idempotent, sweeper aborts stale sessions. **Exit:** cross-actor/replay/wrong-plan/expired
      completion fails and abandoned storage is reclaimed.
      **Implemented:** tenant-RLS migration `0097` persists the actor, object, exact reserved key,
      declared size, bounded part plan, provider upload ID, expiry, completion hash/version, status,
      retry time, and lease. Preparation issues at most 1,000 expiring part URLs; binding or presign
      failures abort immediately, with failed compensation durably retaining the provider ID for the
      sweeper. Completion locks the session, rejects actor/ID/size/part/expiry or replay-payload changes,
      recovers provider-success crashes, and returns the same stored version for an exact replay. The
      bounded tenant worker aborts and deletes stale provider uploads/bytes and database reservations,
      retries failures under a lease, and also reclaims abandoned single-part uploads; an S3 lifecycle
      rule is documented as the process-crash backstop before an upload ID can be bound.

- [x] **DRV-10 — Stream and resume browser uploads without synthetic ETags.** `[P1][P]` Evidence: web
      reads whole files into ArrayBuffer/base64 and fabricates ETag when CORS hides it.
      **Minimum change:** slice directly from Blob, persist resume state, retry/cancel parts, and require
      authoritative ETag/checksum or backend part listing. **Exit:** multi-GB upload uses bounded memory,
      resumes after reload, and missing ETag cannot complete.
      **Implemented:** browser uploads now send `File`/`Blob` slices directly to presigned storage with
      bounded three-part concurrency, bounded retry, and cancellation; no Drive upload path converts the
      payload to ArrayBuffer/base64. File-bound multipart state persists the upload/object IDs, exact
      plan, and completed authoritative part ETags in local storage, so a reload resumes only a matching
      file and plan. Storage responses must expose a nonempty ETag for every part—there is no synthetic
      fallback and completion is impossible without all authoritative values. Focused tests prove direct
      slicing, retry/concurrency bounds, cancellation, reload resume without re-preparation, and
      fail-closed missing-ETag behavior.

- [x] **DRV-11 — Correct blob reference accounting and cleanup.** `[P1][P]` Evidence: finalize,
      revert, and delete count references inconsistently; reserved dedup objects leak; schema lacks
      key uniqueness/nonnegative constraint. **Minimum change:** one reference per immutable version,
      constraints, repair migration, cleanup outbox, and reconciler. **Exit:** property tests keep count
      equal to live references and never delete live content.
      **Implemented:** immutable `drive_versions` rows are now the only blob-reference source: finalize
      and revert add exactly one reference, while purge groups deleted versions by storage key and
      decrements their exact multiplicity. Migration `0104` canonicalizes duplicate same-digest keys,
      queues losing bytes, rebuilds counts from version rows, and adds nonnegative/count and tenant-key
      uniqueness constraints. Advisory locking plus durable in-flight blob reservations closes the
      zero-ref/delete/re-upload ABA race; the tenant reconciler repairs drift from authoritative
      versions, and zero-ref bytes enter the durable deletion queue. Focused same-content, multi-version,
      partial-delete, failed-delete, reservation, and repair-migration tests prove a referenced blob is
      retained and the final reference is the only one that schedules physical deletion.

- [x] **DRV-12 — Enforce trash, recovery, retention, and hold before purge.** `[P1][P]` Evidence:
      an owner can hard-delete active/recent/held-unaware content immediately. **Minimum change:** trash →
      recovery window → privileged purge, governed by retention and holds. **Exit:** active, held, and
      young trash cannot purge; recovery works until policy expiry.
      **Implemented:** migration 0142 gives every file and folder trash transition an enforced 30-day
      recovery deadline, supports explicit retain-until policy, and adds tenant-RLS legal holds with
      bounded reasons, expiry/release attribution, one active hold per resource, and cross-tenant target
      validation. The destructive `drive.delete` capability now rejects active objects, young trash,
      retained content, and active holds before touching versions or bytes; recursive folder purge
      applies the same checks to every folder and file before marking the saga. Restore rejects expired
      recovery windows and clears its deadline atomically. Fresh-chain replay through 0142 and live
      PostgreSQL coverage prove active/young/held/retained denial, a successful restore during recovery,
      and purge only after every protection is released or expired; 51 focused Drive regression tests
      also pass.

- [x] **DRV-13 — Make physical deletion post-commit and recoverable.** `[P1][P]` Evidence: storage
      delete occurs inside SQL transaction before commit. **Minimum change:** transactional tombstone and
      idempotent deletion worker, then physical-deletion proof; retain rollback pointer until verified.
      **Exit:** DB failures never leave a ready version pointing at missing bytes.
      **Implemented:** purge and compensation transactions now commit an idempotent storage-key
      tombstone before returning any deletion work; no object-store delete occurs inside their SQL
      transaction. The tenant worker leases that durable row, treats delete as idempotent, retries every
      storage or follow-up database failure, and records a `completed_at` physical-deletion proof only in
      a fresh post-delete transaction. The tombstone retains the object/key rollback evidence after the
      live rows are removed, and referenced/reserved blob keys are rechecked before deletion. Failure
      injection proves a failed SQL phase performs no delete, while post-commit storage/proof failures
      remain retryable without leaving a ready version pointing at missing bytes.

- [x] **DRV-14 — Serialize version allocation and version previews.** `[P1][P]` Evidence:
      `max(version)+1` races; revert changes bytes/MIME but retains stale preview metadata.
      **Minimum change:** locked counter/unique retry plus idempotency; preview artifacts belong to a
      version and regenerate asynchronously. **Exit:** 100 concurrent writes have unique versions and
      revert never serves another version's preview.
      **Implemented:** version mutation claims/locks the canonical object before allocating the next
      number, and a tenant/object/idempotency unique key makes exact retries return the original version.
      Preview state is stored on its immutable version; reverts strip every old derived preview field,
      publish a pending version-specific state, and enqueue a tenant-RLS `(org, version)` job. The worker
      converts outside SQL and only promotes preview metadata when `latestVersionId` still names that
      version, preventing a late job from overwriting a newer preview. A 100-way serialized-write test
      proves unique monotonic versions, idempotent replay, pending regeneration, and absence of the
      reverted version's stale artifact.

- [x] **DRV-15 — Synchronize trash/restore through one object lifecycle.** `[P1][P]` Evidence:
      recursive folder trash updates Docs but omits Sheets, Slides, and future linked records.
      **Minimum change:** canonical object lifecycle event consumed idempotently by every editor/product.
      **Exit:** Drive and all native editors remain consistent for recursive trash, restore, and purge.
      **Implemented:** one extensible lifecycle registry now handles `trash`, `restore`, and `purge` for
      every Drive object, with idempotent default handlers for Docs, Sheets, and Slides. Single-object and
      recursive-folder paths both call that same handler inside the authoritative object transaction;
      recursive operations carry a `trashRootFolderId` so only the matching tree restores, and purge
      removes linked native records rather than leaving editor tombstones. Folder purge first durably
      marks the entire owned tree, then reuses the normal per-object purge/deletion saga before removing
      folders. Focused registry and recursive trash/restore/purge tests cover all three native editors.

- [x] **DRV-16 — Store stars and view preferences per member.** `[P2][P]` Evidence: a reader mutates
      one global `starred` object flag. **Minimum change:** `(org,membership,object)` preferences.
      **Exit:** one user's star/view state never changes another user's listings.
      **Implemented:** migration 0115 moves stars to presence-only `(org, membership, object)` rows,
      removes and rejects `objects.metadata.starred`, and stores the shared Drive/Docs/Sheets/Slides
      card/list layout on the active membership. Composite tenant foreign keys, forced self-only RLS,
      read-scope tools, and the web query/mutation integration replace local-storage authority. Live
      PostgreSQL tests prove two readable members retain independent stars and layouts and that the
      restricted runtime role cannot forge another member's preference.

- [x] **DRV-17 — Enforce a complete comment permission matrix.** `[P1][P]` Evidence: any reader can
      create, resolve, update, or delete other users' comments. **Minimum change:** commenter create,
      author/editor update/delete, and editor/thread-owner resolution with group/inherited rules.
      **Exit:** exhaustive role × ownership × operation integration tests pass.
      **Implemented:** migration 0120 makes the database the final authority for Drive comment
      mutations. Its effective-role function combines owner, current direct grants, and recursive
      ancestor-folder grants; forced RLS and a mutation trigger then enforce commenter creation,
      author-or-editor edits/tombstones, editor-only anchor rebases, and editor-or-root-thread-owner
      resolve/reopen. Comment identity and stored metadata are immutable, parent replies are bound to
      the same tenant/object, and status changes require matching moderation actors and times. The tools
      require only `drive.read`, leaving the object ACL—not a coarse write scope—as authority. Live
      PostgreSQL tests cover owner/editor/commenter/reader and inherited-commenter roles against own and
      other authors, replies, direct restricted-role SQL, invalid initial state, and cross-object parents.

- [x] **DRV-18 — Preserve comment revisions and evidence.** `[P2][P]` Evidence: delete physically
      removes rows and comment listing is unbounded. **Minimum change:** immutable revisions/tombstones,
      moderation metadata, cursors, retention, legal export, mentions, and notifications.
      **Exit:** edits/deletes remain auditable but are hidden appropriately in normal UI.
      **Implemented:** migration 0120 adds monotonic revisions, resolver/deleter/changer attribution,
      tombstones, and a full immutable snapshot for every create/edit/re-anchor/resolve/reopen/delete.
      A security-definer capture trigger is the only runtime append path; application roles cannot
      insert, rewrite, delete, or truncate evidence. Evidence follows the governed parent-object purge
      lifecycle, while ordinary lists always hide tombstones. Normal and editor-only evidence lists
      use opaque keyset cursors with a hard 100-row ceiling, and every evidence page is audited.
      Create/update mention notifications and reply notifications are access-filtered and deduplicated,
      while all comment state changes append activity/outbox audit events. Fresh-chain replay through
      0120 plus live tests prove cursor continuity, tombstone hiding, preserved bodies and moderation
      actors, editor-only export, unforgeable evidence, update-time mentions, and restricted-role RLS.

- [x] **DRV-19 — Harden public share-link capabilities.** `[P1][P]` Evidence: plaintext bearer
      tokens permit editor/commenter roles and ignore password/domain/download/DLP policy.
      **Minimum change:** hashed high-entropy token, reader-only anonymous access, optional password/
      expiry/one-time/domain rules, classification and tenant policy at create/use. **Exit:** DB compromise
      yields no usable URLs and prohibited content cannot be shared.
      **Implemented:** migration 0141 replaces stored bearer URLs with SHA-256 digests of 256-bit
      random tokens and removes the plaintext column and elevated anonymous roles. Owner-only creation
      supports Argon2id passwords, expiry, atomic one-time consumption, authenticated-domain limits,
      and download policy. Both creation and every use re-evaluate resource classification, tenant
      external-sharing policy, readiness, deletion, and blocking DLP state. A narrowly scoped
      security-definer digest lookup crosses forced RLS only to discover the owning tenant; all object
      and policy reads then run inside that tenant context. Listing never returns bearer material;
      password links use a browser-native Basic challenge without putting passwords in URLs.
      Fresh-chain replay through 0141 and a least-privileged live PostgreSQL test prove hashing,
      reader-only access, password/domain enforcement, one-time consumption, and RLS-safe resolution.

- [x] **DRV-20 — Audit and throttle every share-link event.** `[P1][P]` Evidence: resolve/read/revoke
      lack complete access audit and abuse controls; missing bytes can return HTTP 200 metadata.
      **Minimum change:** immutable create/access/download/revoke events, per-IP/token limits, safe cache
      policy, integrity error states. **Exit:** brute force throttles without validity oracle and corrupt
      backing content never produces success.
      **Implemented:** create, allowed/denied access, download, integrity failure, and revoke append to
      a tenant-RLS, update/delete-proof evidence table through one security-definer function. Durable
      atomic token and pseudonymous client rate buckets run before token lookup, so valid and invalid
      tokens have the same throttling surface. Public responses are private/no-store/nosniff, active
      content is forced to download, and the server verifies storage HEAD length plus available SHA-256
      metadata before atomically consuming the capability. Missing or mismatched bytes now return 404,
      never a successful metadata placeholder. Focused route/store/API tests pass (77 tests across
      the selected suites), and the live migration test proves immutable audit evidence and fail-closed
      one-time reads.

- [x] **DRV-21 — Build one inherited ACL engine and shared-drive ownership model.** `[P1][G]`
      Evidence: folder access is direct owner/direct permission only. **Minimum change:** user, group,
      domain, guest, and link principals; inherited roles and explicit exceptions; organization-owned
      shared drives; move/ownership-transfer rules. **Exit:** nested move and membership-change matrix
      preserves documented permissions without orphan owners.
      **Implemented:** migration `0165` makes `helix_drive_effective_role` the one recursive evaluator
      used by file/folder reads, search projection, comments, WebDAV audiences, workflows, and recursive
      trash/restore/purge gates. Direct actor grants cover users and provisioned guests, IAM-17's live
      group graph now covers files and folders, verified/allowlisted domain grants obey external-sharing
      expiry policy, hardened bearer links remain exact-resource capabilities, and descendant actor,
      group, or domain exceptions suppress only inherited grants above the exception. Shared-drive rows
      are tenant-RLS, organization-owned roots: conversion and subsequent creates remove individual
      ownership at the database write boundary while preserving manager/editor roles. Atomic file and whole-subtree move functions
      reject cycles, immovable roots, and cross-ownership-boundary moves without manager access; leaving
      a shared drive assigns a real active owner, while ownership workflows reject shared-drive content
      and external/suspended recipients. The `drive.folder.move` tool exposes nested moves. The complete
      Drive unit suite passes (210 tests; 8 environment-gated tests skipped), along with focused migration
      contracts, lint, and the repository's unsafe-cast budget; production Drive store/workflow code adds
      no unsafe double casts. The runnable PostgreSQL matrix covers group membership churn, domain
      principals, exceptions, nested moves, owner normalization, and transfer rejection. Fresh PostgreSQL
      17 replay `helix_workspace_replay_20260903_1437` applied all 156 migrations through `0169`, including
      the corrected `0165`, with zero skips.

- [x] **DRV-22 — Support large files end to end with bounded streaming.** `[P1][P]` Evidence: byte
      sizes are 32-bit integer and downloads/ranges materialize the whole object. **Minimum change:**
      bigint-safe API/schema, configured limits, HEAD/ranged GET, response backpressure/cancellation,
      ETag and conditional requests. **Exit:** a 20 GB range reads only requested bytes with bounded RAM.
      **Implemented:** migration `0104` promotes object, version, multipart-session, and recording-upload
      sizes to bigint with nonnegative constraints, while API mapping validates JavaScript safe integers.
      Storage clients now expose HEAD, streaming GET, ranged GET, and server-side copy; tenant wrappers
      preserve those operations. Authenticated, share, preview, and WebDAV downloads use Node stream
      backpressure and request-abort cancellation with strong ETags, conditional requests, and exact
      ranges; scanning/hashing, preview conversion, MCP reads, and outbound-mail attachments are bounded
      or rejected before buffering. A logical 20 GiB integration fixture proves HEAD opens no body and a
      1 KiB range opens and transfers only those requested bytes; S3 and MCP fixtures independently prove
      large-object metadata/range paths stay bounded.

- [x] **DRV-23 — Implement strict HTTP range behavior.** `[P1][P]` Evidence: permissive `parseInt`
      accepts malformed ranges and multi-range falls back to full-file 200. **Minimum change:** strict
      grammar and standards-compliant reject/support behavior without amplification. **Exit:** malformed,
      overflow, suffix, multi, conditional, and unsatisfiable corpus matches RFC expectations.
      **Implemented:** one strict safe-integer byte-range grammar handles bounded, open-ended, and suffix
      requests; malformed, overflowing, multi-range, and unsatisfiable requests return an empty 416
      rather than amplifying into the whole object. Every buffered content response now carries a strong
      content-derived ETag and Last-Modified validator, honors If-None-Match, and applies Range only when
      If-Range matches. Focused parser and injected HTTP tests cover the complete rejection/conditional
      corpus.

- [x] **DRV-24 — Replace split-list pagination with one stable cursor.** `[P1][P]` Evidence: folders
      and files are separately fetched, concatenated, then sliced, allowing starvation/duplicates.
      **Minimum change:** unioned stable keyset query with deterministic tie-break. **Exit:** every mixed
      entry appears exactly once under concurrent creates/deletes.
      **Implemented:** Drive list now executes one ACL-scoped `UNION ALL` query for folders and files,
      ordered by normalized name, entry kind, and UUID. Its opaque cursor is bound to the actor and full
      filter set and carries the database snapshot timestamp, so a cursor cannot be replayed against a
      different listing. Rows created after page one stay outside that snapshot; rows soft-deleted during
      traversal retain their as-of-snapshot projection, preventing both starvation and duplicates. The
      shared contract, tool, browser API, WebDAV, and all consumers use the paged result directly. A live
      PostgreSQL test traverses interleaved folders/files while inserting and deleting between pages and
      proves each original entry appears exactly once; filter-confused cursors reject deterministically.

- [x] **DRV-25 — Enforce object ACLs in keyword and vector search.** `[P0][P]` Evidence:
      `search/scope.ts:34-65` and Meilisearch filter only org/type, exposing private Drive metadata/body.
      **Minimum change:** index principal/ACL version or authoritative post-filter without leaking counts,
      snippets, facets, or timing batches. **Exit:** unshared content is invisible to every search/RAG
      surface even by exact title/text.
      **Implemented:** only ready objects are indexed with projected principals; keyword filters and
      semantic post-filtering enforce ACLs and suppress unauthorized hit counts.

- [x] **DRV-26 — Minimize and lifecycle-manage search documents.** `[P1][P]` Evidence: index stores
      storage keys, SHA, and broad metadata; vector deletion is a no-op. **Minimum change:** explicit
      field allowlist, durable delete on ACL/content/deletion change, reconciliation, and measured purge
      SLA. **Exit:** index export contains no locators/unneeded secrets and revoked content disappears.
      **Implemented:** the Drive projection now has an explicit minimal attribute allowlist and excludes
      object-store keys, hashes, raw metadata, trash state, and owner email. Event deletes inherit the
      authenticated tenant from the shared event boundary and remove both keyword and tenant-local vector
      entries. A leader-gated five-minute authoritative Drive reconciliation re-upserts current content
      and ACLs and prunes stale entries per owning tenant, bounding recovery after missed events; existing
      projection lag/error telemetry measures the real-time purge path. Tests assert the exact exported
      field set, tenant-scoped vector deletion, cross-tenant stale pruning, non-overlapping reconciliation,
      and quarantine deletion; 21 focused search tests pass.

- [x] **DRV-27 — Make semantic retrieval real and authorization-safe.** `[P2][P]` Evidence: semantic
      ranking only boosts IDs already returned lexically. **Minimum change:** merge independently found
      semantic candidates, apply identical authoritative ACL filtering, provenance and tenant-local
      embedding policy. **Exit:** semantic-only authorized hits work and cross-ACL probes reveal nothing.
      **Implemented:** reciprocal-rank fusion now unions independently retrieved keyword and vector
      candidates, labels each returned hit `keyword`, `semantic`, or `hybrid`, and applies the same
      tenant, type, and projected Drive-principal filter before a vector candidate can enter the result
      set or result count. Embeddings remain partitioned by tenant collection and unscoped requests never
      query vectors. Focused tests prove an authorized semantic-only Drive hit is returned, an exact-title
      unauthorized hit and another tenant's hit are absent with a zero count, and mixed-tenant upserts
      never share a vector-store call; the app typecheck and focused lint pass.

- [x] **DRV-28 — Make indexing/reindexing durable and scalable.** `[P1][P]` Evidence: migration 0145
      persists tenant mutations in a leased retry/DLQ queue with a contiguous replay checkpoint, while
      Meilisearch task polling fails closed instead of dropping rejected or timed-out mutations.
      **Minimum change:** outbox, leased retries/DLQ, task polling, lag/replay checkpoint; keyset-batched
      shadow-index job with resume/cancel/swap. **Exit:** an outage and concurrent writes recover every
      document at tens-of-millions scale with bounded memory.
      **Evidence:** the leader-gated projector retries idempotent live and active-shadow writes and
      serializes them with swap; full shadow jobs persist `(updated_at, id)` source cursors, replay the
      mutation checkpoint, support status/cancel, and atomically swap. Source and reconciliation scans
      remain bounded. Thirty focused search/migration tests, app typecheck/lint, a fresh PostgreSQL 17
      replay of all 138 migrations, and live lease/retry/checkpoint/cancel exercises pass.

- [x] **DRV-29 — Replace quota scans with atomic reservations and reconciliation.** `[P1][P]`
      Evidence: each upload scans versions/objects, serializes on org, and missing org can fail open.
      **Minimum change:** bigint usage counters, transactional reservations, strict missing-tenant error,
      release/expiry, independent reconciler and outbox-backed metering. **Exit:** concurrent uploads
      cannot exceed quota and p95 is independent of object count.
      **Implemented:** migration 0153 backfills tenant bigint used/reserved counters and adds
      tenant-bound, row-locked upload reservations. Prepare reserves declared bytes; finalize atomically
      releases the reservation, applies the physical-storage delta, and inserts the canonical
      `metering.events.<org>` payload into the existing outbox; abort, failed-presign compensation, and
      upload expiry release through the reservation's object cascade. Drive deletes, pasted Chat images,
      and Meet recordings use the same counter transaction, including correct content-addressed dedup
      deltas. The leader-gated Drive maintenance sweep independently expires reservations, recomputes
      authoritative distinct stored bytes, repairs both counters, and emits an outbox correction. Upload
      byte size is now required at every public prepare/recording boundary, and all quota functions reject
      missing or cross-tenant context. The hot reserve/commit functions touch only indexed counter,
      reservation, tenant, and object rows; the object/version scan exists only in the reconciler. A fresh
      PostgreSQL database applied all 143 migrations, then a live 20-way reservation race admitted exactly
      ten 10-byte uploads under a 100-byte limit and verified cascade release, expiry, drift repair,
      tenant failure, and metering outbox records. Fifty-one focused Drive/Chat/Meet unit tests, app,
      contracts, and web typechecks pass.

- [x] **DRV-30 — Enforce tenant storage security and lifecycle settings.** `[P1][P]` Evidence:
      configured object lock/retention is ignored; encryption is optional; credential clients remain
      cached after rotation. **Minimum change:** fail-closed TLS/SSE-KMS/versioning/object-lock policy,
      startup verification, secret-version cache invalidation, CMEK rotation. **Exit:** insecure/default
      storage blocks readiness and configured retention prevents direct storage deletion. **Implemented
      2026-09-03:** production default storage now refuses non-TLS endpoints, missing SSE-KMS/CMEK, or
      missing object-lock retention at boot. Its existing readiness probe uses the official S3 client to
      verify the exact bucket KMS key, enabled versioning, enabled object lock, mode, and minimum retention;
      the same non-mutating policy check powers the immediate and periodic BYO health worker, avoiding
      retained probe-object leaks. BYO admin/API resolution requires endpoint, region, bucket, tenant
      prefix (defaulted to `tenants/<org>/`), HTTPS, SSE-KMS key, and governance/compliance retention.
      Credential fingerprints are refreshed on a bounded interval (or immediately by the health worker)
      and participate in the bounded client-cache key, so in-place Vault rotation invalidates stale signed
      clients without exposing secret material. CMEK changes likewise create a new client, while the
      existing staged migration worker's server-side copy now demonstrably sends the destination KMS key
      to re-encrypt objects before cutover. Helm renders every production storage policy input. Bucket
      default Object Lock protects retained versions from physical direct deletion. No schema migration was
      needed because the existing tenant JSON lifecycle/encryption model and migration state were sufficient.
      Ninety-four focused backend tests, twenty-two admin-web tests, app/web typechecks, targeted lint, and
      Helm lint/render pass.

- [x] **DRV-31 — Make WebDAV distributed, atomic, and conformant.** `[P1][P]` Evidence: locks are a
      process Map/unbound to actor; overwrite deletes original first; traversal truncates at 250 while
      advertising DAV 1/2. **Minimum change:** durable fenced locks, upload-new-then-switch, cursor/depth
      traversal, and either implement or stop advertising missing methods. **Exit:** restart/replica/
      interrupted PUT/>250 collection tests and a conformance suite pass.
      **Progress:** process-local locks are replaced by forced-RLS PostgreSQL locks with monotonic fences,
      tenant/actor binding, expiry, atomic conflict acquisition, refresh, and release; two independent
      store instances prove shared visibility and cross-actor release denial. PUT now finalizes a new
      version on the existing object instead of deleting it first, so failed scanning/storage leaves the
      prior version visible. Name resolution and depth-one PROPFIND traverse stable Drive cursors beyond
      250 entries, with a 300-entry route test. The incomplete DAV 1/2 compliance claim was removed while
      OPTIONS continues to enumerate only implemented methods. Full standards-method interoperability
      and OPTIONS advertises only those methods plus the implemented `sync-collection` compliance token.
      Migration `0157_drive_webdav_sync.sql` adds a forced-RLS, actor-visible collection journal whose
      `bigint` cursor increment and object/folder mutation share one PostgreSQL transaction. It records
      move/delete tombstones, serializes cross-collection moves without deadlocks, retains a bounded
      10,000-change window, and rejects pruned or future cursors. `REPORT sync-collection` uses opaque
      tenant-and-collection-bound tokens, caps incremental pages at 250, emits the RFC 507 continuation
      marker, exposes discovery properties, and returns `valid-sync-token` for stale/foreign tokens.
      Conditional GET/streaming and DELETE now honor strong `If-Match`; submitted lock tokens are matched
      exactly rather than by substring. The focused protocol contract covers discovery, initial/incremental
      sync, paging, tombstones, foreign/stale tokens, replica locks, interrupted overwrite preservation,
      conditional requests, and 300-entry traversal; 40 focused checks pass with two live tests skipped.
      The live journal test also proves inherited-access visibility and transaction rollback atomicity when
      a database is available. It could not be replayed in this run because the local PostgreSQL service was
      stopped and Docker failed to start or exec with `no space left on device`; static migration contracts,
      route-level protocol tests, targeted lint, and a typecheck with no DRV-31 errors passed instead.

- [x] **DRV-32 — Complete competitor-grade Drive workflows through the shared model.** `[P2][G]`
      **Minimum change:** shortcuts, file requests, approvals, ownership transfer, shared drives, offline
      sync/change feed, desktop sync contract, labels/classification, OCR/full-text/facets, DLP, data
      residency, client-side/customer-managed encryption, holds, and investigation—not isolated feature
      tables. **Exit:** each selected workflow has an admin policy, user flow, audit/export semantics,
      accessibility, mobile/offline behavior, and multi-tenant end-to-end scenario.
      **Implemented 2026-09-03:** migration `0160_drive_workflows.sql` adds one tenant-RLS workflow model,
      not a table per feature, for shortcuts, internal file requests, approvals, atomic ownership transfer,
      shared-drive folder conversion, classification, retention holds, and investigations. The database
      validates same-tenant resources, freezes workflow identity and the captured policy, increments a
      `bigint` version, restricts every transition by kind and assigned/requesting actor, and rejects
      reopening terminal decisions. Ownership approval changes the canonical object owner and grants in
      the same transaction; file-request completion proves the uploaded object is in the requested folder;
      classification and holds write the existing canonical governance tables; shared-drive conversion
      marks the canonical folder rather than creating a second content hierarchy. Shortcuts remain durable
      tenant-scoped pointers and every participant can open their target from the shared workflow inbox.
      The same model snapshots the existing external-sharing, DLP, and new `drive_workflows` policy. Admins
      can enable it, choose the exact allowed workflow kinds, and require due dates. The responsive,
      labelled Drive panel resolves assignees by tenant-local email/name, accepts due dates, exposes only
      valid decision/completion actions, keeps loaded records visible on request failure, and relies on the
      workspace network status plus fail-closed server authority while offline. Every create/decision and
      canonical side effect commits with the hash-chained activity event and transactional outbox; tenant
      export manifests now include the workflow row count.
      Existing shared capabilities remain the authority rather than being duplicated: DRV-31 supplies the
      atomic WebDAV change feed/desktop-offline sync contract; DRV-25 through DRV-28 supply ACL-safe OCR,
      full-text, semantic retrieval, filterable search attributes, and durable indexing; DRV-19/20 enforce DLP and
      classification on external use; DRV-30 supplies tenant data residency and customer-managed SSE-KMS;
      and DRV-12 supplies hold-enforced recovery/purge. Focused workflow/store/migration/admin/tool/API/UI
      suites pass (36 backend checks plus one environment-gated integration scenario and 31 web checks),
      web typecheck passes, and app typecheck reports no DRV-32 error. The runnable live scenario covers
      two tenants, forced-RLS invisibility, approval, ownership transfer, audit, and outbox atomically; it
      was not replayed in this run because no migrated PostgreSQL URL is available and the shared Docker
      host remains disk-exhausted, so this verification limitation is explicit rather than silently mocked.

## 10. Chat backlog (CHAT-01–CHAT-18)

- [x] **CHAT-01 — Prevent invitation and role escalation by ordinary members.** `[P0][P]` Evidence:
      `packages/contracts/src/chat.ts:22-26` accepts an open role and `chat/store.ts:283-303` lets any
      visible-room member grant it. **Minimum change:** closed roles; owner/moderator-only membership and
      privilege management; exact delegation rules. **Exit:** members cannot mint owners/moderators or
      change their own authority.
      **Implemented:** closed roles and inviter-role rules prevent ordinary members from inviting,
      self-promoting, or minting moderator/owner authority.

- [x] **CHAT-02 — Validate every room member as an active allowed identity.** `[P0][P]` Evidence:
      room/invite paths accept caller-provided actor UUIDs without same-org/active validation.
      **Minimum change:** resolve membership under current org and external-guest policy before any ACL
      insert. **Exit:** cross-org, suspended, expired guest, and nonexistent IDs cannot join or receive
      history.
      **Implemented:** invitees resolve to active same-tenant actors before ACL insertion; disabled,
      foreign, and nonexistent identities fail opaquely.

- [x] **CHAT-03 — Authorize Chat attachments through Drive and governance.** `[P1][P]` Evidence:
      `chat/store.ts:430-435` directly links arbitrary object IDs. **Minimum change:** verify current
      Drive access, tenant, clean state, classification, DLP, external-room policy, and durable snapshot/
      link semantics. **Exit:** foreign, quarantined, revoked, or prohibited files cannot attach or leak.
      **Implemented:** a database trigger now authorizes every Drive link in the same transaction as the
      Chat message, including direct or inherited current ACL, tenant identity, ready/AV-queue state,
      durable resource classification, blocking DLP verdict, room guest policy, organization external-
      sharing mode, and guest-domain allowlist. Confidential/restricted files cannot enter an external
      room, and activated blocking DLP fails closed on missing or adverse verdicts. The link stores a
      version-aware, non-secret metadata snapshot for stable conversation rendering while bytes retain
      `current_acl` Drive semantics; pasted Chat media keeps separate `room_content` semantics. A fresh
      129-migration replay and four live PostgreSQL cases prove allowed snapshots plus foreign, unclean,
      revoked, classified-external, and unscanned-DLP denial. The full focused Chat suite passes 85 tests
      with 28 service-dependent cases intentionally skipped, and the existing moderation live suite still
      passes under the hardened trigger.

- [x] **CHAT-04 — Make message send idempotent.** `[P1][P]` Evidence: `clientMessageId` is metadata
      while retry can resubmit. **Minimum change:** unique `(org,membership,room,client_message_id)` and
      insert-or-return with one outbox event. **Exit:** timeout/retry creates exactly one message and one
      fanout.
      **Implemented:** `client_message_id` is now a first-class message column with a partial unique
      index over tenant, sender membership, room, and client key. The transactional insert uses that
      index as its conflict arbiter and returns the committed original before attachments, room touch,
      mentions, or fanout can repeat. A retry simulation asserts one message identity, one room update,
      and exactly one outbox event.

- [x] **CHAT-05 — Serialize and bound work per WebSocket.** `[P1][P]` Evidence:
      `chat/routes.ts:167-220` detaches concurrent async handlers. **Minimum change:** small ordered queue,
      backpressure, payload/rate/in-flight limits, deadlines, and explicit close codes. **Exit:** burst
      tests retain order and bounded CPU/memory.
      **Implemented:** each socket now processes one frame at a time through a FIFO capped at 32 pending
      frames, rejects payloads above 64 KiB before parsing, enforces an arrival-time token bucket and a
      ten-second processing deadline, and closes with explicit 1008/1009/1011/1013 semantics. Closed
      sockets discard queued work; burst tests prove order, single in-flight execution, and every bound.

- [x] **CHAT-06 — Use one-time WebSocket tickets.** `[P1][P]` Evidence: a long bearer token is sent
      in subprotocol headers. **Minimum change:** session-authenticated, audience/room-bound, seconds-long,
      single-use upgrade ticket with log redaction. **Exit:** ticket replay fails and long credentials
      appear nowhere in handshake telemetry.
      **Implemented:** the session-and-CSRF-protected ticket endpoint now validates current room access
      and mints a 30-second random credential whose SHA-256 digest is persisted with tenant, actor, room,
      audience, and path bindings. Upgrade redemption is one atomic `consumed_at is null` update, so
      concurrent replay succeeds exactly once across replicas; expiry, wrong audience/path, disabled
      actors, inaccessible rooms, malformed protocols, and cross-room frames fail closed. Browsers send
      only the ticket in `Sec-WebSocket-Protocol`, mint a fresh ticket for every reconnect/room change,
      and never put bearer credentials in the WebSocket URL or metadata. Authorization, cookie, and
      WebSocket protocol headers plus token/ticket fields are redacted from server logs. Focused route,
      parser, client, migration, query-shape, and disposable-PostgreSQL race tests cover the exit criteria.

- [x] **CHAT-07 — Revoke live subscriptions immediately on access change.** `[P1][P]` Evidence:
      access is checked only when subscribing; callbacks keep sending after member removal.
      **Minimum change:** durable ACL-version/revocation event and subscription recheck/close on every
      replica. **Exit:** removed/banned/suspended members receive no further events on existing sockets.
      **Implemented:** migration `0100_chat_acl_revocation_events.sql` atomically advances each room's
      ACL version and appends an ordered `access.changed` outbox event for grant insert/update/delete,
      actor disablement, organization-membership removal/suspension, and global-identity suspension.
      Every replica consumes the shared room subject; before delivering any live event, the subscription
      reruns the one canonical grant-validity predicate and closes denied sockets with policy code 1008.
      Post-upgrade store checks and replay use fresh, actor-bound `SET LOCAL` transactions, so a completed
      request transaction can never be reused by a long-lived callback. Restricted-role PostgreSQL tests
      exercise a deliberately inherited stale request context and prove grant revocation plus actor,
      membership, and identity suspension emit durable ACL events and stop an existing socket.

- [x] **CHAT-08 — Add ordered event cursors and reconnect replay.** `[P1][G]` Evidence: resubscribe
      has no cursor/backfill. **Minimum change:** per-room monotonic sequence, retained durable events,
      gap detection, cursor endpoint, and idempotent client reducer. **Exit:** offline/reconnect and
      failover reproduce every authorized event exactly once in order.
      **Implemented:** migration `0099_chat_ordered_events.sql` adds a forced-RLS durable room-event log,
      an atomic per-room sequence allocator, indexed message-event identity, and transactional outbox
      repair. Message creation and shared read advancement now commit their complete replay event in the
      same database transaction; idempotent send retries reuse the original cursor and stale/private read
      calls create no duplicate or leaked event. Live delivery and outbox repair carry the same cursor,
      while each socket stores only its current/desired scalar cursors and drains bounded 100-event replay
      pages through an authorization-gated no-store cursor endpoint. Missing/expired or future cursors
      produce an explicit resync frame and close instead of silently skipping history. The browser resumes
      with its last cursor, rejects gaps, and applies duplicate message/read/ACL events once in order.
      Focused multi-replica, browser, contract, and disposable-PostgreSQL tests cover concurrent allocation,
      atomic mutation/event commit, retention gaps, pagination, reconnect, cross-tenant denial, direct-plus-
      outbox duplication, and replica failover without an unbounded per-socket event buffer.

- [x] **CHAT-09 — Scope and monotonicize read receipts.** `[P1][P]` Evidence: receipts can be written
      across rooms and regress. **Minimum change:** verify room/message membership and update only to a
      greater room sequence. **Exit:** foreign IDs fail, concurrent devices never move unread state
      backward, and privacy settings are respected.
      **Implemented:** migration `0085_chat_read_receipt_integrity.sql` assigns every chat message a
      database-serialized per-room position and backfills existing messages/receipts. `markRead` now
      resolves one live chat message under the exact tenant, room, active actor, and unexpired membership,
      then atomically upserts only when that position exceeds the stored high-water mark; stale concurrent
      callers receive the current marker rather than regressing it. A first-class room
      `readReceiptsEnabled` privacy setting is available at creation, stored durably, and enforced both
      when listing receipts and before realtime fanout, while private self progress remains usable.
      Query-shape, contracts, WebSocket privacy, UI/API, migration, and disposable-PostgreSQL adversarial
      tests cover cross-room/cross-tenant IDs, deletion/revocation gates, concurrent older/newer devices,
      active-member filtering, and sharing disabled.

- [x] **CHAT-10 — Enforce grant validity everywhere.** `[P0][P]` Evidence: expired/wrong-org generic
      permission grants can still authorize Chat. **Minimum change:** canonical authorization evaluator
      checks tenant, resource, principal, status, role, start/expiry, and revocation epoch.
      **Exit:** stale or foreign grants cannot list, fetch, subscribe, search, or mutate a room.
      **Implemented:** migration `0094_chat_permission_validity.sql` gives generic grants explicit
      status, start time, expiry, revocation timestamp, and revocation epoch; repairs invalid historical
      rows; and adds same-tenant subject/grantor foreign keys plus exact same-tenant thread validation.
      Chat rooms additionally enforce a non-null same-tenant grantor and the closed owner/moderator/member
      role set without constraining Mail, Meet, or Docs thread roles. One database predicate,
      `chat_permission_is_valid`, now checks the expected tenant, subject, exact room/resource type,
      active principal, grantor, room kind, status, role, statement-time validity window, and revocation
      state. Every actor-facing room/member listing, room fetch, message/thread/pin/reaction/receipt read
      or mutation, keyword search, invitation, and idempotent-send recovery path uses that predicate;
      mutations repeat it inside the writing statement so a stale preflight cannot authorize a write.
      WebSocket upgrade, every inbound frame, and every subscribed-event callback revalidate access and
      close denied sockets with policy code 1008. Query-shape, realtime-revocation, migration, and
      disposable-PostgreSQL adversarial tests prove valid access while denying expired, future, revoked,
      wrong-role, wrong-resource, cross-tenant subject/object/grantor, known-message, search, mutation,
      and realtime cases.

- [x] **CHAT-11 — Keep keyword/vector search synchronized with edits and deletion.** `[P1][P]`
      Evidence: no durable edit/delete search events. **Minimum change:** immutable message revisions and
      outbox-backed index upsert/delete with ACL version, replay, reconciliation, and lag alert.
      **Exit:** edit/delete/revocation converges within SLO and old text never remains discoverable.
      **Implemented:** migration 0122 gives Chat messages monotonic revisions and captures every prior body
      and deletion state in a tenant-scoped, runtime-append-only revision table. Create, edit, and delete
      now commit versioned projection events containing message revision and current room ACL version in the
      same transaction as the mutation; update is an idempotent document replacement and delete is an
      idempotent index removal. The existing bounded admin reindex with stale pruning is the reconciliation
      path, while per-indexer lag/error metrics and Prometheus alerts surface failed or delayed consumers.
      Live PostgreSQL evidence proves old bodies survive only in revision evidence, current projections carry
      the ACL version, deletion routes to index removal, and ordered room/outbox events are replayable; 21
      focused Chat, indexer, reconciliation, idempotency, and metric tests plus targeted lint pass.

- [x] **CHAT-12 — Make room RAG follow room ACL, not message-author privacy.** `[P1][P]` Evidence:
      current semantic indexing is private to the author. **Minimum change:** room principal set and ACL
      version on chunks, authoritative filtering, retention/deletion propagation, and source citations.
      **Exit:** authorized members can retrieve room knowledge while former/nonmembers cannot probe it.
      **Implemented:** Chat projections now carry the current room ACL version and canonical active actor
      principal set while remaining tenant-visible candidates instead of incorrectly private to the
      message author. Both keyword and semantic search apply the projected principal filter, then a small
      shared search wrapper rechecks every Chat hit against the authoritative PostgreSQL room grant before
      returning it; it suppresses stale-hit counts as well as content. The same CHAT-11 update/delete
      projection and reconciliation path propagates edits, retention deletion, and stale-document removal.
      Chat documents include stable room/message deep links, and Assistant context names the source ID and
      link while explicitly requiring citations. Live PostgreSQL evidence proves a projected member can
      retrieve room knowledge and that revocation immediately rejects the unchanged stale index document;
      20 focused authorization, scoped-search, semantic, and Chat tests plus targeted lint pass.

- [x] **CHAT-13 — Add moderation and abuse primitives.** `[P2][G]` **Implemented:** migration
      `0124_chat_moderation.sql` adds tenant-composite moderation cases, append-only evidence/events,
      user blocks, room bans, room controls, and abuse signals behind forced RLS and security-definer
      mutations. Existing owner/moderator Chat grants authorize queue/control/action access; moderators
      cannot act on owners or peer moderators, subjects alone can appeal, and cross-tenant/direct table
      mutations are rejected. Message removal emits the canonical ordered Chat deletion event; reports,
      actions, appeals, evidence, blocks, controls, and detected signals emit canonical outbox activity,
      while HTTP mutations also append hash-chained activity audit records. Database send enforcement
      covers active bans, DM blocks, slow mode, allowed formats, blocked terms, external guests, and
      per-minute abuse signals. A fresh PostgreSQL database applied all 118 migrations, then focused
      live playbooks passed for harassment removal, spam ban/rate detection, compromised-account
      containment and appeal, malicious-attachment evidence/removal, and external-guest control, plus
      adversarial cross-tenant, non-moderator, moderator-peer, immutable-evidence, RLS-visibility, and
      direct-write rejection checks. Focused route/migration tests (4) pass, targeted ESLint passes, and
      the full `@helix/app` typecheck passes. **Minimum change:** report, block,
      remove, ban, slow mode, content controls, moderator queue, appeals/evidence, and rate/abuse signals,
      all role-checked and audited. **Exit:** tested response playbooks cover harassment, spam, account
      compromise, malicious files, and external guests.

- [x] **CHAT-14 — Define room privacy/discovery and eliminate duplicate DMs.** `[P2][P]` Evidence:
      `isPrivate` has no meaningful discovery/join behavior and identical participants can create many
      DMs. **Minimum change:** explicit discoverable/restricted/private states and canonical participant-
      set key for direct conversations. **Exit:** privacy matrix is enforced and concurrent DM creation
      returns one conversation.
      **Implemented:** migration 0118 replaces the inert boolean with a closed discoverable/restricted/
      private policy and an organization-scoped unique participant-set hash. Discovery exposes public and
      invitation-only rooms without their member rosters, while only discoverable rooms permit self-join;
      private rooms remain undiscoverable and direct-message membership is immutable. Opposite-order
      concurrent DM creation takes one transaction advisory lock and returns the same conversation. A live
      PostgreSQL matrix proves discovery and join boundaries, one concurrent DM row, private DM settings,
      and rejected participant expansion; focused tool, migration, store, web, and full app/web typechecks
      pass.

- [x] **CHAT-15 — Use stable keyset pagination.** `[P1][P]` Evidence: timestamp-only boundaries can
      skip/duplicate equal-timestamp messages. **Minimum change:** `(created_at,id)` or room sequence
      cursor with forward/backward semantics and retention gaps. **Exit:** concurrent inserts and equal
      timestamps produce complete, duplicate-free pages.
      **Implemented:** the shared Chat contract, tools, PostgreSQL store, and infinite-query client now
      carry one typed `(sentAt,id)` cursor. Room and thread history compare and order both fields in
      explicit older/newer directions, so ties are deterministic and cursors do not depend on the
      referenced row remaining present. A live PostgreSQL test paginates messages with the same
      timestamp, deletes the boundary row, inserts another tied message between requests, and proves
      older and newer traversal remains complete and duplicate-free. Contract and web typechecks plus
      25 focused store/tool/query/API tests pass.

- [x] **CHAT-16 — Fan out every state transition through one event contract.** `[P1][P]` Evidence:
      reactions, pins, edits, and deletes do not consistently fan out; list payload omits aggregated
      reaction/reply/pin state. **Minimum change:** versioned event schema and one projection shared by
      initial fetch/replay/live delivery. **Exit:** two clients converge for send/edit/delete/react/pin/
      reply/member changes without refresh.
      **Implemented:** one typed message projection now carries reactions, reply count, and pin state
      through history tools, durable replay, and live WebSocket frames. Send, reply, edit, delete, pin,
      unpin, and reaction changes commit their versioned projection/tombstone and fanout outbox record in
      the same PostgreSQL transaction; reply mutations also refresh the parent projection, while the
      existing ordered ACL event covers member changes. The event schema explicitly accepts created,
      updated, and deleted frames, and clients resume by the same monotonic room cursor. The browser now
      applies all three message frame types in cursor order, aggregates the canonical reaction projection,
      derives the current actor's state, and toggles add/remove without a local-only compatibility overlay.
      Live PostgreSQL evidence executes the entire reaction/pin/reply/edit/delete sequence and proves two
      independent replays are identical to the history projection. Focused contract, store, tool, fanout,
      authorization, search-sync, browser reducer, and live convergence tests pass with targeted lint clean.

- [x] **CHAT-17 — Make presence bounded, expiring, and privacy-aware.** `[P2][P]` Evidence: presence
      lacks a heartbeat; per-connection limits can multiply across sessions. **Minimum change:**
      membership-level connection quota, heartbeat TTL, device aggregation, invisible/DND policy, and
      graceful degradation. **Exit:** crashed clients expire, multiple tabs cannot evade limits, and
      blocked users learn no presence.
      **Implemented:** the browser emits a 15-second protocol heartbeat and Redis stores TTL-bound
      per-device room presence instead of one destructive actor flag. An atomic sorted-set lease caps
      connections across every tab/node for a tenant member; stale crashed leases self-expire, closing one
      device preserves the others, and bounded `SSCAN` rosters degrade safely in large rooms. Device state
      aggregates deterministically with DND and invisible precedence, and invisible actors emit no joined
      payload. A security-definer query filters both sides of user blocks without exposing the owner-only
      block table; snapshots and fanout events are filtered per viewer. Focused socket, Redis, browser,
      migration, and live PostgreSQL tests prove heartbeat renewal, quota enforcement/recovery, device
      aggregation, invisible behavior, and that a blocker is hidden from the blocked viewer.

- [x] **CHAT-18 — Complete governed collaboration spaces.** `[P2][G]` **Minimum change:** threads,
      rich formatting, mentions, notifications, history on/off policy, announcement/project spaces,
      guest/federated rooms, bots/webhooks with scoped identity, import/export, retention/holds, discovery,
      accessibility, and mobile/offline behavior. **Exit:** each shipped space type passes an ACL,
      history, retention, notification, export, and external-member scenario.

- [x] **CHAT-19 — Make pasted media and code first-class conversation content.** `[P1][P]`
      **Minimum change:** paste/drop/upload image and GIF bytes directly from the composer into a hidden
      tenant/room-scoped `chat_attachment` object namespace; scan, quota, encrypt, authorize, retain, and
      purge them with Chat rather than scattering objects through visible Drive folders. Render safe inline
      previews with open/download/explicit “Save to Drive” actions. Preserve attaching existing Drive files
      as a separate flow. Render Markdown fenced code with language labels, copy support, safe highlighting,
      and keyboard triple-backtick entry; add toolbar actions for inline code and fenced blocks.
      **Exit:** pasted image/GIF and code-button/backtick scenarios converge across two clients; nonmembers,
      rejected scans, active content, oversized media, and expired attachment links fail closed.
      **Implemented:** Migration 0126 adds a hidden `chat_attachment` object kind and room-bound stage table
      with composite tenant foreign keys, forced RLS, active-membership/ban checks, sender-owned atomic
      message binding, one-hour expiry, and durable byte-purge jobs. Migration 0140 revokes a known media URL
      as soon as its message is tombstoned and atomically hands its private object to that deletion queue while
      retaining the message tombstone. Uploads accept
      only magic-byte-verified PNG/JPEG/GIF/WebP content up to 10 MiB, authorize room membership before
      invoking antivirus, fail closed without a real clean verdict, reserve the shared tenant quota, inherit
      the tenant storage prefix, fail closed unless the resolved tenant client attests enforced AES-256/KMS
      encryption, and verify size/SHA-256 again when served. Authenticated content routes return no-store,
      nosniff, same-origin and sandbox headers and provide explicit open/download/Save-to-Drive actions;
      hidden media never enters Drive listing, while a separate picker retains attach-from-Drive. The main
      and thread composers support paste, drop, file input, attachment-only messages, inline-code and fenced
      block controls, and typed triple backticks. Rendering is React-text-only (no HTML injection), labels
      normalized languages, highlights a bounded token set, and provides copy controls. A fresh 123-migration
      replay passed; four live PostgreSQL cases prove the real tenant-prefixed upload/open/bind path stays
      absent from Drive listings, plus pre-bind privacy, member/nonmember/cross-tenant isolation,
      owner/room/expiry binding, retention purge queuing, forced RLS and quota tenant checks.
      Immediate REST send/reaction events publish their already-committed cursor and canonical projection on
      the same shared room bus used by WebSockets; a live two-subscriber test proves both clients receive one
      ordered event per database transition without a duplicate append. Focused scanner/route/storage/fanout/
      contract/web tests pass, including identical media/code fanout to two clients, rejected scans,
      unencrypted storage, active-name/content and oversize rejection, post-delete known-URL denial and purge
      queuing, GIF/WebP rendering, raw upload, code toolbar/backtick behavior, and safe headers; app/web
      typechecks and focused lint are clean.

## 11. Meet and media backlog (MEET-01–MEET-18)

- [x] **MEET-01 — Derive moderator status server-side.** `[P0][P]` Evidence:
      `meet/tools.ts:48-57,177-189` accepts caller `moderator`; the web client repeats it.
      **Minimum change:** remove the field and derive host/cohost from meeting authorization.
      **Exit:** crafted attendee requests always mint attendee tokens; only authorized hosts moderate.
      **Implemented:** moderator claims derive from room permissions; the caller field is gone and
      crafted attendee joins remain non-moderator.

- [x] **MEET-02 — Remove caller-controlled Jitsi script origins.** `[P0][P]` Evidence: meeting input
      accepts `jitsiDomain` and browser loads its `external_api.js` with application privileges.
      **Minimum change:** deployment-owned exact origin/allowlist with integrity/version policy, never
      persisted from callers. **Exit:** attacker domains are rejected and no unapproved script loads.
      **Implemented:** Jitsi origin is deployment-owned, removed from caller contracts, and covered by
      hostile-domain tests in both API and web layers.

- [x] **MEET-03 — Separate participant leave from host end.** `[P0][P]` Evidence: any visible
      attendee can call `meet.end`, and ordinary UI leave invokes it. **Minimum change:** local leave is
      client/media state; end-for-all requires host/cohost and is idempotent. **Exit:** attendee leave
      does not alter meeting state and attendee end receives 403.
      **Implemented:** UI leave changes only local/media state; end-for-all is idempotent and restricted
      to an authorized host/cohost.

- [x] **MEET-04 — Authenticate recording/media webhooks cryptographically.** `[P0][P]` Evidence:
      endpoint trusts `X-Helix-Org-Id`, allows empty/known secret, and has no replay defense.
      **Minimum change:** derive tenant/meeting from prepared record; timestamped body HMAC or mTLS,
      nonce/idempotency, constant-time verification, bounded age. **Exit:** forged org, replay, empty
      secret, changed body, and wrong meeting all fail.
      **Implemented:** the media gateway verifies a bounded-age timestamped raw-body HMAC in constant
      time, persists nonce/idempotency state to reject replay, and accepts only server-prepared upload
      capabilities whose tenant, room, storage key, media type, size, and hash are server-derived.
      Tampering, replay, forged tenant/room, and invalid-secret tests all fail closed.

- [x] **MEET-05 — Remove every development media secret from production.** `[P0][P]` Evidence:
      server and Compose fall back to known Jitsi JWT/webhook secrets. **Minimum change:** explicit local
      profile only; workload secrets and rotation in production. **Exit:** production startup rejects
      missing/default secret and old key stops minting tokens after bounded overlap.
      **Implemented:** production configuration rejects absent, known-development, or undersized JWT and
      webhook secrets; legacy aliases and plaintext/direct-bucket recorder paths are deleted. Local-only
      Compose retains explicit development values, while production accepts only mounted workload
      secrets and the signed prepare/upload/complete recording protocol.

- [x] **MEET-06 — Delete the always-registered mock recorder.** `[P1][P]` Evidence:
      `server.ts:2236-2243` registers a recorder that cannot produce evidence-grade media.
      **Minimum change:** no recording capability unless a real healthy recorder is configured; use a
      test-only fake. **Exit:** production UI/API accurately disables recording when unavailable.
      **Implemented:** the mock tool, implementation, runtime registration, export, tests, and Compose
      claim are deleted, so no production catalog can manufacture placeholder media. Token minting now
      performs a two-second, 16 KiB-bounded live Jibri health check through the shared pinned outbound
      client and reports recording availability only for an idle `HEALTHY` recorder. Missing config,
      malformed responses, busy/unhealthy state, HTTP failure, and transport failure all report false;
      the in-call UI labels and disables its recording control accordingly.

- [x] **MEET-07 — Make meeting join identity and guest access explicit.** `[P1][P]` Evidence:
      participant IDs are arbitrary; join-by-code scans only visible rooms and effectively disables
      controlled external guests. **Minimum change:** active same-org memberships, signed expiring guest
      invites, lobby/domain policy, direct indexed code lookup, and revocation. **Exit:** foreign IDs and
      guessed codes fail; invited guests join only within scope/expiry.
      **Implemented:** migration 0125 gives every room a random indexed tenant-unique join code, closed
      disabled/invite/domain guest policy, normalized domain allowlist, explicit lobby flag, and a forced-
      RLS invite table that stores only SHA-256 token hashes behind composite tenant/room/actor foreign
      keys. Room creation now rejects disabled and foreign participant identities before creating state;
      all member listing, lookup, and moderator decisions require current active, unrevoked grants. The
      Meet hub calls one direct server code lookup instead of scanning its visible-room list. Hosts mint
      bounded HMAC-signed, email/tenant/room/expiry-bound invitations and can revoke them immediately;
      the public redemption route returns one non-moderator Jitsi identity, respects domain policy and
      lobby state, and uses an indistinguishable not-found response for tampering, expiry, wrong email,
      revocation, and guessed codes. Live PostgreSQL proves the foreign/disabled/member/code/domain/
      revocation matrix; 26 focused crypto, route, store, config, migration, app and web tests pass, both
      app and web typechecks pass, and targeted lint is clean.

- [x] **MEET-08 — Persist scheduled/active/ended lifecycle from real media events.** `[P1][P]`
      Evidence: scheduled rooms do not reliably transition active and end/duration is app-level only.
      **Minimum change:** idempotent participant/join/leave/conference events drive a versioned meeting
      state machine. **Exit:** reconnect, duplicate events, host crash, and empty-room timeout converge.
      **Implemented 2026-09-02:** signed Jitsi conference/participant callbacks now persist immutable,
      tenant-scoped event IDs and ordered per-session join/leave bounds; a locked room transition derives
      the active participant count, scheduled/active/ended state, first media start, empty timestamp and
      monotonic lifecycle version. Duplicate IDs cannot advance state, delayed joins cannot resurrect a
      later leave, a new session models reconnect, ended rooms never reopen, and conference end archives
      the call thread. A singleton-supervised worker invokes one bounded `skip locked` database operation
      to end rooms left empty after the two-minute bridge-crash grace period, and rejects execution from a
      tenant/actor-scoped worker context. PostgreSQL integration proves duplicate, out-of-order, reconnect,
      crash, timeout, stale-rejoin and scoped-worker rejection; 14 focused migration, route, worker and live
      tests pass, targeted lint is clean, and the app typecheck passes.

- [x] **MEET-09 — Validate recorded bytes before promotion.** `[P1][P]` Evidence: completion can use
      placeholder/fabricated size and hash. **Minimum change:** prepared upload binding, authoritative
      byte size/hash/MIME/duration, scanner, encrypted immutable object, and ready state after validation.
      **Exit:** wrong/missing/truncated media never becomes a recording.
      **Implemented 2026-09-02:** the random, tenant/room-bound upload capability now remains `prepared`
      until the service re-reads the stored stream and verifies magic bytes, normalized MIME, exact length,
      SHA-256, upload/tenant/room metadata, signed media-plane start/end duration and a complete antivirus
      verdict. Secure tiers refuse upload issuance unless the signed storage request enforces server-side
      encryption and refuse promotion without a configured scanner; rejected and unscanned bytes fail
      closed and are deleted. Successful evidence advances the capability through `ready` to one-shot
      `completed`, creates an opaque-key recording object tagged ready/immutable, and a database trigger
      freezes its tenant, key, MIME, size and digest. Route tests prove wrong-type, missing, truncated,
      infected and unencrypted media never attach; live PostgreSQL proves pre-validation completion is
      impossible, completion is one-shot and promoted content identity cannot mutate. All 22 focused
      route/store/migration/live tests pass and targeted lint is clean.

- [x] **MEET-10 — Authorize recordings dynamically and govern their lifecycle.** `[P1][P]`
      Evidence: future attendee changes are not reflected, and retention/deletion is absent.
      **Minimum change:** recording inherits current meeting/Drive principals and classification;
      revoked attendees lose access; retention, hold, export, ownership, deletion, and region apply.
      **Exit:** attendee add/remove and hold/purge matrices behave consistently.
      **Implemented 2026-09-02:** recording authorization no longer copies attendee grants at upload.
      Drive reads now resolve either a current explicit object grant or a live, unrevoked, unexpired
      meeting/thread grant joined to an active actor, and the migration removes legacy copied viewer
      grants, so participant revocation is immediate while deliberate Drive sharing remains possible.
      Each recording has one forced-RLS governance link carrying the owning actor, room/thread,
      inherited classification, tenant storage region, retention deadline, legal-hold state and export
      policy. Purge checks hold/retention transactionally before deleting bytes or metadata; the content
      endpoint refuses download disposition when export is disabled and the Meet drawer removes the
      action while retaining governed inline playback. Live PostgreSQL proves current attendee access,
      revocation denial, explicit Drive re-grant, export denial, hold/retention purge denial, expired-
      retention purge and classification/region persistence. All 12 focused backend/web tests pass.

- [x] **MEET-11 — Provide truthful recording notice and consent.** `[P1][P]` Evidence: participant
      notification flag is not real. **Minimum change:** unmistakable in-product/audio indicator,
      consent/jurisdiction policy, late-join notice, audit, and hard prevention of hidden recording.
      **Exit:** every participant/device sees notice before capture and policy-required consent is proven.
      **Implemented 2026-09-02:** member, join-code and guest JWT issuance now requires an explicit,
      versioned recording acknowledgement and persists immutable participant, device and one-time join
      grant evidence under the global explicit-all-parties policy. Moderator recording start uses a
      short-lived, single-use server authorization containing the exact active-participant consent
      snapshot; unsigned/expired/replayed starts and direct recording uploads fail closed. The native
      Jitsi recording control and shortcuts are unavailable, while Helix's authorized control drives
      capture. Every client receives Jitsi's audible notice plus a persistent assertive REC banner;
      active recording state is durable and returned during token mint so late joiners are notified
      immediately. Activity evidence records consent and authorization decisions. Fresh PostgreSQL
      migration and live RLS-backed integration coverage prove member/guest consent, moderator and
      all-participant gates, one-time lifecycle/upload claims and late-join state; 80 focused backend,
      web and CLI tests pass, with focused lint, typechecks and Meet infrastructure validation green.

- [x] **MEET-12 — Harden media-plane TLS and ICE.** `[P1][P]` Evidence: JVB disables certificate
      verification and config uses public Jitsi STUN. **Minimum change:** verified internal certificates,
      owned STUN/TURN with auth/rotation, restricted network paths, SRTP policy, and secrets outside Git.
      **Exit:** certificate failure blocks connection and external dependency/credential leak tests pass.
      **Implemented 2026-09-02:** Prosody leaf certificates and the private-CA PKCS12 truststore are
      injected from the ignored/operator-selected secret directory; JVB and Jicofo override the
      upstream trust-all defaults, Jibri disables trust-all explicitly, and every Java XMPP client loads
      only that truststore. The pinned owned Coturn service supplies STUN plus authenticated TURN/TURNS;
      Prosody derives 10-minute HMAC credentials from a Docker secret, while bounded relay ports,
      quotas, stale nonces and TLS certificate/key secrets constrain the relay. P2P and the public Jitsi
      STUN default are disabled, control traffic is isolated on an internal network, only JVB/Coturn
      reach the media network, and the only call media path is ICE + DTLS-SRTP. The focused validator
      rejects public relay dependencies or committed TURN credentials and performs real TLS handshakes
      proving an untrusted issuer blocks connection while the configured issuer succeeds; the composed
      Coturn service also starts successfully with injected ephemeral test secrets.

- [x] **MEET-13 — Build a reproducible HA media topology.** `[P1][G]` Evidence: one mutable/unpinned
      bridge and no complete Helm media scaling path. **Minimum change:** pinned signed images,
      multi-zone bridges, autoscaling/drain, regional TURN, sticky signaling where required, capacity
      limits, and upgrade/rollback. **Exit:** bridge/node/zone loss preserves established SLO for calls.
      **Implemented 2026-09-02:** the checksum-locked, upstream-Sigstore-verified Jitsi Scaler chart
      now renders three independently placed regional shards behind a three-replica HAProxy room
      stick table. Every workload and Helm-test image is immutable by digest; deployment additionally
      requires all seven images to be mirrored into the owned registry and Cosign-verified with the
      operator's external public key before an atomic upgrade. Each region has an authenticated TURNS
      pool and externally managed TLS/HMAC credentials. Each JVB pool starts at three zone- and
      node-spread bridges, scales to nine on CPU with slow scale-down, enforces 80 participants per
      bridge, and retains 160 participants of modeled N-1 capacity after any one bridge/node/zone loss.
      JVB rollout enables the native drain API, waits up to ten minutes for active participants, then
      replaces only one host-port bridge; JVB, HAProxy, and TURN disruption budgets retain available
      capacity. The focused validator proves the chart/archive lock, complete digest set, topology,
      regional relay paths, room-only signaling affinity, limits, HPA/PDB/drain behavior, failure-model
      arithmetic, and upgrade/rollback contract; its online mode verifies the chart signature. The
      explicit-confirmation failure drill removes bridge workloads at bridge, node, or zone scope and
      fails release promotion when an external established-call RTP canary exceeds the 30-second SLO.

- [x] **MEET-14 — Record real participant and quality telemetry.** `[P2][P]` Evidence: attendee count
      and duration come from permission metadata, not media join/leave/QoS. **Minimum change:** privacy-
      reviewed events for join latency, loss, jitter, RTT, bitrate, reconnect, device failure, duration,
      and bridge load. **Exit:** dashboards/alerts reproduce injected degradations without logging media
      content or secrets. **Implemented 2026-09-02:** signed, idempotent media lifecycle events now
      supply participant joins, leaves, reconnects, exact session duration, and active bridge load;
      the embedded Jitsi client reports bounded join latency and device failures from conference/media
      events and samples its official connection statistics for packet loss, jitter, RTT, bitrate, and
      connection quality. A strict room-authorized ingestion schema rejects extra fields, impossible
      values, media content, and secrets, while Prometheus exports only fixed low-cardinality labels.
      Operational alerts cover repeated reconnect/device failures and every defined QoS degradation
      threshold; an executable Promtool rule test injects packet-loss and reconnect degradation and
      proves both alerts fire. Focused API, route, browser contract, parser, and live PostgreSQL tests
      prove data provenance, bounds, privacy, idempotency, reconnect detection, and duration accounting.

- [x] **MEET-15 — Implement enforceable host controls.** `[P1][G]` **Minimum change:** lobby/admit,
      meeting lock, remove/ban, mute policy, presenter/screen-share control, cohosts, chat/reaction policy,
      attendance, and safe host transfer. **Exit:** each control is server/media enforced, audited, and
      resistant to a crafted attendee client. **Implemented 2026-09-02:** tenant-scoped, row-locked host
      state now authorizes every mutation independently of attendee input, atomically versions each
      change, and writes append-only audit plus canonical activity records. Helix issues five-minute
      role/policy JWTs and rejects locked or banned joins before minting; Jitsi receives signed moderator,
      chat, reaction, and screen-share claims while Prosody/Jicofo enforce lobby, affiliation, A/V
      moderation, and disabled automatic ownership. The host UI executes only server-returned native
      media commands for admission, lock, removal, mute, presenter, and cohost actions; transfer is an
      atomic host-to-active-member handoff that retains the previous host as cohost. Attendance is derived
      from signed participant lifecycle sessions. Focused migration, store, tool, route, browser-contract,
      and static deployment tests prove forged controls fail, bans block reminting, policies enter signed
      tokens, transfers preserve a moderator, audit versions are monotonic, and the hardened Jitsi modules
      remain enabled.

- [x] **MEET-16 — Prioritize meeting parity deliberately.** `[P2][G]` **Minimum change:** product
      sequence for captions/transcription, layouts, noise cancellation, backgrounds, hand raise, polls,
      breakout rooms, Q&A, whiteboard, dial-in/out, livestream, large meetings, and calendar-room devices.
      **Exit:** only selected, end-to-end-tested capabilities are exposed; unsupported controls are
      absent rather than inert. **Implemented 2026-09-02:** the call surface now derives its optional
      capability set from the loaded Jitsi deployment instead of rendering speculative controls. Tile
      layout, noise suppression, and background blur execute the documented iframe commands and appear
      only when reported supported. Breakout rooms require the complete create/assign/join/close command
      set plus room listing, expose create/assign/close controls only to a server-authorized moderator,
      and retain only bounded room names and participant counts from Jitsi's participant-bearing event.
      Existing hand raise, server-enforced host controls, attendance, and consent-gated recording remain
      the supported paths. Captions/transcription, polls/Q&A, whiteboard, dial-in/out, livestream, room
      devices, and unqualified large-meeting claims are deliberately absent until their real service,
      authorization, persistence, privacy, and release-evidence dependencies exist. The false empty
      captions track was removed from recording playback. The support contract records the delivery
      sequence and exact boundary; focused capability, privacy-normalization, iframe-command, unsupported-
      control, and recording-render tests pass alongside web typecheck and scoped lint.

- [x] **MEET-17 — Prove media with real-browser and real-bridge tests.** `[P1][P]` Evidence: current
      tests do not prove actual audio/video/recording. **Minimum change:** CI/scheduled suite with two
      browsers, Jitsi stack, synthetic media, TURN-only path, reconnect, host controls, webhook, and
      recording integrity. **Exit:** artifact proves both peers exchanged media and enforced roles.
      **Implemented 2026-09-02:** a separate nightly/manual protected-environment Playwright gate creates
      a fresh Helix room and short-lived tokens, launches two independent Chromium processes with real
      synthetic camera/microphone streams, forces `iceTransportPolicy=relay`, and reads browser WebRTC
      stats to require bidirectional audio/video bytes plus selected relay candidates for both peers. It
      proves an offline/reconnected peer resumes new media, rejects attendee-forged server and native
      moderator commands, and applies a server-authorized host mute. The same run sends signed lifecycle
      webhooks from observed browser events, records through Jibri, waits for the validated completion
      artifact, downloads the stored MP4, and independently verifies its byte count, MP4 signature, and
      SHA-256. Only a complete run writes the redacted `evidence.json`; the ordinary mocked E2E suite
      explicitly excludes this spec, and absent live credentials fail rather than skip. Local verification
      compiled/linted and enumerated the gate, validated its infrastructure contract and Jibri payloads,
      and confirmed the live command fails closed without cluster credentials; no live-media artifact was
      fabricated in the development worktree.

- [x] **MEET-18 — Publish Meet SLOs and support boundaries.** `[P2][G]` **Minimum change:** supported
      browsers/devices/codecs/network requirements, join/call/recording SLOs, capacity envelope, regional
      routing, accessibility/keyboard/captions, incident playbooks, and privacy model. **Exit:** release
      evidence measures a sustained mixed call workload and failure recovery. **Implemented
      2026-09-02:** the production support contract now defines the tested browser, OS/device, portable
      codec, TLS/ICE/TURN, and bandwidth envelope; measurable join, healthy-media, recovery, and
      recording objectives; the certified 160-participant-per-region N-1 limit and truthful room-
      affinity/data-residency boundary; semantic keyboard/screen-reader behavior; and the explicit lack
      of live-caption support pending MEET-16/17 rather than making a false accessibility claim. It also
      documents the trusted-media-plane privacy model and concrete join, quality, infrastructure,
      recording, and credential/privacy incident playbooks. One executable release gate reads the
      existing capacity/SLO source, requires 30 minutes at 50% N-1 capacity in all three regions with
      concurrent two-party, small, large, screen-share, and recorded calls, enforces MEET-14 QoS and
      recording objectives, and rejects identity, media, or secret fields. The existing bridge/node/
      zone drill now emits its measured aggregate recovery JSON for that gate, including failed runs;
      focused positive/adversarial contract tests and the full offline Meet/HA validator pass.

## 12. Calendar and Contacts backlog (COL-01–COL-18)

- [x] **COL-01 — Separate calendar read, write, manage, and RSVP authority.** `[P0][P]` Evidence:
      `calendar/store.ts:656-676` treats organizer, attendee, and any permission as equivalent; update/
      delete reuse it. **Minimum change:** exact action decisions shared by HTTP/tools/CalDAV.
      **Exit:** attendees/viewers cannot move, rewrite, or cancel an organizer's event.
      **Implemented:** one store decision path now separates read, event update/delete, shared-calendar
      create, membership management, and RSVP. Writers can create but cannot rewrite another
      organizer's event; owners/managers govern same-tenant active-member roles through dedicated
      `calendar.manage` HTTP and tool surfaces; owners cannot be demoted or removed; attendees and
      viewers remain read/RSVP-only. Tools, browser HTTP, and CalDAV all reuse these store decisions,
      and focused authorization tests cover the hostile writer/attendee cases.

- [x] **COL-02 — Require writer authority to create on a shared calendar.** `[P0][P]` Evidence:
      `calendar/store.ts:635-653` accepts any calendar permission. **Minimum change:** enforce owner/writer
      role, resource policy, and tenant context. **Exit:** reader create is denied through API and CalDAV.
      **Implemented:** shared-calendar creation requires writer/owner authority; reader creation is
      denied at the common store boundary used by API and CalDAV.

- [x] **COL-03 — Bind authenticated RSVP to verified actor identities.** `[P0][P]` Evidence:
      `calendar/tools.ts:60-65` accepts attendee email and store matches actor **or** supplied email.
      **Minimum change:** actor RSVP only for membership's verified addresses; external attendee uses a
      signed scoped token. **Exit:** one user cannot accept/decline for another.
      **Implemented:** session RSVP derives the actor identity and cannot select another attendee by
      caller email/token; external responses remain on the scoped-token route.

- [x] **COL-04 — Revoke removed attendee access transactionally.** `[P0][P]` Evidence: attendee rows
      are recreated but prior event permissions remain. **Minimum change:** diff attendees, grants,
      notifications, and external tokens in one transaction/outbox. **Exit:** removed attendee cannot
      fetch/search/sync by known UUID immediately after commit.
      **Implemented:** attendee replacement removes stale participant grants and RSVP tokens in the
      event transaction before the updated attendee projection becomes visible.

- [x] **COL-05 — Validate organizer, attendee, calendar, and actor identity consistency.** `[P1][P]`
      Evidence: several paths accept caller actor ID/email without same-org verified mapping.
      **Minimum change:** resolve canonical membership/address and explicit external attendee records;
      forbid arbitrary internal UUID/email combinations. **Exit:** spoofed/cross-tenant identities fail.
      **Implemented:** event creation requires an active same-organization user with a canonical address;
      shared-calendar selection remains organization- and writer-bound. Attendee inputs are resolved at
      the store boundary: supplied actor IDs must be active in the event organization and match their
      canonical address, address-only internal users are bound automatically, and unmatched addresses
      become explicit external attendees with no actor authority. Updates preserve the original
      organizer instead of promoting the editing writer. Focused tests reject inactive organizers and
      foreign/spoofed attendee identities before attendee rows or grants are written.

- [x] **COL-06 — Make RSVP a non-prefetchable explicit action.** `[P1][P]` Evidence: GET RSVP mutates
      state and defaults to accept, so link scanners can respond. **Minimum change:** GET shows a safe
      confirmation page; POST consumes CSRF-protected session or signed one-use token with explicit
      response. **Exit:** crawlers/prefetch never change RSVP and replay is idempotent.
      **Implemented:** GET is a no-store, scriptless confirmation page and only an explicit POST with a
      selected response mutates state. The database atomically rotates the receiving attendee's
      unguessable bearer token in the same update, so only the winning request changes the RSVP or sends
      a reply; replays return an inert not-found response. Route and SQL-shape tests prove GET safety,
      explicit choice, atomic consumption, and replay behavior.

- [x] **COL-07 — Patch attendees by stable identity, not delete/recreate.** `[P1][P]` Evidence: update
      resets RSVP/tokens and risks stale grants. **Minimum change:** stable attendee IDs, add/update/remove
      diff, preserve response metadata, revoke only removed tokens, and version changes.
      **Exit:** unrelated event edits preserve RSVPs and invite links.
      **Implemented:** attendee synchronization resolves canonical identities, matches existing rows by
      actor ID then normalized address, updates mutable invite fields in place, and preserves attendee
      IDs, RSVP tokens, response state/time, and response metadata. It inserts only new attendees and
      deletes only removed rows, revoking only those removed actors' participant grants; active exact
      grants are no longer duplicated. Unrelated updates do not touch attendees, while every event
      change still advances `ics_sequence`. A live PostgreSQL test proves title edits and attendee-role
      changes preserve RSVP evidence, removed internal/external tokens become unusable, and only removed
      access disappears; 34 focused calendar tests pass. The work also corrected three dead
      `organizations` table references to the canonical `orgs` relation.

- [x] **COL-08 — Deliver invitations and updates through a durable outbox.** `[P1][P]` Evidence:
      send is non-atomic and non-idempotent. **Minimum change:** event revision + recipient + message type
      idempotency; leased delivery, cancellation/update semantics, retry/DLQ, and audit.
      **Exit:** crashes/retries send at most one correct revision to each attendee.
      **Implemented:** migration 0129 adds a tenant-isolated queue keyed by event revision, normalized
      recipient, and REQUEST/CANCEL type, with bounded skip-locked leases, expired-lease recovery,
      retry/dead-letter transitions, and append-only transition plus canonical outbox audit events.
      Event create/update/delete now snapshot and enqueue recipient-specific invitations and removed-
      attendee cancellations in the same transaction as the event revision; newer revisions supersede
      queued work, while the worker locks the current event revision before handoff so claimed stale work
      cannot send. Delivery runs in the recorded tenant/actor context and uses a stable RFC Message-ID
      protected by a PostgreSQL unique index, so a crash after Mail handoff is rediscovered instead of
      queued twice. The worker is leader-gated on the canonical server path and reuses Mail's durable
      leased SMTP delivery. A fresh database applied all 123 migrations; live tests prove mutation
      rollback atomicity, update/cancel supersession, stale claimed-work rejection, lease recovery,
      retry-to-DLQ, audit/outbox parity, cross-tenant isolation, and a real replay leaving exactly one
      Mail outbound row. All 58 focused/live Calendar tests, full `@helix/app` typecheck, targeted lint,
      and `git diff --check` pass.

- [x] **COL-09 — Implement scalable CalDAV sync.** `[P1][P]` Evidence: queries truncate at 250 and
      expose no sync token. **Minimum change:** stable collection ETag/sync-token, paged change log,
      tombstones, conditional writes, and ACL-aware discovery. **Exit:** >250 events and offline edits
      converge through a CalDAV conformance suite.
      **Implemented:** migration 0137 adds a monotonic per-calendar revision and immutable tenant-scoped
      event change log, backfills existing resources, preserves hard/soft-delete tombstones, and maintains
      revisions atomically through a least-privilege trigger. The log has a bounded indexed cursor, forced
      RLS, composite tenant ownership, and no direct mutation privilege. CalDAV now exposes distinct DAV
      root, principal, calendar-home, and ACL-visible calendar collections with stable collection ETags,
      ctags, scoped sync tokens, advertised sync-collection support, and role-correct privileges. RFC-style
      sync REPORTs return bounded pages of live resources and 404 tombstones, signal truncation with a 507
      continuation response, reject malformed/cross-calendar/future tokens, and converge to a snapshot
      token without the former 250-resource ceiling. PUT/DELETE pass If-Match revisions into the database
      mutation so concurrent stale writes fail atomically; create-only races also return 412, and RSVP
      representation changes advance the resource ETag. Protocol tests synchronize 253 resources in
      100-item pages, then converge an offline update/delete/create delta and reject revoked ACL access.
      Live PostgreSQL tests synchronize 303 resources, prove writer/reader/outsider ACL isolation across
      two tenants, stale-write rejection, exact tombstone deltas, runtime-role trigger execution, RLS, and
      append-only enforcement. A fresh database applied all 128 migrations through 0137; all 58 focused
      Calendar tests (55 pass, 3 intentional skips), the three live migration tests, targeted lint, and
      `git diff --check` pass. The app typecheck passed with the COL-09 diff and currently reports only
      unrelated, concurrent Drive share-link API work.

- [x] **COL-10 — Replace custom XML, ICS, and vCard parsers.** `[P1][P]` Evidence: regex/custom
      parsers mishandle namespaces, folding, quoting, parameters, and malformed percent encoding.
      **Minimum change:** small maintained standards libraries with size/depth/time limits and a shared
      error mapping. **Exit:** public interoperability corpus and fuzz tests pass without 500s.
      **Implemented:** one DAV standards boundary now uses maintained `fast-xml-parser` 5.10.1 for
      namespace-independent WebDAV/CalDAV/CardDAV request trees and Mozilla ICAL.js 2.2.1 for both RFC
      5545 iCalendar and RFC 6350 vCard. The handwritten XML tag regexes, ICS unfolding/property/
      parameter parser, and vCard line scanner are deleted. Parsing is capped at the 512 KiB DAV body
      limit, 32 XML levels, 4,096 nodes/content lines, and 250 ms; DTD/entity input is rejected and all
      format/size/complexity/timeout failures share `DavStandardsParseError`. Malformed XML and percent
      encoding return bounded 400/404 responses rather than 500s. Folded text, quoted parameters,
      namespace variants, entity text, nested-depth, malformed delimiter, calendar recurrence/exdate,
      vCard, CalDAV, CardDAV, and WebDAV vectors pass across 71 focused tests.

- [x] **COL-11 — Implement complete bounded recurrence.** `[P1][P]` Evidence: only daily/weekly/
      monthly subsets exist and unsupported rules silently become one-off. **Minimum change:** RFC 5545
      RRULE/RDATE/EXDATE with validation, occurrence/window limits, deterministic errors, and cursoring.
      **Exit:** supported corpus passes; unsupported/pathological rules reject explicitly and cheaply.
      **Implemented:** the bespoke daily/weekly/monthly parser and UTC cursor loop are deleted in favor
      of the focused BSD-licensed `rrule` implementation. One compact recurrence-set path now supports
      the RFC frequency and BY\* grammar plus metadata-backed RDATE/EXDATE, overlapping-duration windows,
      deterministic ordering, and exclusive ISO cursor pages. Rule/input length, COUNT, INTERVAL, date
      collection, page-size, result-count, and ten-year window bounds fail with one typed error instead
      of silently degrading to a one-off event. Tests cover ordinal yearly weekdays, hourly pagination,
      RDATE/EXDATE interaction, malformed embedded properties/dates, bounds, and duration preservation;
      32 recurrence/ICS/CalDAV tests and the 809-package dependency/license/dedupe gate pass.

- [x] **COL-12 — Make time zones and DST first-class.** `[P1][P]` Evidence: recurrence is UTC-based
      and UI appends `Z` to local values. **Minimum change:** store event timezone and canonical instant/
      local intent, use IANA tzdata, preserve floating/all-day semantics. **Exit:** spring/fall DST,
      traveler display, and timezone-change cases match published behavior.
      **Implemented:** migration 0147 persists a closed zoned/floating/all-day semantic plus canonical
      instants and local wall-clock intent. Shared `Intl`/IANA conversion rejects spring gaps and chooses
      the earlier fall-overlap instant; recurrence, free/busy, CalDAV/ICS, API tools, and the Calendar UI
      carry those semantics end to end. Date windows and event cards resolve in the viewer's zone while
      floating and all-day values do not shift, and changing only a zone preserves the stored wall time.
      Focused tests cover both DST transitions, traveler display/window boundaries, floating/all-day
      round trips, wall-time recurrence, and zone changes.

- [x] **COL-13 — Preserve recurring exceptions and revision history.** `[P1][P]` Evidence: recurring
      overrides are discarded and updates overwrite evidence. **Minimum change:** series master,
      occurrence override/cancellation, immutable revisions, sequence/DTSTAMP, conflict policy, and
      hold/export support. **Exit:** edit-this/edit-future/edit-series round trips through ICS/CalDAV.
      **Implemented:** each CalDAV resource retains its series master plus bounded structured
      `RECURRENCE-ID` components, including exact and `RANGE=THISANDFUTURE` overrides, cancellations,
      per-occurrence SEQUENCE/DTSTAMP, and attendee PARTSTAT. Expansion suppresses cancelled instances
      and applies exact/future time changes; GET/REPORT re-export the same components, while ETags keep
      series edits optimistic. Migration 0164 adds a tenant-isolated, 1 MiB-bounded append-only snapshot
      ledger for every create/update/RSVP/cancel/restore. Authorized history export is capped at 100
      revisions; restore requires the current sequence, restores attendee responses and deleted series,
      rotates RSVP tokens, appends a new audited revision, and revisions remain included in tenant export
      and retention/hold-controlled tenant deletion. Exact, cancelled, future-range, series-edit, bounded
      API, restore, immutability, and recurrence vectors pass across 65 focused tests.

- [x] **COL-14 — Emit standards-correct ICS.** `[P2][P]` Evidence: line folding counts characters,
      not UTF-8 octets. **Minimum change:** compliant octet folding/escaping, UID, organizer/attendee,
      METHOD, sequence, alarms, timezone components, and round-trip tests. **Exit:** major clients import,
      update, cancel, and RSVP without corruption.
      **Implemented:** ICS folding enforces the RFC 5545 75-octet physical-line limit without splitting
      Unicode code points; text handles every newline form and attendee parameters use RFC 6868 caret
      escaping. Exports include stable UID/sequence/DTSTAMP, organizer/attendee PARTSTAT, REQUEST/REPLY/
      CANCEL methods, bounded metadata-backed display alarms, and complete finite `VTIMEZONE` observances
      derived from IANA `Intl` data across the event horizon, with a bounded cache for multi-recipient
      sends. Tests cover Unicode, DST offsets, all-day values, alarms, cancellation, RSVP/reply, and a
      generated Unicode/TZID event round trip through CalDAV without identity, instant, recurrence, or
      attendee corruption; 24 focused emitter/route tests pass.

- [x] **COL-15 — Finish the calendar user experience without inert controls.** `[P2][P]` Evidence:
      mini-calendar is hardcoded to May 2026; day/month select the same week view; attendee email/join
      controls are inert; editor omits core fields. **Minimum change:** real date navigation, day/week/
      month/agenda, URL state, keyboard/a11y, complete editor, conflict errors, and working join links.
      **Exit:** every visible control changes persisted/navigable state or is removed/disabled with reason.
      **Implemented:** Today/previous/next and day/week/month/agenda now own typed URL state and distinct,
      bounded backend windows; day/month/agenda render date-correct scoped lists instead of relabeling the
      seven-day grid. Event location, safe conference, attendee email, RSVP, edit/delete, drag-create and
      drag-move actions are real, and the hard-coded mini-month was removed. Escape dismisses dialogs and
      popovers, interactive state is announced, and unavailable/pending/destructive states are explicit.
      The editor persists title,
      calendar, date/time, all-day/floating/zoned semantics, timezone, location, and description with
      actionable backend errors, plus attendee invitations, bounded alarms, and RFC recurrence rules;
      edits preserve unrelated event metadata. Twenty-seven focused Calendar UI/route/data checks pass,
      and the repository interaction inventory rejects reintroduced inert controls.

- [x] **COL-16 — Add scheduling and resource operations.** `[P2][G]` **Minimum change:** free/busy,
      working hours/location, find-a-time, rooms/equipment with conflict and approval policy, delegated/
      shared calendars, holidays, focus/out-of-office, reminders, and external availability privacy.
      **Exit:** multi-timezone person/resource scheduling scenarios enforce policy and avoid double-booking.
      **Implemented:** bounded scheduling profiles persist canonical timezones, per-day working windows,
      work location, holiday calendars, and explicit external busy-sharing consent. Find-a-time reuses the
      recurrence-aware free/busy engine for people, focus/out-of-office and holiday events, and requested
      room/equipment calendars; external consumers receive anonymous intervals only. Migration 0166 adds
      tenant-isolated room/equipment resources and approval-aware occurrence bookings, with assigned
      approvers and a per-resource transaction lock that atomically rejects approved overlaps. Event
      moves, recurrence edits, and deletion cancel affected bookings. Existing alarm-backed VALARM
      reminders and IAM-17 group-projected owner/manager memberships remain the shared reminder and
      delegation paths. Multi-timezone working-hours, holiday/focus/resource collision, privacy,
      approval, recurrence identity, and conflict vectors pass within 126 calendar/server/migration tests.

- [x] **COL-17 — Replace the Contacts placeholder with the real directory/People API.** `[P2][P]`
      Evidence: Contacts UI is disconnected from backend capability. **Minimum change:** personal contacts,
      org directory, groups, favorites, merge/dedupe, search, import/export, avatars, relationship metadata,
      and address autocomplete through one ACL-aware API. **Exit:** UI/API/CardDAV reflect the same data
      and suspended/private entries follow visibility policy.
      **Implemented:** the Contacts panel now consumes one bounded People API that projects an actor's
      private CardDAV contacts together with active organization actors and directory groups, deduplicates
      by canonical email, supports ranked search/favorites and address autocomplete, and renders bounded
      inline avatars and source identity. Personal vCard import/export, update/delete, favorite, standard
      RELATED metadata, and merge operations all update the canonical CardDAV row and sync version.
      Migration 0167 adds bounded contact annotations, merge identity, tenant validation, and forced RLS;
      every People transaction binds both tenant and actor context. Disabled/inactive directory actors are
      excluded and `directoryVisibility=private` entries are visible only to themselves. Seventeen focused
      People/CardDAV/UI checks and a fresh PostgreSQL 17 replay of all 156 migrations pass.

- [x] **COL-18 — Make CardDAV scalable, interoperable, and auditable.** `[P2][P]` Evidence:
      addressbook-query ignores filters, loads all contacts, and a legacy compatibility scope remains;
      contact mutations lack outbox/search/audit. **Minimum change:** real filter/pagination/sync-token,
      canonical vCard library, change events, retention/export, shared address books, and removal of legacy
      scope. **Exit:** CardDAV conformance plus >100k-contact sync operates with bounded memory.
      **Implemented:** CardDAV now uses the shared bounded `ical.js` vCard/XML standards parser, exact
      read/write app-password scopes, indexed FN/EMAIL/UID text matching, capped keyset query pages, and
      incremental sync pages whose token advances only through the last delivered change. Discovery
      advertises ACL, extended-MKCOL, and sync-collection; MKCOL and ACL manage tenant-bound shared address
      books through the existing permissions table, and every contact/book mutation emits one hash-chained
      activity record plus one outbox event. Contact events feed the durable search index behind a final
      address-book ACL check. Soft-deleted contacts have a 30-day purge deadline, explicit retention/legal
      hold protection (also wired into tenant-deletion blockers), bounded audited worker cleanup, and both
      vCard and tenant export coverage. Focused CardDAV/migration/search tests pass (22 passed; one live-only
      fixture skipped without its opt-in URL), focused lint/diff-check pass, and the full app typecheck passed
      before a concurrent unrelated `tool-registry.ts` DLP edit introduced two shared-tree errors. A
      fresh PostgreSQL replay applied the original 0168 schema with FORCE RLS restored. The synthetic
      100,001-contact route contract proves only 501 rows are requested for a 500-row sync page; the opt-in
      live 100k fixture was attempted after fixing its ordering and rollback design but the isolated Docker
      PostgreSQL volume returned ENOSPC during data generation, so no live 100k throughput pass is claimed.

## 13. Governance, compliance, and administration (GOV-01–GOV-18)

- [x] **GOV-01 — Build one retention, legal-hold, and eDiscovery engine.** `[P1][G]` Evidence: no
      matter/custodian/hold model exists across mail, chat, Drive, calendar, comments, or recordings.
      **Minimum change:** immutable content/revisions, policy precedence, holds that override every purge,
      scoped search, review, export, and chain-of-custody manifests. **Exit:** content deleted by a user or
      tenant remains discoverable under hold and purges only after release plus policy expiry.
      **Implemented 2026-09-03:** migration `0170_governance_ediscovery.sql` and the registered
      `platform/governance` admin surface provide one tenant-isolated matter/custodian/legal-hold/retention
      model over the existing mail, chat, Drive, recording, comment, and calendar sources plus their
      immutable revisions. Longest matching policy wins; active holds win over policy and every physical
      purge trigger, and materialized hold membership survives mailbox, room-membership, attendee, and ACL
      changes. Review writes must match the matter evidence set. Scoped search includes soft-deleted
      records; exports copy referenced bytes into the tenant's hidden governance prefix and write immutable,
      fork-proof, hash-chained custody manifests. Admin mutations and searches are RBAC-gated and audited,
      helper functions are not executable by runtime roles, and tenant deletion preflight includes central
      holds and retention. A fresh isolated PostgreSQL 17 cluster replayed all 158 migrations with zero
      skips, then the opt-in lifecycle test proved a deleted chat item remains searchable, hold blocks a
      privileged purge, retention still blocks unexpired content after release, and two-day-old content
      purges only after its one-day policy has expired (1/1 live). Focused unit/static tests pass (4/4),
      focused lint, diff-check, and the unsafe-cast
      gate pass. The shared Docker PostgreSQL remained unavailable after its ENOSPC condition, so the live
      proof used a disposable local PostgreSQL 17 cluster without touching shared Docker state. Full app
      typecheck is green.

- [x] **GOV-02 — Implement real cross-product DLP.** `[P1][P]` Evidence: DLP is an advisory config
      field without enforcement. **Minimum change:** one detector/classifier and policy evaluator for
      mail send, upload, share, download, chat attachment/message, copy/export, API/agent, and external
      guest actions; support block/warn/quarantine/audit. **Exit:** seeded sensitive data triggers the
      same documented decision on every egress path.
      **Implemented:** one tenant-policy-backed, 256 KiB-bounded evaluator detects validated payment
      cards, PII, credentials, and source code, raises the server-derived resource classification, and
      emits content-free audit evidence. The central tool registry applies the same decision to Mail,
      Drive sharing, Chat, editor copy/export, REST/MCP, and assistant/service-account calls; direct
      Drive/WebDAV downloads, public guest links, Chat sockets, and Chat attachment routes use the same
      guard. `warn` reuses pending-action confirmation, `block` withholds egress while content-bearing
      writes are checked before persistence,
      `quarantine` uses Drive's durable inaccessible quarantine, and scan-limit/policy/audit failures
      become restricted findings or fail closed. The seeded card-number matrix asserts the identical configured decision across all
      nine boundaries; focused DLP, policy, tool, route, and durable-quarantine suites pass (179 tests),
      with application typecheck, focused lint/format, and repository diff checks green.

- [ ] **GOV-03 — Add sensitivity labels as policy inputs, not decoration.** `[P2][G]` **Minimum
      change:** centrally defined labels with required metadata, inheritance/defaulting, downgrade
      permission, visual marking, DLP/retention/sharing/encryption effects, audit and export.
      **Exit:** a confidential label reliably changes access and downstream behavior across products.

- [x] **GOV-04 — Make data residency physically true.** `[P1][P]` Evidence: organization region is
      metadata while SQL, objects, indexes, queues, backups, recordings, logs, and AI are global.
      **Minimum change:** regional placement map and routing for every content/derivative system, immutable
      or controlled migrations, and telemetry residency. **Exit:** a trace proves selected-region data
      and derivatives never leave allowed boundaries.
      **Implemented 2026-09-03:** each production deployment is now one physical regional cell, with
      `HELIX_REGION` as the sole placement decision. Startup rejects a default/invalid region, storage or
      KMS mismatches, mixed-region SQL tenants, unprefixed search indexes, global OpenAI shortcuts,
      externally hosted preview/Ollama processors without in-cluster routing, and AI, Meet, SIEM, immutable
      audit, or telemetry processors without an exact matching region declaration. Tenant resolution
      returns HTTP 421 when a request reaches the wrong cell; tenant creation cannot select another cell;
      BYO object storage and its KMS ARN are checked before credentials or data are accessed. NATS subjects,
      Meilisearch indexes, and backup directories are region-namespaced while SQL-backed queues inherit the
      region-locked database. Migration `0172_regional_data_residency.sql` validates canonical placement and
      BYO storage equality in PostgreSQL and makes region relabeling impossible, requiring a verified
      export/import into a destination cell for moves. The Helm release uses the existing S3 region as the
      canonical cell value, schedules the application, role workers, content converter, and optional
      CloudNativePG cluster onto that region, rejects backup destinations that omit it, and supplies the
      same placement to Meet, SIEM, and telemetry. Traces now carry both `helix.tenant.region` and
      `helix.deployment.region`, making any mismatch queryable while the request guard prevents processing.
      Focused residency, routing, storage, telemetry, organization, and migration checks pass (73 tests),
      application typecheck and focused lint pass, and all four Helm profiles render with the mandatory
      regional selectors and environment.

- [ ] **GOV-05 — Offer a coherent customer-key/client-side encryption tier.** `[P2][G]` **Minimum
      change:** decide server-side CMEK versus true client-side encryption per product; define key access
      service, rotation/revocation, recovery, search/DLP/preview/mobile limitations, and external-user
      behavior. **Exit:** cryptographic tests and product copy accurately prove the selected threat model.

- [x] **GOV-06 — Couple every privileged mutation to durable audit.** `[P1][P]` Evidence:
      `admin/console-shared.ts:193-216` swallows audit failures after mutations. **Minimum change:** write
      mutation intent and audit outbox atomically or fail the security-critical mutation.
      **Exit:** fault injection cannot produce a successful privileged change without an eventual event.
      **Implemented:** privileged route constructors now require a durable audit sink, and
      `auditAdminAction` propagates failed writes instead of swallowing them. Production admin stores and
      `PostgresAuditStore` share the request-scoped
      tenant transaction, so a failed audit savepoint aborts and rolls back the mutation; focused fault
      injection proves the transaction ends in rollback, and 117 affected admin route tests pass.

- [x] **GOV-07 — Make audit ordering concurrency-safe and tenant-bound.** `[P1][P]` Evidence:
      concurrent first events can fork; hash omits org/event/sequence. **Minimum change:** per-org locked
      chain head, monotonic unique sequence/predecessor, canonical payload including org/event/schema.
      **Exit:** 100 concurrent appends make one contiguous chain and transplant/reorder is detected.
      **Implemented:** migration `0149_audit_chain_integrity.sql` installs one forced-RLS per-org chain
      head, row-locked sequencing, a canonical database hash over tenant/event/schema/sequence and all
      persisted event fields, deterministic backfill, immutable runtime rows, and trigger enforcement for
      every direct `activity` writer. The store verifies in numeric sequence order under tenant context;
      three fixed read-only `SECURITY DEFINER` worker functions expose only organization IDs, bounded
      shipping pages, and backlog totals so verification/shipping work across tenants without granting
      the runtime role `BYPASSRLS`. Its live runtime-role check makes 100 concurrent appends, proves
      reorder and cross-tenant transplant detection, and confirms cross-tenant worker visibility. A fresh
      database applied all 141 current migrations through `0152` and the live check passes.

- [x] **GOV-08 — Authenticate and externally anchor audit evidence.** `[P1][P]` Evidence: plain SHA
      chain can be regenerated and DB trigger cannot resist owner/superuser. **Minimum change:** HMAC/
      signature from external key, periodic immutable object/WORM anchor through separate append account,
      and independent reconciliation. **Exit:** privileged DB rewrite/deletion is detectable.
      **Implemented:** immutable-S3 format v2 authenticates each tenant/schema/sequence-bound manifest
      through an async external signer/verifier boundary; production immutable shipping fails closed
      without a separately configured key ID and 256-bit-or-longer HMAC secret held outside PostgreSQL.
      The dedicated `AUDIT_IMMUTABLE_S3_*` client now sends real S3 Object Lock mode/retain-until
      directives instead of decorative metadata. Every leader-gated shipping interval discovers signed
      manifests from the independent archive (not a mutable database checkpoint), verifies manifest and
      record-object integrity, and compares each externally anchored tail against the complete current
      tenant chain before advancing its checkpoint. Focused tests prove authenticated archive tamper,
      privileged full-chain rewrite, anchored-row deletion, and reconciliation failure; the fresh-database
      100-writer/RLS shipping integration plus S3 request tests pass (37 checks), and the wider affected
      audit/storage suite passes (70 checks).

- [x] **GOV-09 — Implement verifiable tenant deletion.** `[P1][P]` Evidence: hard-delete worker is
      wired with `steps: []` and marks completion. **Minimum change:** hold/retention-aware deletion
      manifest covering SQL, objects, indexes/vectors, caches, queues, recordings, backups, identities,
      and keys; idempotent retries and valid system audit principal. **Exit:** synthetic tenant is absent
      everywhere except declared evidence and completion has a signed proof.
      **Implemented:** migration `0152_verifiable_tenant_deletion.sql` adds a forced-RLS, immutable proof
      ledger and two security-definer primitives: preparation refuses active Mail/Drive/recording holds or
      future retention, inventories every tenant storage-key column from the native catalog, and the purge
      discovers every `org_id` table, preserves only the tenant tombstone/audit chain/proof, resolves FK
      order, deletes queue/index/credential rows, removes orphaned global identities, and redacts principals
      retained solely for audit integrity. The worker now verifies the entire default/BYO object namespace
      is empty, removes external search/vector projections, tenant Redis keys and Vault secret trees, then
      stores a canonical SHA-256 manifest with an HMAC authentication in the configured Object-Lock
      compliance destination. The backup section explicitly distinguishes restore denial and scheduled
      encrypted-block expiry from immediate physical erasure. Completion and the hard-delete transition
      are idempotent; the latter atomically appends through the concurrency-safe audit trigger using the
      proof's real tenant-local system actor. Focused hold/failure/retry/idempotency tests pass, fresh replay
      applies all 141 migrations, and a live synthetic tenant check proves hold denial, complete SQL purge,
      principal redaction, proof retry, hard-delete transition, and the final system audit event.

- [ ] **GOV-10 — Make tenant/user export complete and portable.** `[P1][P]` Evidence: current export
      explicitly omits mail bodies and object bytes. **Minimum change:** raw mail, files/versions,
      documents, chat/revisions, calendars, contacts, recordings, ACL/metadata, and checksummed manifest
      in documented standard formats. **Exit:** import into a clean Helix instance preserves sampled
      data and permissions, with secrets excluded.

- [ ] **GOV-11 — Govern guests and all external sharing centrally.** `[P1][G]` Evidence: sharing
      settings are advisory and there is no sponsor/expiry guest membership model.
      **Minimum change:** trusted/blocked domains, invitation state, sponsor, expiry, periodic review,
      federation/link policy, and enforcement at share/send/invite/join/export boundaries.
      **Exit:** internal/trusted/blocked/expired/public/anonymous matrix passes across products.

- [ ] **GOV-12 — Add access reviews and privileged-access lifecycle.** `[P2][G]` **Minimum change:**
      periodic certification for admins, service accounts, groups, shared drives, guests, OAuth apps, and
      public links; time-bound just-in-time elevation and automatic expiry. **Exit:** reviewers can attest/
      revoke, overdue campaigns escalate, and removed access invalidates live sessions/tokens.

- [ ] **GOV-13 — Turn every visible security policy into an enforcement contract.** `[P1][P]`
      Evidence: `admin/security-policies.ts:17-29` explicitly calls MFA, SSO, sessions, sharing, DLP, and
      devices advisory. **Minimum change:** one policy evaluator called by each boundary, with deny reason
      and simulation; hide any policy until a consumer exists. **Exit:** every Admin control has an allow
      and deny end-to-end test.

- [ ] **GOV-14 — Build an investigation and response center.** `[P2][G]` **Minimum change:** unified
      search/timeline for login, admin, mail, Drive, Chat, Meet, device, OAuth, DLP, malware, and export
      events; scoped investigator roles, case notes, preservation, response actions, and privacy audit.
      **Exit:** compromise scenarios can be detected, scoped, contained, preserved, and exported.

- [ ] **GOV-15 — Implement a real break-glass path.** `[P2][P]` Evidence: Admin advertises local
      owner recovery but no secure runtime flow exists. **Minimum change:** hardware-factor protected,
      limited-duration emergency identity, optional dual control, immediate alert, immutable audit, and
      periodic drill. **Exit:** IdP outage recovery works without becoming a casual SSO bypass.

- [ ] **GOV-16 — Version, simulate, stage, and roll back organization policy.** `[P2][G]` **Minimum
      change:** immutable policy versions, validation/conflict analysis, dry-run impact counts, staged OU/
      group rollout, effective-policy explanation, rollback, and propagation SLA. **Exit:** an invalid or
      lockout-causing policy cannot deploy blindly and rollback is deterministic.

- [ ] **GOV-17 — Establish privacy and cryptographic lifecycle controls.** `[P2][G]` **Minimum
      change:** data inventory/purpose, minimization, regional subprocessors, consent/notice, subject
      request workflow, tenant-key hierarchy, rotation/destruction, tokenization/redaction, and secure
      support access. **Exit:** a data map connects each stored field/blob/index/log to owner, purpose,
      region, retention, encryption, and deletion path.

- [ ] **GOV-18 — Produce evidence, not certification-shaped UI.** `[P3][D]` **Minimum change:** choose
      target frameworks only after controls work; automate control evidence, owner/review cadence,
      exceptions, risk register, penetration test, threat models, incident/tabletop records, and customer
      trust documentation. **Exit:** every public security/compliance claim links to current evidence and
      no unimplemented certification is implied.

## 14. Operations, reliability, test, and supply chain (OPS-01–OPS-22)

- [x] **OPS-01 — Make liveness and readiness truthful.** `[P0][P]` Evidence: `/healthz` and `/readyz`
      always return OK, and Caddy replaces health with static success. **Minimum change:** liveness checks
      process; readiness uses bounded cached probes for migrations, DB, storage, queue, Redis, search,
      identity keys, AV, audit, and workers required by tier. **Exit:** disabling each dependency removes
      the pod from readiness without leaking sensitive diagnostics.
      **Implemented:** Caddy now proxies the application probes; liveness is process-only, while readiness
      concurrently runs cached, deadline-bounded checks for pending migrations, PostgreSQL, object
      storage, Redis, NATS, search, configured identity keys, ClamAV, audit configuration/status, and
      leader-supervised workers as required by the running tier. Public responses expose only `ok`, and
      production migration checks now default on. Parameterized route tests fail each required probe in
      turn, assert HTTP 503, and prove that public responses never disclose the failing dependency.

- [x] **OPS-02 — Produce a consistent DB/object backup.** `[P1][P]` Evidence: object capture can be
      silently skipped and `pg_dump` plus `s3 sync` has no shared boundary. **Minimum change:** fail when
      required object storage is omitted; record DB LSN/snapshot and immutable object-version manifest,
      then reconcile every ready reference. **Exit:** every DB-snapshot object exists exactly once in
      backup and no post-boundary object is claimed.
      **Implemented:** backup now holds an exported repeatable-read snapshot while both `pg_dump` and
      the ready-reference query run, recording its database timestamp and LSN. Object capture requires
      bucket versioning, selects the newest immutable version no later than that boundary, downloads it
      by version ID, and reconciles key/size/digest for each unique ready object/version/preview
      reference; missing, conflicting, post-boundary-only, or mismatched blobs fail the backup. Business+
      omission fails even in dry-run policy validation. A live isolated Postgres/RustFS run captured one
      referenced version, restored the signed dump, and verified the exact blob; the helper corpus also
      proves post-boundary versions are excluded and corruption is rejected.

- [x] **OPS-03 — Sign a complete backup integrity manifest.** `[P1][P]` Evidence: inventory errors
      are ignored and manifest lacks per-file checksum/size/count/version/build/schema/LSN/signature.
      **Minimum change:** signed checksum/Merkle manifest over database, object versions, configs, and
      metadata. **Exit:** bit flip, truncation, missing object, wrong build, or forged manifest fails
      before restore.
      **Implemented:** schema-v3 manifests record the immutable app build, database LSN and applied
      migrations, capture/encryption configuration, object/version inventories, and sorted SHA-256,
      size, and count metadata for every artifact. Backups require an Ed25519 signing key; restore
      verifies the pinned public-key identity, signature, expected build when configured, and exact
      filesystem inventory before any PostgreSQL or object-store mutation. Native-crypto tests reject
      altered, truncated/missing, wrong-build, and forged inputs.

- [x] **OPS-04 — Safely extract untrusted restore archives.** `[P0][P]` Evidence:
      `infra/scripts/restore.sh:105-154` pipes directly to `tar -xzf`. **Minimum change:** authenticate
      first; reject absolute/parent paths, devices, hardlinks, and escaping symlinks; extract with safe
      ownership/modes in an isolated directory. **Exit:** tar-slip/symlink corpus cannot write outside it.
      **Implemented:** `infra/scripts/safe_extract_tar.py` permits only regular files/directories, rejects
      absolute/parent/duplicate/link/device entries before extraction, and never restores ownership;
      `infra/scripts/test_safe_extract_tar.py` plus `validate-restore-drill.sh` exercise the attack corpus.

- [x] **OPS-05 — Restore objects atomically to a new target.** `[P1][P]` Evidence: restore uses
      `aws s3 sync --delete` directly against target. **Minimum change:** new versioned bucket/prefix,
      validate against manifest, atomically switch routing, preserve rollback pointer. **Exit:** failed/
      interrupted restore never changes production and rollback is tested.
      **Implemented:** restore refuses the source/existing target, creates a new bucket, confirms
      versioning, uploads the signed inventory, and downloads/hashes every result before invoking a
      three-command compare-and-swap route adapter. It durably writes the old/new rollback receipt
      before switching, so any pre-switch failure leaves production untouched and any post-switch
      interruption retains the rollback pointer. `--no-object-switch` isolates drills;
      `--rollback-objects` detects drift and idempotently restores the old route. A live RustFS test
      restored and verified the blob into a new bucket, switched a CAS route, and rolled it back.

- [x] **OPS-06 — Make PITR prove a running recovered database.** `[P1][P]` Evidence: script only
      prepares a data directory then reports completion. **Minimum change:** start isolated PostgreSQL,
      replay WAL to target, verify time/schema/invariants, promote, run logical checks, and clean up.
      **Exit:** drill proves a pre-target row exists and post-target row does not.
      **Implemented:** `--pitr` now takes a checked physical base backup with WAL fetch, waits for the
      exact switched segment to archive, and can create committed before/after proof markers around a
      recorded recovery timestamp. Restore materializes an empty PGDATA, configures archive recovery,
      starts the Compose Postgres image with networking disabled, waits for promotion, verifies core
      relations, asserts the before marker count is one and the post-target count is zero, then removes
      the isolated container. A live Postgres 17 run replayed archived WAL, promoted, passed both marker
      assertions and logical invariants, and exited zero.

- [x] **OPS-07 — Drill a prior independent backup including objects.** `[P1][P]` Evidence: nightly
      workflow creates/restores a fresh same-run DB backup and omits object restore. **Minimum change:**
      fetch previous immutable artifact, enforce age, restore DB and isolated object store, validate
      random/full referenced blobs, and page on stale/missing backup. **Exit:** deleting yesterday's
      artifact or corrupting one object fails the drill.
      **Implemented:** the nightly job queries a completed earlier workflow run (explicitly excluding
      its own run ID), enforces a 36-hour maximum age, downloads that run's immutable signed artifact,
      and restores its DB plus every referenced blob into isolated targets. Missing/expired/incomplete
      artifacts fail, and a failure job emits a PagerDuty event. A separate `if: always()` job publishes
      the next run's backup with a real DB-referenced proof blob, so the artifact under test can never
      be produced by the same restore job. Contract tests delete the prior artifact, age one past the
      limit, tamper with a captured blob, and verify all three paths fail; the live drill restored and
      SHA-256 checked the referenced blob.

- [x] **OPS-08 — Use authenticated envelope encryption without argv leakage.** `[P1][P]` Evidence:
      backup helper uses AES-CBC and exposes plaintext key in process arguments. **Minimum change:** vetted
      AEAD (AES-GCM/ChaCha20-Poly1305) envelope tooling and fd/file secret input. **Exit:** tampering fails
      authentication and process/log inspection never exposes a key.
      **Implemented:** `infra/scripts/aes-gcm-file.mjs` streams AES-256-GCM with a versioned authenticated
      header; KMS plaintext keys move directly from AWS CLI stdout to helper stdin and are zeroed after
      use. The validation suite proves round-trip behavior and rejects tampered ciphertext.

- [x] **OPS-09 — Move restore out of the synchronous Admin API.** `[P1][P]` Evidence:
      `admin.config.write` launches destructive restore with `--allow-drop-target` in the API process.
      **Minimum change:** dedicated backup-admin permission, step-up + dual control, explicit isolated
      target, durable leased job, idempotency/cancel, and immutable audit. **Exit:** config admins cannot
      restore and retry/restart cannot double-drop or vanish.
      **Implemented:** migration `0148_backup_restore_jobs.sql` persists idempotent restore requests,
      two distinct non-requester approvals, cancellation state, and reclaimable leases. The Admin API
      now requires recent MFA plus `admin.backups.restore`; its worker appends hash-chained lifecycle
      audit records and restores only into explicitly named `helix_restore_*` / `helix-restore-*`
      targets without `--allow-drop-target`, so config admins cannot restore and an expired-lease retry
      cannot erase an existing target.

- [x] **OPS-10 — Default-deny network policy by workload.** `[P1][P]` Evidence: Helm permits broad
      ingress and all egress, with RFC1918 allowances. **Minimum change:** service-account/namespace
      selectors and exact ports; controlled HTTP egress; separate plugin/media policies.
      **Exit:** unrelated pods cannot connect and workloads cannot scan cluster/private/metadata ranges.
      **Implemented:** Helm now emits ingress-and-egress default-deny policy separately for the default
      app, each role workload, the no-network content converter, and the image verifier. Allowed
      in-cluster paths require exact namespace, service-account identity, workload labels, and ports;
      public HTTPS excludes private, link-local, metadata, benchmark, documentation, multicast, and
      otherwise non-global IPv4/IPv6 ranges. Chart validation rejects disabled policy, broad/empty
      selectors, subnet-sized private exceptions, metadata exceptions, and unscoped ingress.

- [x] **OPS-11 — Make role deployments routable or delete them.** `[P1][P]` Evidence: role-specific
      deployments exist but the only Service selects `role: default`. **Minimum change:** explicit
      per-role services/ingress and consistent identity/secret mounts, or remove nonfunctional roles.
      **Exit:** realtime/worker traffic demonstrably reaches the intended scaled pods.
      **Implemented:** every configured role now receives an exact-label-selector ClusterIP Service,
      optional HPA targeting its matching Deployment, and the same SPIRE socket, Vault CSI mount,
      identity annotations, configuration, and external-secret environment as the primary workload.
      Helm validation renders a realtime role and proves the Service, Deployment, HPA, role selection,
      and workload-identity wiring agree; operators can attach ingress to that named Service.

- [x] **OPS-12 — Pin and verify every deployable artifact.** `[P1][P]` Evidence: Helm/Compose and
      package manifests contain mutable `latest`/`stable`. **Minimum change:** immutable image/action/
      dependency digests or exact versions, signatures/provenance, SBOM, reviewed update automation.
      **Exit:** clean deployment resolves only approved signed immutable artifacts.
      **Implemented:** all production images are repository-plus-digest, GitHub Actions are SHA-pinned,
      package resolutions are exact under a frozen lockfile, and reviewed Dependabot updates are wired.
      Helm refuses a missing/mutable digest and a pre-install/pre-upgrade gate verifies the exact image's
      Cosign signature, SPDX SBOM attestation, and SLSA provenance against an operator-pinned public key;
      CI enforces artifact policy and negative install cases.

- [x] **OPS-13 — Keep Compose explicitly local-development-only.** `[P1][P]` Evidence: it sets
      production mode while using defaults and publishing internal services. **Minimum change:** rename/
      label local profile, bind debug ports to loopback, private networks, generated secrets, and supply
      a hardened Helm/reference production profile separately. **Exit:** no operator can mistake default
      Compose for secure production.
      **Implemented:** the stack is named and labeled local-development-only, fixes `NODE_ENV` to
      development, binds internal/debug ports to loopback, uses runtime-generated Meet volumes, and is
      contract-checked in CI; hardened Helm remains the documented production path.

- [x] **OPS-14 — Add zone-aware availability and safe rollout.** `[P2][P]` Evidence: affinity/
      topology are empty and role pods miss security mounts. **Minimum change:** disruption budgets,
      anti-affinity/topology spread, priority/startup/readiness, graceful drain, migration compatibility,
      canary/rollback, and consistent workload identity. **Exit:** node/zone drain and failed release stay
      within SLO without split-brain.
      **Implemented:** every API, role, and isolated conversion workload now uses node anti-affinity,
      soft zone/node skew, a dedicated disruption budget, startup/readiness/liveness separation,
      finite rollout progress, and zero-unavailable one-pod-at-a-time replacement. Role pods retain the
      same service account, Vault, SPIRE, secret, and security mounts as the default workload; secure
      tiers require an operator-managed priority class. The release contract applies expand-only schema
      changes ahead of an atomic Helm rollout and documents drain prechecks and exact-revision rollback;
      chart validation proves the rendered availability and identity invariants across all tiers.

- [x] **OPS-15 — Secure and retain observability as production data.** `[P2][P]` Evidence: Loki,
      Tempo, and OTEL are auth-disabled/local/in-memory/broadly exposed. **Minimum change:** TLS and
      workload auth, restricted listeners, durable replicated storage, tenant isolation, retention,
      redaction, access audit, and cost limits. **Exit:** node loss preserves incident window and
      unauthorized ingest/query fails.
      **Implemented:** production-only Loki, Tempo 3, OTEL Collector, Grafana, and NetworkPolicy assets
      now require mTLS workload identity, fixed deployment tenant headers, restricted selectors,
      three-way durable S3/Kafka-backed operation, 30-day retention, sensitive-attribute redaction,
      access logging, and bounded ingestion/cardinality/query load. Helix rejects insecure production
      OTLP configuration at boot. The production contract and runbook define versioned cross-failure-
      domain storage, config/data recovery, certificate rotation, and repeatable unauthorized-client
      and single-node-loss drills; focused tests and the pinned Loki/Tempo/Collector validators cover
      those invariants while leaving the local Compose profile intentionally local-only.

- [x] **OPS-16 — Instrument real capability and integrity metrics.** `[P1][P]` Evidence: Drive
      dashboard queries series that do not exist. **Minimum change:** RED/useful business metrics for
      auth, queues, upload/finalize/download, AV/quarantine, quota, search lag, mail delivery, Chat replay,
      Meet quality, policy/audit, backup/restore, and reconciler drift. **Exit:** dashboards return live
      series and synthetic failures exercise alerts.
      **Implemented:** the provisioned capability-health dashboard now queries only registered HTTP,
      tool, policy/audit, search, Meet, and bounded operational series. Real mail dispatch, Drive
      finalize/download/scan/quarantine/quota, Chat fanout/replay, and search reconciliation paths emit
      the missing internal signals without tenant/object labels. Helm and local Prometheus load the
      capability alert rules; promtool synthetic failures prove generic operation, mail terminal-delivery,
      and persistent reconciliation-drift alerts.

- [x] **OPS-17 — Define product SLOs and error budgets.** `[P2][G]` **Minimum change:** availability,
      API latency, mail queue/delivery, file durability/integrity, search freshness, Chat fanout/replay,
      meeting join/quality, RPO/RTO, and policy propagation objectives by tier, with burn-rate alerts and
      owner runbooks. **Exit:** a monthly report derives from telemetry and blocks unsafe releases.
      **Implemented:** one tiered 30-day policy drives Prometheus recording rules, multi-window burn-rate
      alerts, a provisioned Grafana dashboard, and an owner runbook. The scheduled fail-closed report
      combines live Prometheus vectors with protected periodic gate evidence; Helm promotion rejects a
      missing, failed, or older-than-35-days report. Static, evaluator, alert-rule, and Helm wiring checks
      cover the release path.

- [x] **OPS-18 — Add one consolidated security/supply-chain CI gate.** `[P1][P]` Evidence: no
      CodeQL/SAST, secret, dependency/license, SBOM, container, IaC, signature, or provenance gate; actions
      are not uniformly pinned. **Minimum change:** fast changed-scope checks on PR and complete scheduled
      scan; fail on defined severity/licensing/secrets/policy. **Exit:** seeded secret, vulnerable dep,
      critical image, unsafe manifest, and unsigned artifact each fail CI.
      **Implemented:** one pinned-action workflow runs fast path-scoped PR checks and complete main,
      manual, and scheduled scans: production advisory policy, CodeQL, Trivy dependency/license/secret/
      IaC checks, SPDX SBOM generation, full deployable-image scanning, chart provenance attestation,
      and install-time image signature/SBOM/provenance verification. Unfixed high/critical findings fail.
      Deterministic negative policy probes reject a seeded credential, critical-image policy weakening,
      unsafe manifest scan removal, vulnerable dependency/expired exception, mutable action, and unsigned
      artifact path. A checked-in, idempotently applicable main-branch protection policy requires the
      consolidated check for administrators too and prohibits force-push/delete bypasses.

- [x] **OPS-19 — Remediate the current production dependency advisories.** `[P0][P]` Evidence:
      audit found 83 vulnerable paths including Better Auth stored-XSS/account-takeover advisories,
      `pdfjs-dist` arbitrary JS, Nodemailer SSRF/file-read/header/TLS issues, and vulnerable Sharp/libvips.
      **Minimum change:** upgrade/replace direct risks, prove patched resolution, triage transitive test-
      only paths, and enforce a time-bounded exception file. **Exit:** production audit has no critical/
      high exploitable advisory and every exception has owner/expiry/evidence.
      **Implemented:** direct security upgrades and narrow transitive overrides reduced the audit from 1
      critical/49 high to 0 critical and 2 high. Both remaining highs are unpatched `image-size` parser
      advisories behind `pptxgenjs`; runtime input is now size- and magic-byte-restricted to PNG/JPEG/GIF
      with a disguised-ICNS regression test. `pnpm audit:prod` enforces the two owner/expiry/evidence
      exceptions in `security/dependency-audit-exceptions.json` and fails for any new critical/high.

- [x] **OPS-20 — Replace fake integration coverage with mandatory real-service tests.** `[P1][P]`
      Evidence: Drive E2E uses fakes, S3 uses fetch stub, authz uses handwritten SQL, and PostgreSQL/
      corpus suites skip. **Minimum change:** smallest CI topology with PostgreSQL, S3-compatible store,
      AV, Redis/queue, search, SMTP edge/provider fake, policy engine, and two orgs. **Exit:** critical flow
      suites run unskipped and prove both allow and deny paths.
      **Implemented:** the required live E2E job now boots PostgreSQL, RustFS, Redis, NATS, Meilisearch,
      Mailpit, Cerbos, SpamAssassin, and ClamAV and fails if either mail-security daemon is unavailable.
      Before the browser suite starts, a non-skippable contract run exercises Redis persistence, NATS
      round-trip delivery, Meilisearch tenant filtering, clean/EICAR ClamAV verdicts, a real spamd scan,
      Cerbos allow/deny decisions, the full SDK-backed S3 range/copy/presign/multipart contract, and the
      adversarial two-organization PostgreSQL/Drive isolation fixture. The same live job then runs the
      authenticated Mail, Chat, Drive, Calendar, Docs, and SMTP-to-Mailpit browser flows with real service
      endpoints; no mock fallback is enabled in that job. The new test is opt-in locally but mandatory in
      CI, so normal unit runs stay fast while service failures block merge.

- [ ] **OPS-21 — Exercise sustained load and failure recovery.** `[P2][P]` Evidence: k6 defaults to
      mock, live smoke is two seconds, and Drive is omitted. **Minimum change:** mixed upload/download/
      search/share/mail/chat/meeting/admin workloads plus soak and kill/dependency/latency/disk-full fault
      injection, asserting SLO and integrity. **Exit:** published capacity/recovery envelope is measured,
      repeatable, and names its hardware/topology.

- [ ] **OPS-22 — Enforce tenant fairness and regional disaster boundaries.** `[P2][G]` **Minimum
      change:** per-tenant quotas/rates/concurrency/queue partitions, backpressure, cost attribution,
      regional failure domains, restore/failover policy, and noisy-neighbor tests. **Exit:** one abusive
      tenant cannot breach another's latency/quota or cause cross-region data movement.

## 15. Minimality, UX, migration, editors, and AI (MIN-01–MIN-18)

- [x] **MIN-01 — Delete all advertised empty plugin/connector stubs.** `[P1][P]` Evidence: nineteen
      `plugins/**/index.js` files are `export default {}` and runtime special-cases them.
      **Minimum change:** remove module, manifest, catalog/config/UI claim, and scaffold branch until a
      real capability exists. **Exit:** every discoverable/installable plugin registers tested behavior
      and a health signal.
      **Implemented:** all nineteen empty module trees plus every remaining manifest-only core-app,
      AI-provider, embedding, and vector-store descriptor are deleted. Core apps remain explicitly wired
      platform modules and AI/vector implementations remain ordinary configured adapters, so neither is
      falsely installable. The catalog now contains exactly two real artifacts: the process-isolated
      Slack connector with registration/behavior/health coverage and the no-egress LibreOffice service
      with an executable Compose recipe and health check. A catalog contract rejects any reintroduced
      empty entrypoint or external service without health-checked deployment behavior.

- [ ] **MIN-02 — Expose one canonical API/protocol surface.** `[P1][P]` Evidence: server rewrites
      `/v1` and unprefixed routes and retains compatibility aliases. **Minimum change:** select the
      versioned path, delete unversioned/legacy aliases before customers, generate clients/contracts from
      it. **Exit:** route inventory contains one name per operation and no compatibility branch.
      **Progress:** the untyped generic `tools.invoke` tRPC compatibility mutation and duplicate
      `tools.visible` listing are deleted; tRPC now exposes one generated, schema-derived procedure per
      tool under `tools.byId` plus one catalog query. Seventeen focused projection/tenant-routing checks
      pass. Selecting and enforcing the single versioned HTTP prefix across REST, OAuth, MCP, WebSocket,
      CLI, browser, and operational clients remains.

- [ ] **MIN-03 — Squash greenfield migrations into a reviewed baseline.** `[P1][P]` Evidence: 69
      files include duplicate `0050`/`0052`, backfills, freeze, and legacy migrations despite no declared
      installed customer. **Minimum change:** preserve schema intent in one baseline plus only true
      post-baseline changes; migration runner records checksum. **Exit:** clean install and schema-diff
      match expected state, duplicate/backfill machinery is gone, and no deployed DB is overwritten.

- [x] **MIN-04 — Make dependencies exact, singular, and intentional.** `[P1][P]` Evidence: many
      packages use `latest`, both Zod 4 and `zod3` are installed, devtools are runtime dependencies, and
      licenses include unknown internal/file packages. **Minimum change:** exact lock policy, one Zod,
      dev-only devtools, unused/duplicate dependency CI, allowlisted licenses and notices.
      **Exit:** clean installs are reproducible and dependency graph has no unexplained duplicate/runtime
      package.
      **Implemented:** all manifest versions are exact, React Query/Router devtools are development-only,
      and the first-party graph now imports one direct Zod 3.25.76 dependency; the `zod3` alias and direct
      Zod 4 dependency are removed. Better Auth and the router generator still bring their documented
      transitive Zod 4 runtime/build copies. Knip now rejects unused/unlisted dependencies, a small
      standard-library policy gate rejects inexact or multiply-versioned direct dependencies, `pnpm
dedupe --check` protects the resolved graph, and the production license allowlist generates and
      verifies `THIRD_PARTY_NOTICES.md` (including a sourced MIT override for the metadata-deficient
      `buffers` transitive and explicit first-party editor-package treatment). Five confirmed unused
      dependencies and three redundant root lint packages were deleted, Lucide was unified, and the
      Tiptap family was aligned to eliminate peer/version splits. Clean frozen install, dependency policy,
      dedupe check, 86 representative app schema/tool tests, 48 contract tests, 48 web editor tests, web
      and contracts typechecks pass. Two stale plugin/connector fixtures were aligned to the narrowed
      executable-plugin contract, after which the complete app typecheck and their 15 focused tests pass.

- [x] **MIN-05 — Replace the handwritten S3/SigV4 client with a maintained SDK.** `[P1][P]`
      Evidence: the 690-line adapter lacks robust timeout/retry/cancellation and misses HTTP-200 S3
      completion errors. **Minimum change:** modular official/maintained SDK behind the narrow existing
      storage interface, configured retry/deadline/checksum/SSE. **Exit:** AWS and RustFS/MinIO contract
      suite plus faults pass while net application code shrinks.
      **Implemented:** the narrow adapter now delegates S3 serialization, SigV4, presigning, retries,
      checksum validation, SSE, Object Lock, pagination, and HTTP-200 completion-error parsing to exact
      modular AWS SDK packages while retaining the guarded outbound transport and a hard operation
      deadline. The AWS request/fault suite passes 26 tests, including retry exhaustion, cancellation,
      SHA-256, signed SSE/Object Lock headers, pagination failure, and embedded completion errors; an
      isolated MinIO contract passes signed put/get/head/range/copy, presigned upload, and multipart
      completion. Even with the new audit listing and WORM primitives, application adapter size falls
      from 690 to 686 lines and all handwritten HMAC/canonical-request/XML code is gone.

- [x] **MIN-06 — Collapse plugin persistence and runtime into one lifecycle.** `[P1][P]` Evidence:
      install/enable/disable rows do not control startup-loaded connectors; one bad manifest suppresses
      all discovery and partial registration persists. **Minimum change:** per-artifact verification and
      temporary registry; transactional start/health/commit, disable/unload, upgrade/rollback on every
      replica. **Exit:** malformed A cannot affect B and disable immediately removes hooks cluster-wide.
      **Implemented:** the PostgreSQL lifecycle row is now the sole startup and runtime authority. A
      connector starts in its permission-denied process and validates its complete hook set before the
      state commit swaps the live registry; a failed health check or persistence write closes the staged
      process and leaves the prior version active. Disable/uninstall remove owned hooks and terminate the
      process, while one NATS lifecycle subject makes every replica re-read the canonical row so
      duplicate/out-of-order notifications converge. Discovery verifies each artifact independently,
      skips malformed/signature-invalid/dependency-broken artifacts without suppressing healthy siblings,
      and marks an enabled row degraded if its exact deployed version cannot start. The disconnected
      in-process runtime, partial begin/end registration path, unused plugin migration table/column, and
      unused transitional persisted states are deleted; database checks keep `enabled` and state aligned.
      Fifty-five focused plugin/connector/migration-runner tests pass, including malformed-artifact
      isolation, atomic hook publication/removal, failed-upgrade rollback, failed-commit rollback, and
      two-replica enable/disable fanout; scoped lint, app typecheck, and diff checks pass.

- [x] **MIN-07 — Delete production no-op, optional-required, and in-memory fallbacks.** `[P1][P]`
      Evidence: AV, recorder, OAuth/audit dependencies, idempotency, WebDAV locks, realtime collaboration,
      queue/rate/cost controls can degrade to fake/process-local behavior. **Minimum change:** required
      capability at construction by tier; test fakes only in test composition. **Exit:** production
      graph has no fake/no-op path and readiness reports every required dependency.
      **Progress:** production now rejects missing Redis/NATS before composing process-local idempotency,
      quota/rate/cost limiters or the in-memory event bus; tool idempotency uses Redis with an exact
      remaining TTL when configured. Scanner/recording secure-tier gates and dependency readiness probes
      were already present. WebDAV locking is now tenant/actor-bound and durable in PostgreSQL, and the
      confirmation service can no longer silently construct an in-memory pending-action store—tests must
      inject that fake explicitly while production injects PostgreSQL. Chat route composition now also
      requires an explicit room bus and presence store, and the cross-replica bus requires an explicit
      durable event log; only tests and local development deliberately inject their in-memory versions.
      Production rejects missing Redis or NATS before constructing process-local quota, rate, cost,
      idempotency, event, or presence services, and Better Auth can no longer be disabled in production.
      The unused web-SDK session façade and its hard-coded authenticated local-admin fallback are deleted
      outright instead of preserving a second client-side identity source. The browser's legacy
      localStorage bearer-token path is also deleted; its shell and fetch layer now accept only the
      HttpOnly Better Auth session/CSRF contract, leaving OAuth client credentials to non-browser clients.
      Tier readiness failures are always fatal; the production-capable environment switch that could
      downgrade missing mandatory controls to warnings is gone.
      Drive, Chat, and Meet content paths fail closed when required scanning/encrypted storage is absent,
      while WebDAV locks, pending confirmations, collaboration replay, audit, and OAuth state use their
      PostgreSQL implementations. Thirty-eight focused Chat dependency/fanout tests and the production
      identity-config assertions, all six SDK-web tests, and ten focused browser auth/webhook tests pass;
      scoped lint is clean.

- [ ] **MIN-08 — Split god files only along cohesive capability boundaries.** `[P2][P]` Evidence:
      `server.ts`, Drive/Mail/Docs/Sheets stores and UI shells reach 2,000–11,000 lines.
      **Minimum change:** composition root only wires dependencies; extract pure capability modules while
      deleting repeated guards/projections—no new factory/repository layers without two real consumers.
      **Exit:** security-sensitive functions are locally understandable and total LOC does not increase.

- [x] **MIN-09 — Make contracts authoritative and eliminate unsafe casting.** `[P2][P]` Evidence:
      747 `as unknown as`, 249 `any`, drifted Mail drafts, and realtime payload mismatches are warning
      signals. **Minimum change:** shared schemas/types at I/O boundaries, inferred internal types, typed
      SQL/result mappers, and an expiring cast budget. **Exit:** critical auth/content/event paths contain
      no unchecked double cast and contract tests cover every producer/consumer.
      **Progress:** the composition root, OAuth client/token/code stores, OAuth consent authorization,
      app passwords, OIDC tenant configuration, admin users, crown-jewel approvals, Better Auth actor
      resolution, Chat WebSocket-ticket consumption and durable realtime-event append/replay queries now
      use their native typed request/SQL contracts instead of unchecked double casts. The same conversion
      now covers every Chat room/message/reaction/pin/read-receipt/search/event query and every SCIM query:
      Auth, Chat, Docs, Mail, Meet, Sheets and Slides production double casts are zero; Docs storage/comments/suggestions/
      revisions/search/Yjs and Sheets storage, operations, revisions, metadata rebasing and fanout now
      retain native typed contracts. Mail storage, delivery-event, quarantine and administrative queries
      and Slides storage now use typed SQL results; Slides' validated realtime operation schema produces
      the domain contract directly. Immutable audit append/read/shipping, transactional outbox delivery,
      notification fanout, and inbound/outbound webhook configuration/delivery paths are also at zero
      double casts. Meet's room/lifecycle/invite/recording SQL paths are likewise typed; scoped lint and
      typecheck pass, while its broader route suite still has seven stale signed-webhook fixture failures
      and is not counted below. Assistant conversation/memory, durable search/reindex, and pending-action
      confirmation paths now use typed query/JSON boundaries too, and CardDAV contact storage is typed
      end to end. Tenant context, provisioning, lifecycle and export plus domain/OAuth-app/security-policy/
      billing admin queries are typed as well; 209 focused checks pass across these newly covered areas.
      One broader tenant-export route fixture still returns 400 instead of its stale expected 200 and is
      not counted. Signup invite/verification/onboarding storage is also fully typed and its 86 focused
      checks pass. AI provenance, per-actor memory, and vector retrieval are typed without laundering
      database results, and their 26 focused checks pass. Metering and tenant-storage migration also use
      typed SQL/JSON boundaries, with 20 focused checks passing. A
      zero-tolerance production cast gate now recursively covers the entire platform tree in the required
      quality workflow; every production area is at zero, including Drive, Calendar, and Admin groups.
      The guarded Undici/DOM response boundary, plugin trust/config parsing, connector sandbox,
      backup results, editor composition, storage migration and metering paths now also use narrow native
      contracts; their 151 focused checks pass. The gate plus
      964 focused Auth/Chat/SCIM/Docs/Mail/Sheets/Slides/event/search/assistant/CardDAV/tenancy/admin/signup/AI/storage
      tests and scoped lint pass. All producer/consumer boundaries touched by the migration have executable
      schemas or typed SQL/result contracts, so this item is complete. The separate
      Sheets XLSX fidelity test still exposes its
      existing import failure after export (the other 92 Sheets checks pass), so no fidelity claim is made.
      This remains open until the remaining critical-path casts and producer/consumer contract gaps reach zero.

- [x] **MIN-10 — Delete greenfield legacy paths.** `[P1][P]` **Minimum change:** remove OAuth scrypt
      rehash and PKCE plain, legacy Drive viewer/inline-body/default storage/finalize alias, deprecated
      capacity/mail config helpers, Chat online alias, CardDAV generic scope, legacy Docs WS protocol, and
      unsafe missing-revision fallback after confirming no deployed consumer. **Exit:** repository search
      and route/schema inventory show one current path for each concern.
      **Progress:** OAuth now accepts only Argon2id client-secret hashes and S256 PKCE; the scrypt
      verifier/rehash store path, `plain` challenge type/branch, and redundant challenge-method database
      column are deleted. Chat now accepts only the canonical `available|away|busy|dnd|invisible`
      presence vocabulary across Redis and web contracts; offline is represented solely by bounded
      roster absence after lease expiry. The broad `carddav` app-password grant is deleted
      in favor of explicit `carddav.read`/`carddav.write`. Drive now rejects non-contract roles instead
      of normalizing `viewer`, has no inline-body runtime/export, requires explicit tenant storage config
      without falling through an authoritative resolver to unscoped default storage, and derives finalize
      keys only from prepared database state; the caller `storageKey`, finalize-key assertion, and deprecated
      assertion alias are deleted. `drive.finalize` remains the canonical operation because the web upload,
      app test, and admin service inventories actively consume it; provisioned `helix-default` storage and
      its migration resolver remain canonical, tenant-scoped functionality. Docs sync now has one binary
      Yjs protocol, one room map and one shutdown path; invalid stored state fails closed instead of being
      interpreted as plaintext. Slide updates/deletes require a per-slide revision at the schema, store and
      web-client boundaries, eliminating the last-write-wins omission. Deprecated Chat capacity aliases,
      mail server/scanner config helpers and their test-only branches are deleted. The focused OAuth/store/
      route suite plus 40 Chat/CardDAV/permission/web tests, 138 Drive/storage/web tests, 9 Docs route tests,
      29 Slides store/route tests, 8 web sync tests and targeted editor tests pass. Targeted typecheck
      output contains no touched-path error, the smaller changed modules pass scoped lint, and repository
      inventory finds no listed compatibility entry point.

- [x] **MIN-11 — Remove or complete every inert UI control.** `[P1][P]` Evidence: Mail AI/schedule/
      smart reply, Meet controls, Calendar navigation/attendee/join, placeholders, and many swallowed
      `onError` handlers are no-ops. **Minimum change:** wire a real contract and actionable error/
      rollback, or remove/disable with a precise reason. **Exit:** automated interaction inventory proves
      every visible control changes observable state or communicates why it cannot.
      **Implemented:** the shell side rail no longer ships local-only Tasks/Notes mini-products or an inert
      add-app control; calendar actions open the real calendar, AI actions open the real assistant, and
      Contacts now queries the authenticated People directory with search/loading/error/empty states.
      Mail's fake AI summary/schedule/smart-reply and inert compose controls are removed while real
      attachments, send, undo-send, and mail operations remain; undo failure is actionable. Meet's inert
      options/summary controls are removed. Calendar renders real location/conference/attendee links and
      RSVP state instead of a hard-coded mini calendar. Assistant copy is real and its unused model/
      attachment controls are gone. Admin's fake overview, unsupported user/billing actions, and product
      list filters/template seeds are deleted. A repository-wide production TSX inventory now rejects
      native buttons without an action, submit behavior, or an explicit disabled state and rejects
      placeholder feature claims. The inventory plus 103 focused product tests pass; ten pre-existing
      editor-list assertions still model the removed inline-upload path and are tracked outside this UI
      exit. Web typecheck and scoped lint pass.

- [x] **MIN-12 — Set and enforce web performance budgets.** `[P2][P]` Evidence: password-strength is
      819 kB raw and PDF/DOCX/XLSX/editor chunks are large. **Minimum change:** route/interaction lazy
      loading, worker isolation, cheaper password estimator if adequate, prefetch discipline, render/
      query profiling, and bundle regression CI. **Exit:** agreed cold-start and interaction budgets pass
      on representative low-end hardware/network.
      **Implemented:** the browser-only 819 kB password corpus and its type package are deleted; a 35-line
      contextual/entropy UX precheck replaces it while the authoritative server retains Zxcvbn plus
      fail-closed breached-password screening. Vite now has no oversized exception: its build gate caps
      the complete initial JavaScript graph at 450 kB and every JavaScript chunk at 500 kB. Route/editor,
      PDF, DOCX, XLSX and PDF-worker code remains interaction-lazy; the production build passes at 398.2
      kB initial across three chunks. A dedicated production-build Playwright gate uses Chromium CDP to
      emulate 4x CPU slowdown, 150 ms RTT, 1.6 Mbps down/750 Kbps up and fails cold login above eight
      seconds or a sign-in response above two seconds; it passes locally in 2.8 seconds total and runs in
      the mocked E2E CI job. Fourteen signup tests, web/E2E typechecks, the production build, and the
      throttled browser gate pass.

- [ ] **MIN-13 — Make offline and mobile behavior explicit per product.** `[P2][G]` **Minimum change:**
      PWA install/session policy, encrypted local cache, outbox/conflict model, background sync, offline
      read/edit scope, push notifications, responsive/touch UI, storage limits, and remote wipe semantics.
      **Exit:** airplane/reconnect/multi-device/conflict scenarios neither lose nor expose data.

- [ ] **MIN-14 — Meet accessibility, localization, and usability as release gates.** `[P2][G]`
      **Minimum change:** WCAG 2.2 AA keyboard/screen-reader/focus/contrast/reduced-motion, captions,
      locale/timezone/RTL/plural formats, error recovery, empty/loading states, and user testing for core
      workflows. **Exit:** automated and manual assistive-technology matrices pass with no critical
      issue; all routes retain `#main-content`.

- [ ] **MIN-15 — Prove native editor integrity and product boundaries.** `[P2][G]` **Minimum change:**
      keep editor source in `helix-editors`; test Drive ACL/lifecycle, concurrent collaboration across
      replicas, revision durability, import/export fidelity, offline conflict, large docs, malicious
      files, search/retention/hold, accessibility, and format compatibility for Docs/Sheets/Slides.
      **Exit:** published fidelity corpus and multi-user failure tests pass without copying editor code.

- [ ] **MIN-16 — Ship migration and coexistence, not just empty-tenant signup.** `[P2][G]` **Minimum
      change:** resumable/idempotent connectors for Google/Microsoft mail, calendars, contacts, Drive/
      shared drives, groups, users, and permissions; delta sync, mapping, dedupe, rate/backoff, reports,
      dry run, rollback, and coexistence routing. **Exit:** seeded source tenant migrates, reruns without
      duplicates, preserves sampled ACL/time/MIME fidelity, and exposes every exception.

- [x] **MIN-17 — Constrain AI and automation to existing authority.** `[P1][P]` Evidence: agents can
      consume workspace content, plugin/webhook paths are powerful, and classification/confirmation
      defaults are caller-influenced. **Minimum change:** treat retrieved content as untrusted data;
      server-derived sensitivity, exact credential/resource scope, write confirmation/automation grants,
      recipient/exfiltration policy, prompt-injection defenses, citations, audit, budgets, kill switch,
      and evaluation corpus. **Exit:** malicious mail/chat/file prompts cannot grant authority, suppress
      confirmation, leak cross-tenant data, or call unapproved egress.
      **Implemented:** assistant retrieval remains actor- and tenant-scoped, and tool visibility plus the
      canonical registry re-authorize every model-selected invocation including composite external-
      recipient scopes. Caller-selected classifications were deleted from REST/tool types and CLI flags;
      routing now derives the strictest classification from authorized search/memory metadata and carries
      it through approval resumes. Retrieved search and memory content is emitted as explicitly untrusted
      tool data rather than system instructions, while destructive/external actions remain confirmation-
      gated and approvals stay actor/digest-bound. Exact-host DNS-pinned outbound clients constrain custom
      AI endpoints, provider errors cannot expose response bodies, provenance/cost budgets remain enforced,
      and `ai.enabled=false` now suppresses environment providers as a real kill switch. The adversarial
      assistant corpus proves injected retrieval instructions never enter the system prompt, restricted
      data selects restricted routing, hidden/unauthorized tools cannot execute, and external sharing waits
      for durable approval; 20 focused assistant tests, 174 CLI tests, and the full server suite pass.

- [ ] **MIN-18 — Make integrations capability-scoped and product claims executable.** `[P3][G]`
      **Minimum change:** signed marketplace, OAuth install/consent, isolated secrets/egress, webhook
      signature/replay/idempotency, per-connector health/revocation/export, stable APIs/SDKs, honest
      support matrix, changelog/deprecation policy for future customers, and release evidence links.
      **Exit:** every advertised integration/feature has a named owner, threat model, observable health,
      end-to-end test, support boundary, and uninstall/data-deletion path.

## 16. Delivery sequence and release gates

Implementation must follow dependencies, not UI attractiveness. Check an item only after its stated
exit condition is captured in tests or release evidence.

### Phase 0 — Contain the current attack surface

Complete all P0 items. Until then, bind to trusted development networks only. The critical path is:

1. canonical authentication and secure ingress (`SEC-01` through `SEC-07`, `SEC-22`, `SEC-23`);
2. real tenant enforcement (`IAM-03` through `IAM-07`, `IAM-18`);
3. credential/admin ceilings (`SEC-05`, `SEC-06`);
4. resource stop-ship fixes in Mail, Drive, Chat, Meet, and Calendar;
5. safe content/plugin boundaries and restore extraction;
6. real readiness and dependency remediation.

**Gate P0:** two-tenant adversarial suite passes through REST, tools, tRPC, WebSocket, SMTP,
CalDAV/CardDAV/WebDAV, search, public links, jobs, and direct SQL. No critical/high exploitable
production dependency remains. No committed credential remains usable.

### Phase 1 — Secure private pilot

Implement P1 work as the smallest vertical slices: identity/membership/RBAC/domain first, then
Mail/Drive, Chat/Meet/Calendar, governance, and operations. Use managed/mature SMTP edge, S3 SDK,
standards parsers, and media components instead of expanding bespoke protocol code.

**Gate P1:** all P1 exits pass in the real-service CI topology; backup from a prior run restores DB
and objects; SLO smoke/soak is within target; every visible Admin policy is enforced; threat models
for auth, tenant isolation, uploads/previews, mail, media, plugins, and backup are reviewed.

### Phase 2 — Credible enterprise GA

Complete P2 work, run migration pilots, add shared drives/governance/delegated admin, publish support
and interoperability matrices, conduct external penetration testing, and execute regional/DR and
incident exercises.

**Gate P2:** every marketed capability maps to tests, SLOs, operational owner, security control,
retention/export behavior, accessibility evidence, and a documented limitation. Customer data can be
migrated in, operated, exported, held, and deleted verifiably.

### Phase 3 — Elite differentiation

Complete chosen P3 items based on customer demand. P3 is not permission to retain placeholders:
unselected capabilities remain absent from UI/catalog/docs.

## 17. Required test matrices

### 17.1 Identity and authorization

For every action, generate positive and negative cases across:

- tenant A and tenant B; unknown/suspended/deleting tenant;
- global identity with one/two memberships, user, guest, service account, agent, system job;
- owner, super admin, delegated admin, custom role, group/OU binding, resource role, no role;
- active/suspended/expired membership and credential; before/after group/role/ACL revocation;
- password/passkey/TOTP/SSO/SCIM/OAuth/app password/API key/mTLS where retained;
- normal/recent-MFA/stale-MFA/device-trusted/untrusted and allowed/blocked network context;
- HTTP, tools, WebSocket, SMTP, WebDAV, CalDAV, CardDAV, worker, search/RAG, and public-link paths.

Every deny test must also assert no row, object, queue event, index document, audit gap, timing
oracle, or realtime delivery was produced.

### 17.2 Content lifecycle

Run create → ingest → scan → ready → share → edit/version → search → export → trash → retain/hold →
restore/purge across Mail, Drive, Chat, Calendar, Contacts, recordings, comments, and editor files.
Inject a crash or dependency failure before and after every external side effect and verify the
state machine converges idempotently.

### 17.3 Interoperability

Use maintained public corpora/conformance suites for SMTP/MIME/DKIM/DMARC/ARC, JMAP/selected mail
clients, WebDAV, CalDAV/ICS, CardDAV/vCard, S3 providers, browsers/WebRTC/TURN, Office/PDF import and
preview, SCIM, SAML, OIDC/OAuth, and migration sources. Unsupported inputs must fail explicitly,
boundedly, and without corrupting stored source.

### 17.4 Operational failure

Exercise pod/process/worker kill, duplicate/out-of-order events, database failover, queue loss,
Redis/search/storage/AV/provider/Vault/KMS/IdP outage, network partition/latency, clock skew, disk full,
quota exhaustion, cert/key rotation, node/zone loss, backup corruption, restore interruption, and
regional isolation. Assert data integrity first, then documented RTO/SLO.

## 18. Implementation bookkeeping

For each checkbox:

1. create or reference a focused issue/PR and note any superseded implementation;
2. add the smallest test that proves the exit condition, prioritizing negative security behavior;
3. update the checkbox only after code, migration/config, tests, and docs land together;
4. record verification commands/evidence immediately beneath the task if non-obvious;
5. delete replaced code, schemas, routes, flags, tests, and documentation in the same change;
6. if scope is deferred, remove the product surface—do not reinterpret “deferred” as “stub shipped.”

Progress summaries should report completed IDs, remaining P0/P1 count, real-test status, dependency
audit status, and LOC/dependency delta. Raw test count alone is not a release metric.

## 19. Ponytail whole-repository minimality audit

This subsection is intentionally limited to over-engineering/deletion findings. It does not replace
the correctness and capability backlog above.

1. <delete> Remove the public header-identity/MFA/fingerprint fallbacks; one verified authenticator replaces three bypass-prone paths. [`apps/helix/src/api/actor.ts`, `platform/auth/mfa.ts`]
2. <delete> Remove 19 empty `export default {}` plugin entrypoints plus their manifests/catalog claims and scaffold-special-case. [`plugins/**/index.js`, `connectors/runtime.ts`]
3. <delete> Collapse `admin_domains` and `mail_sending_domains` into one canonical domain aggregate. [`db/migrations/0024_admin_console.sql`, `platform/db/schema.ts`]
4. <delete> Remove advisory security controls until they have an enforcement consumer; false controls cost more than absent controls. [`platform/admin/security-policies.ts`]
5. <delete> Squash the greenfield migration chain and remove duplicate `0052`, backfills, freezes, and compatibility migrations after confirming no deployed database. [`apps/helix/src/db/migrations`]
6. <delete> Remove `/v1` rewrite/unprefixed aliases and retain one versioned API. [`apps/helix/src/server.ts:943-946`]
7. <delete> Remove OAuth scrypt compatibility and PKCE `plain`; require the one greenfield password/code-challenge format. [`platform/auth/oauth.ts`, `platform/auth/authorization-code.ts`]
8. <delete> Remove Drive `viewer`, inline-body fallback, `legacy-default` storage, deprecated finalize-key alias, and capacity aliases. [`platform/drive`, `platform/storage/tenant-resolver.ts`, `config/env.ts`]
9. <delete> Remove deprecated mail config wrappers, Chat presence aliases, legacy CardDAV scope, and legacy Docs WS/missing-revision branches. [`apps/helix/src/server.ts:3880-3920`, `platform/chat`, `platform/calendar`, `platform/docs`]
10. <delete> Remove the unused SOPS implementation and choose one secret-provider boundary. [`platform/secrets/sops.ts`]
11. <delete> Remove unsupported credential types or finish issuance/rotation/revocation end to end; partially modeled API-key/mTLS types are attack surface. [`platform/auth/credentials.ts`, `platform/auth/tools.ts`]
12. <delete> Remove production in-memory/no-op fallbacks for AV, recorder, OAuth/audit stores, idempotency, locks, realtime, queue, and rate control. [production composition roots]
13. <delete> Migrate `zod3` imports and remove the alias; move Query/Router devtools out of production dependencies. [`apps/helix/package.json`, `apps/web/package.json`]
14. <native> Replace the handwritten SigV4/S3 implementation with the maintained modular SDK behind the existing narrow interface. [`platform/storage/s3-compatible.ts`]
15. <stdlib> Normalize domains with Node's `domainToASCII` before a small explicit validation policy. [`platform/admin/domains.ts`, `platform/mail/admin-routes.ts`]
16. <native> Replace custom XML/ICS/vCard/MIME edge parsing with focused maintained standards libraries rather than expanding regex code. [`platform/calendar`, `platform/mail/ingest.ts`]
17. <shrink> Collapse fake plugin persistence and disconnected runtime into one lifecycle; delete duplicated status/registration machinery. [`platform/plugins/tools.ts`, `loader.ts`, `connectors/runtime.ts`]
18. <shrink> Make production-required store operations non-optional and remove repeated “requires method” runtime branches. [`platform/drive/tools.ts` and production stores]
19. <shrink> Split `server.ts` and oversized stores/shells at real capability boundaries while deleting repeated guards/projections; do not add factories or repositories merely for file size. [`apps/helix/src/server.ts`, oversized stores/shells]
20. <yagni> Remove every inert AI, Meet, Calendar, Contacts, plugin, policy, and recovery control until its vertical slice actually works. [web/admin/plugin surfaces]
21. <shrink> Replace the 4,461-line live-auth shell harness with focused reusable real-service fixtures only after a coverage map proves equivalence. [`infra/scripts/live-auth-smoke.sh`]
22. <delete> Remove stale comments and TODO-specific branches whose described follow-up is already implemented. [`platform/drive/multipart.ts` and repository TODO audit]

Net: approximately 2,800–5,000 lines deleted, 3 direct runtime dependencies removed, 19 fake modules removed, and 6 duplicated/legacy abstractions collapsed; more is possible if the product has no deployed migration compatibility obligation.

## 20. Explicit non-claims until the corresponding gates pass

Do not claim any of the following based on UI or configuration scaffolding alone:

- production-ready, multi-tenant-safe, zero-trust, or compliance-ready;
- enforced MFA, SSO, SCIM, DLP, device trust, data residency, legal hold, or WORM audit;
- secure/public file sharing, malware-safe uploads, customer-controlled encryption, or shared drives;
- private mailboxes, Internet-grade mail deliverability, complete retention, or client interoperability;
- secure moderated meetings, reliable recording, HA media, or external guest support;
- durable realtime Chat, complete message history, moderation, or federated spaces;
- verified backup/restore, PITR, RPO/RTO, HA, regional failover, or tenant deletion;
- safe/official plugins or safe autonomous AI merely because a manifest or confirmation field exists.

The product can become genuinely competitive, but only by making its smaller set of claims
unambiguous and mechanically true before expanding them.
