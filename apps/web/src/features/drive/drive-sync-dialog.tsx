import { Laptop as LaptopIcon, X as XIcon } from "lucide-react";
import { useState } from "react";

const GITHUB_INSTALL =
  "https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync/install.sh";
const GITHUB_INSTALL_PS1 =
  "https://raw.githubusercontent.com/billiondollarsolo/helix-workspace/main/scripts/helix-sync/install.ps1";

export function helixSyncInstallCommands(origin: string): {
  readonly unix: string;
  readonly windows: string;
  readonly unixDownload: string;
  readonly windowsDownload: string;
} {
  const base = origin.replace(/\/$/u, "");
  return {
    unix: `curl -fsSL ${base}/v1/drive/sync/install.sh | bash`,
    windows: `irm ${base}/v1/drive/sync/install.ps1 | iex`,
    unixDownload: `${base}/v1/drive/sync/install.sh`,
    windowsDownload: `${base}/v1/drive/sync/install.ps1`,
  };
}

export function helixSyncPlatform(userAgent: string): "mac" | "windows" | "linux" {
  if (/windows/i.test(userAgent)) return "windows";
  if (/mac os x|macintosh/i.test(userAgent)) return "mac";
  return "linux";
}

export function DriveSyncControl() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"unix" | "windows" | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const commands = helixSyncInstallCommands(origin);
  const platform = helixSyncPlatform(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const primary = platform === "windows" ? "windows" : "unix";
  return (
    <>
      <button type="button" className="surf-nav-row" onClick={() => setOpen(true)}>
        <LaptopIcon size={16} />
        <span className="label">Desktop sync</span>
      </button>
      {open ? (
        <div className="fixed inset-0 [z-index:80] grid [place-items:center] p-6 [background:color-mix(in_srgb,_black_32%,_transparent)]">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Helix Sync"
            className="[width:min(480px,_calc(100vw_-_32px))] bg-card rounded-lg [border:1px_solid_var(--border)] [box-shadow:0_24px_80px_rgba(15,23,42,0.24)]"
          >
            <div className="flex items-center [padding:14px_16px] [border-bottom:1px_solid_var(--border)]">
              <h2 className="m-0 [font-size:var(--text-lg)]">Helix Sync</h2>
              <button
                type="button"
                className="icon-btn ml-auto"
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                <XIcon size={16} />
              </button>
            </div>
            <div className="grid gap-2 [padding:14px_16px] [font-size:var(--text-body-sm)]">
              <p className="m-0">
                Install a small helper on this computer. It downloads rclone for you — no Node,
                pnpm, or Homebrew required. Then run <code>helix-sync</code> and paste an app
                password.
              </p>
              <InstallBlock
                label={primary === "windows" ? "Windows (PowerShell)" : "macOS / Linux"}
                command={primary === "windows" ? commands.windows : commands.unix}
                copied={copied === primary}
                onCopy={() => {
                  void navigator.clipboard
                    .writeText(primary === "windows" ? commands.windows : commands.unix)
                    .then(() => setCopied(primary));
                }}
              />
              <InstallBlock
                label={primary === "windows" ? "macOS / Linux" : "Windows (PowerShell)"}
                command={primary === "windows" ? commands.unix : commands.windows}
                copied={copied === (primary === "windows" ? "unix" : "windows")}
                onCopy={() => {
                  const key = primary === "windows" ? "unix" : "windows";
                  void navigator.clipboard
                    .writeText(key === "unix" ? commands.unix : commands.windows)
                    .then(() => setCopied(key));
                }}
              />
              <p className="m-0 [font-size:var(--text-caption)] text-muted-foreground">
                Downloads:{" "}
                <a className="text-primary" href={commands.unixDownload}>
                  macOS/Linux installer
                </a>
                {" · "}
                <a className="text-primary" href={commands.windowsDownload}>
                  Windows installer
                </a>
              </p>
              <p className="m-0 [font-size:var(--text-caption)] text-muted-foreground">
                From GitHub instead:{" "}
                <code className="[font-size:var(--text-caption)]">
                  curl -fsSL {GITHUB_INSTALL} | bash
                </code>
                {" / "}
                <code className="[font-size:var(--text-caption)]">
                  irm {GITHUB_INSTALL_PS1} | iex
                </code>
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function InstallBlock({
  label,
  command,
  copied,
  onCopy,
}: {
  readonly label: string;
  readonly command: string;
  readonly copied: boolean;
  readonly onCopy: () => void;
}) {
  return (
    <div className="grid gap-1">
      <div className="[font-size:var(--text-caption)] font-semibold">{label}</div>
      <code className="block [padding:8px_10px] rounded-md bg-muted [font-size:var(--text-caption)] [overflow-wrap:anywhere]">
        {command}
      </code>
      <button type="button" className="btn sm" onClick={onCopy}>
        {copied ? "Copied" : "Copy command"}
      </button>
    </div>
  );
}
