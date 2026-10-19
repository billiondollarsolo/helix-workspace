# Hosted federation deployment and recovery enrollment

## Federated app management qualification — 2026-10-19

Workspace API and web `6bfbf55` are hosted and native ready. Bot runtime remains
`92b5ae9`; schemas remain 251 / 13. Recovery workers retain their existing
`eddec8b` binaries and federation protocol. The change adds no schema, configuration
authority, credential rotation or general policy propagation.

Federated apps now offers on-demand app details: installation and app-tenancy
bindings, a link to the app, directory verification recency, pending directory
changes and pending credential delivery. Separately authorized backup observations
are joined by application ID, not matching origin. The view distinguishes an
unenrolled worker, disabled backup management, permission/transport failure, stale
observations and detached targets. A failed refresh cannot present cached health
as current. It shows the last acknowledged worker policy separately from the desired
Workspace revision and pending delivery, and identifies an external scheduler's
authority. Reported capabilities, restore enrollment, coverage, alerts and the last
completed artifact's verification/restore evidence remain observations, not new
operation permissions or proof of a currently running app version.

The existing assignments projection now includes names and email addresses for
active assigned people in the requesting organization. App-admin authorization and
identity-generation filtering remain enforced; disabled people are excluded.
Assigned people outside the directory's first 50 results are visible and editable.
Searching for additional people still uses separately authorized directory access.
Refresh, collapsing the section and failed saves preserve drafts; clean drafts
follow refreshed assignments. Retrying the same failed search makes a new request.
Federation query factories use the shared admin defaults so permission and network
errors retain inline errors and Retry controls under the production error default.
App assignment still grants no Bot ownership or Mail, Chat, Drive or private Work access.

Workspace format, types, lint, full tests, build and boundaries passed: 4,034 backend
and 1,450 web tests, with 448 fixture-gated backend skips. The final query/search
follow-ups passed focused lint, types and all seven ownership/management/backup UI
tests, including the production query-error default. Two complete PostgreSQL/HTTP
fixtures passed on a fresh, disposable migrated database, covering scoped app-admin
labels, member/agent denial, cross-organization isolation, disabled-person filtering,
OIDC/PKCE, backup bindings, lost replies and recovery approvals. Five source and five
built browser/accessibility cases passed at desktop and 390px, including capability
failure/retry, pending versus acknowledged policy, app binding, assignment draft
retention and the existing backup enrollment/navigation flows. No lint or accessibility
rule was disabled. Bot's runtime source did not change; its full suite was not repeated.

Hosted and native readiness pass. The directory regained fresh authority, both
independent recovery workers and the private federation network remain intact,
and native providers/executor/Claude remain ready. Hosted providers remain ready;
its executor remains unconfigured. Anonymous app-management requests are denied
with 403; recovery status requests are denied with 401. At rollout, Workspace
Preview required normal verification; the completed live follow-up is recorded
below. No paid model request was made.

The pre-change native and hosted encrypted deployment checkpoints authenticated.
The final hosted checkpoint also authenticated off-server:
`hosted-after-app-management.tar.gz.age`, SHA-256
`2c9a9dd07e9af0e2b5a243872b3e105c7e09195ae674b38c0a795849428d1c01`.
These are online logical databases plus deployment/configuration, application keys
and source bundles. Existing private/object artifacts and independent operator
runtime/key/journal custody still require the previously preserved full snapshots
and operator checkpoint. No new checkpoint was restored or reboot-qualified.
Private scripts, logs and receipts are under
`~/.local/share/helix-recovery/20261019/app-management/` on the backup machine.

Assignment saves retain the existing whole-list replacement API. Unsaved drafts
survive refresh, but simultaneous editors are not conflict-checked; use one editor
at a time. Revision checks are required before supporting concurrent editing.
General shared-policy enforcement, additional app implementations, native AI product
acceptance and reviewed production restore remain separate work.

### Authenticated live admin review — 2026-10-19

