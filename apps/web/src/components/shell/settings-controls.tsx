/* Shared building blocks for the settings sections: a page header, cards
   with a heading, and rows of label + control (or label + value + action).
   Rows stack on narrow panes through the card's container query, so the
   label and its control never drift apart. */

import { cn } from "@/lib/utils";
import { useId, type ReactNode } from "react";

export function SettingsHeader({
  title,
  description,
}: {
  readonly title: string;
  readonly description: ReactNode;
}) {
  return (
    <header className="mb-5">
      <h1 className="m-0 mb-1 type-h2 font-semibold">{title}</h1>
      <p className="m-0 type-body-sm text-muted-foreground">{description}</p>
    </header>
  );
}

/** A titled group of rows. The heading names the region for assistive tech. */
export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
}: {
  readonly title: string;
  readonly description?: ReactNode;
  /** Shown beside the heading, e.g. "Sign out of all other devices". */
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "@container mb-4 rounded-xl border border-border bg-card [padding:16px_20px]",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={headingId} className="m-0 type-h3 font-semibold">
            {title}
          </h2>
          {description === undefined ? null : (
            <p className="m-0 mt-0.5 type-body-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

const ROW_GRID =
  "grid gap-1.5 border-t border-border py-3.5 first:border-t-0 @xl:grid-cols-[200px_minmax(0,1fr)] @xl:items-baseline @xl:gap-6";

/** A label (and hint) beside its control. */
export function SettingsField({
  label,
  hint,
  controlId,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  /** The control the label names; omit when the children label themselves. */
  readonly controlId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={ROW_GRID}>
      <div>
        {controlId === undefined ? (
          <p className="m-0 type-body-sm font-medium">{label}</p>
        ) : (
          <label htmlFor={controlId} className="block type-body-sm font-medium">
            {label}
          </label>
        )}
        {hint ? (
          <p className="m-0 mt-0.5 type-caption text-muted-foreground [line-height:1.5]">{hint}</p>
        ) : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A read-only value with an optional action, Workspace "Personal info" style. */
export function SettingsValueRow({
  label,
  value,
  action,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className={ROW_GRID}>
      <p className="m-0 type-body-sm font-medium">{label}</p>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0 type-body-sm [overflow-wrap:anywhere]">{value}</div>
        {action}
      </div>
    </div>
  );
}

/** Pill-style single-choice control (Text size, shortcuts on/off). */
export function SegmentedControl<TValue extends string>({
  label,
  options,
  value,
  onSelect,
}: {
  label: string;
  options: readonly { value: TValue; label: string }[];
  value: TValue;
  onSelect: (value: TValue) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex gap-1 p-0.5 bg-muted rounded-md [width:fit-content]"
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onSelect(option.value)}
            aria-pressed={selected}
            className={cn(
              "h-7 [padding:0_16px] rounded type-meta focus-ring",
              selected ? "bg-card" : "bg-transparent",
              selected ? "text-foreground" : "[color:var(--text-2)]",
              selected ? "font-semibold" : "font-normal",
              selected ? "[box-shadow:var(--shadow-sm)]" : "[box-shadow:none]",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A polite status line for "Saved." confirmations. */
export function SettingsStatus({ message }: { readonly message: string | null }) {
  return (
    <p role="status" className="m-0 mt-2 min-h-5 type-body-sm text-muted-foreground">
      {message}
    </p>
  );
}
