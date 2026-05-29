import type { CSSProperties } from "react";

export interface OfficeVersionRecord {
  readonly id: string;
  readonly versionNumber: number;
  readonly byteSize: number;
  readonly metadata: Record<string, unknown>;
  readonly createdByActorId?: string | null;
  readonly createdAt: string;
}

export interface OfficeVersionHistoryPanelProps {
  readonly ariaLabel: string;
  readonly versions: readonly OfficeVersionRecord[];
  readonly loading: boolean;
  readonly loadError: boolean;
  readonly restoreError: boolean;
  readonly restoringVersionId: string | null;
  readonly emptyLabel: string;
  readonly detailLabel: (version: OfficeVersionRecord) => string;
  readonly onRestore: (version: OfficeVersionRecord) => void;
}

export function OfficeVersionHistoryPanel({
  ariaLabel,
  versions,
  loading,
  loadError,
  restoreError,
  restoringVersionId,
  emptyLabel,
  detailLabel,
  onRestore,
}: OfficeVersionHistoryPanelProps) {
  return (
    <aside aria-label={ariaLabel} tabIndex={-1} style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <h2 style={TITLE_STYLE}>Version history</h2>
        <span style={COUNT_STYLE}>{versions.length}</span>
      </div>
      {loading ? <p style={HELP_TEXT_STYLE}>Loading versions</p> : null}
      {loadError ? <p style={ERROR_TEXT_STYLE}>Could not load versions.</p> : null}
      {restoreError ? <p style={ERROR_TEXT_STYLE}>Could not restore version.</p> : null}
      {!loading && !loadError && versions.length === 0 ? (
        <p style={HELP_TEXT_STYLE}>{emptyLabel}</p>
      ) : null}
      {versions.length > 0 ? (
        <ol style={VERSION_LIST_STYLE}>
          {versions.map((version) => {
            const restoring = restoringVersionId === version.id;
            return (
              <li key={version.id} style={VERSION_ITEM_STYLE}>
                <div style={VERSION_ROW_STYLE}>
                  <span style={VERSION_TITLE_STYLE}>Version {version.versionNumber}</span>
                  <time style={VERSION_TIME_STYLE} dateTime={version.createdAt}>
                    {formatVersionTime(version.createdAt)}
                  </time>
                </div>
                <div style={VERSION_META_STYLE}>{versionTitle(version)}</div>
                <dl style={VERSION_FACTS_STYLE}>
                  <VersionFact label="Size" value={formatByteSize(version.byteSize)} />
                  <VersionFact label="Actor" value={version.createdByActorId ?? "System"} />
                  <VersionFact label="Snapshot" value={detailLabel(version)} />
                </dl>
                <div style={ACTION_ROW_STYLE}>
                  <button
                    className="btn sm"
                    type="button"
                    disabled={restoringVersionId !== null}
                    onClick={() => onRestore(version)}
                  >
                    {restoring ? "Restoring..." : "Restore"}
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </aside>
  );
}

function VersionFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={VERSION_FACT_STYLE}>
      <dt style={VERSION_FACT_LABEL_STYLE}>{label}</dt>
      <dd style={VERSION_FACT_VALUE_STYLE}>{value}</dd>
    </div>
  );
}

function versionTitle(version: OfficeVersionRecord): string {
  const title = version.metadata.title;
  return typeof title === "string" && title.trim().length > 0 ? title.trim() : "Saved snapshot";
}

function formatVersionTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "Unknown";
  }
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PANEL_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minHeight: 0,
  padding: 12,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const TITLE_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--text)",
  fontSize: "var(--text-sm)",
  fontWeight: 700,
};

const COUNT_STYLE: CSSProperties = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
  fontWeight: 700,
};

const HELP_TEXT_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--text-3)",
  fontSize: "var(--text-sm)",
};

const ERROR_TEXT_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--danger)",
  fontSize: "var(--text-sm)",
};

const VERSION_LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  listStyle: "none",
  margin: 0,
  padding: 0,
};

const VERSION_ITEM_STYLE: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--surface)",
  padding: 10,
};

const VERSION_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const VERSION_TITLE_STYLE: CSSProperties = {
  color: "var(--text)",
  fontSize: "var(--text-sm)",
  fontWeight: 700,
};

const VERSION_TIME_STYLE: CSSProperties = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
  whiteSpace: "nowrap",
};

const VERSION_META_STYLE: CSSProperties = {
  marginTop: 4,
  color: "var(--text-2)",
  fontSize: "var(--text-caption)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const VERSION_FACTS_STYLE: CSSProperties = {
  display: "grid",
  gap: 4,
  margin: "8px 0 0",
};

const VERSION_FACT_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "72px minmax(0, 1fr)",
  gap: 8,
};

const VERSION_FACT_LABEL_STYLE: CSSProperties = {
  color: "var(--text-3)",
  fontSize: "var(--text-caption)",
  margin: 0,
};

const VERSION_FACT_VALUE_STYLE: CSSProperties = {
  color: "var(--text-2)",
  fontSize: "var(--text-caption)",
  margin: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ACTION_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  marginTop: 10,
};
