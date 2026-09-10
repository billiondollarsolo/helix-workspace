import {
  ACCENT_OPTIONS,
  FONT_SCALE_OPTIONS,
  setAppearance,
  useAppearance,
  type Density,
  type ThemeMode,
} from "@/components/settings-store";
import { SegmentedControl, SettingsField } from "./settings-controls";

/* ---------- Appearance ---------- */

const DENSITY_OPTIONS: readonly { value: Density; label: string }[] = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Roomy" },
];

const THEME_OPTIONS: readonly { v: ThemeMode; label: string; swatch: [string, string] }[] = [
  { v: "light", label: "Light", swatch: ["#fafaf9", "#1c1917"] },
  { v: "dark", label: "Dark", swatch: ["#0a0a0b", "#ededee"] },
];

export function AppearanceSection() {
  const theme = useAppearance((s) => s.theme);
  const density = useAppearance((s) => s.density);
  const fontScale = useAppearance((s) => s.fontScale);
  const accent = useAppearance((s) => s.accent);

  return (
    <>
      <h1 className="[font-size:var(--text-h2)] font-semibold [margin:0_0_4px]">Appearance</h1>
      <div className="[font-size:var(--text-body-sm)] text-muted-foreground mb-2">
        Personalize how Helix looks for you
      </div>
      <SettingsField label="Theme" hint="Choose light or dark mode">
        <div role="group" aria-label="Theme" className="flex gap-3">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.v}
              type="button"
              onClick={() => setAppearance("theme", option.v)}
              aria-pressed={theme === option.v}
              className="rounded-lg p-2 bg-card flex flex-col items-center gap-2 w-30 [border:2px_solid_var(--border)] aria-pressed:[border-color:var(--accent)]"
            >
              <div
                className="w-full h-15 rounded relative [border:1px_solid_var(--border)] overflow-hidden"
                style={{ background: option.swatch[0] }}
              >
                <div
                  className="absolute top-1.5 left-1.5 right-7.5 h-1.5 [border-radius:1px] [opacity:0.9]"
                  style={{ background: option.swatch[1] }}
                />
                <div
                  className="absolute top-4.5 left-1.5 right-4.5 [height:3px] [border-radius:1px] [opacity:0.5]"
                  style={{ background: option.swatch[1] }}
                />
                <div
                  className="absolute top-6.5 left-1.5 right-7.5 [height:3px] [border-radius:1px] [opacity:0.5]"
                  style={{ background: option.swatch[1] }}
                />
              </div>
              <span className="[font-size:var(--text-meta)] font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </SettingsField>
      <SettingsField label="Density" hint="How tightly content is packed">
        <SegmentedControl
          label="Density"
          options={DENSITY_OPTIONS}
          value={density}
          onSelect={(next) => setAppearance("density", next)}
        />
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
          {ACCENT_OPTIONS.map((color) => (
            <button
              key={color}
              type="button"
              onClick={() => setAppearance("accent", color)}
              aria-label={`Accent ${color}`}
              aria-pressed={accent === color}
              title={color}
              className="w-8 h-8 rounded-lg p-0 [border:none] cursor-pointer [transition:box-shadow_0.15s]"
              style={{
                background: color,
                boxShadow:
                  accent === color
                    ? `0 0 0 2px var(--surface), 0 0 0 4px ${color}`
                    : "inset 0 0 0 1px rgba(0,0,0,0.08)",
              }}
            />
          ))}
        </div>
      </SettingsField>
    </>
  );
}
