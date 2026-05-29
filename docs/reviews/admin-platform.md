# Admin + Platform Infrastructure — Senior Review

## Summary

The Admin console and cross-cutting platform layer ship a great deal of structured surface area (six security-policy types, IdP CRUD, OAuth-app moderation, audit hash chain, BYO Postgres / S3 / Vault, plugin loader with tier policy, signed outbound webhooks) but the underlying security primitives have systemic gaps. SCIM and SAML are public, unauthenticated 501 stubs; OAuth has no per-client redirect-URI allowlist and accepts `plain` PKCE; admin-action audit failures are silently swallowed; the primary `activity` audit table is mutable Postgres; plugins load in-process with full Node privileges (no sandbox); API keys are stored as bare SHA-256; admin MFA is enforced via a self-asserted header. The console's Overview is a stub, billing is mostly read-only, and `admin-console.tsx` is 2,339 lines of prop-drilled `<div style={…}>`. The hash-chain, argon2id upgrade-on-verify, scope-catalog reuse, immutable-S3 shipping, and tenant-actor mismatch enforcement are all solid — the foundations are right, but several controls advertised by the security tier engine are not actually enforced end-to-end.

## Scorecard

- Security: 2/5 — Real argon2id, hash chain, tenant-actor enforcement, and an immutable-S3 destination, but SCIM/SAML are public stubs, OAuth has no redirect-URI allowlist, app passwords expose a per-username password-oracle scan, primary audit is mutable, plugins run unsandboxed, admin MFA is header-based, and admin audit writes are best-effort/silent.
- Correctness: 3/5 — Hash chain and per-org `for update` serialization are right; pagination cursors are consistent; the `actor.org_id` mismatch check is real. Several admin routes accept `admin.users` as a stand-in for `admin.console.read`, audit verb taxonomy is ad-hoc, and SCIM-served tenants bypass tenant context entirely.
- Feature completeness: 2/5 — No 2FA enrollment, no SAML ACS, no SCIM CRUD, no IP allowlist enforcement in any auth path, no admin-driven session listing/revocation, no nested groups, no admin tools for tenant org-unit hierarchies, billing is read-only "mailto sales", overview is stubbed.
- Code quality: 2/5 — `admin-console.tsx` is one 2.3k-line file, every panel uses inline styles, every mutation drops `onError: () => undefined`, OAuth-apps moderation has no confirmation UX, three different "is admin?" checks coexist (`canReadAdminConsole`, `canAdminPlugins`, `canReadAuditLog`), and `withPageScroll(Component)` calls a component as a function, breaking hook rules.

## Findings

### P1: SCIM endpoints are public, return 501, and skip tenant context · critical · security
**File**: `apps/helix/src/platform/auth/scim-routes.ts:22-90`, `apps/helix/src/platform/tenancy/middleware.ts:64`
**What's wrong**: `/api/scim/v2/:tenantSlug/*` has no authentication of any kind — anyone can list `ServiceProviderConfig`, `ResourceTypes`, and `Schemas` for any active tenant, including a description that brags the rotation UI is "pending". `Users`/`Groups` are wired to **all** methods (GET/POST/PUT/PATCH/DELETE) and return 501, but the route's existence already discloses tenant existence (404 vs 501 is a tenant-enumeration oracle). The tenancy middleware also skips `/api/scim/v2/*` entirely (`shouldResolveTenantForRequest`), so even when CRUD is added, the tenant-scope safety net isn't in the path.
**Fix**: Require a per-tenant SCIM bearer token (BetterAuth-issued, salted-hash stored in `scim_tokens` and rotated via the admin UI) before the route handler runs. Return identical 401 for unknown-tenant + missing-token + bad-token to remove the enumeration oracle. Either implement the CRUD or remove the 501 PUT/PATCH/DELETE routes entirely until they exist.
**Effort**: M

