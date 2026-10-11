/* Quick settings — the side sheet behind the top-bar cog. The everyday
   appearance choices, with a way through to the full settings page. */

import {
  DENSITY_OPTIONS,
  THEME_OPTIONS,
  setAppearance,
  useAppearance,
} from "@/components/settings-store";
import { Button } from "@/components/ui/button";
import { SideSheet } from "@/components/ui/side-sheet";
import type { ReactNode } from "react";

export interface QuickSettingsProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Open the full settings page. */
  readonly onSeeAllSettings: () => void;
}

export function QuickSettings({ open, onOpenChange, onSeeAllSettings }: QuickSettingsProps) {
  const theme = useAppearance((state) => state.theme);
  const density = useAppearance((state) => state.density);

  return (
    <SideSheet open={open} onOpenChange={onOpenChange} title="Quick settings" size="sm">
      <div className="quick-settings-body">
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            onOpenChange(false);
            onSeeAllSettings();
          }}
        >
          See all settings
        </Button>
        <ChoiceGroup
          name="quick-settings-theme"
          legend="Theme"
          options={THEME_OPTIONS}
          value={theme}
          onChange={(next) => setAppearance("theme", next)}
          preview={(option) => <span className="quick-preview" data-preview-theme={option} />}
        />
        <ChoiceGroup
          name="quick-settings-density"
          legend="Density"
          options={DENSITY_OPTIONS}
          value={density}
          onChange={(next) => setAppearance("density", next)}
          preview={(option) => (
            <span className="quick-preview" data-preview-density={option}>
              <span />
              <span />
              <span />
            </span>
          )}
        />
      </div>
    </SideSheet>
  );
}

function ChoiceGroup<TValue extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  preview,
}: {
  readonly name: string;
  readonly legend: string;
  readonly options: readonly { value: TValue; label: string; hint?: string }[];
  readonly value: TValue;
  readonly onChange: (value: TValue) => void;
  readonly preview: (value: TValue) => ReactNode;
}) {
  return (
    <fieldset className="quick-settings-group">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="quick-option">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="quick-option-label">
            {option.label}
            {option.hint ? <span className="quick-option-hint">{option.hint}</span> : null}
          </span>
          {preview(option.value)}
        </label>
      ))}
    </fieldset>
  );
}
