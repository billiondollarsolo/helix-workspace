/* Settings — the full-screen account and preferences overlay.
   Desktop: section nav (with search) beside the open section.
   Mobile: the section list first, then the full-width section with a back
   button. The open section lives in `?settings=<section>[/<tab>]`. */

import { ArrowLeft, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { settingsSectionBase, type SettingsSectionId } from "./overlay-context";
import { SettingsNav } from "./settings-nav";
import { SETTINGS_SECTIONS } from "./settings-sections";

export interface SettingsPageProps {
  open: boolean;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
  onClose: () => void;
}

const SETTINGS_FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Focusable controls that are rendered (the other layout's controls are hidden). */
function visibleFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE)).filter(
    (node) => node.getClientRects().length > 0,
  );
}

export function SettingsPage({ open, ...props }: SettingsPageProps) {
  return open ? <SettingsDialog {...props} /> : null;
}

function SettingsDialog({ section, onSectionChange, onClose }: Omit<SettingsPageProps, "open">) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  /* Mobile only (CSS hides the other pane): the Profile home opens on the
     section list; a deep link to any other section opens that section. */
  const [mobilePane, setMobilePane] = useState<"list" | "section">(
    settingsSectionBase(section) === "profile" ? "list" : "section",
  );

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    let cancelled = false;
    document.body.style.overflow = "hidden";
    /* Settings covers the whole app: the app behind it is inert and hidden
       (not unmounted, so drafts and scroll positions survive). */
    const restoreBackground = new Map<HTMLElement, () => void>();
    const conceal = (node: Node) => {
      if (!(node instanceof HTMLElement) || node === dialogRef.current) return;
      if (restoreBackground.has(node)) return;
      const { inert } = node;
      const { visibility } = node.style;
      node.inert = true;
      node.style.visibility = "hidden";
      restoreBackground.set(node, () => {
        node.inert = inert;
        node.style.visibility = visibility;
      });
    };
    const parent = dialogRef.current?.parentElement ?? null;
    for (const node of Array.from(parent?.children ?? [])) conceal(node);
    /* The app keeps rendering behind Settings: a route that swaps its loading
       state for its content mounts a new sibling, which must be hidden too. */
    const backgroundObserver = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(conceal);
    });
    if (parent !== null) backgroundObserver.observe(parent, { childList: true });
    queueMicrotask(() => {
      if (!cancelled) {
        const dialog = dialogRef.current;
        if (dialog !== null) (visibleFocusable(dialog)[0] ?? dialog).focus();
      }
    });
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      /* Dialogs opened from a section (confirmations, the photo cropper)
         handle their own keys; leave them alone. */
      const owner = document.activeElement?.closest('[role="dialog"], [role="alertdialog"]');
      if (dialog === null || event.defaultPrevented || (owner != null && owner !== dialog)) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const focusable = visibleFocusable(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
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
      backgroundObserver.disconnect();
      for (const restore of restoreBackground.values()) restore();
      if (previousFocus?.isConnected === true) {
        previousFocus.focus();
      }
    };
  }, [onClose]);

  const sectionBase = settingsSectionBase(section);
  const activeSection =
    SETTINGS_SECTIONS.find((entry) => entry.id === sectionBase) ?? SETTINGS_SECTIONS[0];
  const ActiveSectionBody = activeSection?.Component;
  const onList = mobilePane === "list";

  const selectSection = (id: SettingsSectionId) => {
    onSectionChange(id);
    setMobilePane("section");
    sectionRef.current?.scrollTo?.({ top: 0 });
    queueMicrotask(() => sectionRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
      className="fixed inset-0 bg-background [z-index:300] flex flex-col"
    >
      <div className="h-14 flex items-center [padding:0_12px] gap-2 [border-bottom:1px_solid_var(--border)] bg-card">
        <button
          type="button"
          className="icon-btn md:hidden"
          onClick={onList ? onClose : () => setMobilePane("list")}
          aria-label={onList ? "Close settings" : "All settings"}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-btn max-md:hidden"
          onClick={onClose}
          aria-label="Close settings"
        >
          <X size={18} aria-hidden="true" />
        </button>
        <span id="settings-title" className="type-h3 font-semibold">
          Personal settings
        </span>
        <div className="ml-auto">
          <button type="button" className="btn primary sm" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      <div className="flex-1 flex min-h-0">
        <div
          className={cn(
            "overflow-y-auto bg-card [border-right:1px_solid_var(--border)] [padding:12px] md:w-68 md:shrink-0",
            onList ? "max-md:flex-1" : "max-md:hidden",
          )}
        >
          <SettingsNav active={onList ? null : sectionBase} onSelect={selectSection} />
        </div>
        <section
          ref={sectionRef}
          tabIndex={-1}
          aria-label={`${activeSection?.label ?? "Settings"} settings`}
          className={cn(
            "flex-1 min-w-0 overflow-y-auto outline-none [padding:24px_16px] md:[padding:28px_40px]",
            onList && "max-md:hidden",
          )}
        >
          <div className="mx-auto max-w-180">
            {ActiveSectionBody ? (
              <ActiveSectionBody
                tab={section.split("/")[1]}
                onTabChange={(tab) => onSectionChange(`${sectionBase}/${tab}`)}
                onNavigate={selectSection}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
