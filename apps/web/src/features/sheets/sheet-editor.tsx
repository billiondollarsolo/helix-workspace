/* SheetEditor — the Sheets editor.

   Backend-wired: `sheets.get` loads the spreadsheet + its tabs, `sheets.tab.get`
   loads the active tab's sparse cells (rendered as a dense grid), inline cell
   edits persist through the `sheets.cells.update` batch tool, the title row
   renames via `sheets.update`, and the bottom tab strip runs
   `sheets.tab.create` / `sheets.tab.update` / `sheets.tab.delete`.

   When the sheet id is not a backend UUID (a seeded sample), the editor
   renders the typed seed offline — edits stay local and are not persisted. */

import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Dialog } from "@/components/ui/helix-dialog";
import {
  createSheetTab,
  deleteSheetTab,
  isBackendSheetsId,
  updateSheet,
  updateSheetCells,
  updateSheetTab,
  type SheetsApiTab,
} from "./api";
import { cloneGrid, diffCellEdit, gridFromCells, type EditableGrid } from "./model";
import { sheetQueryOptions, sheetsQueryKeys, sheetTabQueryOptions } from "./queries";
import {
  ARR_COLUMN,
  cellReference,
  columnLetter,
  HEALTH_COLUMN,
  SHEET_DATA,
  SHEET_TABS,
  SHEETS_LIST,
  sumArr,
} from "./seed";

export interface SheetEditorProps {
  /** The spreadsheet id being edited. */
  sheetId: string;
  /** Returns to the list view. */
  onBack: () => void;
}

const CELL_TYPES = ["$ USD", "Number", "Percent", "Date"] as const;
const FX_ACTIONS = ["fx Σ Sum", "Filter", "Sort"] as const;
const SPACER_ROWS = 30;
const ROW_HEIGHT = 26;
const HEADER_HEIGHT = 22;
const ROW_NUM_WIDTH = 40;
const DEFAULT_COL_WIDTH = 130;

const HEALTH_COLORS: Readonly<Record<string, string>> = {
  Green: "#059669",
  Yellow: "#ea580c",
  Red: "#dc2626",
};

const rowNumberStyle: CSSProperties = {
  width: ROW_NUM_WIDTH,
  height: ROW_HEIGHT,
  fontSize: 11,
  color: "var(--text-3)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderBottom: "1px solid var(--border)",
  borderRight: "1px solid var(--border)",
  background: "var(--surface-2)",
};

/** A tab descriptor agnostic of seed vs. backend origin. */
interface EditorTab {
  readonly id: string;
  readonly name: string;
}