### P1: OAuth `/oauth/authorize` accepts any `redirect_uri` and `plain` PKCE · critical · security
**File**: `apps/helix/src/platform/auth/routes.ts:347-382`, `apps/helix/src/platform/auth/oauth.ts:42-57`
**What's wrong**: `validateAuthorizeParams` only requires `redirect_uri` to be `isAbsoluteHttpUri` — there is no per-client allowlist of registered redirect URIs (the `OAuthClientRecord` and the `agent_credentials` table don't carry one). An attacker who knows a `client_id` (one is rendered in the consent HTML and on any error page) can craft `redirect_uri=https://attacker/...` and harvest authorization codes — exactly the attack PKCE *and* redirect-URI allowlists exist to prevent. The validator also accepts `code_challenge_method=plain`, which OAuth 2.1 forbids; only S256 should be allowed.
**Fix**: Add `allowed_redirect_uris text[] not null` to `agent_credentials` (or a sidecar table) and require an exact-match (no path/query wildcards) check both at `/oauth/authorize` and again in `authorization-code` redemption. Reject `code_challenge_method=plain` outright. Mask the `client_id` in error redirects.
**Effort**: M

### P1: Admin-console audit writes are best-effort and silently swallowed · high · security/correctness
**File**: `apps/helix/src/platform/admin/console-shared.ts:198-217`
**What's wrong**: `auditAdminAction` wraps every audit append in a `try { … } catch {}` and the comment explicitly says "audit failures must not roll back an admin mutation". For ordinary CRUD this might be acceptable, but the admin console covers IdP creation, security-policy toggles, OAuth-app revocation, tenant-config rewrites, BYO storage migration, and billing-adjacent actions — the cases regulators care about. A misconfigured DB or sink will silently drop the audit trail while the destructive change succeeds; the operator has no signal at all.
**Fix**: For admin write routes, perform the audit append in the *same* transaction as the mutation (the `PostgresAuditStore.append` uses `sql.begin` already — surface the connection). Failing that, log the audit append failure at `error` with `verb`, `actorId`, `objectId`, increment a `helix_admin_audit_drop_total{verb}` counter, and refuse the mutation when the tier requires `audit_immutable` (Enterprise+).
**Effort**: M

### P1: Primary `activity` audit table is mutable Postgres · high · security
**File**: `apps/helix/src/platform/audit/store.ts:33-85`, `apps/helix/src/platform/audit/immutable-postgres.ts:1-40`
**What's wrong**: `PostgresAuditStore.append` writes to `activity`, the source of truth for the hash chain and what the admin UI reads. The "WORM" guarantees only exist on the opt-in shipping destinations (`audit-immutable-postgres`, `immutable-s3`). A DBA, a SQL-injection, or a buggy migration can mutate `activity` rows directly and the hash chain only catches it if someone runs the verifier. The admin console doesn't expose verifier results.
**Fix**: Add a BEFORE UPDATE/DELETE/TRUNCATE trigger on `activity` mirroring `audit_immutable_postgres`. Surface the verifier output (`platform/audit/verifier.ts`) in the Admin overview and alert on `failures.length > 0`. Document that the trigger can be removed only by a tenant-scoped break-glass migration that is itself audited.
**Effort**: S

### P1: Plugins load in-process with full Node privileges · high · security
**File**: `apps/helix/src/platform/plugins/loader.ts:234-265`
**What's wrong**: `loadInProcessPlugin` does a raw `await import(entryUrl)` — the plugin gets the host process's `fs`, `child_process`, `net`, and DB pool. The `permissions` declared in `plugin.json` (`filesystem`, `outbound-network`, `envVars`) are passed to manifest validation but are not enforced at runtime. `pluginTierPolicyFromSecurityDefaults` checks signature/airgap requirements at *load* time, but a signed plugin is just as un-sandboxed as an unsigned one. A malicious or compromised marketplace plugin can read every tenant's secrets in one process tick.
**Fix**: Run plugins out-of-process by default (worker thread, `vm.SourceTextModule` with a curated import map, or Node permission model `--permission --allow-fs-read=…`). Treat in-process loading as a Tier-1 (`personal`) only path; for `business`+ require a worker-thread host that mediates `fs`/`net`/`process.env` calls against the declared permissions and blocks the rest. Audit every cross-tenant DB read a plugin attempts.
**Effort**: L

