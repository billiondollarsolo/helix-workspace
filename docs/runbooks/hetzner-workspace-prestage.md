# Hetzner development staging and agent testing

Updated 2026-10-15 for `workspace.helixapps.si` on `89.167.14.138`.
This is an explicitly authorized **development environment for testing**.
Production activation and backup attestations remain false. The source baseline
is `aa4d2da67c37a851a3ce1a89c24fd307073f5be1`, with the corrections described below.

## Deployment

The host is `helix-workspace-1`, Ubuntu 26.04.1 LTS, amd64, with eight CPUs,
approximately 16 GiB RAM and a 305 GiB disk. Docker Engine, Buildx and Compose
were installed from Docker's signed Ubuntu repository. The checkout excludes
local env files, dependencies, build output and operator credentials.

| Location                                        | Purpose                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `/srv/helix/repo`                               | Source checkout                                                       |
| `/srv/helix/config/development-compose.json`    | Active resolved development configuration                             |
| `/srv/helix/config/staging.env`                 | Protected inputs for a future production deployment                   |
| `/srv/helix/config/private-ingress.yml`         | Original loopback-only production ingress override                    |
| `/srv/helix/encrypted-data.luks`                | Sparse 160 GiB LUKS2 backing file                                     |
| `/srv/helix-data`                               | Unlocked encrypted ext4 mount                                         |
| `/srv/helix-data/docker`                        | Docker data root, including application volumes                       |
| `/srv/helix-secrets`                            | Symlink to secrets inside the encrypted mount                         |
| `/srv/helix/runtime-patch`                      | Compiled development corrections and image recipe                     |
| `/srv/helix/runtime-threading-update`           | Mail threading/API and live-refresh web image recipes                 |
| `/srv/helix/runtime-full-test`                  | Full app configuration, Jitsi install, AI fixes and rollback evidence |
| `/srv/helix/evidence`                           | Deployment, mail, backup and validation results                       |
| `/srv/helix-data/recovery/owner-invitation.txt` | Mike's protected first-login invitation                               |

