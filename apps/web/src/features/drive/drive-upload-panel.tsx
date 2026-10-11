import {
  ChevronDown as MinimizeIcon,
  ChevronUp as ExpandIcon,
  CircleAlert as FailedIcon,
  CircleCheck as DoneIcon,
  LoaderCircle as BusyIcon,
  RotateCw as RetryIcon,
  ShieldAlert as BlockedIcon,
  X as CloseIcon,
} from "lucide-react";
import { useState } from "react";
import { fileTypeFromName, formatByteSize } from "./drive-data";
import { DriveTypeIcon } from "./drive-type-icon";
import { isUploadActive, type DriveUploadTask } from "./use-drive-uploads";

/** Header line: "Uploading 3 items", "2 uploads complete", "1 upload blocked". */
export function uploadPanelTitle(tasks: readonly DriveUploadTask[]): string {
  const active = tasks.filter(isUploadActive);
  const uploading = active.filter((task) => task.phase !== "scanning");
  if (uploading.length > 0) {
    return `Uploading ${String(uploading.length)} item${uploading.length === 1 ? "" : "s"}`;
  }
  if (active.length > 0) {
    return `Scanning ${String(active.length)} item${active.length === 1 ? "" : "s"}`;
  }
  const blocked = tasks.filter((task) => task.phase === "blocked" || task.phase === "failed");
  if (blocked.length > 0) {
    return blocked.length === 1
      ? "1 upload needs attention"
      : `${String(blocked.length)} uploads need attention`;
  }
  const done = tasks.filter((task) => task.phase === "done").length;
  return `${String(done)} upload${done === 1 ? "" : "s"} complete`;
}

/** Status text for one row. */
export function uploadTaskStatus(task: DriveUploadTask): string {
  switch (task.phase) {
    case "queued":
      return "Waiting…";
    case "uploading":
      return task.size > 0 && task.uploadedBytes > 0
        ? `${formatByteSize(task.uploadedBytes)} of ${formatByteSize(task.size)}`
        : "Uploading…";
    case "scanning":
      return "Scanning…";
    case "done":
      return "Uploaded";
    case "blocked":
      return task.message ?? "Blocked by the security scan.";
    case "failed":
      return task.message ?? "Upload failed.";
    case "canceled":
      return "Canceled";
  }
}

function uploadPercent(task: DriveUploadTask): number | null {
  if (task.phase === "scanning" || task.phase === "done") return 100;
  if (task.phase !== "uploading" || task.size === 0 || task.uploadedBytes === 0) return null;
  return Math.min(100, Math.round((task.uploadedBytes / task.size) * 100));
}

function TaskIcon({ task }: { readonly task: DriveUploadTask }) {
  if (task.phase === "done") {
    return <DoneIcon size={18} aria-hidden="true" className="text-[var(--success)]" />;
  }
  if (task.phase === "blocked") {
    return <BlockedIcon size={18} aria-hidden="true" className="text-[var(--danger)]" />;
  }
  if (task.phase === "failed") {
    return <FailedIcon size={18} aria-hidden="true" className="text-[var(--danger)]" />;
  }
  if (isUploadActive(task)) {
    return <BusyIcon size={18} aria-hidden="true" className="drive-spin text-[var(--accent)]" />;
  }
  return null;
}

/** Bottom-right upload progress panel, like Drive's. */
export function DriveUploadPanel({
  tasks,
  onCancel,
  onRetry,
  onClose,
}: {
  readonly tasks: readonly DriveUploadTask[];
  readonly onCancel: (id: string) => void;
  readonly onRetry: (id: string) => void;
  readonly onClose: () => void;
}) {
  const [minimized, setMinimized] = useState(false);
  if (tasks.length === 0) return null;
  const active = tasks.some(isUploadActive);
  const title = uploadPanelTitle(tasks);
  return (
    <section aria-label="Uploads" className="drive-upload-panel" data-testid="drive-upload-panel">
      <header className="drive-upload-panel-header">
        <h2 className="type-body-sm m-0 font-semibold flex-1 truncate">
          <span role="status">{title}</span>
        </h2>
        <button
          type="button"
          className="icon-btn"
          aria-label={minimized ? "Expand uploads" : "Minimize uploads"}
          aria-expanded={!minimized}
          onClick={() => setMinimized((value) => !value)}
        >
          {minimized ? <ExpandIcon size={18} /> : <MinimizeIcon size={18} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={active ? "Cancel uploads and close" : "Close uploads"}
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </button>
      </header>
      {minimized ? null : (
        <ul className="drive-upload-panel-list" aria-label="Upload progress">
          {tasks.map((task) => {
            const percent = uploadPercent(task);
            const status = uploadTaskStatus(task);
            const problem = task.phase === "blocked" || task.phase === "failed";
            return (
              <li key={task.id} className="drive-upload-row" data-phase={task.phase}>
                <DriveTypeIcon type={fileTypeFromName(task.name, null)} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="type-body-sm truncate" title={task.name}>
                    {task.name}
                  </div>
                  <div
                    className={
                      problem
                        ? "type-caption text-[var(--danger)]"
                        : "type-caption text-muted-foreground"
                    }
                  >
                    {status}
                  </div>
                  {task.phase === "uploading" ? (
                    <div
                      role="progressbar"
                      aria-label={`Uploading ${task.name}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent ?? undefined}
                      className="drive-upload-bar"
                      data-indeterminate={percent === null || undefined}
                    >
                      <span style={{ width: `${String(percent ?? 35)}%` }} />
                    </div>
                  ) : null}
                </div>
                {task.phase === "queued" || task.phase === "uploading" ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Cancel upload of ${task.name}`}
                    onClick={() => onCancel(task.id)}
                  >
                    <CloseIcon size={16} />
                  </button>
                ) : (
                  <TaskIcon task={task} />
                )}
                {task.phase === "failed" ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Retry upload of ${task.name}`}
                    onClick={() => onRetry(task.id)}
                  >
                    <RetryIcon size={16} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
