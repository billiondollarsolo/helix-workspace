# Helix Sync installer — Windows (PowerShell 5+).
#
#   irm https://YOUR-HELIX/v1/drive/sync/install.ps1 | iex
#   irm https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync/install.ps1 | iex
#
# No Node or pnpm. Downloads rclone into %LOCALAPPDATA%\Helix\drive-sync\bin.
$ErrorActionPreference = "Stop"
$RcloneVersion = if ($env:HELIX_SYNC_RCLONE_VERSION) { $env:HELIX_SYNC_RCLONE_VERSION } else { "v1.69.3" }
$HelixHome = if ($env:HELIX_SYNC_HOME) { $env:HELIX_SYNC_HOME } else { Join-Path $env:LOCALAPPDATA "Helix\drive-sync" }
$BinDir = Join-Path $HelixHome "bin"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if ($env:HELIX_SYNC_SKIP_RCLONE -ne "1") {
  $rcloneArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
  $zipName = "rclone-$RcloneVersion-windows-$rcloneArch.zip"
  $url = "https://downloads.rclone.org/$RcloneVersion/$zipName"
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("helix-sync-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Write-Host "Downloading rclone $RcloneVersion (windows/$rcloneArch)..."
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp "rclone.zip")
  Expand-Archive -Path (Join-Path $tmp "rclone.zip") -DestinationPath $tmp -Force
  $rclone = Get-ChildItem -Path $tmp -Recurse -Filter rclone.exe | Select-Object -First 1
  if (-not $rclone) { throw "rclone zip did not contain rclone.exe." }
  Copy-Item $rclone.FullName (Join-Path $BinDir "rclone.exe") -Force
  Remove-Item $tmp -Recurse -Force
}

$origin = $env:HELIX_SYNC_ORIGIN
if ($origin) {
  $scriptUrl = ($origin.TrimEnd("/")) + "/v1/drive/sync/helix-sync.ps1"
} else {
  $base = if ($env:HELIX_SYNC_SCRIPT_BASE) { $env:HELIX_SYNC_SCRIPT_BASE } else {
    "https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync"
  }
  $scriptUrl = $base.TrimEnd("/") + "/helix-sync.ps1"
}

Write-Host "Installing helix-sync..."
Invoke-WebRequest -Uri $scriptUrl -OutFile (Join-Path $BinDir "helix-sync.ps1")
$launcher = Join-Path $BinDir "helix-sync.cmd"
@"
@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0helix-sync.ps1" %*
"@ | Set-Content -Path $launcher -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$BinDir", "User")
  $env:Path = "$env:Path;$BinDir"
}

Write-Host ""
Write-Host "  Helix Sync is installed."
Write-Host "  Next:    helix-sync"
Write-Host "  You will need an app password from Helix (Settings -> Security)."
Write-Host ""
