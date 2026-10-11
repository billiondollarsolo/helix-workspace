import {
  setKeyboardShortcutsEnabled,
  useKeyboardShortcutsEnabled,
} from "@/components/settings-store";
import { ShortcutList } from "@/lib/shortcuts/shortcut-list";
import { SegmentedControl, SettingsCard, SettingsField, SettingsHeader } from "./settings-controls";

/* ---------- Keyboard shortcuts ---------- */

const SHORTCUT_SWITCH_OPTIONS = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const;

export function ShortcutsSection() {
  const enabled = useKeyboardShortcutsEnabled();
  return (
    <>
      <SettingsHeader title="Keyboard shortcuts" description="Press ? anywhere to see this list" />
      <SettingsCard title="Shortcuts">
        <SettingsField
          label="Keyboard shortcuts"
          hint="Off turns off single-key shortcuts. Shortcuts with ⌘, Ctrl, or Alt always work."
        >
          <SegmentedControl
            label="Keyboard shortcuts"
            options={SHORTCUT_SWITCH_OPTIONS}
            value={enabled ? "on" : "off"}
            onSelect={(next) => setKeyboardShortcutsEnabled(next === "on")}
          />
        </SettingsField>
        <div className="[padding:16px_0_0] [border-top:1px_solid_var(--border)]">
          <ShortcutList />
        </div>
      </SettingsCard>
    </>
  );
}
