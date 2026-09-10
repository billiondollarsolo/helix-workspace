import { iconMap as Icons, type IconName } from "@/components/icon-map";
import type { SettingsSectionId } from "@/components/shell/overlay-context";
import { cn } from "@/lib/utils";
import { ArrowLeft as ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import {
  LanguageSection,
  NotifySection,
  ProfileSection,
  ShortcutsSection,
  SignatureSection,
} from "./settings-account";
import { AISection } from "./settings-ai";
import { AppearanceSection } from "./settings-appearance";
import { SecuritySection } from "./settings-security";

/* ---------- shell ---------- */

const SECTIONS: {
  id: SettingsSectionId;
  label: string;
  icon: IconName;
  Component: () => ReactNode;
}[] = [
  { id: "profile", label: "Profile", icon: "Users", Component: ProfileSection },
  { id: "appearance", label: "Appearance", icon: "Sun", Component: AppearanceSection },
  { id: "language", label: "Language & region", icon: "Globe", Component: LanguageSection },
  { id: "notify", label: "Notifications", icon: "Bell", Component: NotifySection },
  { id: "signature", label: "Mail signature", icon: "EditPen", Component: SignatureSection },
  { id: "ai", label: "Helix AI", icon: "Sparkles", Component: AISection },
  { id: "security", label: "Security", icon: "Shield", Component: SecuritySection },
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

  const activeSection = SECTIONS.find((entry) => entry.id === section);
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
        <span id="settings-title" className="[font-size:var(--text-body)] font-semibold">
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
            const selected = section === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSectionChange(entry.id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "w-full flex items-center gap-2.5 h-8 [padding:0_10px] rounded-md [font-size:var(--text-body-sm)] text-left",
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
          {ActiveSectionBody ? <ActiveSectionBody /> : null}
        </section>
      </div>
    </div>
  );
}
