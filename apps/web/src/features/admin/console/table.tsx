/** Shared Admin table: TanStack ordering, shared styles, and windowed large lists. */

import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** What a sortable column compares on. Returning a string sorts with
 *  `localeCompare` so accented names land where a reader expects; numbers and
 *  dates sort numerically. `null` sorts last in both directions — an absent
 *  value is not "before A", it is unknown. */
type AdminSortValue = string | number | null;

export interface AdminColumn<TRow> {
  /** Stable id — also the React key for the cell and the sort key. */
  readonly id: string;
  /** Column caption. Rendered in the console's one caption treatment. */
  readonly header: ReactNode;
  readonly cell: (row: TRow) => ReactNode;
  /** `right` for counts and money, so figures line up on the decimal. */
  readonly align?: "left" | "right";
  /** Optional fixed width, e.g. `"120px"`. Omit to size to content. */
  readonly width?: string;
  /** Hide the caption visually but keep it for assistive tech — for the
   *  actions column, where a visible "Actions" heading is noise. */
  readonly headerHidden?: boolean;
  /** Makes the column sortable. The value a row contributes to the ordering —
   *  deliberately separate from `cell`, because what you sort on is rarely what
   *  you render (a status chip sorts on its status, not its JSX). */
  readonly sortValue?: (row: TRow) => AdminSortValue;
}

type SortDirection = "asc" | "desc";

const ARIA_SORT: Record<SortDirection, "ascending" | "descending"> = {
  asc: "ascending",
  desc: "descending",
};

/* ------------------------------------------------------------------ */
/* VIRTUALIZATION                                                      */
/* ------------------------------------------------------------------ */

/* Below this many rows the table renders as plain DOM.
 *
 * Virtualizing a ten-row table costs a scroll container, a measured height and
 * two padding rows to save nothing. The threshold also keeps every existing
 * section — and its tests — on the simple path, so this capability is opt-in by
 * data volume rather than a change every caller has to absorb. */
const VIRTUALIZE_ABOVE = 60;

/** Fallback row height before anything is measured. Matches the density token's
 *  default value; the virtualizer re-measures from the real DOM immediately. */
const ESTIMATED_ROW_HEIGHT = 36;

