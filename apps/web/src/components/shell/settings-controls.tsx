import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

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

const SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE =
  "Account-backed settings are not available in this build yet.";

/* Spread onto every control whose value has nowhere to persist yet, so the
   disabled state and its explanation always travel together. */
export const UNAVAILABLE_CONTROL_PROPS = {
  disabled: true,
  title: SETTINGS_ACCOUNT_STORAGE_UNAVAILABLE,
} as const;

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
