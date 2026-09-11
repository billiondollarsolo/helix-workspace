# Helix Drive desktop sync

Keep a folder (or virtual drive) on your computer in sync with Helix Drive.

You do **not** need Node, pnpm, or rclone knowledge. The installer downloads a local rclone binary and the `helix-sync` command.

## Setup

### 1. Create an app password in Helix

**Settings → Security → App passwords** (or Admin → Apps & integrations).  
Give it **WebDAV / Drive** access. Use this password in setup — not your login password.

### 2. Install Helix Sync on this computer

From the Drive sidebar (**Desktop sync**), copy the command for your OS. It is served by _your_ Helix server:

**macOS / Linux**

```sh
curl -fsSL https://YOUR-HELIX/v1/drive/sync/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://YOUR-HELIX/v1/drive/sync/install.ps1 | iex
```

Or download the installer from that dialog (macOS/Linux `.sh`, Windows `.ps1`).

From GitHub instead of a running Helix server:

```sh
curl -fsSL https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync/install.ps1 | iex
```

The installer puts binaries in `~/.helix/drive-sync/bin` (Windows: `%LOCALAPPDATA%\Helix\drive-sync\bin`) and adds `helix-sync` to your PATH when it can. No sudo.

### 3. Run setup

```sh
helix-sync
```

It asks for:

1. **Server URL** — e.g. `https://helix.company.com` (pre-filled when you installed from that server)
2. **Email** — your Helix account
3. **App password**
4. **Mode**
   - **1) Mirror folder** (recommended) — normal folder that stays in sync
   - **2) Virtual drive** — mount like a network drive
5. **Local path** — default `~/HelixDrive` or `~/HelixMount` (Windows mount default `X:`)

### 4. Day-to-day

Helpers land next to the install:

| Mode   | Command                                                         |
| ------ | --------------------------------------------------------------- |
| Mirror | `~/.helix/drive-sync/sync-now.sh` (or `sync-now.cmd`)           |
| Mount  | `~/.helix/drive-sync/mount.sh` (or `mount.cmd`) — leave running |

Schedule **sync-now** every few minutes (Task Scheduler / cron / launchd) if you want continuous mirror updates.

## Modes

|                | Mirror folder               | Virtual drive                            |
| -------------- | --------------------------- | ---------------------------------------- |
| Feels like     | Google Drive’s local folder | Network drive letter / mount             |
| Offline edits  | Yes (in the folder)         | Depends on cache                         |
| Extra software | None                        | WinFsp (Windows), macFUSE/FUSE-T (macOS) |
| Best for       | Most people                 | “Always live on the server” workflows    |

## Security

- App passwords only; revoke anytime in Helix
- Prefer **HTTPS** for the server URL
- rclone stores the password in its machine-local config, not in git

## Troubleshooting

| Symptom                         | Fix                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `helix-sync: command not found` | `export PATH="$HOME/.local/bin:$PATH"` or run `~/.helix/drive-sync/bin/helix-sync` |
| Connection test fails           | Check URL, email, app password scopes, TLS                                         |
| Mount fails on Mac/Windows      | Install FUSE / WinFsp, then run the mount helper                                   |
| Mirror conflicts                | rclone keeps both copies; look for conflict-named files                            |

Re-run `helix-sync` anytime to reconfigure.

## Automation

```sh
HELIX_SYNC_URL=https://helix.example.com \
HELIX_SYNC_USER=you@example.com \
HELIX_SYNC_PASSWORD='app-password-here' \
HELIX_SYNC_MODE=mirror \
HELIX_SYNC_PATH=$HOME/HelixDrive \
helix-sync
```

## Developers (this repo)

From a Helix checkout you can still run `pnpm helix:drive-sync`, which is the same setup script. End users should use the curl/irm installers above.

## Advanced

Power users can point raw rclone at `/dav/files/` with an app password. The `helix-sync` command is the supported path for everyone else.
