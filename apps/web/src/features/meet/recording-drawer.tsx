import { SideSheet } from "@/components/ui/side-sheet";
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

import type { MeetMeetingRecord, MeetRecordingArtifactRecord } from "./api";
import { formatElapsed } from "./meet-call";

export interface RecordingDrawerProps {
  readonly meeting: MeetMeetingRecord;
  readonly onClose: () => void;
}

export function RecordingDrawer({ meeting, onClose }: RecordingDrawerProps) {
  const artifacts = meeting.recordingArtifacts ?? [];
  return (
    <SideSheet
      open
      modal={false}
      title="Recordings"
      description={meeting.title || meeting.subject}
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {artifacts.length === 0 ? (
        <EmptyState recorded={meeting.recorded} />
      ) : (
        <div className="flex flex-col gap-4">
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
    </SideSheet>
  );
}

function EmptyState({ recorded }: { readonly recorded: boolean }) {
  return (
    <div role="status" className="[padding:48px_16px] text-center text-muted-foreground type-meta">
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
  const src = `/v1/api/drive/objects/${artifact.objectId}/content`;
  const driveHref = `/drive?file=${encodeURIComponent(artifact.objectId)}`;
  const captured = artifact.startedAt ?? artifact.createdAt;
  const duration = formatDurationFromRange(artifact.startedAt, artifact.endedAt);
  return (
    <article className="[border:1px_solid_var(--border)] [border-radius:10px] bg-muted overflow-hidden">
      <div className="bg-black">
        <video
          aria-label={`Recording ${String(index + 1)} of ${String(total)}`}
          controls
          preload="metadata"
          src={src}
          className="w-full block max-h-80 bg-black"
        />
      </div>
      <div className="[padding:12px_14px] flex flex-col gap-1.5">
        <div className="flex [align-items:baseline] justify-between gap-2">
          <span className="font-semibold type-body-sm">
            {total > 1 ? `Recording ${String(index + 1)} of ${String(total)}` : "Recording"}
          </span>
          <span className="type-caption text-muted-foreground">
            {formatBytes(artifact.byteSize)}
          </span>
        </div>
        <dl className="m-0 grid [grid-template-columns:auto_1fr] [gap:2px_12px] type-meta [color:var(--text-2)]">
          <dt className="text-muted-foreground">Captured</dt>
          <dd className="m-0">{formatTimestamp(captured)}</dd>
          {duration !== null ? (
            <>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="m-0">{duration}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Format</dt>
          <dd className="m-0">{prettyMime(artifact.mimeType)}</dd>
        </dl>
        <div className="flex gap-2 pt-1">
          {artifact.exportAllowed !== false ? (
            <a
              className="btn sm inline-flex items-center gap-1.5"
              href={`${src}?download=1`}
              download
            >
              Download
            </a>
          ) : (
            <span className="text-muted-foreground type-meta">Download disabled</span>
          )}
          <a className="btn sm inline-flex items-center gap-1.5" href={driveHref}>
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
  return formatElapsed(Math.round((endMs - startMs) / 1000));
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
