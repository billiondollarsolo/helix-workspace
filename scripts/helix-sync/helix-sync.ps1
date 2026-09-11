# Helix Sync — configure a local Drive folder or virtual mount (rclone WebDAV).
$ErrorActionPreference = "Stop"
$RemoteName = if ($env:HELIX_SYNC_REMOTE) { $env:HELIX_SYNC_REMOTE } else { "helix" }
$HelixHome = if ($env:HELIX_SYNC_HOME) { $env:HELIX_SYNC_HOME } else { Join-Path $env:LOCALAPPDATA "Helix\drive-sync" }
$Rclone = if ($env:HELIX_RCLONE) { $env:HELIX_RCLONE } else { Join-Path $HelixHome "bin\rclone.exe" }
if (-not (Test-Path $Rclone)) {
  $fromPath = Get-Command rclone -ErrorAction SilentlyContinue
  if ($fromPath) { $Rclone = $fromPath.Source } else {
    Write-Error "Helix Sync is not installed. In PowerShell: irm `$origin/v1/drive/sync/install.ps1 | iex"
    exit 2
  }
}

function Normalize-DavUrl([string]$raw) {
  $s = $raw.Trim()
  if (-not $s) { throw "Server URL is required." }
  if ($s -notmatch "^https?://") { $s = "https://$s" }
  $s = $s.TrimEnd("/")
  if ($s -match "/dav/files$") { return "$s/" }
  if ($s -match "/dav/files/") { return ($s.TrimEnd("/") + "/") }
  return "$s/dav/files/"
}

Write-Host ""
Write-Host "  Helix Sync setup"
Write-Host "  Connects this computer to Helix Drive over WebDAV."
Write-Host "  Use an app password (Settings -> Security), not your login password."
Write-Host ""

$urlRaw = $env:HELIX_SYNC_URL
if (-not $urlRaw) { $urlRaw = $env:HELIX_SYNC_DEFAULT_URL }
if (-not $urlRaw) { $urlRaw = Read-Host "Helix server URL (e.g. https://helix.company.com)" }
$url = Normalize-DavUrl $urlRaw

$user = $env:HELIX_SYNC_USER
if (-not $user) { $user = Read-Host "Your Helix email" }
if (-not $user) { throw "Email is required." }

$password = $env:HELIX_SYNC_PASSWORD
if (-not $password) {
  $secure = Read-Host "App password" -AsSecureString
  $password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  )
}
if (-not $password) { throw "App password is required." }

Write-Host ""
Write-Host "  1) Mirror folder  — a normal folder that stays in sync (recommended)"
Write-Host "  2) Virtual drive  — mount Helix like a network drive"
$modeRaw = $env:HELIX_SYNC_MODE
if (-not $modeRaw) { $modeRaw = Read-Host "Choose mode [1]" }
if (-not $modeRaw) { $modeRaw = "1" }
$mode = switch ($modeRaw.ToLower()) {
  { $_ -in @("1", "mirror", "m", "folder", "sync") } { "mirror" }
  { $_ -in @("2", "mount", "drive", "virtual") } { "mount" }
  default { throw "Mode must be mirror or mount." }
}

$defaultPath = if ($mode -eq "mirror") { Join-Path $HOME "HelixDrive" } else { "X:" }
$localPath = $env:HELIX_SYNC_PATH
if (-not $localPath) {
  $entered = Read-Host "$(if ($mode -eq 'mirror') { 'Local folder path' } else { 'Mount path / drive letter' }) [$defaultPath]"
  $localPath = if ($entered) { $entered } else { $defaultPath }
}

Write-Host "Configuring connection..."
$obscured = (& $Rclone obscure $password | Select-Object -First 1).Trim()
& $Rclone config delete $RemoteName 2>$null | Out-Null
& $Rclone config create $RemoteName webdav "url=$url" vendor=other "user=$user" "pass=$obscured"
if ($LASTEXITCODE -ne 0) { throw "rclone config failed." }
Write-Host "Testing connection..."
& $Rclone lsd "${RemoteName}:"
if ($LASTEXITCODE -ne 0) { throw "Could not list Helix Drive. Check URL, email, and app password." }

New-Item -ItemType Directory -Force -Path $HelixHome | Out-Null
if ($mode -eq "mirror") {
  New-Item -ItemType Directory -Force -Path $localPath | Out-Null
  $sync = Join-Path $HelixHome "sync-now.cmd"
  @"
@echo off
"$Rclone" bisync "$localPath" ${RemoteName}: --create-empty-src-dirs --resilient
"@ | Set-Content -Path $sync -Encoding ASCII
  Write-Host "First sync into $localPath..."
  & $Rclone bisync $localPath "${RemoteName}:" --create-empty-src-dirs --resilient --resync
  Write-Host "  Helix Drive is set up."
  Write-Host "  Folder:  $localPath"
  Write-Host "  Later:   $sync"
} else {
  $mount = Join-Path $HelixHome "mount.cmd"
  @"
@echo off
echo Mounting Helix Drive to $localPath ...
"$Rclone" mount ${RemoteName}: $localPath --vfs-cache-mode full --dir-cache-time 30s --network-mode
"@ | Set-Content -Path $mount -Encoding ASCII
  Write-Host "  Helix Drive is configured."
  Write-Host "  Start mount:  $mount"
  Write-Host "  Windows needs WinFsp for mount mode (https://winfsp.dev/)."
}
