import { Laptop as LaptopIcon, X as XIcon } from "lucide-react";
import { useState } from "react";

const SYNC_COMMAND = "pnpm helix:drive-sync";

export function DriveSyncControl() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
            className="[width:min(420px,_calc(100vw_-_32px))] bg-card rounded-lg [border:1px_solid_var(--border)] [box-shadow:0_24px_80px_rgba(15,23,42,0.24)]"
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
                Mirror Helix Drive to a folder on this computer, or mount it as a virtual drive.
                Uses WebDAV and an app password.
              </p>
              <ol className="m-0 [padding-inline-start:18px] grid gap-1">
                <li>Create an app password in Settings → Security.</li>
                <li>On this machine run:</li>
              </ol>
              <code className="block [padding:8px_10px] rounded-md bg-muted [font-size:var(--text-caption)]">
                {SYNC_COMMAND}
              </code>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  void navigator.clipboard.writeText(SYNC_COMMAND).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy command"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
