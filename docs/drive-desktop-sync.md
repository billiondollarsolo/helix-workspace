# Helix Drive desktop sync (rclone-first)

Helix stores files in Drive and exposes them over **WebDAV** at `/dav/files/*`.
There is no first-party “Helix Sync” app yet. **Phase A** uses open-source
**[rclone](https://rclone.org/)** so Windows, macOS, and Linux users can sync
like Google Drive for desktop.

**Phase B** (later) will ship a thin branded tray app that wraps rclone.

## Security model (Phase A)

| Requirement | Approach |
|-------------|----------|
| Auth | **App passwords** only (not the account password) |
| Scopes | At least `webdav` and/or `drive.read` + `drive.write` (+ `drive.delete` if deletes should sync) |
| Transport | **HTTPS** to your Helix URL in production |
| Revocation | Admin → App passwords → revoke anytime |
| Audit | WebDAV writes/deletes go through the same Drive authz and audit path |

Create an app password in **Admin → Apps & integrations → App passwords**
(or the Helix CLI). Prefer a dedicated password for the desktop machine so you
can revoke one laptop without logging out of the browser.

## Choose a mode

Give the user the option:

### 1. Mirror folder (recommended for most people)

A normal folder on disk that **rclone bisync** keeps in two-way sync with Helix.

- Edit files in Word/Excel/local apps, then sync  
- Offline work lives in the folder  
- Conflicts: rclone keeps both copies (configure policy carefully)

### 2. Network / virtual drive (mount)

rclone **mount** presents Helix as a drive letter or FUSE path.

- Feels like a network share  
- Needs **WinFsp** (Windows) or **macFUSE / FUSE-T** (macOS)  
- Cache mode matters for Office “save” behavior (`--vfs-cache-mode full`)

Both modes use the **same** WebDAV remote; only the local presentation differs.

## Prerequisites

1. Helix reachable at `https://your-helix.example` (TLS in production).  
2. rclone installed: <https://rclone.org/install/>  
3. App password with WebDAV/Drive scopes.  
4. For **mount** on Windows: [WinFsp](https://winfsp.dev/). On macOS: macFUSE or FUSE-T.

## Configure the remote once

```sh
rclone config
```

Interactive values:

| Prompt | Value |
|--------|--------|
| `n` new remote | e.g. `helix` |
| Storage | `webdav` |
| URL | `https://your-helix.example/dav/files/` |
| Vendor | `other` |
| User | your Helix login email (e.g. `you@company.com`) |
| Password | **app password** (y → paste) |
| Bearer token | leave empty |

Test:

```sh
rclone lsd helix:
rclone ls helix: --max-depth 2
```

## Mode A — Mirror folder

```sh
# First-time: make local root and pull (or push) carefully
mkdir -p ~/HelixDrive
rclone bisync ~/HelixDrive helix: --create-empty-src-dirs --resync
```

Ongoing (cron, Task Scheduler, or a loop):

```sh
rclone bisync ~/HelixDrive helix: --create-empty-src-dirs
```

Notes:

- Always run `--resync` only when both sides are trusted (initial setup or recovery).  
- Prefer excluding temporary Office files if needed (`--exclude` patterns).  
- Document conflict recovery for operators: check rclone logs; rename conflict copies.

## Mode B — Mount (virtual drive)

**Linux / macOS:**

```sh
mkdir -p ~/HelixMount
rclone mount helix: ~/HelixMount \
  --vfs-cache-mode full \
  --dir-cache-time 30s \
  --daemon
```

**Windows** (after WinFsp; adjust drive letter):

```bat
rclone mount helix: X: --vfs-cache-mode full --network-mode
```

Unmount: stop the rclone process or `fusermount -u ~/HelixMount` / unmount the drive letter.

## Recommended scopes

Minimum for two-way sync:

- `webdav` **or** explicit `drive.read` + `drive.write`  
- Add `drive.delete` only if remote deletes should remove local files (and vice versa)

Read-only mirror:

- `drive.read` / `webdav` without write — use `rclone sync helix: ~/HelixDrive` (one-way pull) instead of bisync.

## Operator checklist

- [ ] App password created and stored in a password manager / OS keychain  
- [ ] TLS certificate valid for the Helix hostname  
- [ ] WebDAV smoke green: `pnpm quality:live-auth-smoke` with `--webdav-smoke` (or equivalent)  
- [ ] Users choose **mirror** vs **mount** with the tradeoffs above  
- [ ] Multi-node deploys: WebDAV locks should be durable (Postgres/Redis) before relying on LOCK for Office co-write  

## What Helix will ship later (Phase B)

A small open-source tray app that:

1. Asks for server URL + app password (or device login later)  
2. Offers **Mirror folder** vs **Mount drive**  
3. Runs rclone under the hood and shows sync status  

Until then, this document is the supported client path.

## Related

- Drive WebDAV implementation: `apps/helix/src/platform/drive/` (`/dav/files/*`)  
- App passwords: Admin → App passwords; `docs/admin-guide.md`  
- Live WebDAV smoke notes: `docs/troubleshooting.md`  
- MVP product boundary: `docs/product-claims-mvp.md` (files + previews; no native editors)  
