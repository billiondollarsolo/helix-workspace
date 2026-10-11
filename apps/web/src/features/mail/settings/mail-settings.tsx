/* Settings → Mail: tabs in the familiar order. The tab lives in the URL as
   `?settings=mail/<tab>`, so every tab can be linked to directly. */

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { FiltersTab } from "./filters-tab";
import { GeneralTab } from "./general-tab";
import { ManageLabelsPage } from "./manage-labels-page";

const MAIL_SETTINGS_TABS = [
  { id: "general", label: "General" },
  { id: "labels", label: "Labels" },
  { id: "filters", label: "Filters and blocked addresses" },
] as const;

export type MailSettingsTab = (typeof MAIL_SETTINGS_TABS)[number]["id"];

/** Unknown or missing tabs open General. */
function mailSettingsTab(value: string | undefined): MailSettingsTab {
  return MAIL_SETTINGS_TABS.find((tab) => tab.id === value)?.id ?? "general";
}

const PANELS: Readonly<Record<MailSettingsTab, () => ReactNode>> = {
  general: GeneralTab,
  labels: ManageLabelsPage,
  filters: FiltersTab,
};

export function MailSettingsSection({
  tab,
  onTabChange,
}: {
  /** From `?settings=mail/<tab>`. */
  readonly tab: string | undefined;
  readonly onTabChange: (tab: MailSettingsTab) => void;
}) {
  const active = mailSettingsTab(tab);
  const tabRefs = useRef(new Map<MailSettingsTab, HTMLButtonElement>());
  const Panel = PANELS[active];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = MAIL_SETTINGS_TABS.findIndex((entry) => entry.id === active);
    const last = MAIL_SETTINGS_TABS.length - 1;
    const target = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key];
    const next = target === undefined ? undefined : MAIL_SETTINGS_TABS[target];
    if (next === undefined) return;
    event.preventDefault();
    onTabChange(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className="@container">
      <h1 className="m-0 mb-1 type-h2 font-semibold">Mail</h1>
      <p className="m-0 mb-3 type-body-sm text-muted-foreground">
        How Mail looks, sorts and answers for you
      </p>
      <div
        role="tablist"
        aria-label="Mail settings"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto border-b border-border"
      >
        {MAIL_SETTINGS_TABS.map((entry) => {
          const selected = entry.id === active;
          return (
            <button
              key={entry.id}
              ref={(node) => {
                if (node === null) tabRefs.current.delete(entry.id);
                else tabRefs.current.set(entry.id, node);
              }}
              type="button"
              role="tab"
              id={`mail-settings-tab-${entry.id}`}
              aria-selected={selected}
              aria-controls="mail-settings-panel"
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(entry.id)}
              className={cn(
                "focus-ring -mb-px shrink-0 border-b-2 px-3 py-2 type-body-sm whitespace-nowrap",
                selected
                  ? "border-[var(--accent)] font-semibold text-foreground"
                  : "border-transparent text-[var(--text-2)] hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id="mail-settings-panel"
        aria-labelledby={`mail-settings-tab-${active}`}
        className="pt-2 pb-8"
      >
        <Panel />
      </div>
    </div>
  );
}
