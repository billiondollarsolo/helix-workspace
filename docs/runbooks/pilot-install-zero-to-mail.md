# Pilot install runbook — zero to mail (and beyond)

**Audience:** Skilled operator bringing up a single-organization Business pilot

**Timebox:** about one working day when DNS, provider account, and host access are ready

**Normative plan:** [`docs/archive/plans/2026-08-03-elite-mvp-enterprise-production.md`](../archive/plans/2026-08-03-elite-mvp-enterprise-production.md) (task E10.5)

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

| Need                           | Notes                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Linux amd64 host               | 4 CPUs, 16 GB memory, 80 GB disk. The ClamAV image is amd64-only.                          |
| Docker Engine + Compose plugin | Compose 2.24 or newer. The secrets generator needs Node.js and `openssl`, or Docker alone. |
| A checkout of this repository  | At the commit you deploy; the overlay mounts configuration files from it.                  |
| Public DNS control             | An `A`/`AAAA` record for `HELIX_DOMAIN` pointing at the host, and `MX` for inbound mail.   |
| Open inbound ports             | 80 and 443 for the web app; 25 for inbound mail (many hosting providers block it — ask).   |
| Managed mail provider account  | SES, Postmark, Mailgun, managed SMTP, or SMTP relay, with STARTTLS — see provider docs.    |
| An authenticator app           | Administrators need 2-step verification before the Admin console works.                    |
| Promoted image digests         | Every `HELIX_*_IMAGE` value must be `registry/repo@sha256:<64 hex>`.                       |

Read claims before you brief pilot users: [`product-claims-mvp.md`](../product-claims-mvp.md).

## Packaging defaults (MVP)

Keep production fail-closed on the MVP allowlist unless a separate Full Workspace
gate package says otherwise:

- `HELIX_WORKSPACE_PROFILE=mvp` (or unset)
- `HELIX_APPS=mail,drive,chat,assistant` (exact)
- Web build: `VITE_HELIX_MVP_ONLY=true`
- Calendar and Meet **not** production-enabled

See [`docs/architecture/v1-packaging-matrix.md`](../architecture/v1-packaging-matrix.md).

---

## 1. Prepare secrets and env (no secrets in git)

Run every command from the repository root on the deployment host.

