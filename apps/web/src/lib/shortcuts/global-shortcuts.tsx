/* GlobalShortcuts — the single keydown listener for the workspace plus the
   shortcuts that work in every app: `?` help, ⌘K palette, and the Gmail-style
   `g` navigation sequences. Mounted once by AppShell.

   `g` destinations: i/s/t/d/a → Mail Inbox, Starred, Sent, Drafts, All Mail;
   c → Calendar, k → Chat, r → Drive (files), h → Meet (huddle). */

import { keyboardShortcutsEnabled, useKeyboardShortcutsEnabled } from "@/components/settings-store";
import { Dialog } from "@/components/ui/helix-dialog";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { detectMacPlatform } from "./keys";
import { shortcutRegistry } from "./registry";
import { ShortcutList } from "./shortcut-list";
import { useShortcuts } from "./use-shortcuts";

/** Window event that opens the shortcuts help dialog (`?`) from outside it. */
const OPEN_SHORTCUTS_HELP_EVENT = "helix:open-shortcuts";

/** Open the keyboard-shortcuts help dialog, as `?` does — e.g. from the Help menu. */
export function openShortcutsHelp(): void {
  window.dispatchEvent(new Event(OPEN_SHORTCUTS_HELP_EVENT));
}

/** Open modal dialogs and menus take precedence over app shortcuts. */
const OVERLAY_SELECTOR = '[aria-modal="true"], [role="alertdialog"], [role="menu"]';

export interface GlobalShortcutsProps {
  readonly onTogglePalette: () => void;
  readonly onOpenShortcutSettings: () => void;
}

export function GlobalShortcuts({ onTogglePalette, onOpenShortcutSettings }: GlobalShortcutsProps) {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    const isMac = detectMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      shortcutRegistry.handleKeyDown(event, {
        enabled: keyboardShortcutsEnabled(),
        overlayOpen: document.querySelector(OVERLAY_SELECTOR) !== null,
        isMac,
      });
    };
    const onOpenHelp = () => setHelpOpen(true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_SHORTCUTS_HELP_EVENT, onOpenHelp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_SHORTCUTS_HELP_EVENT, onOpenHelp);
    };
  }, []);

  const goToMail = (folder?: "starred" | "sent" | "drafts" | "all") => {
    void navigate({ to: "/mail", search: folder === undefined ? {} : { folder } });
  };

  useShortcuts("global", {
    "global.help": () => setHelpOpen(true),
    "global.command-palette": onTogglePalette,
    "global.go-inbox": () => goToMail(),
    "global.go-starred": () => goToMail("starred"),
    "global.go-sent": () => goToMail("sent"),
    "global.go-drafts": () => goToMail("drafts"),
    "global.go-all-mail": () => goToMail("all"),
    "global.go-calendar": () => void navigate({ to: "/calendar" }),
    "global.go-chat": () => void navigate({ to: "/chat" }),
    "global.go-drive": () => void navigate({ to: "/drive" }),
    "global.go-meet": () => void navigate({ to: "/meet" }),
  });

  return helpOpen ? (
    <ShortcutHelpDialog
      onClose={() => setHelpOpen(false)}
      onOpenSettings={() => {
        setHelpOpen(false);
        onOpenShortcutSettings();
      }}
    />
  ) : null;
}

function ShortcutHelpDialog({
  onClose,
  onOpenSettings,
}: {
  readonly onClose: () => void;
  readonly onOpenSettings: () => void;
}) {
  const enabled = useKeyboardShortcutsEnabled();
  return (
    <Dialog
      modal={false}
      title="Keyboard shortcuts"
      onClose={onClose}
      width="min(820px, 100%)"
      footer={
        <>
          <span className="mr-auto self-center type-meta text-muted-foreground">
            {enabled
              ? "Single-key shortcuts are on."
              : "Single-key shortcuts are off. Shortcuts with ⌘, Ctrl, or Alt still work."}
          </span>
          <button type="button" className="btn" onClick={onOpenSettings}>
            Shortcut settings
          </button>
        </>
      }
    >
      {/* Focusable so keyboard users can scroll the list (axe scrollable-region-focusable). */}
      <div
        role="region"
        aria-label="Shortcut list"
        tabIndex={0}
        className="max-h-[min(60dvh,520px)] overflow-y-auto rounded-md p-1"
      >
        <ShortcutList columns={2} />
      </div>
    </Dialog>
  );
}
