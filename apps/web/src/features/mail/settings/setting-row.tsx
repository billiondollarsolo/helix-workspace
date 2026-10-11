/* One labelled settings row: the name on the left, the control on the
   right; stacked when the settings pane is narrow (container query). */

import { useId, type ReactNode } from "react";

export function SettingRow({
  title,
  hint,
  controlId,
  children,
}: {
  readonly title: string;
  readonly hint?: ReactNode;
  /** The control the title labels; omit when the children label themselves. */
  readonly controlId?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-2 border-t border-border py-4 first:border-t-0 @2xl:grid-cols-[200px_minmax(0,1fr)] @2xl:gap-6">
      <div>
        {controlId === undefined ? (
          <p className="m-0 type-body-sm font-medium">{title}</p>
        ) : (
          <label htmlFor={controlId} className="block type-body-sm font-medium">
            {title}
          </label>
        )}
        {hint ? <p className="m-0 mt-0.5 type-caption text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A row whose control is a set of radio buttons, named by the row title. */
export function ChoiceRow<TValue extends string>({
  title,
  hint,
  name,
  options,
  value,
  onChange,
  disabled = false,
}: {
  readonly title: string;
  readonly hint?: ReactNode;
  readonly name: string;
  readonly options: readonly { readonly value: TValue; readonly label: string }[];
  readonly value: TValue;
  readonly onChange: (value: TValue) => void;
  readonly disabled?: boolean;
}) {
  const titleId = useId();
  return (
    <div className="grid gap-2 border-t border-border py-4 first:border-t-0 @2xl:grid-cols-[200px_minmax(0,1fr)] @2xl:gap-6">
      <div>
        <p id={titleId} className="m-0 type-body-sm font-medium">
          {title}
        </p>
        {hint ? <p className="m-0 mt-0.5 type-caption text-muted-foreground">{hint}</p> : null}
      </div>
      <div role="radiogroup" aria-labelledby={titleId} className="grid gap-2">
        {options.map((option) => (
          <label key={option.value} className="flex items-center gap-2 type-body-sm">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="focus-ring accent-[var(--accent)]"
            />
            {option.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** The heading over a group of rows inside a tab. */
export function SettingsGroupHeading({
  children,
  id,
}: {
  readonly children: ReactNode;
  readonly id?: string;
}) {
  return (
    <h2 id={id} className="m-0 mt-6 mb-1 type-h3 font-semibold first:mt-2">
      {children}
    </h2>
  );
}
