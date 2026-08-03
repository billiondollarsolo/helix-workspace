# Pilot install runbook — zero to mail (and beyond)

**Audience:** Skilled operator bringing up a single-organization Business pilot  
**Timebox:** about one working day when DNS, provider account, and host access are ready  
**Normative plan:** [`docs/superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md`](../superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md) (task E10.5)  
**Product claims:** [`docs/product-claims-mvp.md`](../product-claims-mvp.md)  
**Deep deploy reference:** [`docs/deployment-production.md`](../deployment-production.md)

This runbook is the short path from an empty host to: production-ish Compose up,
first admin sign-in, domain DNS verification, a real outbound test message via a
managed provider, a chat room, a Drive upload, an agent credential, and emergency
kill engage/clear. It does **not** replace release gates, backup drills, or the
full production configuration guide.

## What this is not

- Not public multi-tenant SaaS (ADR-0012).
- Not direct-to-MX outbound mail; not a Helix-hosted IMAP server (ADR-0002 / 0003).
- Not end-to-end encrypted chat (ADR-0004).
- Not native Docs/Sheets/Slides collaborative editing under MVP packaging.
- Not a promise that DNS or provider verification finishes in minutes — those are
  external systems and often dominate the schedule.

## Preconditions

| Need                            | Notes                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| Linux amd64 host                | ClamAV official image is amd64-only in the Compose stack.                           |
| Docker Engine + Compose plugin  | Production overlay pulls digest-pinned images only.                                 |
| Public DNS control              | For your mail/workspace domain(s).                                                  |
| Managed mail provider account   | SES, Postmark, Mailgun, managed SMTP, or SMTP relay — see provider docs.            |
| Upstream MFA assertion producer | Business admin paths require signed `X-Helix-Mfa-Assertion` (see deployment guide). |
| Secret storage outside git      | Operator-owned directory mode `0700` with secret files mode `0600`.                 |
| Promoted image digests          | Every `HELIX_*_IMAGE` value must be `registry/repo@sha256:<64 hex>`.                |

Read claims before you brief pilot users: [`product-claims-mvp.md`](../product-claims-mvp.md).

## Packaging defaults (MVP)

Keep production fail-closed on the MVP allowlist unless a separate Full Workspace
gate package says otherwise:

- `HELIX_WORKSPACE_PROFILE=mvp` (or unset)
- `HELIX_APPS=mail,drive,chat,assistant` (exact)
- `HELIX_EDITORS_MIGRATIONS_ENABLED=false`
- Web build: `VITE_HELIX_MVP_ONLY=true`
- Calendar, Meet, Docs, Sheets, Slides **not** production-enabled

See [`docs/architecture/v1-packaging-matrix.md`](../architecture/v1-packaging-matrix.md).

---

## 1. Prepare secrets and env (no secrets in git)

1. Copy non-secret inputs:

   ```sh
   cp .env.production.example .env.production
   ```

2. Edit `.env.production`: set `HELIX_DOMAIN`, mail provider fields, MFA issuer/audience,
   encryption attestations (only after real evidence), and digest-qualified image refs.
   Do **not** put passwords or API keys in this file.

3. Create `HELIX_PRODUCTION_SECRETS_DIR` (absolute path, mode `0700`) with the secret
   files listed in [`deployment-production.md`](../deployment-production.md)
   (database URLs, TLS material, Redis/NATS passwords, Better Auth secret, object-store
   keys, Meilisearch master key, mail SMTP password, mail provider webhook secret, MFA
   assertion HMAC secret, etc.).

4. Generate each secret from a CSPRNG; minimum length and character diversity rules
   are enforced at startup. Never reuse one password across services.

---

## 2. Validate Compose, then bring the stack up

From the repository root on the deployment host (or a bastion that can reach Docker):

```sh
export HELIX_PRODUCTION_SECRETS_DIR=/path/to/operator-secrets

docker compose \
  --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  config
```

A failed `config` because a secret file or digest is missing is intentional. Fix
inputs; do not bypass production assertions.

Start:

```sh
docker compose \
  --env-file .env.production \
  -f docker-compose.yml \
  -f docker-compose.production.yml \
  up -d
```