### P1: API keys stored as bare SHA-256 (no salt, no work factor) · high · security
**File**: `apps/helix/src/platform/auth/credentials.ts:95-97`
**What's wrong**: `apiKeyHash` is a single round of SHA-256 hex. SHA-256 is FIPS-approved but it is *fast* — a DB dump turns into trivial brute-force against any short or guessable key. Argon2id is already imported in `oauth.ts`; the comment "FIPS-approved" conflates "the algorithm is permitted" with "this use of the algorithm is safe".
**Fix**: Generate keys with ≥128 bits of entropy (already done) AND store argon2id over the key. Keep a SHA-256 lookup index column only if you need O(1) lookup; the verify step must use argon2id like `app_passwords`. Migrate existing rows on next use, identical to the scrypt → argon2id upgrade-on-verify pattern in `verifySecretWithRehash`.
**Effort**: M

### P1: `PostgresAppPasswordStore.authenticateAppPassword` is a password oracle scan · high · security
**File**: `apps/helix/src/platform/auth/app-passwords.ts:281-322`
**What's wrong**: The query fetches **every** non-revoked app-password row whose `actors.email = $username` (or whose `actors.id::text = $username`) and then iterates calling `verifySecret(input.password, row.hash)` in sequence. With argon2id costing ~50ms per verify, an actor with N labeled passwords burns N×50ms of CPU per failed attempt — a measurable side-channel that reveals how many app-passwords a user has, and an amplification factor for online password guessing. The `lower(a.email) = lower(...)` and the `or a.id::text = $username` path also let unauthenticated callers enumerate which actor IDs exist via timing.
**Fix**: After fetching candidate rows, run all argon2 verifies in parallel with `Promise.all`, OR (better) require the username to also identify the password label (e.g. `user@host/label`) so at most one row is verified. Add a fixed-time outer wrapper (~50ms regardless of row count) and a per-username throttle (count failures in `app_password_login_attempts`).
**Effort**: M

### P1: Admin MFA gate trusts `x-helix-mfa-verified` header from the request · high · security
**File**: `apps/helix/src/platform/auth/mfa.ts:54-60`
**What's wrong**: `headerMfaVerificationResolver` reads the client-supplied request header. The comment claims "a client cannot self-assert it past the trusted auth boundary" — that's only true if a reverse proxy strips it; the Fastify app itself doesn't. Nothing in `installTenantContextHook` or the auth resolver chain removes the header from the request before it reaches the resolver. Any admin user holding only a password can `curl -H 'x-helix-mfa-verified: true'` and pass the Enterprise-tier admin-MFA enforcement.
**Fix**: Sign or HMAC the MFA assertion at the auth boundary, OR drop the header in a global `onRequest` hook and resolve MFA strictly from the BetterAuth session (when its `twoFactor` plugin is enabled). Until BetterAuth twoFactor is enabled, the admin-MFA control is *not enforced* — block the Enterprise tier from claiming it.
**Effort**: M

### P1: `admin.users` scope is treated as full admin-console read · high · security
**File**: `apps/helix/src/platform/admin/console-shared.ts:28-36`
**What's wrong**: `canReadAdminConsole` accepts `admin.users` as a substitute for `admin.console.read`. The legacy `admin.users` scope was minted as "manage user accounts" — granting it now also discloses security policies, OAuth apps, billing, tenant config, DNS, mail config, and audit log shape. This is an unannounced privilege expansion that any token previously issued with `admin.users` silently inherits.
**Fix**: Make `admin.users` strictly user-management. Mint a migration that grants tenants currently using `admin.users` an explicit `admin.console.read` so admins aren't locked out, then remove the implication.
**Effort**: S

