/* Renders an ImportedSheet (multi-tab grid) in a read-only viewer.
 *
 * v1 is a simple HTML <table> per tab, with a tab strip at the bottom (matching
 * the native sheets editor's bottom-tab affordance). v2 will mount the native
 * spreadsheet grid component pre-populated with the imported tabs once that
 * component accepts an external `initialTabs` prop.
 */

import { useState } from "react";
import type { ImportedSheet, ImportedSheetTab, ImportedCell } from "../parsers/types.js";
import { driveDownloadHref } from "./viewer-shared";

export interface ImportedSheetRendererProps {
  readonly sheet: ImportedSheet;
  readonly objectId: string;
  readonly fileName?: string;
}

export function ImportedSheetRenderer({ sheet, objectId, fileName }: ImportedSheetRendererProps) {
  const [activeTabId, setActiveTabId] = useState(sheet.tabs[0]?.id ?? "");
  const activeTab = sheet.tabs.find((t) => t.id === activeTabId) ?? sheet.tabs[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <ImportedBanner
        label={sheet.format.label}
        objectId={objectId}
        fileName={fileName}
        warnings={sheet.warnings}
      />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          background: "var(--bg)",
        }}
      >
        {activeTab ? (
          <SheetTable tab={activeTab} />
        ) : (
          <div style={{ padding: 32, textAlign: "center", color: "var(--text-3)" }}>
            Empty workbook
          </div>
        )}
      </div>
      {sheet.tabs.length > 1 ? (
        <div
          style={{
            display: "flex",
            gap: 4,
            padding: "6px 12px",
            borderTop: "1px solid var(--border)",
            background: "var(--surface-2)",
            overflowX: "auto",
          }}
        >
          {sheet.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={tab.id === activeTabId ? "btn primary sm" : "btn sm"}
              onClick={() => setActiveTabId(tab.id)}
            >
              {tab.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SheetTable({ tab }: { readonly tab: ImportedSheetTab }) {
  if (tab.rows.length === 0) {
    return (
      <div style={{ padding: 32, textAlign: "center", color: "var(--text-3)" }}>Empty sheet</div>
    );
  }

  return (
    <table
      style={{
        borderCollapse: "collapse",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "var(--text-caption)",
      }}
    >
      <thead>
        <tr>
          <th
            style={{
              padding: "4px 8px",
              background: "var(--surface-2)",
              border: "1px solid var(--border)",
              minWidth: 40,
            }}
          />
          {tab.rows[0]!.map((_, colIdx) => (
            <th
              key={`col-${String(colIdx)}`}
              style={{
                padding: "4px 8px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                minWidth: 80,
                textAlign: "center",
                color: "var(--text-2)",
              }}
            >
              {colLabel(colIdx)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tab.rows.map((row, rowIdx) => (
          <tr key={`row-${String(rowIdx)}`}>
            <th
              style={{
                padding: "4px 8px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                textAlign: "center",
                color: "var(--text-2)",
              }}
            >
              {rowIdx + 1}
            </th>
            {row.map((cell, colIdx) => (
              <td
                key={`cell-${String(rowIdx)}-${String(colIdx)}`}
                style={{
                  padding: "4px 8px",
                  border: "1px solid var(--border)",
                  whiteSpace: "nowrap",
                  textAlign: typeof cell.value === "number" ? "right" : "left",
                }}
                title={cell.formula !== undefined ? `=${cell.formula}` : undefined}
              >
                {renderCell(cell)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderCell(cell: ImportedCell): string {
  if (cell.value === null) return "";
  if (typeof cell.value === "boolean") return cell.value ? "TRUE" : "FALSE";
  return String(cell.value);
}

/** 0 → "A", 25 → "Z", 26 → "AA", … (spreadsheet column labels). */
function colLabel(n: number): string {
  let label = "";
  let i = n;
  while (i >= 0) {
    label = String.fromCharCode(65 + (i % 26)) + label;
    i = Math.floor(i / 26) - 1;
  }
  return label;
}

function ImportedBanner({
  label,
  objectId,
  fileName,
  warnings,
}: {
  readonly label: string;
  readonly objectId: string;
  readonly fileName?: string;
  readonly warnings: ReadonlyArray<string>;
}) {
  return (
    <div
      role="status"
      style={{
        padding: "12px 24px",
        background: "var(--info-soft, var(--surface-2))",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 240 }}>
        <strong style={{ fontSize: "var(--text-body)" }}>Imported from {label}</strong>
        {fileName !== undefined ? (
          <span style={{ marginLeft: 8, color: "var(--text-2)", fontSize: "var(--text-caption)" }}>
            <code>{fileName}</code>
          </span>
        ) : null}
        {warnings.length > 0 ? (
          <p
            style={{
              margin: "4px 0 0 0",
              fontSize: "var(--text-caption)",
              color: "var(--text-2)",
              lineHeight: 1.4,
            }}
          >
            {warnings[0]}
          </p>
        ) : null}
      </div>
      <a href={driveDownloadHref(objectId)} className="btn sm" download={fileName ?? ""}>
        Download original
      </a>
    </div>
  );
}
