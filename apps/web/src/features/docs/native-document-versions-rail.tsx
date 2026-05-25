import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useEffect, useState } from "react";
import {
  previewDocsVersion,
  renameDocsVersion,
  restoreDocsVersion,
  type DocsVersion,
  type DocsVersionDiffLine,
  type DocsVersionPreview,
} from "./api";
import { docsQueryKeys, docsVersionsQueryOptions } from "./queries";

interface RestoreConflictBlock {
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly string[];
}

export interface NativeDocumentVersionsRailProps {
  readonly documentId: string;
}

export function NativeDocumentVersionsRail({ documentId }: NativeDocumentVersionsRailProps) {
  const queryClient = useQueryClient();
  const versionsQuery = useQuery(docsVersionsQueryOptions(documentId));
  const versions = versionsQuery.data ?? [];
  const renameMutation = useMutation({
    mutationFn: (input: { readonly versionId: string; readonly name: string }) =>
      renameDocsVersion(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.versions(documentId) });
    },
  });
  const [preview, setPreview] = useState<DocsVersionPreview | null>(null);
  const previewMutation = useMutation({
    mutationFn: (input: { readonly versionId: string }) => previewDocsVersion(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: (nextPreview) => {
      setPreview(nextPreview);
    },
  });
  const restoreMutation = useMutation({
    mutationFn: (input: {
      readonly versionId: string;
      readonly expectedCurrentUpdateSeq: number;
    }) => restoreDocsVersion(input),
    onMutate: () => undefined,
    onError: () => undefined,
    onSuccess: () => {
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.versions(documentId) });
      void queryClient.invalidateQueries({ queryKey: docsQueryKeys.nativeSession(documentId) });
    },
  });

  return (
    <aside
      id="native-document-versions-panel"
      style={RAIL_STYLE}
      aria-label="Document version history"
      tabIndex={-1}
    >
      <div style={RAIL_HEADER_STYLE}>
        <h2 style={RAIL_TITLE_STYLE}>Version history</h2>
        <span style={COUNT_STYLE}>{versions.length}</span>
      </div>
      {versionsQuery.isLoading ? <p style={HELP_TEXT_STYLE}>Loading versions</p> : null}
      {versionsQuery.isError ? <p style={ERROR_TEXT_STYLE}>Could not load versions.</p> : null}
      {renameMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not name version.</p> : null}
      {previewMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not preview version.</p> : null}
      {restoreMutation.isError ? <p style={ERROR_TEXT_STYLE}>Could not restore version.</p> : null}
      {!versionsQuery.isLoading && !versionsQuery.isError && versions.length === 0 ? (
        <p style={HELP_TEXT_STYLE}>No saved updates</p>
      ) : null}
      {versions.length > 0 ? (
        <ol style={VERSION_LIST_STYLE}>
          {versions.map((version) => (
            <VersionItem
              key={version.id}
              version={version}
              renaming={renameMutation.isPending}
              previewing={previewMutation.isPending}
              onRename={(name) => {
                renameMutation.mutate({ versionId: version.id, name });
              }}
              onPreview={() => {
                previewMutation.mutate({ versionId: version.id });
              }}
            />
          ))}
        </ol>
      ) : null}
      {preview !== null ? (
        <VersionPreview
          preview={preview}
          restoring={restoreMutation.isPending}
          onRestore={(input) => {
            restoreMutation.mutate(input);
          }}
        />
      ) : null}
    </aside>
  );
}

function VersionItem({
  version,
  renaming,
  previewing,
  onRename,
  onPreview,
}: {
  readonly version: DocsVersion;
  readonly renaming: boolean;
  readonly previewing: boolean;
  readonly onRename: (name: string) => void;
  readonly onPreview: () => void;
}) {
  const currentName = versionName(version);
  const [nameDraft, setNameDraft] = useState(currentName);
  const trimmedName = nameDraft.trim();

  useEffect(() => {
    setNameDraft(currentName);
  }, [currentName, version.id]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmedName.length === 0 || trimmedName === currentName || renaming) {
      return;
    }
    onRename(trimmedName);
  };

  return (
    <li style={VERSION_ITEM_STYLE}>
      <div style={VERSION_ROW_STYLE}>
        <span style={VERSION_TITLE_STYLE}>{versionTitle(version)}</span>
        <time style={VERSION_TIME_STYLE} dateTime={version.createdAt}>
          {formatVersionTime(version.createdAt)}
        </time>
      </div>
      <dl style={VERSION_FACTS_STYLE}>
        <VersionFact label="Bytes" value={formatByteSize(version.byteSize)} />
        <VersionFact label="Actor" value={version.actorId ?? "System"} />
        <VersionFact label="Source" value={versionSourceLabel(version)} />
      </dl>
      <form style={NAME_FORM_STYLE} onSubmit={onSubmit}>
        <label style={VERSION_LABEL_STYLE} htmlFor={`docs-version-name-${version.id}`}>
          Name
        </label>
        <input
          id={`docs-version-name-${version.id}`}
          value={nameDraft}
          onChange={(event) => {
            setNameDraft(event.target.value);
          }}
          style={NAME_INPUT_STYLE}
          maxLength={120}
        />
        <button
          className="btn sm"
          type="submit"
          disabled={trimmedName.length === 0 || trimmedName === currentName || renaming}
        >
          Save
        </button>
      </form>
      <div style={ACTION_ROW_STYLE}>
        <button className="btn sm" type="button" disabled={previewing} onClick={onPreview}>
          Preview
        </button>
      </div>
    </li>
  );
}

