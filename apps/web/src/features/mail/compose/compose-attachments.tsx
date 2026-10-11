import { CircleAlert, Paperclip, ShieldCheck, X } from "lucide-react";
import type { CSSProperties } from "react";
import type { ComposeAttachmentItem } from "./use-compose-attachments";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function statusText(item: ComposeAttachmentItem): string {
  switch (item.state) {
    case "uploading":
      return `Uploading ${String(item.progress ?? 0)}%`;
    case "scanning":
      return `${item.detail}…`;
    case "ready":
      return formatBytes(item.byteSize);
    case "blocked":
    case "failed":
      return item.detail;
  }
}

/** Attachment chips with upload progress and the malware-scan result. */
export function ComposeAttachments({
  items,
  onRemove,
  label = "Attachments",
}: {
  readonly items: readonly ComposeAttachmentItem[];
  readonly onRemove?: (key: string) => void;
  readonly label?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="compose-attachments" aria-label={label}>
      {items.map((item) => {
        const busy = item.state === "uploading" || item.state === "scanning";
        const problem = item.state === "blocked" || item.state === "failed";
        return (
          <li
            key={item.key}
            className="compose-attachment"
            data-state={item.state}
            aria-busy={busy ? "true" : undefined}
          >
            {problem ? (
              <CircleAlert aria-hidden="true" size={16} className="compose-attachment-icon" />
            ) : item.state === "ready" ? (
              <Paperclip aria-hidden="true" size={16} className="compose-attachment-icon" />
            ) : (
              <ShieldCheck aria-hidden="true" size={16} className="compose-attachment-icon" />
            )}
            <span className="compose-attachment-text">
              <span className="compose-attachment-name" title={item.filename}>
                {item.filename}
              </span>
              <span className="compose-attachment-status">{statusText(item)}</span>
            </span>
            {item.state === "uploading" ? (
              <span
                className="compose-attachment-progress"
                role="progressbar"
                aria-label={`Uploading ${item.filename}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={item.progress ?? 0}
                style={{ "--progress": `${String(item.progress ?? 0)}%` } as CSSProperties}
              />
            ) : item.state === "scanning" ? (
              <span
                className="compose-attachment-progress"
                data-scanning=""
                role="progressbar"
                aria-label={`${item.filename}: ${statusText(item)}`}
              />
            ) : null}
            {onRemove === undefined ? null : (
              <button
                type="button"
                className="compose-attachment-remove"
                aria-label={`Remove ${item.filename}`}
                onClick={() => {
                  onRemove(item.key);
                }}
              >
                <X aria-hidden="true" size={14} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