export function SheetEditor({ sheetId, onBack }: SheetEditorProps) {
  const isBackend = isBackendSheetsId(sheetId);
  const queryClient = useQueryClient();

  const sheetQuery = useQuery(sheetQueryOptions(sheetId, isBackend));

  // Seed fallback when offline / seeded sample.
  const seedMeta = useMemo(
    () => SHEETS_LIST.find((sheet) => sheet.id === sheetId) ?? SHEETS_LIST[0]!,
    [sheetId],
  );

  const tabs: readonly EditorTab[] = useMemo(() => {
    const backendTabs = sheetQuery.data?.tabs;
    if (backendTabs !== undefined && backendTabs.length > 0) {
      return [...backendTabs]
        .sort((a, b) => a.position - b.position)
        .map((tab) => ({ id: tab.id, name: tab.name }));
    }
    return SHEET_TABS.map((tab) => ({ id: tab.id, name: tab.name }));
  }, [sheetQuery.data?.tabs]);

  const title = sheetQuery.data?.title ?? seedMeta.title;
  const backendUnavailable = isBackend && sheetQuery.isError;

  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0]?.id ?? "");
  const [activeCell, setActiveCell] = useState<readonly [number, number]>([1, 0]);
  const [editing, setEditing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [tabMenuId, setTabMenuId] = useState<string | null>(null);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [cellError, setCellError] = useState<string | null>(null);
  const [tabError, setTabError] = useState<string | null>(null);

  // Keep a valid active tab when the tab set changes.
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(tabs[0]!.id);
    }
  }, [tabs, activeTabId]);

  const activeTabIsBackend = isBackendSheetsId(activeTabId);
  const tabCellsQuery = useQuery(sheetTabQueryOptions(activeTabIsBackend ? activeTabId : null));

  // The dense grid currently rendered. Backend grids come from `sheets.tab.get`;
  // seed grids come from the typed seed module. Local edits are layered on top.
  const [localGrids, setLocalGrids] = useState<Record<string, EditableGrid>>({});

  const baseGrid: EditableGrid = useMemo(() => {
    if (activeTabIsBackend) {
      const cells = tabCellsQuery.data?.cells;
      return cells !== undefined ? gridFromCells(cells) : [];
    }
    return cloneGrid(SHEET_DATA[activeTabId] ?? []);
  }, [activeTabIsBackend, activeTabId, tabCellsQuery.data?.cells]);

  const data: EditableGrid = localGrids[activeTabId] ?? baseGrid;
  const [activeRow, activeCol] = activeCell;
  const totalArr = useMemo(() => sumArr(data), [data]);
  const colCount = data.reduce((max, row) => Math.max(max, row.length), 1);
  const colWidths = useMemo(
    () => Array.from({ length: colCount }, () => DEFAULT_COL_WIDTH),
    [colCount],
  );

  const cellsMutation = useMutation({
    mutationFn: (input: { tabId: string; row: number; col: number; value: string }) =>
      updateSheetCells({
        tabId: input.tabId,
        edits: [{ row: input.row, col: input.col, value: input.value }],
      }),
    onMutate: () => {
      setCellError(null);
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.tab(input.tabId) });
    },
    onError: (error: unknown) => {
      setCellError(errorMessage(error));
    },
  });

  const renameMutation = useMutation({
    mutationFn: (nextTitle: string) => updateSheet({ sheetId, title: nextTitle }),
    onMutate: () => {
      setCellError(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.list() });
    },
    onError: (error: unknown) => {
      setCellError(errorMessage(error));
    },
  });

  const createTabMutation = useMutation({
    mutationFn: () =>
      createSheetTab({ sheetId, name: `Sheet ${String(tabs.length + 1)}`, position: tabs.length }),
    onMutate: () => {
      setTabError(null);
    },
    onSuccess: (tab: SheetsApiTab) => {
      void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
      setActiveTabId(tab.id);
    },
    onError: (error: unknown) => {
      setTabError(errorMessage(error));
    },
  });

  const renameTabMutation = useMutation({
    mutationFn: (input: { tabId: string; name: string }) =>
      updateSheetTab({ tabId: input.tabId, name: input.name }),
    onMutate: () => {
      setTabError(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
    },
    onError: (error: unknown) => {
      setTabError(errorMessage(error));
    },
  });

  const deleteTabMutation = useMutation({
    mutationFn: (tabId: string) => deleteSheetTab({ tabId }),
    onMutate: () => {
      setTabError(null);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.sheet(sheetId) });
    },
    onError: (error: unknown) => {
      setTabError(errorMessage(error));
    },
  });

  const updateLocalCell = (tabId: string, row: number, col: number, value: string) => {
    setLocalGrids((current) => {
      const grid = current[tabId] ?? cloneGrid(data);
      const next = grid.map((r, ri) => (ri === row ? [...r] : r));
      while (next.length <= row) {
        next.push([]);
      }
      const targetRow = next[row] ?? [];
      while (targetRow.length <= col) {
        targetRow.push("");
      }
      targetRow[col] = value;
      next[row] = targetRow;
      return { ...current, [tabId]: next };
    });
  };

  /** Commit a cell value: update local view, then persist to the backend. */
  const commitCell = (row: number, col: number, value: string) => {
    const diff = diffCellEdit(data, row, col, value);
    if (diff === null) {
      return;
    }
    updateLocalCell(activeTabId, row, col, value);
    if (activeTabIsBackend) {
      cellsMutation.mutate({ tabId: activeTabId, row, col, value });
    }
  };

  const selectCell = (row: number, col: number) => {
    setActiveCell([row, col]);
    setEditing(false);
  };

  const reference = cellReference(activeRow, activeCol);
  const formulaValue = data[activeRow]?.[activeCol] ?? "";

  const commitEdit = (
    event: KeyboardEvent<HTMLInputElement>,
    row: number,
    col: number,
  ) => {
    if (event.key === "Enter") {
      commitCell(row, col, event.currentTarget.value);
      setEditing(false);
    } else if (event.key === "Escape") {
      setEditing(false);
    }
  };

  const savingLabel = cellsMutation.isPending
    ? "Saving…"
    : cellsMutation.isError
      ? "Save failed"
      : "Saved";

  return (
    <div
      className="flex-1"
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        background: "var(--surface)",
      }}
    >
      {/* Doc title row */}
      <div
        style={{
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--surface)",
        }}
      >
        <button
          type="button"
          className="icon-btn"
          onClick={onBack}
          aria-label="Back to spreadsheets"
        >
          <Icons.ArrowLeft />
        </button>
        <span style={{ color: "#059669", display: "flex" }}>
          <Icons.Sheet />
        </span>
        {renaming && isBackend ? (
          <input
            aria-label="Spreadsheet title"
            defaultValue={title}
            ref={(node) => node?.focus()}
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next.length > 0 && next !== title) {
                renameMutation.mutate(next);
              }
              setRenaming(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setRenaming(false);
              }
            }}
            style={{
              fontSize: 13,
              fontWeight: 600,
              border: "1px solid var(--accent)",
              borderRadius: 4,
              padding: "2px 6px",
              background: "var(--surface)",
            }}
          />
        ) : (
          <button
            type="button"
            className="sheets-title-button"
            onClick={() => isBackend && setRenaming(true)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: isBackend ? "text" : "default",
            }}
          >
            {title}
          </button>
        )}
        <span className="chip" role="status">
          {renameMutation.isPending ? "Renaming…" : savingLabel}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <button type="button" className="btn sm" aria-label="Version history">
            <Icons.History />
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => setShareOpen(true)}
          >
            <Icons.Users /> Share
          </button>
        </span>
      </div>

      {backendUnavailable ? (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 16px",
            fontSize: 12,
            color: "var(--text-2)",
            background: "var(--warning-soft)",
          }}
        >
          <Icons.Globe />
          Sheets backend unavailable — edits in this view are not being saved.
        </div>
      ) : null}

      {cellError !== null ? (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 16px",
            fontSize: 12,
            color: "var(--danger)",
            background: "var(--danger-soft)",
          }}
        >
          <Icons.X />
          Could not save change: {cellError}
        </div>
      ) : null}

      {tabError !== null ? (
        <div
          role="alert"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 16px",
            fontSize: 12,
            color: "var(--danger)",
            background: "var(--danger-soft)",
          }}
        >
          <Icons.X />
          Could not update tab: {tabError}
        </div>
      ) : null}

      {/* Toolbar */}
      <div
        style={{
          height: 36,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 4,
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <button type="button" className="icon-btn" aria-label="Bold">
          <Icons.Bold />
        </button>
        <button type="button" className="icon-btn" aria-label="Italic">
          <Icons.Italic />
        </button>
        <button type="button" className="icon-btn" aria-label="Underline">
          <Icons.Underline />
        </button>
        <div className="v-divider" style={{ height: 18, margin: "0 4px" }} />
        <select
          className="select"
          aria-label="Cell type"
          style={{ width: 90, height: 24, fontSize: 11 }}
        >
          {CELL_TYPES.map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
        <div className="v-divider" style={{ height: 18, margin: "0 4px" }} />
        {FX_ACTIONS.map((action) => (
          <button key={action} type="button" className="btn sm">
            {action}
          </button>
        ))}
        <button type="button" className="btn sm">
          <Icons.Sparkles /> Helix AI
        </button>
      </div>

      {/* Formula bar */}
      <div
        style={{
          height: 28,
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          gap: 8,
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          fontSize: 12,
        }}
      >
        <span className="mono" style={{ minWidth: 50, color: "var(--text-3)" }}>
          {reference}
        </span>
        <span className="mono" style={{ color: "var(--text-3)" }}>
          fx
        </span>
        <input
          aria-label={`Formula for ${reference}`}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 12,
          }}
          value={formulaValue}
          onChange={(event) =>
            updateLocalCell(activeTabId, activeRow, activeCol, event.target.value)
          }
          onBlur={(event) => commitCell(activeRow, activeCol, event.target.value)}
        />
      </div>

      {/* Grid */}
      <div className="flex-1" style={{ overflow: "auto", background: "var(--surface)" }}>
        {tabCellsQuery.isLoading && activeTabIsBackend ? (
          <div className="empty" role="status">
            <Icons.Sheet size={28} />
            <div>Loading cells…</div>
          </div>
        ) : (
          <div style={{ display: "inline-block", minWidth: "100%" }}>
            {/* Column headers */}
            <div
              style={{
                display: "flex",
                position: "sticky",
                top: 0,
                zIndex: 2,
                background: "var(--surface-2)",
              }}
            >
              <div
                style={{
                  width: ROW_NUM_WIDTH,
                  height: HEADER_HEIGHT,
                  borderBottom: "1px solid var(--border)",
                  borderRight: "1px solid var(--border)",
                  position: "sticky",
                  left: 0,
                  zIndex: 1,
                  background: "var(--surface-2)",
                }}
              />
              {colWidths.map((width, col) => (
                <div
                  key={col}
                  style={{
                    width,
                    height: HEADER_HEIGHT,
                    padding: "0 8px",
                    fontSize: 11,
                    color: "var(--text-3)",
                    fontWeight: 500,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderBottom: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    background:
                      activeCol === col ? "var(--accent-soft)" : "var(--surface-2)",
                  }}
                >
                  {columnLetter(col)}
                </div>
              ))}
            </div>

            {/* Data rows */}
            {data.map((row, r) => (
              <div key={r} style={{ display: "flex" }}>
                <div
                  style={{
                    ...rowNumberStyle,
                    background:
                      activeRow === r ? "var(--accent-soft)" : "var(--surface-2)",
                    position: "sticky",
                    left: 0,
                    zIndex: 1,
                  }}
                >
                  {r + 1}
                </div>
                {colWidths.map((width, c) => {
                  const cell = row[c] ?? "";
                  const isHeader = r === 0;
                  const isActive = activeRow === r && activeCol === c;
                  const isHealth = c === HEALTH_COLUMN && !isHeader;
                  const healthColor = HEALTH_COLORS[cell] ?? "transparent";
                  return (
                    <div
                      key={c}
                      role="gridcell"
                      aria-selected={isActive}
                      onClick={() => selectCell(r, c)}
                      onDoubleClick={() => {
                        setActiveCell([r, c]);
                        setEditing(true);
                      }}
                      style={{
                        width,
                        height: ROW_HEIGHT,
                        padding: "0 8px",
                        fontSize: 12,
                        fontWeight: isHeader ? 600 : 400,
                        color: isHeader ? "var(--text-2)" : "var(--text)",
                        background: isHeader ? "var(--surface-2)" : "var(--surface)",
                        borderBottom: "1px solid var(--border)",
                        borderRight: "1px solid var(--border)",
                        outline: isActive ? "2px solid var(--accent)" : "none",
                        outlineOffset: -2,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        cursor: "cell",
                        overflow: "hidden",
                      }}
                    >
                      {isHealth && cell !== "" && (
                        <span
                          aria-hidden="true"
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 999,
                            background: healthColor,
                            flexShrink: 0,
                          }}
                        />
                      )}
                      {editing && isActive ? (
                        <input
                          ref={(node) => node?.focus()}
                          aria-label={`Edit cell ${cellReference(r, c)}`}
                          defaultValue={cell}
                          onBlur={(event) => {
                            commitCell(r, c, event.target.value);
                            setEditing(false);
                          }}
                          onKeyDown={(event) => commitEdit(event, r, c)}
                          style={{
                            width: "100%",
                            border: "none",
                            outline: "none",
                            background: "transparent",
                            fontSize: 12,
                          }}
                        />
                      ) : (
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {cell}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Totals row */}
            <div style={{ display: "flex", background: "var(--accent-soft)" }}>
              <div style={rowNumberStyle}>{data.length + 1}</div>
              <div
                style={{
                  width: colWidths[0] ?? DEFAULT_COL_WIDTH,
                  height: ROW_HEIGHT,
                  padding: "0 8px",
                  fontSize: 12,
                  fontWeight: 600,
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid var(--border)",
                  borderRight: "1px solid var(--border)",
                }}
              >
                Total ARR
              </div>
              <div
                style={{
                  width: colWidths[ARR_COLUMN] ?? DEFAULT_COL_WIDTH,
                  height: ROW_HEIGHT,
                  padding: "0 8px",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--accent)",
                  display: "flex",
                  alignItems: "center",
                  borderBottom: "1px solid var(--border)",
                  borderRight: "1px solid var(--border)",
                }}
              >
                ${totalArr.toLocaleString()}
              </div>
              {colWidths.slice(2).map((width, i) => (
                <div
                  key={i}
                  style={{
                    width,
                    height: ROW_HEIGHT,
                    borderBottom: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                  }}
                />
              ))}
            </div>

            {/* Spacer rows */}
            {Array.from({ length: SPACER_ROWS }).map((_, r) => (
              <div key={`spacer-${String(r)}`} style={{ display: "flex" }}>
                <div style={rowNumberStyle}>{data.length + 2 + r}</div>
                {colWidths.map((width, c) => (
                  <div
                    key={c}
                    style={{
                      width,
                      height: ROW_HEIGHT,
                      borderBottom: "1px solid var(--border)",
                      borderRight: "1px solid var(--border)",
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sheet tabs */}
      <div
        style={{
          height: 32,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          gap: 2,
          borderTop: "1px solid var(--border)",
          background: "var(--surface-2)",
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTabId === tab.id;
          const isRenaming = renamingTabId === tab.id;
          return (
            <div key={tab.id} style={{ position: "relative" }}>
              {isRenaming ? (
                <input
                  aria-label={`Rename tab ${tab.name}`}
                  defaultValue={tab.name}
                  ref={(node) => node?.select()}
                  onBlur={(event) => {
                    const next = event.target.value.trim();
                    if (next.length > 0 && next !== tab.name) {
                      renameTabMutation.mutate({ tabId: tab.id, name: next });
                    }
                    setRenamingTabId(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    } else if (event.key === "Escape") {
                      setRenamingTabId(null);
                    }
                  }}
                  style={{
                    height: 24,
                    width: 110,
                    padding: "0 8px",
                    borderRadius: 4,
                    fontSize: 12,
                    border: "1px solid var(--accent)",
                    background: "var(--surface)",
                  }}
                />
              ) : (
                <button
                  type="button"
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => {
                    setActiveTabId(tab.id);
                    setActiveCell([1, 0]);
                    setEditing(false);
                  }}
                  onDoubleClick={() => isBackend && setTabMenuId(tab.id)}
                  style={{
                    height: 24,
                    padding: "0 12px",
                    borderRadius: 4,
                    fontSize: 12,
                    background: isActive ? "var(--surface)" : "transparent",
                    border: isActive
                      ? "1px solid var(--border)"
                      : "1px solid transparent",
                    color: isActive ? "var(--text)" : "var(--text-2)",
                    fontWeight: isActive ? 500 : 400,
                  }}
                >
                  {tab.name}
                </button>
              )}
              {tabMenuId === tab.id && isBackendSheetsId(tab.id) ? (
                <div
                  role="menu"
                  style={{
                    position: "absolute",
                    bottom: 28,
                    left: 0,
                    zIndex: 20,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    boxShadow: "0 8px 24px rgba(0,0,0,.18)",
                    minWidth: 140,
                    padding: 4,
                  }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setTabMenuId(null);
                      setRenamingTabId(tab.id);
                    }}
                    style={menuItemStyle}
                  >
                    <Icons.EditPen /> Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="menu-item"
                    disabled={tabs.length <= 1}
                    onClick={() => {
                      setTabMenuId(null);
                      deleteTabMutation.mutate(tab.id);
                    }}
                    style={{ ...menuItemStyle, color: "var(--danger)" }}
                  >
                    <Icons.Trash /> Delete
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
        <button
          type="button"
          className="icon-btn"
          aria-label="Add sheet"
          disabled={!isBackend || createTabMutation.isPending}
          onClick={() => createTabMutation.mutate()}
        >
          <Icons.Plus />
        </button>
      </div>

      {shareOpen && (
        <Dialog
          title={`Share “${title}”`}
          onClose={() => setShareOpen(false)}
          footer={
            <button
              type="button"
              className="btn primary"
              onClick={() => setShareOpen(false)}
            >
              Done
            </button>
          }
        >
          <div style={{ fontSize: 13, color: "var(--text-2)" }}>
            This spreadsheet is shared with {seedMeta.shared} people. Owned by {seedMeta.owner}.
          </div>
        </Dialog>
      )}
    </div>
  );
}

const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  fontSize: 12,
  textAlign: "left",
  borderRadius: 4,
  background: "transparent",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