Expected shape (high level):

- One-shot `helix-migrate` completes successfully before app replicas serve traffic.
- App depends on healthy Postgres, Redis, NATS, Meilisearch, RustFS, Cerbos, ClamAV,
  SpamAssassin (Business scanners required).
- Public published ports: Caddy HTTP/HTTPS and the chosen inbound SMTP port only.
  Data-plane ports stay private (VPN / SSH tunnel for operator access).

Smoke:

```sh
curl -fsS "https://${HELIX_DOMAIN}/readyz"
# or, if TLS is not yet pointed: curl against the edge with appropriate host/SNI
```

If `/readyz` fails, check migrate job logs, secret mount paths, scanner health, and
encryption attestation env flags before continuing.

---

## 3. First admin

Production does **not** use the local seed accounts from `scripts/dev-up.sh`
(`admin@helix.local` is for development evidence only).

Typical pilot paths (use the one your packaging enables):

1. **Hosted-style signup / onboarding** — complete owner email verification and
   organization provisioning when those routes are enabled for the deployment.
2. **Operator-provisioned actor** — create the first organization owner through your
   controlled bootstrap process (out-of-band SQL/tools are not recommended without a
   written change ticket; prefer supported provisioning APIs).

Then:

1. Sign in at `https://$HELIX_DOMAIN/` with the owner account.
2. Confirm Admin is reachable (`/admin/overview`) with admin scopes.
3. Business tier: ensure the upstream authenticator issues valid MFA assertions for
   admin API calls. Without them, admin-scoped requests fail closed.

Rotate the owner password immediately if any temporary bootstrap credential was used.
Never commit credentials or paste them into tickets/logs.

---

## 4. Domain + DNS verify (external)

Admin → **Domains** (`/admin/domains`).

1. Add the organization domain you will send as (and, if distinct, receive for).
2. Publish the TXT (or other) ownership challenge records Helix shows.
3. Run ownership / DNS verify from the console. Verification requires **public DNS**
   to answer correctly from the resolver Helix uses — local hosts-file tricks do not
   count for production evidence.
4. Set the primary domain when ownership is confirmed.

### Mail DNS (managed provider — external)

Outbound reputation lives at the provider, not in Helix. In the provider console for
the same domain, create the sending domain and publish **their** records:

| Record               | Owner                                                    |
| -------------------- | -------------------------------------------------------- |
| SPF                  | Provider-documented include; one SPF TXT only            |
| DKIM                 | Provider selectors/CNAMEs — provider holds signing keys  |
| DMARC                | Start with reporting; tighten after alignment is healthy |
| Bounce / return-path | Provider custom MAIL FROM domain if required             |
| MX                   | Only if the provider also owns inbound or bounce MX      |

Helix Admin → **Mail** is for provider registration, default selection, and Helix-side
domain linkage. It does not replace provider-side domain verification.

Details: [`docs/mail-managed-provider-delivery.md`](../mail-managed-provider-delivery.md).

---

## 5. Send a test message (managed provider)

1. Admin → **Mail**: confirm an outbound provider is registered and set as default.
   Credentials are secret **references** resolved from the secret store — not pasted
   into the database.
2. Configure provider event webhooks (bounces/complaints) to the documented path
   with the signing secret mounted only as a file secret.
3. From the web Mail UI as a pilot user, compose a message to an external inbox you
   control (or a second pilot mailbox).
4. Confirm:

   - Message leaves Helix with accepted provider response (not only “queued” forever).
   - Message arrives (or soft-bounce feedback is visible) under the managed provider.
   - Headers show provider DKIM, not a Helix-local DKIM story.

Mailpit is a **local/dev sink** and is not a production dependency. Do not treat
Mailpit success as pilot mail evidence.

If delivery fails, follow [`runbooks/mail-provider-outage.md`](./mail-provider-outage.md)
and the provider’s own DNS verification UI before changing Helix code.

---

## 6. Create a chat room

1. Open **Chat** in the shell.
2. Create a room for the pilot cohort; invite at least one other active user.
3. Post a short message; confirm the second user can read it.
4. Remember claims: transport is TLS; access is org/room ACL; **not E2EE**.

