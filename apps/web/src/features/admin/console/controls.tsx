/* Form and toolbar vocabulary shared by every admin section.
 *
 * Each of these replaces something that was written three to five times, or an
 * exported inline-style object that could not be themed:
 *
 *  - `AdminField` was copy-pasted byte-identically into `drive-admin.tsx`,
 *    `chat-admin.tsx` and `mail-admin.tsx`.
 *  - `AdminToolbar` / `AdminBulkBar` finally give `.admin-filter-bar` and
 *    `.admin-bulk-bar` a caller. Both classes were written, documented in
 *    `styles.css` as "recurs across sections, so it is a class rather than a
 *    repeated inline object", and then used by nothing — every section
 *    hand-rolled its own `{display:"flex", gap:8, marginBottom:12}`.
 *  - `AdminInput` / `AdminSelect` replace the exported `INPUT_STYLE`
 *    CSSProperties object. An inline style cannot carry `:focus-visible`,
 *    cannot respond to the density token, and can only be overridden with
 *    `!important` — which is a strange thing for a design token to be.
 *  - `AdminStatTile` replaces five implementations of the same KPI tile with
 *    four different auto-fit breakpoints.
 */

import type { ReactNode } from "react";

function joinClass(base: string, extra: string | undefined): string {
  return extra === undefined ? base : `${base} ${extra}`;
}

/** Label-above-control form row. The `<label>` wraps the control, so the
 *  caption is the accessible name without an id/htmlFor pair to keep in sync. */
export function AdminField({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <label className={joinClass("admin-field", className)}>
      <span className="admin-field-label">{label}</span>
      {children}
    </label>
  );
}

/** Search + filter row above a table. */
export function AdminToolbar({
  /** Names the group for assistive tech — "User filters", "Audit log filters". */
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="admin-filter-bar" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** Selection summary + actions. Rendered only while something is selected. */
export function AdminBulkBar({
  /** Names the bar for assistive tech — "Bulk actions for selected users". */
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    /* `role="status"`: the count changes as rows are ticked, and a bulk action
       that names a number the operator cannot hear is how the wrong rows get
       acted on. It still needs a name of its own — a status region announced
       only as a number does not say what the number counts. */
    <div className="admin-bulk-bar panel" role="status" aria-label={label}>
      {children}
    </div>
  );
}

/** The console's text input. Replaces `style={INPUT_STYLE}`. */
export function AdminInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input {...props} className={joinClass("admin-control", className)} />;
}

/** The console's select. Same treatment as `AdminInput`. */
export function AdminSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select {...props} className={joinClass("admin-control", className)} />;
}

/** A figure with its caption. `value` is a string, never a number, so a caller
 *  physically cannot pass `0` for "we could not read it" — the console's
 *  recurring bug is a refused request rendered as a zero. Pass "—". */
export function AdminStatTile({
  label,
  value,
  note,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: ReactNode;
  /** Colours the figure. Omit for a neutral reading — and never pass `success`
   *  for data that did not arrive. */
  readonly tone?: "success" | "warning" | "danger";
}) {
  return (
    <div className="panel admin-stat" data-tone={tone}>
      <span className="admin-stat-label">{label}</span>
      <strong className="admin-stat-value">{value}</strong>
      {note === undefined ? null : <span className="admin-stat-note">{note}</span>}
    </div>
  );
}

/** Auto-fitting row of `AdminStatTile`s. One breakpoint for the whole console,
 *  replacing the four that existed. */
export function AdminStatRow({ children }: { readonly children: ReactNode }) {
  return <div className="admin-stat-row">{children}</div>;
}
