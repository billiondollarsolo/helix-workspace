# Helix Drive desktop sync

Keep a folder (or virtual drive) on your computer in sync with Helix Drive.

You do **not** need to learn rclone. Run the setup script and answer a few prompts.

## Setup (easy path)

### 1. Install Node.js and rclone once

- **Node.js 24** (the version in the repo's `package.json` `engines`): https://nodejs.org/
- **rclone 1.66 or newer** (open source). Two-way sync needs 1.66+; setup checks the version and
  stops with an upgrade hint if yours is older. Linux distribution packages are often too old, so
  use the official installer:

| OS      | One-liner                                                   |
| ------- | ----------------------------------------------------------- |
| macOS   | `brew install rclone`                                       |
| Windows | `winget install Rclone.Rclone`                              |
| Linux   | `sudo -v ; curl https://rclone.org/install.sh \| sudo bash` |

### 2. Get an app password from your admin

App passwords are issued by a Helix admin; you cannot create one yourself. Ask your admin for a
**desktop sync** app password and use it in setup, not your login password.

For admins: **Admin → Apps & integrations → App passwords**, pick the user, click the
**Desktop sync (WebDAV)** preset (it sets `drive.read drive.write drive.delete`), and create the
password. Hand the one-time password to the user over a secure channel. Without `drive.write` or
`drive.delete`, uploads or deletes fail with **403** and a message naming the missing scope.

### 3. Run setup

From a machine that can reach your Helix server:

```sh
# From the Helix workspace repo:
pnpm helix:drive-sync

# Or:
node scripts/helix-drive-sync-setup.mjs          # --help lists every option
```

The script asks for:

1. **Server URL** — e.g. `https://helix.company.com` (must be `https://`)
2. **Email** — your Helix account
3. **App password** — typing is hidden
4. **Mode**
   - **1) Mirror folder** (recommended) — normal folder updated each time the sync helper runs
   - **2) Virtual drive** — mount like a network drive
5. **Local path** — default `~/HelixDrive` or `~/HelixMount` (Windows mount default `X:`). `~` is
   expanded and relative paths are made absolute. Setup refuses `/`, your home folder itself, and
   the Helix repository folder.

It then writes a dedicated rclone config, checks that it can list, create, and delete (using a
temporary `.helix-sync-check-…` folder, which ends up in your Drive trash), and runs the first sync
(mirror) or tells you how to start the mount. The working config is only replaced after these checks, any required confirmation, and a
successful initial sync. Cancelling a server/account/folder change preserves the previous config
and sync state.

### 4. Day-to-day