### P1: SAML "support" ships metadata only — no ACS, no signature verification · high · feature
**File**: `apps/helix/src/platform/auth/saml-routes.ts:21-72`
**What's wrong**: The only SAML route is `GET /api/auth/saml/:tenantSlug/metadata`. There is no `POST /…/acs`, no SAMLResponse signature verification, no NotBefore/NotOnOrAfter clock check, no audience restriction enforcement. `tenant-idp-configs.ts` lets the admin store SAML config and the UI exposes "Test login" buttons that always return `runtime_pending`. Tenants who pass SAML configuration through the Admin console get nothing.
**Fix**: Implement ACS or remove the SAML option from `IdentityManagement` and `security-policies.sso.provider`. If keeping SAML metadata available, hide it behind a feature flag and document explicitly that production SAML is not implemented.
**Effort**: L

### P1: OAuth-app moderation has no confirmation gate · high · security/UX
**File**: `apps/web/src/features/admin/admin-console.tsx:1499-1537`
**What's wrong**: "Block" and "Revoke" are bare `<button>`s that call the mutation directly. An accidental misclick revokes a third-party integration org-wide. `IdentityManagement` and `agent-credentials-management.tsx` use `AlertDialog` for destructive actions; this surface is inconsistent.
**Fix**: Wrap Block/Revoke in `AlertDialog` requiring confirmation, surface the count of affected users (`app.users`) in the dialog, and surface a "Reason" textbox that is audited alongside the action.
**Effort**: S

### P1: Webhook signature accepts a single `v1` SHA-256 HMAC — no algorithm negotiation, no per-secret rotation grace · medium · security
**File**: `apps/helix/src/platform/webhooks/signatures.ts:3-78`
**What's wrong**: `WEBHOOK_SIGNATURE_VERSION = "v1"` is the only accepted version. There is no rotation window where two HMACs are both valid, so rotating a secret means dropped webhooks across the cut-over. The tolerance defaults to 300 s, which is fine, but `toleranceSeconds < 0` disables replay protection silently — should require an explicit boolean to allow that.
**Fix**: Accept `t=…,v1=…,v1=…` (multiple signatures) and parse them as a set; allow two active secrets per webhook (current + previous) for a 24-hour rotation grace. Reject negative `toleranceSeconds` outright.
**Effort**: M

### P1: Billing has fake CTA buttons and no real plan-change flow · high · feature/UX
**File**: `apps/web/src/features/admin/admin-console.tsx:1586-1727`
**What's wrong**: "Update payment method" and "Download invoices" are inert buttons. "Upgrade plan" opens a `mailto:sales@helix.example` — a placeholder email, not a real address — meaning the entire upgrade flow is a dead end. Per-invoice "PDF" buttons (`:1868`) do nothing.
**Fix**: Either wire to the real billing surface (`billing-api.ts` already exists) or hide these CTAs under a `feature.billing_self_serve` flag and replace them with a "Contact Helix support" banner with a real address.
**Effort**: M

### P1: Admin Overview is "Telemetry not yet wired" · medium · feature
**File**: `apps/web/src/features/admin/admin-console.tsx:253-285`
**What's wrong**: The default landing tab for the entire Admin console is a literal placeholder card. New admins land on this every time. There is no signed-in sessions list, no recent admin events, no posture summary — none of which require new endpoints; `audit-log` and `security-tier-readiness.tsx` already exist.
**Fix**: Reuse `security-tier-readiness.tsx` and the audit-log "last 10 admin verbs" as the overview body. This is a 1-day change.
**Effort**: S