The dependencies use pinned promoted images from the successful
[image security workflow](https://github.com/billiondollarsolo/helix-workspace/actions/runs/38478093440).
The active API image is a local development derivative of that exact promoted
API image, containing the compiled fixes below. It is not a promoted production
artifact. Its local image ID and source hashes belong in the deployment evidence.

The current development images are
`helix/workspace-development:validation-r5-openapi` and
`helix/workspace-web-development:validation-r5-accessibility`. The one-shot migrator uses
a locally built API image with development pull policy `never`. Previous images and protected,
timestamped pre-change Compose copies remain available for rollback. The full
development install enables Calendar, Meet, Assistant and the optional Passwords
service, preserving the earlier Mail, Drive, Chat and approval corrections.
The migrator remains `helix/workspace-development:native-keepass-r4-bind`: the
validation update changes Swagger configuration and adds no migration.
Migration `0229_password_vaults.sql` adds actor- and tenant-private encrypted
KDBX storage, with one previous encrypted revision for recovery.

The development configuration sets `NODE_ENV=development`, retains Business
action approvals, and makes administrator and sensitive-action MFA optional by
the operator's explicit tenant policy. It retains PostgreSQL application and
migration roles, private TLS, object KMS, versioning, retention, audit storage,
ClamAV and SpamAssassin. This explicitly authorized development install uses the
Full Workspace profile. Production packaging and release evidence are unchanged.
Meet uses generated credentials, a private XMPP CA, a verifying Java truststore,
and the bundled authenticated Jitsi and TURN services.

Operate the active stack with:

```sh
ssh -i ~/.ssh/mj_hetzner_091123 root@89.167.14.138

docker compose -f /srv/helix/config/development-compose.json ps

docker compose -f /srv/helix/config/development-compose.json up -d
```

All application dependencies and the web edge became healthy; 229 migrations
completed. Both private and public readiness returned `{"ok":true}`.
Caddy obtained a trusted Let’s Encrypt certificate and the public web landing
and sign-in pages loaded.

## Ingress and DNS

Cloudflare contains these records:

| Name in `helixapps.si`          | Type | Value                                      | Proxy    |
| ------------------------------- | ---- | ------------------------------------------ | -------- |
| `workspace`                     | A    | `89.167.14.138`                            | Proxied  |
| `mail.workspace`                | A    | `89.167.14.138`                            | DNS only |
| `workspace`                     | MX   | `mail.workspace.helixapps.si`, priority 10 | DNS only |
| `_helix-verification.workspace` | TXT  | Exact challenge issued by Helix Admin      | DNS only |
| `meet.workspace`                | A    | `89.167.14.138`                            | DNS only |
| `turn.workspace`                | A    | `89.167.14.138`                            | DNS only |
| `passwords.workspace`           | A    | `89.167.14.138`                            | DNS only |

The assigned nameservers are `cruz.ns.cloudflare.com` and
`woz.ns.cloudflare.com`. The `.si` parent now publishes that pair. Direct
queries confirmed the workspace, mail and verification records. Helix verified
the TXT challenge and enabled identity and mail for the primary workspace
domain. The application and Caddy use Cloudflare's public resolvers for external
DNS, retaining Docker service discovery for internal dependencies.

Caddy publishes IPv4 TCP 80 and 443. Meet and Passwords accept direct HTTPS with
trusted certificates. The main workspace site checks the actual socket peer
against Cloudflare's 15 IPv4 networks; direct workspace requests return 403,
including attempts to spoof forwarded client headers. The guard does not trust
client-supplied forwarded headers. HTTP port 80 remains public for ACME renewal
and redirects. The managed firewall script persists this transport configuration
after Docker starts; the site restriction lives in
`/srv/helix/runtime-full-test/Caddyfile.full-test`.

The nested Meet and Passwords names use DNS only because Cloudflare's default
Universal SSL certificate covers only the root and first-level subdomains.
Their server certificates cover the exact nested names. Keep the main
`workspace` record proxied. Nested proxying requires additional Cloudflare
certificate coverage; see [Cloudflare's documentation](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/).

The media bridge publishes UDP 10000. Authenticated TURN publishes TCP/UDP 3478,
TLS TCP 5349, and UDP 49160–49200. Its allowed relay peer is the server's public
address. The XMPP controller and Jitsi web service have no public Docker ports.
The TURN certificate is copied from Caddy's issued certificate and checked by
`helix-turn-certificate.service`; its timer refreshes it every 12 hours and
recreates the relay after changes. The helper also preserves the pinned Coturn
image's non-root secret-file ownership. Root-owned bind secrets are not readable
by that process. Generated XMPP secrets stay root-owned; the shared Prosody init
helper installs a private, Prosody-owned runtime copy.

External UDP and trusted TLS allocation tests passed and released their
allocations. Anonymous allocation was denied. Both the conference controller and
bridge authenticated to Prosody with certificate verification enabled. These
checks do not prove a two-person browser call or recording.
The API, PostgreSQL, Redis, NATS, object storage and private SMTP receiver have
no public listeners. HTTP/3 and public IPv6 origin listeners are not enabled.

## Full development apps and AI

All six core apps report enabled and registered. Calendar invitation importing
is on. Contacts remains available through the launcher. Passwords is installed
at `https://passwords.workspace.helixapps.si`; its vault accounts are separate
from Helix accounts and signups are restricted to `workspace.helixapps.si`
addresses with email verification. The Vaultwarden administration endpoint is
not enabled.

Passwords now appears in the desktop rail when installed and enabled; full
phone navigation offers it under More. Live standalone testing covered signup,
verification mail, a saved login, secure-note creation/editing, lock, incorrect
password denial, correct unlock, fresh login with exact Unicode note recovery,
and disposable account deletion. A fixture-only database check confirmed opaque
encrypted item fields. The temporary vault Mail reader was revoked and disabled;
Atlas remains active.

Native Passwords is now available at `https://workspace.helixapps.si/passwords`.
People use their Helix session and choose a vault master password; no second
account or identity provider is needed. Existing Vaultwarden accounts remain at
their original address, reached through **Open previous password manager**.
No automatic migration or deletion of those accounts was performed.

The native vault uses KDBX 4 with Argon2id and browser-worker encryption. Its API
accepts only human sessions, stores no plaintext vault fields, and rejects stale
versions. The worker terminates on lock, tab hiding, navigation or 5-minute
inactivity. A failed encrypted save can be retried or downloaded without repeating
the item mutation; conflicting tabs must download their changes before reload.
Requests bind `X-Helix-Vault-Owner` to the signed-in actor: stale tabs cannot
read or replace a different account’s vault after an account switch. Identity
refusals and worker failures lock the vault and clear decrypted fields. The saved and previous
encrypted revisions can be downloaded as `.kdbx`. This
first slice has a 1 MiB operational limit, supports logins and notes, and does not
provide sharing, file import, master-password changes or external-client sync.
Neither Helix nor its administrators can recover a forgotten master password.

Live browser checks used an explicitly provisioned, unprivileged test person,
not the owner. Creation, login-item save/edit, secure-note save, incorrect unlock,
correct unlock, Unicode recovery, encrypted API output and previous revisions
passed. The fixture's sessions were revoked, actor disabled and test vault
removed under an audited maintenance operation. The owner was untouched. Atlas
still answers MCP `platform.ping`; its credential receives 401 for personal
vault storage. Independent PyKeePass read/edit/save and real PostgreSQL RLS/CAS
checks passed. The native-vault acceptance run passed 5,514 tests plus 12 relevant
browser/accessibility cases. See the
[native-vault evidence](../reviews/evidence/2026-10-14-native-keepass.json).
The later [system validation](../reviews/evidence/2026-10-15-system-validation.json)
passes 5,515 tests and records the fixed OpenAPI regression, browser and loaded
Admin accessibility checks, live agent/AI checks, and remaining defects.
The existing off-server archive predates this change; no new restore drill was
performed for this slice. Export encrypted vault copies and test current database
backups before treating this development instance as production.

The dedicated `_dmarc.workspace` TXT record now declares `v=DMARC1; p=none`.
Before it existed, DKIM-passing vault verification mail was correctly held from
an allowlisted agent inbox because DMARC was `none`. Fresh mail reached the
inbox after the policy was published. See the
[AWS authentication guide](https://aws.amazon.com/blogs/messaging-and-targeting/email-authenctication-dmarc-policy/)
for why a DMARC policy and aligned authentication matter.

Configure AI at **Admin → Assistant → Models**. Keys use the write-only form
field and are not returned by settings reads. Helix AI appears in the desktop
rail once its provider is available; phone navigation offers it under More.
Saving provider settings refreshes the Assistant queries, and availability is
rechecked in the background. Changing a key or endpoint under an existing
provider id invalidates the backend availability probe.

GPT-6 Sol/Luna Chat Completions requests use `reasoning_effort: none`, as required
for native function calling. Streaming and buffered requests share this behavior;
other model families retain their existing request format. See the
[OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna).
Bounded, allowlisted error parsing distinguishes provider quota exhaustion from
temporary HTTP 429 throttling without exposing provider response contents.
Requests without native tools omit `tool_choice`; sending that parameter alone
caused OpenAI to reject otherwise valid conversations.

This explicit development environment supports global AI endpoints. Production
still requires declared provider processing placement to match residency rules.
The same placement check now runs before saving settings, on hot reload, and at
startup. Provider forms preserve the processing region. This prevents a saved
configuration from working temporarily and breaking the next restart.

The composer clears while sending and restores the draft on failure. A rejected
streaming request rolls back its conversation changes and explains that it was not saved.
Successful conversations refresh the thread list and retain their URL and
history. Public MCP generation and the REST streaming endpoint both returned
real configured-provider replies. Independent MCP reads verified four stored
messages and the conversation's reply preview. The ten-minute own-conversation
test credential was revoked afterward; Atlas's standing credential remains active.
Agent stream output remains buffered until its output classification check;
the successful agent REST test received a terminal `final` event.

Still separate: Jibri recording is not installed; web search has no configured
provider; semantic retrieval has no embedding/vector provider configuration.
Ordinary workspace retrieval is enabled and remains permission-filtered. AI
Mail drafting and broader generated summaries remain in the optional AI plan.
Private-room administrative access remains off. No production evidence or
unattended external-mail approval was fabricated for testing.

The Cloudflare source list and idempotent firewall script live at:

```text
/srv/helix/config/cloudflare-v4.txt
/srv/helix/bin/cloudflare-origin-firewall
```

Cloudflare proxying does not replace Helix authentication. Cloudflare Access is
not configured. MCP and CLI requests must still use individually scoped Helix
credentials. If Access is added, test the selected clients' service-token header
support, including presigned storage requests, before enabling it.

## Admin setup

The owner is `mj@workspace.helixapps.si`, display name **Mike Johnson**.
Its account has not been claimed by automation. Retrieve the single-use,
seven-day invitation through your SSH session:

```sh
ssh -i ~/.ssh/mj_hetzner_091123 root@89.167.14.138 \
  'cat /srv/helix-data/recovery/owner-invitation.txt'
```

A protected local copy is also stored outside this checkout at
`~/.local/share/helix-workspace/89.167.14.138/owner-invitation.txt`.
Open the link, choose a password, and click **Join workspace**. MFA is optional,
including for administrator and sensitive operations. To opt in, open
**Settings → Security → 2-step verification**, confirm your password, scan the
locally generated QR code with an authenticator app and verify its six-digit
code. A manual setup key is available when scanning is inconvenient. Save the
recovery codes. Passkeys are also available. The invitation works once.
If it expires before use, rerun the existing owner helper:

```sh
umask 077
docker compose -f /srv/helix/config/development-compose.json exec -T helix \
  /nodejs/bin/node dist/db/bootstrap-owner.js \
  --email mj@workspace.helixapps.si --name 'Mike Johnson' \
  > /srv/helix-data/recovery/owner-invitation.txt
```

Once joined, recovery goes through the sign-in page's password reset flow.
The saved MFA policy uses `adminMfa=optional`,
`sensitiveActionMfaRequired=false` and `secondAdminApprovalRequired=false`.
Password-only administrator reads and authentication-policy updates were verified
with a disposable account. Recent sign-in, actor permissions and agent action
approvals remain enforced. Administrators can require MFA later from
**Admin → Security → Policies**.

Optional email codes are a second step after the password. In **Settings →
Security → Email codes**, confirm the password, verify an external
inbox with its six-digit code, then explicitly turn the factor on. Workspace
mailboxes cannot be used for this factor. Outbound SMTP must be working before
verification or enabling the factor; a sending failure does not bypass MFA.
Turning the optional factor off requires the password. Verification, sign-in,
single-use codes, attempt limits, session assurance and outage behavior were
checked against PostgreSQL and the maintained authentication library with a
disposable identity. The owner's factors were not changed.

The public [admin setup guide](https://workspace.helixapps.si/admin-setup.md) and
[agent guide](https://workspace.helixapps.si/agent-setup.md) are linked from Admin
Home. These documents grant no access. Provider-assisted configuration remains
a [design proposal](../architecture/provider-assisted-setup.md).

## SES outbound and inbound prerequisites

SES is configured in **US East (Ohio), `us-east-2`**. Its region is independent
of Helix's `eu-central` data residency label. The selected SMTP credential was
created with SES's newer Mail Manager flow, which provisions authenticated
SMTP ingress and a send-to-internet rule for outbound delivery.
[AWS documents this credential flow](https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials-mail-manager.html).

The active outbound endpoint is:

```text
eigy4enapz8h.fips.yxbq.mail-manager-smtp.amazonaws.com:587
```

The installed username is in the protected deployment configuration. The
password is in `/srv/helix-secrets/mail_smtp_password`, readable by the runtime
through its read-only secret mount. No password appears in the source, this
runbook or the test reports. Port 587 uses required STARTTLS with certificate
verification; `MAIL_SMTP_SECURE=false` selects STARTTLS rather than implicit TLS.
Use the raw username/password from the downloaded CSV; the SMTP library handles
AUTH encoding.

The TLS and SMTP authentication checks passed (235). A provider diagnostic from
`mj@workspace.helixapps.si` to `mikejohnsonit@gmail.com` was accepted, and the
recipient confirmed it arrived. Its subject was
`[Helix development] SES SMTP connection test`. This is provider delivery
evidence, separate from a successful agent-originated Helix send.

Helix identity and mail capabilities are enabled on the verified primary
domain. The stack uses its env-configured SMTP fallback. Creating a managed
provider without a valid tenant secret handle would override that working
fallback. SES signing is recognized when `MAIL_PROVIDER=ses` or the selected
fallback uses `SES_SMTP_HOST`; SES does not need a separate Helix-owned DKIM key.
Self-managed SMTP retains the tenant-key requirement, and active tenant keys
continue to be used alongside SES signing.

The disposable agent was assigned an address, issued a separate credential with
`mail.send` and `mail.external`, and submitted an email over public HTTPS/MCP.
The agent could not approve it. A separate reviewer approved the action; after
correcting the SES signing integration, a freshly approved retry was accepted
and recorded as sent. The recipient confirmed that
`[Helix development] MCP agent email test` arrived and Gmail showed DKIM PASS.
The agent also read its sent Mail thread through MCP and was denied changing
its own receive policy. All disposable agent credentials were revoked after
verification.

Use the SES-issued Easy DKIM CNAME records in Cloudflare. A custom
`bounce.workspace.helixapps.si` MAIL FROM is optional when aligned DKIM is used.
If enabled, its MX points to `feedback-smtp.us-east-2.amazonses.com`, with SPF
`v=spf1 include:amazonses.com ~all`. The bounce MX is not the inbox MX.
[AWS describes custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html).
Publish `_dmarc.workspace` TXT `v=DMARC1; p=none` before evaluating authentication
reports and tightening policy. The MX is now present; the DMARC record was
absent in the last direct Cloudflare check.

Public inbound mail is active for this development deployment. Its separate
Postfix/Rspamd edge publishes `89.167.14.138:25` and forwards accepted mail to
Helix on private port 2525 using required, CA-verified STARTTLS. Caddy obtained
a trusted mail-host certificate; Docker Mailserver monitors its mounted
certificate directory for renewal changes. The receiver exposes no SMTP AUTH,
accepts Mike's mailbox, rejects unknown mailboxes with 550, denies external
relay with 554 and rejects oversized envelopes with 552. Three external TCP
probes connected, and a real Gmail reply was delivered to Mike's Helix inbox.
The public MX was confirmed after the administrator saved it.

Postfix forwards the original client IP and HELO with XFORWARD over the verified
private hop. Helix advertises this command only when an explicit trusted-IP
allowlist is configured, and rejects connections from other peers before SMTP
commands. The mail edge's private address is pinned to `172.20.0.11` in this
deployment. Connection accounting retains the raw peer address. Ordinary
message headers cannot set the trusted sender IP.

Mail conversations use a white reading canvas inside the selected application
theme, with aligned sender headers, body text and reply controls. HTML stays in
an opaque sandbox with network access blocked, external links require
confirmation, and quoted replies collapse behind a keyboard-accessible ellipsis.
Plain text and original-message download remain in the message actions menu.
The SMTP From header uses the configured display name; the primary mailbox uses
the user's profile display name. Gmail's choice of visible sender text cannot
be determined from the header alone.

Mail DNS uses a private Unbound recursive resolver on the mail Docker bridge,
with DNSSEC validation and access limited to that subnet and loopback. Public
recursive DNS produced Spamhaus access-error answers; the private resolver
returned the expected test-listing answers. Queue state and logs reside in the
encrypted Docker data directory. Resolved deployment configuration is
`/srv/helix/config/mail-edge-compose.json`; provider credentials are absent.

This is development delivery evidence, not the full production DNS gate:
forward-confirmed mail PTR, DMARC, MTA-STS, TLS-RPT, licensed production DNSBL
access and ongoing monitoring still require their production checks. Follow
[the mail edge guide](../../infra/mail-edge/README.md).

SES bounce and complaint ingestion into Helix still needs implementation:
the existing managed-provider webhook accepts Mailgun, not SES SNS events.
Do not claim that suppression feedback is active because SMTP delivery works.

## Encryption, recovery copy and reboot

LUKS2 encrypts the application data and service secrets on the host. Its unlock
key is held on the operator's machine rather than stored persistently on the
server. Docker has a mountpoint precondition and cannot start on an unmounted
`/srv/helix-data`. After a reboot, unlock and mount it before starting Docker:

```sh
python3 ~/.local/share/helix-workspace/89.167.14.138/bin/recover-after-reboot.py
```

The operator directory is private and outside the checkout:

```text
~/.local/share/helix-workspace/89.167.14.138/
  keys/storage-unlock.key
  keys/backup-identity.txt
  keys/backup-recipient.txt
  backups/operator-ca-20261014.tar.gz.age
  backups/development-cold-20261014.tar.gz.age
  evidence/
```

The development services were stopped for a coherent cold copy of Docker data,
secrets, operator CA, configuration, runtime corrections and deployment evidence.
The stream was age-encrypted directly into the local archive, with no plaintext
archive on either disk. Its encrypted size was 129,278,421 bytes. Age
authentication and all 3,068 archive entries were checked. An isolated restored
PostgreSQL booted, and counts matched: five actors, one draft, one message,
two Drive versions and nine pending actions. The restored object store also
decrypted the 65-byte test file with restored
KMS material and matched its SHA-256. A domain verification regression passed
against the restored database using the application role and verified TLS.

A refreshed copy, `development-final-20261014T071040Z.tar.gz.age`, includes the
new mail edge, optional email MFA, reading view, guides, and retired disposable
accounts. Both the application and mail edge were stopped for this copy. Its
139,336,256 encrypted bytes and 6,372 entries passed age authentication and
archive inspection. It also includes Unbound, Docker service prerequisites and
UFW configuration. The isolated restore results above belong to the earlier
archive; a separate restore drill of this refreshed archive was not performed.

The later copy, `development-final-20261014T091857Z.tar.gz.age`, additionally
includes the threading/live-refresh runtime, updated public guide, and protected
conversation-repair rollback snapshot. Both the application and mail edge were
stopped during the copy and restarted healthy; readiness returned 200. Its
141,168,997 encrypted bytes and 6,690 entries passed age authentication and
archive inspection. This newest archive has not had an isolated restore drill.

This local recovery copy does **not** satisfy the formal Business replicated S3
backup gate. Production configuration still requires the encrypted, signed,
versioned, retained and replicated off-host backup contract and restore evidence.
On October 15, a controlled reboot to kernel `7.0.0-38-generic` confirmed that
storage remains locked until the local recovery helper supplies the off-server
key over pinned SSH. All 17 containers recovered, public readiness passed and
Atlas authenticated through MCP. SSH password authentication is disabled.

The local `helix-development-backup.timer` now runs daily at 03:30 UTC with up to
five minutes of jitter. It catches up after missed runs when the local user
service manager starts. Services pause for the cold snapshot; a server recovery
timer restarts them if the backup connection fails. The first scheduled-service
run produced `development-daily-20261015T174859Z.tar.gz.age` (990,706,130 encrypted
bytes), passed age authentication and recovery-component inspection, and resumed
services. A full application restore of this archive has not been performed.

Inspect the schedule with `systemctl --user list-timers helix-development-backup.timer`
and failures with `journalctl --user -u helix-development-backup.service`.
The operator directory's `evidence/daily-backup-status.json` records the last run.
Backups require this machine and its keys; there is no proactive failure alert or
automatic archive pruning yet. Keep adequate disk space and preserve the keys.
See [stream and recovery validation](../reviews/evidence/2026-10-15-stream-security-validation.json)
for the current `security-r12` API deployment and remaining acceptance limits.

## Agent onboarding and live checks

For a preconfigured agent, a signed-in administrator creates the agent identity,
then issues an expiring API key or OAuth client with explicit scopes. Store the
credential in the runner's secret store. Both credential types worked with MCP;
API keys also worked through REST. OAuth client credentials mint a short-lived
bearer at `/v1/oauth/token`.

```text
MCP: https://workspace.helixapps.si/v1/mcp
CLI base: https://workspace.helixapps.si
```

The live tests used clearly named disposable reviewer accounts, actual password
sign-in and TOTP verification, separate agent credentials, private Chat and
Drive fixtures, and an email draft. Automation did not claim your owner invitation.
All test credentials were revoked; both API keys and an already-issued
OAuth token were rejected on the public endpoint afterward.
The three disposable actors were subsequently disabled, preserving their
messages, files and audit records; both reviewer sessions were rejected afterward.

The current product has resource access requests and action approval. It does
not have a general agent enrollment flow that requests its first credential,
mailbox and storage allocation. That would need a separate, short-lived
invitation restricted to submitting an enrollment request, an admin approval,
resource/scoped credential issuance and an audit trail. An MCP URL by itself
must not create a working identity. Resource approval cannot grant a scope the
credential lacks, and action approval must execute as the requesting actor.

Live checks used encrypted SSH tunnels first and were then repeated at the
public HTTPS MCP endpoint:

- Anonymous and invalid-key MCP rejection; discovery and initialization with
  valid API-key and OAuth credentials; scope-filtered tool discovery.
- Missing `mail.send` scope denial and denial of agent self-provisioning.
- An unattended own-mailbox draft within the existing bounded policy, followed
  by a separate read proving it persisted.
- Chat write queued for the credential owner, self-approval denied, reviewer
  approval executed as the agent, and a subsequent message/resource read.
- Drive folder and upload approvals, TLS-verified object upload, real scanning,
  finalization, SHA-256 verification and exact file content returned through MCP.
- Private owner file denied before a request, owner-visible access request,
  explicit approval granting read access, and successful subsequent MCP read.
- A complete 51-byte file upload, finalization and MCP read through public
  HTTPS, approved by a password-only administrator after making MFA optional.
  Agent self-approval remained denied, and the short-lived test key was revoked.
- An approved rename still denied for a reader; approval did not turn the
  reader into an editor. Direct origin HTTPS access also failed as intended.

Use `helix://drive/file/<id>` for Drive MCP resources. The earlier live-evidence
runbook incorrectly used `/object/`; that documentation was corrected.

Four backend defects were found and corrected during these checks:

1. MCP treated the default tenant UUID as anonymous even with valid credentials.
2. Finite MCP SSE replies bypassed transaction completion, so reported writes
   and pending approval records rolled back after the response.
3. Composite-return domain mutation queries repeated their side effects while
   expanding result columns. The calls now evaluate once in the FROM clause.
4. SES delivery incorrectly required an additional Helix KMS-backed DKIM key.
   Provider-aware key resolution now allows SES signing while preserving the
   default tenant-key check and any active tenant signature.

Focused regressions and the required repository checks accompany those fixes.
Authenticator setup now renders a local, accessible QR code and a manual setup
key. Ten account-settings Playwright tests passed, including QR enrollment and
disabling MFA with axe checks in light and dark mode. The deployed QR was decoded
in the native browser, and a code generated from its payload successfully enrolled
a disposable account. Turning it off cleared the recovery codes from the UI.
Public MCP initialization, scoped access, Mail send, mailbox assignment,
Drive content reads and revocation checks passed. The built CLI also passed MCP
discovery, file content retrieval and REST draft reads through the private test
path. Real Gmail-to-Helix inbound delivery now also passed. First-time
self-service agent enrollment remains an unfinished product flow. Hosted-agent connector
compatibility still needs testing with the actual external client.

## October 15 defect repair deployment

The development API and web now use `helix/workspace-development:defects-r6` and
`helix/workspace-web-development:defects-r6`. Migration
`0230_agent_source_context.sql` adds the bounded tenant/actor source ledger. The
full API image includes patched runtime dependencies; it is not a JavaScript-only
overlay. The protected Compose configuration was backed up before migration and
service replacement, with automatic API/web rollback on failed readiness.
The migration is additive, so a service rollback does not remove the ledger.

MCP content resources now use the same scopes, feature controls, request budget,
audit and data-policy path as tools. Agents retain source identifiers between
calls; destructive and external communication requests need human review even
when a standing automation rule exists. All action kinds have a browser review
page. Mail resources expose bounded pages and continuation metadata. Atlas and
its credential remain active; external-email regression requests were cancelled
without sending. The human owner was not impersonated.

Native SES feedback support is deployed, but the selected environment SMTP
fallback does not automatically become a tenant-managed provider. Follow
[managed provider delivery](../mail-managed-provider-delivery.md) to install a
tenant secret handle, configure the SES-backed provider and its exact SNS topic
ARN, subscribe the displayed HTTPS webhook, enable original headers, and test
feedback with the SES simulator. This pass does not assert that AWS topic wiring
or live bounce/complaint feedback has occurred.

See [repair evidence](../reviews/evidence/2026-10-15-defect-repairs.json) for
checks, image IDs, source binding and remaining acceptance limits. The stack
remains development. Full desktop WebDAV sync, dedicated approval-queue/email
reminders and production acceptance remain planned work.

## October 15 provider and spam refinement deployment

The current development API and web use
`helix/workspace-development:admin-mail-r7` and
`helix/workspace-web-development:admin-mail-r7`. Both services passed readiness
after replacement. The protected Compose rollback copy is
`/srv/helix/config/development-compose.pre-admin-mail-r7-20261015T140409Z.json`.

Admin provider lists now use the shared TanStack table with search, sorting and
nonblocking editing panels. AI models have individual rows and a default-model
selector. Resend and SendGrid are SMTP presets; their delivery events require
future native integrations. See [mail provider setup](../mail-managed-provider-delivery.md).

Mail spam settings include independent Clef/Jev decision-model and LLM controls.
The decision-model worker reserves provider calls atomically against the tenant's
daily cap. The LLM path rejects malformed verdicts, restricts outbound requests
and skips classified content. Clef/Jev remain off on this deployment because no
credential is configured. Start with shadow decisions and review evidence before
enforcement; the separate LLM pass has no shadow mode.

Atlas passed 26 live MCP/CLI checks, including isolation, encrypted-file readback
and human approval enforcement. Its pending external email was cancelled without
sending; Atlas remains active. SES SMTP authentication passed over required TLS.
Server-side inbound checks verified STARTTLS, the Atlas recipient and rejection
of unauthenticated external relay, without submitting message data. A direct
port-25 check from the local workstation timed out, so that network path is not
claimed as verified. Existing environment-based SES delivery and its outstanding
SNS feedback setup are unchanged.

See [provider and mail validation evidence](../reviews/evidence/2026-10-15-provider-admin-mail-validation.json)
for test counts, deployed image IDs and live-provider limits. Credentials and raw
private test logs are kept outside the repository.

## October 15 UI consistency deployment

The development web now uses
`helix/workspace-web-development:ui-consistency-r8`; the API remains
`helix/workspace-development:admin-mail-r7`. No database migration was needed.
Both containers are healthy, public readiness passed, and the public JavaScript
and stylesheet asset paths match the tested build. The protected rollback copy is
`/srv/helix/config/development-compose.pre-ui-consistency-r8-20261015T150305Z.json`.

The audited management lists share TanStack search and sorting, including mobile
sort controls. Agent credentials, app passwords and AI cost limits use labelled
Add actions and nonblocking creation panels. Mail settings and other audited
editing flows use shared panels; destructive confirmations remain blocking.
Calendar and webhook controls reuse global styles. Search and sorting on paged
lists explicitly apply to loaded results.

The repository suite passed 5,560 tests, with 398 skipped. The browser suite
passed 250 cases, with the optional live SMTP/Mailpit case skipped. Final label
refinements passed affected focused checks. Management lists and panels passed
responsive light/dark accessibility checks. See
[UI consistency evidence](../reviews/evidence/2026-10-15-ui-consistency.json) for
validation scope and limits. Raw logs and screenshots are stored privately
outside the repository.

## Development security and restore follow-up — October 15

API `security-r13` supersedes `security-r12`. The core application restore drill,
extended sharing checks, image/host scans and optional-image patch deployment are
recorded in [development completion evidence](../reviews/evidence/2026-10-15-development-completion-validation.json).
The daily archive restored successfully into isolated services on this host; this
is not proof of a replacement-host recovery or production acceptance.

`infra/docker/optional-runtime.Dockerfile` supplies development-only `packages`,
`jitsi` and `mail-edge` targets. Pass the original pinned image as `SOURCE_IMAGE`
and its original user as `RUNTIME_USER`, build the matching target, then scan and
record the resulting image ID before updating the resolved development compose.
The active six optional-image IDs and rollback configurations are in the evidence.
APT/APK repository contents can change between builds; this is not the signed,
promoted production-image pipeline. Unfixed High/Critical advisories remain.

Mail's private Unbound resolver must start without depending on Docker. Its config
at `/etc/unbound/unbound.conf.d/helix-mail.conf` includes `ip-freebind: yes`, retaining
only loopback and the mail bridge listener/allowlist. Remove the old
`/etc/systemd/system/unbound.service.d/helix-mail.conf` Docker dependency: it creates
an ordering cycle through `nss-lookup.target`. The
[Unbound manual](https://unbound.docs.nlnetlabs.nl/en/latest/manpages/unbound.conf.html#ip-freebind)
describes binding the configured private address before its interface exists.
Do not broaden the listener to the public interface.

After a reboot and storage unlock, verify mail DNS as well as HTTP readiness:

```sh
systemctl is-active unbound.service
unbound-checkconf
docker exec helix-mail-edge-inbound-1 dig +short @172.21.0.1 gmail.com MX
```

The local `recover-after-reboot.py` helper starts Unbound and checks DNS inside the
mail container before reporting success. The DNS repair passed config/unit-graph
checks and a service start; a second whole-host reboot was not performed in this
follow-up. Public TCP 25 still times out from the operator network, so SMTP probes
run from the deployment host. They stop before DATA and send no email.
