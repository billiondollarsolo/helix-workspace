# Workspace-managed applications

Updated 2026-10-17. Optional identity connection for one Workspace organization;
Bot remains independently installable. The identity feature defaults off.
See the [cross-app identity protocol](../../../helix-bot/docs/reference/app-family-identity-protocol.md)
and [management/backup design](../../../helix-bot/docs/plans/2026-10-17-app-family-management.md).
Optional backup management is implemented; see the [backup runbook](app-family-backups.md).
The [hosted activation record](2026-10-17-hosted-family-operations.md) describes the
current paired installation and its independently enrolled recovery workers.

## Enable and pair

1. Preserve encrypted database/file/configuration backups and both local recovery
   accounts. Updating an initialized installation never resets its password.
2. Enable maintained human authentication and
   `HELIX_FAMILY_IDENTITY_ENABLED=true`. Use the canonical public HTTPS Workspace
   origin for `BETTER_AUTH_URL`. In Helm use `familyIdentity.enabled: true`.
3. For explicitly trusted private HTTPS app addresses, also opt into
   `HELIX_FAMILY_ALLOW_PRIVATE_NETWORK=true` / `familyIdentity.allowPrivateNetwork`.
   This permits protected outbound private routing, not HTTP or unverified TLS.
   Bot has a corresponding `family_identity.allow_private_networks` setting.
4. As Bot's separate local recovery owner, open Team settings → Single sign-on →
   Helix app family, choose **+ Connect Workspace** and copy the address,
   connection ID and short-lived installation proof.
5. As the Workspace organization administrator, open Admin → Family applications →
   **+ Add application**. Enter those values and review the connection. Copy the
   returned code directly into Bot's **Workspace pairing code** form and connect.
   Do not put proof/code/credentials in URLs, tickets, logs or assistant prompts.
6. Assign people and explicit viewer/member/admin roles in Workspace. Verify
   directory sync, then use **Continue with Helix Workspace** in Bot. Source
   identity is immutable issuer/subject; matching email never adopts a local owner.
7. Connect model providers and create/approve each bot's Workspace account and
   resource grants separately. Human sign-in does not grant mail, chat or files.

Version one reconciles the installation's default organization. Other tenants
remain isolated; enabling this feature does not enroll them. Existing upstream
OIDC/SAML sign-in can authenticate a linked Workspace user, subject to the same
membership/assignment/assurance checks before Workspace issues a Bot identity.

The provider issuer is the public origin plus `/v1/api/auth`; discovery is under
`/.well-known/openid-configuration` relative to that issuer. Bot's exact callback
is its public origin plus `/v1/auth/sso/callback`. Keep agent OAuth separate.
Private transport must preserve public hostname/certificate validation.

## Optional unattended administrator

Set `HELIX_BOOTSTRAP_ADMIN_ENABLED=true`, explicit
`HELIX_BOOTSTRAP_ADMIN_EMAIL` and optional `HELIX_BOOTSTRAP_ADMIN_NAME` on a fresh
installation. Existing installations ignore changed bootstrap identities/files.
Manual owner setup remains available with bootstrap disabled.

Compose can use `docker-compose.bootstrap.yml` in addition to the normal manifest.
Create its private host directory (default `secrets/bootstrap-admin`) as the app
UID/GID 10001, mode 0700. A supplied password file must be app-owned mode 0600
or a supported read-only projected Secret. Mount it in that directory and set
`HELIX_BOOTSTRAP_ADMIN_PASSWORD_FILE` to its container path. Do not store plaintext
passwords in `.env`, Helm values, ConfigMaps or images.

Without a supplied file, Workspace creates `bootstrap-admin.password` once in
its persistent `/var/lib/helix/bootstrap` directory. Generated passwords require
changing after sign-in before normal use. Retrieve only through authorized host
access. The production API image is distroless: use Node's filesystem API rather
than assuming an interactive shell or `cat` is installed:

```sh
docker compose exec helix /nodejs/bin/node -e \
  'process.stdout.write(require("node:fs").readFileSync("/var/lib/helix/bootstrap/bootstrap-admin.password","utf8"))'
```

Helm uses `bootstrapAdmin.enabled`, `.email`, `.displayName` and optional
`.existingSecret.name`/`.passwordKey`. Supplied Secrets need no API RBAC.
Generated mode keeps a retained bootstrap PVC. Its default ReadWriteMany access
mode needs a compatible storage class; set a suitable single-replica topology
otherwise. Back up the private recovery material. Changing values or re-rendering
Helm never generates a new password. A lost file after initialization requires
normal account recovery, not bootstrap reuse.

## Directory status and outages

Workspace reconciles every 15 seconds. Bot accepts bounded directory authority
for at most 45 seconds from its fresh challenge. It requires a new checkpoint
after restart. Once that bound expires, managed users and affected owner-derived
background work fail closed; local recovery and unconnected teams remain usable.
Inspect the application's last-sync/error status in Workspace Admin and Bot's
family panel. Check HTTPS reachability, host clocks, registered origins and
protected credentials before retrying. Never bypass this by adding local passwords
to managed users or increasing source revisions by hand.

Removing assignment or organization membership removes app access and derived
grants. Reactivation needs a new explicit assignment and sign-in; old paused bots,
sessions, revoked credentials and grants do not resume automatically. Local
managed-member changes are rejected by Bot and link back to Workspace.

## Credentials, disconnect and recovery

Rotate OIDC, provisioning or enrollment credentials independently in Family
applications. A sealed pending rotation is durable and retried by the directory
worker after a lost response. Retry that operation rather than starting a different
one. The previous credential retires after acknowledgement; per-bot keys remain
separate. Keep signing-key overlap enabled for already-issued tokens.

Disconnect disables the human client and enrollment authority, retires managed
access and retries peer cleanup. It leaves separate local recovery accounts and
data intact. It does not convert managed users into password accounts.

Recovery needs matching image/schema versions, PostgreSQL, app encryption keys,
private files and object storage, configuration and bootstrap PVC. Encrypted
provider signing keys, pairing receipts, assignments and outbox state live in
Workspace's database; encryption keys remain separately protected. Follow the
[existing recovery runbook](backup-restore-recovery.md), including off-host copies.
Do not restore a database and assume its old authority is current. A source
checkpoint behind Bot's accepted revision fails closed and requires reviewed
re-pairing. Restoring both peers together still needs post-backup revocations
reconciled from retained evidence before managed access opens.

## Evidence and limits

The reproducible joined fixture in Bot's `tests/family/run-joined.mjs` uses actual
source HTTP applications, maintained OAuth/JWKS and two disposable PostgreSQL
instances over verified TLS. It covers lost pairing/rotation responses, two
humans/two bots, roles/groups, tenant isolation, restart, a measured outage,
offboarding/readmission, rollback denial and re-pairing. This is not a hosted
pilot, live external-IdP MFA journey, cross-host deployment or full production
container recovery qualification. Live Kubernetes testing remains deferred.

## Optional operations management

Backup policy, status, approvals and recovery-set enrollment are separate from
identity pairing. Follow the [family backup runbook](app-family-backups.md) to
provision independent operator capabilities and retain app-local recovery.