function VersionPreview({
  preview,
  restoring,
  onRestore,
}: {
  readonly preview: DocsVersionPreview;
  readonly restoring: boolean;
  readonly onRestore: (input: {
    readonly versionId: string;
    readonly expectedCurrentUpdateSeq: number;
  }) => void;
}) {
  const [showChangesOnly, setShowChangesOnly] = useState(false);
  const [compareMode, setCompareMode] = useState<"unified" | "side-by-side">("unified");
  const [restoreReviewAccepted, setRestoreReviewAccepted] = useState(false);
  const stats = diffStats(preview.diff);
  const conflictBlocks = restoreConflictBlocks(preview.diff);
  const restoreReviewRequired = conflictBlocks.length > 0;
  const restoreDisabled =
    !preview.complete || restoring || (restoreReviewRequired && !restoreReviewAccepted);
  const visibleDiff = showChangesOnly
    ? preview.diff.filter((line) => line.kind !== "unchanged")
    : preview.diff;

  useEffect(() => {
    setRestoreReviewAccepted(false);
  }, [preview.currentUpdateSeq, preview.version.id]);

  return (
    <section style={PREVIEW_STYLE} aria-label="Version preview">
      <div style={VERSION_ROW_STYLE}>
        <h3 style={PREVIEW_TITLE_STYLE}>Preview {versionTitle(preview.version)}</h3>
        <span style={VERSION_TIME_STYLE}>
          {preview.complete ? "Complete" : "Best effort"} · {preview.completeness}
        </span>
      </div>
      <dl style={COMPARE_STATS_STYLE} aria-label="Version compare summary">
        <CompareStat label="Added" value={stats.added} tone="added" />
        <CompareStat label="Removed" value={stats.removed} tone="removed" />
        <CompareStat label="Unchanged" value={stats.unchanged} tone="unchanged" />
      </dl>
      {preview.warnings.length > 0 ? (
        <ul style={WARNING_LIST_STYLE}>
          {preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {preview.diff.length > 0 ? (
        <>
          <div style={COMPARE_TOOLBAR_STYLE} aria-label="Version compare view">
            <button
              className={compareMode === "unified" ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={compareMode === "unified"}
              onClick={() => {
                setCompareMode("unified");
              }}
            >
              Unified
            </button>
            <button
              className={compareMode === "side-by-side" ? "btn primary sm" : "btn sm"}
              type="button"
              aria-pressed={compareMode === "side-by-side"}
              onClick={() => {
                setCompareMode("side-by-side");
              }}
            >
              Side by side
            </button>
            {compareMode === "unified" ? (
              <label style={TOGGLE_ROW_STYLE}>
                <input
                  type="checkbox"
                  checked={showChangesOnly}
                  onChange={(event) => {
                    setShowChangesOnly(event.target.checked);
                  }}
                />
                Changes only
              </label>
            ) : null}
          </div>
          {compareMode === "side-by-side" ? (
            <SideBySideCompare preview={preview} />
          ) : visibleDiff.length > 0 ? (
            <ol style={DIFF_LIST_STYLE}>
              {visibleDiff.map((line, index) => (
                <DiffLine key={`${line.kind}-${String(index)}-${line.text}`} line={line} />
              ))}
            </ol>
          ) : (
            <p style={HELP_TEXT_STYLE}>No changed lines</p>
          )}
        </>
      ) : (
        <p style={HELP_TEXT_STYLE}>No text changes</p>
      )}
      {restoreReviewRequired ? (
        <section style={RESTORE_REVIEW_STYLE} aria-label="Restore block conflict review">
          <h4 style={RESTORE_REVIEW_TITLE_STYLE}>Review current-only content</h4>
          <p style={RESTORE_REVIEW_COPY_STYLE}>
            Restoring this version will replace current document text that is not in the selected
            version.
          </p>
          <ol style={RESTORE_BLOCK_LIST_STYLE}>
            {conflictBlocks.map((block, index) => (
              <li
                key={`${String(block.startLine)}-${String(block.endLine)}-${String(index)}`}
                style={RESTORE_BLOCK_ITEM_STYLE}
              >
                <div style={RESTORE_BLOCK_TITLE_STYLE}>
                  {formatConflictBlockTitle(index, block)}
                </div>
                <ol style={RESTORE_REVIEW_LIST_STYLE}>
                  {block.lines.map((line, lineIndex) => (
                    <li key={`${String(lineIndex)}-${line}`}>
                      {line.length === 0 ? "Blank line" : line}
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
          <label style={TOGGLE_ROW_STYLE}>
            <input
              type="checkbox"
              checked={restoreReviewAccepted}
              onChange={(event) => {
                setRestoreReviewAccepted(event.target.checked);
              }}
            />
            I reviewed current-only content
          </label>
        </section>
      ) : null}
      <div style={ACTION_ROW_STYLE}>
        <button
          className="btn sm"
          type="button"
          disabled={restoreDisabled}
          onClick={() => {
            onRestore({
              versionId: preview.version.id,
              expectedCurrentUpdateSeq: preview.currentUpdateSeq,
            });
          }}
        >
          Restore
        </button>
      </div>
    </section>
  );
}

function SideBySideCompare({ preview }: { readonly preview: DocsVersionPreview }) {
  return (
    <div style={SIDE_BY_SIDE_STYLE} aria-label="Side-by-side version compare">
      <ComparePane label="Version" text={preview.versionText} />
      <ComparePane label="Current" text={preview.currentText} />
    </div>
  );
}

function ComparePane({ label, text }: { readonly label: string; readonly text: string }) {
  const lines = textLines(text);
  return (
    <section style={COMPARE_PANE_STYLE} aria-label={`${label} text`}>
      <h4 style={COMPARE_PANE_TITLE_STYLE}>{label}</h4>
      <ol style={COMPARE_PANE_LINES_STYLE}>
        {lines.map((line, index) => (
          <li key={`${label}-${String(index)}-${line}`} style={COMPARE_PANE_LINE_STYLE}>
            <span style={COMPARE_LINE_NUMBER_STYLE}>{String(index + 1)}</span>
            <span>{line.length === 0 ? " " : line}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CompareStat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone: DocsVersionDiffLine["kind"];
}) {
  return (
    <div style={{ ...COMPARE_STAT_STYLE, ...compareStatStyle(tone) }}>
      <dt style={COMPARE_STAT_LABEL_STYLE}>{label}</dt>
      <dd style={COMPARE_STAT_VALUE_STYLE}>{String(value)}</dd>
    </div>
  );
}

function DiffLine({ line }: { readonly line: DocsVersionDiffLine }) {
  return (
    <li style={{ ...DIFF_LINE_STYLE, ...diffLineStyle(line.kind) }}>
      <span style={DIFF_MARK_STYLE}>{diffMark(line.kind)}</span>
      <span>{line.text.length === 0 ? " " : line.text}</span>
    </li>
  );
}

function diffStats(diff: readonly DocsVersionDiffLine[]): {
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
} {
  return diff.reduce(
    (stats, line) => ({
      added: stats.added + (line.kind === "added" ? 1 : 0),
      removed: stats.removed + (line.kind === "removed" ? 1 : 0),
      unchanged: stats.unchanged + (line.kind === "unchanged" ? 1 : 0),
    }),
    { added: 0, removed: 0, unchanged: 0 },
  );
}

function restoreConflictBlocks(
  diff: readonly DocsVersionDiffLine[],
): readonly RestoreConflictBlock[] {
  const blocks: RestoreConflictBlock[] = [];
  let active: { startLine: number; lines: string[] } | null = null;
  let currentLine = 0;

  const flush = (endLine: number) => {
    if (active === null) {
      return;
    }
    blocks.push({
      startLine: active.startLine,
      endLine,
      lines: [...active.lines],
    });
    active = null;
  };

  for (const line of diff) {
    if (line.kind === "removed") {
      flush(currentLine);
      continue;
    }

    currentLine += 1;

    if (line.kind !== "added") {
      flush(currentLine - 1);
      continue;
    }

    if (line.text.trim().length === 0) {
      flush(currentLine - 1);
      blocks.push({
        startLine: currentLine,
        endLine: currentLine,
        lines: [line.text],
      });
      continue;
    }

    if (active === null) {
      active = { startLine: currentLine, lines: [] };
    }
    active.lines.push(line.text);
  }

  flush(currentLine);
  return blocks;
}

function formatConflictBlockTitle(index: number, block: RestoreConflictBlock): string {
  const blockLabel = `Block ${String(index + 1)}`;
  const lineLabel =
    block.startLine === block.endLine
      ? `current line ${String(block.startLine)}`
      : `current lines ${String(block.startLine)}-${String(block.endLine)}`;
  const contentLabel =
    block.lines.length === 1 && block.lines[0]?.trim().length === 0
      ? "blank line"
      : `${String(block.lines.length)} ${block.lines.length === 1 ? "line" : "lines"}`;
  return `${blockLabel} · ${lineLabel} · ${contentLabel}`;
}

function VersionFact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={VERSION_FACT_STYLE}>
      <dt style={VERSION_LABEL_STYLE}>{label}</dt>
      <dd style={VERSION_VALUE_STYLE}>{value}</dd>
    </div>
  );
}

function versionSourceLabel(version: DocsVersion): string {
  const source = version.metadata.source;
  return typeof source === "string" && source.trim().length > 0 ? source.trim() : "Sync";
}

function versionName(version: DocsVersion): string {
  const name = version.metadata.name;
  return typeof name === "string" ? name.trim() : "";
}

function versionTitle(version: DocsVersion): string {
  const name = versionName(version);
  return name.length > 0 ? name : `Update ${String(version.seq)}`;
}

function formatVersionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatByteSize(value: number): string {
  if (value < 1024) {
    return `${String(value)} B`;
  }
  return `${(value / 1024).toFixed(1)} KB`;
}

function textLines(value: string): readonly string[] {
  if (value.length === 0) {
    return [""];
  }
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
}

const RAIL_STYLE = {
  display: "grid",
  gap: 12,
  padding: 14,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface)",
} satisfies CSSProperties;

const RAIL_HEADER_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} satisfies CSSProperties;

const RAIL_TITLE_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const COUNT_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const HELP_TEXT_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const ERROR_TEXT_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  color: "var(--danger, #b91c1c)",
} satisfies CSSProperties;

const VERSION_LIST_STYLE = {
  display: "grid",
  gap: 10,
  margin: 0,
  padding: 0,
  listStyle: "none",
} satisfies CSSProperties;

const VERSION_ITEM_STYLE = {
  display: "grid",
  gap: 8,
  paddingBottom: 10,
  borderBottom: "1px solid var(--border)",
} satisfies CSSProperties;

const VERSION_ROW_STYLE = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
} satisfies CSSProperties;

const VERSION_TITLE_STYLE = {
  fontSize: "var(--text-body-sm)",
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const VERSION_TIME_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
  whiteSpace: "nowrap",
} satisfies CSSProperties;

const VERSION_FACTS_STYLE = {
  display: "grid",
  gap: 4,
  margin: 0,
} satisfies CSSProperties;

const NAME_FORM_STYLE = {
  display: "grid",
  gridTemplateColumns: "48px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
} satisfies CSSProperties;

const ACTION_ROW_STYLE = {
  display: "flex",
  justifyContent: "flex-end",
} satisfies CSSProperties;

const PREVIEW_STYLE = {
  display: "grid",
  gap: 8,
  borderTop: "1px solid var(--border)",
  paddingTop: 10,
} satisfies CSSProperties;

const PREVIEW_TITLE_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const COMPARE_STATS_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 6,
  margin: 0,
} satisfies CSSProperties;

const COMPARE_STAT_STYLE = {
  display: "grid",
  gap: 2,
  minWidth: 0,
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
} satisfies CSSProperties;

const COMPARE_STAT_LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const COMPARE_STAT_VALUE_STYLE = {
  margin: 0,
  fontSize: "var(--text-body-sm)",
  fontWeight: 700,
  color: "var(--text-1)",
} satisfies CSSProperties;

const WARNING_LIST_STYLE = {
  margin: 0,
  paddingInlineStart: 18,
  fontSize: "var(--text-caption)",
  color: "var(--warning, #92400e)",
} satisfies CSSProperties;

const RESTORE_REVIEW_STYLE = {
  display: "grid",
  gap: 6,
  padding: "8px 10px",
  border: "1px solid rgba(185, 28, 28, 0.28)",
  borderRadius: 6,
  background: "rgba(185, 28, 28, 0.06)",
} satisfies CSSProperties;

const RESTORE_REVIEW_TITLE_STYLE = {
  margin: 0,
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  color: "var(--danger, #b91c1c)",
} satisfies CSSProperties;

const RESTORE_REVIEW_COPY_STYLE = {
  margin: 0,
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const RESTORE_BLOCK_LIST_STYLE = {
  display: "grid",
  gap: 6,
  margin: 0,
  maxHeight: 180,
  overflow: "auto",
  paddingInlineStart: 18,
} satisfies CSSProperties;

const RESTORE_BLOCK_ITEM_STYLE = {
  display: "grid",
  gap: 4,
} satisfies CSSProperties;

const RESTORE_BLOCK_TITLE_STYLE = {
  fontSize: "var(--text-caption)",
  fontWeight: 700,
  color: "var(--danger, #b91c1c)",
} satisfies CSSProperties;

const RESTORE_REVIEW_LIST_STYLE = {
  display: "grid",
  gap: 2,
  margin: 0,
  paddingInlineStart: 18,
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  fontSize: "var(--text-caption)",
  color: "var(--danger, #b91c1c)",
} satisfies CSSProperties;

const TOGGLE_ROW_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const COMPARE_TOOLBAR_STYLE = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
} satisfies CSSProperties;

const DIFF_LIST_STYLE = {
  display: "grid",
  gap: 2,
  margin: 0,
  padding: 0,
  listStyle: "none",
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const DIFF_LINE_STYLE = {
  display: "grid",
  gridTemplateColumns: "18px minmax(0, 1fr)",
  gap: 6,
  padding: "3px 6px",
  borderRadius: 4,
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
} satisfies CSSProperties;

const DIFF_MARK_STYLE = {
  color: "inherit",
} satisfies CSSProperties;

const SIDE_BY_SIDE_STYLE = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(160px, 1fr))",
  gap: 8,
  overflowX: "auto",
} satisfies CSSProperties;

const COMPARE_PANE_STYLE = {
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  background: "var(--surface-2)",
  overflow: "hidden",
} satisfies CSSProperties;

const COMPARE_PANE_TITLE_STYLE = {
  margin: 0,
  padding: "6px 8px",
  borderBottom: "1px solid var(--border)",
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;

const COMPARE_PANE_LINES_STYLE = {
  display: "grid",
  gap: 0,
  margin: 0,
  padding: 0,
  listStyle: "none",
  fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

const COMPARE_PANE_LINE_STYLE = {
  display: "grid",
  gridTemplateColumns: "28px minmax(0, 1fr)",
  gap: 6,
  padding: "3px 8px",
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
  color: "var(--text-2)",
} satisfies CSSProperties;

const COMPARE_LINE_NUMBER_STYLE = {
  color: "var(--text-3)",
  userSelect: "none",
} satisfies CSSProperties;

const NAME_INPUT_STYLE = {
  minWidth: 0,
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 8px",
  background: "var(--surface-2)",
  color: "var(--text-1)",
  font: "inherit",
  fontSize: "var(--text-caption)",
} satisfies CSSProperties;

function diffLineStyle(kind: DocsVersionDiffLine["kind"]): CSSProperties {
  if (kind === "added") {
    return { color: "var(--success, #047857)", background: "rgba(4, 120, 87, 0.08)" };
  }
  if (kind === "removed") {
    return { color: "var(--danger, #b91c1c)", background: "rgba(185, 28, 28, 0.08)" };
  }
  return { color: "var(--text-2)" };
}

function compareStatStyle(kind: DocsVersionDiffLine["kind"]): CSSProperties {
  if (kind === "added") {
    return { borderColor: "rgba(4, 120, 87, 0.28)" };
  }
  if (kind === "removed") {
    return { borderColor: "rgba(185, 28, 28, 0.28)" };
  }
  return {};
}

function diffMark(kind: DocsVersionDiffLine["kind"]): string {
  if (kind === "added") return "+";
  if (kind === "removed") return "-";
  return " ";
}

const VERSION_FACT_STYLE = {
  display: "grid",
  gridTemplateColumns: "56px minmax(0, 1fr)",
  gap: 8,
  minWidth: 0,
} satisfies CSSProperties;

const VERSION_LABEL_STYLE = {
  fontSize: "var(--text-caption)",
  color: "var(--text-3)",
} satisfies CSSProperties;

const VERSION_VALUE_STYLE = {
  margin: 0,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-caption)",
  color: "var(--text-2)",
} satisfies CSSProperties;
