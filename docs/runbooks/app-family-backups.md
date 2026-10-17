# Optional family backup management

Workspace's **Admin → Family backups** manages independently enrolled recovery
workers for its own installation and paired Bot installations. Identity pairing
does not enroll recovery or grant access to backups. Only the default installation
organization's administrators can manage physical installation backups.

Each app still runs independently. Its operator owns the backup destination,
recovery keys, commands and local journal. Workspace sends policy revisions and
idempotent requests; it does not receive backup bytes, decryption keys, arbitrary
shell access, Docker sockets or Kubernetes administrator credentials.

## Install an operator worker

Build Workspace normally (`pnpm --filter @helix/app... build`). The same worker
can serve either application. Run it as a dedicated operator account with private
configuration files and a private state directory:

```sh
umask 077
openssl rand -hex 32 > /private/management.key
openssl rand -hex 32 > /private/restore.key
node apps/helix/dist/platform/backup/family-worker.js serve /private/worker.json
```

These are separate capabilities. Omit the restore key and command for backup-only
management. Protect the files as app-owned 0600 and directories as 0700. Projected
Kubernetes Secrets may instead be root-owned 0440 with the worker's group. Paths
must not traverse symlinks. Linux `flock` is required; one process owns each journal.

Example `worker.json` (replace UUIDs with the actual installation binding):

```json
{
  "binding": {
    "application": "bot",
    "installationId": "11111111-1111-4111-8111-111111111111",
    "tenantId": "22222222-2222-4222-8222-222222222222",
    "orgId": "33333333-3333-4333-8333-333333333333",
    "connectionId": "44444444-4444-4444-8444-444444444444"
  },
  "stateDirectory": "/var/lib/helix-backup-worker/state",
  "managementKeyFile": "/private/management.key",
  "restoreKeyFile": "/private/restore.key",
  "scheduler": "worker",
  "localSchedulerDisabled": true,
  "destinations": ["offsite"],
  "minimumRetentionDays": 30,
  "requiredCoverage": ["database", "files", "configuration"],
  "initialPolicy": {
    "revision": 0,
    "enabled": false,
    "intervalMinutes": 1440,
    "retentionDays": 30,
    "destinationRef": "offsite"
  },
  "commands": {
    "backup": [
      "node",
      "/opt/workspace/apps/helix/dist/platform/backup/family-backup-tool.js",
      "/private/tool.json"
    ],
    "verify": [
      "node",
      "/opt/workspace/apps/helix/dist/platform/backup/family-backup-tool.js",
      "/private/tool.json"
    ],
    "restore": [
      "node",
      "/opt/workspace/apps/helix/dist/platform/backup/family-backup-tool.js",
      "/private/tool.json"
    ]
  },
  "healthUrl": "http://127.0.0.1:43101/healthz"
}
```

For Workspace use application `workspace`, its actual org/installation IDs,
`connectionId: null`, and coverage `database`, `objects`, `configuration`. The
worker's status must exactly match the enrolled installation. Re-pairing does not
silently change an existing worker's binding; review and re-enroll separately.

Expose **only** `/v1/family-operations/*` at the app's existing HTTPS origin,
forwarding to the worker on port 3081. No new domain is required. Workspace's
Caddy configurations already route this prefix; set
`HELIX_BACKUP_WORKER_UPSTREAM` if the executor is elsewhere. For Bot add the same
prefix route to its existing edge, before its normal application route:

```caddyfile
handle /v1/family-operations/* {
    reverse_proxy backup-worker:3081
}
handle {
    reverse_proxy bot:43101
}
```

Native loopback workers default to HTTP on 127.0.0.1. Use worker TLS for direct
remote connections. Containers behind a trusted TLS edge need `host: "0.0.0.0"`
and explicit `privateHttp: true`; restrict worker traffic to that edge. Never
expose cleartext capability traffic to an untrusted network. Browser cookies are
rejected. Workspace uses its existing bounded HTTPS transport and rejects redirects.
Private addresses require the existing family private-network opt-in.

Enroll through Admin → Family backups with the independent management capability,
and optionally the independent restore capability. Workspace stores them encrypted
with its tenant envelope key. Enrollment acknowledges the current local policy;
then policy changes require consecutive revisions. Failed submissions preserve
drafts and operation IDs so a lost reply can be retried without replaying a backup.
Rotate keys locally and re-enroll the existing target ID after pending policies
have been delivered. Disconnect revokes enrolled keys at the worker and destroys
Workspace's encrypted copy after acknowledgement. The last schedule continues
under local ownership. Replacement keys are necessary to reconnect.

## Existing backup tools and destination custody

