/* The 24 label colors as one radio group: arrow keys move between swatches,
   each swatch is named ("Teal"), and the chosen one shows a check. */

import type { MailLabelColorName } from "@helix/contracts";
import { Check } from "lucide-react";
import { useId } from "react";
import { LABEL_COLORS, labelColorTitle, labelColorVar } from "./label-model";

export function LabelColorPicker({
  value,
  onChange,
}: {
  readonly value: MailLabelColorName;
  readonly onChange: (color: MailLabelColorName) => void;
}) {
  const name = useId();
  return (
    <fieldset className="m-0 grid gap-1.5 border-0 p-0">
      <legend className="mb-1.5 p-0 type-body-sm font-medium">Label color</legend>
      <div className="grid grid-cols-8 gap-1.5 [width:fit-content]">
        {LABEL_COLORS.map((color) => {
          const checked = value === color;
          return (
            <label
              key={color}
              title={labelColorTitle(color)}
              className="grid size-7 cursor-pointer place-items-center rounded-full has-focus-visible:[outline:var(--focus-ring-width)_solid_var(--focus-ring-color)] has-focus-visible:[outline-offset:var(--focus-ring-offset)]"
              style={{ background: labelColorVar(color) }}
            >
              <input
                type="radio"
                name={name}
                value={color}
                checked={checked}
                onChange={() => onChange(color)}
                aria-label={labelColorTitle(color)}
                className="sr-only"
              />
              {checked ? (
                <Check aria-hidden="true" className="size-4 text-[var(--label-on)]" />
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
