/* SheetsList — the Sheets list view.

   Reads spreadsheets from the `sheets.list` tool via TanStack Query and
   merges them ahead of the typed seed (offline fallback). The per-row
   more-actions menu runs `sheets.delete`. Mirrors the Docs list layout:
   a "Recent" thumbnail grid and an "All spreadsheets" table. */

import { useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { deleteSheet, isBackendSheetsId } from "./api";
import { mergeDriveSheets, type SheetListRow } from "./model";
import { sheetsListFromDriveQueryOptions, sheetsQueryKeys } from "./queries";
import { SHEETS_LIST } from "./seed";

export interface SheetsListProps {
  /** Optional case-insensitive filter applied to the spreadsheet title. */
  query?: string;
  /** Opens a spreadsheet in the editor. */
  onOpen: (id: string) => void;
  /** Runs the `sheets.create` tool. */
  onCreate?: () => void;
  /** True while a create is in flight. */
  isCreating?: boolean;
  /** Surfaced when a create fails. */
  createError?: string | null;
}

const GRID_COLUMNS = "1fr 160px 140px 80px 32px";

const thumbStyle: CSSProperties = {
  aspectRatio: "8 / 11",
  background: "var(--surface-2)",
  borderRadius: 4,
  padding: 8,
  overflow: "hidden",
  border: "1px solid var(--border)",
  backgroundImage:
    "linear-gradient(to right, var(--border) 1px, transparent 1px), linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
  backgroundSize: "calc(100% / 5) 14px, 100% 14px",
};

const noticeStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 12px",
  marginBottom: 16,
  fontSize: 12,
  color: "var(--text-2)",
  background: "var(--warning-soft)",
  borderRadius: 6,
};

