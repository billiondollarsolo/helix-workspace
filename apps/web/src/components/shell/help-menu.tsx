/* Help — the rail's help menu (keyboard shortcuts, documentation, about) and
   the About dialog it opens. */

import { HelixLogo } from "@/components/shell/helix-logo";
import { useShellOverlays } from "@/components/shell/overlay-context";
import {
  BookOpen as DocsIcon,
  CircleHelp as HelpIcon,
  Info as InfoIcon,
  Keyboard as KeyboardIcon,
  X as XIcon,
} from "lucide-react";
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { menuItemClass, menuSurfaceClass } from "@/components/ui/menu-styles";
import { Dialog, DropdownMenu } from "radix-ui";

/** Product documentation, opened in a new tab. */
const HELIX_DOCS_URL = "https://github.com/billiondollarsolo/helix-workspace/tree/main/docs";

export function HelpMenu() {
  const overlays = useShellOverlays();
  return (
    <Menu modal={false}>
      <MenuTrigger className="rail-item" aria-label="Help">
        <HelpIcon size={16} aria-hidden="true" />
        <span className="rail-tip" aria-hidden="true">
          Help
        </span>
      </MenuTrigger>
      {/* Content is not portalled, so the menu stays inside the rail's
          navigation landmark. */}
      <DropdownMenu.Content side="right" align="end" sideOffset={8} className={menuSurfaceClass}>
        <MenuLabel>Help</MenuLabel>
        <MenuItem icon={<KeyboardIcon />} shortcut="?" onSelect={overlays.openShortcuts}>
          Keyboard shortcuts
        </MenuItem>
        <DropdownMenu.Item asChild className={menuItemClass}>
          <a href={HELIX_DOCS_URL} target="_blank" rel="noopener noreferrer">
            <DocsIcon aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">Documentation</span>
          </a>
        </DropdownMenu.Item>
        <MenuSeparator />
        <MenuItem icon={<InfoIcon />} onSelect={overlays.openAbout}>
          About Helix
        </MenuItem>
      </DropdownMenu.Content>
    </Menu>
  );
}

export interface AboutDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function AboutDialog({ open, onOpenChange }: AboutDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay" />
        <Dialog.Content className="about-dialog">
          <div className="about-dialog-header">
            <HelixLogo size={28} />
            <Dialog.Title className="about-dialog-title">Helix Workspace</Dialog.Title>
            <Dialog.Close className="icon-btn ml-auto" aria-label="Close">
              <XIcon size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="about-dialog-text">
            Mail, file storage, chat, calendar and video meetings in one self-hosted workspace.
          </Dialog.Description>
          <p className="about-dialog-text">Open source under the Apache License 2.0.</p>
          <a
            className="btn about-dialog-docs"
            href={HELIX_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <DocsIcon size={16} aria-hidden="true" />
            Read the documentation
          </a>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