export function AdminTable<TRow>({
  /** Names the table for assistive tech. Required, not optional: a table
   *  announced only as "table" is the defect this replaces. */
  label,
  columns,
  rows,
  rowKey,
  /** Rendered as a single full-width row when `rows` is empty. Callers pass
   *  `EmptyRow`/`EmptyState` — an empty table with no explanation reads as a
   *  broken one. */
  empty,
  /** Shown beside the sorted column's caption when the rows on screen are not
   *  the whole set — a directory that has paged 250 of 350 sorts 250 of 350,
   *  and presenting that as "sorted by name" is the same class of lie as the
   *  client-side search this console already removed. */
  partialNote,
  /** Cap for the scroll container once virtualization kicks in. */
  maxHeight = "60vh",
  searchText,
}: {
  readonly label: string;
  readonly columns: readonly AdminColumn<TRow>[];
  readonly rows: readonly TRow[];
  readonly rowKey: (row: TRow) => string;
  readonly empty?: ReactNode;
  readonly partialNote?: string;
  readonly maxHeight?: string;
  /** Explicit searchable display fields; never pass a credential or secret. */
  readonly searchText?: (row: TRow) => string;
}) {
  const [search, setSearch] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const definitions = useMemo<ColumnDef<TRow>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        accessorFn:
          column.sortValue === undefined
            ? undefined
            : (row: TRow) => column.sortValue?.(row) ?? undefined,
        enableSorting: column.sortValue !== undefined,
        sortDescFirst: false,
        sortUndefined: "last",
        sortingFn: (left, right, id) => {
          const a = left.getValue<AdminSortValue>(id);
          const b = right.getValue<AdminSortValue>(id);
          return typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b), undefined, { numeric: true });
        },
      })),
    [columns],
  );
  const data = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return searchText && query
      ? rows.filter((row) => searchText(row).toLocaleLowerCase().includes(query))
      : [...rows];
  }, [rows, search, searchText]);
  const table = useReactTable({
    data,
    columns: definitions,
    getRowId: rowKey,
    state: { sorting },
    onSortingChange: setSorting,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const sortedRows = table.getRowModel().rows.map((row) => row.original);
  const sort = sorting[0];
  const sortOptions = columns
    .filter((column) => column.sortValue)
    .flatMap((column) =>
      [false, true].map((desc) => ({
        id: column.id,
        desc,
        value: `${column.id}:${String(desc)}`,
        label: `${typeof column.header === "string" ? column.header : column.id} (${desc ? "descending" : "ascending"})`,
      })),
    );

  const virtualized = sortedRows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 12,
    enabled: virtualized,
  });

  const measuredRows = virtualized ? virtualizer.getVirtualItems() : [];
  const virtualRows =
    measuredRows.length || !virtualized
      ? measuredRows
      : sortedRows.slice(0, 20).map((_, index) => ({
          index,
          start: index * ESTIMATED_ROW_HEIGHT,
          end: (index + 1) * ESTIMATED_ROW_HEIGHT,
        }));
  const paddingTop = virtualRows[0]?.start ?? 0;
  const lastRow = virtualRows[virtualRows.length - 1];
  const paddingBottom = lastRow === undefined ? 0 : virtualizer.getTotalSize() - lastRow.end;
  const visibleRows = virtualized
    ? virtualRows.map((item) => ({ row: sortedRows[item.index], index: item.index }))
    : sortedRows.map((row, index) => ({ row, index }));

  const body = (
    <Table aria-label={label} className="admin-table">
      <TableHeader>
        <TableRow>
          {columns.map((column) => {
            const sortable = column.sortValue !== undefined;
            const active = sort?.id === column.id;
            const caption =
              column.headerHidden === true ? (
                <span className="sr-only">{column.header}</span>
              ) : (
                column.header
              );
            return (
              <TableHead
                key={column.id}
                scope="col"
                className="admin-table-head"
                style={column.width === undefined ? undefined : { width: column.width }}
                data-align={column.align ?? "left"}
                /* `none` on a sortable column, absent on one that cannot sort —
                   announcing "not sorted" for a column that never sorts is
                   noise, not information. */
                aria-sort={
                  sortable ? (active ? ARIA_SORT[sort?.desc ? "desc" : "asc"] : "none") : undefined
                }
              >
                {sortable ? (
                  <>
                    <span className="admin-table-mobile-caption">{caption}</span>
                    <button
                      type="button"
                      className="admin-table-sort"
                      aria-label={
                        typeof column.header === "string"
                          ? `${column.header}${active && partialNote ? `. ${partialNote}` : ""}`
                          : undefined
                      }
                      onClick={() => {
                        table.getColumn(column.id)?.toggleSorting();
                      }}
                    >
                      {caption}
                      {/* The direction indicator is drawn by CSS from `aria-sort`
                        on the header — decorative by construction, so it stays
                        out of the cell's text content and out of the accessible
                        name, which is just the caption. */}
                      {active && partialNote !== undefined ? (
                        /* Read out with the column name, so the scope of the sort
                         travels with the claim that it is sorted. */
                        <span className="sr-only">{partialNote}</span>
                      ) : null}
                    </button>
                  </>
                ) : (
                  caption
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.length === 0 && (empty !== undefined || search.trim()) ? (
          <TableRow>
            {/* One cell spanning the table, so the explanation sits under the
                headings rather than squeezed into the first column. */}
            <TableCell colSpan={columns.length}>
              {search.trim() ? "No matching results. Clear or change your search." : empty}
            </TableCell>
          </TableRow>
        ) : (
          <>
            {paddingTop > 0 ? <tr aria-hidden="true" style={{ height: paddingTop }} /> : null}
            {visibleRows.map(({ row, index }) =>
              row === undefined ? null : (
                <TableRow
                  key={rowKey(row)}
                  data-index={index}
                  ref={virtualized ? (node) => virtualizer.measureElement(node) : undefined}
                >
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      className="admin-table-cell"
                      data-align={column.align ?? "left"}
                      /* The caption, repeated on each cell for the mobile card layout. */
                      data-label={
                        typeof column.header === "string" && column.headerHidden !== true
                          ? column.header
                          : undefined
                      }
                    >
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ),
            )}
            {paddingBottom > 0 ? <tr aria-hidden="true" style={{ height: paddingBottom }} /> : null}
          </>
        )}
      </TableBody>
    </Table>
  );

  return (
    <>
      {searchText ? (
        <label className="admin-field">
          <span className="admin-field-label">Search {label.toLocaleLowerCase()}</span>
          <input
            className="input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {partialNote ? (
            <span className="type-caption text-muted-foreground">{partialNote}</span>
          ) : null}
        </label>
      ) : null}
      {sortOptions.length ? (
        <label className="admin-table-mobile-sort admin-field">
          <span className="admin-field-label">Sort {label.toLocaleLowerCase()}</span>
          <select
            className="select"
            value={sort ? `${sort.id}:${String(sort.desc)}` : ""}
            onChange={(event) => {
              const choice = sortOptions.find((option) => option.value === event.target.value);
              setSorting(choice ? [{ id: choice.id, desc: choice.desc }] : []);
            }}
          >
            <option value="">Original order</option>
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {sort && partialNote && !searchText ? (
            <span className="type-caption text-muted-foreground">{partialNote}</span>
          ) : null}
        </label>
      ) : null}
      {virtualized ? (
        <div
          className="admin-table-scroll"
          ref={scrollRef}
          style={{ maxHeight }}
          tabIndex={0}
          role="group"
          aria-label={label}
        >
          {body}
        </div>
      ) : (
        body
      )}
    </>
  );
}