Everything is written to `~/.helix/drive-sync/` (Windows: `%USERPROFILE%\.helix\drive-sync\`):

| File                           | Purpose                                               |
| ------------------------------ | ----------------------------------------------------- |
| `sync-now.sh` / `sync-now.cmd` | Mirror: run one two-way sync                          |
| `mount.sh` / `mount.cmd`       | Mount: start the virtual drive — leave running        |
| `status.sh` / `status.cmd`     | List top-level folders on the server                  |
| `rclone.conf` (mode 0600)      | Connection settings; password stored rclone-obscured  |
| `config.json`                  | What setup configured (server, account, folder, mode) |
| `bisync/` or `bisync-…/`       | Two-way sync state (listings of both sides)           |

Mirror mode runs once; setup does not install a background service. Run **sync-now** manually,
or schedule it every few minutes with Task Scheduler / cron / launchd. Do not run overlapping
copies. The helper reports connection and sync errors through its exit code.

Sync compares file contents, including edits that leave the size unchanged. Plain WebDAV
does not supply a checksum rclone can use, so this downloads files to compute hashes on each
run. This is reliable but can use substantial bandwidth for large mirrors. Interrupted runs
use rclone recovery; unrecoverable errors stop rather than silently rebuilding the baseline.
Conflicts keep both versions with conflict suffixes; resolve them deliberately.

### Re-running setup

Re-run `pnpm helix:drive-sync` anytime to change the password or settings. Re-runs **never resync
on their own**:

- Same server, account, and folder, with sync state present → a normal two-way sync.
- First setup → an initial `--resync` to build the baseline. If the folder is not empty you are
  warned first.
- Upgrading an older size/modtime baseline to content checking also requires an explicit resync.
- Different server, account, or folder, or missing sync state → setup stops and asks. A resync can
  bring back files that were deleted on one side, so it only runs after an interactive "yes",
  `--resync`, or `HELIX_SYNC_RESYNC=1`.

## File size limit

WebDAV uploads are capped by the server's `HELIX_DRIVE_AV_MAX_FILE_BYTES` (default **128 MiB**).
Setup passes `--max-size 128M` to rclone so larger files are skipped instead of failing over and
over. If your admin changed the server limit, set `HELIX_SYNC_MAX_SIZE` (e.g. `512M`) before
running setup. Reverse proxies can impose a lower request limit. For this Cloudflare-proxied
development deployment, use `HELIX_SYNC_MAX_SIZE=95M` for headroom. Larger files need an
admin-reviewed limit and upload path; the web app does not bypass antivirus limits.

## Modes (what to pick)

|                | Mirror folder               | Virtual drive                            |
| -------------- | --------------------------- | ---------------------------------------- |
| Feels like     | Google Drive’s local folder | Network drive letter / mount             |
| Offline edits  | Yes (in the folder)         | Depends on cache                         |
| Extra software | None                        | WinFsp (Windows), macFUSE/FUSE-T (macOS) |
| Best for       | Most people                 | “Always live on the server” workflows    |

Files that are still being scanned for malware, or that were quarantined, are not listed over
WebDAV; they appear once they are available.

## Security

- App passwords only; your admin can revoke them anytime in Admin
- HTTPS only. Plain `http://` is refused unless you pass `--insecure` (or `HELIX_SYNC_INSECURE=1`)
  for a local test server
- The password is never passed on the command line: setup hands it to `rclone obscure -` on stdin
  and stores only the obscured form in `~/.helix/drive-sync/rclone.conf` (machine-local, mode 0600),
  never in git

## Troubleshooting

| Symptom                       | Fix                                                                     |
| ----------------------------- | ----------------------------------------------------------------------- |
| `rclone is required`          | Install rclone (table above), re-run setup                              |
| `rclone … is too old`         | Upgrade to 1.66+ with the official installer                            |
| 401 — email or password       | Check both; the app password may be revoked or expired                  |
| 403 — missing `drive.…` scope | Ask your admin for a password with the **Desktop sync (WebDAV)** preset |
| 404 — no WebDAV endpoint      | Enter the base server URL; setup adds `/v1/dav/files/`                  |
| 426 — HTTPS required          | Use the `https://` address                                              |
| 429 — too many attempts       | Wait a minute; see the admin note below if many users share one IP      |
| Re-run says "Not resyncing"   | Intended; re-run with `--resync` if you want to rebuild the baseline    |
| Mount fails on Mac/Windows    | Install FUSE / WinFsp, then run the mount helper                        |
| Mirror conflicts              | rclone keeps both copies; check the folder for conflict-named files     |

## Admin notes

- WebDAV rate limits: failed logins are limited to 20 per minute per client IP; authenticated
  requests are limited per user (600 per minute, of which 120 may be writes or deletes), so many
  people behind one office IP can sync at once.
- The per-IP limit uses the client address Helix sees. Behind a reverse proxy or load balancer, set
  `HELIX_TRUSTED_PROXIES` to the proxy addresses or CIDRs (for example
  `HELIX_TRUSTED_PROXIES=10.0.0.0/8`) so Helix uses the forwarded client IP. Otherwise every user
  shares the proxy's address, and one user's failed logins can lock out the others for a minute.
- Reverse proxies must preserve strong DAV ETags; disable response compression for `/v1/dav/*`
  (and legacy `/dav/*`). Otherwise a valid conditional edit can fail with 412.
- Cloudflare: bypass caching for the workspace hostname and `/v1/*`; browser-oriented security
  rules must also allow your authenticated sync clients.
- The upload limit is `HELIX_DRIVE_AV_MAX_FILE_BYTES`; tell users if you change it so they can set
  `HELIX_SYNC_MAX_SIZE`.

## Automation (optional)

```sh
HELIX_SYNC_URL=https://helix.example.com \
HELIX_SYNC_USER=you@example.com \
HELIX_SYNC_PASSWORD='app-password-here' \
HELIX_SYNC_MODE=mirror \
HELIX_SYNC_PATH=$HOME/HelixDrive \
HELIX_SYNC_YES=1 \
node scripts/helix-drive-sync-setup.mjs
```

`HELIX_SYNC_YES=1` answers prompts for you but does **not** approve a resync on a re-run; add
`HELIX_SYNC_RESYNC=1` only when you mean it.

## Advanced

Power users can use raw rclone against the same WebDAV endpoint:
`https://<your-helix-host>/v1/dav/files/` (vendor `other`, your email, and an app password). To
reuse the setup's connection, pass `--config ~/.helix/drive-sync/rclone.conf` and the remote
`helix:`. The setup script is the supported path for everyone else.

## Phase B (later)

A small tray app will wrap the same flow (endpoint, app password, mirror vs mount) without a terminal.