### P2: No admin-driven session listing or revocation · medium · feature/security
**File**: `apps/helix/src/platform/auth/better-auth.ts:314-375`, `apps/web/src/features/admin/admin-console.tsx` (no surface)
**What's wrong**: BetterAuth sessions live in `session` with `expiresAt`, `ipAddress`, `userAgent`. Nothing in the admin UI lets an admin see "alice has 14 active sessions across 3 IPs", and nothing lets them force-revoke them. Combined with the missing real MFA, this means after a credential leak an admin has no remediation path other than disabling the user.
**Fix**: Add `GET /api/admin/users/:id/sessions` and `DELETE /api/admin/users/:id/sessions(/:sessionId)` that delete from `session` and emit `admin.session.revoked`. Surface the list in `IdentityManagement` or a new "Sessions" section.
**Effort**: M

### P2: No 2FA enrollment flow anywhere · high · feature
**File**: `apps/helix/src/platform/auth/mfa.ts`, `apps/helix/src/platform/auth/better-auth.ts:419-445`
**What's wrong**: `mfa.ts` only *checks* a header. BetterAuth `twoFactor` plugin is not enabled in `createBetterAuthRuntime`. There is no enrollment endpoint, no TOTP QR, no WebAuthn registration. The `security_policies.mfa.allowedMethods` array literally contains `hardware_key`/`totp`/`sms` but none of those have an implementation behind them.
**Fix**: Enable BetterAuth `twoFactor`, expose `/api/account/mfa/enroll`, `/api/account/mfa/verify`, `/api/account/mfa/recovery-codes`. Wire `evaluateAdminMfa` to the BetterAuth session AAL instead of the header. Until then, downgrade `allowedMethods.sms` to "not supported" in the schema so admins aren't promised something that doesn't exist.
**Effort**: L

### P2: IP allowlist on agent credentials is declared but not enforced · high · security
**File**: `apps/helix/src/platform/auth/credentials.ts:45-50`
**What's wrong**: `AgentCredentialPolicy.ipAllowlist` and `allowedHours` are persisted, but I see no enforcement in the token-issuance or token-introspection paths and no middleware that consults them on tool invocation. (Searched for `ipAllowlist` in the codebase — the field is defined but never read.) Policies entered through the admin UI silently do nothing.
**Fix**: Enforce the policy in the bearer-token resolver: on each request that authenticates via an agent credential, look up the credential's policy and reject when the client IP / hour falls outside the window. Audit the rejection with verb `auth.credential.policy.denied`.
**Effort**: M

### P2: SCIM, signup, and SAML metadata routes bypass tenant context entirely · medium · correctness
**File**: `apps/helix/src/platform/tenancy/middleware.ts:50-75`
**What's wrong**: `shouldResolveTenantForRequest` excludes `/api/scim/v2/*`, `/api/auth/saml/*/metadata`, and signup routes from tenant resolution. SCIM in particular operates *per tenant* (path param `:tenantSlug`) yet runs without a tenant context — once the CRUD lands, every store call inside SCIM must remember to scope manually, which is exactly the class of bug the middleware was added to prevent.
**Fix**: Add a dedicated `resolveScimTenantContext` that maps `params.tenantSlug` → orgId and installs it; require it on every `/api/scim/v2/*` handler. Same pattern for SAML's eventual ACS handler.
**Effort**: S

### P2: `admin-console.tsx` is 2,339 lines of inline-styled prop drilling · high · code quality
**File**: `apps/web/src/features/admin/admin-console.tsx`
**What's wrong**: Every section (`AdminOverview`, `AdminUsers`, `AdminGroups`, `AdminSecurity`, `AdminApps`, `AdminBilling`, `AdminDomain`, …) lives in one file. Inline `style={{…}}` is used everywhere — no design tokens reused. The `withPageScroll(Component)` adapter at `:2298-2302` calls `Component()` as a function (`<PageScroll>{Component()}</PageScroll>`) which violates React's rules of hooks for any component that calls hooks inside (which most of them do — `IdentityManagement`, `TenantConfigManagement`, etc.). It works today by accident; React 19 strict mode or `<Suspense>` boundaries will break it.
**Fix**: Split each section into its own file (mirrors the per-section `*-api.ts` pattern already established). Replace `withPageScroll(Component)` with `<PageScroll><Component /></PageScroll>` to render as a child, not call. Move inline styles to per-component module styles or shared classNames.
**Effort**: L