1. Generate the secret files and certificates:

   ```sh
   sudo install -d -m 0700 -o "$USER" /srv/helix-secrets
   node infra/scripts/generate-production-secrets.mjs \
     --dir /srv/helix-secrets --mail-host mail.example.com
   ```

   Without Node.js on the host, run the same script in a container:

   ```sh
   docker run --rm --user "$(id -u):$(id -g)" \
     -v "$PWD/infra/scripts:/scripts:ro" -v /srv/helix-secrets:/out \
     node:24 node /scripts/generate-production-secrets.mjs \
     --dir /out --mail-host mail.example.com
   ```

   Then put your mail provider's SMTP password in `/srv/helix-secrets/mail_smtp_password`,
   move `/srv/helix-secrets/ca` offline, and back the directory up. See
   [Secret files](../deployment-production.md#secret-files).

2. Copy the non-secret inputs:

   ```sh
   cp .env.production.example .env.production
   echo 'HELIX_PRODUCTION_SECRETS_DIR=/srv/helix-secrets' >> .env.production
   ```

3. Edit `.env.production`:
   - `HELIX_DOMAIN`, `HELIX_REGION`, and `HELIX_DEFAULT_ORG_NAME`. Choose the region label
     before the first start; it cannot be changed afterwards.
   - The eight image references, resolved as described in
     [Image references](../deployment-production.md#image-references).
   - The mail provider fields (`MAIL_PROVIDER`, `MAIL_FROM_DOMAIN`, `MAIL_SMTP_*`).
   - The three encryption attestations, only after collecting the evidence.

   Do **not** put passwords or API keys in this file.

4. Choose where the HTTPS certificate comes from. With nothing set, Caddy obtains one from
   Let's Encrypt. To serve your own, see
   [TLS certificates](../deployment-production.md#tls-certificates) and add
   `-f docker-compose.tls-files.yml` to every command below.

---

## 2. Validate Compose, then bring the stack up

```sh
compose="docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.production.yml"

$compose config --quiet
```

(In zsh, define `compose` as a function instead; zsh does not split the variable into words.)

A failed `config` because a secret file or digest is missing is intentional. Fix
inputs; do not bypass production assertions.

Start:

```sh
$compose up -d
```

The first start takes up to ten minutes: ClamAV downloads its signatures before Helix
reports ready. Expected shape:

- The one-shot services (`helix-migrate`, `rustfs-kms-init`, `rustfs-kms-key`,
  `helix-storage-init`) exit with status 0 before the application starts.
- The application depends on healthy Postgres, Redis, NATS, Meilisearch, RustFS, Cerbos,
  ClamAV, and SpamAssassin.
- Published ports: Caddy HTTP/HTTPS and the inbound SMTP port only. Data-plane ports stay
  private (VPN / SSH tunnel for operator access).

Smoke:

```sh
$compose ps
curl -fsS "https://${HELIX_DOMAIN}/readyz"
```

If `/readyz` does not answer 200, the application log names the dependency that is failing:

```sh
$compose logs helix | grep -i 'not ready'
```

---

## 3. First admin

Production has no default accounts and no public sign-up. The local seed accounts from
`scripts/dev-up.sh` (`admin@helix.local`) exist only in development.

1. Create the workspace owner's invitation:

   ```sh
   $compose exec helix /nodejs/bin/node dist/db/bootstrap-owner.js \
     --email owner@example.com --name "Owner Name"
   ```

   The command prints a single-use link that expires in 7 days. Treat it as a credential.

2. Open the link, choose a password, and you are signed in at `https://$HELIX_DOMAIN/`.
3. Open **Settings → Security → 2-step verification** and add an authenticator app. On the
   Business tier the Admin console refuses administrator requests until the account has a
   second step, and asks you to set one up.
4. Confirm the Admin console opens (`/admin/overview`). Helix asks for a fresh code after
   10 minutes of administrator work and then continues what you were doing.

**Adding people:** in **Admin → Users**, choose **Invite people**, enter the person's
email address, and choose Member or Administrator (only a full administrator,
`admin.*`, can invite another administrator). Helix emails a link that expires in
7 days; the person opens it, chooses a password, and is signed in. Until then the
person appears as **Invited**, and the row menu can resend or withdraw the
invitation. The same actions are available from the CLI (`helix admin users invite --email <address>`).
Invitation email uses the managed mail provider; finish sections 4 and 5, then confirm one test
invitation arrives before inviting the pilot cohort.

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
Mailpit success as pilot mail evidence. Helix sets `requireTLS` on SMTP and will
not downgrade to plaintext, so a catcher that does not offer STARTTLS refuses the
send outright — locally that surfaces as
`Error upgrading connection with STARTTLS: 502 5.5.1 Command ...`. That is the
transport refusing to leak mail, not a Helix bug.

### If the message stays `queued`

`queued` with no error used to be indistinguishable from "not sent yet". It is
now diagnosable — work down this list:

1. **Read the row, not the UI.** `mail.outbound.get` returns `status`,
   `deliveryStatus`, `provider`/`providerKind`, `sentAt`, and `lastError`. A
   bound `providerKind` with a populated `lastError` means dispatch ran and the
   provider rejected it; that error text is the provider's and belongs in their
   support ticket, not a code change.
2. **`provider: null` after the undo window** means no provider was ever bound —
   dispatch either never ran or could not resolve a transport for the sending
   domain. Check a provider is registered _and set as default_ for the org, and
   that `MAIL_FROM_DOMAIN` matches a verified sending domain.
3. **`Outbound mail dispatch skipped`** (warn): dispatch found no row to claim —
   already sent by another replica, cancelled, or still inside its undo window.
   Benign unless it repeats for the same id.
4. **`Outbound mail recovered by reconciliation sweep`** (warn): dispatch is
   driven by a `mail.send` event, and the sweep is the backstop that re-dispatches
   what the event path dropped. Recovering anything means events are being lost
   between the outbox and the worker — the mail is not stuck, but the bus needs
   investigating. A healthy deployment sweeps up nothing.
5. **`Outbound mail dispatch error`** (error): carries `errorName`,
   `errorMessage`, and `operatorCode` when the cause is provider
   misconfiguration.

A message that stays `queued` with _none_ of the above in the log means the
worker is not running — confirm `outbound-mail-worker` acquired singleton
leadership at boot, and that this node has `mail` in `HELIX_APPS`.

If delivery fails, follow [`runbooks/mail-provider-outage.md`](mail-provider-outage.md)
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
4. After clean: download the file and verify its bytes in an appropriate local application.
5. Optional: create a share to another org member and confirm access.

Scanner trouble: [`runbooks/drive-scanner-outage.md`](drive-scanner-outage.md).

---

## 8. Create an agent credential

1. Admin → **Agent credentials**.
2. Create a credential bound to a non-human actor with **least-privilege scopes**.
3. Copy the secret **once** into a sealed operator store; it will not be shown again.
4. Do not grant write scopes for a first smoke unless you are about to test
   confirmation gates.
5. Optional smoke: use the credential against a read-only tool/MCP path and confirm
   the audit log distinguishes agent from human.

Agent security incident path: [`runbooks/agent-security-incident.md`](agent-security-incident.md).

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
| Authenticator app per admin       | Business admin access needs 2-step verification     |
| Object/volume encryption evidence | Business encryption-at-rest attestations            |
| Off-host backup target            | RPO ≤ 24h / RTO ≤ 4h pilot objectives (ADR-0006)    |

---

## Related docs

- Product claims: [`docs/product-claims-mvp.md`](../product-claims-mvp.md)
- Elite plan: [`docs/archive/plans/2026-08-03-elite-mvp-enterprise-production.md`](../archive/plans/2026-08-03-elite-mvp-enterprise-production.md)
- Production deploy: [`docs/deployment-production.md`](../deployment-production.md)
- Admin guide: [`docs/admin-guide.md`](../admin-guide.md)
- Incident index: [`docs/RUNBOOK.md`](../RUNBOOK.md)
- Packaging: [`docs/architecture/v1-packaging-matrix.md`](../architecture/v1-packaging-matrix.md)
- Admin enforce-or-hide inventory: [`docs/admin-enforce-or-hide-inventory.md`](../admin-enforce-or-hide-inventory.md)
- Local disconnected multi-surface smokes (Mailpit/RustFS, multi-user RBAC):
  [`docs/runbooks/local-disconnected-live-smokes.md`](local-disconnected-live-smokes.md)

## Safety

- No production secrets, customer data, message bodies, or filenames in tickets or
  evidence dumps.
- Prefer opaque IDs and redacted configs in any dry-run notes attached to E10 evidence.