export function SheetsList({
  query = "",
  onOpen,
  onCreate,
  isCreating = false,
  createError,
}: SheetsListProps) {
  const normalized = query.trim().toLowerCase();
  const queryClient = useQueryClient();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const sheetsQuery = useQuery(sheetsListFromDriveQueryOptions({ limit: 100 }));
  const isBackendUnavailable = sheetsQuery.isError;

  const deleteMutation = useMutation({
    mutationFn: (sheetId: string) => deleteSheet({ sheetId }),
    onMutate: () => {
      setDeleteError(null);
    },
    onError: (error: unknown) => {
      setDeleteError(error instanceof Error ? error.message : String(error));
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: sheetsQueryKeys.all }),
  });

  const merged = mergeDriveSheets(SHEETS_LIST, sheetsQuery.data);
  const sheets: readonly SheetListRow[] = normalized
    ? merged.filter((sheet) => sheet.title.toLowerCase().includes(normalized))
    : merged;

  const createErrorMessage = createError ?? undefined;
  const deleteErrorMessage = deleteError ?? undefined;

  return (
    <div
      className="flex-1"
      style={{ overflowY: "auto", padding: "24px 32px", background: "var(--bg)" }}
    >
      <div style={{ display: "flex", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Spreadsheets</h1>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button type="button" className="btn">
            <Icons.Filter /> Filter
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={isCreating}
            onClick={() => onCreate?.()}
          >
            <Icons.Plus /> {isCreating ? "Creating…" : "New sheet"}
          </button>
        </div>
      </div>

      {isBackendUnavailable ? (
        <div role="status" style={noticeStyle}>
          <Icons.Globe />
          Sheets backend unavailable — showing seeded spreadsheets only.
        </div>
      ) : null}

      {createErrorMessage !== undefined ? (
        <div
          role="alert"
          style={{ ...noticeStyle, background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          <Icons.X />
          Could not create spreadsheet: {createErrorMessage}
        </div>
      ) : null}

      {deleteErrorMessage !== undefined ? (
        <div
          role="alert"
          style={{ ...noticeStyle, background: "var(--danger-soft)", color: "var(--danger)" }}
        >
          <Icons.X />
          Could not delete spreadsheet: {deleteErrorMessage}
        </div>
      ) : null}

      {sheetsQuery.isLoading ? (
        <div className="empty" role="status">
          <Icons.Sheet size={28} />
          <div>Loading spreadsheets…</div>
        </div>
      ) : sheets.length === 0 ? (
        <div className="empty">
          <Icons.Search size={28} />
          <div>
            {normalized
              ? `No spreadsheets match “${query}”.`
              : "No spreadsheets yet — create your first one."}
          </div>
        </div>
      ) : (
        <>
          {!normalized && (
            <>
              <div className="section-label" style={{ padding: "0 0 8px" }}>
                Recent
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: 12,
                  marginBottom: 24,
                }}
              >
                {sheets.slice(0, 4).map((sheet) => (
                  <button
                    key={sheet.id}
                    type="button"
                    onClick={() => onOpen(sheet.id)}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: 12,
                      textAlign: "left",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    <div style={thumbStyle}>
                      <div style={{ fontSize: 6, fontWeight: 600, color: "var(--text-2)" }}>
                        {sheet.title.split(" ")[0]}
                      </div>
                    </div>
                    <div>
                      <div
                        className="truncate"
                        style={{ fontSize: 12, fontWeight: 500, marginBottom: 2 }}
                      >
                        {sheet.title}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-3)" }}>{sheet.modified}</div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="section-label" style={{ padding: "0 0 8px" }}>
            All spreadsheets
          </div>
          <div className="panel">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: GRID_COLUMNS,
                padding: "8px 16px",
                fontSize: 11,
                color: "var(--text-3)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: ".06em",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span>Name</span>
              <span>Owner</span>
              <span>Modified</span>
              <span>Shared</span>
              <span />
            </div>
            {sheets.map((sheet) => (
              <SheetRow
                key={sheet.id}
                sheet={sheet}
                onOpen={onOpen}
                onDelete={(id) => deleteMutation.mutate(id)}
                isDeleting={deleteMutation.isPending && deleteMutation.variables === sheet.id}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface SheetRowProps {
  readonly sheet: SheetListRow;
  readonly onOpen: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly isDeleting: boolean;
}

function SheetRow({ sheet, onOpen, onDelete, isDeleting }: SheetRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const canDelete = isBackendSheetsId(sheet.id);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="list-row"
        onClick={() => onOpen(sheet.id)}
        disabled={isDeleting}
        style={{
          display: "grid",
          gridTemplateColumns: GRID_COLUMNS,
          padding: "0 16px",
          height: 36,
          alignItems: "center",
          fontSize: 12,
          width: "100%",
          textAlign: "left",
          borderBottom: "1px solid var(--border)",
          opacity: isDeleting ? 0.5 : 1,
        }}
      >
        <div className="row gap-2" style={{ minWidth: 0 }}>
          <span style={{ color: "#059669", display: "flex" }}>
            <Icons.Sheet />
          </span>
          <span className="truncate">{sheet.title}</span>
        </div>
        <div className="row gap-2" style={{ minWidth: 0 }}>
          <Avatar name={sheet.owner} size={18} />
          <span className="truncate">{sheet.owner}</span>
        </div>
        <span style={{ color: "var(--text-2)" }}>{sheet.modified}</span>
        <span style={{ color: "var(--text-2)" }}>{sheet.shared} people</span>
        <span
          role="button"
          tabIndex={-1}
          className="icon-btn"
          aria-label={`More actions for ${sheet.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <Icons.MoreV />
        </span>
      </button>

      {menuOpen ? (
        <div
          role="menu"
          style={{
            position: "absolute",
            right: 12,
            top: 32,
            zIndex: 10,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 8px 24px rgba(0,0,0,.18)",
            minWidth: 160,
            padding: 4,
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            disabled={!canDelete}
            title={canDelete ? undefined : "Seeded sample — not stored on the backend"}
            onClick={() => {
              setMenuOpen(false);
              onDelete(sheet.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 8px",
              fontSize: 12,
              textAlign: "left",
              borderRadius: 4,
              color: canDelete ? "var(--danger)" : "var(--text-3)",
              background: "transparent",
            }}
          >
            <Icons.Trash /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}