### P2: Every mutation drops errors with `onError: () => undefined` and shows them in a banner only on the next render · medium · code quality
**File**: `apps/web/src/features/admin/admin-console.tsx` (groups, security, apps, domain, …)
**What's wrong**: The pattern is `useMutation({ onMutate: () => undefined, onError: () => undefined, onSuccess: …})` followed by `{mutation.isError ? <StateBanner>{mutation.error.message}</StateBanner> : null}`. `onError: () => undefined` is dead code that signals to a reviewer "errors are handled" when they aren't — the user sees the message but the app neither logs nor reports it. There is no toast, no Sentry capture, no analytics breadcrumb.
**Fix**: Drop the no-op `onError`. Add a project-wide `useMutation` wrapper that funnels errors through a `useToast` + telemetry sink.
**Effort**: M

### P2: Postgres `app_passwords` SQL leaks per-tenant existence on auth attempts · medium · security
**File**: `apps/helix/src/platform/auth/app-passwords.ts:281-298`
**What's wrong**: The candidate-row query uses `lower(a.email) = lower(${input.username}) or a.id::text = ${input.username}` *without* filtering by tenant — every app-password across every tenant is a candidate for verify. Two tenants could in principle have the same user email; the second one's password would be tried first by the loop order, leaking cross-tenant timing.
**Fix**: Take a `tenantSlug` (or org id) parameter in the IMAP/SMTP entry point, pass it down, and add `and a.org_id = ${orgId}` to the SQL. The IMAP/SMTP frontend already addresses a specific tenant via SNI / Host; thread it through.
**Effort**: S

### P2: Hash chain not surfaced or alerted on · medium · security
**File**: `apps/helix/src/platform/audit/verifier.ts`, no admin route
**What's wrong**: `AuditHashChainVerifier` exists with `verifyAuditHashChain` returning `{ valid, checked, failures }`. Nothing schedules it, nothing alerts on it, no admin UI exposes it. A successful in-database tamper would not be detected until someone manually runs the verifier.
**Fix**: Add a nightly job (`AuditChainVerifierWorker`) gated by `LeaderElection` that verifies the last N records per tenant, emits `helix_audit_chain_verification_failures_total{org}` and writes an audit record `audit.chain.verification.failed`. Surface the last verifier run + failure count in the Admin Overview.
**Effort**: M

### P2: Webhook `compactHeaders` strips `cookie` but keeps custom auth headers · medium · security
**File**: `apps/helix/src/platform/webhooks/routes.ts:278-289`
**What's wrong**: When persisting inbound webhook requestHeaders, the code only removes `authorization` and `cookie`. Custom auth headers like `x-api-key`, `x-stripe-signature` (already a secret-derived MAC), `x-hub-signature-256`, vendor bearer tokens, etc. are all stored in the DB in plaintext for forensic replay. A DBA or audit-log viewer (`admin.audit`) can lift those values.
**Fix**: Allowlist headers worth persisting (`content-type`, `user-agent`, `x-helix-event`, `x-request-id`), denylist everything else. Hash signatures before persisting if you need to verify them again later.
**Effort**: S

### P2: `audit-log.tsx` has no time-range, actor, object-ID, or export · medium · feature
**File**: `apps/web/src/features/admin/audit-log.tsx:79-200`
**What's wrong**: The audit-log filters expose only `verb` and `objectType` text inputs. The backend `auditLogQuerySchema` accepts `actorId`, `objectId`, and cursors but the UI does not. There is no CSV/NDJSON export, no time-range, no "follow Alice for the last 24h" pivot. Compliance reviewers will need to use psql.
**Fix**: Add From/To date pickers (server-side already orders by `created_at desc`; just need a `from`/`to` schema extension), actor and object-id text inputs, and an "Export NDJSON" that streams `?limit=…` pages through `Response.body`. Cap export by tenant quota.
**Effort**: M