`family-backup-tool.js` is an optional fixed-command adapter to Bot's cold backup
CLI and Workspace's signed database/object backup and isolated restore scripts.
Its private `tool.json` declares `application`, absolute `repository`,
`workspaceRecoveryTools` (Workspace's `infra/scripts`), `appVersion`, and a
`destinations` map. Each destination declares a private `directory`,
`recipientsFile`, independent `identityFile`, nonsecret `keyCustodyRef`, and
`offHost` boolean. An optional `offHostUri` S3 prefix copies the encrypted bundle
using the operator's AWS credentials. No credentials or paths come from the UI.
For a mounted off-host destination, `offHost: true` is an operator assertion;
confirm the mount and external retention policy separately. Local fixtures must
use false. Keep age identities outside the archive and recoverable without Workspace.

Bot additionally requires `sourceDirectory`, `restoreDirectory` and an operator
`restoreDatabaseUrlFile`. PostgreSQL TLS defaults to `verify-full`; an optional
`postgresCaFile` supplies a private CA. `postgresTls: "off"` is for isolated local
test databases only. The adapter creates a **new** `helix_restore_*` database and
uses the cold restore's checks; it never drops or replaces a live database.

**Bot cold backups require a stopped app and its relevant writers.** Use a reviewed
local maintenance wrapper, or an existing qualified online/snapshot operator that
emits the protocol receipt. The worker does not stop production automatically.
Fixed `backupArgs` and `restoreArgs` may configure existing executor/coding recovery
options. Include every required private volume and independent recovery key in
the operator's recovery procedure; the minimal fixture excludes executor volumes.

Workspace additionally requires `configurationDirectory`: an explicit bundle of
JSON/YAML/TOML/conf deployment configuration. It uses `backupArgs`/`restoreArgs`
for the existing compose, signing and object-storage options. These scripts require
the existing operator toolchain and deployment permissions. Configuration is
inventoried before and after capture; links and special files are rejected.
Recovery secrets remain in separately documented custody. Database and immutable
object recovery points come from the existing backup manifest.

The adapter encrypts the complete bundle with age, inventories every file, records
ciphertext/manifest digests, and verifies both on restore. Retention pruning occurs
only after a successful backup and preserves each archive's original minimum
retention promise. External object lock/lifecycle rules remain authoritative.
Restores require matching application tools and version, a verified recorded
backup, and a distinct isolated database (plus a new `helix-restore-*` object bucket
for Workspace). They never switch live traffic or the active object bucket.

## Docker and Kubernetes

Optional overlays are `docker-compose.backup-worker.yml` in Workspace and
`deploy/compose/compose.backup-worker.yaml` in Bot. Supply the documented image
and private config directory variables. They publish no host port, use a read-only
root, drop capabilities, and persist the worker journal. Provision the state
volume for UID/GID 10001 before starting; keep the actual journal in its `state`
subdirectory. Mount operator-approved backup storage and required tooling explicitly.

Workspace's Dockerfile has a `backup-worker` build target with Node and flock.
It is a **base executor image**: derive a pinned operator tool image containing the
commands your configuration needs (age, tar, Python, PostgreSQL clients and existing
application recovery tools, as appropriate). The ordinary API image has no new
privileged tools or socket mounts. Native operator workers are supported too.

Both Helm charts offer disabled-by-default `backupWorker` values. Enabling requires
an image pinned by digest, an existing private Secret and explicit NetworkPolicy
ingress/egress. The retained ReadWriteOncePod journal PVC, single Recreate replica,
non-root/read-only container and absent service-account token prevent accidental
concurrent journal ownership or implicit cluster authority. The Secret contains
`worker.json`, management key, optional restore key and configured `extraSecretKeys`.
SubPath Secrets require a pod restart to rotate. Storage and operator tooling are
explicit installation choices. `extraVolumes`/`extraVolumeMounts` attach approved
snapshot or destination volumes. Do not attach a live ReadWriteOncePod app volume
to a second pod: use a maintenance handoff or operator-produced snapshot/export. Workspace's chart adds the same HTTPS ingress path;
Bot's existing external edge/Gateway must route the prefix to its worker Service.

There must be one schedule owner. Defaults preserve the existing schedules.
Before choosing worker scheduling, disable Bot's original scheduler with
`backup.scheduler: external` and stop any other cron/timer. Set
`localSchedulerDisabled: true` only after that handoff. Helm's
`backupWorker.ownsSchedule: true` enforces Bot's handoff and requires Workspace's
CNPG ScheduledBackup to be suspended. Keep ordinary CNPG/Barman scheduling when
using `scheduler: "external"` and `initialPolicy.enabled: false`; the UI then shows
status and manual operations without offering schedule edits. This release does
not rewrite CNPG schedules or claim a database-only Barman backup covers private
files, objects or configuration. Use an operator command that proves full coverage.

## Restore authority, outages and uncertainty

Restore uses a separate key and `admin.backups.restore` scope. Existing recent-MFA
policy applies; when configured, a different active administrator must approve.
Workspace rechecks requester/approver authority before queued dispatch. Queued
restores need a short renewable source-authority lease; an unavailable source
cannot start a previously queued restore after that lease expires. Already running
operations finish locally; revocation is not a remote process-kill mechanism.

Local backup schedules survive source outages and detach. Commands have bounded
timeouts and fixed arguments. Interrupted/timed-out running jobs become `unknown`
and block subsequent work; they are never automatically replayed. Inspect the
operator's actual processes and artifacts, confirm all old writers stopped, then:

```sh
node apps/helix/dist/platform/backup/family-worker.js resolve /private/worker.json JOB_UUID --confirmed-stopped
```

This resolves the journal entry as failed, without deleting artifacts or rerunning
anything. Use a fresh operation ID for a reviewed retry. Preserve the journal in
local recovery; it rejects another installation binding and contains at most
10,000 receipts. Archive it through a reviewed operator procedure before that
bound is reached. Workspace rollback behind an accepted worker policy fails
closed; inspect policy/revocation evidence before re-enrolling. Never reset the
journal just to bypass a rejected revision or revive revoked capabilities.

Recovery-set exports contain app bindings, versions, recovery points, key custody
references and artifact digests. A complete set requires this Workspace and every
active paired app to have fresh status and a recent, verified, off-host full backup.
These are **independent snapshots**, not an atomic cross-app transaction. A partial
set is explicitly incomplete. Promotion remains the existing reviewed operator
restore procedure, including reconciliation of family revisions/revocations before
opening access. Workspace downtime never prevents local recovery.
