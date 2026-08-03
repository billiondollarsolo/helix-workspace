/* The admin console's one table.
 *
 * Before this file the console rendered tabular data two incompatible ways:
 * eleven real `<table>` elements (eight through the shadcn primitive, three raw
 * in webhooks) alongside ten hand-built CSS-grid pseudo-tables. The grid ones
 * carried twenty separate `grid-template-columns` definitions, five different
 * row heights across five sections, four different last-row border strategies,
 * and — because a div is not a row — gave assistive technology a stack of
 * anonymous boxes where the semantics said "table".
 *
 * This wraps the shadcn `Table` rather than replacing it, because the eight
 * sections already using it are the ones that are right. What it adds is what
 * every grid pseudo-table was hand-rolling, plus the two capabilities no admin
 * list had at all:
 *
 *   1. the density token — one `--rd-list-row-h`, so a row is the same height
 *      in Users as in Domains and both grow under `[data-density="comfortable"]`
 *   2. the uppercase caption treatment, as a class rather than the exported
 *      `HEADER_CELL` CSSProperties object (an inline style cannot carry a focus
 *      ring, a media query, or a theme)
 *   3. a required accessible name — three raw tables in webhooks had none, so a
 *      screen reader announced "table" and nothing else
 *   4. sorting (§SORTING) — no column anywhere in this console could be sorted
 *   5. virtualization (§VIRTUALIZATION) — no admin list was virtualized, on a
 *      directory that pages to 250 rows at a time
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
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
export type AdminSortValue = string | number | null;

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

interface SortState {
  readonly columnId: string;
  readonly direction: SortDirection;
}

/* ------------------------------------------------------------------ */
/* SORTING                                                             */
/* ------------------------------------------------------------------ */

/* Three states, not two: none → ascending → descending → none.
 *
 * The un-sorted state has to be reachable, because for several of these lists
 * the server's own order is information — the audit log is newest-first, the
 * directory is newest-first. A two-state toggle would make that order
 * unrecoverable without a reload. */
function nextSort(current: SortState | null, columnId: string): SortState | null {
  if (current === null || current.columnId !== columnId) {
    return { columnId, direction: "asc" };
  }
  return current.direction === "asc" ? { columnId, direction: "desc" } : null;
}

/** Compare two values *including* the direction, because "unknown sorts last"
 *  cannot be expressed by a comparator whose result is later multiplied by the
 *  direction — that flips the nulls to the front on the descending pass. They
 *  are placed here, outside the flip.
 *
 *  Unknown last both ways: treating `null` as less-than files every unnamed
 *  actor at the top of an A-Z sort and invites the reader to think those are
 *  the As. */
function compare(left: AdminSortValue, right: AdminSortValue, direction: SortDirection): number {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const order =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, { numeric: true });
  return direction === "asc" ? order : -order;
}

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
 *  compact value; the virtualizer re-measures from the real DOM immediately. */
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
}: {
  readonly label: string;
  readonly columns: readonly AdminColumn<TRow>[];
  readonly rows: readonly TRow[];
  readonly rowKey: (row: TRow) => string;
  readonly empty?: ReactNode;
  readonly partialNote?: string;
  readonly maxHeight?: string;
}) {
  const [sort, setSort] = useState<SortState | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const sortedRows = useMemo(() => {
    if (sort === null) {
      return rows;
    }
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    if (column?.sortValue === undefined) {
      return rows;
    }
    const sortValue = column.sortValue;
    /* Copy before sorting: `rows` belongs to the caller (usually straight off a
       query cache) and sorting in place would mutate it. */
    return [...rows].sort((left, right) =>
      compare(sortValue(left), sortValue(right), sort.direction),
    );
  }, [columns, rows, sort]);

  const virtualized = sortedRows.length > VIRTUALIZE_ABOVE;
  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 12,
    enabled: virtualized,
  });

  const virtualRows = virtualized ? virtualizer.getVirtualItems() : [];
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
            const active = sort?.columnId === column.id;
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
                aria-sort={sortable ? (active ? ARIA_SORT[sort.direction] : "none") : undefined}
              >
                {sortable ? (
                  <button
                    type="button"
                    className="admin-table-sort"
                    onClick={() => {
                      setSort((current) => nextSort(current, column.id));
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
                ) : (
                  caption
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedRows.length === 0 && empty !== undefined ? (
          <TableRow>
            {/* One cell spanning the table, so the explanation sits under the
                headings rather than squeezed into the first column. */}
            <TableCell colSpan={columns.length}>{empty}</TableCell>
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

  if (!virtualized) {
    return body;
  }
  return (
    /* The scroll container has to be outside the table for the virtualizer to
       measure against it. `tabIndex` because a scrollable region must be
       reachable from the keyboard — axe's `scrollable-region-focusable`, and
       the reason someone who cannot use a pointer can still read row 300. */
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
  );
}