### P2: `setOAuthAppStatus(id, 'pending')` mutation is exposed but `oauth-apps-api.ts` schema only allows 3 statuses · medium · correctness
**File**: `apps/web/src/features/admin/oauth-apps-api.ts:1-211`, `admin-console.tsx:1348-1349`
**What's wrong**: `statusMutation` is typed `"approved" | "pending" | "blocked"`. The UI never sends `pending` (no button maps to it). Dead code in a security-sensitive surface.
**Fix**: Narrow the type to `"approved" | "blocked"` and remove the unreachable branch.
**Effort**: S

### P2: Plugin admin routes call `tools.invoke` without first checking `canAdminPlugins` at the route boundary · medium · security
**File**: `apps/helix/src/platform/plugins/admin-routes.ts:42-144`
**What's wrong**: Permission enforcement is delegated to the tool definitions (`permission: "admin.plugins"` in `plugins/tools.ts:96`), and the route surfaces a 403 via `sendToolError`. That works *iff* every plugin tool sets the correct permission and the tool registry actually enforces it. There is no defense-in-depth at the route. Other admin routes (`security-policies`, `audit`) check at the boundary; this one is inconsistent.
**Fix**: Call `canAdminPlugins(actor)` at the top of each plugin admin route and return 403 immediately, *and* keep the tool-level check. Two-layer enforcement is cheap.
**Effort**: S

### P2: BetterAuth runtime never sets `cookies.session_token.options` (SameSite/Secure/HttpOnly) explicitly · medium · security
**File**: `apps/helix/src/platform/auth/better-auth.ts:437-444`
**What's wrong**: `advanced.cookies.session_token` only overrides the *name*. The library's defaults for `secure`, `sameSite`, `httpOnly`, and `path` are accepted blindly. In dev/test, `secure=false` is fine; in production the deployment relies on the library's behavior. The custom-issued cookie path (`PostgresBetterAuthSessionIssuer`) at `:522-538` does set `HttpOnly; SameSite=Lax; Secure` when the baseUrl is HTTPS — good — but the *primary* BetterAuth-issued cookie isn't audited here.
**Fix**: Explicitly set `secure: true`, `sameSite: "lax"`, `httpOnly: true`, `path: "/"` on the BetterAuth session cookie when `baseURL` is HTTPS. Add a startup assertion that fails when `baseURL=https://…` but session cookies aren't `Secure`.
**Effort**: S

### P2: SOPS adapter shells out to `sops` with a 30 s timeout and no rotation observability · medium · correctness/security
**File**: `apps/helix/src/platform/secrets/sops.ts:94-106`
**What's wrong**: `decryptWithSopsCli` runs `execFile("sops", …)` in the request hot path each call to `get()`/`require()`. A 30 s decrypt hang blocks the request indefinitely and emits no metric. There is no caching layer — every `require("HELIX_BYO_KMS_KEY")` re-decrypts the file.
**Fix**: Cache the decrypted snapshot with file-mtime invalidation (the `version` field is already `sha256(plaintext)`); expose `helix_secrets_decrypt_seconds` histogram and `helix_secrets_decrypt_failures_total`. Move the decrypt off the request path into a startup load + periodic refresh.
**Effort**: S

### P3: Activity log payload column is unbounded JSON — no PII redaction · low · security/compliance
**File**: `apps/helix/src/platform/audit/store.ts:64-74`
**What's wrong**: The `payload` JSON for audit records is whatever the caller passes in `metadata`. Several callers shove the entire input/output of admin actions in (`policy.metadata.fields`, etc.). With BYO storage / mail config, there's no guardrail against an admin accidentally logging a secret-shaped string.
**Fix**: Add a `redactSensitiveFields(payload)` helper that masks any value matching a token/secret heuristic (`^(sk|pk|helix_at|helix_cs|hk_)…$`, very long random strings, anything in keys named `secret|password|key|token`). Run it once in `PostgresAuditStore.append`.
**Effort**: S

