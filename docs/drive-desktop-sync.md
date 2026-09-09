# Helix Drive desktop sync

Keep a folder (or virtual drive) on your computer in sync with Helix Drive.

You do **not** need to learn rclone. Run the setup script and answer a few prompts.

## Setup (easy path)

### 1. Install Node.js and rclone once

- **Node.js 20+**: https://nodejs.org/
- **rclone** (open source):

| OS      | One-liner                                         |
| ------- | ------------------------------------------------- |
| macOS   | `brew install rclone`                             |
| Windows | `winget install Rclone.Rclone`                    |
| Linux   | `curl https://rclone.org/install.sh \| sudo bash` |

### 2. Create an App password in Helix

In Helix: **Admin → Apps & integrations → App passwords**  
Create a password with **WebDAV / Drive** access. Use this password in setup—not your login password.

### 3. Run setup

From a machine that can reach your Helix server:

```sh
# From the Helix workspace repo:
pnpm helix:drive-sync

# Or:
node scripts/helix-drive-sync-setup.mjs
```

The script asks for:

1. **Server URL** — e.g. `https://helix.company.com`
2. **Email** — your Helix account
3. **App password**
4. **Mode**
   - **1) Mirror folder** (recommended) — normal folder that stays in sync
   - **2) Virtual drive** — mount like a network drive
5. **Local path** — default `~/HelixDrive` or `~/HelixMount` (Windows mount default `X:`)

It then configures the connection, tests it, and runs the first sync (mirror) or tells you how to start the mount.

### 4. Day-to-day

Helpers are written to `~/.helix/drive-sync/` (Windows: `%USERPROFILE%\.helix\drive-sync\`):

| Mode   | Command                                                         |
| ------ | --------------------------------------------------------------- |
| Mirror | `~/.helix/drive-sync/sync-now.sh` (or `sync-now.cmd`)           |
| Mount  | `~/.helix/drive-sync/mount.sh` (or `mount.cmd`) — leave running |
| Status | `~/.helix/drive-sync/status.sh`                                 |

Schedule **sync-now** every few minutes (Task Scheduler / cron / launchd) if you want continuous mirror updates.

## Modes (what to pick)

|                | Mirror folder               | Virtual drive                            |
| -------------- | --------------------------- | ---------------------------------------- |
| Feels like     | Google Drive’s local folder | Network drive letter / mount             |
| Offline edits  | Yes (in the folder)         | Depends on cache                         |
| Extra software | None                        | WinFsp (Windows), macFUSE/FUSE-T (macOS) |
| Best for       | Most people                 | “Always live on the server” workflows    |

## Security

- App passwords only; revoke anytime in Admin
- Prefer **HTTPS** for the server URL
- Password is stored in rclone’s local config (machine-local), not in git

## Troubleshooting

| Symptom                    | Fix                                                                 |
| -------------------------- | ------------------------------------------------------------------- |
| `rclone is required`       | Install rclone (table above), re-run setup                          |
| Connection test fails      | Check URL, email, app password scopes, TLS                          |
| Mount fails on Mac/Windows | Install FUSE / WinFsp, then run the mount helper                    |
| Mirror conflicts           | rclone keeps both copies; check the folder for conflict-named files |

Re-run `pnpm helix:drive-sync` anytime to reconfigure.

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

## Advanced

Power users can use raw rclone against the same WebDAV endpoint (`/dav/files/`).  
The setup script is the supported path for everyone else.

## Phase B (later)

A small tray app will wrap the same flow (endpoint, app password, mirror vs mount) without a terminal.
