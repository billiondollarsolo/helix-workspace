import { iconMap as Icons, type IconName } from "@/components/icon-map";
import { settingsSectionBase, type SettingsSectionId } from "@/components/shell/overlay-context";
import { MailSettingsSection } from "@/features/mail/settings";
import { cn } from "@/lib/utils";
import { ArrowLeft as ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { LanguageSection, ProfileSection } from "./settings-account";
import { AppearanceSection } from "./settings-appearance";
import { S3KeysSection } from "./settings-s3-keys";
import { SecuritySection } from "./settings-security";
import { ShortcutsSection } from "./settings-shortcuts";

/* ---------- shell ---------- */

/** Tabbed sections get the tab from `?settings=<section>/<tab>` and switch it here. */
interface SettingsSectionProps {
  tab: string | undefined;
  onTabChange: (tab: string) => void;
}

const SECTIONS: {
  id: ReturnType<typeof settingsSectionBase>;
  label: string;
  icon: IconName;
  Component: (props: SettingsSectionProps) => ReactNode;
}[] = [
  { id: "profile", label: "Profile", icon: "Users", Component: ProfileSection },
  { id: "appearance", label: "Appearance", icon: "Sun", Component: AppearanceSection },
  { id: "language", label: "Language & region", icon: "Globe", Component: LanguageSection },
  { id: "mail", label: "Mail", icon: "Mail", Component: MailSettingsSection },
  { id: "security", label: "Security", icon: "Shield", Component: SecuritySection },
  { id: "s3-keys", label: "S3 access keys", icon: "Key", Component: S3KeysSection },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: "Code", Component: ShortcutsSection },
];

export interface SettingsPageProps {
  open: boolean;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onClose: () => void;
}

const SETTINGS_FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SettingsPage({ open, section, onSectionChange, onClose }: SettingsPageProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    let cancelled = false;
    document.body.style.overflow = "hidden";
    queueMicrotask(() => {
      if (!cancelled) {
        dialogRef.current?.querySelector<HTMLElement>(SETTINGS_FOCUSABLE)?.focus();
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) {
        return;
      }
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const sectionBase = settingsSectionBase(section);
  const activeSection = SECTIONS.find((entry) => entry.id === sectionBase);
  const ActiveSectionBody = activeSection?.Component;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
      className="fixed inset-0 bg-background [z-index:300] flex flex-col"
    >
      <div className="h-12 flex items-center [padding:0_16px] gap-3 [border-bottom:1px_solid_var(--border)] bg-card">
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Back">
          <ArrowLeftIcon size={16} />
        </button>
        <span id="settings-title" className="type-body font-semibold">
          Settings
        </span>
        <div className="ml-auto">
          <button type="button" className="btn primary sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      <div className="flex-1 flex min-h-0">
        <nav
          aria-label="Settings sections"
          className="w-60 [border-right:1px_solid_var(--border)] bg-card p-3"
        >
          {SECTIONS.map((entry) => {
            const Icon = Icons[entry.icon];
            const selected = sectionBase === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSectionChange(entry.id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "w-full flex items-center gap-2.5 h-8 [padding:0_10px] rounded-md type-body-sm text-left",
                  selected ? "[background:var(--accent-soft)]" : "bg-transparent",
                  selected ? "text-primary" : "text-foreground",
                  selected ? "font-semibold" : "font-normal",
                )}
              >
                <Icon size={16} />
                {entry.label}
              </button>
            );
          })}
        </nav>
        <section
          aria-label={`${activeSection?.label ?? "Settings"} settings`}
          className="flex-1 overflow-y-auto [padding:24px_32px] max-w-180 min-w-0"
        >
          {ActiveSectionBody ? (
            <ActiveSectionBody
              tab={section.split("/")[1]}
              onTabChange={(tab) => onSectionChange(`${sectionBase}/${tab}`)}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