### P3: Tenant export/import jobs deleted from migrations directory but still referenced · low · correctness
**File**: gitStatus shows `D apps/helix/src/db/migrations/0055..0058_tenant_*.sql`, and `apps/helix/src/platform/tenancy/export.ts` exists
**What's wrong**: The migrations that created `tenant_export_jobs`, `tenant_import_jobs`, etc. are deleted in the working tree, but `tenancy/export.ts` and related routes are likely still referenced. Schema drift will break boot on a fresh DB.
**Fix**: Either restore the migrations (preferred, since the export feature is wired into the admin UI workflow) or remove the code paths that reference the dropped tables. Add a CI check that `git ls-files migrations/` matches the schema referenced in `db/schema.ts`.
**Effort**: S

### P3: Three "is admin?" predicates coexist with subtly different semantics · low · code quality
**File**: `apps/helix/src/platform/admin/console-shared.ts:28`, `apps/helix/src/platform/plugins/admin-routes.ts:146`, `apps/helix/src/platform/audit/routes.ts:98`
**What's wrong**: `canReadAdminConsole` accepts `admin.*`, `admin.console.read`, `admin.console.write`, *and* `admin.users` (the over-broad backward-compat described in P1 #9). `canAdminPlugins` accepts `admin.plugins` or `admin.*`. `canReadAuditLog` accepts `admin.audit` or `admin.*`. The matrix of which legacy scope implies which surface is undocumented.
**Fix**: Centralize the scope matrix in `permissions/scope-catalog.ts`, generate the `canX` helpers from it, and document the implications table in the PRD.
**Effort**: S

### P3: `lifecycle-routes.ts` deletes the org's *next billing cycle* without a confirmation token · low · security
**File**: `apps/helix/src/platform/tenancy/lifecycle-routes.ts` (not opened — inferred from path)
**What's wrong**: Tenant lifecycle (delete/suspend/resume) is invoked over HTTP. Without re-reading the file in detail I flag that destructive lifecycle should require an idempotency-key + confirmation phrase (the org slug typed) + a 24-hour grace window before `hard-delete-worker` runs. This is standard for tenant destruction.
**Fix**: Confirm-with-slug pattern + `tenant_delete_grace_period_hours` window + cancel-on-grace before the hard-delete worker proceeds.
**Effort**: M

### P3: `BetterAuthApiSessionVerifier.getSessionUser` makes a call to BetterAuth per request with no cache · low · perf
**File**: `apps/helix/src/platform/auth/better-auth.ts:391-402`
**What's wrong**: Every authenticated request resolves the session by calling `this.auth.api.getSession({ headers })`, which in BetterAuth's default config does a DB lookup. There is no per-request memoization (Fastify decorator) and no short-lived in-memory LRU.
**Fix**: Cache the result on the Fastify request (`request.session ??= await getSession(…)`); optionally add a small LRU keyed by signed token with a 5-second TTL.
**Effort**: S

### P3: `webhooks/sources/index.ts` registers Stripe / GitHub etc. but only `github`/`linear`/`stripe` have explicit signature-header names · low · correctness
**File**: `apps/helix/src/platform/webhooks/routes.ts:39-43`
**What's wrong**: `providerSignatureHeaders` maps only three providers; GitLab/Grafana/Prometheus/Alertmanager fall through to the generic `x-helix-signature` even though they ship their own signature headers (e.g. GitLab `X-Gitlab-Token`).
**Fix**: Extend `providerSignatureHeaders` to all providers in `providerSources` and have each `InboundSourceAdapter.verify` consume its own header. Reject when the expected header is absent.
**Effort**: S