The owner completed Workspace's normal verification. Read-only review of the hosted
page passed at 1280px and 390px: the governing organization loaded, the directory
was recently verified, the assigned Admin role was visible, and the app's bound
backup worker showed acknowledged policy revision 0 with no pending delivery.
External scheduling, backup/verify capabilities and unenrolled restore were
identified correctly. App, backup-status and assignment refreshes completed without
inline errors. Both widths had zero horizontal overflow; the mobile menu was
available. No role, credential, policy or recovery operation was submitted.

The worker reports `backup_stale` and `restore_drill_missing` for its managed
artifact history. Its displayed artifact version is explicitly historical. This
does not replace the separate authenticated deployment-checkpoint evidence above;
the latest checkpoint still has not been restored. The live review is complete;
assignment conflict protection and the checkpoint restore test remain pending.
Private receipt and screenshot references: `app-management/live-admin-review.json`
under the October 19 recovery directory. This follow-up covers Workspace's admin
view; it does not repeat Bot's human SSO or a paid model call.

## Setting ownership qualification — 2026-10-19

Workspace web `6e44cc5` and Bot `92b5ae9` are hosted and native ready. Workspace API
remains `eddec8b`; schemas remain 251 / 13. This Stage 3 change shows current
ownership and effective values using existing contracts; it adds no generalized
Workspace policy propagation. The [setting inventory](../architecture/helix-federation-management.md#setting-ownership-inventory)
records the inherited and local fields.

Managed people and Single sign-on show Workspace as their source and link to its
existing Federated apps editor. Links require the person's own Workspace session
and permissions; Bot roles do not grant Workspace administration. Member-only
views show the source without an administrator link. Managed sign-in shows the
provider, issuer, enabled state, assigned role range and local-owner login policy.
Managed editors remain read-only. Unavailable connection data offers retry without
declaring local authority, and synchronization errors retain the Workspace source.

Bot's password, recovery and MFA editors are offered to local password accounts;
SSO-only users see provider ownership. The required-MFA count now excludes SSO-only
identities. Existing backend member/SSO write fences and owner-only pairing and
disconnect remain in force. Workspace's app card identifies its assigned-person
roles, profiles, groups and sign-in authority, and distinguishes Bot's local
recovery, credentials, bots, Work and grants. App assignment grants no Mail, Chat
or Drive access.

Workspace format, types, lint, full tests, build and boundaries passed: 4,034 backend
and 1,446 web tests, with 448 fixture-gated backend skips. Three browser/accessibility
cases passed, including the active app card at desktop and 390px and the existing
backup enrollment flow. Bot's full `pnpm check` passed: 820 tests, one optional skip,
plus static/types, Effect/driver contracts, Pi recovery, portability, build and
compatibility reporting. Its complete image/PDF and background fixtures passed.
Fifteen focused PostgreSQL/SSO/permission cases and two frontend self-checks passed.
The source browser run passed 19 cases with three intentional mobile SSO skips;
the built run passed 13 with one intentional mobile performance skip. These cover
standalone and managed settings, SSO-only accounts, member denial, failure/retry,
keyboard scrolling, accessibility and the unchanged production JavaScript budget.
The read-only settings scroll region is named and keyboard-focusable.

The hosted directory regained fresh authority, both recovery workers and the
private federation network remain intact, and unauthenticated recovery status is
denied. Native providers/executor and the separate Claude service remain ready;
hosted providers remain ready and its executor remains unconfigured. The existing
Preview sessions now require normal Workspace verification, including Bot SSO.
Authenticated live visual review remains pending; no verification gate was bypassed.

Encrypted online logical/configuration checkpoints authenticated before each
rollout. The final hosted checkpoint also authenticated off-server:
`hosted-after-ownership.tar.gz.age`, SHA-256
`7b4d7e17c90586d0cafa3e2fcd2bb373030143105f5c5045631ead6133328da9`.
It includes current database dumps, deployment/configuration, keys and source
bundles. Existing private/object artifacts remain covered by the earlier full
snapshots. This new checkpoint was not restored. Private scripts, logs and receipts
are under `~/.local/share/helix-recovery/20261019/setting-ownership/` on the backup
machine. Fresh human SSO/MFA completion, paid model calls, host reboot and a coverage
sweep were not repeated. Broader app management is Stage 4.

## Greenfield terminology cutover — 2026-10-19

Hosted Workspace API/web now run `eddec8b`; Bot runs `c88124d`. Native checkouts
include the same changes, plus Workspace's deployment-test correction `0af0954`.
The schemas still contain 251 Workspace migrations and 13 Bot migrations.
The integration uses federation names throughout code, routes, configuration,
database objects, credential bindings and recovery protocols. Old routes return
404; there are no aliases, redirects, dual settings or runtime compatibility code.

Both apps were stopped behind temporary maintenance responses for the hosted
conversion. Encrypted cold database dumps and matching configuration, keys and
source bundles were authenticated off-server first. One-time operator transactions
renamed database objects and migration records and rewrapped the existing encrypted
credentials under their new contexts. No migration was replayed. Fresh-schema
fingerprints match Bot's converted database. Enrollment metadata, the saved pairing
code prefix and the managed SCIM-token label were converted once too. Opaque OAuth
client IDs and historical audit/recovery records retain their original values.

Original users, bots, Work, model providers, vault secrets, memberships and account
drafts were compared. Their authority and content remain intact; normal credential
use timestamps advanced after restart. The existing hosted directory connection
regained fresh authority before maintenance ended. Both public readiness checks
pass, and native Bot still reports providers and executor ready. The separate
local Claude service and executor configuration were retained.

The private shared network is now `helix-federation`. Its gateway, firewall bridge
and three participating containers were preserved. Independent workers use
`helix.federation.backup.v1` at `/v1/federation-operations/*`, with their existing
bindings, management capabilities and journals. Both workers completed verification
of an existing encrypted archive through the new route and command environment.
Archive/key contents were preserved while their enclosing names and operator paths
were converted. The off-server custodian timer was updated and re-enabled.

Qualification: Workspace format, types, lint, full tests, build and boundaries
passed (4,034 backend and 1,445 web tests; 447 backend fixture-dependent skips).
Bot static/types, contract, Pi recovery, portability and build checks passed.
Its full run recorded 815 passes, one optional skip and a parent/child failure from
one PDF fixture's database-pool timeout. That complete fixture passed separately
(three tests); the full suite was not repeated. The joined TLS proof passed pairing,
lost acknowledgements, three credential rotations, directory roles/groups,
restart/outage denial, offboarding, rollback denial, re-pairing and local recovery.
The real encrypted backup/isolated-restore fixture passed. Workspace's seven
focused browser/accessibility checks and Bot's three SSO browser checks passed;
Bot's three mobile cases are intentionally skipped by that suite.

The native encrypted checkpoint authenticated. Its Bot database restored in
isolation and selected original application rows matched both live databases.
Native Workspace's original isolated restore stopped at a foreign-key constraint:
five pre-existing app-password rows referred to missing actors. That historical
checkpoint remains unqualified; the repair and fresh successful restore are
recorded below. Hosted
Workspace's cold dump restored successfully for exact comparison. Existing older
hosted physical-restore evidence below remains separate from this conversion.

Private scripts, receipts and encrypted checkpoints are under
`~/.local/share/helix-recovery/20261019/federation-clean-rename/` on the backup
machine. A rollback requires the matching old database, configuration, worker and
source checkpoint together; starting old code against the renamed schema is not
supported. Fresh human SSO/MFA sign-in, paid model calls, host reboot and Kubernetes
were not repeated for this naming cutover. The management-layout follow-up is recorded below.

## Management layout qualification — 2026-10-19

Workspace web `ae2a735` and Bot `78402c0` align Administration and Personal settings,
app/organization context and the common navigation groups. Workspace apps is the
built-in module destination; Federated apps and Federated backups have their own
Federation group. Bot's dedicated Federation page shows its governing Workspace,
with administrator status visibility and separately authorized local recovery-owner
mutations. Existing routes, app controls and private resource grants remain intact.

Workspace format, types, lint, full tests, build and boundaries passed: 4,034 backend
and 1,445 web tests; 448 fixture-dependent backend skips. The new cleanup regression
also ran separately against restored PostgreSQL. Nine focused Workspace browser/
accessibility cases passed, including desktop/mobile navigation and the dashboard
fixture, member denial and mobile shell. Bot's source Settings/SSO/navigation run passed 23 cases with 19 intentional
mobile skips; its built Settings/navigation/performance run passed 21 cases with
17 intentional mobile skips. The production JavaScript budget was preserved by
loading the setup guide through the existing lazy settings helper.

The final Bot full check at `87c54c4` passed 818 tests with one optional skip,
plus static/types, Effect/driver contracts, Pi recovery, portability, build and
compatibility reporting. Its full image/PDF and background-reply fixtures passed.
An earlier concurrent run timed out in the background-reply test; both its isolated
and final full reruns passed without relaxing runtime timeouts or authorization.
The CSS-only scope-label follow-up `78402c0` passed static/build checks and five
built browser/accessibility/performance cases (one intentional mobile performance
skip); label bounds are now asserted at both widths.

These revisions are hosted and native ready. Workspace API stays `eddec8b`; its
container was refreshed only to report the new web image metadata. Schemas remain
Workspace 251 / Bot 13. The existing hosted directory regained fresh authority.
Live Bot desktop/390px checks confirm the governing Workspace, directory status,
mobile menu, readable scope labels and no horizontal overflow. Workspace's new
navigation assets loaded, but its saved Preview session reached the normal
“Confirm it’s you” gate; the live organization-label check remains behind that
verification. No new login or credentials were requested for this layout change.

Native providers/executor and the separate Claude service remain ready. Hosted
providers remain ready and its executor remains unconfigured. Recovery workers,
network boundaries, resource grants and provider credentials are retained;
unauthenticated recovery requests still return 401. Pre-change encrypted native
and hosted checkpoints authenticated. The final hosted online logical/configuration
checkpoint also authenticated off-server:
`hosted-after-management.tar.gz.age`, SHA-256
`3be458183b608fa64907707140f13ef6a60e9f92ecc2ede0dbcc1968ecb7a2b3`.
It captures current source bundles, configuration and keys; existing object/private
artifacts remain covered by the earlier full snapshots. This new checkpoint was
not restored. Fresh SSO/MFA, paid model calls, host reboot and a coverage sweep were
not repeated. Stages 3 and 4 remain in the federation standard.

## Native restore integrity repair — 2026-10-19

The fixture cleanup helper deleted actors without deleting their app passwords,
because those credentials have no organization column. It now deletes passwords
through the selected fixture actors before removing tenant rows. An integration
test against the isolated, restored native database verifies deletion and retention
of another tenant's credentials, including rejection of an empty tenant list.

The five actorless native credentials were archived under age encryption before
an exact-ID, still-orphaned guarded deletion. Seven derived rows referencing missing
organizations (four search-index mutations and three storage counters) were also
archived and removed. Valid app-password rows were unchanged. No human password
was reset. A fresh complete Workspace logical dump then restored in isolation with
all foreign keys and post-data constraints applied successfully.

Private repair/restore receipts and authenticated archives are under
`~/.local/share/helix-recovery/20261019/management-alignment/`. The successful dump is
`native-workspace-after-integrity-repair.pgdump.age`, SHA-256
`a333c0143eae6448eac230e59164646740e0fc60a4b484359915f823cac76567`.
This validates the repaired logical database; it does not replace object-storage,
physical-restore or host-reboot qualification.

## Original deployment — 2026-10-17

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
capabilities are private under `/srv/helix-data/federation-operations/`. Runtime code
is under `/opt/helix-recovery-eddec8b/`; privileged execution is outside the API
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
`~/.local/share/helix-workspace/89.167.14.138/bin/pull-federation-backups.py`; encrypted
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
