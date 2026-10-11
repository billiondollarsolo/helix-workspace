import {
  ACCENT_OPTIONS,
  DENSITY_OPTIONS,
  FONT_SCALE_OPTIONS,
  THEME_OPTIONS,
  accentSwatch,
  setAppearance,
  useAppearance,
  type ResolvedTheme,
  type ThemeMode,
} from "@/components/settings-store";
import { SegmentedControl, SettingsField } from "./settings-controls";

/* ---------- Appearance ---------- */

/** A miniature page drawn with the real theme tokens: `data-theme` on the
 *  preview re-scopes every colour variable to that theme. */
function ThemePreview({ theme }: { theme: ResolvedTheme }) {
  return (
    <div data-theme={theme} className="relative h-full flex-1 bg-background">
      <div className="absolute top-1.5 left-1.5 right-4 h-1.5 rounded-xs bg-foreground opacity-90" />
      <div className="absolute top-4.5 left-1.5 right-3 h-0.75 rounded-xs bg-foreground opacity-50" />
      <div className="absolute top-6.5 left-1.5 right-5 h-0.75 rounded-xs bg-foreground opacity-50" />
    </div>
  );
}

const PREVIEWS: Readonly<Record<ThemeMode, readonly ResolvedTheme[]>> = {
  system: ["light", "dark"],
  light: ["light"],
  dark: ["dark"],
};

export function AppearanceSection() {
  const theme = useAppearance((s) => s.theme);
  const density = useAppearance((s) => s.density);
  const fontScale = useAppearance((s) => s.fontScale);
  const accent = useAppearance((s) => s.accent);

  return (
    <>
      <h1 className="type-h2 font-semibold [margin:0_0_4px]">Appearance</h1>
      <div className="type-body-sm text-muted-foreground mb-2">
        Personalize how Helix looks for you
      </div>
      <SettingsField label="Theme" hint="System follows your device setting">
        <fieldset className="m-0 p-0 border-0 flex gap-3 flex-wrap">
          <legend className="sr-only">Theme</legend>
          {THEME_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="rounded-lg p-2 bg-card flex flex-col items-center gap-2 w-30 cursor-pointer [border:2px_solid_var(--border)] has-checked:[border-color:var(--accent)] has-focus-visible:[outline:var(--focus-ring-width)_solid_var(--focus-ring-color)] has-focus-visible:[outline-offset:var(--focus-ring-offset)]"
            >
              <input
                type="radio"
                name="appearance-theme"
                value={option.value}
                checked={theme === option.value}
                onChange={() => setAppearance("theme", option.value)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className="w-full h-15 rounded flex overflow-hidden [border:1px_solid_var(--border)]"
              >
                {PREVIEWS[option.value].map((preview) => (
                  <ThemePreview key={preview} theme={preview} />
                ))}
              </span>
              <span className="type-meta font-medium">{option.label}</span>
            </label>
          ))}
        </fieldset>
      </SettingsField>
      <SettingsField label="Density" hint="How much fits on screen in lists">
        <fieldset className="m-0 p-0 border-0 grid gap-2">
          <legend className="sr-only">Density</legend>
          {DENSITY_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="radio"
                name="appearance-density"
                value={option.value}
                checked={density === option.value}
                onChange={() => setAppearance("density", option.value)}
                className="mt-0.5 accent-[var(--accent)] focus-ring"
              />
              <span>
                <span className="block type-body-sm font-medium">{option.label}</span>
                <span className="block type-caption text-muted-foreground">{option.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </SettingsField>
      <SettingsField label="Text size" hint="Scale text across the entire workspace">
        <SegmentedControl
          label="Text size"
          options={FONT_SCALE_OPTIONS}
          value={fontScale}
          onSelect={(next) => setAppearance("fontScale", next)}
        />
      </SettingsField>
      <SettingsField label="Accent color" hint="Used for buttons, selections, and highlights">
        <div role="group" aria-label="Accent color" className="flex gap-2.5 flex-wrap">
          {ACCENT_OPTIONS.map((option) => {
            const color = accentSwatch(option.hue);
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setAppearance("accent", option.value)}
                aria-label={`Accent ${option.label}`}
                aria-pressed={accent === option.value}
                title={option.label}
                className="w-8 h-8 rounded-lg p-0 [border:none] cursor-pointer [transition:box-shadow_0.15s]"
                style={{
                  background: color,
                  boxShadow:
                    accent === option.value
                      ? `0 0 0 2px var(--surface), 0 0 0 4px ${color}`
                      : "inset 0 0 0 1px rgba(0,0,0,0.08)",
                }}
              />
            );
          })}
        </div>
      </SettingsField>
    </>
  );
}