Admin Chat controls (retention / legal hold / export) live under Admin → **Chat** and
use real tools with confirmation gates — exercise later if needed for the pilot.

---

## 7. Upload a Drive file

1. Open **Drive**; create a folder if useful.
2. Upload a small benign file (PDF or PNG).
3. On Business tier, the object stays unavailable until integrity + **real ClamAV**
   return clean. A no-op scanner is forbidden in production Business boots
   (`assertDriveMalwareScannerReady`).
4. After clean: open the read-only preview (MVP: no native office collaborative edit).
5. Optional: create a share to another org member and confirm access.

Scanner trouble: [`runbooks/drive-scanner-outage.md`](./drive-scanner-outage.md).

---

## 8. Create an agent credential

1. Admin → **Agent credentials**.
2. Create a credential bound to a non-human actor with **least-privilege scopes**.
3. Copy the secret **once** into a sealed operator store; it will not be shown again.
4. Do not grant write scopes for a first smoke unless you are about to test
   confirmation gates.
5. Optional smoke: use the credential against a read-only tool/MCP path and confirm
   the audit log distinguishes agent from human.

Agent security incident path: [`runbooks/agent-security-incident.md`](./agent-security-incident.md).

---

## 9. Emergency kill — engage and clear

1. Admin → **Agent emergency controls** (`/admin/agent-controls`).
2. Confirm current state: emergency kill (global read-only) off; agent writes enabled.
3. Click **Engage emergency kill**. Confirm UI shows global read-only **ON**.
4. Attempt a non-read agent tool call (or confirm via controls API status): non-read
   tools must deny while kill is engaged.
5. Click **Clear emergency kill**. Confirm global read-only is off.
6. Leave the pilot in the **cleared** state unless you are deliberately locking down.

Org-scoped disable is available on the same page for a single organization UUID.

---

## 10. Exit checklist

| Step             | Done when                                                |
| ---------------- | -------------------------------------------------------- |
| Compose up       | `/readyz` green; migrate succeeded; scanners healthy     |
| First admin      | Owner signed in; Admin overview loads                    |
| Domain           | Ownership verified in Admin Domains                      |
| Mail DNS         | Provider + public DNS SPF/DKIM/DMARC verified externally |
| Test mail        | External receipt under managed provider                  |
| Chat             | Room + cross-user message                                |
| Drive            | Upload clean-scanned; preview works                      |
| Agent credential | Created, secret stored offline, audit visible            |
| Kill switch      | Engaged (denies non-read) then cleared                   |

---

## Honest external dependencies

| Dependency                        | Why you cannot skip it                              |
| --------------------------------- | --------------------------------------------------- |
| Public DNS                        | Domain ownership and mail authentication records    |
| Managed mail provider             | Outbound delivery, DKIM, bounce/complaint webhooks  |
| TLS certificates at edge          | User and API trust (Caddy / ACME or operator certs) |
| Upstream MFA assertion issuer     | Business admin API access                           |
| Object/volume encryption evidence | Business encryption-at-rest attestations            |
| Off-host backup target            | RPO ≤ 24h / RTO ≤ 4h pilot objectives (ADR-0006)    |

---

## Related docs

- Product claims: [`docs/product-claims-mvp.md`](../product-claims-mvp.md)
- Elite plan: [`docs/superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md`](../superpowers/plans/2026-08-03-elite-mvp-enterprise-production.md)
- Production deploy: [`docs/deployment-production.md`](../deployment-production.md)
- Admin guide: [`docs/admin-guide.md`](../admin-guide.md)
- Incident index: [`docs/RUNBOOK.md`](../RUNBOOK.md)
- Packaging: [`docs/architecture/v1-packaging-matrix.md`](../architecture/v1-packaging-matrix.md)
- Admin enforce-or-hide inventory: [`docs/admin-enforce-or-hide-inventory.md`](../admin-enforce-or-hide-inventory.md)

## Safety

- No production secrets, customer data, message bodies, or filenames in tickets or
  evidence dumps.
- Prefer opaque IDs and redacted configs in any dry-run notes attached to E10 evidence.
