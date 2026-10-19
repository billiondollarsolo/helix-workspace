# Hosted federation deployment and recovery enrollment

Deployed on 2026-10-17 to `89.167.14.138`:

| Application | URL                              | Application source |
| ----------- | -------------------------------- | ------------------ |
| Workspace   | <https://workspace.helixapps.si> | `9400401`          |
| Bot         | <https://bot.helixapps.si>       | `623e698`          |

The original remote checkout and recovery commits remain intact. The new source
is under `/srv/helix/family-operations-20261017/`; Compose retains the existing
dependency images, private network, TLS and Workspace origin restrictions.
This deployment preserves the documented development hosting profile. It is not
an audited transition to production-mode security or promoted release artifacts.

The existing Workspace owner was used for Bot's separate local recovery account.
The operator generated a private initial password; the owner changed it before
pairing. No Workspace password was reset. Temporary operator sessions were retired.
Federation identity is enabled, the apps are paired, and their backup workers are
independently enrolled. Human assignments and bot resource grants remain explicit.

### Human sign-in checkpoint — 2026-10-19

The Workspace owner signs in as `mj@workspace.helixapps.si`. Bot's local recovery
owner uses the same email but has its own password and session. Pairing does not
copy passwords or adopt that local owner by email. The hosted Bot advertises
**Sign in with Helix Workspace**; Workspace is the identity provider. The owner
recovered Workspace access through a private, explicitly authorized reset page
and signed in normally. Their Bot administrator assignment is saved. Directory
synchronization exposed Bot's rejection of a matching local recovery email; the
qualified fix creates a separate managed identity bound to the immutable subject.
Deployment and the managed browser sign-in remain to be verified.

The Workspace owner already has a password but had no verified external recovery
email at this checkpoint. Password-reset delivery currently targets the sign-in
address, which is the owner's Workspace mailbox. Do not assume that email recovery
is usable while the owner cannot access that mailbox. The completed private reset
restored access, but an independently controlled external recovery method is still
unqualified.

## Operation and custody

Open **Workspace → Admin → Federated backups** for the two recovery targets.
Independent native operator services are `helix-workspace-recovery.service` and
`helix-bot-recovery.service`. Their fixed command/configuration, journals and
capabilities are private under `/srv/helix-data/family-operations/`. Runtime code
is under `/opt/helix-recovery-9400401/`; privileged execution is outside the API
containers. The workers bind only the private Docker bridge gateway; UFW admits
that bridge to ports 3081–3082. Caddy routes `/v1/federation-operations/*` at each
existing HTTPS hostname. No additional DNS entry or public worker port was added.

These targets use **external scheduling**. The existing Bot metadata schedule and
off-server whole-installation backup schedule remain in place; federation snapshots
can be requested manually. Policy scheduling has not silently moved to Workspace.
The obsolete first-team bootstrap timer is disabled after successful pairing.

The hosted operator command creates encrypted **cold snapshots**. It briefly
stops the relevant app's writers, captures its database/private volumes and
configuration, then restarts it with a recovery watchdog. Workspace snapshots also
capture object storage, its KMS material and TLS/deployment configuration. Caddy's
runtime admin-socket volume is deliberately excluded. Bot snapshots capture its
private state, PostgreSQL data, keys and deployment configuration. PostgreSQL
recovery requires the exact recorded database image/version. These are independent
app snapshots, not an atomic federation transaction.

Every archive has a manifest with per-file digests, installation binding, image
versions and a recovery boundary. The operator verifies age authentication and
all recorded file hashes. An independent custodian copies ciphertext to the
existing backup machine, independently verifies it, then acknowledges its exact
ciphertext and manifest digests. A worker marks `offHost` only after that acknowledgement.
Missing off-server custody leaves that receipt's `offHost` false; a recovery-set
export must then remain incomplete. Retention is at least 30 days; this activation
keeps existing copies and does not automatically delete old recovery material.

