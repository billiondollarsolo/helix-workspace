/* Recording playback drawer for the Meet hub.
 *
 * The Meet backend attaches Jibri uploads as Drive objects on the meeting
 * thread (see apps/helix/src/platform/meet/store.ts:attachRecording). Each
 * artifact's bytes are reachable through the session-authenticated
 * /api/drive/objects/:id/content route, which supports HTTP Range requests
 * — so a plain <video> element scrubs cleanly.
 *
 * Triggered from the Recent panel's "Recording" button. Renders a right-side
 * panel listing every artifact with an inline player + size + duration +
 * an "Open in Drive" link.
 */

import { Icons } from "@/components/icons";
import { useEffect, useId, useRef } from "react";
import type { MeetMeetingRecord, MeetRecordingArtifactRecord } from "./api";

export interface RecordingDrawerProps {
  readonly meeting: MeetMeetingRecord;
  readonly onClose: () => void;
}

export function RecordingDrawer({ meeting, onClose }: RecordingDrawerProps) {
  const artifacts = meeting.recordingArtifacts ?? [];
  const titleId = useId();
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || drawerRef.current === null) return;
      const controls = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (controls.length === 0) {
        event.preventDefault();
        drawerRef.current.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          border: "none",
          padding: 0,
          cursor: "default",
          zIndex: 40,
        }}
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(520px, 90vw)",
          background: "var(--surface)",
          borderLeft: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          zIndex: 41,
          boxShadow: "-12px 0 30px rgba(0,0,0,0.25)",
        }}
      >
        <header
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icons.Video />
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2
              id={titleId}
              style={{
                margin: 0,
                fontWeight: 600,
                fontSize: "var(--text-body-sm)",
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              Recordings
            </h2>
            <div
              style={{
                fontSize: "var(--text-meta)",
                color: "var(--text-3)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {meeting.title || meeting.subject}
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icons.X />
          </button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
          {artifacts.length === 0 ? (
            <EmptyState recorded={meeting.recorded} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {artifacts.map((artifact, idx) => (
                <RecordingCard
                  key={artifact.objectId}
                  artifact={artifact}
                  index={idx}
                  total={artifacts.length}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function EmptyState({ recorded }: { readonly recorded: boolean }) {
  return (
    <div
      role="status"
      style={{
        padding: "48px 16px",
        textAlign: "center",
        color: "var(--text-3)",
        fontSize: "var(--text-meta)",
      }}
    >
      {recorded
        ? "This meeting was recorded, but the upload hasn't been received yet. Recordings appear here after Jibri finishes uploading."
        : "No recordings for this meeting."}
    </div>
  );
}

function RecordingCard({
  artifact,
  index,
  total,
}: {
  readonly artifact: MeetRecordingArtifactRecord;
  readonly index: number;
  readonly total: number;
}) {
  const src = `/api/drive/objects/${artifact.objectId}/content`;
  const driveHref = `/drive?file=${encodeURIComponent(artifact.objectId)}`;
  const captured = artifact.startedAt ?? artifact.createdAt;
  const duration = formatDurationFromRange(artifact.startedAt, artifact.endedAt);
  return (
    <article
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        background: "var(--surface-2)",
        overflow: "hidden",
      }}
    >
      <div style={{ background: "#000" }}>
        <video
          aria-label={`Recording ${String(index + 1)} of ${String(total)}`}
          controls
          preload="metadata"
          src={src}
          style={{ width: "100%", display: "block", maxHeight: 320, background: "#000" }}
        >
          <track kind="captions" />
        </video>
      </div>
      <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ fontWeight: 600, fontSize: "var(--text-body-sm)" }}>
            {total > 1 ? `Recording ${String(index + 1)} of ${String(total)}` : "Recording"}
          </span>
          <span style={{ fontSize: "var(--text-caption)", color: "var(--text-3)" }}>
            {formatBytes(artifact.byteSize)}
          </span>
        </div>
        <dl
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "2px 12px",
            fontSize: "var(--text-meta)",
            color: "var(--text-2)",
          }}
        >
          <dt style={{ color: "var(--text-3)" }}>Captured</dt>
          <dd style={{ margin: 0 }}>{formatTimestamp(captured)}</dd>
          {duration !== null ? (
            <>
              <dt style={{ color: "var(--text-3)" }}>Duration</dt>
              <dd style={{ margin: 0 }}>{duration}</dd>
            </>
          ) : null}
          <dt style={{ color: "var(--text-3)" }}>Format</dt>
          <dd style={{ margin: 0 }}>{prettyMime(artifact.mimeType)}</dd>
        </dl>
        <div style={{ display: "flex", gap: 8, paddingTop: 4 }}>
          <a
            className="btn sm"
            href={`${src}?download=1`}
            download
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Download
          </a>
          <a
            className="btn sm"
            href={driveHref}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            Open in Drive
          </a>
        </div>
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${formatted} ${units[unit]}`;
}

function formatDurationFromRange(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  const seconds = Math.round((endMs - startMs) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const date = new Date(ms);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function prettyMime(mime: string): string {
  if (mime === "video/mp4") return "MP4";
  if (mime === "video/webm") return "WebM";
  return mime;
}
