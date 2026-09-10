import { cn } from "@/lib/utils";
import { useState, type ReactNode } from "react";

/* ---------- shared bits ---------- */

export function SettingsField({
  label,
  hint,
  controlId,
  children,
}: {
  label: string;
  hint?: string;
  controlId?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid [grid-template-columns:200px_1fr] gap-6 [padding:16px_0] [border-top:1px_solid_var(--border)] items-start">
      <div>
        {controlId === undefined ? (
          <div className="[font-size:var(--text-body-sm)] font-medium">{label}</div>
        ) : (
          <label htmlFor={controlId} className="block [font-size:var(--text-body-sm)] font-medium">
            {label}
          </label>
        )}
        {hint ? (
          <div className="[font-size:var(--text-caption)] text-muted-foreground mt-0.5 [line-height:1.5]">
            {hint}
          </div>
        ) : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

export const SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE =
  "Account-backed settings are not available in this build yet.";

/* Spread onto every control whose value has nowhere to persist yet, so the
   disabled state and its explanation always travel together. */
export const UNAVAILABLE_CONTROL_PROPS = {
  disabled: true,
  title: SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE,
} as const;

function Toggle({
  defaultOn,
  label,
  disabledReason,
}: {
  defaultOn: boolean;
  label: string;
  disabledReason?: string;
}) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      aria-description={disabledReason}
      title={disabledReason}
      disabled={disabledReason !== undefined}
      onClick={() => setOn((value) => !value)}
      className={cn(
        "w-9 h-5 [border-radius:999px] relative [transition:background_0.15s]",
        on ? "[background:var(--accent)]" : "[background:var(--surface-3)]",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 w-4 h-4 [border-radius:999px] [background:white] [transition:left_0.15s] [box-shadow:0_1px_2px_rgba(0,0,0,0.15)]",
          on ? "left-4.5" : "left-0.5",
        )}
      />
    </button>
  );
}

export function UnavailableSettingsButton({
  children,
  className = "btn sm",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      {...UNAVAILABLE_CONTROL_PROPS}
      aria-description={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
    >
      {children}
    </button>
  );
}

/** Pill-style single-choice control (Density, Text size). */
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
              "h-7 [padding:0_16px] rounded [font-size:var(--text-meta)]",
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

/** Label + description on the left, a switch on the right. `className` carries the
    caller's row padding and separator borders. */
export function ToggleRow({
  label,
  desc,
  defaultOn,
  className,
}: {
  label: string;
  desc: string;
  defaultOn: boolean;
  className: string;
}) {
  return (
    <div className={cn("flex items-center", className)}>
      <div className="flex-1">
        <div className="[font-size:var(--text-body-sm)] font-medium">{label}</div>
        <div className="[font-size:var(--text-caption)] text-muted-foreground mt-0.5">{desc}</div>
      </div>
      <Toggle
        defaultOn={defaultOn}
        label={label}
        disabledReason={SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE}
      />
    </div>
  );
}