The off-server user service/timer is `helix-federation-backup-custodian`, polling each
minute. Its script is at
`~/.local/share/helix-workspace/89.167.14.138/bin/pull-family-backups.py`; encrypted
per-app artifacts are under that host directory's `federation-backups/`. Independent
age identities are in its private `keys/` directory. User lingering is enabled so
collection does not depend on an interactive login. This backup machine must stay
available; it is not an external managed object-storage service.

The existing encrypted whole-installation backup helper now includes the operator
runtime, worker configuration/journals and systemd units. Keep the separately
sealed operator checkpoint and the backup machine's original decryption identity
in independent custody. Never print keys or copy plaintext configuration into Git.

## Verification and recovery limits

The release was preceded by a fully authenticated encrypted off-server snapshot.
Both enrolled workers completed backup and follow-up verification jobs. Their
receipts report authenticated off-host custody; the exported recovery set is
complete, with two independent snapshots. Its canonical manifest digest was
verified separately on the backup machine. Streaming inspection of both copies
confirmed PostgreSQL 18 version files, control files and database relations;
Workspace object-storage and Bot private-state roots are included. The separately
encrypted operator checkpoint was authenticated and checked for both workers’
configuration, management/encryption keys and journals.
The initial Workspace socket rejection remains a failed operation rather than
being erased or replayed. The initial Bot archive omitted its separate PostgreSQL
volume; that receipt was explicitly invalidated and retained for inspection. A
corrected full snapshot contains the actual PostgreSQL volume and passed the
coverage checks above. Both public readiness endpoints returned 200; unauthenticated
worker status requests returned 401. These checks establish readiness and artifact
integrity, not successful restoration.

**Restore capabilities are not enrolled.** These hosted physical-volume snapshots
need a separate isolated restore drill and reviewed promotion procedure. They do
not use the logical-restore adapter. Do not enable an automatic restore command or
replace production volumes based only on a successful checksum verification.
Restore into matching isolated database/object volumes first, then reconcile
identity revisions/revocations before reopening managed access.

Live Kubernetes, host reboot and a full hosted restore have not been qualified by
this deployment. Keep the pre-change Compose/Caddy checkpoints and old images for
rollback; database rollback still requires its matching preserved schema/data.
See the [federation recovery runbook](app-federation-backups.md) for authority and unknown-job
handling, and the [existing host runbook](hetzner-workspace-prestage.md) for encrypted
mount and reboot recovery.

## Isolated recovery checkpoint — 2026-10-19

Off-server archives `8a801d2b-e9e0-4b89-85e6-2d7dda45b2c3` (Workspace) and
`d0fff34f-9be2-4dc9-8ef8-501330a30f54` (Bot), captured on 2026-10-17, were
authenticated, matched to their ciphertext/manifest receipts and checked against
every recorded file digest before extraction. Independent custody keys stayed
outside the repositories. Restored data uses separate disposable Docker volumes,
the recorded PostgreSQL images and exact application images `9400401`/`623e698`.
These are older snapshots, not backups of the subsequently connected model account.

Both complete applications reached readiness using their recovered databases,
keys and configuration. Workspace also recovered object storage and its KMS
material. A temporary session created only inside the isolated copy downloaded
an existing scanned owner file through the authenticated content route: 1,875,041
bytes matched the recorded SHA-256. The same unauthenticated request was denied.
The session was removed afterward. The paired application inventory was retained.

The project `helix-full-restore-20261019` publishes no ports and uses only internal
networks; no live data volumes are mounted. Outbound mail and SMTP receiving are
disabled. Rebuilt caches are separate from recovered authoritative state. Private
commands, manifests, logs and the generated isolation configuration are retained
under `~/.local/share/helix-recovery/20261019/integration-completion/restore/`.

This proves application startup and authenticated object recovery. It does not
qualify restored managed identities, later credential rotations/revocations,
current-schema upgrades, new-host ingress, host reboot or Kubernetes. Reconcile
current identity and credential authority before allowing a restored copy to
contact live peers. Hosted restore capabilities remain unenrolled; no restored
volume was promoted or substituted for live state.
