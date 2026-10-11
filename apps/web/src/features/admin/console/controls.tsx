/* Form and toolbar vocabulary shared by every admin section.
 *
 * Each of these replaces something that was written three to five times, or an
 * exported inline-style object that could not be themed:
 *
 *  - `AdminField` was copy-pasted byte-identically into `drive-admin.tsx`,
 *    `chat-admin.tsx` and `mail-admin.tsx`.
 *  - `AdminToolbar` gives `.admin-filter-bar` a caller, instead of every
 *    section hand-rolling its own `{display:"flex", gap:8, marginBottom:12}`.
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

/** The console's text input. Replaces `style={INPUT_STYLE}`. */
export function AdminInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input {...props} className={joinClass("admin-control", className)} />;
}

/** The console's select. Same treatment as `AdminInput`. */
export function AdminSelect({ className, ...props }: React.ComponentProps<"select">) {
  return <select {...props} className={joinClass("admin-control", className)} />;
}
